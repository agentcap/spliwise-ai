import { getDb } from '@/db';
import { Store } from '@/lib/store';
import { AppError, invariant } from '@/lib/errors';
import { z } from 'zod';
import { splitAmount } from '@/lib/money';
import type { Proposal, RuleDefinition } from '@/lib/types';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const itemSchema = z.object({ id: z.string(), version: z.number().int().positive() });
function store() {
  return new Store(getDb());
}
function checkOrigin(req: Request) {
  const host = new URL('http://' + (req.headers.get('host') || ''));
  invariant(['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname), 'Local access only.', 403);
  const origin = req.headers.get('origin');
  invariant(
    !origin || new URL(origin).host === host.host,
    'This request came from another website.',
    403,
  );
}
async function handle(req: Request, context: Context): Promise<Response> {
  try {
    checkOrigin(req);
    const path = (await context.params).path;
    const key = path.join('/');
    const service = store();
    if (req.method === 'GET') {
      const url = new URL(req.url);
      if (key === 'health') return Response.json({ ok: true });
      if (path[0] === 'imports' && path.length === 2) {
        const record = service.one<{ preview: string; summary: string }>(
          'SELECT preview,summary FROM imports WHERE id=? AND status=?',
          path[1],
          'confirmed',
        );
        invariant(record, 'Import not found.', 404);
        return Response.json({
          preview: JSON.parse(record.preview),
          summary: record.summary,
          rows: service.all(
            'SELECT rowNumber,status,kind FROM import_rows WHERE importId=? ORDER BY rowNumber',
            path[1],
          ),
        });
      }
      if (key === 'state')
        return Response.json(
          service.snapshot(
            url.searchParams.get('from') || undefined,
            url.searchParams.get('to') || undefined,
          ),
          { headers: { 'Cache-Control': 'no-store' } },
        );
      if (path[0] === 'jobs' && path[2] === 'events') {
        service.job(path[1]);
        const encoder = new TextEncoder();
        let timer: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream({
          start(controller) {
            let count = 0;
            const send = () => {
              if (req.signal.aborted) {
                if (timer) clearInterval(timer);
                controller.close();
                return;
              }
              const job = service.job(path[1]);
              controller.enqueue(encoder.encode('data: ' + JSON.stringify(job) + '\n\n'));
              if (['completed', 'failed', 'cancelled'].includes(job.status) || ++count >= 30) {
                if (timer) clearInterval(timer);
                controller.close();
              }
            };
            timer = setInterval(send, 1000);
            send();
          },
          cancel() {
            if (timer) clearInterval(timer);
          },
        });
        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      }
      throw new AppError('Not found.', 404);
    }
    if (key === 'imports/preview') {
      const form = await req.formData();
      const file = form.get('file');
      invariant(
        file instanceof File && file.size <= 10_000_000,
        'Choose a CSV file smaller than 10 MB.',
      );
      return Response.json(
        service.preview(String(form.get('accountId') || ''), file.name, await file.text()),
      );
    }
    invariant(Number(req.headers.get('content-length') || 0) <= 2_000_000, 'Request is too large.');
    const body = await req.json();
    if (key === 'imports/confirm') {
      const a = z
        .object({
          id: z.string(),
          acknowledgeSkips: z.boolean(),
          keepRows: z.array(z.number().int()),
          skipInvalid: z.boolean(),
        })
        .parse(body);
      return Response.json(
        service.confirmImport(a.id, a.acknowledgeSkips, a.keepRows, a.skipInvalid),
      );
    }
    if (key === 'people') {
      const a = z
        .object({ name: z.string(), handle: z.string(), relation: z.string() })
        .parse(body);
      return Response.json(service.addPerson(a.name, a.handle, a.relation));
    }
    if (key === 'transactions/review') {
      const a = z
        .object({
          items: z.array(itemSchema),
          action: z.enum(['approve', 'reject', 'reopen', 'correct']),
          instruction: z.string().max(4000).optional(),
        })
        .parse(body);
      service.review(a.items, a.action, a.instruction);
      return Response.json({ ok: true });
    }
    if (key === 'transactions/proposal') {
      const a = z
        .object({
          id: z.string(),
          version: z.number().int(),
          category: z.string(),
          mode: z.enum(['personal', 'equal', 'exact', 'percent']),
          participants: z.array(z.string()),
          values: z.array(z.number().int()).optional(),
          refundOf: z.string().optional(),
        })
        .parse(body);
      const tx = service.transaction(a.id);
      const spec = { mode: a.mode, participants: a.participants, values: a.values };
      const proposal: Proposal = {
        splits: splitAmount(tx.amountCents, spec),
        category: a.category,
        source: 'manual',
        confidence: 'high',
        explanation: 'Split entered by you.',
        spec,
        refundOf: a.refundOf,
      };
      service.saveProposals([{ id: a.id, version: a.version, proposal, state: 'ready' }], 'user');
      return Response.json({ ok: true });
    }
    if (key === 'rules/propose') {
      const a = z
        .object({
          title: z.string(),
          definition: z.object({
            merchant: z.string(),
            category: z.string().optional(),
            accountId: z.string().optional(),
            from: z.string().optional(),
            to: z.string().optional(),
            outputCategory: z.string(),
            split: z.object({
              mode: z.enum(['personal', 'equal', 'exact', 'percent']),
              participants: z.array(z.string()),
              values: z.array(z.number().int()).optional(),
            }),
          }),
          ruleId: z.string().optional(),
        })
        .parse(body);
      return Response.json({
        id: service.proposeRule(a.title, a.definition as RuleDefinition, a.ruleId, 'user'),
      });
    }
    if (key === 'rules/review') {
      const a = z.object({ id: z.string(), approve: z.boolean() }).parse(body);
      service.reviewRule(a.id, a.approve);
      return Response.json({ ok: true });
    }
    if (key === 'repayments') {
      const a = z
        .object({
          personId: z.string(),
          date: z.string(),
          amountCents: z.number().int(),
          direction: z.enum(['received', 'returned']),
          note: z.string(),
        })
        .parse(body);
      service.addRepayment(a.personId, a.date, a.amountCents, a.direction, a.note);
      return Response.json({ ok: true });
    }
    if (key === 'undo') return Response.json({ label: service.undo() });
    if (key === 'jobs') {
      const a = z
        .object({
          kind: z.enum(['process', 'chat']),
          text: z.string().max(12000).optional(),
          ids: z.array(z.string()).max(50000).optional(),
          mentionIds: z.array(z.string()).optional(),
        })
        .parse(body);
      const ids =
        a.ids ||
        (a.kind === 'process'
          ? service
              .transactions()
              .filter((t) => t.state === 'inbox')
              .map((t) => t.id)
          : undefined);
      if (ids)
        for (const id of ids) {
          const tx = service.transaction(id);
          invariant(tx.state !== 'finalized', 'Finalized transactions cannot be processed.', 403);
        }
      return Response.json({
        id: service.enqueue(a.kind, { ids, text: a.text, mentionIds: a.mentionIds }),
      });
    }
    if (path[0] === 'jobs' && path[2] === 'cancel') {
      service.cancelJob(path[1]);
      return Response.json({ ok: true });
    }
    if (path[0] === 'jobs' && path[2] === 'retry') {
      service.retryJob(path[1]);
      return Response.json({ ok: true });
    }
    throw new AppError('Not found.', 404);
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        { error: error.issues.map((i) => i.path.join('.') + ': ' + i.message).join('; ') },
        { status: 400 },
      );
    if (error instanceof AppError)
      return Response.json({ error: error.message }, { status: error.status });
    console.error('Request failed:', error instanceof Error ? error.message : 'Unknown error');
    return Response.json(
      { error: 'Unable to complete this action. Please try again.' },
      { status: 500 },
    );
  }
}
export const GET = handle;
export const POST = handle;
