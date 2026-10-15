import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
import { parseStatement } from '../src/lib/importer';
import { cents, splitAmount } from '../src/lib/money';
import { ruleProposal } from '../src/lib/rules';
import { applyStep, claimJob, executeJob } from '../src/lib/jobs';
import { askAgent } from '../src/lib/agent';
import type { Proposal, RuleDefinition, Transaction } from '../src/lib/types';
let store: Store, dir: string;
const header = 'Transaction Date,Post Date,Description,Category,Type,Amount,Memo\n';
const csv = (...lines: string[]) => header + lines.join('\n');
const row = (date = '01/10/2026', description = 'COFFEE', amount = '-20.01', type = 'Sale') =>
  [date, date, description, 'Food & Drink', type, amount, ''].join(',');
function ingest(content: string, account = 'sapphire') {
  const p = store.preview(account, 'test.csv', content);
  return store.confirmImport(p.id, true, [], true).ids.map((id) => store.transaction(id));
}
function propose(tx: Transaction, personId: string, total = tx.amountCents): Proposal {
  return {
    splits: splitAmount(total, { mode: 'equal', participants: ['self', personId] }),
    category: 'Food & Drink',
    confidence: 'high',
    source: 'manual',
    explanation: 'Test allocation.',
  };
}
function finalize(tx: Transaction, p: Proposal) {
  store.saveProposals([{ id: tx.id, version: tx.version, proposal: p, state: 'ready' }], 'user');
  const fresh = store.transaction(tx.id);
  store.review([{ id: tx.id, version: fresh.version }], 'approve');
  return store.transaction(tx.id);
}
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'splitwise-test-'));
  store = new Store(openDatabase(join(dir, 'test.sqlite')));
  delete process.env.AGENT_MODE;
  delete process.env.OPENAI_API_KEY;
});
afterEach(() => {
  store.db.close();
  rmSync(dir, { recursive: true, force: true });
});
describe('statement parsing and import confirmation', () => {
  it('normalizes opposite signs and retains refunds, payments and raw values', () => {
    const amex = parseStatement(
      'Date,Description,Amount\n09/30/2026,SHOP,33.14\n09/29/2026,REFUND,-5.00\n09/28/2026,AUTOPAY PAYMENT - THANK YOU,-20.00',
      'amex',
    );
    expect(amex.map((r) => [r.amountCents, r.kind])).toEqual([
      [3314, 'expense'],
      [-500, 'refund'],
      [-2000, 'payment'],
    ]);
    const chase = parseStatement(
      csv(
        row(),
        row('01/11/2026', 'REFUND', '5', 'Return'),
        row('01/12/2026', 'PAYMENT', '20', 'Payment'),
      ),
      'chase',
    );
    expect(chase.map((r) => r.kind)).toEqual(['expense', 'refund', 'payment']);
    expect(chase[0].raw.Amount).toBe('-20.01');
  });
  it('preserves identical occurrences, skips reuploads only after confirmation and imports count differences', () => {
    const first = ingest(csv(row(), row()));
    expect(first).toHaveLength(2);
    const second = store.preview('sapphire', 'repeat.csv', csv(row(), row(), row()));
    expect(second.counts).toMatchObject({ new: 1, duplicates: 2 });
    expect(() => store.confirmImport(second.id, false)).toThrow(/confirm/);
    expect(store.confirmImport(second.id, true).ids).toHaveLength(1);
    expect(store.transactions()).toHaveLength(3);
  });
  it('supports explicit retain-as-distinct overrides and separates cards', () => {
    ingest(csv(row()));
    const p = store.preview('sapphire', 'repeat.csv', csv(row()));
    expect(store.confirmImport(p.id, false, [2]).ids).toHaveLength(1);
    expect(ingest(csv(row()), 'prime')).toHaveLength(1);
  });
  it('finds unsorted ranges and backfills within existing date coverage', () => {
    ingest(csv(row('03/10/2026'), row('01/10/2026')));
    const p = store.preview(
      'sapphire',
      'backfill.csv',
      csv(row('02/10/2026', 'NEW'), row('01/10/2026')),
    );
    expect(p.dateRange).toEqual({ from: '2026-01-10', to: '2026-02-10' });
    expect(p.counts.new).toBe(1);
    expect(store.confirmImport(p.id, true).ids).toHaveLength(1);
  });
  it('rechecks duplicates transactionally after concurrent previews', () => {
    const a = store.preview('sapphire', 'a.csv', csv(row())),
      b = store.preview('sapphire', 'b.csv', csv(row()));
    store.confirmImport(a.id, false);
    expect(() => store.confirmImport(b.id, false)).toThrow(/Another import/);
  });
  it('requires invalid-row acknowledgement, keeps card payments outside the workflow and rejects wrong headers', () => {
    const p = store.preview(
      'sapphire',
      'bad.csv',
      csv(row(), row('99/01/2026'), row('01/12/2026', 'PAYMENT', '20', 'Payment')),
    );
    expect(p.counts).toMatchObject({ new: 1, invalid: 1, payments: 1 });
    expect(() => store.confirmImport(p.id, false)).toThrow(/invalid rows/);
    expect(store.confirmImport(p.id, false, [], true).ids).toHaveLength(1);
    expect(store.all('SELECT * FROM import_rows')).toHaveLength(3);
    expect(() => parseStatement('Date,Description,Amount\n01/01/2026,A,1', 'chase')).toThrow(
      /format/,
    );
  });
});
describe('money and rule precedence', () => {
  it('uses integer cents and stable largest-remainder rounding', () => {
    expect(cents('1,500.01')).toBe(150001);
    expect(() => cents('1.001')).toThrow();
    const a = splitAmount(100, { mode: 'equal', participants: ['c', 'a', 'b'] });
    expect(a.reduce((s, p) => s + p.amountCents, 0)).toBe(100);
    expect(a.find((s) => s.personId === 'a')!.amountCents).toBe(34);
    expect(
      splitAmount(-100, { mode: 'equal', participants: ['b', 'a'] }).reduce(
        (s, p) => s + p.amountCents,
        0,
      ),
    ).toBe(-100);
    expect(() =>
      splitAmount(100, { mode: 'exact', participants: ['a', 'b'], values: [40, 40] }),
    ).toThrow(/equal/);
    expect(() =>
      splitAmount(100, { mode: 'percent', participants: ['a', 'b'], values: [5000, 4000] }),
    ).toThrow(/100%/);
  });
  it('requires rule review, prioritizes scoped rules, and detects conflicting instructions', () => {
    const person = store.addPerson('Alex', 'alex'),
      tx = ingest(csv(row()))[0];
    const def: RuleDefinition = {
      merchant: 'COFFEE',
      split: { mode: 'equal', participants: ['self', person.id] },
      outputCategory: 'Food & Drink',
    };
    const change = store.proposeRule('Coffee', def, undefined, 'user');
    expect(store.rules()).toHaveLength(0);
    expect(() => store.reviewRule(change, true, 'agent')).toThrow(/Only you/);
    store.reviewRule(change, true);
    const broad = store.rules()[0];
    const scoped = {
      ...broad,
      id: 'trip',
      definition: {
        ...def,
        from: '2026-01-01',
        to: '2026-01-31',
        split: { mode: 'personal' as const, participants: ['self'] },
      },
    };
    expect(ruleProposal(tx, [broad, scoped]).proposal?.ruleId).toBe('trip');
    expect(
      ruleProposal(tx, [
        broad,
        {
          ...broad,
          id: 'conflict',
          definition: { ...def, split: { mode: 'personal', participants: ['self'] } },
        },
      ]).error,
    ).toMatch(/Conflicting/);
  });
  it('resolves mentions and rejects unknown people and incorrect fixed rules', () => {
    const p = store.addPerson('Alex', 'alex', 'Roommate');
    expect(store.resolveMentions('Split with @alex')).toEqual([p.id]);
    expect(() => store.resolveMentions('With @missing')).toThrow(/Unknown/);
    const tx = ingest(csv(row()))[0];
    expect(
      ruleProposal(tx, [
        {
          id: 'x',
          title: 'Rent',
          active: 1,
          version: 1,
          definition: {
            merchant: '',
            outputCategory: 'Rent',
            split: { mode: 'exact', participants: ['self'], values: [370000] },
          },
        },
      ]).error,
    ).toMatch(/equal/);
  });
});
describe('review and authorization boundaries', () => {
  it('prohibits agent finalization, reopening, finalized edits, repayments and undo', () => {
    const person = store.addPerson('Alex', 'alex'),
      tx = ingest(csv(row()))[0],
      p = propose(tx, person.id);
    expect(() =>
      store.review([{ id: tx.id, version: tx.version }], 'approve', '', 'agent'),
    ).toThrow(/Only you/);
    const final = finalize(tx, p);
    expect(() =>
      store.saveProposals(
        [{ id: final.id, version: final.version, proposal: p, state: 'inbox' }],
        'agent',
      ),
    ).toThrow(/Finalized/);
    expect(() =>
      store.review([{ id: final.id, version: final.version }], 'reopen', '', 'agent'),
    ).toThrow(/Only you/);
    expect(() => store.addRepayment(person.id, '2026-01-10', 10, 'received', '', 'agent')).toThrow(
      /Only you/,
    );
    expect(() => store.undo('agent')).toThrow(/Only you/);
  });
  it('applies bulk actions atomically, rejects stale writes and queues corrections', () => {
    const person = store.addPerson('Alex', 'alex'),
      txs = ingest(csv(row(), row('02/10/2026')));
    for (const tx of txs)
      store.saveProposals(
        [{ id: tx.id, version: tx.version, proposal: propose(tx, person.id), state: 'ready' }],
        'user',
      );
    expect(() =>
      store.review(
        txs.map((t) => ({ id: t.id, version: t.version })),
        'approve',
      ),
    ).toThrow(/changed/);
    expect(store.transactions().every((t) => t.state === 'ready')).toBe(true);
    const fresh = store.transaction(txs[0].id);
    store.review([{ id: fresh.id, version: fresh.version }], 'correct', 'Equal with @alex');
    expect(store.transaction(fresh.id)).toMatchObject({
      state: 'inbox',
      instruction: 'Equal with @alex',
      proposal: null,
    });
  });
  it('persists multiple undos across restart and keeps versions monotonic', () => {
    const person = store.addPerson('Alex', 'alex'),
      tx = ingest(csv(row()))[0];
    finalize(tx, propose(tx, person.id));
    const before = store.transaction(tx.id).version;
    store.db.close();
    store = new Store(openDatabase(join(dir, 'test.sqlite')));
    store.undo();
    expect(store.transaction(tx.id).state).toBe('ready');
    expect(store.transaction(tx.id).version).toBeGreaterThan(before);
    store.undo();
    expect(store.transaction(tx.id).state).toBe('inbox');
    expect(store.snapshot().dashboard.totalOutstandingCents).toBe(0);
  });
  it('blocks activation races for edited rules and approval using stale rule versions', () => {
    const p = store.addPerson('Alex', 'alex');
    const def: RuleDefinition = {
      merchant: 'COFFEE',
      split: { mode: 'equal', participants: ['self', p.id] },
      outputCategory: 'Food & Drink',
    };
    const c = store.proposeRule('Coffee', def);
    store.reviewRule(c, true);
    const r = store.rules()[0];
    const tx = ingest(csv(row()))[0];
    const proposal = ruleProposal(tx, [r]).proposal!;
    store.saveProposals([{ id: tx.id, version: tx.version, proposal, state: 'ready' }], 'agent');
    const e1 = store.proposeRule('Edit1', { ...def, outputCategory: 'Personal' }, r.id),
      e2 = store.proposeRule('Edit2', def, r.id);
    store.reviewRule(e1, true);
    expect(() => store.reviewRule(e2, true)).toThrow(/changed/);
    expect(() =>
      store.review([{ id: tx.id, version: store.transaction(tx.id).version }], 'approve'),
    ).toThrow(/rule has changed/);
  });
});
describe('balances and refunds', () => {
  it('allocates later repayments to oldest expenses and filters unpaid amounts by original expense date', () => {
    const p = store.addPerson('Alex', 'alex'),
      txs = ingest(csv(row('01/10/2026', 'A', '-100'), row('02/10/2026', 'B', '-100')));
    for (const tx of txs) finalize(tx, propose(tx, p.id));
    store.addRepayment(p.id, '2026-04-01', 6000, 'received', 'Partial payment');
    const d = store.snapshot('2026-01-01', '2026-01-31').dashboard;
    expect(d.totalOutstandingCents).toBe(4000);
    expect(d.filteredOutstandingCents).toBe(0);
    expect(store.snapshot('2026-02-01', '2026-02-28').dashboard.filteredOutstandingCents).toBe(
      4000,
    );
    store.addRepayment(p.id, '2026-04-02', 5000, 'received', 'Overpayment');
    expect(store.snapshot().dashboard.people[0].creditCents).toBe(1000);
    store.addRepayment(p.id, '2026-04-03', 1000, 'returned', 'Return credit');
    expect(store.snapshot().dashboard.creditCents).toBe(0);
  });
  it('suggests a unique refund, preserves original finalization and caps linked refund totals', () => {
    const p = store.addPerson('Alex', 'alex');
    const original = ingest(csv(row('01/01/2026', 'SHOP', '-100')))[0];
    finalize(original, propose(original, p.id));
    const refund = ingest(csv(row('02/01/2026', 'SHOP', '40', 'Return')))[0];
    const suggestion = store.refundProposal(refund)!;
    expect(suggestion.refundOf).toBe(original.id);
    finalize(refund, suggestion);
    expect(store.snapshot().dashboard.totalOutstandingCents).toBe(3000);
    expect(store.transaction(original.id).state).toBe('finalized');
    const excessive = ingest(csv(row('03/01/2026', 'SHOP', '70', 'Return')))[0];
    expect(() =>
      store.validateProposal(excessive, { ...propose(excessive, p.id), refundOf: original.id }),
    ).toThrow(/remaining/);
  });
});
describe('durable jobs and mocked agent', () => {
  it('uses explicit instructions without an API key in test mode, rejects finalized selected records, and applies steps once', async () => {
    process.env.AGENT_MODE = 'mock';
    const person = store.addPerson('Alex', 'alex'),
      tx = ingest(csv(row()))[0];
    const id = store.enqueue('chat', { text: 'Split equally with @alex', ids: [tx.id] });
    const plan = await askAgent(store, 'Split equally with @alex', [tx.id]);
    expect(plan.updates[0].proposal?.splits).toHaveLength(2);
    const job = claimJob(store)!;
    applyStep(store, id, 0, plan, 1, 100);
    const version = store.transaction(tx.id).version;
    applyStep(store, id, 0, plan, 1, 100);
    expect(store.transaction(tx.id).version).toBe(version);
    await executeJob(store, store.job(job.id));
    expect(store.job(id).status).toBe('completed');
    store.review([{ id: tx.id, version }], 'approve');
    expect(await askAgent(store, 'Split equally with @alex', [tx.id])).toMatchObject({
      updates: [],
    });
    expect(person.id).toBeTruthy();
  });
  it('recovers expired leases and cancellation/retry preserves its cursor', () => {
    const id = store.enqueue('process', { ids: [] });
    claimJob(store);
    store.db.prepare('UPDATE jobs SET leaseUntil=0,cursor=20 WHERE id=?').run(id);
    expect(claimJob(store)?.cursor).toBe(20);
    store.cancelJob(id);
    store.db.prepare("UPDATE jobs SET status='cancelled' WHERE id=?").run(id);
    store.retryJob(id);
    expect(store.job(id)).toMatchObject({ status: 'queued', cursor: 20, cancelRequested: 0 });
  });
});

