import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
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
const result = await askAgent(
  store,
  'Split the selected expense equally between @me and @synthetic_alex.',
  ids,
);
if (!result.updates.length || result.updates[0].proposal?.splits.length !== 2)
  throw new Error('Expected a two-person split.');
console.log('Live agent smoke test passed with synthetic data. No financial records were saved.');
db.close();
