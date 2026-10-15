import { existsSync, copyFileSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { config } from '../src/lib/config';
import { verifySnapshot } from '../src/lib/backups';
import { openDatabase } from '../src/db';
import { openControl } from '../src/db/control';
import { workspacePath } from '../src/lib/workspaces';
const cfg = config(),
  source = process.argv[2],
  deletionArg = process.argv.indexOf('--deletions');
if (!source || !process.argv.includes('--confirm'))
  throw new Error(
    'Stop the app. Usage: npm run restore:all -- /restored/snapshot --confirm --deletions /latest/deletions.json',
  );
if (
  existsSync(
    (cfg.production ? cfg.controlPath : process.env.DATABASE_PATH || './data/splitwise.sqlite') +
      '.server.lock',
  )
)
  throw new Error('Stop the application before restoring.');
if (cfg.production && deletionArg === -1)
  throw new Error(
    'Production restore requires the latest deletion ledger, including an empty [] when none exist.',
  );
const manifest = verifySnapshot(source),
  deletions = [...manifest.deletions];
if (cfg.production && manifest.files.some((f) => f.name === 'local.sqlite'))
  throw new Error(
    'Use workspace:adopt to assign a local database to a verified production identity.',
  );
if (deletionArg !== -1)
  deletions.push(
    ...z
      .array(
        z.object({
          id: z
            .string()
            .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
          at: z.number().int(),
        }),
      )
      .parse(JSON.parse(readFileSync(process.argv[deletionArg + 1], 'utf8'))),
  );
const deleted = new Set(deletions.map((d) => d.id)),
  stamp = Date.now(),
  prepared: { temp: string; target: string }[] = [];
try {
  for (const entry of manifest.files) {
    const id = entry.name.replace('.sqlite', '');
    if (deleted.has(id)) continue;
    const target =
      entry.name === 'control.sqlite'
        ? cfg.controlPath
        : entry.name === 'local.sqlite'
          ? resolve(process.env.DATABASE_PATH || './data/splitwise.sqlite')
          : workspacePath(id);
    if (resolve(join(source, entry.name)) === target)
      throw new Error('Source and destination must differ.');
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    const temp = target + '.restore-' + stamp;
    copyFileSync(join(source, entry.name), temp);
    prepared.push({ temp, target });
    if (entry.name === 'control.sqlite') {
      const db = openControl(temp);
      db.transaction(() => {
        db.prepare('DELETE FROM sessions').run();
        db.prepare('DELETE FROM auth_flows').run();
        db.prepare('DELETE FROM worker_status').run();
        for (const item of deletions)
          db.prepare(
            "UPDATE principals SET status='deleted',deletionAt=?,email=?,name='' WHERE id=?",
          ).run(item.at, 'deleted-' + item.id + '@invalid', item.id);
      }).immediate();
      db.close();
    } else {
      const db = openDatabase(temp);
      db.prepare(
        "UPDATE jobs SET status='queued',leaseUntil=0,leaseToken=NULL WHERE status='running'",
      ).run();
      db.close();
    }
  }
  // Every database is verified and migrated before the first live file is replaced.
  for (const item of prepared) {
    if (existsSync(item.target)) {
      const old = new Database(item.target, { readonly: true, fileMustExist: true });
      await old.backup(item.target + '.before-restore-' + stamp);
      old.close();
    }
    for (const suffix of ['-wal', '-shm']) rmSync(item.target + suffix, { force: true });
    renameSync(item.temp, item.target);
  }
  for (const id of deleted) rmSync(dirname(workspacePath(id)), { recursive: true, force: true });
  console.log(
    'Restore completed. Sessions were revoked. Previous databases remain beside the restored files.',
  );
} finally {
  for (const item of prepared) rmSync(item.temp, { force: true });
}
