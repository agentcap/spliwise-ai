import { randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync, chmodSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import type { Store } from './store';
import { config } from './config';
import { removeExpiredExports } from './maintenance';
export async function exportWorkspace(store: Store) {
  const directory = join(config().dataRoot, '.exports');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  removeExpiredExports(directory);
  const file = join(directory, randomUUID() + '.sqlite');
  try {
    await store.db.backup(file);
    chmodSync(file, 0o600);
  } catch (error) {
    rmSync(file, { force: true });
    throw error;
  }
  const stream = createReadStream(file);
  stream.once('close', () => rmSync(file, { force: true }));
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      'Content-Type': 'application/vnd.sqlite3',
      'Content-Disposition': 'attachment; filename="splitwise-ai-workspace.sqlite"',
      'Cache-Control': 'no-store',
    },
  });
}
