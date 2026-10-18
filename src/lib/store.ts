import { randomUUID, createHash } from 'node:crypto';
import type { Sqlite } from '../db';
import { invariant, AppError } from './errors';
import { Features } from './features';
import { AssistantService } from './assistant-service';
import { config } from './config';
import { queryLedger, type LedgerQuery } from './ledger-query';
import { isoDate, linkedRefundShares, cents, splitAmount } from './money';
import { parseStatement, normalizedDescription } from './importer';
import { calculateDashboard } from './balances';
import { matchingRules } from './rules';
import { optimizeRules } from './rule-optimizer';
import type {
  Account,
  Actor,
  ActionBatch,
  AgentJob,
  ImportPreview,
  ImportResult,
  ImportCompletion,
  ParsedRow,
  PreviewRow,
  Person,
  Proposal,
  Repayment,
  Rule,
  RuleChange,
  RuleDefinition,
  Snapshot,
  Transaction,
  TransactionState,
  Message,
  Category,
  RuleOptimizationGroup,
  RuleOptimizationPreview,
} from './types';
type Raw = Record<string, unknown>;
type Undo = {
  table:
    | 'transactions'
    | 'rules'
    | 'rule_changes'
    | 'repayments'
    | 'trips'
    | 'split_templates'
    | 'merchant_aliases'
    | 'attachments'
    | 'user_context'
    | 'people';
  id: string;
  before: Raw | null;
};
const now = () => new Date().toISOString();
const dashboards = new WeakMap<
  Sqlite,
  { key: string; value: ReturnType<typeof calculateDashboard> }
