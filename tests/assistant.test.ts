import { afterEach, test, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
import { Features } from '../src/lib/features';
import { AssistantService } from '../src/lib/assistant-service';
import { applyStep, claimJob, executeJob } from '../src/lib/jobs';
import type { AgentPlan } from '../src/lib/agent';
import type { AssistantOperation } from '../src/lib/assistant-contracts';
const dbs: ReturnType<typeof openDatabase>[] = [],
  dirs: string[] = [];
afterEach(() => {
  dbs.splice(0).forEach((d) => {
    if (d.open) d.close();
  });
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
  vi.unstubAllEnvs();
});
function setup(file = ':memory:') {
  const db = openDatabase(file);
  dbs.push(db);
  const store = new Store(db),
    service = new AssistantService(store),
    features = new Features(store),
    person =
      store.people().find((p) => p.handle === 'alex') || store.addPerson('Alex', 'alex', 'Friend');
  const make = (description = 'Synthetic dinner', amountCents = 10001) =>
    features.manual({
      description,
      date: '2028-06-02',
      amountCents,
      category: 'Food & Drink',
      note: '',
      tripId: null,
      requestId: randomUUID(),
    }).id;
  const trip = (): Extract<AssistantOperation, { kind: 'trip'; action: 'save' }> => ({
    kind: 'trip',
    action: 'save',
    id: randomUUID(),
    version: null,
    name: 'Yosemite',
    destination: 'Yosemite',
    from: '2028-06-01',
    to: '2028-06-03',
    split: { mode: 'equal', participants: ['self', person.id] },
    context: 'Shared food',
  });
  const rule = (): Extract<AssistantOperation, { kind: 'rule'; action: 'save' }> => ({
    kind: 'rule',
    action: 'save',
    id: randomUUID(),
    version: null,
    title: 'Dinner with Alex',
    definition: {
      merchant: 'Synthetic dinner',
      outputCategory: 'Food & Drink',
      split: { mode: 'equal', participants: ['self', person.id] },
    },
  });
  return { db, store, service, features, person, make, trip, rule };
}
function plan(): AgentPlan {
  return { message: 'Prepared.', updates: [], rules: [] };
}
test('agent rules activate immediately, deduplicate, and never change existing proposals or balances', () => {
  const { store, service, features, make, rule } = setup(),
    id = make(),
    r = rule();
  features.quick({ items: [store.transaction(id)], mode: 'personal' });
  const before = store.transaction(id);
  service.applyOperation(r, 'job', 0, '');
  expect(store.rules().filter((r) => r.active)).toHaveLength(1);
  expect(store.ruleChanges()[0].status).toBe('auto-applied');
  expect(store.transaction(id)).toEqual(before);
  service.applyOperation({ ...r, id: randomUUID() }, 'job', 1, '');
  expect(store.rules().filter((r) => r.active)).toHaveLength(1);
  const active = store.rules()[0];
  service.applyOperation(
    { kind: 'rule', action: 'delete', id: active.id, version: active.version },
    'job',
    2,
    '',
  );
  expect(store.rules()[0].active).toBe(0);
  expect(store.transaction(id)).toEqual(before);
  store.undo();
  expect(store.rules()[0].active).toBe(1);
  expect(service.events().at(-1)?.undoneAt).toBeTruthy();
});
test('optimization merges compatible rules without touching unfinished or finalized transactions', () => {
  const { store, service, features, make, rule } = setup(),
    a = rule();
  service.applyOperation(a, 'j', 0, '');
  const other = store.proposeRule('Same outcome', { ...a.definition, merchant: 'Second merchant' });
  store.reviewRule(other, true);
  const id = make();
  features.quick({ items: [store.transaction(id)], mode: 'personal' });
  store.review([store.transaction(id)], 'approve');
  const before = store.transaction(id),
    balance = store.dashboard().totalOutstandingCents;
  service.applyOperation({ kind: 'rule', action: 'optimize' }, 'j', 1, '');
  expect(store.rules().filter((r) => r.active)).toHaveLength(1);
  expect(store.transaction(id)).toEqual(before);
  expect(store.dashboard().totalOutstandingCents).toBe(balance);
});
test('saved user facts are quoted, separate, scoped, versioned, deduplicated and undoable', () => {
  const { store, service, person } = setup(),
    text = 'Remember that @alex is my partner.';
  const op: Extract<AssistantOperation, { kind: 'context'; action: 'save' }> = {
    kind: 'context',
    action: 'save',
    id: randomUUID(),
    version: null,
    title: 'Partner',
    text: 'Alex is my partner.',
    quote: text,
    personId: person.id,
    tripId: null,
    from: null,
    to: null,
  };
  service.applyOperation(op, 'job', 0, text);
  expect(service.contexts()).toHaveLength(1);
  expect(store.rules()).toHaveLength(0);
  service.applyOperation({ ...op, id: randomUUID() }, 'job', 1, text);
  expect(service.contexts()).toHaveLength(1);
  expect(() =>
    service.applyOperation({ ...op, id: randomUUID(), quote: 'Invented fact' }, 'job', 2, text),
  ).toThrow(/current user/);
  const current = service.contexts()[0];
  service.applyOperation(
    { kind: 'context', action: 'delete', id: current.id, version: current.version },
    'job',
    2,
    text,
  );
  expect(service.contexts()).toHaveLength(0);
  store.undo();
  expect(service.contexts()[0].version).toBeGreaterThan(current.version);
  expect(() =>
    service.applyOperation(
      { kind: 'context', action: 'delete', id: current.id, version: current.version },
      'job',
      3,
      text,
    ),
  ).toThrow(/changed/);
});
test('automatic trip setup and edits preserve assignment, states and accepted allocations', () => {
  const { store, service, features, make, trip } = setup(),
    t = trip(),
    id = make();
  service.applyOperation(t, 'job', 0, '');
  expect(features.trip(t.id).name).toBe('Yosemite');
  expect(store.transaction(id).tripId).toBeNull();
  features.assign([store.transaction(id)], t.id);
  const proposal = features.tripProposal(store.transaction(id)).proposal!;
  store.saveProposals([{ ...store.transaction(id), proposal, state: 'ready' }], 'user');
  const before = store.transaction(id);
  service.applyOperation({ ...t, version: 1, context: 'Updated trip context' }, 'job', 1, '');
  expect(store.transaction(id)).toEqual(before);
  expect(() => store.review([before], 'approve')).toThrow(/Trip changed/);
  expect(() => service.applyOperation({ ...t, version: 1 }, 'job', 2, '')).toThrow(/changed/);
});
test('proposed splits wait for explicit approval, stay atomic, and still need manual finalization', async () => {
  vi.stubEnv('AGENT_MODE', 'mock');
  const { store, service, make } = setup(),
    id = make(),
    jobId = store.enqueue('chat', { text: 'Split equally with @alex', ids: [id] });
  await executeJob(store, claimJob(store)!);
  expect(store.transaction(id).state).toBe('inbox');
  expect(store.dashboard().totalOutstandingCents).toBe(0);
  const request = service.requests().find((r) => r.jobId === jobId)!;
  expect(() => service.applyRequest(request.id, 'agent')).toThrow(/Only you/);
  service.applyRequest(request.id);
  expect(store.transaction(id).state).toBe('ready');
  expect(store.dashboard().totalOutstandingCents).toBe(0);
  expect(service.applyRequest(request.id)).toMatchObject({ alreadyApplied: true });
  store.review([store.transaction(id)], 'approve');
  expect(store.dashboard().totalOutstandingCents).toBe(5001);
  store.undo();
  expect(store.transaction(id).state).toBe('ready');
  store.undo();
  expect(store.transaction(id).state).toBe('inbox');
  expect(service.applyRequest(request.id)).toMatchObject({ alreadyApplied: true });
});
test('stale confirmation cannot partially overwrite a selected batch', async () => {
  vi.stubEnv('AGENT_MODE', 'mock');
  const { store, service, features, make } = setup(),
    a = make(),
    b = make('Second');
  store.enqueue('chat', { text: 'Personal expense', ids: [a, b] });
  await executeJob(store, claimJob(store)!);
  const r = service.requests().find((r) => r.status === 'pending')!;
  features.quick({ items: [store.transaction(b)], mode: 'personal' });
  expect(() => service.applyRequest(r.id)).toThrow(/changed/);
  expect(store.transaction(a).state).toBe('inbox');
  expect(service.requests().find((x) => x.id === r.id)?.status).toBe('pending');
});
test('trip assignments and manual expenses are confirmation-only with retry protection', () => {
  const { store, service, features, trip, make } = setup(),
    t = trip(),
    id = make();
  service.applyOperation(t, 'j', 0, '');
  const assignment = service.queue(
    'j',
    'assignment',
    { kind: 'assignment', items: [store.transaction(id)], tripId: t.id },
    'Assign to trip',
  );
  expect(store.transaction(id).tripId).toBeNull();
  service.applyRequest(assignment);
  expect(store.transaction(id).tripId).toBe(t.id);
  const expense = service.queue(
    'j',
    'expense',
    {
      kind: 'expense',
      description: 'Cash tickets',
      date: '2028-06-02',
      amountCents: 2000,
      category: 'Travel',
      note: 'Museum',
      tripId: t.id,
    },
    'Cash tickets',
  );
  const count = store.transactions().length;
  service.applyRequest(expense);
  service.applyRequest(expense);
  expect(store.transactions()).toHaveLength(count + 1);
  expect(features.trip(t.id)).toBeTruthy();
});
test('repayment cards cannot write until confirmed and preserve idempotency after Undo', () => {
  const { store, service, person } = setup();
  const id = service.queue(
    'j',
    'repayment',
    {
      kind: 'repayment',
      personId: person.id,
      date: '2028-07-01',
      amountCents: 500,
      direction: 'received',
      note: 'Cash received',
    },
    'Repayment',
  );
  expect(store.snapshot().repayments).toHaveLength(0);
  service.applyRequest(id);
  service.applyRequest(id);
  expect(store.snapshot().repayments).toHaveLength(1);
  store.undo();
  expect(store.snapshot().repayments).toHaveLength(0);
  service.applyRequest(id);
  expect(store.snapshot().repayments).toHaveLength(0);
});
test('cancelled, stale-worker and invalid scoped results cannot apply organization side effects', () => {
  const { store, service, make, rule } = setup(),
    id = make(),
    other = make('Other'),
    jobId = store.enqueue('chat', { text: 'Remember a rule', ids: [id] });
  const p = plan();
  p.organization = [rule()];
  p.updates = [
    { id: other, version: store.transaction(other).version, state: 'inbox', proposal: null },
  ];
  expect(() => applyStep(store, jobId, 0, p, 1, 100)).toThrow(/scope/);
  expect(store.rules()).toHaveLength(0);
  p.updates = [];
  store.cancelJob(jobId);
  expect(() => applyStep(store, jobId, 0, p, 1, 100)).toThrow(/cancelled/);
  expect(service.events()).toHaveLength(0);
});
test('organization plus requested transaction actions commit once or roll back together', () => {
  const { store, service, rule } = setup(),
    id = store.enqueue('chat', { text: 'Set up my workspace' }),
    p = plan();
  p.organization = [rule()];
  p.requests = [
    { kind: 'assignment', items: [{ id: 'not-in-this-workspace', version: 1 }], tripId: null },
  ];
  expect(() => applyStep(store, id, 0, p, 1, 100)).toThrow();
  expect(store.rules()).toHaveLength(0);
  expect(service.events()).toHaveLength(0);
  expect(store.job(id).cursor).toBe(0);
  p.requests = [];
  applyStep(store, id, 0, p, 1, 100);
  applyStep(store, id, 0, p, 1, 100);
  expect(store.rules()).toHaveLength(1);
  expect(service.events()).toHaveLength(1);
});
test('finalized transactions cannot be changed through any chat confirmation action', () => {
  const { store, service, features, make } = setup(),
    id = make();
  features.quick({ items: [store.transaction(id)], mode: 'personal' });
  store.review([store.transaction(id)], 'approve');
  const t = store.transaction(id),
    r = service.queue(
      'j',
      'splits',
      [{ id, version: t.version, state: 'inbox', proposal: null }],
      'Reopen',
    );
  expect(() => service.applyRequest(r)).toThrow(/Finalized/);
  expect(() =>
    service.validateExpenseAction({ kind: 'assignment', items: [t], tripId: null }),
  ).toThrow(/Finalized/);
  expect(store.transaction(id)).toEqual(t);
});
test('chat recognizes trips and user facts without a separate setup form', async () => {
  vi.stubEnv('AGENT_MODE', 'mock');
  const { store, service, features } = setup();
  const job = store.enqueue('chat', {
    text: 'We went on a trip to Yosemite from 2028-06-01 to 2028-06-03 with @alex. Split food equally.',
  });
  await executeJob(store, claimJob(store)!);
  expect(store.job(job).status).toBe('completed');
  expect(features.trips()).toHaveLength(1);
  expect(features.trips()[0].participants).toHaveLength(2);
  store.enqueue('chat', { text: 'Remember that @alex is my partner.' });
  await executeJob(store, claimJob(store)!);
  expect(service.contexts()[0].text).toContain('partner');
  expect(store.rules()).toHaveLength(0);
});
test('pending cards, automatic memory and action receipts survive restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'split-assistant-'));
  dirs.push(dir);
  const file = join(dir, 'ledger.sqlite');
  const { db, store, service, trip } = setup(file),
    t = trip();
  service.applyOperation(t, 'job', 0, '');
  const id = service.queue(
    'job',
    'expense',
    {
      kind: 'expense',
      description: 'Tickets',
      date: '2028-06-01',
      amountCents: 2000,
      category: 'Travel',
      note: '',
      tripId: t.id,
    },
    'Tickets',
  );
  db.close();
  const reopened = setup(file);
  expect(reopened.service.events()[0].targetId).toBe(t.id);
  expect(reopened.service.requests()[0].status).toBe('pending');
  reopened.service.applyRequest(id);
  expect(reopened.store.transactions().some((t) => t.description === 'Tickets')).toBe(true);
});

