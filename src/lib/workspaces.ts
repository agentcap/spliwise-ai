import { resolve, dirname, join } from 'node:path';
import { existsSync, mkdirSync, chmodSync } from 'node:fs';
import { getDb, openDatabase, type Sqlite } from '../db';
import { controlDb, type Principal } from '../db/control';
import { config } from './config';
import { invariant } from './errors';
import { Store } from './store';

const databases = new Map<string, Sqlite>();
export function workspacePath(id: string) {
  invariant(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id),
    'Invalid workspace ID.',
  );
  return join(config().dataRoot, id, 'ledger.sqlite');
}
export function workspaceStore(principal?: Pick<Principal, 'id'>) {
  if (!config().production && !principal) return new Store(getDb());
  invariant(principal, 'Sign in to continue.', 401);
  const record = controlDb()
    .prepare("SELECT id FROM principals WHERE id=? AND status='active'")
    .get(principal.id);
  invariant(record, 'This workspace is unavailable.', 403);
  let db = databases.get(principal.id);
  if (!db) {
    // Idle workspaces are closed by the worker between jobs. Web handles are bounded by the invite allowlist.
    invariant(
      databases.size < 128,
      'Workspace capacity reached. Please contact the operator.',
      503,
    );
    const file = workspacePath(principal.id),
      directory = dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    db = openDatabase(file, { migrate: !existsSync(file) });
    chmodSync(file, 0o600);
    databases.set(principal.id, db);
  }
  return new Store(db, principal.id);
}
export function closeWorkspace(id: string) {
  databases.get(id)?.close();
  databases.delete(id);
}
export function workspaceExists(id: string) {
  return existsSync(resolve(workspacePath(id)));
}
export function workspacePrincipals(): Pick<Principal, 'id'>[] {
  return config().production
    ? (controlDb()
        .prepare("SELECT id FROM principals WHERE status='active' ORDER BY createdAt")
        .all() as Pick<Principal, 'id'>[])
    : [];
}

// Called by the web process after streams have checked identity status.
export function closeInactiveWorkspaces() {
  if (!config().production) return;
  for (const id of databases.keys()) {
    if (!controlDb().prepare("SELECT id FROM principals WHERE id=? AND status='active'").get(id))
      closeWorkspace(id);
  }
}
