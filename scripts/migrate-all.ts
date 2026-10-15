import { existsSync } from 'node:fs';
import { openDatabase } from '../src/db';
import { openControl } from '../src/db/control';
import { config } from '../src/lib/config';
import { workspacePath } from '../src/lib/workspaces';
const cfg = config();
const lock =
  (cfg.production ? cfg.controlPath : process.env.DATABASE_PATH || './data/splitwise.sqlite') +
  '.server.lock';
if (existsSync(lock)) throw new Error('Stop the app before running production migrations.');
const control = openControl(cfg.controlPath);
const users = control.prepare("SELECT id FROM principals WHERE status='active'").all() as {
  id: string;
}[];
for (const user of users)
  if (existsSync(workspacePath(user.id))) openDatabase(workspacePath(user.id)).close();
if (!cfg.production) openDatabase().close();
control.close();
console.log('All database migrations completed.');
