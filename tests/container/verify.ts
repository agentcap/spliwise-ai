import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { openControl } from '../../src/db/control';
import { openDatabase } from '../../src/db';
import { Store } from '../../src/lib/store';
const db = openControl(process.env.CONTROL_DATABASE_PATH!, false);
const alice = db.prepare('SELECT id FROM principals WHERE email=?').get('alice@example.test') as {
  id: string;
};
assert.ok(alice);
if (process.argv[2] === 'stopped') {
  assert.equal(existsSync(process.env.CONTROL_DATABASE_PATH + '.server.lock'), false);
  assert.equal(db.prepare('SELECT * FROM worker_status').all().length, 0);
} else if (process.argv[2] === 'deletions') {
  const deletions = db
    .prepare("SELECT id,deletionAt AS at FROM principals WHERE status IN ('deleting','deleted')")
    .all();
  assert.equal(deletions.length, 1);
  writeFileSync('/drill/deletions.json', JSON.stringify(deletions), { mode: 0o600 });
} else {
  assert.equal(db.prepare('SELECT * FROM sessions').all().length, 0);
  const bob = db.prepare("SELECT id,status FROM principals WHERE subject='bob'").get() as {
    id: string;
    status: string;
  };
  assert.equal(bob.status, 'deleted');
  assert.equal(existsSync(join(process.env.WORKSPACE_ROOT!, bob.id)), false);
  const ledger = openDatabase(join(process.env.WORKSPACE_ROOT!, alice.id, 'ledger.sqlite'));
  const store = new Store(ledger);
  assert.equal(store.snapshot('2026-01-01', '2026-01-31').dashboard.filteredOutstandingCents, 3000);
  assert.equal(store.transactions().length, 1);
  assert.equal(store.transactions()[0].state, 'finalized');
  assert.equal(store.all('SELECT * FROM import_rows').length, 1);
  assert.equal(store.all('SELECT * FROM repayments').length, 1);
  assert.ok(store.rules().some((rule) => rule.active && rule.title === 'Synthetic lunch rule'));
  assert.ok(store.undo().length > 0, 'Undo survives restic recovery.');
  ledger.close();
}
db.close();
console.log('Container recovery safeguards passed.');
