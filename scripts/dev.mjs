import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { loadEnvFile } from 'node:process';
try {
  loadEnvFile('.env.local');
} catch {}
const production = process.argv.includes('--production');
const dbPath = resolve(process.env.DATABASE_PATH || './data/splitwise.sqlite');
const lock = dbPath + '.server.lock';
mkdirSync(dirname(dbPath), { recursive: true });
if (existsSync(lock)) {
  try {
    process.kill(Number(readFileSync(lock, 'utf8')), 0);
    console.error('Splitwise AI is already running for this database.');
    process.exit(1);
  } catch (e) {
    if (e.code !== 'ESRCH') throw e;
  }
}
writeFileSync(lock, String(process.pid));
const common = [];
const children = [
  spawn(
    process.execPath,
    [
      ...common,
      'node_modules/next/dist/bin/next',
      production ? 'start' : 'dev',
      '--hostname',
      '127.0.0.1',
      '--port',
      process.env.PORT || '3000',
    ],
    { stdio: 'inherit' },
  ),
  spawn(process.execPath, [...common, '--import', 'tsx', 'scripts/worker.ts'], {
    stdio: 'inherit',
  }),
];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  try {
    unlinkSync(lock);
  } catch {}
  setTimeout(() => process.exit(code), 500);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
for (const child of children) child.on('exit', (code) => stop(code || 0));
