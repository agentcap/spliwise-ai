/** Explicit local-runtime smoke test; all financial state stays in an in-memory fixture. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
import { Features } from '../src/lib/features';
import { claimJob, executeJob } from '../src/lib/jobs';
import { AssistantService } from '../src/lib/assistant-service';
import { fineTunedModelStatus } from '../src/lib/finetuned-agent';

assert.equal((await fineTunedModelStatus()).available, true, 'Start npm run model:local first.');
process.env.APP_MODE = 'local';
delete process.env.AGENT_MODE;
delete process.env.OPENAI_API_KEY;
const db = openDatabase(':memory:');
try {
  const store = new Store(db);
  const person = store.addPerson('Alex', 'alex', 'Friend');
  const id = new Features(store).manual({
    description: 'CAFE lunch',
    date: '2026-10-17',
    amountCents: 1200,
    category: 'Food & Drink',
    note: '',
    tripId: null,
    requestId: randomUUID(),
  }).id;
  store.updateSettings('America/Los_Angeles', true, 'gemma-v2');
  for (const [text, ids] of [
    ['Split the selected lunch equally between @me and @alex. Category Food & Drink.', [id]],
    ['Remember that @alex is my roommate.', undefined],
    [
      'Add a cash expense: lunch costing $12.00 on 2026-10-17, category Food & Drink, no trip.',
      undefined,
    ],
  ] as const) {
    const jobId = store.enqueue('chat', { text, ids: ids ? [...ids] : undefined });
    const job = claimJob(store)!;
    assert.equal(job.id, jobId);
    await executeJob(store, job);
  }
  assert.equal(store.transaction(id).state, 'inbox');
  const service = new AssistantService(store);
  const splits = service.requests().find((r) => r.kind === 'splits');
  assert.ok(splits, 'Split confirmation card was not created.');
  assert.ok(
    service.requests().some((r) => r.kind === 'expense'),
    'Expense confirmation card was not created.',
  );
  assert.ok(
    service.contexts().some((c) => c.personId === person.id && c.text.includes('roommate')),
    'Scoped fact was not saved.',
  );
  service.applyRequest(splits.id);
  assert.equal(store.transaction(id).state, 'ready');
  assert.deepEqual(
    store
      .transaction(id)
      .proposal?.splits.map((s) => s.amountCents)
      .sort(),
    [600, 600],
  );
  console.log(
    'Fine-tuned web integration passed: scoped fact, expense card, equal split, explicit confirmation; no OpenAI key.',
  );
} finally {
  db.close();
}
