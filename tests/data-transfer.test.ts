import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
import { DataTransfer, transactionCsv, type TransferBundle } from '../src/lib/data-transfer';
import { linkedRefundShares, splitAmount } from '../src/lib/money';
import { ruleProposal } from '../src/lib/rules';
import type { Proposal, Transaction } from '../src/lib/types';

let source: Store, target: Store, exports: DataTransfer, imports: DataTransfer;
beforeEach(() => {
  source = new Store(openDatabase(':memory:'));
  target = new Store(openDatabase(':memory:'));
  exports = new DataTransfer(source);
  imports = new DataTransfer(target);
});
afterEach(() => {
  source.db.close();
  target.db.close();
});
function ingest(store: Store, descriptions = ['COFFEE'], account = 'amex', amounts?: number[]) {
  const body =
    'Date,Description,Amount\n' +
    descriptions
      .map((text, i) => '01/10/2026,' + text + ',' + ((amounts?.[i] ?? 1001) / 100).toFixed(2))
      .join('\n');
  const preview = store.preview(account, 'synthetic.csv', body);
  return store.confirmImport(preview.id, true).ids.map((id) => store.transaction(id));
}
function prepare(
  store: Store,
  tx: Transaction,
  personId = 'self',
  finalize = false,
  extra: Partial<Proposal> = {},
) {
  const proposal: Proposal = {
    splits: splitAmount(tx.amountCents, {
      mode: 'equal',
      participants: personId === 'self' ? ['self'] : ['self', personId],
    }),
    spec: { mode: 'equal', participants: personId === 'self' ? ['self'] : ['self', personId] },
    confidence: 'high',
    category: 'Food & Drink',
    source: 'manual',
    explanation: 'Synthetic saved split.',
    ...extra,
  };
  store.saveProposals([{ id: tx.id, version: tx.version, state: 'ready', proposal }], 'user');
  if (finalize) store.review([{ id: tx.id, version: store.transaction(tx.id).version }], 'approve');
  return store.transaction(tx.id);
}
function txBundle() {
  const b = exports.export('transactions');
  if (b.kind !== 'transactions') throw new Error('Expected transactions');
  return b;
}
function preview(bundle: TransferBundle, kind = bundle.kind) {
  return imports.preview(kind, 'synthetic.json', JSON.stringify(bundle));
}
describe('transaction and rule transfer', () => {
  it('exports personal splits with their implicit owner so valid agent-created rules and proposals can be imported', () => {
    const personal = { mode: 'personal' as const, participants: [] };
    source.reviewRule(
      source.proposeRule('Personal', { merchant: '', outputCategory: 'Personal', split: personal }),
      true,
    );
    const tx = ingest(source)[0];
    prepare(source, tx, 'self', false, { spec: personal });
    const transactions = txBundle();
    expect(transactions.transactions[0].proposal!.spec!.participants).toEqual(['self']);
    imports.confirm(preview(transactions).id, false);
    const rules = exports.export('rules');
    expect(rules.kind === 'rules' && rules.rules[0].definition.split.participants).toEqual([
      'self',
    ]);
    imports.confirm(preview(rules).id, false);
    expect(target.ruleChanges()).toHaveLength(1);
  });

  it('round-trips source rows, notes and saved splits across workspaces and maps people by handle without finalizing', () => {
    const alex = source.addPerson('Alex', 'alex', 'Friend');
    const local = target.addPerson('Alexander', 'alex', 'Roommate');
    const [tx] = ingest(source);
    source.instruct(
      [{ id: tx.id, version: tx.version }],
      'Split equally with @alex. Lunch on our hiking trip.',
    );
    prepare(source, source.transaction(tx.id), alex.id, true);
    ingest(source, ['OTHER EXPENSE']);
    const bundle = txBundle();
    const p = preview(bundle);
    expect(p.counts).toMatchObject({ total: 2, new: 2, previouslyFinalized: 1 });
    expect(p.people.find((p) => p.source.id === alex.id)?.target.id).toBe(local.id);
    expect(target.transactions()).toHaveLength(0);
    expect(() => imports.confirm(p.id, false)).toThrow(/person matches/);
    const result = imports.confirm(p.id, false, [], true);
    expect(result).toMatchObject({ added: 2, ready: 1, skipped: 0 });
    const restored = target.transaction(tx.id);
    expect(restored.state).toBe('ready');
    expect(restored.proposal!.splits.map((s) => s.personId)).toContain(local.id);
    expect(restored.notes).toEqual(source.transaction(tx.id).notes);
    expect(restored.instruction).toBe(source.transaction(tx.id).instruction);
    expect(target.people().find((p) => p.id === local.id)?.relation).toBe('Roommate');
    expect(target.snapshot().dashboard.totalOutstandingCents).toBe(0);
    const again = new DataTransfer(target).export('transactions');
    if (again.kind !== 'transactions') throw new Error();
    expect(again.transactions.find((t) => t.id === tx.id)?.raw).toEqual(
      bundle.transactions.find((t) => t.id === tx.id)?.raw,
    );
    expect(() => imports.confirm(p.id, false, [], true)).toThrow(/already imported/);
  });
  it('requires explicit duplicate skips, supports keeping distinct occurrences, and remains compatible with bank CSV deduplication', () => {
    ingest(source, ['IDENTICAL', 'IDENTICAL']);
    const bundle = txBundle();
    imports.confirm(preview(bundle).id, false);
    const p = preview(bundle);
    expect(p.counts.duplicates).toBe(2);
    expect(p.rows.every((r) => r.existingId && r.existingLabel)).toBe(true);
    expect(() => imports.confirm(p.id, false)).toThrow(/skipped/);
    imports.confirm(p.id, true, [1]);
    expect(target.transactions()).toHaveLength(3);
    const bank = target.preview(
      'amex',
      'overlap.csv',
      'Date,Description,Amount\n01/10/2026,IDENTICAL,10.01\n01/10/2026,IDENTICAL,10.01\n01/10/2026,IDENTICAL,10.01\n01/10/2026,IDENTICAL,10.01',
    );
    expect(bank.counts).toMatchObject({ duplicates: 3, new: 1 });
    const all = target.transactions();
    const skipped = preview(bundle);
    imports.confirm(skipped.id, true);
    expect(target.transactions()).toEqual(all);
  });
  it('imports rules as one undoable proposal batch, preserves alternatives and scopes, and deduplicates remapped participants', () => {
    const a = source.addPerson('Alex', 'alex');
    const b = target.addPerson('Alex local', 'alex');
    const def = {
      merchant: 'COFFEE',
      merchantAliases: ['TEA'],
      accountId: 'amex',
      from: '2026-01-01',
      to: '2026-12-31',
      outputCategory: 'Food & Drink',
      split: { mode: 'percent' as const, participants: ['self', a.id], values: [6000, 4000] },
    };
    source.reviewRule(source.proposeRule('Coffee & tea', def), true);
    source.proposeRule('Personal office food', {
      ...def,
      merchant: 'OFFICE',
      merchantAliases: [],
      split: { mode: 'personal', participants: ['self'] },
    });
    const bundle = exports.export('rules');
    expect(bundle.kind === 'rules' && bundle.rules).toHaveLength(2);
    const p = preview(bundle);
    imports.confirm(p.id, false, [], true);
    expect(target.rules()).toHaveLength(0);
    expect(target.ruleChanges()).toHaveLength(2);
    expect(target.ruleChanges().find((c) => c.title === 'Coffee & tea')?.definition).toMatchObject({
      merchantAliases: ['TEA'],
      split: { participants: ['self', b.id], values: [6000, 4000] },
    });
    expect(preview(bundle).counts.duplicates).toBe(2);
    target.undo();
    expect(target.ruleChanges()).toHaveLength(0);
    const next = preview(bundle);
    imports.confirm(next.id, false, [], true);
    const change = target.ruleChanges().find((c) => c.title === 'Coffee & tea')!;
    target.reviewRule(change.id, true);
    const tx = ingest(target, ['TEA'])[0];
    expect(ruleProposal(tx, target.rules()).proposal!.splits).toHaveLength(2);
  });
  it('detects duplicate rule definitions within one file without activating or overwriting existing rules', () => {
    const def = {
      merchant: 'COFFEE',
      outputCategory: 'Personal',
      split: { mode: 'personal' as const, participants: ['self'] },
    };
    source.proposeRule('First', def);
    source.proposeRule('Second', { ...def, merchant: 'coffee' });
    const bundle = exports.export('rules'),
      p = preview(bundle);
    expect(p.counts).toMatchObject({ new: 1, duplicates: 1 });
    expect(p.rows[1].existingId).toBe('file-row:1');
    expect(() => imports.confirm(p.id, false)).toThrow(/skipped/);
    imports.confirm(p.id, true);
    expect(target.ruleChanges()).toHaveLength(1);
    expect(target.rules()).toHaveLength(0);
  });
  it('rejects stale previews, agent writes, and ID collisions without partial imports', () => {
    const person = source.addPerson('Alex', 'alex');
    prepare(source, ingest(source)[0], person.id);
    const bundle = txBundle(),
      p = preview(bundle);
    expect(() => imports.confirm(p.id, false, [], true, 'agent')).toThrow(/Only you/);
    target.addPerson('New person', 'new_person');
    expect(() => imports.confirm(p.id, false, [], true)).toThrow(/changed/);
    expect(target.transactions()).toHaveLength(0);
    const fresh = preview(bundle);
    imports.confirm(fresh.id, false, [], true);
    bundle.transactions[0].amountCents++;
    bundle.transactions[0].proposal = null;
    bundle.transactions[0].state = 'inbox';
    expect(() => preview(bundle)).toThrow(/ID collision/);
    expect(target.transactions()).toHaveLength(1);
  });
  it('blocks malformed references, amounts, dates, formats and schemas instead of dropping rows', () => {
    ingest(source);
    const base = txBundle();
    const mutations = [
      (b: any) => (b.version = 2),
      (b: any) => (b.currency = 'EUR'),
      (b: any) => (b.transactions[0].date = '2026-02-31'),
      (b: any) => (b.transactions[0].amountCents = 12.5),
      (b: any) => (b.transactions[0].kind = 'refund'),
      (b: any) => (b.transactions[0].accountId = 'unknown'),
      (b: any) => b.transactions.push(b.transactions[0]),
      (b: any) =>
        (b.transactions[0].proposal = {
          splits: [{ personId: 'unknown', amountCents: 1001 }],
          category: 'Personal',
          confidence: 'high',
          source: 'manual',
          explanation: 'x',
        }),
      (b: any) =>
        (b.transactions[0].proposal = {
          splits: [{ personId: 'self', amountCents: 1000 }],
          category: 'Personal',
          confidence: 'high',
          source: 'manual',
          explanation: 'x',
        }),
    ];
    for (const mutate of mutations) {
      const b = structuredClone(base);
      mutate(b);
      expect(() => preview(b)).toThrow();
    }
    expect(() => imports.preview('transactions', 'broken.json', '{"')).toThrow(/valid JSON/);
    expect(() => imports.preview('rules', 'wrong.json', JSON.stringify(base))).toThrow(
      /matching import tab/,
    );
    expect(target.transactions()).toHaveLength(0);
    expect(target.one<{ n: number }>('SELECT COUNT(*) AS n FROM data_transfers')?.n).toBe(0);
  });
  it('includes linked purchase/refund history in filtered exports, preserves links, and requires review in the destination', () => {
    const alex = source.addPerson('Alex', 'alex');
    const [purchase, firstRefund, secondRefund] = ingest(
      source,
      ['PURCHASE', 'PARTIAL ONE', 'PARTIAL TWO'],
      'amex',
      [101, -1, -1],
    );
    const original = prepare(source, purchase, alex.id, true);
    const firstShares = linkedRefundShares(original.proposal!.splits, -1, []);
    prepare(source, firstRefund, alex.id, true, {
      splits: firstShares,
      refundOf: original.id,
      spec: undefined,
      source: 'refund',
    });
    const secondShares = linkedRefundShares(original.proposal!.splits, -1, [firstShares]);
    prepare(source, secondRefund, alex.id, true, {
      splits: secondShares,
      refundOf: original.id,
      spec: undefined,
      source: 'refund',
    });
    source.db.prepare("UPDATE transactions SET date='2026-02-01' WHERE id=?").run(secondRefund.id);
    const bundle = exports.export('transactions', { from: '2026-02-01', to: '2026-02-01' });
    expect(bundle.kind === 'transactions' && bundle.transactions).toHaveLength(3);
    imports.confirm(preview(bundle).id, false, [], true);
    expect(target.transaction(original.id).state).toBe('ready');
    expect(target.transaction(firstRefund.id)).toMatchObject({
      state: 'inbox',
      proposal: { refundOf: original.id },
    });
    target.review([{ id: original.id, version: 1 }], 'approve');
    for (const tx of [firstRefund, secondRefund]) {
      const imported = target.transaction(tx.id);
      target.saveProposals(
        [{ id: tx.id, version: imported.version, state: 'ready', proposal: imported.proposal }],
        'user',
      );
      target.review([{ id: tx.id, version: target.transaction(tx.id).version }], 'approve');
    }
    expect(target.snapshot().dashboard.totalSpentCents).toBe(99);
    expect(target.snapshot().dashboard.totalOutstandingCents).toBe(
      source.snapshot().dashboard.totalOutstandingCents,
    );
  });
  it('keeps finalized records intact on reimport and produces escaped spreadsheet CSV including negative refunds', () => {
    const [tx, refund] = ingest(source, ['FORMULA', 'REFUND'], 'amex', [1001, -101]);
    source.db
      .prepare('UPDATE transactions SET description=? WHERE id=?')
      .run('=HYPERLINK("example","x")', tx.id);
    prepare(source, source.transaction(tx.id), 'self', true);
    const bundle = txBundle();
    const before = source.transaction(tx.id);
    const local = new DataTransfer(source);
    const p = local.preview('transactions', 'same.json', JSON.stringify(bundle));
    local.confirm(p.id, true);
    expect(source.transaction(tx.id)).toEqual(before);
    const csv = transactionCsv(bundle);
    expect(csv).toContain('"' + "'" + '=HYPERLINK(""example"",""x"")"');
    expect(csv).toContain(',-1.01,');
    expect(csv).toContain('"Finalized"'.toLowerCase());
    expect(bundle.transactions.find((t) => t.id === refund.id)?.amountCents).toBe(-101);
  });
});
