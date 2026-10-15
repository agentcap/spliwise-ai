import { getDb } from '../src/db';
import { Store } from '../src/lib/store';
import { claimJob, executeJob } from '../src/lib/jobs';
import { setTimeout as delay } from 'node:timers/promises';
const store = new Store(getDb());
let stopping = false;
let controller: AbortController | undefined;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
    controller?.abort();
  });
console.log('Splitwise AI worker ready.');
while (!stopping) {
  const job = claimJob(store);
  if (!job) {
    await delay(750);
    continue;
  }
  controller = new AbortController();
  const heartbeat = setInterval(() => {
    const fresh = store.job(job.id);
    if (fresh.cancelRequested) controller?.abort();
    store.db.prepare('UPDATE jobs SET leaseUntil=? WHERE id=?').run(Date.now() + 30000, job.id);
  }, 1000);
  try {
    await executeJob(store, job, controller.signal);
  } catch (error) {
    const cancelled = store.job(job.id).cancelRequested;
    if (stopping)
      store.db.prepare("UPDATE jobs SET status='queued',leaseUntil=0 WHERE id=?").run(job.id);
    else
      store.db
        .prepare('UPDATE jobs SET status=?,error=?,leaseUntil=0,updatedAt=? WHERE id=?')
        .run(
          cancelled ? 'cancelled' : 'failed',
          cancelled
            ? 'Cancelled. Completed batches are saved; Undo can reverse them.'
            : error instanceof Error
              ? error.message
              : 'Processing failed.',
          new Date().toISOString(),
          job.id,
        );
  } finally {
    clearInterval(heartbeat);
    controller = undefined;
  }
}
store.db.close();
