import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
import { claimJob, executeJob } from '../src/lib/jobs';
import { DataTransfer } from '../src/lib/data-transfer';
import type { ImportResult } from '../src/lib/types';

let store: Store;
beforeEach(() => {
  store = new Store(openDatabase(':memory:'));
});
afterEach(() => {
  store.db.close();
  delete process.env.AGENT_MODE;
});
const csv = (rows: string[]) => 'Date,Description,Amount\n' + rows.join('\n');
function ingest(
  rows = ['01/10/2026,COFFEE,20.01', '01/11/2026,TRIP FOOD,10.00', '02/01/2026,OTHER,5.00'],
) {
  const preview = store.preview('amex', 'synthetic.csv', csv(rows));
  return { id: preview.id, result: store.confirmImport(preview.id, true) };
}
function finish(
  id: string,
  result: ImportResult,
  text: string,
  process = false,
  from?: string,
  to?: string,
) {
  return store.finishImport(id, result.items, text, process, from, to);
}
describe('optional post-CSV import context', () => {
  it('reports dates for new expenses only, excluding payments and skipped duplicates', () => {
    const original = ingest(['01/01/2026,OLDER,10.00']);
    const { result } = ingest([
      '12/01/2025,AUTOPAY PAYMENT,-50.00',
      '01/01/2026,OLDER,10.00',
      '01/10/2026,NEW,15.00',
    ]);
    expect(result.ids).toHaveLength(1);
    expect(result.dateRange).toEqual({ from: '2026-01-10', to: '2026-01-10' });
    expect(result.items).toEqual([{ id: result.ids[0], date: '2026-01-10', version: 1 }]);
    expect(store.transaction(original.result.ids[0]).notes).toEqual([]);
  });
  it('saves one-off notes and instructions only on new transactions in the chosen date range, and retains them in JSON exports', () => {
    store.addPerson('Alex', 'alex');
    const old = ingest(['01/10/2026,EXISTING,11.00']).result;
    const baseline = store.transaction(old.ids[0]);
    const { id, result } = ingest();
    const text = 'We were on a hiking trip. Split food equally with @alex.';
    const saved = finish(id, result, text, false, '2026-01-10', '2026-01-11');
    expect(saved).toMatchObject({ affectedCount: 2, context: text, process: false });
    for (const item of result.items) {
      const tx = store.transaction(item.id);
      if (item.date < '2026-02-01') {
        expect(tx).toMatchObject({
          state: 'inbox',
          instruction: text,
          notes: [{ source: 'import', text }],
        });
      } else expect(tx).toMatchObject({ instruction: '', notes: [], version: 1 });
    }
    expect(store.transaction(baseline.id)).toEqual(baseline);
    expect(store.snapshot().jobs).toHaveLength(0);
    expect(store.rules()).toHaveLength(0);
    const destination = new Store(openDatabase(':memory:'));
    try {
      const transfer = new DataTransfer(destination);
      const preview = transfer.preview(
        'transactions',
        'synthetic.json',
        JSON.stringify(new DataTransfer(store).export('transactions')),
      );
      transfer.confirm(preview.id, false, [], true);
      expect(destination.people().some((p) => p.handle === 'alex')).toBe(true);
      expect(destination.transaction(result.ids[0]).notes[0]).toMatchObject({
        source: 'import',
        text,
      });
      expect(destination.snapshot().dashboard.totalOutstandingCents).toBe(0);
    } finally {
      destination.db.close();
    }
  });
  it('honors saved import instructions before broad rules when processing now or later', async () => {
    process.env.AGENT_MODE = 'mock';
    const alex = store.addPerson('Alex', 'alex');
    const change = store.proposeRule('Personal coffee', {
      merchant: 'COFFEE',
      outputCategory: 'Personal',
      split: { mode: 'personal', participants: ['self'] },
    });
    store.reviewRule(change, true);
    const { id, result } = ingest(['01/10/2026,COFFEE,20.01', '02/01/2026,COFFEE,5.00']);
    finish(id, result, 'On our trip, split equally with @alex.', false, '2026-01-10', '2026-01-10');
    store.enqueue('process', { ids: result.ids });
    await executeJob(store, claimJob(store)!);
    const trip = store.transaction(result.items.find((item) => item.date === '2026-01-10')!.id);
    const other = store.transaction(result.items.find((item) => item.date === '2026-02-01')!.id);
    expect(trip).toMatchObject({ state: 'ready', proposal: { source: 'instruction' } });
    expect(trip.proposal!.splits.map((share) => share.personId)).toContain(alex.id);
    expect(other.proposal!.splits).toEqual([{ personId: 'self', amountCents: 500 }]);
    expect(store.snapshot().dashboard.totalOutstandingCents).toBe(0);
  });
  it('atomically saves context before queuing one processing job and tolerates an identical completion retry', async () => {
    process.env.AGENT_MODE = 'mock';
    store.addPerson('Alex', 'alex');
    const { id, result } = ingest();
    const first = finish(id, result, 'Split equally with @alex.', true);
    const retry = finish(id, result, 'Split equally with @alex.', true);
    expect(retry.jobId).toBe(first.jobId);
    expect(store.snapshot().jobs).toHaveLength(1);
    expect(store.transaction(result.ids[0]).notes).toHaveLength(1);
    expect(() => finish(id, result, 'Personal expense.', true)).toThrow(/already completed/);
    await executeJob(store, claimJob(store)!);
    expect(store.transaction(result.ids[0]).state).toBe('ready');
    expect(store.transaction(result.ids[0]).notes[0].source).toBe('import');
    expect(finish(id, result, 'Split equally with @alex.', true).jobId).toBe(first.jobId);
    expect(store.snapshot().jobs).toHaveLength(1);
  });
  it('rejects invalid mentions, empty/reversed date scopes, other import IDs, stale writes, and agent actions without partial changes', () => {
    const { id, result } = ingest();
    expect(() =>
      store.finishImport(id, result.items, 'Personal expense', true, undefined, undefined, 'agent'),
    ).toThrow(/Only you/);
    expect(() => finish(id, result, 'Split with @missing.', true)).toThrow(/Unknown person/);
    expect(() => finish(id, result, 'Trip context', true, '2026-02-31')).toThrow(/Invalid date/);
    expect(() => finish(id, result, 'Trip context', true, '2026-02-01', '2026-01-01')).toThrow(
      /precede/,
    );
    expect(() => finish(id, result, 'Trip context', true, '2027-01-01')).toThrow(
      /No new transactions/,
    );
    expect(() => store.finishImport(id, result.items.slice(1), 'Trip context', true)).toThrow(
      /exactly/,
    );
    const other = ingest(['03/01/2026,OTHER UPLOAD,15.00']);
    expect(() => finish(id, other.result, 'Trip context')).toThrow(/exactly/);
    expect(store.snapshot().jobs).toHaveLength(0);
    expect(result.ids.every((id) => store.transaction(id).notes.length === 0)).toBe(true);
    const item = result.items[0];
    store.review([{ id: item.id, version: item.version }], 'correct', 'My personal expense.');
    expect(() => finish(id, result, 'Trip context', true)).toThrow(/changed/);
    expect(store.transaction(result.ids[1]).notes).toHaveLength(0);
    expect(store.snapshot().jobs).toHaveLength(0);
  });
  it('allows skipping context, including an import containing only payments or duplicates', () => {
    const first = ingest();
    const completion = finish(first.id, first.result, '   ');
    expect(completion.affectedCount).toBe(0);
    expect(store.transaction(first.result.ids[0])).toMatchObject({
      version: 1,
      instruction: '',
      notes: [],
    });
    const noNew = ingest(['01/10/2026,COFFEE,20.01', '01/01/2026,AUTOPAY PAYMENT,-100.00']);
    expect(noNew.result.dateRange).toEqual({ from: null, to: null });
    expect(noNew.result.ids).toHaveLength(0);
    expect(finish(noNew.id, noNew.result, '', true).jobId).toBeUndefined();
    expect(store.snapshot().jobs).toHaveLength(0);
  });
  it('handles more than a correction batch of 100 expenses and can Undo the context while retaining the import audit', () => {
    const { id, result } = ingest(
      Array.from({ length: 125 }, (_, i) => '01/10/2026,EXPENSE ' + i + ',1.00'),
    );
    finish(id, result, 'Personal expenses from a work trip.');
    expect(store.transaction(result.ids[124]).notes[0].source).toBe('import');
    store.undo();
    expect(store.transactions()).toHaveLength(125);
    expect(store.transactions().every((tx) => !tx.instruction && tx.notes.length === 0)).toBe(true);
    const audit = JSON.parse(
      store.one<{ preview: string }>('SELECT preview FROM imports WHERE id=?', id)!.preview,
    );
    expect(audit.completion.context).toContain('work trip');
  });
});
