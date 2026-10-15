import { randomUUID, createHash } from 'node:crypto';
import type { Sqlite } from '../db';
import { invariant, AppError } from './errors';
import { isoDate, linkedRefundShares, cents } from './money';
import { parseStatement, normalizedDescription } from './importer';
import { calculateDashboard } from './balances';
import type {
  Account,
  Actor,
  ActionBatch,
  AgentJob,
  ImportPreview,
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
} from './types';
type Raw = Record<string, unknown>;
type Undo = {
  table: 'transactions' | 'rules' | 'rule_changes' | 'repayments';
  id: string;
  before: Raw | null;
};
const now = () => new Date().toISOString();
export class Store {
  constructor(public db: Sqlite) {}
  all<T>(sql: string, ...args: unknown[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  one<T>(sql: string, ...args: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...args) as T | undefined;
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
  transaction(id: string): Transaction {
    const r = this.one<Raw>('SELECT * FROM transactions WHERE id=?', id);
    invariant(r, 'Transaction not found.', 404);
    return {
      ...r,
      proposal: r.proposal ? JSON.parse(r.proposal as string) : null,
      notes: JSON.parse((r.notes as string) || '[]'),
    } as unknown as Transaction;
  }
  rules(): Rule[] {
    return this.all<Raw>('SELECT * FROM rules').map(
      (r) => ({ ...r, definition: JSON.parse(r.definition as string) }) as unknown as Rule,
    );
  }
  ruleChanges(): RuleChange[] {
    return this.all<Raw>('SELECT * FROM rule_changes').map(
      (r) => ({ ...r, definition: JSON.parse(r.definition as string) }) as unknown as RuleChange,
    );
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
            ['transactions', 'rules', 'rule_changes', 'repayments'].includes(entry.table),
            'Invalid undo record.',
          );
          if (!entry.before)
            this.db.prepare('DELETE FROM ' + entry.table + ' WHERE id=?').run(entry.id);
          else {
            const cols = Object.keys(entry.before).filter((c) => c !== 'id');
            const values = cols.map((c) => entry.before![c]);
            if (entry.table === 'transactions') {
              const index = cols.indexOf('version');
              const current = this.one<{ version: number }>(
                'SELECT version FROM transactions WHERE id=?',
                entry.id,
              );
              values[index] = (current?.version || 0) + 1;
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
  ): { ids: string[]; summary: string } {
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
        return { ids, summary };
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
  private withNote(tx: Transaction, text: string, source: 'instruction' | 'chat') {
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
    invariant(!ruleId || existing, 'Rule not found.');
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
  addRepayment(
    personId: string,
    date: string,
    amountCents: number,
    direction: Repayment['direction'],
    note: string,
    actor: Actor = 'user',
  ): void {
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
    const id = randomUUID();
    this.batch(actor, 'Record repayment', [{ table: 'repayments', id }], () => {
      if (direction === 'returned')
        invariant(
          (this.snapshot().dashboard.people.find((p) => p.person.id === personId)?.creditCents ||
            0) >= amountCents,
          'Returned amount exceeds this person’s available credit.',
        );
      this.db
        .prepare(
          'INSERT INTO repayments(id,personId,date,amountCents,direction,note) VALUES (?,?,?,?,?,?)',
        )
        .run(id, personId, date, amountCents, direction, note.slice(0, 500));
    });
  }
  enqueue(kind: AgentJob['kind'], payload: AgentJob['payload']): string {
    return this.db
      .transaction(() => {
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
    invariant(
      job.status === 'failed' || job.status === 'cancelled',
      'Only failed or cancelled jobs can be retried.',
    );
    this.db
      .prepare(
        "UPDATE jobs SET status='queued',cancelRequested=0,error='',activity='',response='',leaseUntil=0,updatedAt=? WHERE id=?",
      )
      .run(now(), id);
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
  snapshot(from?: string, to?: string): Snapshot {
    if (from) isoDate(from);
    if (to) isoDate(to);
    invariant(!from || !to || from <= to, 'Start date must precede end date.');
    const transactions = this.transactions(),
      people = this.people(),
      repayments = this.all<Repayment>('SELECT * FROM repayments ORDER BY date DESC,id');
    return {
      people,
      accounts: this.all<Account>('SELECT * FROM accounts'),
      categories: this.all<Category>('SELECT * FROM categories ORDER BY name'),
      transactions,
      rules: this.rules(),
      ruleChanges: this.ruleChanges(),
      repayments,
      batches: this.all<ActionBatch>(
        'SELECT id,sequence,label,actor,createdAt,undoneAt FROM action_batches ORDER BY sequence DESC',
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
      dashboard: calculateDashboard(transactions, people, repayments, from, to),
      imports: this.all(
        "SELECT id,fileName,accountId,createdAt,summary FROM imports WHERE status='confirmed' ORDER BY createdAt DESC",
      ),
      aiConfigured: !!process.env.OPENAI_API_KEY || process.env.AGENT_MODE === 'mock',
    };
  }
}
