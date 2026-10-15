import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { config, numberSetting } from '../src/lib/config';
import { createSnapshot, verifySnapshot } from '../src/lib/backups';
const cfg = config(),
  temporary = mkdtempSync(join(tmpdir(), 'splitwise-backup-')),
  stage = join(temporary, 'snapshot');
try {
  const summary = await createSnapshot(
    {
      controlPath: cfg.controlPath,
      workspaceRoot: cfg.dataRoot,
      localPath: cfg.production
        ? undefined
        : process.env.DATABASE_PATH || './data/splitwise.sqlite',
    },
    stage,
  );
  verifySnapshot(stage);
  if (!process.env.RESTIC_REPOSITORY || !process.env.RESTIC_PASSWORD_FILE)
    throw new Error(
      'Set RESTIC_REPOSITORY and RESTIC_PASSWORD_FILE for encrypted off-host backups.',
    );
  execFileSync(
    'restic',
    ['backup', stage, '--tag', 'splitwise-ai', '--host', 'splitwise-ai', '--quiet'],
    { stdio: 'pipe', timeout: 1_200_000 },
  );
  execFileSync(
    'restic',
    [
      'forget',
      '--tag',
      'splitwise-ai',
      '--host',
      'splitwise-ai',
      '--group-by',
      'host,tags',
      '--keep-within',
      String(numberSetting('BACKUP_RETENTION_DAYS', 30, 1, 3650)) + 'd',
      '--prune',
      '--quiet',
    ],
    { stdio: 'pipe', timeout: 1_200_000 },
  );
  const operations = join(dirname(cfg.controlPath), 'operations');
  mkdirSync(operations, { recursive: true, mode: 0o700 });
  writeFileSync(join(operations, 'backup-success.json'), JSON.stringify({ at: Date.now() }), {
    mode: 0o600,
  });
  console.log(
    JSON.stringify({
      event: 'backup_complete',
      databases: summary.databases,
      time: new Date().toISOString(),
    }),
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
