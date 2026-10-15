import { resolve, dirname } from 'node:path';
import { existsSync, renameSync, unlinkSync, mkdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { openDatabase } from '../src/db';
const source = process.argv[2],
  destination = resolve(process.env.DATABASE_PATH || './data/splitwise.sqlite');
if (!source || !process.argv.includes('--confirm'))
  throw new Error('Stop the app first. Usage: npm run restore -- /path/to/backup.sqlite --confirm');
if (existsSync(destination + '.server.lock'))
  throw new Error('Stop the application before restoring (server lock is present).');
if (resolve(source) === destination) throw new Error('Source and destination must differ.');
const backup = new Database(resolve(source), { readonly: true, fileMustExist: true });
if (backup.pragma('integrity_check', { simple: true }) !== 'ok')
  throw new Error('Backup failed its integrity check.');
if (!backup.prepare("SELECT name FROM sqlite_master WHERE name='transactions'").get())
  throw new Error('Not a Splitwise AI database.');
mkdirSync(dirname(destination), { recursive: true });
const temp = destination + '.restore-' + Date.now();
await backup.backup(temp);
backup.close();
const check = openDatabase(temp);
check.close();
if (existsSync(destination)) {
  const old = openDatabase(destination);
  await old.backup(destination + '.before-restore-' + Date.now());
  old.close();
}
for (const suffix of ['-wal', '-shm'])
  if (existsSync(destination + suffix)) unlinkSync(destination + suffix);
renameSync(temp, destination);
console.log('Restored. The previous database was backed up beside it.');
