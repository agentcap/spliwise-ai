import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, unlinkSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { loadEnvFile } from 'node:process';
try {
  loadEnvFile('.env.local');
} catch {}
const production = process.argv.includes('--production');
const appProduction =
  (process.env.APP_MODE || (production ? 'production' : 'local')) === 'production';
if (appProduction && !production) throw new Error('Use npm start for production mode.');
const dbPath = resolve(
  appProduction
    ? process.env.CONTROL_DATABASE_PATH || './data/control.sqlite'
    : process.env.DATABASE_PATH || './data/splitwise.sqlite',
);
const lock = dbPath + '.server.lock',
  owner = randomUUID();
mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
function startTime(pid) {
  try {
    return readFileSync('/proc/' + pid + '/stat', 'utf8')
      .split(') ')
      .at(-1)
      .split(' ')[19];
  } catch {
    return undefined;
  }
}
if (existsSync(lock)) {
  let active = false;
  try {
    const saved = JSON.parse(readFileSync(lock, 'utf8')),
      pid = typeof saved === 'number' ? saved : saved.pid;
    process.kill(pid, 0);
    active =
      pid !== process.pid &&
      (typeof saved === 'number'
        ? readFileSync('/proc/' + pid + '/cmdline', 'utf8').includes('scripts/dev.mjs')
        : saved.startTime === startTime(pid));
  } catch (error) {
    if (error.code === 'EPERM') throw error;
  }
  if (active) {
    console.error('Splitwise AI is already running for this database.');
    process.exit(1);
  }
  unlinkSync(lock);
}
writeFileSync(
  lock,
  JSON.stringify({ pid: process.pid, startTime: startTime(process.pid), owner }),
  { flag: 'wx', mode: 0o600 },
);
const children = [
  spawn(
    process.execPath,
    [
      'node_modules/next/dist/bin/next',
      production ? 'start' : 'dev',
      '--hostname',
      process.env.APP_HOST || '127.0.0.1',
      '--port',
      process.env.PORT || '3000',
    ],
    { stdio: 'inherit' },
  ),
  spawn(process.execPath, ['--import', 'tsx', 'scripts/worker.ts'], { stdio: 'inherit' }),
];
let closing = false;
function stop(code = 0) {
  if (closing) return;
  closing = true;
  for (const child of children) child.kill('SIGTERM');
  let finished = false;
  const timeout = setTimeout(() => {
    for (const child of children) child.kill('SIGKILL');
    finish();
  }, 30000);
  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    try {
      if (JSON.parse(readFileSync(lock, 'utf8')).owner === owner) unlinkSync(lock);
    } catch {}
    process.exit(code);
  }
  Promise.all(
    children.map((child) =>
      child.exitCode !== null || child.signalCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once('exit', resolve)),
    ),
  ).then(finish);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
for (const child of children) {
  child.on('exit', (code) => stop(code || 0));
  child.on('error', () => stop(1));
}
