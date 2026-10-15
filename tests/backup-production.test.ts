import { test, expect } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { openControl } from '../src/db/control';
import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
import { createSnapshot, verifySnapshot } from '../src/lib/backups';
test('full backup restore verifies each database, revokes sessions and reapplies newer deletion requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'splitwise-full-backup-')),
    controlPath = join(dir, 'control.sqlite'),
    root = join(dir, 'workspaces'),
    backup = join(dir, 'backup'),
    alice = randomUUID(),
    bob = randomUUID(),
    target = join(dir, 'restore');
  const control = openControl(controlPath);
  try {
    for (const [id, email] of [
      [alice, 'alice@test.invalid'],
      [bob, 'bob@test.invalid'],
    ]) {
      control
        .prepare(
          'INSERT INTO principals(id,issuer,subject,email,name,createdAt) VALUES(?,?,?,?,?,?)',
        )
        .run(id, 'https://identity.test', id, email, 'Synthetic', new Date().toISOString());
      const db = openDatabase(join(root, id, 'ledger.sqlite')),
        store = new Store(db);
      const person = store.addPerson('Private ' + id.slice(0, 4), 'private_person');
      const preview = store.preview(
        'amex',
        'synthetic.csv',
        'Date,Description,Amount\n01/01/2026,SYNTHETIC TRIP,100.00',
      );
      const txId = store.confirmImport(preview.id, false).ids[0];
      store.saveProposals(
        [
          {
            id: txId,
            version: 1,
            state: 'ready',
            context: 'Synthetic trip lunch.',
            proposal: {
              splits: [
                { personId: 'self', amountCents: 5000 },
                { personId: person.id, amountCents: 5000 },
              ],
              category: 'Food & Drink',
              confidence: 'high',
              source: 'manual',
              explanation: 'Synthetic allocation.',
            },
          },
        ],
        'user',
      );
      store.review([{ id: txId, version: store.transaction(txId).version }], 'approve');
      store.addRepayment(person.id, '2026-02-01', 2000, 'received', 'Synthetic partial repayment');
      const rule = store.proposeRule('Synthetic rule', {
        merchant: 'SYNTHETIC',
        outputCategory: 'Food & Drink',
        split: { mode: 'personal', participants: ['self'] },
      });
      store.reviewRule(rule, true);
      db.close();
    }
    control
      .prepare('INSERT INTO sessions(hash,principalId,expiresAt,createdAt) VALUES(?,?,?,?)')
      .run('synthetic-hash', alice, Date.now() + 60000, Date.now());
    await createSnapshot({ controlPath, workspaceRoot: root }, backup);
    expect(verifySnapshot(backup).files).toHaveLength(3);
    const deletions = join(dir, 'latest-deletions.json');
    writeFileSync(deletions, JSON.stringify([{ id: bob, at: Date.now() }]));
    const env = {
      ...process.env,
      APP_MODE: 'production',
      APP_URL: 'https://splitwise.test',
      OIDC_ISSUER: 'https://identity.test',
      OIDC_CLIENT_ID: 'synthetic',
      OIDC_CLIENT_SECRET: 'synthetic',
      OIDC_ALLOWED_EMAILS: 'alice@test.invalid,bob@test.invalid',
      OPENAI_API_KEY: '',
      AGENT_MODE: '',
      CONTROL_DATABASE_PATH: join(target, 'control.sqlite'),
      WORKSPACE_ROOT: join(target, 'workspaces'),
    };
    execFileSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/restore-all.ts', backup, '--confirm', '--deletions', deletions],
      { env, stdio: 'pipe' },
    );
    const restored = openControl(env.CONTROL_DATABASE_PATH);
    expect(restored.prepare('SELECT * FROM sessions').all()).toHaveLength(0);
    expect(
      (restored.prepare('SELECT status FROM principals WHERE id=?').get(bob) as { status: string })
        .status,
    ).toBe('deleted');
    restored.close();
    expect(readdirSync(env.WORKSPACE_ROOT)).toEqual([alice]);
    const restoredLedger = openDatabase(join(env.WORKSPACE_ROOT, alice, 'ledger.sqlite'));
    expect(new Store(restoredLedger).people().some((p) => p.handle === 'private_person')).toBe(
      true,
    );
    const restoredStore = new Store(restoredLedger);
    expect(
      restoredStore.snapshot('2026-01-01', '2026-01-31').dashboard.filteredOutstandingCents,
    ).toBe(3000);
    expect(restoredStore.transactions()[0].state).toBe('finalized');
    expect(restoredStore.transactions()[0].notes[0].text).toBe('Synthetic trip lunch.');
    expect(restoredStore.all('SELECT * FROM import_rows')).toHaveLength(1);
    expect(restoredStore.rules().some((r) => r.active && r.title === 'Synthetic rule')).toBe(true);
    expect(restoredStore.undo()).toContain('Activate');
    expect(restoredStore.rules().some((r) => r.active)).toBe(false);
    restoredLedger.close();
  } finally {
    control.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test('backup verification rejects changed bytes, duplicate entries, traversal and symlinks before restore writes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'splitwise-backup-validation-')),
    controlPath = join(dir, 'control.sqlite'),
    backup = join(dir, 'backup');
  openControl(controlPath).close();
  try {
    await createSnapshot({ controlPath, workspaceRoot: join(dir, 'workspaces') }, backup);
    const manifestPath = join(backup, 'manifest.json'),
      original = readFileSync(manifestPath, 'utf8'),
      manifest = JSON.parse(original);
    manifest.files.push(manifest.files[0]);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifySnapshot(backup)).toThrow(/Duplicate/);
    manifest.files[0].name = '../control.sqlite';
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(() => verifySnapshot(backup)).toThrow();
    writeFileSync(manifestPath, original);
    unlinkSync(join(backup, 'control.sqlite'));
    symlinkSync(controlPath, join(backup, 'control.sqlite'));
    expect(() => verifySnapshot(backup)).toThrow(/Unsafe/);
    unlinkSync(join(backup, 'control.sqlite'));
    writeFileSync(join(backup, 'control.sqlite'), 'tampered');
    expect(() => verifySnapshot(backup)).toThrow(/checksum/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