test('chat finalization is a separate user action and rejects stale or agent approval', async () => {
  vi.stubEnv('AGENT_MODE', 'mock');
  const { store, service, features, make } = setup(),
    id = make();
  store.enqueue('chat', { text: 'Split equally with @alex', ids: [id] });
  await executeJob(store, claimJob(store)!);
  const card = service.requests().find((r) => r.status === 'pending')!;
  service.applyRequest(card.id);
  expect(service.requests().find((r) => r.id === card.id)?.reviewState).toBe('ready');
  expect(() => service.finalizeRequest(card.id, 'agent')).toThrow(/Only you/);
  expect(store.dashboard().totalOutstandingCents).toBe(0);
  service.finalizeRequest(card.id);
  expect(store.transaction(id).state).toBe('finalized');
  expect(service.finalizeRequest(card.id)).toMatchObject({ alreadyFinalized: true });
  expect(service.requests().find((r) => r.id === card.id)?.reviewState).toBe('finalized');
  store.undo();
  expect(store.transaction(id).state).toBe('ready');
  expect(() => service.finalizeRequest(card.id)).toThrow(/changed/);
  features.quick({ items: [store.transaction(id)], mode: 'personal' });
  expect(() => service.finalizeRequest(card.id)).toThrow(/changed/);
});
test('trip edits invalidate prepared membership cards before any assignment', () => {
  const { service, trip, store, make } = setup(),
    t = trip(),
    id = make();
  service.applyOperation(t, 'j', 0, '');
  const card = service.queue(
    'j',
    'assignment',
    { kind: 'assignment', items: [store.transaction(id)], tripId: t.id },
    'Assign',
  );
  service.applyOperation({ ...t, version: 1, name: 'Changed trip' }, 'j', 1, '');
  expect(() => service.applyRequest(card)).toThrow(/Trip changed/);
  expect(store.transaction(id).tripId).toBeNull();
});
