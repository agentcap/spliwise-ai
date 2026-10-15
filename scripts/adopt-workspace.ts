import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '../src/lib/config';
import { controlDb } from '../src/db/control';
import { workspacePath } from '../src/lib/workspaces';
import { openDatabase } from '../src/db';
const args = process.argv.slice(2),
  email = args[args.indexOf('--email') + 1],
  source = args[args.indexOf('--source') + 1],
  cfg = config();
if (!args.includes('--confirm') || !args.includes('--email') || !args.includes('--source'))
  throw new Error(
    'Usage: npm run workspace:adopt -- --email invited@example.com --source /path/to/local.sqlite --confirm',
  );
if (existsSync(cfg.controlPath + '.server.lock') || existsSync(resolve(source) + '.server.lock'))
  throw new Error('Stop both app instances before adopting a workspace.');
const user = controlDb()
  .prepare("SELECT id FROM principals WHERE email=? AND status='active'")
  .get(email.toLowerCase()) as { id: string } | undefined;
if (!user)
  throw new Error('Sign in once with the invited account before assigning a local workspace.');
const target = workspacePath(user.id);
if (resolve(source) === resolve(target)) throw new Error('Source and destination must differ.');
if (existsSync(target)) {
  const old = new Database(target, { readonly: true, fileMustExist: true });
  try {
    if (
      (
        old
          .prepare(
            'SELECT (SELECT COUNT(*) FROM transactions)+(SELECT COUNT(*) FROM repayments)+(SELECT COUNT(*) FROM rules)+(SELECT COUNT(*) FROM people WHERE isSelf=0) n',
          )
          .get() as { n: number }
      ).n
    )
      throw new Error('Destination workspace is not empty. Export and merge through the app.');
  } finally {
    old.close();
  }
}
mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
const temp = target + '.adopt',
  db = new Database(resolve(source), { readonly: true, fileMustExist: true });
try {
  if (db.pragma('integrity_check', { simple: true }) !== 'ok')
    throw new Error('Source integrity check failed.');
  await db.backup(temp);
  const check = openDatabase(temp);
  check.close();
  for (const suffix of ['-wal', '-shm']) rmSync(target + suffix, { force: true });
  renameSync(temp, target);
  console.log('Local workspace assigned. The source database was preserved.');
} finally {
  db.close();
  rmSync(temp, { force: true });
}
