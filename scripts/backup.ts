import { resolve, dirname } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { openDatabase } from '../src/db';
const target = resolve(
  process.argv[2] ||
    './backups/splitwise-' + new Date().toISOString().replace(/[:.]/g, '-') + '.sqlite',
);
if (existsSync(target)) throw new Error('Backup destination already exists.');
mkdirSync(dirname(target), { recursive: true });
const db = openDatabase();
await db.backup(target);
db.close();
console.log('Consistent backup saved: ' + target);
