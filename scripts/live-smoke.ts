import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
import { usageSummary } from '../src/lib/usage';
import { askAgent } from '../src/lib/agent';
if (!process.env.OPENAI_API_KEY) {
  console.log('SKIP: Set OPENAI_API_KEY to run the opt-in live smoke test.');
  process.exit(0);
}
const db = openDatabase(':memory:'),
  store = new Store(db);
store.addPerson('Synthetic Alex', 'synthetic_alex');
const preview = store.preview(
  'amex',
  'synthetic.csv',
  'Date,Description,Amount\n01/01/2026,SYNTHETIC CAFE,10.00',
);
const { ids } = store.confirmImport(preview.id, false);
const instruction =
  'Split the selected expense equally between @me and @synthetic_alex. This was lunch during our synthetic hiking trip.';
store.instruct(
  ids.map((id) => ({ id, version: store.transaction(id).version })),
  instruction,
);
let streamedText = false;
const result = await askAgent(store, instruction, ids, AbortSignal.timeout(90000), (event) => {
  if (event.text) streamedText = true;
});
if (!result.updates.length || result.updates[0].proposal?.splits.length !== 2)
  throw new Error('Expected a two-person split.');
if (!streamedText) throw new Error('Expected streamed reply text.');
store.saveProposals(result.updates, 'agent');
if (
  store.transaction(ids[0]).state !== 'ready' ||
  !store.transaction(ids[0]).notes.some((n) => n.text.includes('hiking trip'))
)
  throw new Error('Expected a reviewable split with preserved transaction context.');
const usage = usageSummary(store.workspaceId);
if (!usage.inputTokens || !usage.outputTokens || usage.heldMicros)
  throw new Error('Expected reported token usage with no unresolved reservation.');
console.log(
  'Live agent smoke test passed with synthetic data, streamed output and metered token usage. No financial records were saved.',
);
db.close();
