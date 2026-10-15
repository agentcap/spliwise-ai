import { config } from '../src/lib/config';
import { controlDb } from '../src/db/control';
import { workspaceStore, workspacePrincipals, closeWorkspace } from '../src/lib/workspaces';
import { pruneWorkspace, purgeDeleted } from '../src/lib/maintenance';
const cfg = config(),
  db = controlDb();
for (const principal of workspacePrincipals()) {
  pruneWorkspace(workspaceStore(principal).db);
  closeWorkspace(principal.id);
}
if (!cfg.production) pruneWorkspace(workspaceStore().db);
const purged = cfg.production ? purgeDeleted(db) : 0;
console.log(JSON.stringify({ event: 'maintenance_complete', purged }));
db.close();
