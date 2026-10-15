import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  chmodSync,
  readFileSync,
  writeFileSync,
  realpathSync,
  lstatSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { invariant } from './errors';
const idPattern = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const filePattern = new RegExp('^(control\\.sqlite|local\\.sqlite|' + idPattern + '\\.sqlite)$');
const manifestSchema = z.object({
  format: z.literal('splitwise-ai-backup'),
  version: z.literal(1),
  createdAt: z.string(),
  files: z
    .array(
      z.object({ name: z.string().regex(filePattern), hash: z.string().regex(/^[0-9a-f]{64}$/) }),
    )
    .min(1)
    .max(10000),
  deletions: z
    .array(
      z.object({ id: z.string().regex(new RegExp('^' + idPattern + '$')), at: z.number().int() }),
    )
    .max(100000),
});
const checksum = (file: string) => {
  const hash = createHash('sha256'),
    fd = openSync(file, 'r'),
    buffer = Buffer.alloc(65536);
  try {
    let count = 0;
    while ((count = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      hash.update(buffer.subarray(0, count));
    return hash.digest('hex');
  } finally {
    closeSync(fd);
  }
};
function checkDatabase(file: string, control = false) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    invariant(
      db.pragma('integrity_check', { simple: true }) === 'ok',
      'Backup integrity check failed.',
    );
    invariant(
      (db.pragma('foreign_key_check') as unknown[]).length === 0,
      'Backup foreign key check failed.',
    );
    invariant(
      db
        .prepare('SELECT name FROM sqlite_master WHERE name=?')
        .get(control ? 'principals' : 'transactions'),
      'Unexpected backup database.',
    );
  } finally {
    db.close();
  }
}
export async function createSnapshot(
  options: { controlPath: string; workspaceRoot: string; localPath?: string },
  target: string,
) {
  invariant(!existsSync(target), 'Backup destination already exists.');
  mkdirSync(target, { recursive: true, mode: 0o700 });
  chmodSync(target, 0o700);
  const files: { name: string; hash: string }[] = [];
  async function snapshot(file: string, name: string) {
    const db = new Database(file, { readonly: true, fileMustExist: true });
    try {
      await db.backup(join(target, name));
    } finally {
      db.close();
    }
    chmodSync(join(target, name), 0o600);
    checkDatabase(join(target, name), name === 'control.sqlite');
    files.push({ name, hash: checksum(join(target, name)) });
  }
  await snapshot(options.controlPath, 'control.sqlite');
  const control = new Database(join(target, 'control.sqlite'), {
    readonly: true,
    fileMustExist: true,
  });
  const users = control.prepare("SELECT id FROM principals WHERE status='active'").all() as {
    id: string;
  }[];
  const deletions = control
    .prepare("SELECT id,deletionAt AS at FROM principals WHERE status IN ('deleting','deleted')")
    .all() as { id: string; at: number }[];
  control.close();
  for (const user of users) {
    invariant(new RegExp('^' + idPattern + '$').test(user.id), 'Invalid workspace identifier.');
    const source = join(options.workspaceRoot, user.id, 'ledger.sqlite');
    if (existsSync(source)) await snapshot(source, user.id + '.sqlite');
  }
  if (options.localPath && existsSync(options.localPath))
    await snapshot(options.localPath, 'local.sqlite');
  writeFileSync(
    join(target, 'manifest.json'),
    JSON.stringify(
      {
        format: 'splitwise-ai-backup',
        version: 1,
        createdAt: new Date().toISOString(),
        files,
        deletions,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return { databases: files.length };
}
export function verifySnapshot(directory: string) {
  const root = realpathSync(directory),
    manifestFile = join(root, 'manifest.json');
  invariant(
    lstatSync(manifestFile).isFile() && !lstatSync(manifestFile).isSymbolicLink(),
    'Invalid backup manifest.',
  );
  invariant(lstatSync(manifestFile).size <= 5_000_000, 'Backup manifest is too large.');
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestFile, 'utf8')));
  invariant(
    new Set(manifest.files.map((f) => f.name)).size === manifest.files.length,
    'Duplicate backup entry.',
  );
  invariant(
    manifest.files.some((f) => f.name === 'control.sqlite'),
    'Control database is missing.',
  );
  for (const file of manifest.files) {
    const path = join(root, file.name),
      real = realpathSync(path);
    invariant(
      real.startsWith(root + sep) && !lstatSync(path).isSymbolicLink() && lstatSync(path).isFile(),
      'Unsafe backup entry.',
    );
    invariant(checksum(real) === file.hash, 'Backup checksum does not match.');
    checkDatabase(real, file.name === 'control.sqlite');
  }
  return manifest;
}
