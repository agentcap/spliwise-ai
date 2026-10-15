import { z } from 'zod';
import { Features } from './features';
import { AssistantService } from './assistant-service';
import type { Store } from './store';
import { boundedJson, boundedForm } from './security';
import { invariant } from './errors';
export async function featureRequest(
  store: Store,
  key: string,
  req: Request,
): Promise<Response | undefined> {
  const f = new Features(store),
    url = new URL(req.url),
    parts = key.split('/');
  if (req.method === 'GET') {
    if (parts[0] === 'trips' && parts[2] === 'suggestions')
      return Response.json(f.suggestions(parts[1], Number(url.searchParams.get('page') || 0)));
    if (parts[0] === 'attachments' && parts.length === 2) return f.download(parts[1]);
    if (parts[0] === 'transaction-files' && parts.length === 2)
      return Response.json(f.attachments(parts[1]));
    if (parts[0] === 'transaction-source' && parts.length === 2) {
      const tx = store.transaction(parts[1]);
      return Response.json({
        source: tx.source || 'import',
        row: store.one('SELECT raw,rowNumber FROM import_rows WHERE id=?', tx.importRowId),
        history: store.all(
          "SELECT id,label,actor,createdAt,undoneAt FROM action_batches WHERE EXISTS(SELECT 1 FROM json_each(undo) WHERE json_extract(value,'$.id')=?) ORDER BY sequence DESC LIMIT 30",
          tx.id,
        ),
      });
    }
    if (parts[0] === 'settlements' && parts.length === 2)
      return new Response(
        f.settlement(
          parts[1],
          url.searchParams.get('from') || undefined,
          url.searchParams.get('to') || undefined,
          url.searchParams.get('trip') || undefined,
        ),
        {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': 'attachment; filename="expense-summary.txt"',
            'Cache-Control': 'no-store',
          },
        },
      );
    return;
  }
  if (
    parts[0] === 'assistant-requests' &&
    parts.length === 3 &&
    ['apply', 'dismiss', 'finalize'].includes(parts[2])
  ) {
    await boundedJson(req, 1000);
    const assistant = new AssistantService(store);
    if (parts[2] === 'apply') return Response.json(assistant.applyRequest(parts[1]));
    if (parts[2] === 'finalize') return Response.json(assistant.finalizeRequest(parts[1]));
    assistant.dismissRequest(parts[1]);
    return Response.json({ ok: true });
  }
  if (key === 'context/delete') {
    const a = z
      .object({ id: z.string(), version: z.number().int().positive() })
      .parse(await boundedJson(req, 1000));
    const context = new AssistantService(store).contexts().find((c) => c.id === a.id);
    invariant(context?.version === a.version, 'Context changed. Refresh.', 409);
    store.batch('user', 'Forget saved context', [{ table: 'user_context', id: a.id }], () =>
      store.db.prepare('DELETE FROM user_context WHERE id=?').run(a.id),
    );
    return Response.json({ ok: true });
  }
  if (key === 'attachments/upload') {
    const form = await boundedForm(req),
      file = form.get('file');
    invariant(
      file instanceof File && file.size <= 5_000_000,
      'Choose a PNG, JPEG or PDF receipt smaller than 5 MB.',
    );
    return Response.json(
      f.addAttachment(
        String(form.get('transactionId') || ''),
        file.name,
        file.type,
        new Uint8Array(await file.arrayBuffer()),
      ),
    );
  }
  if (
    ![
      'trips/save',
      'trips/archive',
      'trips/assign',
      'templates/save',
      'templates/delete',
      'aliases/save',
      'aliases/delete',
      'transactions/quick',
      'transactions/manual',
      'attachments/delete',
      'onboarding',
    ].includes(key)
  )
    return;
  const body = await boundedJson(req, 2_000_000);
  if (key === 'trips/save') return Response.json(f.saveTrip(body));
  if (key === 'trips/assign') {
    const a = z
      .object({
        items: z
          .array(z.object({ id: z.string(), version: z.number().int().positive() }))
          .min(1)
          .max(1000),
        tripId: z.string().nullable(),
      })
      .parse(body);
    return Response.json(f.assign(a.items, a.tripId));
  }
  if (key === 'trips/archive') {
    const a = z
      .object({ id: z.string(), version: z.number().int().positive(), archived: z.boolean() })
      .parse(body);
    f.archive(a.id, a.version, a.archived);
    return Response.json({ ok: true });
  }
  if (key === 'templates/save') return Response.json(f.saveTemplate(body));
  if (key === 'aliases/save') return Response.json(f.saveAlias(body));
  if (key === 'templates/delete' || key === 'aliases/delete') {
    const a = z.object({ id: z.string(), version: z.number().int().positive() }).parse(body);
    f.remove(key.startsWith('templates') ? 'template' : 'alias', a.id, a.version);
    return Response.json({ ok: true });
  }
  if (key === 'transactions/quick') return Response.json(f.quick(body));
  if (key === 'transactions/manual') return Response.json(f.manual(body));
  if (key === 'attachments/delete') {
    const a = z.object({ id: z.string() }).parse(body);
    f.removeAttachment(a.id);
    return Response.json({ ok: true });
  }
  const a = z.object({ dismissed: z.boolean() }).parse(body);
  const settings = store.settings();
  store.db
    .prepare(
      "INSERT INTO workspace_settings(id,timezone,consentAt,onboardingDismissed) VALUES('main',?,?,?) ON CONFLICT(id) DO UPDATE SET onboardingDismissed=excluded.onboardingDismissed",
    )
    .run(settings.timezone, settings.consentAt, Number(a.dismissed));
  return Response.json({ ok: true });
}
