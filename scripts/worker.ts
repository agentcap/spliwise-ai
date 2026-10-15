import { randomUUID } from 'node:crypto';
import { getDb } from '../src/db';
import { controlDb } from '../src/db/control';
import { Store } from '../src/lib/store';
import { workspaceStore, workspacePrincipals, closeWorkspace } from '../src/lib/workspaces';
import { pruneWorkspace, purgeDeleted } from '../src/lib/maintenance';
import { config } from '../src/lib/config';
import { claimJob, executeJob } from '../src/lib/jobs';
import { AppError } from '../src/lib/errors';
import { log } from '../src/lib/log';
import { setTimeout as delay } from 'node:timers/promises';
const workspaceErrors = new Map<string, number>();
const cfg = config(),
  control = controlDb(),
  owner = randomUUID();
control
  .transaction(() => {
    const current = control
      .prepare("SELECT heartbeat FROM worker_status WHERE id='worker'")
      .get() as { heartbeat: number } | undefined;
    if (current && current.heartbeat > Date.now() - 30_000)
      throw new Error('A worker already owns this queue.');
    control
      .prepare(
        "INSERT INTO worker_status(id,heartbeat,owner) VALUES('worker',?,?) ON CONFLICT(id) DO UPDATE SET heartbeat=excluded.heartbeat,owner=excluded.owner",
      )
      .run(Date.now(), owner);
  })
  .immediate();
let maintenanceAt = 0;
let stopping = false,
  controller: AbortController | undefined,
  rotation = 0;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    controller?.abort();
  });
const workerHeartbeat = setInterval(() => {
  const changed = control
    .prepare("UPDATE worker_status SET heartbeat=? WHERE id='worker' AND owner=?")
    .run(Date.now(), owner).changes;
  if (!changed) {
    stopping = true;
    controller?.abort();
  }
}, 3000);
log('worker_ready');
try {
  while (!stopping) {
    const maintain = Date.now() - maintenanceAt > 60_000;
    if (maintain) {
      if (cfg.production) purgeDeleted(control);
      control.prepare('DELETE FROM sessions WHERE expiresAt<?').run(Date.now());
      control.prepare('DELETE FROM auth_flows WHERE expiresAt<?').run(Date.now());
      control.prepare('DELETE FROM rates WHERE expiresAt<?').run(Date.now());
      maintenanceAt = Date.now();
    }
    const principals = cfg.production ? workspacePrincipals() : [undefined];
    if (principals.length) rotation = (rotation + 1) % principals.length;
    const ordered = [...principals.slice(rotation), ...principals.slice(0, rotation)];
    let worked = false;
    for (const principal of ordered) {
      if (stopping) break;
      let store: Store, job: ReturnType<typeof claimJob>;
      try {
        store = principal ? workspaceStore(principal) : new Store(getDb());
        if (maintain) pruneWorkspace(store.db);
        job = claimJob(store);
      } catch {
        const key = principal?.id || 'local';
        if (Date.now() - (workspaceErrors.get(key) || 0) > 60_000) {
          log('workspace_unavailable', { code: 'DATABASE_UNAVAILABLE' });
          workspaceErrors.set(key, Date.now());
        }
        if (principal) closeWorkspace(principal.id);
        continue;
      }
      if (!job) {
        if (principal) closeWorkspace(principal.id);
        continue;
      }
      worked = true;
      controller = new AbortController();
      const activeController = controller,
        started = Date.now();
      const deadline = setTimeout(() => activeController.abort(), cfg.jobTimeoutMs);
      const heartbeat = setInterval(() => {
        const fresh = store.job(job.id);
        if (fresh.cancelRequested || fresh.leaseToken !== job.leaseToken) activeController.abort();
        if (
          !control
            .prepare("SELECT id FROM principals WHERE id=? AND status='active'")
            .get(store.workspaceId) &&
          cfg.production
        )
          activeController.abort();
        store.db
          .prepare("UPDATE jobs SET leaseUntil=? WHERE id=? AND leaseToken=? AND status='running'")
          .run(Date.now() + 30000, job.id, job.leaseToken);
      }, 1000);
      log('job_started', { jobId: job.id });
      try {
        await executeJob(store, job, activeController.signal);
        log('job_finished', { jobId: job.id, elapsedMs: Date.now() - started });
      } catch (error) {
        const cancelled = store.job(job.id).cancelRequested;
        const status = stopping ? 'queued' : cancelled ? 'cancelled' : 'failed';
        const message = cancelled
          ? 'Cancelled. Completed batches are saved; Undo can reverse them.'
          : activeController.signal.aborted
            ? 'Processing timed out or was interrupted. Review completed batches before retrying.'
            : error instanceof AppError
              ? error.message
              : 'Processing failed. Completed batches are saved. Retry or contact the operator.';
        store.db
          .prepare(
            'UPDATE jobs SET status=?,error=?,leaseUntil=0,leaseToken=NULL,updatedAt=? WHERE id=? AND leaseToken=?',
          )
          .run(status, message, new Date().toISOString(), job.id, job.leaseToken);
        log('job_failed', {
          jobId: job.id,
          code: cancelled
            ? 'CANCELLED'
            : activeController.signal.aborted
              ? 'INTERRUPTED'
              : 'JOB_FAILED',
        });
      } finally {
        clearTimeout(deadline);
        clearInterval(heartbeat);
        controller = undefined;
        if (principal) closeWorkspace(principal.id);
      }
    }
    if (!worked) await delay(750);
  }
} finally {
  clearInterval(workerHeartbeat);
  control.prepare("DELETE FROM worker_status WHERE id='worker' AND owner=?").run(owner);
  if (!cfg.production) getDb().close();
  control.close();
  log('worker_stopped');
}
