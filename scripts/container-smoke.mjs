// Exercises the real production Compose services with synthetic data and private volumes.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  chownSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { createServer } from 'node:net';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const temporary = mkdtempSync(join(tmpdir(), 'splitwise-container-'));
const project = 'splitwise-smoke-' + randomUUID().slice(0, 8);
const tag = 'smoke-' + randomUUID().slice(0, 8);
const port = await new Promise((resolve, reject) => {
  const server = createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port;
    server.close(() => resolve(port));
  });
});
const origin = 'https://splitwise.test:' + port,
  issuer = 'https://identity.test:' + port;
const envFile = join(temporary, 'production.env'),
  backupFile = join(temporary, 'backup.env');
const overrideFile = join(temporary, 'override.yaml'),
  certFile = join(temporary, 'root.crt');
const drill = join(temporary, 'drill');
chmodSync(temporary, 0o755);
mkdirSync(drill, { mode: 0o700 });
writeFileSync(join(temporary, 'password'), randomBytes(48).toString('base64url'), { mode: 0o600 });
if (process.getuid?.() === 0) {
  chownSync(drill, 1000, 1000);
  chownSync(join(temporary, 'password'), 1000, 1000);
} else {
  assert.equal(
    process.getuid?.(),
    1000,
    'Run this test with sudo on hosts whose UID is not 1000, so private bind mounts can be owned by the container user.',
  );
}
writeFileSync(
  envFile,
  [
    'APP_MODE=production',
    'APP_URL=' + origin,
    'APP_DOMAIN=splitwise.test:' + port,
    'OIDC_ISSUER=' + issuer,
    'OIDC_CLIENT_ID=synthetic-client',
    'OIDC_CLIENT_SECRET=synthetic-secret',
    'OIDC_ALLOWED_EMAILS=alice@example.test,bob@example.test,unverified@example.test',
    'OPENAI_API_KEY=',
    'AGENT_MODE=',
    'RELEASE_TAG=' + tag,
  ].join('\n'),
  { mode: 0o600 },
);
writeFileSync(backupFile, 'RESTIC_REPOSITORY=/drill/repository\n', { mode: 0o600 });
const caddy = readFileSync(join(root, 'deploy/Caddyfile'), 'utf8').replace(
  '{$APP_DOMAIN} {',
  '{$APP_DOMAIN} {\n  tls internal',
);
writeFileSync(
  join(temporary, 'Caddyfile'),
  caddy + '\nidentity.test:' + port + ' {\n  tls internal\n  reverse_proxy identity:9000\n}\n',
);
const q = JSON.stringify;
writeFileSync(
  overrideFile,
  [
    'services:',
    '  app:',
    '    env_file: !override [' + q(envFile) + ']',
    '    environment:',
    '      NODE_EXTRA_CA_CERTS: /smoke/root.crt',
    '    volumes:',
    '      - ' + q(temporary + ':/smoke:ro'),
    '  proxy:',
    '    ports: !override [' + q('127.0.0.1:' + port + ':' + port) + ']',
    '    volumes: !override',
    '      - ' + q(join(temporary, 'Caddyfile') + ':/etc/caddy/Caddyfile:ro'),
    '      - caddy_data:/data',
    '      - caddy_config:/config',
    '    networks:',
    '      default:',
    '        aliases: [identity.test]',
    '  identity:',
    '    image: splitwise-ai:' + tag,
    '    command: [node, /fixtures/identity.mjs]',
    '    init: true',
    '    environment:',
    '      SMOKE_ISSUER: ' + issuer,
    '      SMOKE_APP_URL: ' + origin,
    '    volumes: [' + q(join(root, 'tests/container') + ':/fixtures:ro') + ']',
    '  operations:',
    '    env_file: !override [' + q(envFile) + ', ' + q(backupFile) + ']',
    '    volumes: !override',
    '      - app_data:/app/data',
    '      - ' + q(join(temporary, 'password') + ':/run/secrets/restic_password:ro'),
    '      - ' + q(drill + ':/drill'),
    '      - ' + q(join(root, 'tests/container') + ':/app/tests/container:ro'),
  ].join('\n'),
);
const args = [
  'compose',
  '-p',
  project,
  '--env-file',
  envFile,
  '-f',
  join(root, 'compose.yaml'),
  '-f',
  overrideFile,
];
const docker = (...params) =>
  execFileSync('docker', params, {
    cwd: root,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 1_200_000,
    maxBuffer: 8_000_000,
  });
