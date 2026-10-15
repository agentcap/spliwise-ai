import { rmSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Sqlite } from '../db';
import type Database from 'better-sqlite3';
import { numberSetting } from './config';
import { workspacePath, closeWorkspace } from './workspaces';
export function pruneWorkspace(db: Sqlite, now = Date.now()) {
  const cutoff = (days: number) => new Date(now - days * 86400000).toISOString();
  db.transaction(() => {
    db.prepare(
      "DELETE FROM imports WHERE status='draft' AND createdAt<? AND NOT EXISTS(SELECT 1 FROM import_rows r WHERE r.importId=imports.id)",
    ).run(cutoff(7));
    db.prepare("DELETE FROM data_transfers WHERE status='draft' AND createdAt<?").run(cutoff(7));
    db.prepare('DELETE FROM messages WHERE createdAt<?').run(
      cutoff(numberSetting('CHAT_RETENTION_DAYS', 90, 1, 3650)),
    );
    db.prepare(
      "DELETE FROM jobs WHERE status IN ('completed','failed','cancelled') AND updatedAt<?",
    ).run(cutoff(30));
  }).immediate();
}
export function purgeDeleted(control: Database.Database, now = Date.now()) {
  const rows = control
    .prepare("SELECT id FROM principals WHERE status='deleting' AND deletionAt<?")
    .all(now - 120_000) as { id: string }[];
  for (const row of rows) {
    closeWorkspace(row.id);
    const directory = dirname(workspacePath(row.id)); // UUID validation and server-owned root; never accepts a caller-supplied path.
    rmSync(directory, { recursive: true, force: true });
    control
      .transaction(() => {
        control.prepare('DELETE FROM sessions WHERE principalId=?').run(row.id);
        control
          .prepare("UPDATE ai_usage SET principalId='deleted',jobId=NULL WHERE principalId=?")
          .run(row.id);
        // Keep the identity tombstone to prevent deleted accounts being silently recreated.
        control
          .prepare("UPDATE principals SET status='deleted',name='',email=? WHERE id=?")
          .run('deleted-' + row.id + '@invalid', row.id);
      })
      .immediate();
  }
  return rows.length;
}
export function removeExpiredExports(directory: string, now = Date.now()) {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (/^[0-9a-f-]+\.sqlite$/.test(entry)) {
      const file = join(directory, entry);
      if (statSync(file).mtimeMs < now - 3600000) rmSync(file, { force: true });
    }
  }
}