>();
export class Store {
  constructor(
    public db: Sqlite,
    public workspaceId = 'local',
  ) {}
  all<T>(sql: string, ...args: unknown[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  one<T>(sql: string, ...args: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
  }
  settings(): { timezone: string; consentAt: string | null; aiModel: 'hosted' | 'gemma-v2' } {
    return (
      this.one('SELECT timezone,consentAt,aiModel FROM workspace_settings WHERE id=?', 'main') || {
        timezone: 'America/Los_Angeles',
        consentAt: null,
        aiModel: 'hosted',
      }
    );
  }
  updateSettings(timezone: string, consent: boolean, aiModel = this.settings().aiModel) {
    invariant(aiModel === 'hosted' || aiModel === 'gemma-v2', 'Choose a supported AI model.');
    try {
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    } catch {
      throw new AppError('Choose a valid IANA time zone.');
    }
    this.db
      .prepare(
        'INSERT INTO workspace_settings(id,timezone,consentAt,aiModel) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET timezone=excluded.timezone,consentAt=excluded.consentAt,aiModel=excluded.aiModel',
      )
      .run('main', timezone, consent ? this.settings().consentAt || now() : null, aiModel);
    if (!consent)
      this.db
        .prepare(
          "UPDATE jobs SET cancelRequested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END WHERE status IN ('queued','running')",
        )
        .run();
  }
  addAccount(name: string, format: 'chase' | 'amex') {
    invariant(
      name.trim() && name.length <= 80 && ['chase', 'amex'].includes(format),
      'Choose an account name and supported format.',
    );
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO accounts(id,name,format) VALUES(?,?,?)')
      .run(id, name.trim(), format);
    return id;
  }
  people(): Person[] {
    return this.all('SELECT * FROM people ORDER BY isSelf DESC,name');
  }
  transactions(): Transaction[] {
    return this.all<Raw>('SELECT * FROM transactions ORDER BY updatedAt DESC,id').map(
      (r) =>
        ({
          ...r,
          proposal: r.proposal ? JSON.parse(r.proposal as string) : null,
          notes: JSON.parse((r.notes as string) || '[]'),
        }) as unknown as Transaction,
    );
  }
  unfinishedTransactions(): Transaction[] {
    return this.all<Raw>(
      "SELECT * FROM transactions WHERE state!='finalized' ORDER BY updatedAt DESC,id",
    ).map((r) => ({
      ...r,
      proposal: r.proposal ? JSON.parse(r.proposal as string) : null,
      notes: JSON.parse(r.notes as string),
    })) as unknown as Transaction[];
  }
  transaction(id: string): Transaction {
    const r = this.one<Raw>('SELECT * FROM transactions WHERE id=?', id);
    invariant(r, 'Transaction not found.', 404);
    return {
      ...r,
      proposal: r.proposal ? JSON.parse(r.proposal as string) : null,
      notes: JSON.parse((r.notes as string) || '[]'),
    } as unknown as Transaction;
  }
  rules(includeCounts = false): Rule[] {
    const counts = includeCounts
      ? new Map(
          this.all<{ id: string; n: number }>(
            "SELECT json_extract(proposal,'$.ruleId') id,COUNT(*) n FROM transactions WHERE state!='finalized' AND proposal IS NOT NULL GROUP BY id",
          ).map((r) => [r.id, r.n]),
        )
      : undefined;
    return this.all<Raw>('SELECT * FROM rules').map((r) => ({
      ...r,
      definition: JSON.parse(r.definition as string),
      ...(counts ? { unfinishedCount: counts.get(String(r.id)) || 0 } : {}),
    })) as unknown as Rule[];
  }
  ruleChanges(): RuleChange[] {
    // Job step keys and undo snapshots already retain the origin of each rule proposal.
    // Derive links here so earlier chat proposals also work without a data migration.
    const origins = new Map<string, string>();
    for (const batch of this.all<{ stepKey: string; undo: string }>(
      "SELECT stepKey,undo FROM action_batches WHERE stepKey LIKE '%:rule:%' AND undoneAt IS NULL",
    )) {
      const match = /^([^:]+):\d+:rule:\d+$/.exec(batch.stepKey);
      if (!match) continue;
      for (const entry of JSON.parse(batch.undo) as Undo[]) {
        if (entry.table === 'rule_changes') origins.set(entry.id, match[1]);
      }
    }
    const inbox = this.unfinishedTransactions().filter((tx) => tx.state === 'inbox');
    return this.all<Raw>('SELECT * FROM rule_changes').map((r) => {
      const definition = JSON.parse(r.definition as string) as RuleDefinition;
      const candidate: Rule = {
        id: String(r.id),
        title: String(r.title),
        definition,
        active: 1,
        version: 1,
      };
      return {
        ...r,
        definition,
        jobId: origins.get(String(r.id)) || null,
        matchingInboxCount: inbox.filter((tx) => matchingRules(tx, [candidate]).length > 0).length,
      } as unknown as RuleChange;
    });
  }
  job(id: string): AgentJob {
    const r = this.one<Raw>('SELECT * FROM jobs WHERE id=?', id);
    invariant(r, 'Job not found.', 404);
    return { ...r, payload: JSON.parse(r.payload as string) } as unknown as AgentJob;
  }
  batch<T>(
    actor: Actor,
    label: string,
    entities: { table: Undo['table']; id: string }[],
    work: (batchId: string) => T,
    stepKey?: string,
  ): T | undefined {
    return this.db
      .transaction(() => {
        if (stepKey && this.one('SELECT id FROM action_batches WHERE stepKey=?', stepKey))
          return undefined;
        const undo: Undo[] = entities
          .filter((e, i, a) => a.findIndex((x) => x.table === e.table && x.id === e.id) === i)
          .map((e) => ({
            ...e,
            before: this.one<Raw>('SELECT * FROM ' + e.table + ' WHERE id=?', e.id) || null,
          }));
        const id = randomUUID();
        const result = work(id);
        this.db
          .prepare(
            'INSERT INTO action_batches(id,label,actor,undo,createdAt,stepKey) VALUES (?,?,?,?,?,?)',
          )
          .run(id, label, actor, JSON.stringify(undo), now(), stepKey || null);
        return result;
      })
      .immediate();
  }
  undo(actor: Actor = 'user'): string {
    invariant(actor === 'user', 'Only you can undo actions.', 403);
    return this.db
      .transaction(() => {
        const last = this.one<Raw>(
          'SELECT * FROM action_batches WHERE undoneAt IS NULL ORDER BY sequence DESC LIMIT 1',
        );
        invariant(last, 'Nothing to undo.');
        const entries = JSON.parse(last.undo as string) as Undo[];
        for (const entry of entries.reverse()) {
          // The table name comes only from our fixed internal allowlist.
          invariant(
            [
              'transactions',
              'rules',
              'rule_changes',
              'repayments',
              'trips',
              'split_templates',
              'merchant_aliases',
              'attachments',
              'user_context',
              'people',
            ].includes(entry.table),
            'Invalid undo record.',
          );
          if (!entry.before) {
            if (entry.table === 'people') {
              const used =
                this.transactions().some((t) =>
                  t.proposal?.splits.some((p) => p.personId === entry.id),
                ) ||
                this.rules().some(
                  (r) => r.active && r.definition.split.participants.includes(entry.id),
                ) ||
                new Features(this).trips().some((t) => t.participants.includes(entry.id)) ||
                new Features(this)
                  .templates()
                  .some((t) => t.spec.participants.includes(entry.id)) ||
                this.one('SELECT id FROM repayments WHERE personId=? LIMIT 1', entry.id) ||
                this.one('SELECT id FROM user_context WHERE personId=? LIMIT 1', entry.id);
              invariant(
                !used,
                'This person is used by expenses or saved context and cannot be undone.',
              );
            }
            this.db.prepare('DELETE FROM ' + entry.table + ' WHERE id=?').run(entry.id);
          } else {
            const cols = Object.keys(entry.before).filter((c) => c !== 'id');
            const values = cols.map((c) => entry.before![c]);
            if (
              [
                'transactions',
                'trips',
                'split_templates',
                'merchant_aliases',
                'user_context',
              ].includes(entry.table)
            ) {
              const index = cols.indexOf('version');
              const current = this.one<{ version: number }>(
                'SELECT version FROM ' + entry.table + ' WHERE id=?',
                entry.id,
              );
              values[index] =
                Math.max(Number(entry.before?.version || 0), current?.version || 0) + 1;
            }
            if (!this.one('SELECT id FROM ' + entry.table + ' WHERE id=?', entry.id)) {
              this.db
                .prepare(
                  'INSERT INTO ' +
                    entry.table +
                    ' (id,' +
                    cols.map((c) => '"' + c + '"').join(',') +
                    ') VALUES (' +
                    [entry.id, ...values].map(() => '?').join(',') +
                    ')',
                )
                .run(entry.id, ...values);
              continue;
            }
            this.db
              .prepare(
                'UPDATE ' +
                  entry.table +
                  ' SET ' +
                  cols.map((c) => '"' + c + '"=?').join(',') +
                  ' WHERE id=?',
              )
              .run(...values, entry.id);
          }
        }
        for (const entry of entries) {
          if (entry.table !== 'transactions' || !entry.before?.proposal) continue;
          const proposal = JSON.parse(String(entry.before.proposal)) as Proposal;
          const oldTrip = entries.find(
            (e) => e.table === 'trips' && e.id === proposal.tripId,
          )?.before;
          if (oldTrip && proposal.tripVersion === oldTrip.version) {
            const trip = this.one<{ version: number }>(
              'SELECT version FROM trips WHERE id=?',
              proposal.tripId,
            );
            if (trip)
              this.db
                .prepare('UPDATE transactions SET proposal=? WHERE id=?')
                .run(JSON.stringify({ ...proposal, tripVersion: trip.version }), entry.id);
          }
        }
        this.db.prepare('UPDATE action_batches SET undoneAt=? WHERE id=?').run(now(), last.id);
        return String(last.label);
      })
      .immediate();
  }
  addPerson(name: string, handle: string, relation = ''): Person {
    name = name.trim();
    handle = handle.trim().replace(/^@/, '').toLowerCase();
    invariant(name.length > 0 && name.length <= 80, 'Name must contain 1–80 characters.');
    invariant(
      /^[a-z][a-z0-9_]{0,39}$/.test(handle),
      'Use a unique handle with letters, numbers, and underscores.',
    );
    invariant(
      !this.one('SELECT id FROM people WHERE handle=?', handle),
      'That @handle is already in use.',
    );
    const p = {
      id: randomUUID(),
      name,
      handle,
      relation: relation.trim().slice(0, 100),
      isSelf: 0,
    };
    this.db
      .prepare(
        'INSERT INTO people(id,name,handle,relation,isSelf) VALUES (@id,@name,@handle,@relation,@isSelf)',
      )
      .run(p);
    return p;
  }
  resolveMentions(text: string, ids: string[] = []): string[] {
    const people = this.people();
    const handles = [...text.matchAll(/@([a-zA-Z][a-zA-Z0-9_]*)/g)].map((m) => m[1].toLowerCase());
    for (const handle of handles)
      invariant(
        people.some((p) => p.handle === handle),
        'Unknown person @' + handle + '. Add or select that person first.',
      );
    for (const id of ids)
      invariant(
        people.some((p) => p.id === id),
        'A mentioned person no longer exists.',
      );
    return [...new Set([...ids, ...handles.map((h) => people.find((p) => p.handle === h)!.id)])];
  }
  previewRows(accountId: string, rows: ParsedRow[]): PreviewRow[] {
    const occurrences = new Map<string, number>();
    const matches = new Map<string, PreviewRow['existing']>();
    const records = this.all<Raw>(
      "SELECT r.fingerprint,r.id,r.raw AS rawData,t.id as transactionId,t.date,t.description,t.amountCents,t.state FROM import_rows r JOIN imports i ON i.id=r.importId LEFT JOIN transactions t ON t.importRowId=r.id WHERE r.accountId=? AND i.status='confirmed' AND r.status IN ('imported','payment') ORDER BY r.rowNumber",
      accountId,
    );
    for (const record of records) {
      const key = String(record.fingerprint),
        list = matches.get(key) || [];
      const raw = JSON.parse(String(record.rawData)) as Record<string, string>;
      list.push({
        id: String(record.transactionId || record.id),
        date: String(record.date || raw.Date || raw['Transaction Date'] || ''),
        description: String(record.description || raw.Description || 'Card-bill payment'),
        amountCents:
          record.amountCents === null
            ? cents(raw.Amount) * (raw.Date ? 1 : -1)
            : Number(record.amountCents),
        state: String(record.state || 'payment'),
      });
      matches.set(key, list);
    }
    return rows.map((row) => {
      const count = (occurrences.get(row.fingerprint) || 0) + 1;
      occurrences.set(row.fingerprint, count);
      const existing = matches.get(row.fingerprint) || [];
      return {
        ...row,
        duplicate: !row.error && count <= existing.length,
        existing: existing.slice(count - 1, count),
      };
    });
  }
  preview(accountId: string, fileName: string, content: string): ImportPreview {
    invariant(accountId !== 'manual', 'Manual expenses do not accept statement uploads.');
    const account = this.one<Account>('SELECT * FROM accounts WHERE id=?', accountId);
    invariant(account, 'Choose a card account.');
    const rows = this.previewRows(accountId, parseStatement(content, account.format));
    const range = (values: (string | null)[]) => {
      const sorted = values.filter((s): s is string => !!s).sort();
      return { from: sorted[0] || null, to: sorted.at(-1) || null };
    };
    const preview: ImportPreview = {
      id: randomUUID(),
      accountId,
      fileName: fileName.slice(0, 200),
      rows,
      dateRange: range(rows.map((r) => r.date)),
      postDateRange: range(rows.map((r) => r.postDate)),
      counts: {
        total: rows.length,
        new: rows.filter((r) => !r.error && !r.duplicate && r.kind !== 'payment').length,
        duplicates: rows.filter((r) => r.duplicate).length,
        payments: rows.filter((r) => !r.error && r.kind === 'payment').length,
        invalid: rows.filter((r) => r.error).length,
      },
    };
    this.db
      .prepare(
        'INSERT INTO imports(id,accountId,fileName,hash,status,preview,createdAt) VALUES (?,?,?,?,?,?,?)',
      )
      .run(
        preview.id,
        accountId,
        preview.fileName,
        createHash('sha256').update(content).digest('hex'),
        'draft',
        JSON.stringify(preview),
        now(),
      );
    return preview;
  }
  confirmImport(
    id: string,
    acknowledgeSkips: boolean,
    keepRows: number[] = [],
    skipInvalid = false,
  ): ImportResult {
    return this.db
      .transaction(() => {
        const record = this.one<Raw>('SELECT * FROM imports WHERE id=?', id);
        invariant(record, 'Import preview not found.', 404);
        invariant(record.status === 'draft', 'This import was already confirmed.', 409);
        const preview = JSON.parse(record.preview as string) as ImportPreview;
        const fresh = this.previewRows(preview.accountId, preview.rows);
        invariant(
          fresh.every((r, i) => r.duplicate === preview.rows[i].duplicate),
          'Another import changed the duplicate matches. Preview this file again.',
          409,
        );
        invariant(
          keepRows.every((n) => fresh.some((r) => r.rowNumber === n && r.duplicate)),
          'Only previewed duplicate rows may be retained.',
        );
        invariant(
          !fresh.some((r) => r.duplicate && !keepRows.includes(r.rowNumber)) || acknowledgeSkips,
          'Review and confirm the duplicate rows that will be skipped.',
        );
        invariant(
          !preview.counts.invalid || skipInvalid,
          'Review and explicitly acknowledge invalid rows before importing the valid rows.',
        );
        const ids: string[] = [];
        let skipped = 0,
          payments = 0;
        for (const row of fresh) {
          const rowId = randomUUID();
          const status = row.error
            ? 'invalid'
            : row.duplicate && !keepRows.includes(row.rowNumber)
              ? 'duplicate'
              : row.kind === 'payment'
                ? 'payment'
                : 'imported';
          this.db
            .prepare(
              'INSERT INTO import_rows(id,importId,accountId,rowNumber,fingerprint,raw,kind,status) VALUES (?,?,?,?,?,?,?,?)',
            )
            .run(
              rowId,
              id,
              preview.accountId,
              row.rowNumber,
              row.fingerprint,
              JSON.stringify(row.raw),
              row.kind,
              status,
            );
          if (status === 'imported') {
            const txId = randomUUID();
            ids.push(txId);
            this.db
              .prepare(
                'INSERT INTO transactions(id,accountId,importRowId,date,postDate,description,amountCents,kind,bankCategory,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?)',
              )
              .run(
                txId,
                preview.accountId,
                rowId,
                row.date,
                row.postDate,
                row.description,
                row.amountCents,
                row.kind,
                row.bankCategory,
                now(),
              );
          } else if (status === 'payment') payments++;
          else skipped++;
        }
        const summary =
          ids.length +
          ' added to Inbox · ' +
          payments +
          ' card payments retained · ' +
          skipped +
          ' rows skipped';
        this.db
          .prepare("UPDATE imports SET status='confirmed',summary=? WHERE id=?")
          .run(summary, id);
        const created = this.all<{ id: string; date: string; version: number }>(
          'SELECT t.id,t.date,t.version FROM transactions t JOIN import_rows r ON r.id=t.importRowId WHERE r.importId=? ORDER BY t.date,t.id',
          id,
        );
        return {
          ids,
          summary,
          items: created.map((tx) => ({ id: tx.id, version: tx.version, date: tx.date })),
          dateRange: { from: created[0]?.date || null, to: created.at(-1)?.date || null },
        };
      })
      .immediate();
  }
  finishImport(
    id: string,
    items: { id: string; version: number }[],
    context: string,
    process: boolean,
    from?: string,
    to?: string,
    actor: Actor = 'user',
  ): ImportCompletion {
    invariant(actor === 'user', 'Only you can add import context or start processing.', 403);
    invariant(context.length <= 4000, 'Import context can contain up to 4,000 characters.');
    const text = context.trim();
    this.resolveMentions(text);
    if (!text) {
      from = undefined;
      to = undefined;
    }
    if (from) isoDate(from);
    if (to) isoDate(to);
    invariant(!from || !to || from <= to, 'Context start must precede end date.');
    return this.db
      .transaction(() => {
        const record = this.one<{ status: string; preview: string; summary: string }>(
          'SELECT status,preview,summary FROM imports WHERE id=?',
          id,
        );
        invariant(record?.status === 'confirmed', 'Confirmed import not found.', 404);
        const preview = JSON.parse(record.preview) as ImportPreview;
        const imported = this.all<{ id: string }>(
          'SELECT t.id FROM transactions t JOIN import_rows r ON r.id=t.importRowId WHERE r.importId=? ORDER BY t.date,t.id',
          id,
        ).map((row) => this.transaction(row.id));
        const expected = new Map(items.map((item) => [item.id, item.version]));
        invariant(
          expected.size === items.length &&
            items.length === imported.length &&
            imported.every((tx) => expected.has(tx.id)),
          'Choose exactly the new transactions from this import.',
        );
        const digest = createHash('sha256')
          .update(JSON.stringify([text, process, from || null, to || null]))
          .digest('hex');
        if (preview.completion) {
          invariant(
            preview.completion.digest === digest,
            'This import step was already completed. Add further instructions from the review workspace.',
            409,
          );
          return preview.completion;
        }
        if (text || process)
          invariant(
            imported.every((tx) => tx.state === 'inbox' && tx.version === expected.get(tx.id)),
            'Some imported expenses have changed. Review them before adding more context or processing.',
            409,
          );
        const scoped = imported.filter(
          (tx) => (!from || tx.date >= from) && (!to || tx.date <= to),
        );
        if (text)
          invariant(scoped.length > 0, 'No new transactions fall within this context date range.');
        if (text)
          this.batch(
            'user',
            'Save context for ' + scoped.length + ' imported expenses',
            scoped.map((tx) => ({ table: 'transactions' as const, id: tx.id })),
            (batchId) => {
              for (const tx of scoped)
                this.db
                  .prepare(
                    'UPDATE transactions SET instruction=?,notes=?,version=version+1,batchId=?,updatedAt=? WHERE id=?',
                  )
                  .run(
                    text,
                    JSON.stringify(this.withNote(tx, text, 'import')),
                    batchId,
                    now(),
                    tx.id,
                  );
            },
            'import:' + id + ':context',
          );
        const jobId =
          process && imported.length
            ? this.enqueue('process', { ids: imported.map((tx) => tx.id) })
            : undefined;
        const completion: ImportCompletion = {
          context: text,
          from: from || null,
          to: to || null,
          savedAt: now(),
          affectedCount: text ? scoped.length : 0,
          process,
          jobId,
          digest,
          summary:
            record.summary +
            (text ? ' · Context saved for ' + scoped.length + ' new expenses' : '') +
            (jobId ? ' · Processing started' : ''),
        };
        preview.completion = completion;
        this.db.prepare('UPDATE imports SET preview=? WHERE id=?').run(JSON.stringify(preview), id);
        return completion;
      })
      .immediate();
  }
  validateProposal(tx: Transaction, p: Proposal, finalizing = false): void {
    invariant(p.category.trim().length > 0 && p.category.length <= 80, 'Choose a category.');
    invariant(
      p.splits.length > 0 && new Set(p.splits.map((s) => s.personId)).size === p.splits.length,
      'A proposal needs distinct participants.',
    );
    const people = this.people();
    for (const s of p.splits) {
      invariant(
        people.some((person) => person.id === s.personId),
        'Split references an unknown person.',
      );
      invariant(
        Number.isSafeInteger(s.amountCents) &&
          (tx.amountCents < 0 ? s.amountCents <= 0 : s.amountCents >= 0),
        'Invalid split amount.',
      );
    }
    invariant(
      p.splits.reduce((a, s) => a + s.amountCents, 0) === tx.amountCents,
      'Split amounts must add up to the transaction amount.',
    );
    invariant(['high', 'medium', 'low'].includes(p.confidence), 'Invalid confidence.');
    if (p.tripId && finalizing) {
      const trip = new Features(this).trip(p.tripId);
      invariant(
        trip.status === 'active' && trip.version === p.tripVersion && tx.tripId === p.tripId,
        'Trip changed. Generate a new split before approving.',
        409,
      );
    }
    if (p.ruleId && finalizing) {
      const rule = this.rules().find((r) => r.id === p.ruleId);
      invariant(
        rule?.active && rule.version === p.ruleVersion,
        'This rule has changed. Regenerate this split before approving.',
        409,
      );
    }
    if (p.refundOf) {
      const original = this.transaction(p.refundOf);
      invariant(
        tx.amountCents < 0 &&
          original.amountCents > 0 &&
          original.state === 'finalized' &&
          original.proposal,
        'Link refunds to a finalized purchase.',
      );
      const refunds = this.transactions().filter(
        (t) => t.id !== tx.id && t.state === 'finalized' && t.proposal?.refundOf === original.id,
      );
      const refunded = refunds.reduce((sum, t) => sum + Math.abs(t.amountCents), 0);
      invariant(
        Math.abs(tx.amountCents) <= original.amountCents - refunded,
        'Refund exceeds the remaining refundable amount.',
      );
      const shares = linkedRefundShares(
        original.proposal.splits,
        tx.amountCents,
        refunds.map((t) => t.proposal!.splits),
      );
      invariant(
        shares.every((s) =>
          p.splits.some((x) => x.personId === s.personId && x.amountCents === s.amountCents),
        ),
        'A linked refund must proportionally reverse the original split.',
      );
    }
  }
  saveProposals(
    updates: {
      id: string;
      version: number;
      proposal: Proposal | null;
      state: 'inbox' | 'ready';
      attention?: string;
      context?: string;
    }[],
    actor: Actor = 'agent',
    stepKey?: string,
  ): void {
    invariant(updates.length > 0 && updates.length <= 100, 'Submit 1–100 proposals.');
    this.batch(
      actor,
      'Generate ' + updates.length + ' split' + (updates.length === 1 ? '' : 's'),
      updates.map((u) => ({ table: 'transactions' as const, id: u.id })),
      (batchId) => {
        for (const u of updates) {
          const tx = this.transaction(u.id);
          invariant(
            tx.state !== 'finalized',
            'Finalized transactions can only be reopened by you.',
            403,
          );
          invariant(tx.version === u.version, 'Transaction changed. Refresh and try again.', 409);
          invariant(
            u.state === 'inbox' || u.state === 'ready',
            'The agent cannot finalize transactions.',
            403,
          );
          if (u.proposal) this.validateProposal(tx, u.proposal);
          invariant(
            u.state !== 'ready' || u.proposal?.confidence === 'high' || actor === 'user',
            'Only high-confidence AI proposals can enter Ready.',
          );
          invariant(u.state !== 'ready' || u.proposal, 'Ready transactions need a split proposal.');
          this.db
            .prepare(
              'UPDATE transactions SET state=?,proposal=?,attention=?,notes=?,version=version+1,batchId=?,updatedAt=? WHERE id=?',
            )
            .run(
              u.state,
              u.proposal ? JSON.stringify(u.proposal) : null,
              u.attention || '',
              JSON.stringify(u.context ? this.withNote(tx, u.context, 'chat') : tx.notes),
              batchId,
              now(),
              u.id,
            );
        }
      },
      stepKey,
    );
  }
  private withNote(tx: Transaction, text: string, source: 'instruction' | 'chat' | 'import') {
    invariant(
      text.trim().length > 0 && text.length <= 12000,
      'Context must be 1–12,000 characters.',
    );
    if (tx.notes.some((n) => n.text === text.trim())) return tx.notes;
    return [...tx.notes, { id: randomUUID(), text: text.trim(), source, createdAt: now() }];
  }
  instruct(items: { id: string; version: number }[], text: string): string {
    return this.db
      .transaction(() => {
        invariant(items.length > 0 && items.length <= 100, 'Choose 1–100 Inbox expenses.');
        for (const item of items) {
          const tx = this.transaction(item.id);
          invariant(tx.state === 'inbox', 'Quick instructions are only available in Inbox.', 403);
        }
        this.review(items, 'correct', text);
        return this.enqueue('chat', {
          ids: items.map((item) => item.id),
          text: text.trim(),
          origin: 'transaction',
        });
      })
      .immediate();
  }
  review(
    items: { id: string; version: number }[],
    action: 'approve' | 'reject' | 'reopen' | 'correct',
    instruction = '',
    actor: Actor = 'user',
  ): void {
    invariant(
      actor === 'user',
      'Only you can approve, reject, correct, or reopen transactions.',
      403,
    );
    invariant(items.length > 0 && items.length <= 1000, 'Select 1–1000 transactions.');
    invariant(new Set(items.map((i) => i.id)).size === items.length, 'Duplicate selection.');
    this.resolveMentions(instruction);
    if (action === 'correct')
      invariant(
        instruction.trim().length > 0 && instruction.length <= 4000,
        'Add an instruction of up to 4,000 characters.',
      );
    this.batch(
      actor,
      {
        approve: 'Finalize',
        reject: 'Return to Inbox',
        reopen: 'Reopen',
        correct: 'Save correction for',
      }[action] +
        ' ' +
        items.length +
        ' transaction' +
        (items.length === 1 ? '' : 's'),
      items.map((i) => ({ table: 'transactions' as const, id: i.id })),
      (batchId) => {
        for (const item of items) {
          const tx = this.transaction(item.id);
          invariant(tx.version === item.version, 'Selection changed. Refresh and try again.', 409);
          if (action === 'approve') {
            invariant(tx.state === 'ready' && tx.proposal, 'Only Ready proposals can be approved.');
            this.validateProposal(tx, tx.proposal, true);
            this.db
              .prepare('INSERT OR IGNORE INTO categories(id,name) VALUES (?,?)')
              .run(randomUUID(), tx.proposal.category.trim());
          } else if (action === 'reopen')
            invariant(tx.state === 'finalized', 'Only finalized transactions can be reopened.');
          else
            invariant(
              tx.state !== 'finalized',
              'Reopen finalized transactions before changing them.',
              403,
            );
          const state =
            action === 'approve' ? 'finalized' : action === 'reopen' ? 'ready' : 'inbox';
          const proposal = action === 'reject' || action === 'correct' ? null : tx.proposal;
          this.db
            .prepare(
              'UPDATE transactions SET state=?,proposal=?,instruction=?,notes=?,attention=?,version=version+1,batchId=?,updatedAt=? WHERE id=?',
            )
            .run(
              state,
              proposal ? JSON.stringify(proposal) : null,
              action === 'correct' ? instruction.trim() : tx.instruction,
              JSON.stringify(
                action === 'correct' ? this.withNote(tx, instruction, 'instruction') : tx.notes,
              ),
              action === 'correct' ? '' : tx.attention,
              batchId,
              now(),
              tx.id,
            );
        }
      },
    );
  }
  validateRule(definition: RuleDefinition): void {
    invariant(definition.merchant.length <= 200, 'Merchant condition is too long.');
    invariant(
      !definition.merchantAliases?.length ||
        (definition.merchant.trim().length > 0 &&
          definition.merchantAliases.length <= 199 &&
          definition.merchantAliases.every(
            (value) => value.trim().length > 0 && value.length <= 200,
          )),
      'Choose up to 200 nonempty merchant alternatives.',
    );
    invariant(
      definition.outputCategory.trim().length > 0 && definition.outputCategory.length <= 80,
      'Choose an output category.',
    );
    if (definition.from) isoDate(definition.from);
    if (definition.to) isoDate(definition.to);
    invariant(
      !definition.from || !definition.to || definition.from <= definition.to,
      'Rule start must precede end.',
    );
    if (definition.accountId)
      invariant(
        this.one('SELECT id FROM accounts WHERE id=?', definition.accountId),
        'Unknown card.',
      );
    const ids = definition.split.mode === 'personal' ? ['self'] : definition.split.participants;
    invariant(
      ids.length > 0 && new Set(ids).size === ids.length,
      'Choose distinct rule participants.',
    );
    for (const id of ids)
      invariant(
        this.people().some((p) => p.id === id),
        'Rule references an unknown person.',
      );
    if (definition.split.mode === 'exact')
      invariant(
        definition.split.values?.length === ids.length &&
          definition.split.values.every((v) => Number.isSafeInteger(v) && v >= 0),
        'Enter nonnegative exact amounts for all participants.',
      );
    if (definition.split.mode === 'percent')
      invariant(
        definition.split.values?.length === ids.length &&
          definition.split.values.every((v) => Number.isSafeInteger(v) && v >= 0) &&
          definition.split.values.reduce((a, b) => a + b, 0) === 10000,
        'Percentages must add up to 100%.',
      );
  }
  proposeRule(
    title: string,
    definition: RuleDefinition,
    ruleId?: string,
    actor: Actor = 'agent',
    stepKey?: string,
  ): string {
    this.validateRule(definition);
    invariant(title.trim().length > 0 && title.length <= 160, 'Provide a rule title.');
    const existing = ruleId ? this.rules().find((r) => r.id === ruleId) : undefined;
    invariant(!ruleId || existing?.active, 'Rule is no longer active.');
    const id = randomUUID();
    this.batch(
      actor,
      'Propose rule: ' + title,
      [{ table: 'rule_changes', id }],
      () =>
        this.db
          .prepare(
            'INSERT INTO rule_changes(id,ruleId,title,definition,status,baseVersion) VALUES (?,?,?,?,?,?)',
          )
          .run(
            id,
            ruleId || null,
            title,
            JSON.stringify(definition),
            'proposed',
            existing?.version || null,
          ),
      stepKey,
    );
    return id;
  }
  reviewRule(id: string, approve: boolean, actor: Actor = 'user'): void {
    invariant(actor === 'user', 'Only you can activate or reject reusable rules.', 403);
    const change = this.ruleChanges().find((r) => r.id === id);
    invariant(change?.status === 'proposed', 'Rule proposal not found.');
    const ruleId = change.ruleId || randomUUID();
    this.batch(
      actor,
      (approve ? 'Activate' : 'Reject') + ' rule: ' + change.title,
      [
        { table: 'rule_changes', id },
        { table: 'rules', id: ruleId },
      ],
      () => {
        if (approve) {
          this.validateRule(change.definition);
          const current = this.rules().find((r) => r.id === ruleId);
          invariant(
            !change.ruleId || current?.active,
            'This rule was deleted. Create a new proposal.',
            409,
          );
          invariant(
            (current?.version || null) === change.baseVersion,
            'This rule changed. Propose the change again.',
            409,
          );
          this.db
            .prepare(
              'INSERT INTO rules(id,title,definition,version,active) VALUES (?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,definition=excluded.definition,version=excluded.version,active=1',
            )
            .run(
              ruleId,
              change.title,
              JSON.stringify(change.definition),
              current
                ? this.one<{ n: number }>(
                    'SELECT COALESCE(MAX(sequence),0)+1 AS n FROM action_batches',
                  )!.n
                : 1,
            );
        }
        this.db
          .prepare('UPDATE rule_changes SET status=? WHERE id=?')
          .run(approve ? 'approved' : 'rejected', id);
      },
    );
  }
  reviewRuleAndProcess(
    id: string,
    approve: boolean,
    processInbox = false,
    actor: Actor = 'user',
  ): { processed: number; jobId?: string } {
    invariant(actor === 'user', 'Only you can activate or reject reusable rules.', 403);
    invariant(approve || !processInbox, 'Rejecting a rule cannot start processing.');
    return this.db
      .transaction(() => {
        const change = this.ruleChanges().find((r) => r.id === id);
        invariant(change, 'Rule proposal not found.', 404);
        this.reviewRule(id, approve, actor);
        if (!processInbox) return { processed: 0 };
        const candidate: Rule = {
          id,
          title: change.title,
          definition: change.definition,
          active: 1,
          version: 1,
        };
        const ids = this.transactions()
          .filter((tx) => tx.state === 'inbox' && matchingRules(tx, [candidate]).length > 0)
          .map((tx) => tx.id);
        return {
          processed: ids.length,
          jobId: ids.length ? this.enqueue('process', { ids }) : undefined,
        };
      })
      .immediate();
  }
  private nextRuleVersion() {
    return this.one<{ n: number }>('SELECT COALESCE(MAX(sequence),0)+1 AS n FROM action_batches')!
      .n;
  }
  private optimizationRevision() {
    const active = this.rules()
      .filter((rule) => rule.active)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((rule) => [rule.id, rule.version, rule.title, rule.definition]);
    const proposals = this.transactions()
      .filter((tx) => tx.state !== 'finalized' && tx.proposal?.ruleId)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((tx) => [tx.id, tx.version, tx.state, tx.proposal!.ruleId, tx.proposal!.ruleVersion]);
    return createHash('sha256')
      .update(JSON.stringify([active, proposals]))
      .digest('hex');
  }
  private optimizedProposal(
    tx: Transaction,
    group: RuleOptimizationGroup,
    version: number,
  ): Proposal | null {
    const original = group.rules.find((rule) => rule.id === tx.proposal?.ruleId);
    if (
      !original ||
      tx.proposal?.ruleVersion !== original.version ||
      tx.proposal.category !== group.definition.outputCategory ||
      !matchingRules(tx, [
        {
          id: group.keepRuleId,
          title: group.title,
          definition: group.definition,
          active: 1,
          version,
        },
      ]).length
    )
      return null;
    try {
      const expected = splitAmount(tx.amountCents, group.definition.split);
      if (
        expected.length !== tx.proposal.splits.length ||
        !expected.every((share) =>
          tx.proposal!.splits.some(
            (actual) =>
              actual.personId === share.personId && actual.amountCents === share.amountCents,
          ),
        )
      )
        return null;
      return {
        ...tx.proposal,
        ruleId: group.keepRuleId,
        ruleVersion: version,
        explanation: group.title,
      };
    } catch {
      return null;
    }
  }
  previewRuleOptimization(): RuleOptimizationPreview {
    return this.db.transaction(() => {
      const preview = optimizeRules(this.rules());
      const unfinished = this.transactions().filter(
        (tx) => tx.state !== 'finalized' && tx.proposal?.ruleId,
      );
      for (const group of preview.groups) {
        for (const tx of unfinished.filter((tx) =>
          group.rules.some((rule) => rule.id === tx.proposal!.ruleId),
        )) {
          if (this.optimizedProposal(tx, group, 1)) group.rebindCount++;
          else group.resetCount++;
        }
      }
      return { revision: this.optimizationRevision(), ...preview };
    })();
  }
  deleteRule(id: string, version: number, actor: Actor = 'user'): number {
    invariant(actor === 'user', 'Only you can delete reusable rules.', 403);
    return this.db
      .transaction(() => {
        const rule = this.rules().find((rule) => rule.id === id);
        invariant(rule?.active, 'Rule is no longer active.', 409);
        invariant(rule.version === version, 'This rule changed. Refresh before deleting it.', 409);
        const affected = this.transactions().filter(
          (tx) => tx.state !== 'finalized' && tx.proposal?.ruleId === id,
        );
        this.batch(
          actor,
          'Delete rule: ' + rule.title,
          [
            { table: 'rules', id },
            ...affected.map((tx) => ({ table: 'transactions' as const, id: tx.id })),
          ],
          (batchId) => {
            this.db
              .prepare('UPDATE rules SET active=0,version=? WHERE id=?')
              .run(this.nextRuleVersion(), id);
            for (const tx of affected)
              this.db
                .prepare(
                  "UPDATE transactions SET state='inbox',proposal=NULL,attention=?,version=version+1,batchId=?,updatedAt=? WHERE id=?",
                )
                .run(
                  'The rule for this proposal was deleted. Add an instruction or process Inbox with your remaining rules.',
                  batchId,
                  now(),
                  tx.id,
                );
          },
        );
        return affected.length;
      })
      .immediate();
  }
  applyRuleOptimization(
    revision: string,
    groupIds: string[],
    actor: Actor = 'user',
  ): { removed: number; groups: number } {
    invariant(actor === 'user', 'Only you can optimize reusable rules.', 403);
    invariant(
      groupIds.length > 0 && new Set(groupIds).size === groupIds.length,
      'Select at least one distinct cleanup group.',
    );
    return this.db
      .transaction(() => {
        const preview = this.previewRuleOptimization();
        invariant(
          preview.revision === revision,
          'Rules or unfinished proposals changed after this preview. Refresh the preview before applying cleanup.',
          409,
        );
        const groups = preview.groups.filter((group) => groupIds.includes(group.id));
        invariant(
          groups.length === groupIds.length,
          'Cleanup selection no longer exists. Refresh the preview.',
          409,
        );
        for (const group of groups) this.validateRule(group.definition);
        const ids = new Set(groups.flatMap((group) => group.rules.map((rule) => rule.id)));
        const affected = this.transactions().filter(
          (tx) => tx.state !== 'finalized' && tx.proposal?.ruleId && ids.has(tx.proposal.ruleId),
        );
        this.batch(
          actor,
          'Optimize ' + groups.length + ' rule group' + (groups.length === 1 ? '' : 's'),
          [
            ...[...ids].map((id) => ({ table: 'rules' as const, id })),
            ...affected.map((tx) => ({ table: 'transactions' as const, id: tx.id })),
          ],
          (batchId) => {
            const version = this.nextRuleVersion();
            for (const group of groups) {
              this.db
                .prepare('UPDATE rules SET title=?,definition=?,version=?,active=1 WHERE id=?')
                .run(group.title, JSON.stringify(group.definition), version, group.keepRuleId);
              for (const rule of group.rules.filter((rule) => rule.id !== group.keepRuleId))
                this.db
                  .prepare('UPDATE rules SET active=0,version=? WHERE id=?')
                  .run(version, rule.id);
            }
            for (const tx of affected) {
              const group = groups.find((group) =>
                group.rules.some((rule) => rule.id === tx.proposal!.ruleId),
              )!;
              const proposal = this.optimizedProposal(tx, group, version);
              this.db
                .prepare(
                  'UPDATE transactions SET state=?,proposal=?,attention=?,version=version+1,batchId=?,updatedAt=? WHERE id=?',
                )
                .run(
                  proposal ? tx.state : 'inbox',
                  proposal ? JSON.stringify(proposal) : null,
                  proposal
                    ? tx.attention
                    : 'This proposal used an older rule revision. Regenerate the split after rule cleanup.',
                  batchId,
                  now(),
                  tx.id,
                );
            }
          },
        );
        return {
          removed: groups.reduce((count, group) => count + group.rules.length - 1, 0),
          groups: groups.length,
        };
      })
      .immediate();
  }
  addRepayment(
    personId: string,
    date: string,
    amountCents: number,
    direction: Repayment['direction'],
    note: string,
    actor: Actor = 'user',
    idempotencyKey?: string,
  ): string {
    invariant(actor === 'user', 'Only you can record repayments.', 403);
    invariant(
      this.people().some((p) => p.id === personId && !p.isSelf),
      'Choose a person.',
    );
    isoDate(date);
    invariant(
      Number.isSafeInteger(amountCents) && amountCents > 0 && amountCents <= 1_000_000_000_000,
      'Repayment must be a positive cent amount.',
    );
    invariant(direction === 'received' || direction === 'returned', 'Invalid direction.');
    const key = idempotencyKey || randomUUID();
    invariant(/^[A-Za-z0-9_-]{16,100}$/.test(key), 'Invalid repayment request key.');
    const digest = createHash('sha256')
      .update(JSON.stringify({ personId, date, amountCents, direction, note }))
      .digest('hex');
    return this.db
      .transaction(() => {
        const previous = this.one<{ digest: string; response: string }>(
          'SELECT digest,response FROM receipts WHERE key=?',
          'repayment:' + key,
        );
        if (previous) {
          invariant(
            previous.digest === digest,
            'This request key was used for a different repayment.',
            409,
          );
          return JSON.parse(previous.response).id as string;
        }
        const id = randomUUID();
        this.batch(actor, 'Record repayment', [{ table: 'repayments', id }], () => {
          if (direction === 'returned')
            invariant(
              (this.snapshot().dashboard.people.find((p) => p.person.id === personId)
                ?.creditCents || 0) >= amountCents,
              'Returned amount exceeds this person’s available credit.',
            );
          this.db
            .prepare(
              'INSERT INTO repayments(id,personId,date,amountCents,direction,note) VALUES (?,?,?,?,?,?)',
            )
            .run(id, personId, date, amountCents, direction, note.slice(0, 500));
        });
        this.db
          .prepare('INSERT INTO receipts(key,digest,response,createdAt) VALUES(?,?,?,?)')
          .run('repayment:' + key, digest, JSON.stringify({ id }), now());
        return id;
      })
      .immediate();
  }
  enqueue(kind: AgentJob['kind'], payload: AgentJob['payload']): string {
    return this.db
      .transaction(() => {
        const limits = config();
        invariant(
          !limits.production || kind !== 'chat' || this.settings().consentAt,
          'Review Privacy & AI in Settings before using the assistant.',
          403,
        );
        invariant(
          (payload.ids?.length || 0) <= limits.maxJobTransactions,
          'Select at most ' + limits.maxJobTransactions + ' transactions per processing job.',
        );
        const queued = this.one<{ count: number }>(
          "SELECT COUNT(*) count FROM jobs WHERE status IN ('queued','running')",
        )!.count;
        invariant(
          queued < limits.maxQueuedJobs,
          'Finish or cancel a queued job before starting another.',
          429,
        );
        if (payload.ids) {
          invariant(
            new Set(payload.ids).size === payload.ids.length,
            'Duplicate transaction selection.',
          );
          for (const id of payload.ids) {
            invariant(
              this.transaction(id).state !== 'finalized',
              'Finalized transactions cannot be processed.',
              403,
            );
          }
        }
        if (kind === 'chat') {
          invariant(
            payload.text?.trim() && payload.text.length <= 12000,
            'Write an instruction of up to 12,000 characters.',
          );
          payload.text = payload.text!.trim();
          payload.mentionIds = this.resolveMentions(payload.text, payload.mentionIds);
          if (payload.ids?.length && payload.origin !== 'transaction') {
            this.batch(
              'user',
              'Save chat context for ' + payload.ids.length + ' expenses',
              payload.ids.map((id) => ({ table: 'transactions' as const, id })),
              (batchId) => {
                for (const id of payload.ids!) {
                  const tx = this.transaction(id);
                  this.db
                    .prepare(
                      'UPDATE transactions SET notes=?,version=version+1,batchId=?,updatedAt=? WHERE id=?',
                    )
                    .run(
                      JSON.stringify(this.withNote(tx, payload.text!, 'chat')),
                      batchId,
                      now(),
                      id,
                    );
                }
              },
            );
          }
          if (payload.ids)
            payload.versions = payload.ids.map((id) => ({
              id,
              version: this.transaction(id).version,
            }));
        }
        const id = randomUUID();
        this.db
          .prepare('INSERT INTO jobs(id,kind,payload,createdAt,updatedAt) VALUES (?,?,?,?,?)')
          .run(id, kind, JSON.stringify(payload), now(), now());
        if (kind === 'chat') this.addMessage('user', payload.text!, id, payload.ids);
        return id;
      })
      .immediate();
  }
  addMessage(
    role: Message['role'],
    text: string,
    jobId: string | null = null,
    transactionIds: string[] = [],
  ): void {
    // Keep batch progress from drowning out conversation history.
    if (role === 'assistant' && jobId && this.job(jobId).kind === 'process') {
      const previous = this.one<{ id: string }>(
        "SELECT id FROM messages WHERE jobId=? AND role='assistant'",
        jobId,
      );
      if (previous) {
        this.db
          .prepare('UPDATE messages SET text=?,createdAt=? WHERE id=?')
          .run(text, now(), previous.id);
        return;
      }
    }
    this.db
      .prepare(
        'INSERT INTO messages(id,role,text,jobId,transactionIds,createdAt) VALUES (?,?,?,?,?,?)',
      )
      .run(randomUUID(), role, text, jobId, JSON.stringify(transactionIds), now());
  }
  cancelJob(id: string): void {
    const job = this.job(id);
    invariant(job.status === 'queued' || job.status === 'running', 'Job is already finished.');
    this.db
      .prepare(
        "UPDATE jobs SET cancelRequested=1,status=CASE WHEN status='queued' THEN 'cancelled' ELSE status END,updatedAt=? WHERE id=?",
      )
      .run(now(), id);
  }
  retryJob(id: string): void {
    const job = this.job(id);
    const limits = config();
    invariant(
      !limits.production || job.kind !== 'chat' || this.settings().consentAt,
      'Review Privacy & AI in Settings before using the assistant.',
      403,
    );
    invariant(
      (job.payload.ids?.length || 0) <= limits.maxJobTransactions,
      'This job exceeds the current processing limit. Start a smaller selection.',
    );
    invariant(
      this.one<{ n: number }>("SELECT COUNT(*) n FROM jobs WHERE status IN ('queued','running')")!
        .n < limits.maxQueuedJobs,
      'Finish or cancel a queued job before retrying.',
      429,
    );
    invariant(
      job.status === 'failed' || job.status === 'cancelled',
      'Only failed or cancelled jobs can be retried.',
    );
    this.db
      .prepare(
        "UPDATE jobs SET status='queued',cancelRequested=0,error='',activity='',response='',leaseUntil=0,leaseToken=NULL,attempts=0,updatedAt=? WHERE id=?",
      )
      .run(now(), id);
  }
  quoteRefund(refundId: string, originalId: string) {
    const refund = this.transaction(refundId),
      original = this.transaction(originalId);
    invariant(
      refund.amountCents < 0 && refund.state !== 'finalized',
      'Choose an unfinished refund.',
    );
    invariant(
      original.state === 'finalized' && original.amountCents > 0 && original.proposal,
      'Choose a finalized purchase.',
    );
    return {
      splits: linkedRefundShares(
        original.proposal.splits,
        refund.amountCents,
        this.transactions()
          .filter((t) => t.state === 'finalized' && t.proposal?.refundOf === original.id)
          .map((t) => t.proposal!.splits),
      ),
      category: original.proposal.category,
    };
  }
  refundProposal(tx: Transaction): Proposal | undefined {
    if (tx.amountCents >= 0) return;
    const merchant = (s: string) =>
      normalizedDescription(s)
        .replace(/\*[\w-]+/g, '')
        .replace(/\d+/g, '')
        .trim();
    const candidates = this.transactions()
      .filter(
        (t) =>
          t.state === 'finalized' &&
          t.amountCents > 0 &&
          t.accountId === tx.accountId &&
          t.date <= tx.date &&
          merchant(t.description) === merchant(tx.description) &&
          !!t.proposal,
      )
      .filter((t) => {
        const used = this.transactions()
          .filter((r) => r.state === 'finalized' && r.proposal?.refundOf === t.id)
          .reduce((sum, r) => sum - r.amountCents, 0);
        return t.amountCents - used >= -tx.amountCents;
      });
    if (candidates.length !== 1) return;
    const original = candidates[0];
    return {
      splits: linkedRefundShares(
        original.proposal!.splits,
        tx.amountCents,
        this.transactions()
          .filter((t) => t.state === 'finalized' && t.proposal?.refundOf === original.id)
          .map((t) => t.proposal!.splits),
      ),
      category: original.proposal!.category,
      source: 'refund',
      confidence: 'high',
      explanation:
        'Suggested refund of ' +
        original.description +
        ' on ' +
        original.date +
        '. Reverses its approved split.',
      refundOf: original.id,
    };
  }
  dashboard(from?: string, to?: string) {
    if (from) isoDate(from);
    if (to) isoDate(to);
    invariant(!from || !to || from <= to, 'Start date must precede end date.');
    const key = [
      from,
      to,
      this.one<{ revision: number }>("SELECT revision FROM ledger_revision WHERE id='main'")!
        .revision,
    ].join('|');
    const cached = dashboards.get(this.db);
    if (cached?.key === key) return cached.value;
    const value = calculateDashboard(
      this.transactions(),
      this.people(),
      this.all<Repayment>('SELECT * FROM repayments ORDER BY date DESC,id'),
      from,
      to,
    );
    dashboards.set(this.db, { key, value });
    return value;
  }
  personLedger(personId: string, from?: string, to?: string, page = 0) {
    invariant(Number.isInteger(page) && page >= 0, 'Invalid page.');
    const person = this.dashboard(from, to).people.find((p) => p.person.id === personId);
    invariant(person, 'Person not found.', 404);
    const expenses = person.expenses.filter(
      (e) => (!from || e.date >= from) && (!to || e.date <= to),
    );
    return {
      expenses: expenses.slice(page * 50, (page + 1) * 50),
      total: expenses.length,
      page,
      repayments: this.all<Repayment>(
        'SELECT * FROM repayments WHERE personId=? ORDER BY date DESC,id LIMIT 50 OFFSET ?',
        personId,
        page * 50,
      ),
      repaymentCount: this.one<{ n: number }>(
        'SELECT COUNT(*) n FROM repayments WHERE personId=?',
        personId,
      )!.n,
    };
  }
  snapshot(from?: string, to?: string, query?: LedgerQuery): Snapshot {
    if (from) isoDate(from);
    if (to) isoDate(to);
    invariant(!from || !to || from <= to, 'Start date must precede end date.');
    const ledger = query ? queryLedger(this.db, { ...query, from, to }) : undefined;
    if (ledger && query?.view === 'imports') {
      const count = this.one<{ n: number }>(
        "SELECT COUNT(*) n FROM imports WHERE status='confirmed'",
      )!.n;
      Object.assign(ledger.pagination, { total: count, imports: count });
    }
    const transactions = ledger?.transactions || this.transactions(),
      people = this.people(),
      repayments = this.all<Repayment>('SELECT * FROM repayments ORDER BY date DESC,id');
    return {
      ...new Features(this).snapshot(),
      userContext: new AssistantService(this).contexts(),
      assistantEvents: new AssistantService(this).events(),
      assistantRequests: new AssistantService(this).requests(),
      people,
      pagination: ledger?.pagination,
      workspace: { id: this.workspaceId, production: config().production, ...this.settings() },
      accounts: this.all<Account>('SELECT * FROM accounts'),
      categories: this.all<Category>('SELECT * FROM categories ORDER BY name'),
      transactions,
      rules: this.rules(true),
      ruleChanges: this.ruleChanges(),
      repayments: query ? repayments.slice(0, 100) : repayments,
      batches: this.all<ActionBatch>(
        'SELECT id,sequence,label,actor,createdAt,undoneAt FROM action_batches ORDER BY sequence DESC' +
          (query ? ' LIMIT 200' : ''),
      ),
      jobs: this.all<{ id: string }>(
        "SELECT id FROM jobs WHERE status IN ('queued','running') OR id IN (SELECT id FROM jobs ORDER BY createdAt DESC LIMIT 20) ORDER BY createdAt DESC",
      ).map((j) => this.job(j.id)),
      messages: this.all<Raw>(
        'SELECT id,role,text,jobId,transactionIds,createdAt FROM (SELECT rowid AS messageOrder,* FROM messages ORDER BY createdAt DESC,rowid DESC LIMIT 100) ORDER BY createdAt,messageOrder',
      ).map(
        (m) =>
          ({
            ...m,
            transactionIds: JSON.parse((m.transactionIds as string) || '[]'),
          }) as unknown as Message,
      ),
      dashboard: query
        ? {
            ...this.dashboard(from, to),
            people: this.dashboard(from, to).people.map((p) => ({ ...p, expenses: [] })),
          }
        : calculateDashboard(transactions, people, repayments, from, to),
      imports: this.all(
        "SELECT id,fileName,accountId,createdAt,summary FROM imports WHERE status='confirmed' ORDER BY createdAt DESC" +
          (query
            ? ' LIMIT 100 OFFSET ' + (query.view === 'imports' ? (query.page || 0) * 100 : 0)
            : ''),
      ),
      aiConfigured: !!process.env.OPENAI_API_KEY || process.env.AGENT_MODE === 'mock',
    };
  }
}
