import assert from 'node:assert/strict';
import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
import { askAgent } from '../src/lib/agent';
import { applyStep } from '../src/lib/jobs';
import { AssistantService } from '../src/lib/assistant-service';
import { Features } from '../src/lib/features';
const live = process.argv.includes('--live');
process.env.APP_MODE = 'local';
process.env.CONTROL_DATABASE_PATH = './data/assistant-evaluations.control.sqlite';
if (live) {
  if (!process.env.OPENAI_API_KEY)
    throw new Error('Set OPENAI_API_KEY for the opt-in live assistant evaluation.');
  delete process.env.AGENT_MODE;
} else process.env.AGENT_MODE = 'mock';
const cases = [
  {
    name: 'automatic trip from context',
    instruction:
      'We went on a trip to Yosemite from 2028-06-01 to 2028-06-03 with @alex. Split food equally. Please set up the trip.',
    check: (s: Store) =>
      assert.ok(new Features(s).trips().some((t) => /yosemite/i.test(t.name + t.destination))),
  },
  {
    name: 'descriptive context stays separate from rules',
    instruction: 'Remember that @alex is my partner.',
    check: (s: Store) => {
      assert.ok(new AssistantService(s).contexts().some((c) => /partner/i.test(c.text)));
      assert.equal(s.rules().length, 0);
    },
  },
  {
    name: 'reusable rule activates without approval',
    instruction:
      'Always split SYNTHETIC DINNER equally with @alex. Save this as a reusable rule; do not process existing expenses.',
    check: (s: Store) =>
      assert.ok(s.rules().some((r) => r.active && r.definition.split.participants.length === 2)),
  },
];
let failures = 0;
for (const c of cases) {
  const db = openDatabase(':memory:'),
    store = new Store(db, 'assistant-evaluation');
  try {
    store.addPerson('Synthetic Alex', 'alex');
    const preview = store.preview(
      'amex',
      'synthetic.csv',
      'Date,Description,Amount\n06/02/2028,SYNTHETIC DINNER,20.00',
    );
    const { ids } = store.confirmImport(preview.id, false);
    const before = store.transactions();
    const jobId = store.enqueue('chat', { text: c.instruction });
    const result = await askAgent(
      store,
      c.instruction,
      undefined,
      AbortSignal.timeout(90000),
      undefined,
      jobId,
    );
    applyStep(store, jobId, 0, result, 1, 100);
    c.check(store);
    // No trip membership, state, amount or financial allocation changes can happen without a click.
    for (const t of store.transactions()) {
      const old = before.find((x) => x.id === t.id)!;
      assert.equal(t.state, old.state);
      assert.equal(t.tripId, old.tripId);
      assert.deepEqual(t.proposal, old.proposal);
      assert.equal(t.amountCents, old.amountCents);
    }
    assert.equal(store.dashboard().totalOutstandingCents, 0);
    console.log(
      JSON.stringify({ case: c.name, adapter: live ? 'live' : 'mock', status: 'passed' }),
    );
  } catch (error) {
    failures++;
    console.error(
      JSON.stringify({
        case: c.name,
        adapter: live ? 'live' : 'mock',
        status: 'failed',
        reason: error instanceof Error ? error.name : 'Error',
      }),
    );
  } finally {
    db.close();
  }
}
if (failures) process.exitCode = 1;
