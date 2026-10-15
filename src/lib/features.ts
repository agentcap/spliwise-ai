import { randomUUID, createHash } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store';
import type {
  Actor,
  Trip,
  TripSummary,
  SplitSpec,
  SplitTemplate,
  MerchantAlias,
  Transaction,
  Proposal,
  Attachment,
} from './types';
import { isoDate, splitAmount, money } from './money';
import { invariant } from './errors';
import { normalizeMerchant } from './rule-definition';
const now = () => new Date().toISOString();
const specSchema = z.object({
  mode: z.enum(['personal', 'equal', 'exact', 'percent']),
  participants: z.array(z.string()).min(1).max(30),
  values: z.array(z.number().int().safe().nonnegative()).max(30).optional(),
});
const itemSchema = z.object({ id: z.string(), version: z.number().int().positive() });
export const tripSchema = z.object({
  id: z.string().optional(),
  version: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(100),
  destination: z.string().trim().max(150),
  from: z.string(),
  to: z.string(),
  split: specSchema,
  context: z.string().trim().max(4000),
});
export type TripInput = z.infer<typeof tripSchema>;
export function displayMerchant(description: string, aliases: MerchantAlias[]) {
  const matches = aliases
    .filter((a) => normalizeMerchant(description).includes(a.pattern))
    .sort((a, b) => b.pattern.length - a.pattern.length);
  return matches.length &&
    !matches.some(
      (a) => a.pattern.length === matches[0].pattern.length && a.name !== matches[0].name,
    )
    ? matches[0].name
    : description;
}
export class Features {
  constructor(public store: Store) {}
  private user(actor: Actor) {
    invariant(actor === 'user', 'Only you can change workspace organization or add expenses.', 403);
  }
  private checkSpec(spec: SplitSpec) {
    invariant(
      new Set(spec.participants).size === spec.participants.length,
      'Choose distinct participants.',
    );
    for (const id of spec.participants)
      invariant(
        this.store.people().some((p) => p.id === id),
        'A participant no longer exists.',
      );
    splitAmount(
      spec.mode === 'exact' ? (spec.values || []).reduce((a, b) => a + b, 0) : 10000,
      spec,
    );
  }
  trips(): Trip[] {
    return this.store
      .all<Record<string, unknown>>(
        'SELECT *, "from" AS startDate, "to" AS endDate FROM trips ORDER BY createdAt DESC,id',
      )
      .map((t) => ({
        ...t,
        from: t.startDate,
        to: t.endDate,
        participants: JSON.parse(t.participants as string),
        split: JSON.parse(t.split as string),
      })) as unknown as Trip[];
  }
  trip(id: string) {
    const t = this.trips().find((t) => t.id === id);
    invariant(t, 'Trip not found.', 404);
    return t;
  }
  templates(): SplitTemplate[] {
    return this.store
      .all<Record<string, unknown>>('SELECT * FROM split_templates ORDER BY name,id')
      .map((t) => ({ ...t, spec: JSON.parse(t.spec as string) })) as unknown as SplitTemplate[];
  }
  aliases(): MerchantAlias[] {
    return this.store.all('SELECT * FROM merchant_aliases ORDER BY length(pattern) DESC,id');
  }
  snapshot() {
    const totals = this.store.all<{
      tripId: string;
      count: number;
      unfinished: number;
      totalCents: number;
      yourShareCents: number;
    }>(
      "SELECT tripId,COUNT(*) count,SUM(state!='finalized') unfinished,COALESCE(SUM(CASE WHEN state='finalized' THEN amountCents ELSE 0 END),0) totalCents,COALESCE(SUM(CASE WHEN state='finalized' THEN COALESCE((SELECT json_extract(s.value,'$.amountCents') FROM json_each(json_extract(proposal,'$.splits')) s WHERE json_extract(s.value,'$.personId')='self'),0) ELSE 0 END),0) yourShareCents FROM transactions WHERE tripId IS NOT NULL GROUP BY tripId",
    );
    return {
      trips: this.trips().map((t) => ({
        ...t,
        count: 0,
        unfinished: 0,
        totalCents: 0,
        yourShareCents: 0,
        ...totals.find((x) => x.tripId === t.id),
      })) as TripSummary[],
      templates: this.templates(),
      aliases: this.aliases(),
      onboardingDismissed: !!this.store.one<{ onboardingDismissed: number }>(
        "SELECT onboardingDismissed FROM workspace_settings WHERE id='main'",
      )?.onboardingDismissed,
      lastSplit: JSON.parse(
        this.store.one<{ spec: string }>(
          "SELECT json_extract(proposal,'$.spec') spec FROM transactions WHERE state='finalized' AND json_extract(proposal,'$.spec') IS NOT NULL ORDER BY updatedAt DESC,id LIMIT 1",
        )?.spec || 'null',
      ),
    };
  }
  saveTrip(input: unknown, actor: Actor = 'user') {
    this.user(actor);
    const a = tripSchema.parse(input);
    isoDate(a.from);
    isoDate(a.to);
    invariant(a.from <= a.to, 'Trip start must precede its end.');
    this.checkSpec(a.split);
    this.store.resolveMentions(a.context);
    return this.store.db
      .transaction(() => {
        const old = a.id ? this.trip(a.id) : undefined;
        if (old) invariant(a.version === old.version, 'Trip changed. Refresh before saving.', 409);
        const id = old?.id || randomUUID();
        const affected = old
          ? this.store.unfinishedTransactions().filter((t) => t.tripId === id)
          : [];
        this.store.batch(
          'user',
          old ? 'Update trip ' + a.name : 'Create trip ' + a.name,
          [
            { table: 'trips', id },
            ...affected.map((t) => ({ table: 'transactions' as const, id: t.id })),
          ],
          (batchId) => {
            if (old)
              this.store.db
                .prepare(
                  'UPDATE trips SET name=?,destination=?,"from"=?,"to"=?,participants=?,split=?,context=?,version=version+1 WHERE id=?',
                )
                .run(
                  a.name,
                  a.destination,
                  a.from,
                  a.to,
                  JSON.stringify(a.split.participants),
                  JSON.stringify(a.split),
                  a.context,
                  id,
                );
            else
              this.store.db
                .prepare(
                  'INSERT INTO trips(id,name,destination,"from","to",participants,split,context,createdAt) VALUES(?,?,?,?,?,?,?,?,?)',
                )
                .run(
                  id,
                  a.name,
                  a.destination,
                  a.from,
                  a.to,
                  JSON.stringify(a.split.participants),
                  JSON.stringify(a.split),
                  a.context,
                  now(),
                );
            for (const tx of affected)
              this.store.db
                .prepare(
                  "UPDATE transactions SET proposal=NULL,state='inbox',attention='Trip defaults changed. Generate a new split.',version=version+1,batchId=?,updatedAt=? WHERE id=?",
                )
                .run(batchId, now(), tx.id);
          },
        );
        return { id };
      })
      .immediate();
  }
  archive(id: string, version: number, archived: boolean, actor: Actor = 'user') {
    this.user(actor);
    const t = this.trip(id);
    invariant(t.version === version, 'Trip changed. Refresh.', 409);
    invariant(
      !archived ||
        !this.store.one(
          "SELECT id FROM transactions WHERE tripId=? AND state!='finalized' LIMIT 1",
          id,
        ),
      'Review every trip expense before archiving.',
    );
    this.store.batch(
      'user',
      archived ? 'Archive trip' : 'Reopen trip',
      [{ table: 'trips', id }],
      () =>
        this.store.db
          .prepare('UPDATE trips SET status=?,version=version+1 WHERE id=?')
          .run(archived ? 'archived' : 'active', id),
    );
  }
  assign(items: { id: string; version: number }[], tripId: string | null, actor: Actor = 'user') {
    this.user(actor);
    z.array(itemSchema).min(1).max(1000).parse(items);
    invariant(new Set(items.map((i) => i.id)).size === items.length, 'Duplicate selection.');
    return this.store.db
      .transaction(() => {
        if (tripId)
          invariant(
            this.trip(tripId).status === 'active',
            'Reopen this trip before assigning expenses.',
          );
        this.store.batch(
          'user',
          tripId
            ? 'Assign ' + items.length + ' expenses to trip'
            : 'Remove ' + items.length + ' expenses from trip',
          items.map((i) => ({ table: 'transactions', id: i.id })),
          (batchId) => {
            for (const item of items) {
              const tx = this.store.transaction(item.id);
              invariant(
                tx.version === item.version,
                'An expense changed. Refresh the selection.',
                409,
              );
              this.store.db
                .prepare(
                  "UPDATE transactions SET tripId=?,proposal=CASE WHEN state='finalized' THEN proposal ELSE NULL END,state=CASE WHEN state='finalized' THEN state ELSE 'inbox' END,attention='',version=version+1,batchId=?,updatedAt=? WHERE id=?",
                )
                .run(tripId, batchId, now(), tx.id);
            }
          },
        );
        return { count: items.length };
      })
      .immediate();
  }
  suggestions(id: string, page = 0) {
    const t = this.trip(id);
    invariant(Number.isInteger(page) && page >= 0, 'Invalid page.');
    const query = this.store.all<{ id: string }>(
      'SELECT id FROM transactions WHERE tripId IS NULL AND date>=? AND date<=? ORDER BY date,id LIMIT 50 OFFSET ?',
      t.from,
      t.to,
      page * 50,
    );
    return {
      transactions: query.map((x) => this.store.transaction(x.id)),
      total: this.store.one<{ n: number }>(
        'SELECT COUNT(*) n FROM transactions WHERE tripId IS NULL AND date>=? AND date<=?',
        t.from,
        t.to,
      )!.n,
      page,
    };
  }
  tripProposal(tx: Transaction): { proposal?: Proposal; error?: string } {
    if (!tx.tripId) return {};
    const trip = this.trip(tx.tripId);
    if (trip.status !== 'active')
      return { error: 'This trip is archived. Reopen it before generating splits.' };
    try {
      return {
        proposal: {
          splits: splitAmount(tx.amountCents, trip.split),
          spec: trip.split,
          category: tx.bankCategory || 'Travel',
          confidence: 'high',
          source: 'trip',
          tripId: trip.id,
          tripVersion: trip.version,
          explanation:
            'Trip default: ' +
            trip.name +
            '. ' +
            (trip.context ? 'Saved trip context is available in details.' : ''),
        },
      };
    } catch (e) {
      return { error: e instanceof Error ? e.message : 'Trip split does not match this amount.' };
    }
  }
  saveTemplate(input: unknown, actor: Actor = 'user') {
    this.user(actor);
    const a = z
      .object({
        id: z.string().optional(),
        version: z.number().int().optional(),
        name: z.string().trim().min(1).max(100),
        spec: specSchema,
        category: z.string().trim().min(1).max(80),
      })
      .parse(input);
    this.checkSpec(a.spec);
    const id = a.id || randomUUID();
    const old = this.templates().find((t) => t.id === id);
    invariant(!a.id || old, 'Template not found.', 404);
    invariant(!old || old.version === a.version, 'Template changed. Refresh.', 409);
    this.store.batch(
      'user',
      old ? 'Update split template' : 'Create split template',
      [{ table: 'split_templates', id }],
      () => {
        if (old)
          this.store.db
            .prepare(
              'UPDATE split_templates SET name=?,spec=?,category=?,version=version+1 WHERE id=?',
            )
            .run(a.name, JSON.stringify(a.spec), a.category, id);
        else
          this.store.db
            .prepare('INSERT INTO split_templates(id,name,spec,category) VALUES(?,?,?,?)')
            .run(id, a.name, JSON.stringify(a.spec), a.category);
      },
    );
    return { id };
  }
  saveAlias(input: unknown, actor: Actor = 'user') {
    this.user(actor);
    const a = z
      .object({
        pattern: z.string().trim().min(2).max(200),
        name: z.string().trim().min(1).max(100),
      })
      .parse(input);
    const pattern = normalizeMerchant(a.pattern);
    invariant(pattern.length >= 2, 'Use at least two merchant characters.');
    invariant(
      !this.aliases().some((x) => x.pattern === pattern),
      'That merchant pattern already has a name. Delete it before replacing.',
    );
    const id = randomUUID();
    this.store.batch('user', 'Name merchant', [{ table: 'merchant_aliases', id }], () =>
      this.store.db
        .prepare('INSERT INTO merchant_aliases(id,pattern,name) VALUES(?,?,?)')
        .run(id, pattern, a.name),
    );
    return { id };
  }
  remove(kind: 'template' | 'alias', id: string, version: number, actor: Actor = 'user') {
    this.user(actor);
    const table = kind === 'template' ? 'split_templates' : 'merchant_aliases';
    const old = this.store.one<{ version: number }>(
      'SELECT version FROM ' + table + ' WHERE id=?',
      id,
    );
    invariant(old, 'Item not found.', 404);
    invariant(old.version === version, 'Item changed. Refresh.', 409);
    this.store.batch('user', 'Delete ' + kind, [{ table, id }], () =>
      this.store.db.prepare('DELETE FROM ' + table + ' WHERE id=?').run(id),
    );
  }
  quick(input: unknown, actor: Actor = 'user') {
    this.user(actor);
    const a = z
      .object({
        items: z.array(itemSchema).min(1).max(100),
        mode: z.enum(['personal', 'equal', 'last', 'template', 'trip']),
        participants: z.array(z.string()).max(30).optional(),
        templateId: z.string().optional(),
        category: z.string().max(80).optional(),
      })
      .parse(input);
    invariant(new Set(a.items.map((i) => i.id)).size === a.items.length, 'Duplicate selection.');
    let spec: SplitSpec,
      category = a.category || '';
    if (a.mode === 'trip') {
      const tx = this.store.transaction(a.items[0].id);
      invariant(
        tx.tripId && a.items.every((i) => this.store.transaction(i.id).tripId === tx.tripId),
        'Select expenses from one trip.',
      );
      spec = this.trip(tx.tripId).split;
    } else if (a.mode === 'template') {
      const t = this.templates().find((t) => t.id === a.templateId);
      invariant(t, 'Template not found.', 404);
      spec = t.spec;
      category = t.category;
    } else if (a.mode === 'last') {
      const last = this.snapshot().lastSplit;
      invariant(last, 'Finalize a split with a saved method first.');
      spec = last;
    } else
      spec = {
        mode: a.mode,
        participants: a.mode === 'personal' ? ['self'] : a.participants || [],
      };
    this.checkSpec(spec);
    this.store.saveProposals(
      a.items.map((item) => {
        const tx = this.store.transaction(item.id);
        return {
          ...item,
          state: 'ready' as const,
          proposal: {
            splits: splitAmount(tx.amountCents, spec),
            spec,
            category: category || tx.bankCategory || 'Uncategorized',
            confidence: 'high' as const,
            source: 'manual' as const,
            explanation:
              a.mode === 'template'
                ? 'Saved split template.'
                : a.mode === 'last'
                  ? 'Reused your last finalized split.'
                  : 'Quick split chosen by you.',
          },
        };
      }),
      'user',
    );
    return { count: a.items.length };
  }
  manual(input: unknown, actor: Actor = 'user') {
    this.user(actor);
    const a = z
      .object({
        description: z.string().trim().min(1).max(200),
        date: z.string(),
        amountCents: z.number().int().safe().positive().max(1_000_000_000_000),
        category: z.string().trim().min(1).max(80),
        note: z.string().trim().max(4000),
        tripId: z.string().nullable(),
        requestId: z.string().uuid(),
      })
      .parse(input);
    isoDate(a.date);
    this.store.resolveMentions(a.note);
    return this.store.db
      .transaction(() => {
        if (a.tripId) invariant(this.trip(a.tripId).status === 'active', 'Choose an active trip.');
        const key = 'manual:' + a.requestId,
          digest = createHash('sha256').update(JSON.stringify(a)).digest('hex');
        const previous = this.store.one<{ digest: string; response: string }>(
          'SELECT * FROM receipts WHERE key=?',
          key,
        );
        if (previous) {
          invariant(previous.digest === digest, 'This request ID was already used.', 409);
          const result = JSON.parse(previous.response);
          invariant(
            this.store.one('SELECT id FROM transactions WHERE id=?', result.id),
            'That expense was undone. Start a new expense.',
            409,
          );
          return result;
        }
        const id = randomUUID(),
          importId = randomUUID(),
          rowId = randomUUID();
        this.store.db
          .prepare(
            "INSERT OR IGNORE INTO accounts(id,name,format) VALUES('manual','Cash & manual','amex')",
          )
          .run();
        this.store.db
          .prepare(
            "INSERT INTO imports(id,accountId,fileName,hash,status,preview,createdAt) VALUES(?,'manual','Manual expense',?,'manual','{}',?)",
          )
          .run(importId, key, now());
        this.store.db
          .prepare(
            "INSERT INTO import_rows(id,importId,accountId,rowNumber,fingerprint,raw,kind,status) VALUES(?,?,'manual',1,?,?,'expense','manual')",
          )
          .run(
            rowId,
            importId,
            key,
            JSON.stringify({
              Date: a.date,
              Description: a.description,
              Amount: (a.amountCents / 100).toFixed(2),
              Note: a.note,
            }),
          );
        this.store.batch('user', 'Add manual expense', [{ table: 'transactions', id }], (batchId) =>
          this.store.db
            .prepare(
              "INSERT INTO transactions(id,accountId,importRowId,date,description,amountCents,kind,bankCategory,tripId,source,notes,batchId,updatedAt) VALUES(?,'manual',?,?,?,?,'expense',?,?,'manual',?,?,?)",
            )
            .run(
              id,
              rowId,
              a.date,
              a.description,
              a.amountCents,
              a.category,
              a.tripId,
              JSON.stringify(
                a.note
                  ? [{ id: randomUUID(), text: a.note, source: 'instruction', createdAt: now() }]
                  : [],
              ),
              batchId,
              now(),
            ),
        );
        this.store.db
          .prepare('INSERT INTO receipts(key,digest,response,createdAt) VALUES(?,?,?,?)')
          .run(key, digest, JSON.stringify({ id }), now());
        return { id };
      })
      .immediate();
  }
  attachments(transactionId: string): Attachment[] {
    this.store.transaction(transactionId);
    return this.store.all(
      'SELECT id,transactionId,name,mime,size,createdAt FROM attachments WHERE transactionId=? ORDER BY createdAt,id',
      transactionId,
    );
  }
  addAttachment(
    transactionId: string,
    name: string,
    mime: string,
    bytes: Uint8Array,
    actor: Actor = 'user',
  ) {
    this.user(actor);
    this.store.transaction(transactionId);
    const data = Buffer.from(bytes);
    const detected = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : data[0] === 255 && data[1] === 216 && data[2] === 255
        ? 'image/jpeg'
        : data.subarray(0, 5).toString() === '%PDF-'
          ? 'application/pdf'
          : null;
    invariant(
      detected && detected === mime,
      'Choose a PNG, JPEG or PDF receipt with matching file contents.',
    );
    invariant(data.length > 0 && data.length <= 5_000_000, 'Receipts must be smaller than 5 MB.');
    return this.store.db
      .transaction(() => {
        invariant(
          this.attachments(transactionId).length < 10,
          'Keep up to 10 receipts per expense.',
        );
        const id = randomUUID();
        this.store.batch('user', 'Attach receipt', [{ table: 'attachments', id }], () =>
          this.store.db
            .prepare(
              'INSERT INTO attachments(id,transactionId,name,mime,size,data,createdAt) VALUES(?,?,?,?,?,?,?)',
            )
            .run(
              id,
              transactionId,
              name.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(0, 120) || 'Receipt',
              mime,
              data.length,
              data.toString('base64'),
              now(),
            ),
        );
        return { id };
      })
      .immediate();
  }
  download(id: string) {
    const file = this.store.one<Attachment & { data: string }>(
      'SELECT * FROM attachments WHERE id=?',
      id,
    );
    invariant(file, 'Receipt not found.', 404);
    return new Response(Buffer.from(file.data, 'base64'), {
      headers: {
        'Content-Type': file.mime,
        'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.name),
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "sandbox; default-src 'none'",
        'Cache-Control': 'no-store',
      },
    });
  }
  removeAttachment(id: string, actor: Actor = 'user') {
    this.user(actor);
    invariant(
      this.store.one('SELECT id FROM attachments WHERE id=?', id),
      'Receipt not found.',
      404,
    );
    this.store.batch('user', 'Remove receipt', [{ table: 'attachments', id }], () =>
      this.store.db.prepare('DELETE FROM attachments WHERE id=?').run(id),
    );
  }
  settlement(personId: string, from?: string, to?: string, tripId?: string) {
    const person = this.store.dashboard(from, to).people.find((p) => p.person.id === personId);
    invariant(person, 'Person not found.', 404);
    const trip = tripId ? this.trip(tripId) : undefined;
    const ids = trip
      ? new Set(
          this.store
            .all<{ id: string }>('SELECT id FROM transactions WHERE tripId=?', trip.id)
            .map((t) => t.id),
        )
      : undefined;
    const expenses = person.expenses.filter(
      (e) =>
        (!from || e.date >= from) && (!to || e.date <= to) && (!ids || ids.has(e.transactionId)),
    );
    const lines = [
      'Expense summary for ' + person.person.name,
      trip
        ? 'Trip: ' + trip.name
        : 'Expense dates: ' + (from || 'Beginning') + ' to ' + (to || 'Today'),
      'Generated ' + now().slice(0, 10) + ' · USD',
      '',
      ...expenses.map(
        (e) => e.date + ' · ' + e.description + ' · unpaid ' + money(e.remainingCents),
      ),
      '',
      'Unpaid for these expenses: ' + money(expenses.reduce((s, e) => s + e.remainingCents, 0)),
      'All-time outstanding: ' + money(person.outstandingCents),
      'Available credit: ' + money(person.creditCents),
      '',
      'Includes repayments received after the expense dates. This is a summary, not a payment request sent by the app.',
    ];
    return lines.join('\n');
  }
}
