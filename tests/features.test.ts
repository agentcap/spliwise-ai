import { AssistantService } from '../src/lib/assistant-service';
function confirmPrepared(store: Store) {
  for (const r of new AssistantService(store).requests().filter((r) => r.status === 'pending'))
    new AssistantService(store).applyRequest(r.id);
}
import { test, expect, afterEach, vi } from 'vitest';
import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
import { Features } from '../src/lib/features';
import { DataTransfer } from '../src/lib/data-transfer';
import { claimJob, executeJob } from '../src/lib/jobs';
import { featureRequest } from '../src/lib/feature-api';
import { queryLedger } from '../src/lib/ledger-query';
import { randomUUID } from 'node:crypto';
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllEnvs();
});
function setup() {
  const db = openDatabase(':memory:');
  databases.push(db);
  const store = new Store(db),
    features = new Features(store),
    person = store.addPerson('Alex', 'alex', 'Friend');
  const input = {
    name: 'Mountain weekend',
    destination: 'Yosemite',
    from: '2026-06-01',
    to: '2026-06-03',
    context: 'Food and lodging were shared.',
    split: { mode: 'equal' as const, participants: ['self', person.id] },
  };
  const tripId = features.saveTrip(input).id;
  const make = (description = 'Dinner', date = '2026-06-02', amountCents = 10001) =>
    features.manual({
      description,
      date,
      amountCents,
      category: 'Food & Drink',
      note: 'Synthetic note',
      tripId: null,
      requestId: randomUUID(),
    }).id;
  return { store, features, person, tripId, input, make };
}
test('trips suggest dates without assigning, allow earlier bookings, and preserve finalized allocations', () => {
  const { store, features, tripId, make } = setup(),
    dinner = make(),
    flight = make('Flight', '2026-03-01');
  expect(features.suggestions(tripId).transactions.map((t) => t.id)).toEqual([dinner]);
  expect(store.transaction(dinner).tripId).toBeNull();
  features.assign([store.transaction(flight)], tripId);
  expect(store.transaction(flight).tripId).toBe(tripId);
  features.quick({ items: [store.transaction(dinner)], mode: 'personal' });
  store.review([store.transaction(dinner)], 'approve');
  const proposal = store.transaction(dinner).proposal;
  features.assign([store.transaction(dinner)], tripId);
  expect(store.transaction(dinner).state).toBe('finalized');
  expect(store.transaction(dinner).proposal).toEqual(proposal);
  expect(features.snapshot().trips[0].count).toBe(2);
  expect(features.snapshot().trips[0].totalCents).toBe(10001);
});
test('trip defaults use deterministic cents, reset unfinished proposals on edit, and reject stale approvals', () => {
  const { store, features, tripId, input, make } = setup(),
    id = make();
  features.assign([store.transaction(id)], tripId);
  const proposal = features.tripProposal(store.transaction(id)).proposal!;
  expect(proposal.splits.reduce((s, p) => s + p.amountCents, 0)).toBe(10001);
  store.saveProposals([{ ...store.transaction(id), proposal, state: 'ready' }], 'agent');
  const stale = store.transaction(id);
  features.saveTrip({ ...input, id: tripId, version: 1, context: 'Updated trip facts' });
  expect(store.transaction(id).state).toBe('inbox');
  expect(() => store.review([stale], 'approve')).toThrow();
  expect(() => features.saveTrip({ ...input, id: tripId, version: 1 })).toThrow(/changed/);
  store.undo();
  expect(store.transaction(id).state).toBe('ready');
  // Undo restores the definition and rebinds restored proposals to its fresh version.
  store.review([store.transaction(id)], 'approve');
  expect(store.transaction(id).state).toBe('finalized');
});
test('trip archive requires review completion, is reversible and blocks new assignments', () => {
  const { store, features, tripId, make } = setup(),
    id = make();
  features.assign([store.transaction(id)], tripId);
  expect(() => features.archive(tripId, 1, true)).toThrow(/Review every/);
  features.quick({ items: [store.transaction(id)], mode: 'personal' });
  store.review([store.transaction(id)], 'approve');
  features.archive(tripId, 1, true);
  expect(features.trip(tripId).status).toBe('archived');
  const second = make();
  expect(() => features.assign([store.transaction(second)], tripId)).toThrow(/Reopen/);
  store.undo(); // Undo manual creation, then trip archive.
  store.undo();
  expect(features.trip(tripId).status).toBe('active');
});
test('manual expense retries are idempotent and Undo does not resurrect a reused request', () => {
  const { store, features } = setup(),
    a = {
      description: 'Cash museum',
      date: '2026-01-01',
      amountCents: 1200,
      category: 'Travel',
      note: 'Cash at the door',
      tripId: null,
      requestId: randomUUID(),
    };
  const first = features.manual(a);
  expect(features.manual(a)).toEqual(first);
  expect(store.transaction(first.id).state).toBe('inbox');
  expect(store.transaction(first.id).notes[0].text).toBe(a.note);
  expect(store.dashboard().totalSpentCents).toBe(0);
  store.undo();
  expect(() => features.manual(a)).toThrow(/undone/);
  expect(() => features.manual({ ...a, requestId: randomUUID(), amountCents: -10 })).toThrow();
});
test('bulk quick splits are atomic, version checked, scoped to unfinished records and never finalize', () => {
  const { store, features, person, make } = setup(),
    a = make(),
    b = make('Second');
  const original = store.transaction(a);
  expect(() =>
    features.quick({
      items: [original, { id: b, version: 999 }],
      mode: 'equal',
      participants: ['self', person.id],
    }),
  ).toThrow(/changed/);
  expect(store.transaction(a).version).toBe(original.version);
  features.quick({
    items: [original, store.transaction(b)],
    mode: 'equal',
    participants: ['self', person.id],
  });
  expect(store.transaction(a).state).toBe('ready');
  expect(store.dashboard().totalOutstandingCents).toBe(0);
  store.review([store.transaction(a)], 'approve');
  expect(() => features.quick({ items: [store.transaction(a)], mode: 'personal' })).toThrow(
    /Finalized/,
  );
  expect(() => features.assign([store.transaction(b)], null, 'agent')).toThrow(/Only you/);
});
test('templates support percentages, exact totals, last finalized method, deletion and persistent Undo', () => {
  const { store, features, person, make } = setup(),
    id = make();
  const template = features.saveTemplate({
    name: 'Half each',
    category: 'Food & Drink',
    spec: { mode: 'percent', participants: ['self', person.id], values: [5000, 5000] },
  });
  features.quick({ items: [store.transaction(id)], mode: 'template', templateId: template.id });
  store.review([store.transaction(id)], 'approve');
  const second = make('Second');
  features.quick({ items: [store.transaction(second)], mode: 'last' });
  expect(store.transaction(second).proposal?.spec?.mode).toBe('percent');
  const exact = features.saveTemplate({
    name: 'Rent',
    category: 'Bills & Utilities',
    spec: { mode: 'exact', participants: ['self', person.id], values: [5000, 5000] },
  });
  expect(() =>
    features.quick({ items: [store.transaction(second)], mode: 'template', templateId: exact.id }),
  ).toThrow(/Fixed split/);
  features.remove('template', template.id, 1);
  expect(features.templates().some((t) => t.id === template.id)).toBe(false);
  store.undo();
  expect(features.templates().find((t) => t.id === template.id)?.version).toBe(2);
  expect(() => features.remove('template', template.id, 1)).toThrow(/changed/);
});
test('trip processing works without AI or consent and aliases match approved rules without modifying source text', async () => {
  const { store, features, person, tripId, make } = setup();
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('AGENT_MODE', '');
  features.saveTrip({ ...features.trip(tripId), context: '' });
  const id = make('TST* DINER');
  features.assign([store.transaction(id)], tripId);
  const jobId = store.enqueue('process', { ids: [id] });
  await executeJob(store, claimJob(store)!, undefined);
  confirmPrepared(store);
  expect(store.job(jobId).status).toBe('completed');
  expect(store.transaction(id).proposal?.source).toBe('trip');
  const second = make('TST* CAFE 004');
  features.saveAlias({ pattern: 'TST* CAFE', name: 'Morning Coffee' });
  const rule = store.proposeRule('Coffee', {
    merchant: 'Morning Coffee',
    outputCategory: 'Food & Drink',
    split: { mode: 'equal', participants: ['self', person.id] },
  });
  store.reviewRule(rule, true);
  store.enqueue('process', { ids: [second] });
  await executeJob(store, claimJob(store)!);
  confirmPrepared(store);
  expect(store.transaction(second).proposal?.source).toBe('rule');
  expect(store.transaction(second).description).toBe('TST* CAFE 004');
});
test('receipts validate MIME and size, remain private to their ledger and survive deletion Undo', async () => {
  const { store, features, make } = setup(),
    id = make();
  const pdf = Buffer.from('%PDF-1.4\nSynthetic receipt\n%%EOF');
  const file = features.addAttachment(id, 'receipt.pdf', 'application/pdf', pdf);
  expect(features.attachments(id)[0].name).toBe('receipt.pdf');
  expect(await features.download(file.id).text()).toBe(pdf.toString());
  expect(features.download(file.id).headers.get('content-disposition')).toContain('attachment');
  expect(() =>
    features.addAttachment(id, 'evil.html', 'image/png', Buffer.from('<script>')),
  ).toThrow(/matching/);
  expect(() =>
    features.addAttachment(
      id,
      'big.pdf',
      'application/pdf',
      Buffer.concat([pdf, Buffer.alloc(5_000_000)]),
    ),
  ).toThrow(/5 MB/);
  const other = new Features(new Store(openDatabase(':memory:')));
  databases.push(other.store.db);
  expect(() => other.download(file.id)).toThrow(/not found/);
  features.removeAttachment(file.id);
  expect(features.attachments(id)).toHaveLength(0);
  store.undo();
  expect(features.attachments(id)).toHaveLength(1);
});
test('settlement summaries use current unpaid amounts, later repayments and explicit trip membership', () => {
  const { store, features, person, tripId, make } = setup(),
    id = make();
  features.assign([store.transaction(id)], tripId);
  features.quick({
    items: [store.transaction(id)],
    mode: 'equal',
    participants: ['self', person.id],
  });
  store.review([store.transaction(id)], 'approve');
  store.addRepayment(person.id, '2026-07-01', 2000, 'received', 'Later repayment');
  const summary = features.settlement(person.id, '2026-06-01', '2026-06-30', tripId);
  expect(summary).toContain('Dinner');
  expect(summary).toMatch(/\$30\.0[01]/);
  expect(summary).toContain('Mountain weekend');
  expect(queryLedger(store.db, { tripId, view: 'review' }).transactions).toHaveLength(0);
  expect(queryLedger(store.db, { tripId, view: 'finalized' }).transactions).toHaveLength(1);
  const exported = new DataTransfer(store).export('transactions', { tripId });
  expect(exported.kind === 'transactions' && exported.transactions.length).toBe(1);
});
test('feature HTTP interfaces reject malformed payloads and foreign workspace IDs', async () => {
  const { store, features, make } = setup(),
    id = make();
  const get = (key: string) =>
    featureRequest(store, key, new Request('http://localhost/api/' + key));
  const resp = await get('transaction-source/' + id);
  expect(resp?.status).toBe(200);
  await expect(get('transaction-files/foreign')).rejects.toThrow(/not found/);
  await expect(
    featureRequest(
      store,
      'trips/save',
      new Request('http://localhost/api/trips/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }),
    ),
  ).rejects.toThrow();
  expect(() =>
    features.saveTrip({
      name: 'Invalid',
      destination: '',
      from: '2026-99-01',
      to: '2026-99-02',
      context: '',
      split: { mode: 'equal', participants: ['self'] },
    }),
  ).toThrow();
});

test('trip context requires clarification without AI, and explicit Trip default still works', async () => {
  const { store, features, tripId, make } = setup(),
    id = make();
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('AGENT_MODE', '');
  features.assign([store.transaction(id)], tripId);
  store.enqueue('process', { ids: [id] });
  await executeJob(store, claimJob(store)!);
  confirmPrepared(store);
  expect(store.transaction(id).state).toBe('inbox');
  expect(store.transaction(id).proposal).toBeNull();
  features.quick({ items: [store.transaction(id)], mode: 'trip' });
  expect(store.transaction(id).state).toBe('ready');
  expect(store.transaction(id).proposal?.splits).toHaveLength(2);
});
test('trip assignment validates the whole selection and leaves the other workspace untouched', () => {
  const { store, features, tripId, make } = setup(),
    a = make(),
    b = make('Second');
  const original = store.transaction(a);
  expect(() => features.assign([original, { id: b, version: 999 }], tripId)).toThrow(/changed/);
  expect(store.transaction(a).version).toBe(original.version);
  expect(store.transaction(a).tripId).toBeNull();
  const second = new Features(new Store(openDatabase(':memory:')));
  databases.push(second.store.db);
  expect(() => second.assign([original], tripId)).toThrow(/not found/);
});
test('merchant display names are searchable while ambiguous names preserve statement labels', () => {
  const { store, features, make } = setup(),
    id = make('TST* CAFE CENTRAL 002');
  features.saveAlias({ pattern: 'CAFE CENTRAL', name: 'Morning Coffee' });
  expect(queryLedger(store.db, { search: 'Morning Coffee' }).transactions.map((t) => t.id)).toEqual(
    [id],
  );
  expect(store.transaction(id).description).toBe('TST* CAFE CENTRAL 002');
  expect(() => features.saveAlias({ pattern: 'CAFE CENTRAL', name: 'Another Name' })).toThrow(
    /already/,
  );
});
test('feature mutations cannot be invoked as agent operations', () => {
  const { store, features, input, tripId, make } = setup(),
    id = make();
  const calls = [
    () => features.saveTrip(input, 'agent'),
    () => features.archive(tripId, 1, true, 'agent'),
    () => features.quick({ items: [store.transaction(id)], mode: 'personal' }, 'agent'),
    () => features.saveAlias({ pattern: 'CAFE', name: 'Coffee' }, 'agent'),
    () =>
      features.saveTemplate(
        {
          name: 'Personal',
          category: 'Personal',
          spec: { mode: 'personal', participants: ['self'] },
        },
        'agent',
      ),
    () => features.remove('alias', 'unknown', 1, 'agent'),
    () => features.manual({}, 'agent'),
    () => features.addAttachment(id, 'x.pdf', 'application/pdf', Buffer.from('%PDF-'), 'agent'),
    () => features.removeAttachment('unknown', 'agent'),
  ];
  for (const call of calls) expect(call).toThrow(/Only you/);
});