const compose = (...params) => docker(...args, ...params);
const operations = (...command) =>
  compose('run', '--rm', '--no-deps', '-T', 'operations', ...command);
const stage = (text) => console.log('[container] ' + text);
let ca;
function request(path, options = {}) {
  const url = new URL(path, origin);
  assert.ok(
    [origin, issuer].includes(url.origin),
    'Synthetic test never follows external redirects.',
  );
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        hostname: '127.0.0.1',
        port,
        servername: url.hostname,
        ca,
        path: url.pathname + url.search,
        method: options.method || 'GET',
        headers: { Host: url.host, ...options.headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString(),
            json() {
              return JSON.parse(this.text);
            },
          }),
        );
      },
    );
    req.setTimeout(10_000, () => req.destroy(new Error('Container HTTP request timed out.')));
    req.on('error', reject);
    req.end(options.body);
  });
}
async function ready() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await request('/api/ready')).status === 200) return;
    } catch {}
    await delay(500);
  }
  throw new Error('App and worker did not become ready.');
}
async function login(user) {
  const start = await request('/auth/login');
  assert.equal(start.status, 303);
  const flowCookie = start.headers['set-cookie']?.find((cookie) =>
    cookie.startsWith('__Host-splitwise-login='),
  );
  assert.match(flowCookie || '', /Secure; HttpOnly; SameSite=Lax/);
  const authorization = new URL(start.headers.location);
  assert.equal(authorization.origin, issuer);
  authorization.searchParams.set('synthetic_user', user);
  const grant = await request(authorization);
  assert.equal(grant.status, 303);
  const callback = await request(grant.headers.location, {
    headers: {
      Cookie: flowCookie.split(';')[0],
      'Sec-Fetch-Site': 'cross-site',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
    },
  });
  if (user === 'unverified' || user === 'outsider') {
    assert.match(callback.headers.location, /login\?error=access/);
    return;
  }
  assert.equal(callback.headers.location, '/', callback.text);
  const session = callback.headers['set-cookie']?.find((cookie) =>
    cookie.startsWith('__Host-splitwise-session='),
  );
  assert.match(session || '', /Secure; HttpOnly; SameSite=Lax/);
  return session.split(';')[0];
}
async function json(path, cookie, body, expected = 200) {
  const response = await request('/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, expected, path + ': ' + response.text);
  return response.json();
}

try {
  stage('Building production image.');
  compose('config', '--quiet');
  if (process.env.CONTAINER_SMOKE_IMAGE)
    docker('tag', process.env.CONTAINER_SMOKE_IMAGE, 'splitwise-ai:' + tag);
  else compose('build', 'app');
  docker(
    'run',
    '--rm',
    '--entrypoint',
    'node',
    'splitwise-ai:' + tag,
    '-e',
    "const fs=require('node:fs'),a=require('node:assert/strict');a.equal(process.getuid(),1000);for(const p of ['.env.local','.env.production','.git','.tools','tests/container'])a.equal(fs.existsSync('/app/'+p),false,p);for(const p of ['data','backups'])a.equal(fs.readdirSync('/app/'+p).length,0,p);",
  );
  compose(
    'run',
    '--rm',
    '--no-deps',
    '-T',
    'proxy',
    'caddy',
    'adapt',
    '--config',
    '/etc/caddy/Caddyfile',
    '--validate',
  );
  operations('npm', 'run', 'db:migrate:all');
  compose('up', '-d', '--no-deps', 'identity', 'proxy');
  for (let attempt = 0; attempt < 40 && !existsSync(certFile); attempt++) {
    try {
      compose('cp', 'proxy:/data/caddy/pki/authorities/local/root.crt', certFile);
    } catch {}
    if (!existsSync(certFile)) await delay(250);
  }
  ca = readFileSync(certFile);
  chmodSync(certFile, 0o644);
  compose('up', '-d', 'app');
  await ready();
  compose('exec', '-T', 'app', 'node', 'scripts/healthcheck.mjs');
  compose('exec', '-T', 'app', 'node', 'scripts/healthcheck.mjs', '--unauthenticated');
  const loginPage = await request('/login');
  assert.equal(loginPage.status, 200);
  assert.equal(loginPage.headers['strict-transport-security'], 'max-age=31536000');
  const nonce = loginPage.text.match(/<script[^>]*nonce="([^"]+)"/)?.[1];
  assert.ok(
    nonce && loginPage.headers['content-security-policy']?.includes("'nonce-" + nonce + "'"),
  );
  assert.equal(
    (await request('/api/state', { headers: { Cookie: '__Host-splitwise-session=forged' } }))
      .status,
    401,
  );
  assert.equal((await request('/api/people', { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await request('/api/ops')).status, 401);
  stage('Verified TLS certificate chain, readiness, sign-in gate, CSRF and CSP.');
  const alice = await login('alice'),
    bob = await login('bob');
  await login('unverified');
  await login('outsider');
  const person = await json('people', alice, {
    name: 'Synthetic roommate',
    handle: 'roommate',
    relation: 'friend',
  });
  assert.ok(!(await json('state', bob)).people.some((p) => p.id === person.id));
  const account = await json('accounts', alice, { name: 'Synthetic Amex', format: 'amex' });
  const boundary = 'splitwise-' + randomUUID();
  const body =
    '--' +
    boundary +
    '\r\nContent-Disposition: form-data; name="accountId"\r\n\r\n' +
    account.id +
    '\r\n--' +
    boundary +
    '\r\nContent-Disposition: form-data; name="file"; filename="synthetic.csv"\r\nContent-Type: text/csv\r\n\r\n' +
    'Date,Description,Amount\n01/01/2026,SYNTHETIC LUNCH,100.00\n' +
    '\r\n--' +
    boundary +
    '--\r\n';
  const previewResponse = await request('/api/imports/preview', {
    method: 'POST',
    body,
    headers: {
      Cookie: alice,
      Origin: origin,
      'Content-Type': 'multipart/form-data; boundary=' + boundary,
    },
  });
  assert.equal(previewResponse.status, 200, previewResponse.text);
  const preview = previewResponse.json();
  assert.equal(preview.counts.new, 1);
  const imported = await json('imports/confirm', alice, {
    id: preview.id,
    acknowledgeSkips: false,
    keepRows: [],
    skipInvalid: false,
  });
  let tx = await json('transactions/' + imported.ids[0], alice);
  await json('imports/finish', alice, {
    id: preview.id,
    items: [{ id: tx.id, version: tx.version }],
    context: 'Synthetic lunch during a test trip.',
    process: false,
  });
  tx = await json('transactions/' + tx.id, alice);
  await json('transactions/proposal', alice, {
    id: tx.id,
    version: tx.version,
    category: 'Food & Drink',
    mode: 'equal',
    participants: ['self', person.id],
  });
  tx = await json('transactions/' + tx.id, alice);
  await json(
    'transactions/review',
    bob,
    { items: [{ id: tx.id, version: tx.version }], action: 'approve' },
    404,
  );
  await json('transactions/review', alice, {
    items: [{ id: tx.id, version: tx.version }],
    action: 'approve',
  });
  const repayment = {
    personId: person.id,
    date: '2026-02-01',
    amountCents: 2000,
    direction: 'received',
    note: 'Synthetic repayment.',
    requestId: randomUUID(),
  };
  const firstReceipt = await json('repayments', alice, repayment);
  assert.equal((await json('repayments', alice, repayment)).id, firstReceipt.id);
  const summary = await json('state?from=2026-01-01&to=2026-01-31', alice);
  assert.equal(summary.dashboard.filteredOutstandingCents, 3000);
  const rule = await json('rules/propose', alice, {
    title: 'Synthetic lunch rule',
    definition: {
      merchant: 'SYNTHETIC LUNCH',
      outputCategory: 'Food & Drink',
      split: { mode: 'equal', participants: ['self', person.id] },
    },
  });
  await json('rules/review', alice, { id: rule.id, approve: true });
  stage(
    'Verified signed OIDC, rejected unverified/uninvited users, separate ledgers, import, finalization, idempotent repayment and filtered balance.',
  );
  compose('restart', 'app');
  await ready();
  assert.equal(
    (await json('state?from=2026-01-01&to=2026-01-31', alice)).dashboard.filteredOutstandingCents,
    3000,
  );
  operations('restic', 'init');
  operations('npm', 'run', 'backup:all');
  operations('restic', 'check', '--read-data');
  operations('npm', 'run', 'backup:all');
  const snapshots = JSON.parse(
    operations('restic', 'snapshots', '--json', '--tag', 'splitwise-ai'),
  );
  assert.equal(snapshots.length, 2, 'Retention must keep both changing temporary snapshot paths.');
  const recoverySnapshot = snapshots[0].id;
  await json('account/delete', bob, { confirm: 'DELETE' });
  await json('state', bob, undefined, 401);
  operations('node', '--import', 'tsx', 'tests/container/verify.ts', 'deletions');
  compose('stop', 'app');
  const stopped = compose('ps', '-aq', 'app').trim();
  assert.equal(JSON.parse(docker('inspect', stopped))[0].State.ExitCode, 0);
  operations('node', '--import', 'tsx', 'tests/container/verify.ts', 'stopped');
  operations('restic', 'restore', recoverySnapshot, '--target', '/drill/recovered');
  // Resolve restic's restored absolute /tmp/.../snapshot path without trusting arbitrary paths.
  operations(
    'node',
    '-e',
    "const fs=require('node:fs'),p=require('node:path');let hits=[];function walk(d){for(const e of fs.readdirSync(d,{withFileTypes:true})){const f=p.join(d,e.name);if(e.isDirectory())walk(f);else if(e.name==='manifest.json')hits.push(d)}}walk('/drill/recovered');if(hits.length!==1)throw Error('Expected one verified snapshot');fs.cpSync(hits[0],'/drill/snapshot',{recursive:true});",
  );
  operations(
    'npm',
    'run',
    'restore:all',
    '--',
    '/drill/snapshot',
    '--confirm',
    '--deletions',
    '/drill/deletions.json',
  );
  operations('node', '--import', 'tsx', 'tests/container/verify.ts', 'restored');
  compose('up', '-d', 'app');
  await ready();
  await json('state', alice, undefined, 401);
  const newAlice = await login('alice');
  await json('state', newAlice);
  const logout = await request('/auth/logout', {
    method: 'POST',
    headers: { Cookie: newAlice, Origin: origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(logout.status, 303);
  await json('state', newAlice, undefined, 401);
  stage(
    'Verified encrypted backup/check/restore, deletion replay, session revocation, persistent Undo, restart and sign-out.',
  );
  stage('All container checks passed.');
} catch (error) {
  try {
    console.error(compose('logs', '--no-color', '--tail', '60', 'app', 'proxy', 'identity'));
  } catch {}
  throw error;
} finally {
  // Only this randomly named synthetic test project is removed.
  compose('down', '--volumes', '--remove-orphans', '--timeout', '40');
  try {
    docker('image', 'rm', 'splitwise-ai:' + tag);
  } catch {}
  rmSync(temporary, { recursive: true, force: true });
}
