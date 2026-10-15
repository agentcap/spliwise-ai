import { randomUUID } from 'node:crypto';
import { authenticate, secureCookie, SESSION_COOKIE } from '@/lib/auth';
import { workspaceStore, closeInactiveWorkspaces } from '@/lib/workspaces';
import { config } from '@/lib/config';
import { controlDb } from '@/db/control';
import { checkOrigin, rateLimit, boundedJson, boundedForm } from '@/lib/security';
import { log } from '@/lib/log';
import { readiness } from '@/lib/health';
import { queryLedger } from '@/lib/ledger-query';
import { exportWorkspace } from '@/lib/account-data';
import { usageSummary } from '@/lib/usage';
import { AppError, invariant } from '@/lib/errors';
import { z } from 'zod';
import { DataTransfer, transactionCsv } from '@/lib/data-transfer';
import { splitAmount } from '@/lib/money';
import type { Proposal, RuleDefinition } from '@/lib/types';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
type Context = { params: Promise<{ path: string[] }> };
const inactiveCleanup = setInterval(closeInactiveWorkspaces, 10_000);
inactiveCleanup.unref();
const itemSchema = z.object({ id: z.string(), version: z.number().int().positive() });
async function handle(req: Request, context: Context, requestId: string): Promise<Response> {
  const started = Date.now();
  try {
    checkOrigin(req);
    const path = (await context.params).path;
    const key = path.join('/');
    if (key === 'health' && req.method === 'GET') {
      config();
      return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (key === 'ready' && req.method === 'GET') {
      const status = readiness();
      return Response.json(
        { ok: status.ok },
        { status: status.ok ? 200 : 503, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const principal = authenticate(req);
    const identity = principal?.id || 'local';
    if (config().production) {
      rateLimit(
        controlDb(),
        identity,
        req.method === 'GET' ? 'read' : 'write',
        req.method === 'GET' ? 600 : 180,
      );
      if (
        key === 'jobs' ||
        key === 'transactions/instruct' ||
        key === 'imports/finish' ||
        key.endsWith('/retry')
      )
        rateLimit(controlDb(), identity, 'processing', 20);
      if (key === 'imports/preview' || key === 'transfer/preview')
        rateLimit(controlDb(), identity, 'uploads', 10);
    }
    const service = workspaceStore(principal);
    if (key === 'settings' && req.method === 'GET')
      return Response.json(
        {
          production: config().production,
          email: principal?.email,
          name: principal?.name,
          ...service.settings(),
          usage: usageSummary(identity),
        },
        { headers: { 'Cache-Control': 'no-store' } },
      );

    if (req.method === 'GET') {
      const url = new URL(req.url);
      if (key === 'account/export') {
        rateLimit(controlDb(), identity, 'full-export', 3, 300_000);
        return await exportWorkspace(service);
      }
      if (key === 'transfer/export') {
        const kind = z.enum(['transactions', 'rules']).parse(url.searchParams.get('kind'));
        const format = z.enum(['json', 'csv']).parse(url.searchParams.get('format') || 'json');
        invariant(kind === 'transactions' || format === 'json', 'Rules are exported as JSON.');
        const bundle = new DataTransfer(service).export(kind, {
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
          state: url.searchParams.get('state') || undefined,
          includePending: url.searchParams.get('includePending') !== 'false',
        });
        const content = format === 'csv' ? transactionCsv(bundle) : JSON.stringify(bundle, null, 2);
        if (format === 'json') {
          invariant(
            Buffer.byteLength(content) <= 10_000_000,
            'This export exceeds the 10 MB import limit. Select a shorter date range.',
          );
          invariant(
            bundle.kind === 'transactions'
              ? bundle.transactions.length <= 50000
              : bundle.rules.length <= 5000,
            'This export exceeds the record limit. Select a smaller range.',
          );
        }
        return new Response(content, {
          headers: {
            'Content-Type':
              format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
            'Content-Disposition':
              'attachment; filename="splitwise-ai-' +
              kind +
              '-' +
              new Date().toISOString().slice(0, 10) +
              '.' +
              format +
              '"',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
          },
        });
      }
      if (key === 'rules/optimize/preview')
        return Response.json(service.previewRuleOptimization(), {
          headers: { 'Cache-Control': 'no-store' },
        });
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
      if (key === 'transactions')
        return Response.json(
          queryLedger(
            service.db,
            {
              view: 'finalized',
              positive: true,
              search: url.searchParams.get('search') || undefined,
              page: Number(url.searchParams.get('page') || 0),
            },
            50,
          ),
          { headers: { 'Cache-Control': 'no-store' } },
        );
      if (path[0] === 'transactions' && path.length === 2)
        return Response.json(service.transaction(path[1]), {
          headers: { 'Cache-Control': 'no-store' },
        });
      if (path[0] === 'balances' && path.length === 2)
        return Response.json(
          service.personLedger(
            path[1],
            url.searchParams.get('from') || undefined,
            url.searchParams.get('to') || undefined,
            Number(url.searchParams.get('page') || 0),
          ),
          { headers: { 'Cache-Control': 'no-store' } },
        );
      if (key === 'state')
        return Response.json(
          service.snapshot(
            url.searchParams.get('from') || undefined,
            url.searchParams.get('to') || undefined,
            url.searchParams.has('paged') || config().production
              ? {
                  view: url.searchParams.get('view') || 'overview',
                  page: Number(url.searchParams.get('page') || 0),
                  search: url.searchParams.get('search') || undefined,
                  accountId: url.searchParams.get('account') || undefined,
                  personId: url.searchParams.get('person') || undefined,
                }
              : undefined,
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
              let signedIn = true;
              try {
                authenticate(req);
              } catch {
                signedIn = false;
              }
              if (
                !signedIn ||
                req.signal.aborted ||
                (principal &&
                  !controlDb()
                    .prepare("SELECT id FROM principals WHERE id=? AND status='active'")
                    .get(principal.id))
              ) {
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
            'X-Accel-Buffering': 'no',
          },
        });
      }
      throw new AppError('Not found.', 404);
    }
    if (key === 'transfer/preview') {
      const form = await boundedForm(req);
      const file = form.get('file');
      invariant(
        file instanceof File && file.size <= 10_000_000,
        'Choose a JSON file smaller than 10 MB.',
      );
      const kind = z.enum(['transactions', 'rules']).parse(form.get('kind'));
      return Response.json(new DataTransfer(service).preview(kind, file.name, await file.text()));
    }
    if (key === 'imports/preview') {
      const form = await boundedForm(req);
      const file = form.get('file');
      invariant(
        file instanceof File && file.size <= 10_000_000,
        'Choose a CSV file smaller than 10 MB.',
      );
      return Response.json(
        service.preview(String(form.get('accountId') || ''), file.name, await file.text()),
      );
    }
    const body = await boundedJson(req, key === 'imports/finish' ? 8_000_000 : 2_000_000);
    if (key === 'account/delete') {
      invariant(principal, 'Account deletion requires a signed-in account.', 403);
      z.object({ confirm: z.literal('DELETE') }).parse(body);
      controlDb()
        .transaction(() => {
          controlDb()
            .prepare("UPDATE principals SET status='deleting',deletionAt=? WHERE id=?")
            .run(Date.now(), principal.id);
          controlDb().prepare('DELETE FROM sessions WHERE principalId=?').run(principal.id);
        })
        .immediate();
      service.db
        .prepare(
          "UPDATE jobs SET cancelRequested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE status IN ('queued','running')",
        )
        .run();
      return Response.json(
        { ok: true },
        { headers: { 'Set-Cookie': secureCookie(SESSION_COOKIE, '', 0) } },
      );
    }
    if (key === 'settings') {
      const a = z.object({ timezone: z.string().max(100), consent: z.boolean() }).parse(body);
      service.updateSettings(a.timezone, a.consent);
      return Response.json({ ok: true });
    }
    if (key === 'accounts') {
      const a = z
        .object({ name: z.string().trim().min(1).max(80), format: z.enum(['chase', 'amex']) })
        .parse(body);
      return Response.json({ id: service.addAccount(a.name, a.format) });
    }
    if (key === 'transfer/confirm') {
      const a = z
        .object({
          id: z.string(),
          acknowledgeSkips: z.boolean(),
          acknowledgePeople: z.boolean(),
          keepRows: z.array(z.number().int().positive()).max(50000),
        })
        .parse(body);
      return Response.json(
        new DataTransfer(service).confirm(
          a.id,
          a.acknowledgeSkips,
          a.keepRows,
          a.acknowledgePeople,
        ),
      );
    }
    if (key === 'imports/finish') {
      const a = z
        .object({
          id: z.string(),
          items: z.array(itemSchema).max(50000),
          context: z.string().max(4000),
          process: z.boolean(),
          from: z.string().optional(),
          to: z.string().optional(),
        })
        .parse(body);
      return Response.json(service.finishImport(a.id, a.items, a.context, a.process, a.from, a.to));
    }
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
    if (key === 'transactions/instruct') {
      const a = z
        .object({
          items: z.array(itemSchema).min(1).max(100),
          text: z.string().trim().min(1).max(4000),
        })
        .parse(body);
      return Response.json({ id: service.instruct(a.items, a.text) });
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
    if (key === 'refunds/quote') {
      const a = z.object({ refundId: z.string(), originalId: z.string() }).parse(body);
      return Response.json(service.quoteRefund(a.refundId, a.originalId));
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
    if (key === 'rules/delete') {
      const a = itemSchema.parse(body);
      return Response.json({ affected: service.deleteRule(a.id, a.version) });
    }
    if (key === 'rules/optimize/apply') {
      const a = z
        .object({ revision: z.string().length(64), groupIds: z.array(z.string()).min(1).max(1000) })
        .parse(body);
      return Response.json(service.applyRuleOptimization(a.revision, a.groupIds));
    }
    if (key === 'rules/propose') {
      const a = z
        .object({
          title: z.string(),
          definition: z.object({
            merchant: z.string(),
            merchantAliases: z.array(z.string().min(1).max(200)).max(199).optional(),
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
      const a = z
        .object({ id: z.string(), approve: z.boolean(), processInbox: z.boolean().optional() })
        .parse(body);
      return Response.json({
        ok: true,
        ...service.reviewRuleAndProcess(a.id, a.approve, a.processInbox),
      });
    }
    if (key === 'repayments') {
      const a = z
        .object({
          personId: z.string(),
          date: z.string(),
          amountCents: z.number().int(),
          direction: z.enum(['received', 'returned']),
          note: z.string().max(500),
          requestId: z.string().min(16).max(100),
        })
        .parse(body);
      const id = service.addRepayment(
        a.personId,
        a.date,
        a.amountCents,
        a.direction,
        a.note,
        'user',
        a.requestId,
      );
      return Response.json({ ok: true, id });
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
    log('request_failed', { requestId, status: 500, elapsedMs: Date.now() - started });
    return Response.json(
      { error: 'Unable to complete this action. Please try again.', requestId },
      { status: 500 },
    );
  }
}
async function instrumented(req: Request, context: Context) {
  const started = Date.now(),
    requestId = randomUUID(),
    response = await handle(req, context, requestId);
  response.headers.set('X-Request-ID', requestId);
  response.headers.set('Cache-Control', 'no-store');
  if (response.status === 429) response.headers.set('Retry-After', '60');
  log('http_request', { requestId, status: response.status, elapsedMs: Date.now() - started });
  return response;
}
export const GET = instrumented;
export const POST = instrumented;
