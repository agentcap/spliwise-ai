import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import * as schema from './schema';
export type Sqlite = Database.Database;
export function openDatabase(
  file = process.env.DATABASE_PATH || './data/splitwise.sqlite',
  options: { migrate?: boolean } = {},
): Sqlite {
  if (file !== ':memory:')
    mkdirSync(dirname(resolve(/*turbopackIgnore: true*/ file)), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  if (options.migrate !== false) {
    migrate(drizzle(sqlite, { schema }), { migrationsFolder: resolve('drizzle') });
    seed(sqlite);
  } else {
    const journal = JSON.parse(readFileSync(resolve('drizzle/meta/_journal.json'), 'utf8')) as {
      entries: { when: number }[];
    };
    const expected = journal.entries.at(-1)!.when;
    const latest = sqlite
      .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
      .get() as { created_at: number } | undefined;
    if (latest?.created_at !== expected) {
      sqlite.close();
      throw new Error('Database migrations are required before startup.');
    }
  }
  if (file !== ':memory:') chmodSync(file, 0o600);
  return sqlite;
}
function seed(db: Sqlite) {
  db.transaction(() => {
    db.prepare(
      'INSERT OR IGNORE INTO people(id,name,handle,relation,isSelf) VALUES (?,?,?,?,?)',
    ).run('self', 'Me', 'me', 'You', 1);
    const account = db.prepare('INSERT OR IGNORE INTO accounts(id,name,format) VALUES (?,?,?)');
    account.run('sapphire', 'Chase Sapphire', 'chase');
    account.run('amex', 'American Express', 'amex');
    account.run('prime', 'Chase Prime', 'chase');
    const category = db.prepare('INSERT OR IGNORE INTO categories(id,name) VALUES (?,?)');
    for (const name of [
      'Food & Drink',
      'Groceries',
      'Automotive',
      'Bills & Utilities',
      'Entertainment',
      'Fees & Adjustments',
      'Gas',
      'Health & Wellness',
      'Personal',
      'Professional Services',
      'Shopping',
      'Travel',
      'Uncategorized',
    ])
      category.run(name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name);
  })();
}
let singleton: Sqlite | undefined;
export function getDb(): Sqlite {
  return (singleton ??= openDatabase());
}
