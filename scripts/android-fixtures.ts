import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
import { Features } from '../src/lib/features';
import { randomUUID } from 'node:crypto';
import { allocate, splitAmount, linkedRefundShares } from '../src/lib/money';
import { parseStatement } from '../src/lib/importer';
import { calculateDashboard } from '../src/lib/balances';
import type { Transaction, Person, Repayment } from '../src/lib/types';

// Synthetic cross-language fixtures: expected results come from the production web ledger.
const allocations = [];
for (const total of [1, 2, 3, 7, 99, 100, 101, 10001, 999999, 1_000_000_000_000]) {
  for (const sign of [1, -1]) for (const weights of [[1, 1], [1, 1, 1], [0, 1, 2], [3333, 3333, 3334], [1, 999999999]]) {
    const ids = ['self', 'alex', 'zara'].slice(0, weights.length);
    allocations.push({ total: total * sign, ids, weights, expected: allocate(total * sign, ids, weights) });
  }
}
const refunds = [];
for (const amount of [3, 7, 101, 10001]) {
  const original = splitAmount(amount, { mode: 'equal', participants: ['self', 'alex', 'zara'] });
  const previous = [];
  for (const value of [1, 1, amount - 2]) {
    const expected = linkedRefundShares(original, -value, previous);
    refunds.push({ original, amount: -value, previous: structuredClone(previous), expected });
    previous.push(expected);
  }
}
const people = [
  { id: 'self', name: 'Me', handle: 'me', relation: '', isSelf: 1 },
  { id: 'alex', name: 'Alex', handle: 'alex', relation: 'Friend', isSelf: 0 },
  { id: 'zara', name: 'Zara', handle: 'zara', relation: 'Friend', isSelf: 0 },
] satisfies Person[];
const transactions = [
  { id: 'a', date: '2026-01-01', description: 'First', amountCents: 101, state: 'finalized', proposal: { splits: allocate(101, ['self', 'alex', 'zara'], [1,1,1]), category: 'Food' } },
  { id: 'b', date: '2026-01-01', description: 'Second', amountCents: 700, state: 'finalized', proposal: { splits: allocate(700, ['self', 'alex'], [1,1]), category: 'Travel' } },
  { id: 'c', date: '2026-02-01', description: 'Third', amountCents: 400, state: 'finalized', proposal: { splits: allocate(400, ['self', 'alex'], [1,1]), category: 'Travel' } },
  { id: 'd', date: '2026-02-02', description: 'Refund', amountCents: -100, state: 'finalized', proposal: { splits: allocate(-100, ['self', 'alex'], [1,1]), category: 'Travel', refundOf: 'b' } },
  { id: 'e', date: '2026-02-03', description: 'Unlinked refund', amountCents: -50, state: 'finalized', proposal: { splits: [{ personId: 'alex', amountCents: -50 }], category: 'Travel' } },
  { id: 'f', date: '2026-01-01', description: 'Unapproved', amountCents: 10000, state: 'ready', proposal: { splits: [{ personId: 'alex', amountCents: 10000 }], category: 'Food' } },
] as Transaction[];
const balanceCases = [];
for (const received of [0, 1, 200, 533, 800]) for (const returned of [0, 100]) {
  const repayments = [{ id: 'pay', personId: 'alex', date: '2026-03-01', amountCents: received, direction: 'received', note: '' }, { id: 'return', personId: 'alex', date: '2026-03-02', amountCents: returned, direction: 'returned', note: '' }] as Repayment[];
  const expected = calculateDashboard(transactions, people, repayments, '2026-01-01', '2026-01-31');
  balanceCases.push({ transactions, people, repayments, from: '2026-01-01', to: '2026-01-31', expected: expected.people });
}
const statements = [
  { format: 'amex', text: 'Date,Description,Amount\n01/03/2026,"Cafe, Inc",12.34\n01/04/2026,AUTOPAY PAYMENT,-20.00\n01/05/2026,Refund,-1.01\n' },
  { format: 'chase', text: '\uFEFFTransaction Date,Post Date,Description,Category,Type,Amount,Memo\r\n01/01/2026,01/02/2026,"Shop ""A""",Shopping,Sale,-10.01,\r\n01/02/2026,01/03/2026,Payment,,Payment,100,\r\n' },
  { format: 'amex', text: 'Date,Description,Amount\n02/30/2026,Invalid,1.00\n01/01/2026,Zero,0.00\n01/02/2026,"Line one\nLine two",12.00\n' },
].map((test) => ({ ...test, expected: parseStatement(test.text, test.format as 'amex' | 'chase') }));
writeFileSync('android/ledger/src/test/resources/parity.json', JSON.stringify({ allocations, refunds, balanceCases, statements }, null, 2) + '\n');
console.log(`Wrote ${allocations.length + refunds.length + balanceCases.length + statements.length} web-ledger parity cases.`);

// A complete database created by the actual web migrator catches schema differences,
// including Drizzle's SERIAL migration key and its exact SQL-file hashes.
mkdirSync('.tools/android/fixtures', { recursive: true });
const database = '.tools/android/fixtures/web-workspace.sqlite';
rmSync(database, { force: true });
rmSync(database + '-wal', { force: true });
rmSync(database + '-shm', { force: true });
const db = openDatabase(database);
const store = new Store(db);
const fixturePerson = store.addPerson('Synthetic Alex', 'synthetic_alex', 'Synthetic friend');
const features = new Features(store);
const trip = features.saveTrip({ name: 'Synthetic trip', destination: 'Test destination', from: '2026-01-01', to: '2026-01-03', split: { mode: 'equal', participants: ['self', fixturePerson.id] }, context: 'Synthetic trip with @synthetic_alex' });
features.manual({ description: 'Synthetic web lunch', date: '2026-01-01', amountCents: 101, category: 'Food & Drink', note: 'Synthetic source with @synthetic_alex', tripId: trip.id, requestId: randomUUID() });
const fixtureTransaction = store.transactions().find(t => t.description === 'Synthetic web lunch')!;
features.quick({ items: [{ id: fixtureTransaction.id, version: fixtureTransaction.version }], mode: 'equal', participants: ['self', fixturePerson.id], category: 'Food & Drink' });
store.review([{ id: fixtureTransaction.id, version: store.transaction(fixtureTransaction.id).version }], 'approve');
store.addRepayment(fixturePerson.id, '2026-01-04', 25, 'received', 'Synthetic repayment');
features.addAttachment(fixtureTransaction.id, 'synthetic.pdf', 'application/pdf', Buffer.from('%PDF-1.7 Synthetic receipt'));
db.pragma('wal_checkpoint(TRUNCATE)');
db.close();
