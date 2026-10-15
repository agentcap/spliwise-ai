import { statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { controlDb } from '../db/control';
import { config } from './config';
export function readiness() {
  const cfg = config(),
    db = controlDb();
  db.prepare('SELECT 1').get();
  const disk = statfsSync(dirname(cfg.controlPath)),
    freeBytes = disk.bavail * disk.bsize;
  const worker = db.prepare("SELECT heartbeat FROM worker_status WHERE id='worker'").get() as
    { heartbeat: number } | undefined;
  const workerAgeMs = worker ? Date.now() - worker.heartbeat : null;
  return {
    ok: freeBytes >= cfg.minFreeBytes && workerAgeMs !== null && workerAgeMs < 30_000,
    freeBytes,
    workerAgeMs,
  };
}
