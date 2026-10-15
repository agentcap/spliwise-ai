import { request as httpRequest } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
const dir = mkdtempSync(join(tmpdir(), 'splitwise-server-smoke-'));
const env = {
  ...process.env,
  NODE_ENV: 'production',
  APP_MODE: 'production',
  PORT: '3200',
  APP_HOST: '127.0.0.1',
  APP_URL: 'https://splitwise.test',
  OIDC_ISSUER: 'https://identity.test',
  OIDC_CLIENT_ID: 'synthetic-client',
  OIDC_CLIENT_SECRET: 'synthetic-secret',
  OIDC_ALLOWED_EMAILS: 'synthetic@example.test',
  OPENAI_API_KEY: '',
  AGENT_MODE: '',
  CONTROL_DATABASE_PATH: join(dir, 'control.sqlite'),
  WORKSPACE_ROOT: join(dir, 'workspaces'),
  NEXT_TELEMETRY_DISABLED: '1',
};
let child,
  output = '';
const get = (path, options = {}) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: '127.0.0.1',
        port: 3200,
        path,
        method: options.method || 'GET',
        headers: { Host: 'splitwise.test', ...options.headers },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('error', reject);
        res.on('end', () =>
          resolve(
            new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers }),
          ),
        );
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error('Request timed out.')));
    req.on('error', reject);
    req.end(options.body);
  });

try {
  execFileSync(process.execPath, ['--import', 'tsx', 'scripts/migrate-all.ts'], {
    env,
    stdio: 'pipe',
  });
  child = spawn(process.execPath, ['scripts/dev.mjs', '--production'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on('data', (chunk) => {
      output = (output + chunk).slice(-4000);
    });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('Server exited before readiness.');
    try {
      if ((await get('/api/ready')).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(150);
  }
  assert.ok(ready, 'Server and worker must become ready.');
  assert.equal((await get('/api/state')).status, 401);
  assert.equal(
    (
      await get('/api/state', {
        headers: { cookie: '__Host-splitwise-session=forged', 'x-user-id': 'self' },
      })
    ).status,
    401,
  );
  const home = await get('/');
  assert.equal(home.status, 307);
  assert.equal(home.headers.get('location'), '/login');
  const login = await get('/login'),
    html = await login.text(),
    csp = login.headers.get('content-security-policy') || '';
  assert.equal(login.status, 200);
  assert.match(html, /Sign in securely/);
  assert.ok(csp.includes("'strict-dynamic'") && !csp.includes("'unsafe-eval'"));
  const nonce = html.match(/<script[^>]*nonce="([^"]+)"/)?.[1];
  assert.ok(nonce && csp.includes("'nonce-" + nonce + "'"));
  assert.equal(login.headers.get('x-frame-options'), 'DENY');
  assert.equal(login.headers.get('strict-transport-security'), 'max-age=31536000');
  assert.equal(
    (
      await get('/api/repayments', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
    403,
  );
  assert.equal((await get('/api/ops')).status, 401);
  const failedCallback = await get('/auth/callback?code=invalid', {
    headers: {
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
  });
  assert.equal(failedCallback.status, 303);
  assert.match(failedCallback.headers.get('location'), /login\?error=signin/);
  console.log(
    'Compiled production smoke passed: sign-in gate, forged identity rejection, CSRF, CSP nonce, security headers, database and worker readiness.',
  );
} catch (error) {
  console.error(output);
  throw error;
} finally {
  if (child && child.exitCode === null) {
    const stopped = once(child, 'exit');
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 32000);
    await stopped;
    clearTimeout(timeout);
    assert.equal(
      existsSync(env.CONTROL_DATABASE_PATH + '.server.lock'),
      false,
      'Graceful shutdown must release the lock.',
    );
  }
  rmSync(dir, { recursive: true, force: true });
}