describe('additional financial and recovery invariants', () => {
  it('does not over-refund individual shares across repeated one-cent partial refunds', async () => {
    const { linkedRefundShares } = await import('../src/lib/money');
    const original = [
        { personId: 'a', amountCents: 2 },
        { personId: 'b', amountCents: 1 },
      ],
      previous: { personId: string; amountCents: number }[][] = [];
    for (let i = 0; i < 3; i++) previous.push(linkedRefundShares(original, -1, previous));
    expect(
      previous
        .flat()
        .filter((s) => s.personId === 'a')
        .reduce((sum, s) => sum + s.amountCents, 0),
    ).toBe(-2);
    expect(
      previous
        .flat()
        .filter((s) => s.personId === 'b')
        .reduce((sum, s) => sum + s.amountCents, 0),
    ).toBe(-1);
  });
  it('keeps medium-confidence proposals in Inbox and rejects an invented finalized state at the service boundary', () => {
    const p = store.addPerson('Alex', 'alex'),
      tx = ingest(csv(row()))[0],
      proposal = propose(tx, p.id);
    expect(() =>
      store.saveProposals(
        [
          {
            id: tx.id,
            version: tx.version,
            proposal: { ...proposal, confidence: 'medium' },
            state: 'ready',
          },
        ],
        'agent',
      ),
    ).toThrow(/high-confidence/);
    expect(() =>
      store.saveProposals(
        [{ id: tx.id, version: tx.version, proposal, state: 'finalized' as never }],
        'agent',
      ),
    ).toThrow(/cannot finalize/);
    expect(store.transaction(tx.id).state).toBe('inbox');
  });
  it('recovers cancellation when the previous worker died before seeing the request', () => {
    const id = store.enqueue('process', { ids: [] });
    claimJob(store);
    store.cancelJob(id);
    store.db.prepare('UPDATE jobs SET leaseUntil=0 WHERE id=?').run(id);
    expect(claimJob(store)).toBeUndefined();
    expect(store.job(id).status).toBe('cancelled');
  });
});

