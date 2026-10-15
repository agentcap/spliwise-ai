import { timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '@/lib/config';
import { checkOrigin } from '@/lib/security';
import { controlDb } from '@/db/control';
import { workspacePath } from '@/lib/workspaces';
import { readiness } from '@/lib/health';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  try {
    checkOrigin(req);
    const expected = process.env.OPS_TOKEN || '',
      received = req.headers.get('authorization')?.replace(/^Bearer /, '') || '';
    if (
      expected.length < 32 ||
      Buffer.byteLength(received) !== Buffer.byteLength(expected) ||
      !timingSafeEqual(Buffer.from(expected), Buffer.from(received))
    )
      return new Response('Unauthorized.', { status: 401 });
    const db = controlDb(),
      health = readiness(),
      counts = { queued: 0, running: 0, failed: 0 },
      cfg = config();
    let oldest = Date.now();
    for (const row of db.prepare("SELECT id FROM principals WHERE status='active'").all() as {
      id: string;
    }[]) {
      const file = workspacePath(row.id);
      if (!existsSync(file)) continue;
      const ledger = new Database(file, { readonly: true, fileMustExist: true });
      try {
        for (const r of ledger
          .prepare(
            "SELECT status,COUNT(*) count,MIN(createdAt) oldest FROM jobs WHERE status IN ('queued','running','failed') GROUP BY status",
          )
          .all() as { status: keyof typeof counts; count: number; oldest: string }[]) {
          counts[r.status] += r.count;
          if (r.status === 'queued') oldest = Math.min(oldest, Date.parse(r.oldest));
        }
      } finally {
        ledger.close();
      }
    }
    const backupFile = join(dirname(cfg.controlPath), 'operations', 'backup-success.json');
    let backupAge = -1;
    if (existsSync(backupFile))
      backupAge = (Date.now() - JSON.parse(readFileSync(backupFile, 'utf8')).at) / 1000;
    const text =
      [
        '# Splitwise AI operations. No user labels or transaction data.',
        'splitwise_ready ' + Number(health.ok),
        'splitwise_free_disk_bytes ' + health.freeBytes,
        'splitwise_worker_age_seconds ' +
          (health.workerAgeMs === null ? -1 : health.workerAgeMs / 1000),
        'splitwise_backup_age_seconds ' + backupAge,
        'splitwise_oldest_queued_seconds ' + (Date.now() - oldest) / 1000,
        ...Object.entries(counts).map(([state, n]) => 'splitwise_jobs{state="' + state + '"} ' + n),
      ].join('\n') + '\n';
    return new Response(text, {
      headers: { 'Content-Type': 'text/plain; version=0.0.4', 'Cache-Control': 'no-store' },
    });
  } catch {
    return new Response('Health check failed.', { status: 503 });
  }
}
