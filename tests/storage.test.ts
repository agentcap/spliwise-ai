import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, unlinkSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
test('consistent online backup, locked-restore refusal, restore and preservation of previous database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'splitwise-backup-')),
    file = join(dir, 'live.sqlite'),
    backup = join(dir, 'backup.sqlite');
  let db = openDatabase(file);
  const env = { ...process.env, DATABASE_PATH: file };
  try {
    new Store(db).addPerson('Before backup', 'before');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/backup.ts', backup], {
      env,
      stdio: 'pipe',
    });
    new Store(db).addPerson('After backup', 'after');
    db.close();
    writeFileSync(file + '.server.lock', 'test');
    expect(() =>
      execFileSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/restore.ts', backup, '--confirm'],
        { env, stdio: 'pipe' },
      ),
    ).toThrow();
    unlinkSync(file + '.server.lock');
    execFileSync(process.execPath, ['--import', 'tsx', 'scripts/restore.ts', backup, '--confirm'], {
      env,
      stdio: 'pipe',
    });
    db = openDatabase(file);
    expect(new Store(db).people().map((p) => p.handle)).toContain('before');
    expect(new Store(db).people().map((p) => p.handle)).not.toContain('after');
    expect(readdirSync(dir).some((f) => f.includes('before-restore'))).toBe(true);
  } finally {
    if (db.open) db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