describe('rule revision and repayment safeguards', () => {
  it('does not reuse the revision of an undone rule edit', () => {
    const definition: RuleDefinition = {
      merchant: 'COFFEE',
      outputCategory: 'Food & Drink',
      split: { mode: 'personal', participants: ['self'] },
    };
    const first = store.proposeRule('Coffee', definition);
    store.reviewRule(first, true);
    const id = store.rules()[0].id;
    const edit = store.proposeRule(
      'Personal coffee',
      { ...definition, outputCategory: 'Personal' },
      id,
    );
    store.reviewRule(edit, true);
    const undoneVersion = store.rules()[0].version;
    store.undo();
    const next = store.proposeRule(
      'Travel coffee',
      { ...definition, outputCategory: 'Travel' },
      id,
    );
    store.reviewRule(next, true);
    expect(store.rules()[0].version).toBeGreaterThan(undoneVersion);
  });
  it('cannot return more than a person’s available credit', () => {
    const person = store.addPerson('Alex', 'alex');
    expect(() => store.addRepayment(person.id, '2026-01-10', 100, 'returned', '')).toThrow(
      /available credit/,
    );
  });
});

describe('quick instructions and durable transaction context', () => {
  it('saves context and queues only that expense, then retains it after approval and restart', async () => {
    process.env.AGENT_MODE = 'mock';
    const person = store.addPerson('Alex', 'alex');
    const [tx, untouched] = ingest(csv(row(), row('01/11/2026', 'OTHER')));
    const text = 'Split equally with @alex. This was dinner after our hiking trip.';
    const id = store.instruct([{ id: tx.id, version: tx.version }], text);
    expect(store.transaction(tx.id).notes.map((n) => n.text)).toEqual([text]);
    expect(store.transaction(tx.id).instruction).toBe(text);
    expect(store.job(id).payload.ids).toEqual([tx.id]);
    expect(store.snapshot().messages[0].transactionIds).toEqual([tx.id]);
    expect(store.snapshot().dashboard.totalOutstandingCents).toBe(0);
    await executeJob(store, claimJob(store)!);
    const ready = store.transaction(tx.id);
    expect(ready.state).toBe('ready');
    expect(ready.proposal?.splits.map((s) => s.personId).sort()).toEqual(
      ['self', person.id].sort(),
    );
    expect(store.transaction(untouched.id).state).toBe('inbox');
    store.review([{ id: ready.id, version: ready.version }], 'approve');
    store.db.close();
    store = new Store(openDatabase(join(dir, 'test.sqlite')));
    expect(store.transaction(tx.id).notes[0].text).toBe(text);
    expect(store.transaction(tx.id).state).toBe('finalized');
    expect(() =>
      store.instruct([{ id: tx.id, version: store.transaction(tx.id).version }], 'personal'),
    ).toThrow(/Inbox/);
    store.undo();
    expect(store.transaction(tx.id).notes[0].text).toBe(text);
  });

  it('atomically rejects unknown mentions, duplicate sends and stale queued instructions', async () => {
    process.env.AGENT_MODE = 'mock';
    const tx = ingest(csv(row()))[0];
    expect(() => store.instruct([{ id: tx.id, version: tx.version }], 'With @missing')).toThrow(
      /Unknown/,
    );
    expect(store.transaction(tx.id).notes).toEqual([]);
    expect(store.snapshot().jobs).toEqual([]);
    const id = store.instruct(
      [{ id: tx.id, version: tx.version }],
      'Personal expense. Bought supplies for my garden.',
    );
    expect(() => store.instruct([{ id: tx.id, version: tx.version }], 'personal')).toThrow(
      /changed/,
    );
    expect(store.snapshot().jobs).toHaveLength(1);
    const current = store.transaction(tx.id);
    store.review(
      [{ id: tx.id, version: current.version }],
      'correct',
      'This was a gift, my personal expense.',
    );
    await expect(executeJob(store, store.job(id))).rejects.toThrow(/changed after/);
    expect(store.transaction(tx.id).instruction).toContain('gift');
    expect(store.transaction(tx.id).notes).toHaveLength(2);
    expect(store.transaction(tx.id).state).toBe('inbox');
  });

  it('saves scoped chat context once and applies buffered agent notes at most once', () => {
    const person = store.addPerson('Alex', 'alex');
    const tx = ingest(csv(row()))[0];
    const id = store.enqueue('chat', {
      text: 'Dinner with @alex on our road trip. Split equally.',
      ids: [tx.id],
    });
    const fresh = store.transaction(tx.id);
    expect(fresh.notes[0].source).toBe('chat');
    const plan = {
      message: 'Prepared a split.',
      rules: [],
      updates: [
        {
          id: tx.id,
          version: fresh.version,
          proposal: propose(fresh, person.id),
          state: 'ready' as const,
          context: 'The restaurant was near our hotel.',
        },
      ],
    };
    applyStep(store, id, 0, plan, 1, 100);
    applyStep(store, id, 0, plan, 1, 100);
    expect(store.transaction(tx.id).notes).toHaveLength(2);
    const ready = store.transaction(tx.id);
    store.review([{ id: ready.id, version: ready.version }], 'approve');
    expect(() =>
      store.saveProposals(
        [
          {
            id: tx.id,
            version: store.transaction(tx.id).version,
            state: 'inbox',
            proposal: null,
            context: 'Changed',
          },
        ],
        'agent',
      ),
    ).toThrow(/Finalized/);
    expect(store.transaction(tx.id).notes).toHaveLength(2);
  });

  it('keeps a focused clarification in Inbox while preserving every earlier note', async () => {
    process.env.AGENT_MODE = 'mock';
    const tx = ingest(csv(row()))[0];
    store.instruct([{ id: tx.id, version: tx.version }], 'This charge was for our weekend trip.');
    await executeJob(store, claimJob(store)!);
    const fresh = store.transaction(tx.id);
    expect(fresh.state).toBe('inbox');
    expect(fresh.attention).toContain('Who');
    expect(fresh.notes[0].text).toContain('weekend trip');
    store.instruct([{ id: fresh.id, version: fresh.version }], 'My personal expense.');
    await executeJob(store, claimJob(store)!);
    expect(store.transaction(tx.id).state).toBe('ready');
    expect(store.transaction(tx.id).notes).toHaveLength(2);
  });
});

it('keeps chat turns in insertion order when their timestamps match', () => {
  const id = store.enqueue('chat', { text: 'A question about expenses.' });
  store.addMessage('assistant', 'An answer.', id);
  store.db.prepare("UPDATE messages SET createdAt='2026-10-15T20:00:00.000Z'").run();
  expect(store.snapshot().messages.map((m) => m.role)).toEqual(['user', 'assistant']);
});
