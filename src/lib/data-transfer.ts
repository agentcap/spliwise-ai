import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store';
import { invariant, AppError } from './errors';
import { isoDate, splitAmount } from './money';
import { normalizedDescription } from './importer';
import { definitionKey } from './rule-definition';
import type {
  Account,
  ImportPreview,
  Person,
  Proposal,
  RuleDefinition,
  Transaction,
} from './types';

export type TransferKind = 'transactions' | 'rules';
const id = z.string().min(1).max(100);
const amount = z.number().int().safe().min(-1_000_000_000_000).max(1_000_000_000_000);
const date = z.string().refine((value) => {
  try {
    isoDate(value);
    return true;
  } catch {
    return false;
  }
}, 'Use an ISO date (YYYY-MM-DD).');
const split = z.object({
  mode: z.enum(['personal', 'equal', 'exact', 'percent']),
  participants: z.array(id).min(1).max(30),
  values: z.array(amount).max(30).optional(),
});
const definition = z.object({
  merchant: z.string().max(200),
  merchantAliases: z.array(z.string().trim().min(1).max(200)).max(199).optional(),
  category: z.string().optional(),
  accountId: id.optional(),
  from: date.optional(),
  to: date.optional(),
  split,
  outputCategory: z.string().trim().min(1).max(80),
});
const proposal = z.object({
  splits: z
    .array(z.object({ personId: id, amountCents: amount }))
    .min(1)
    .max(30),
  category: z.string().trim().min(1).max(80),
  confidence: z.enum(['high', 'medium', 'low']),
  source: z.enum(['rule', 'instruction', 'inference', 'refund', 'manual', 'trip']),
  explanation: z.string(),
  ruleId: id.optional(),
  ruleVersion: z.number().int().positive().optional(),
  refundOf: id.optional(),
  spec: split.optional(),
});
const person = z.object({
  id,
  name: z.string().trim().min(1).max(80),
  handle: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
  relation: z.string().max(100),
  isSelf: z.union([z.literal(0), z.literal(1)]),
});
const transaction = z.object({
  id,
  accountId: id,
  date,
  postDate: date.nullable(),
  description: z.string().trim().min(1),
  amountCents: amount.refine((value) => value !== 0, 'Zero amounts are not supported.'),
  kind: z.enum(['expense', 'refund']),
  bankCategory: z.string(),
  state: z.enum(['inbox', 'ready', 'finalized']),
  proposal: proposal.nullable(),
  instruction: z.string().max(12000),
  notes: z
    .array(
      z.object({
        id,
        text: z.string().min(1).max(12000),
        source: z.enum(['instruction', 'chat', 'import']),
        createdAt: z.iso.datetime(),
      }),
    )
    .max(1000),
  attention: z.string().max(4000),
  updatedAt: z.iso.datetime(),
  raw: z.record(z.string(), z.string()),
});
const rule = z.object({
  id,
  title: z.string().trim().min(1).max(160),
  definition,
  status: z.enum(['active', 'proposed']),
});
const common = {
  format: z.literal('splitwise-ai'),
  version: z.literal(1),
  exportedAt: z.iso.datetime(),
  currency: z.literal('USD'),
  people: z.array(person).min(1).max(5000),
  accounts: z
    .array(z.object({ id, name: z.string().max(200), format: z.enum(['amex', 'chase']) }))
    .max(100),
};
const bundleSchema = z.discriminatedUnion('kind', [
  z.object({
    ...common,
    kind: z.literal('transactions'),
    transactions: z.array(transaction).max(50000),
  }),
  z.object({ ...common, kind: z.literal('rules'), rules: z.array(rule).max(5000) }),
]);
export type TransferBundle = z.infer<typeof bundleSchema>;
export type TransferTransaction = z.infer<typeof transaction>;
export type TransferRule = z.infer<typeof rule>;
export interface TransferRow {
  rowNumber: number;
  duplicate: boolean;
  existingId?: string;
  existingLabel?: string;
  existingState?: string;
  transaction?: TransferTransaction;
  rule?: TransferRule;
}
export interface TransferPreview {
  id: string;
  kind: TransferKind;
  fileName: string;
  revision: string;
  people: { source: Person; target: Person; isNew: boolean }[];
  rows: TransferRow[];
  counts: {
    total: number;
    new: number;
    duplicates: number;
    savedSplits: number;
    previouslyFinalized: number;
  };
}
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fingerprint(
  tx: Pick<Transaction, 'accountId' | 'date' | 'postDate' | 'description' | 'amountCents' | 'kind'>,
) {
  return hash([
    tx.date,
    tx.postDate,
    normalizedDescription(tx.description),
    tx.amountCents,
    tx.kind,
  ]);
}
function portableSpec(spec: RuleDefinition['split']): RuleDefinition['split'] {
  return spec.mode === 'personal' ? { mode: 'personal', participants: ['self'] } : spec;
}
function mapSpec(spec: RuleDefinition['split'], ids: Map<string, string>) {
  return {
    ...spec,
    participants:
      spec.mode === 'personal' ? ['self'] : spec.participants.map((value) => ids.get(value)!),
  };
}
function mapDefinition(value: RuleDefinition, ids: Map<string, string>): RuleDefinition {
  return { ...value, split: mapSpec(value.split, ids) };
}
function unique(values: string[], label: string) {
  invariant(new Set(values).size === values.length, 'The file contains duplicate ' + label + '.');
}
function sameShares(a: Proposal['splits'], b: Proposal['splits']) {
  return (
    a.length === b.length &&
    a.every((share) =>
      b.some(
        (other) => share.personId === other.personId && share.amountCents === other.amountCents,
      ),
    )
  );
}
export class DataTransfer {
  constructor(private store: Store) {}
  private proposedRules() {
    return this.store
      .all<{ id: string; title: string; definition: string }>(
        "SELECT id,title,definition FROM rule_changes WHERE status='proposed' ORDER BY id",
      )
      .map((r) => ({
        ...r,
        definition: JSON.parse(r.definition) as RuleDefinition,
        status: 'proposed' as const,
      }));
  }
  private revision() {
    return hash([
      this.store.people(),
      this.store.transactions().map((tx) => [tx.id, tx.version]),
      this.store.rules().sort((a, b) => a.id.localeCompare(b.id)),
      this.store.all('SELECT id,status,definition FROM rule_changes ORDER BY id'),
    ]);
  }
  export(
    kind: TransferKind,
    options: {
      from?: string;
      to?: string;
      state?: string;
      tripId?: string;
      includePending?: boolean;
    } = {},
  ): TransferBundle {
    if (options.from) isoDate(options.from);
    if (options.to) isoDate(options.to);
    invariant(
      !options.from || !options.to || options.from <= options.to,
      'Start date must precede end date.',
    );
    invariant(
      !options.state || ['inbox', 'ready', 'finalized'].includes(options.state),
      'Unknown transaction state.',
    );
    return this.store.db.transaction(() => {
      const base = {
        format: 'splitwise-ai' as const,
        version: 1 as const,
        currency: 'USD' as const,
        exportedAt: new Date().toISOString(),
        people: this.store
          .people()
          .map((p) => ({ ...p, isSelf: p.isSelf ? (1 as const) : (0 as const) })),
        accounts: this.store.all<Account>('SELECT * FROM accounts ORDER BY id'),
      };
      let bundle: TransferBundle;
      if (kind === 'rules') {
        bundle = {
          ...base,
          kind,
          rules: [
            ...this.store
              .rules()
              .filter((r) => r.active)
              .map((r) => ({
                id: r.id,
                title: r.title,
                definition: { ...r.definition, split: portableSpec(r.definition.split) },
                status: 'active' as const,
              })),
            ...(options.includePending === false
              ? []
              : this.proposedRules().map((r) => ({
                  id: r.id,
                  title: r.title,
                  definition: { ...r.definition, split: portableSpec(r.definition.split) },
                  status: 'proposed' as const,
                }))),
          ],
        };
      } else {
        const all = this.store.transactions();
        const selected = new Set(
          all
            .filter(
              (tx) =>
                (!options.tripId || tx.tripId === options.tripId) &&
                (!options.from || tx.date >= options.from) &&
                (!options.to || tx.date <= options.to) &&
                (!options.state || tx.state === options.state),
            )
            .map((tx) => tx.id),
        );
        // Include linked purchases and their finalized refund history to retain cumulative rounding.
        const roots = new Set(
          all.filter((tx) => selected.has(tx.id)).map((tx) => tx.proposal?.refundOf || tx.id),
        );
        for (const tx of all)
          if (
            roots.has(tx.id) ||
            (tx.state === 'finalized' && tx.proposal?.refundOf && roots.has(tx.proposal.refundOf))
          )
            selected.add(tx.id);
        const raw = new Map(
          this.store
            .all<{ id: string; raw: string }>('SELECT id,raw FROM import_rows')
            .map((row) => [row.id, JSON.parse(row.raw)]),
        );
        bundle = {
          ...base,
          kind,
          transactions: all
            .filter((tx) => selected.has(tx.id))
            .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
            .map((tx) => ({
              id: tx.id,
              accountId: tx.accountId,
              date: tx.date,
              postDate: tx.postDate,
              description: tx.description,
              amountCents: tx.amountCents,
              kind: tx.kind,
              bankCategory: tx.bankCategory,
              state: tx.state,
              proposal: tx.proposal
                ? {
                    ...tx.proposal,
                    spec: tx.proposal.spec ? portableSpec(tx.proposal.spec) : undefined,
                  }
                : null,
              instruction: tx.instruction,
              notes: tx.notes,
              attention: tx.attention,
              updatedAt: tx.updatedAt,
              raw: raw.get(tx.importRowId) || {},
            })),
        };
      }
      const referenced = new Set<string>(['self']);
      const specs =
        bundle.kind === 'rules'
          ? bundle.rules.map((r) => r.definition.split)
          : bundle.transactions.flatMap((tx) => (tx.proposal?.spec ? [tx.proposal.spec] : []));
      specs.forEach((spec) => spec.participants.forEach((value) => referenced.add(value)));
      if (bundle.kind === 'transactions') {
        for (const tx of bundle.transactions) {
          tx.proposal?.splits.forEach((share) => referenced.add(share.personId));
          const text = tx.instruction + '\n' + tx.notes.map((note) => note.text).join('\n');
          for (const p of base.people)
            if (new RegExp('@' + p.handle + '\\b', 'i').test(text)) referenced.add(p.id);
        }
      }
      bundle.people = base.people.filter((p) => referenced.has(p.id));
      return bundle;
    })();
  }
  preview(kind: TransferKind, fileName: string, content: string): TransferPreview {
    invariant(Buffer.byteLength(content) <= 10_000_000, 'Choose a JSON file smaller than 10 MB.');
    let input: unknown;
    try {
      input = JSON.parse(content.replace(/^\uFEFF/, ''));
    } catch {
      throw new AppError('This is not valid JSON. Choose a Splitwise AI JSON export.');
    }
    const parsed = bundleSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new AppError(
        'Invalid export at ' + (issue.path.join('.') || 'file') + ': ' + issue.message,
      );
    }
    const bundle = parsed.data;
    invariant(
      bundle.kind === kind,
      'This file contains ' + bundle.kind + '. Choose the matching import tab.',
    );
    unique(
      bundle.people.map((p) => p.id),
      'person IDs',
    );
    unique(
      bundle.people.map((p) => p.handle),
      'person handles',
    );
    invariant(
      bundle.people.filter((p) => p.isSelf).length === 1 &&
        bundle.people.some((p) => p.id === 'self' && p.isSelf === 1 && p.handle === 'me'),
      'Include the owner as self / @me.',
    );
    const peopleIds = new Set(bundle.people.map((p) => p.id));
    const accounts = this.store.all<Account>('SELECT * FROM accounts');
    const knownAccount = (value: string) =>
      invariant(
        accounts.some((a) => a.id === value),
        'Unknown card account: ' + value + '.',
      );
    const validateSpec = (value: RuleDefinition['split'], total?: number, forRule = false) => {
      unique(value.participants, 'split participants');
      value.participants.forEach((value) =>
        invariant(
          peopleIds.has(value),
          'Split references a person missing from the file: ' + value,
        ),
      );
      if (value.mode === 'personal')
        invariant(
          value.participants.length === 1 && value.participants[0] === 'self',
          'Personal expenses must use @me.',
        );
      if (value.mode === 'percent') {
        invariant(
          value.values?.length === value.participants.length &&
            value.values.every((n) => n >= 0) &&
            value.values.reduce((a, b) => a + b, 0) === 10000,
          'Percentages must total 100%.',
        );
      }
      if (value.mode === 'exact') {
        invariant(
          value.values?.length === value.participants.length,
          'Every exact split participant needs an amount.',
        );
        if (forRule)
          invariant(
            value.values!.every((n) => n >= 0),
            'Rule exact amounts must be nonnegative.',
          );
      }
      if (total !== undefined) splitAmount(total, value);
    };
    for (const account of bundle.accounts) {
      knownAccount(account.id);
      invariant(
        accounts.find((a) => a.id === account.id)!.format === account.format,
        'Card format does not match: ' + account.id,
      );
    }
    if (bundle.kind === 'rules') {
      unique(
        bundle.rules.map((r) => r.id),
        'rule IDs',
      );
      bundle.rules.forEach((r) => {
        validateSpec(r.definition.split, undefined, true);
        if (r.definition.accountId) knownAccount(r.definition.accountId);
        invariant(
          !r.definition.from || !r.definition.to || r.definition.from <= r.definition.to,
          'Rule start must precede end.',
        );
        invariant(
          !r.definition.merchantAliases?.length || r.definition.merchant.trim(),
          'Merchant alternatives require a primary merchant.',
        );
      });
    } else {
      unique(
        bundle.transactions.map((tx) => tx.id),
        'transaction IDs',
      );
      const sourceById = new Map(bundle.transactions.map((tx) => [tx.id, tx]));
      const existingById = new Map(this.store.transactions().map((tx) => [tx.id, tx]));
      for (const [i, tx] of bundle.transactions.entries()) {
        knownAccount(tx.accountId);
        const prefix = 'Transaction ' + (i + 1) + ': ';
        invariant(
          tx.amountCents < 0 === (tx.kind === 'refund'),
          prefix + 'Expense/refund sign is inconsistent.',
        );
        invariant(
          tx.state === 'inbox' || tx.proposal,
          prefix + 'Reviewed transactions need a saved split.',
        );
        if (tx.proposal) {
          const p = tx.proposal;
          unique(
            p.splits.map((s) => s.personId),
            'split participants',
          );
          invariant(
            p.splits.every(
              (s) =>
                peopleIds.has(s.personId) &&
                (tx.amountCents < 0 ? s.amountCents <= 0 : s.amountCents >= 0),
            ),
            prefix + 'Invalid participant or split sign.',
          );
          invariant(
            p.splits.reduce((a, b) => a + b.amountCents, 0) === tx.amountCents,
            prefix + 'Split amounts do not match the expense.',
          );
          if (p.spec) {
            validateSpec(p.spec, tx.amountCents);
            if (!p.refundOf)
              invariant(
                sameShares(splitAmount(tx.amountCents, p.spec), p.splits),
                prefix + 'Saved split method and amounts disagree.',
              );
          }
          if (p.refundOf) {
            const original = sourceById.get(p.refundOf) || existingById.get(p.refundOf);
            invariant(
              tx.kind === 'refund' && original && original.amountCents > 0,
              prefix + 'Include the linked original purchase in the export.',
            );
          }
        }
      }
    }
    return this.store.db
      .transaction(() => {
        const existingPeople = this.store.people();
        const people = bundle.people.map((source) => {
          const match = source.isSelf
            ? existingPeople.find((p) => p.isSelf)!
            : existingPeople.find((p) => p.handle === source.handle);
          return {
            source,
            target: match || {
              ...source,
              id: existingPeople.some((p) => p.id === source.id) ? randomUUID() : source.id,
            },
            isNew: !match,
          };
        });
        const ids = new Map(people.map((p) => [p.source.id, p.target.id]));
        let rows: TransferRow[];
        if (bundle.kind === 'transactions') {
          const existing = this.store.transactions();
          const byId = new Map(existing.map((tx) => [tx.id, tx]));
          const reserved = new Set(
            bundle.transactions.filter((tx) => byId.has(tx.id)).map((tx) => tx.id),
          );
          const available = new Map<string, Transaction[]>();
          const cursor = new Map<string, number>();
          const keyFor = (tx: Transaction | TransferTransaction) =>
            tx.accountId + ':' + fingerprint(tx);
          for (const tx of existing) {
            if (reserved.has(tx.id)) continue;
            const key = keyFor(tx);
            const list = available.get(key) || [];
            list.push(tx);
            available.set(key, list);
          }
          rows = bundle.transactions.map((tx, i) => {
            const exact = byId.get(tx.id);
            invariant(
              !exact ||
                (exact.accountId === tx.accountId && fingerprint(exact) === fingerprint(tx)),
              'Transaction ID collision at row ' +
                (i + 1) +
                '. Existing records cannot be overwritten.',
            );
            const key = keyFor(tx),
              index = cursor.get(key) || 0;
            const match = exact || available.get(key)?.[index];
            if (!exact && match) cursor.set(key, index + 1);
            return {
              rowNumber: i + 1,
              duplicate: !!match,
              existingId: match?.id,
              existingLabel: match?.description,
              existingState: match?.state,
              transaction: tx,
            };
          });
        } else {
          const existing = [
            ...this.store
              .rules()
              .filter((r) => r.active)
              .map((r) => ({ ...r, status: 'active' })),
            ...this.proposedRules(),
          ];
          const byDefinition = new Map(existing.map((r) => [definitionKey(r.definition), r]));
          const seen = new Map<string, { id: string; title: string; status: string }>();
          rows = bundle.rules.map((r, i) => {
            const key = definitionKey(mapDefinition(r.definition, ids));
            const match = byDefinition.get(key) || seen.get(key);
            if (!seen.has(key))
              seen.set(key, { id: 'file-row:' + (i + 1), title: r.title, status: 'in this file' });
            return {
              rowNumber: i + 1,
              duplicate: !!match,
              existingId: match?.id,
              existingLabel: match?.title,
              existingState: match?.status,
              rule: r,
            };
          });
        }
        const preview: TransferPreview = {
          id: randomUUID(),
          kind,
          fileName: fileName.slice(0, 200),
          revision: this.revision(),
          people,
          rows,
          counts: {
            total: rows.length,
            new: rows.filter((r) => !r.duplicate).length,
            duplicates: rows.filter((r) => r.duplicate).length,
            savedSplits: rows.filter((r) => r.transaction?.proposal).length,
            previouslyFinalized: rows.filter((r) => r.transaction?.state === 'finalized').length,
          },
        };
        this.store.db
          .prepare(
            'INSERT INTO data_transfers(id,kind,fileName,payload,preview,status,createdAt) VALUES (?,?,?,?,?,?,?)',
          )
          .run(
            preview.id,
            kind,
            preview.fileName,
            JSON.stringify(bundle),
            JSON.stringify(preview),
            'draft',
            new Date().toISOString(),
          );
        return preview;
      })
      .immediate();
  }
  confirm(
    id: string,
    acknowledgeSkips: boolean,
    keepRows: number[] = [],
    acknowledgePeople = false,
    actor: 'user' | 'agent' = 'user',
  ) {
    invariant(actor === 'user', 'Only you can import transactions or rules.', 403);
    return this.store.db
      .transaction(() => {
        const record = this.store.one<{ status: string; preview: string; payload: string }>(
          'SELECT * FROM data_transfers WHERE id=?',
          id,
        );
        invariant(record, 'Import preview not found.', 404);
        invariant(record.status === 'draft', 'This file was already imported.', 409);
        const preview = JSON.parse(record.preview) as TransferPreview;
        invariant(
          preview.revision === this.revision(),
          'Your workspace changed after this preview. Refresh the preview before importing.',
          409,
        );
        unique(keepRows.map(String), 'retained rows');
        const retained = new Set(keepRows);
        const duplicates = new Set(preview.rows.filter((r) => r.duplicate).map((r) => r.rowNumber));
        invariant(
          keepRows.every((n) => duplicates.has(n)),
          'Only previewed duplicate rows can be kept as distinct.',
        );
        const skipped = preview.rows.filter((r) => r.duplicate && !retained.has(r.rowNumber));
        invariant(
          !skipped.length || acknowledgeSkips,
          'Review and confirm the records that will be skipped.',
        );
        invariant(
          preview.people.length <= 1 || acknowledgePeople,
          'Review the person matches before importing.',
        );
        const added = preview.rows.filter((r) => !r.duplicate || retained.has(r.rowNumber));
        const addedNumbers = new Set(added.map((r) => r.rowNumber));
        const skippedNumbers = new Set(skipped.map((r) => r.rowNumber));
        const ids = new Map(preview.people.map((p) => [p.source.id, p.target.id]));
        if (added.length)
          for (const p of preview.people.filter((p) => p.isNew))
            this.store.db
              .prepare('INSERT INTO people(id,name,handle,relation,isSelf) VALUES (?,?,?,?,0)')
              .run(p.target.id, p.target.name, p.target.handle, p.target.relation);
        let ready = 0;
        if (preview.kind === 'rules') {
          const changes = added.map((r) => ({
            id: randomUUID(),
            title: r.rule!.title,
            definition: mapDefinition(r.rule!.definition, ids),
          }));
          for (const c of changes) this.store.validateRule(c.definition);
          if (changes.length)
            this.store.batch(
              'user',
              'Import ' + changes.length + ' rule proposals',
              changes.map((r) => ({ table: 'rule_changes', id: r.id })),
              () => {
                for (const c of changes)
                  this.store.db
                    .prepare(
                      "INSERT INTO rule_changes(id,title,definition,status) VALUES (?,?,?,'proposed')",
                    )
                    .run(c.id, c.title, JSON.stringify(c.definition));
              },
            );
        } else {
          const targetIds = new Map(
            preview.rows.map((r) => [
              r.transaction!.id,
              r.duplicate && !retained.has(r.rowNumber)
                ? r.existingId!
                : r.duplicate
                  ? randomUUID()
                  : r.transaction!.id,
            ]),
          );
          const accountIds = [...new Set(preview.rows.map((r) => r.transaction!.accountId))];
          for (const accountId of accountIds) {
            const accountRows = preview.rows.filter((r) => r.transaction!.accountId === accountId);
            const importId = randomUUID();
            const range = (values: (string | null)[]) => {
              const sorted = values.filter((v): v is string => !!v).sort();
              return { from: sorted[0] || null, to: sorted.at(-1) || null };
            };
            const history: ImportPreview = {
              id: importId,
              accountId,
              fileName: preview.fileName,
              rows: accountRows.map((r) => ({
                rowNumber: r.rowNumber,
                raw: r.transaction!.raw,
                date: r.transaction!.date,
                postDate: r.transaction!.postDate,
                description: r.transaction!.description,
                amountCents: r.transaction!.amountCents,
                bankCategory: r.transaction!.bankCategory,
                kind: r.transaction!.kind,
                fingerprint: fingerprint(r.transaction!),
                duplicate: r.duplicate,
                existing: r.existingId
                  ? [
                      {
                        id: r.existingId,
                        date: r.transaction!.date,
                        description: r.existingLabel!,
                        amountCents: r.transaction!.amountCents,
                        state: r.existingState!,
                      },
                    ]
                  : [],
              })),
              dateRange: range(accountRows.map((r) => r.transaction!.date)),
              postDateRange: range(accountRows.map((r) => r.transaction!.postDate)),
              counts: {
                total: accountRows.length,
                new: accountRows.filter((r) => addedNumbers.has(r.rowNumber)).length,
                duplicates: accountRows.filter((r) => r.duplicate).length,
                payments: 0,
                invalid: 0,
              },
            };
            this.store.db
              .prepare(
                'INSERT INTO imports(id,accountId,fileName,hash,status,preview,createdAt,summary) VALUES (?,?,?,?,?,?,?,?)',
              )
              .run(
                importId,
                accountId,
                preview.fileName,
                hash(JSON.parse(record.payload)),
                'confirmed',
                JSON.stringify(history),
                new Date().toISOString(),
                history.counts.new +
                  ' imported for review · ' +
                  accountRows.filter((r) => skippedNumbers.has(r.rowNumber)).length +
                  ' duplicates skipped',
              );
            for (const r of accountRows) {
              const tx = r.transaction!,
                rowId = randomUUID(),
                importing = addedNumbers.has(r.rowNumber);
              this.store.db
                .prepare(
                  'INSERT INTO import_rows(id,importId,accountId,rowNumber,fingerprint,raw,kind,status) VALUES (?,?,?,?,?,?,?,?)',
                )
                .run(
                  rowId,
                  importId,
                  accountId,
                  r.rowNumber,
                  fingerprint(tx),
                  JSON.stringify(tx.raw),
                  tx.kind,
                  importing ? 'imported' : 'duplicate',
                );
              if (!importing) continue;
              const p: Proposal | null = tx.proposal
                ? {
                    ...tx.proposal,
                    ruleId: undefined,
                    ruleVersion: undefined,
                    source: tx.proposal.source === 'rule' ? 'manual' : tx.proposal.source,
                    explanation: tx.proposal.explanation,
                    splits: tx.proposal.splits.map((s) => ({
                      ...s,
                      personId: ids.get(s.personId)!,
                    })),
                    spec: tx.proposal.spec ? mapSpec(tx.proposal.spec, ids) : undefined,
                    refundOf: tx.proposal.refundOf
                      ? targetIds.get(tx.proposal.refundOf) || tx.proposal.refundOf
                      : undefined,
                  }
                : null;
              // Imported refunds retain their link but wait in Inbox for purchase/refund-order review.
              const state = p && !p.refundOf ? 'ready' : 'inbox';
              if (p && !p.refundOf) this.store.validateProposal(tx as unknown as Transaction, p);
              if (state === 'ready') ready++;
              const attention = p?.refundOf
                ? 'Imported linked refund. Finalize its original purchase, then review this refund in the order it was originally accepted.'
                : tx.attention;
              this.store.db
                .prepare(
                  'INSERT INTO transactions(id,accountId,importRowId,date,postDate,description,amountCents,kind,bankCategory,state,attention,proposal,instruction,notes,updatedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                )
                .run(
                  targetIds.get(tx.id),
                  accountId,
                  rowId,
                  tx.date,
                  tx.postDate,
                  tx.description,
                  tx.amountCents,
                  tx.kind,
                  tx.bankCategory,
                  state,
                  attention,
                  p ? JSON.stringify(p) : null,
                  tx.instruction,
                  JSON.stringify(tx.notes),
                  new Date().toISOString(),
                );
            }
          }
        }
        const summary =
          preview.kind === 'rules'
            ? added.length +
              ' rule proposals imported · ' +
              skipped.length +
              ' duplicates skipped. Review before activating.'
            : added.length +
              ' transactions imported · ' +
              ready +
              ' ready for review · ' +
              (added.length - ready) +
              ' in Inbox · ' +
              skipped.length +
              ' duplicates skipped. Balances unchanged.';
        this.store.db
          .prepare("UPDATE data_transfers SET status='confirmed',summary=? WHERE id=?")
          .run(summary, id);
        return { added: added.length, skipped: skipped.length, ready, summary };
      })
      .immediate();
  }
}
export function transactionCsv(bundle: TransferBundle): string {
  invariant(bundle.kind === 'transactions', 'Choose transactions for CSV export.');
  const names = new Map(bundle.people.map((p) => [p.id, '@' + p.handle]));
  const text = (value: unknown) => {
    let s = String(value ?? '');
    if (/^(\s*[=+\-@]|[\t\r])/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const columns = [
    'ID',
    'Account',
    'Date',
    'Posting date',
    'Description',
    'Amount USD',
    'Kind',
    'State',
    'Category',
    'Splits USD',
    'Instruction',
    'Saved context',
    'Explanation',
    'Refund of',
  ];
  const rows = bundle.transactions.map((tx) =>
    [
      text(tx.id),
      text(bundle.accounts.find((a) => a.id === tx.accountId)?.name || tx.accountId),
      text(tx.date),
      text(tx.postDate),
      text(tx.description),
      (tx.amountCents / 100).toFixed(2),
      text(tx.kind),
      text(tx.state),
      text(tx.proposal?.category || tx.bankCategory),
      text(
        tx.proposal?.splits
          .map(
            (s) => (names.get(s.personId) || s.personId) + ': ' + (s.amountCents / 100).toFixed(2),
          )
          .join('; '),
      ),
      text(tx.instruction),
      text(tx.notes.map((n) => n.createdAt + ': ' + n.text).join('\n')),
      text(tx.proposal?.explanation),
      text(tx.proposal?.refundOf),
    ].join(','),
  );
  return '\uFEFF' + columns.map(text).join(',') + '\r\n' + rows.join('\r\n') + '\r\n';
}
