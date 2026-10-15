import { AssistantService } from '../src/lib/assistant-service';
function confirmPrepared(store: Store) {
  for (const r of new AssistantService(store).requests().filter((r) => r.status === 'pending'))
    new AssistantService(store).applyRequest(r.id);
}
import { beforeAll, afterAll, beforeEach, afterEach, test, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import * as oidc from 'openid-client';
import { openControl, controlDb } from '../src/db/control';
import { config } from '../src/lib/config';
import {
  provisionIdentity,
  createSession,
  findSession,
  revokeSession,
  startLogin,
  completeLogin,
  SESSION_COOKIE,
} from '../src/lib/auth';
import { workspaceStore, workspacePath, closeWorkspace } from '../src/lib/workspaces';
import { boundedBody, boundedForm, checkOrigin, rateLimit } from '../src/lib/security';
import { GET, POST } from '../src/app/api/[...path]/route';
import { claimJob, applyStep, executeJob } from '../src/lib/jobs';
import { pruneWorkspace, purgeDeleted } from '../src/lib/maintenance';
import { reserveUsage, settleUsage, usageSummary, meteredModel } from '../src/lib/usage';
import { Usage, type Model, type ModelResponse } from '@openai/agents';
import { Store } from '../src/lib/store';
import { openDatabase } from '../src/db';
const directory = mkdtempSync(join(tmpdir(), 'splitwise-production-'));
const users = new Set<string>();
beforeAll(() => {
  vi.stubEnv('APP_MODE', 'production');
  vi.stubEnv('APP_URL', 'https://splitwise.test');
  vi.stubEnv('OIDC_ISSUER', 'https://identity.test');
  vi.stubEnv('OIDC_CLIENT_ID', 'test-client');
  vi.stubEnv('OIDC_CLIENT_SECRET', 'synthetic-secret');
  vi.stubEnv('OIDC_ALLOWED_EMAILS', 'alice@example.test,bob@example.test,oidc@example.test');
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('AGENT_MODE', '');
  vi.stubEnv('CONTROL_DATABASE_PATH', join(directory, 'control.sqlite'));
  vi.stubEnv('WORKSPACE_ROOT', join(directory, 'workspaces'));
  openControl(config().controlPath).close();
});
beforeEach(() => {
  vi.stubEnv('AI_MONTHLY_USER_USD', '1');
  vi.stubEnv('AI_MONTHLY_GLOBAL_USD', '10');
});
afterEach(() => {
  for (const id of users) closeWorkspace(id);
});
afterAll(() => {
  controlDb().close();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});
function person(email = 'alice@example.test') {
  const user = provisionIdentity({
    sub: email,
    email,
    email_verified: true,
    name: 'Synthetic user',
  });
  users.add(user.id);
  return user;
}
function request(path: string, token?: string, body?: unknown, origin = 'https://splitwise.test') {
  return new Request('https://splitwise.test/api/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      host: 'splitwise.test',
      origin,
      ...(token ? { cookie: SESSION_COOKIE + '=' + token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function call(path: string, token?: string, body?: unknown) {
  return (body === undefined ? GET : POST)(request(path, token, body), {
    params: Promise.resolve({ path: path.split('?')[0].split('/') }),
  });
}
function imported(store: Store, label = 'SYNTHETIC CAFE') {
  const preview = store.preview(
    'amex',
    'synthetic.csv',
    'Date,Description,Amount\n01/01/2026,' + label + ',10.00',
  );
  return { preview, id: store.confirmImport(preview.id, false).ids[0] };
}
test('production fails closed without identity configuration and rejects public local mode', () => {
  vi.stubEnv('OIDC_CLIENT_SECRET', '');
  expect(() => config()).toThrow(/requires/);
  vi.stubEnv('OIDC_CLIENT_SECRET', 'synthetic-secret');
  expect(() => checkOrigin(request('state', undefined, undefined, 'https://evil.test'))).toThrow(
    /another website/,
  );
  expect(() =>
    checkOrigin(
      new Request('https://splitwise.test/api/state', { headers: { host: 'evil.test' } }),
    ),
  ).toThrow(/host/);
  vi.stubEnv('APP_MODE', 'local');
  expect(() =>
    checkOrigin(new Request('http://public.test/api/state', { headers: { host: 'public.test' } })),
  ).toThrow(/Local/);
  vi.stubEnv('APP_MODE', 'production');
});
test('verified invitations, hashed sessions, expiration, revocation and identity binding', () => {
  expect(() =>
    provisionIdentity({ sub: 'x', email: 'alice@example.test', email_verified: false }),
  ).toThrow(/verified/);
  expect(() =>
    provisionIdentity({ sub: 'x', email: 'unknown@example.test', email_verified: true }),
  ).toThrow(/invited/);
  const user = person(),
    token = createSession(user.id);
  expect(findSession(token)?.id).toBe(user.id);
  expect(controlDb().prepare('SELECT hash FROM sessions WHERE hash=?').get(token)).toBeUndefined();
  expect(findSession(token, controlDb(), Date.now() + 169 * 3600000)).toBeUndefined();
  expect(() =>
    provisionIdentity({ sub: 'changed-subject', email: user.email, email_verified: true }),
  ).toThrow(/another identity/);
  revokeSession(token);
  expect(findSession(token)).toBeUndefined();
});
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function oidcConfiguration(nonce: () => string, overrides: Record<string, unknown> = {}) {
  const configuration = new oidc.Configuration(
    {
      issuer: 'https://identity.test',
      authorization_endpoint: 'https://identity.test/authorize',
      token_endpoint: 'https://identity.test/token',
      jwks_uri: 'https://identity.test/jwks',
      id_token_signing_alg_values_supported: ['RS256'],
    },
    'test-client',
    'synthetic-secret',
  );
  configuration[oidc.customFetch] = async (url, options) => {
    if (String(url).endsWith('/jwks'))
      return Response.json({
        keys: [
          { ...publicKey.export({ format: 'jwk' }), kid: 'test-key', use: 'sig', alg: 'RS256' },
        ],
      });
    expect(String(url)).toBe('https://identity.test/token');
    expect(new URLSearchParams(String(options?.body)).get('code_verifier')).toBeTruthy();
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'https://identity.test',
        aud: 'test-client',
        sub: 'oidc-user',
        email: 'oidc@example.test',
        email_verified: true,
        iat: now,
        exp: now + 120,
        nonce: nonce(),
        ...overrides,
      }),
    ).toString('base64url');
    const content = header + '.' + payload,
      signature = sign('RSA-SHA256', Buffer.from(content), privateKey).toString('base64url');
    return Response.json({
      access_token: 'synthetic-access',
      token_type: 'Bearer',
      expires_in: 120,
      id_token: content + '.' + signature,
    });
  };
  return configuration;
}
test('real OIDC library validates PKCE, signed identity, state and nonce; flow is single use', async () => {
  let nonce = '';
  const client = oidcConfiguration(() => nonce),
    db = controlDb(),
    flow = await startLogin(db, client);
  const row = db.prepare('SELECT nonce FROM auth_flows ORDER BY expiresAt DESC LIMIT 1').get() as {
    nonce: string;
  };
  nonce = row.nonce;
  expect(flow.url.searchParams.get('code_challenge_method')).toBe('S256');
  expect(flow.url.searchParams.get('code_challenge')).toBeTruthy();
  const callback = new URL(
    'https://splitwise.test/auth/callback?code=synthetic&state=' +
      flow.url.searchParams.get('state'),
  );
  const token = await completeLogin(callback, flow.flow, db, client);
  const user = findSession(token);
  expect(user?.email).toBe('oidc@example.test');
  users.add(user!.id);
  await expect(completeLogin(callback, flow.flow, db, client)).rejects.toThrow(/expired/);
});
test.each(['state', 'nonce', 'expiry'])('OIDC rejects an invalid %s', async (kind) => {
  const db = controlDb();
  let nonce = '';
  const client = oidcConfiguration(
    () => (kind === 'nonce' ? 'wrong' : nonce),
    kind === 'expiry' ? { exp: 1, iat: 0 } : {},
  );
  const flow = await startLogin(db, client);
  nonce = (
    db.prepare('SELECT nonce FROM auth_flows ORDER BY expiresAt DESC LIMIT 1').get() as {
      nonce: string;
    }
  ).nonce;
  const callback = new URL(
    'https://splitwise.test/auth/callback?code=synthetic&state=' +
      (kind === 'state' ? 'wrong' : flow.url.searchParams.get('state')),
  );
  await expect(completeLogin(callback, flow.flow, db, client)).rejects.toThrow();
});
test('every financial interface is isolated from another authenticated workspace', async () => {
  const alice = person(),
    bob = person('bob@example.test'),
    a = workspaceStore(alice),
    b = workspaceStore(bob);
  a.updateSettings('UTC', true);
  b.updateSettings('UTC', true);
  const { preview, id } = imported(a),
    token = createSession(bob.id),
    personId = a.addPerson('Only Alice', 'only_alice').id;
  const ruleId = a.proposeRule('Private rule', {
    merchant: 'SYNTHETIC',
    outputCategory: 'Food & Drink',
    split: { mode: 'personal', participants: ['self'] },
  });
  a.reviewRule(ruleId, true);
  const approved = a.rules().find((r) => r.title === 'Private rule')!;
  const job = a.enqueue('process', { ids: [id] });
  expect((await call('state')).status).toBe(401);
  for (const path of [
    'transactions/' + id,
    'imports/' + preview.id,
    'jobs/' + job + '/events',
    'balances/' + personId,
  ])
    expect((await call(path, token)).status).toBe(404);
  expect(
    (await call('transactions/review', token, { items: [{ id, version: 1 }], action: 'approve' }))
      .status,
  ).toBe(404);
  expect(
    (await call('rules/delete', token, { id: approved.id, version: approved.version })).status,
  ).toBe(409);
  expect(
    (
      await call('repayments', token, {
        personId,
        date: '2026-01-01',
        amountCents: 500,
        direction: 'received',
        note: '',
        requestId: randomUUID(),
      })
    ).status,
  ).toBe(400);
  const state = await (await call('state', token)).json();
  expect(state.transactions).toEqual([]);
  expect(state.rules).toEqual([]);
  expect(state.imports).toEqual([]);
  expect(state.messages).toEqual([]);
  const exported = await (await call('transfer/export?kind=transactions', token)).json();
  expect(exported.transactions).toEqual([]);
  expect(() => workspacePath('../escape')).toThrow(/identifier|ID/);
  expect(a.transaction(id).state).toBe('inbox');
  expect(b.transactions()).toEqual([]);
});
test('actual streamed bytes are limited before multipart or JSON parsing', async () => {
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(600));
      c.enqueue(new Uint8Array(600));
      c.close();
    },
  });
  const req = new Request('https://splitwise.test', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit);
  await expect(boundedBody(req, 1000)).rejects.toMatchObject({ status: 413 });
  const large = new Request('https://splitwise.test', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': '11000000' },
    body: 'x',
  });
  await expect(boundedForm(large)).rejects.toMatchObject({ status: 413 });
});
test('persistent rate limits isolate identities and reject excess requests', () => {
  const db = openControl(':memory:');
  try {
    rateLimit(db, 'alice', 'writes', 1, 60000, 1000);
    expect(() => rateLimit(db, 'alice', 'writes', 1, 60000, 1000)).toThrow(/Too many/);
    expect(() => rateLimit(db, 'bob', 'writes', 1, 60000, 1000)).not.toThrow();
    expect(() => rateLimit(db, 'alice', 'writes', 1, 60000, 61001)).not.toThrow();
  } finally {
    db.close();
  }
});
test('repayment receipt survives reopening the database and cannot be reused with different content or undo resurrection', () => {
  const file = join(directory, 'repayment.sqlite');
  let db = openDatabase(file),
    store = new Store(db);
  const id = store.addPerson('Repayment person', 'repayer').id,
    key = randomUUID();
  const receipt = store.addRepayment(id, '2026-01-01', 500, 'received', 'synthetic', 'user', key);
  db.close();
  db = openDatabase(file);
  store = new Store(db);
  expect(store.addRepayment(id, '2026-01-01', 500, 'received', 'synthetic', 'user', key)).toBe(
    receipt,
  );
  expect(store.all('SELECT * FROM repayments')).toHaveLength(1);
  expect(() =>
    store.addRepayment(id, '2026-01-01', 600, 'received', 'synthetic', 'user', key),
  ).toThrow(/different repayment/);
  store.undo();
  store.addRepayment(id, '2026-01-01', 500, 'received', 'synthetic', 'user', key);
  expect(store.all('SELECT * FROM repayments')).toHaveLength(0);
  db.close();
});
test('stale workers are fenced and repeated crashes reach a recovery limit', () => {
  const store = workspaceStore(person('bob@example.test'));
  store.updateSettings('UTC', true);
  const id = store.enqueue('process', { ids: [] }),
    first = claimJob(store)!;
  // Ignore earlier pending test jobs so this test claims its own queue.
  if (first.id !== id) {
    store.db.prepare("UPDATE jobs SET status='completed' WHERE id<>?").run(id);
  }
  const job = first.id === id ? first : claimJob(store)!;
  store.db.prepare('UPDATE jobs SET leaseUntil=0 WHERE id=?').run(id);
  const replacement = claimJob(store)!;
  expect(replacement.leaseToken).not.toBe(job.leaseToken);
  expect(() =>
    applyStep(store, id, 0, { message: 'late', updates: [], rules: [] }, 1, 100, job.leaseToken),
  ).toThrow(/lease/);
  store.db.prepare('UPDATE jobs SET leaseUntil=0 WHERE id=?').run(id);
  claimJob(store);
  store.db.prepare('UPDATE jobs SET leaseUntil=0 WHERE id=?').run(id);
  expect(claimJob(store)).toBeUndefined();
  expect(store.job(id).status).toBe('failed');
});
test('budget reservations are atomic, token usage settles and uncertain requests keep their allowance', () => {
  const db = openControl(':memory:');
  try {
    vi.stubEnv('AI_MONTHLY_USER_USD', '0.05');
    const id = reserveUsage('test', 'model', 20000, undefined, db);
    expect(() => reserveUsage('test', 'model', 20000, undefined, db)).toThrow(/budget/);
    settleUsage(id, { inputTokens: 100, outputTokens: 100 }, 'response', db);
    expect(usageSummary('test', db).chargedMicros).toBe(600);
    const uncertain = reserveUsage('test', 'model', 20000, undefined, db);
    settleUsage(uncertain, undefined, undefined, db);
    expect(usageSummary('test', db).heldMicros).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});
test('metered model caps output, disables storage and records interrupted streams without retry', async () => {
  const db = openControl(':memory:');
  const response: ModelResponse = {
    usage: new Usage({ inputTokens: 20, outputTokens: 10 }),
    output: [],
  };
  let calls = 0;
  const inner: Model = {
    async getResponse(request) {
      calls++;
      expect(request.modelSettings.store).toBe(false);
      expect(request.modelSettings.maxTokens).toBe(4096);
      return response;
    },
    async *getStreamedResponse() {
      calls++;
      throw new Error('synthetic interruption');
    },
  };
  const model = meteredModel(inner, 'metered', 'synthetic', undefined, db);
  const req = {
    input: 'hello',
    systemInstructions: 'synthetic',
    modelSettings: {},
    tools: [],
    outputType: { type: 'text' },
    handoffs: [],
    tracing: false,
  } as unknown as Parameters<Model['getResponse']>[0];
  try {
    await model.getResponse(req);
    expect(usageSummary('metered', db).inputTokens).toBe(20);
    await expect(async () => {
      for await (const _event of model.getStreamedResponse(req)) {
        /* consume */
      }
    }).rejects.toThrow(/interruption/);
    expect(calls).toBe(2);
    expect(usageSummary('metered', db).heldMicros).toBeGreaterThan(0);
  } finally {
    db.close();
  }
});
test('server pagination is bounded, searchable, and does not change full-history balances', () => {
  const db = openDatabase(':memory:'),
    store = new Store(db);
  try {
    const rows = Array.from({ length: 205 }, (_, i) => '01/01/2026,SYNTHETIC ' + i + ',10.00').join(
      '\n',
    );
    const preview = store.preview('amex', 'synthetic.csv', 'Date,Description,Amount\n' + rows);
    store.confirmImport(preview.id, false);
    const first = store.snapshot(undefined, undefined, { view: 'review', page: 0 }),
      second = store.snapshot(undefined, undefined, { view: 'review', page: 1 });
    expect(first.transactions).toHaveLength(100);
    expect(second.transactions).toHaveLength(100);
    expect(new Set([...first.transactions, ...second.transactions].map((t) => t.id)).size).toBe(
      200,
    );
    expect(first.dashboard.inboxCount).toBe(205);
    expect(first.pagination?.inbox).toBe(205);
    expect(
      store.snapshot(undefined, undefined, { search: 'SYNTHETIC 204' }).transactions,
    ).toHaveLength(1);
  } finally {
    db.close();
  }
});
test('consent withdrawal cancels queued jobs and deletion tombstones prevent account resurrection', () => {
  const user = person(),
    store = workspaceStore(user);
  store.updateSettings('UTC', true);
  const job = store.enqueue('chat', { text: 'Synthetic question' });
  store.updateSettings('UTC', false);
  expect(store.job(job).status).toBe('cancelled');
  expect(() => store.enqueue('chat', { text: 'More' })).toThrow(/Privacy/);
  const token = createSession(user.id);
  controlDb()
    .prepare("UPDATE principals SET status='deleting',deletionAt=? WHERE id=?")
    .run(Date.now() - 121000, user.id);
  expect(findSession(token)).toBeUndefined();
  closeWorkspace(user.id);
  expect(purgeDeleted(controlDb())).toBe(1);
  expect(existsSync(workspacePath(user.id))).toBe(false);
  expect(() =>
    provisionIdentity({ sub: user.subject, email: user.email, email_verified: true }),
  ).toThrow(/unavailable/);
});
test('retention removes expired drafts and chat while preserving financial records and undo', () => {
  const db = openDatabase(':memory:'),
    store = new Store(db);
  try {
    imported(store);
    store.preview('amex', 'abandoned.csv', 'Date,Description,Amount\n01/02/2026,UNSAVED,20.00');
    store.addMessage('user', 'old synthetic message');
    db.prepare("UPDATE imports SET createdAt='2000-01-01'").run();
    db.prepare("UPDATE messages SET createdAt='2000-01-01'").run();
    pruneWorkspace(db);
    expect(store.transactions()).toHaveLength(1);
    expect(store.all("SELECT * FROM imports WHERE status='draft'")).toEqual([]);
    expect(store.snapshot().messages).toEqual([]);
  } finally {
    db.close();
  }
});

test('balance cache ignores worker heartbeat writes and invalidates on financial changes', () => {
  const db = openDatabase(':memory:'),
    store = new Store(db);
  try {
    const first = store.dashboard();
    db.prepare(
      "INSERT INTO jobs(id,kind,payload,createdAt,updatedAt) VALUES('heartbeat-test','process','{}','2026-01-01','2026-01-01')",
    ).run();
    db.prepare("UPDATE jobs SET leaseUntil=9999 WHERE id='heartbeat-test'").run();
    expect(store.dashboard()).toBe(first);
    imported(store, 'CACHE TRANSACTION');
    expect(store.dashboard()).not.toBe(first);
    expect(store.dashboard().inboxCount).toBe(1);
  } finally {
    db.close();
  }
});

test('retries enforce consent and queue limits, and oversized processing selections are rejected', () => {
  const db = openDatabase(':memory:'),
    store = new Store(db);
  try {
    store.updateSettings('UTC', true);
    const ids = Array.from({ length: 5 }, () =>
      store.enqueue('chat', { text: 'Synthetic question' }),
    );
    expect(() => store.enqueue('chat', { text: 'Overflow' })).toThrow(/queued job/);
    store.cancelJob(ids[0]);
    store.enqueue('chat', { text: 'Replacement' });
    expect(() => store.retryJob(ids[0])).toThrow(/queued job/);
    store.updateSettings('UTC', false);
    expect(() => store.retryJob(ids[0])).toThrow(/Privacy/);
    expect(() =>
      store.enqueue('process', { ids: Array.from({ length: 1001 }, (_, i) => String(i)) }),
    ).toThrow(/at most/);
  } finally {
    db.close();
  }
});
test('approved rules run without AI consent while unresolved items stay in Inbox', async () => {
  const db = openDatabase(':memory:'),
    store = new Store(db);
  try {
    const { id } = imported(store, 'RULE-ONLY PURCHASE');
    const rule = store.proposeRule('Personal purchase', {
      merchant: 'RULE-ONLY',
      outputCategory: 'Personal',
      split: { mode: 'personal', participants: ['self'] },
    });
    store.reviewRule(rule, true);
    const other = imported(store, 'NO RULE PURCHASE').id;
    const job = store.enqueue('process', { ids: [id, other] });
    await executeJob(store, claimJob(store)!);
    confirmPrepared(store);
    expect(store.job(job).status).toBe('completed');
    expect(store.transaction(id).state).toBe('ready');
    expect(store.transaction(other).state).toBe('inbox');
    expect(store.transaction(other).attention).toContain('Settings');
  } finally {
    db.close();
  }
});
test('refund quotes include earlier finalized refunds outside the visible page', () => {
  const db = openDatabase(':memory:'),
    store = new Store(db);
  try {
    const person = store.addPerson('Refund person', 'refund_person');
    const preview = store.preview(
      'amex',
      'synthetic.csv',
      'Date,Description,Amount\n01/01/2026,ORIGINAL,0.05\n01/02/2026,REFUND ONE,-0.02\n01/03/2026,REFUND TWO,-0.01',
    );
    const ids = store.confirmImport(preview.id, false).ids;
    const original = store.transactions().find((t) => t.description === 'ORIGINAL')!;
    const first = store.transactions().find((t) => t.description === 'REFUND ONE')!,
      second = store.transactions().find((t) => t.description === 'REFUND TWO')!;
    store.saveProposals(
      [
        {
          id: original.id,
          version: 1,
          state: 'ready',
          proposal: {
            splits: [
              { personId: 'self', amountCents: 3 },
              { personId: person.id, amountCents: 2 },
            ],
            source: 'manual',
            confidence: 'high',
            category: 'Personal',
            explanation: 'Synthetic',
          },
        },
      ],
      'user',
    );
    store.review([{ id: original.id, version: 2 }], 'approve');
    const quote = store.quoteRefund(first.id, original.id);
    store.saveProposals(
      [
        {
          id: first.id,
          version: 1,
          state: 'ready',
          proposal: {
            ...quote,
            source: 'refund',
            confidence: 'high',
            explanation: 'Synthetic',
            refundOf: original.id,
          },
        },
      ],
      'user',
    );
    store.review([{ id: first.id, version: 2 }], 'approve');
    const remaining = store.quoteRefund(second.id, original.id);
    expect(remaining.splits.find((s) => s.personId === 'self')?.amountCents).toBe(-1);
    expect(remaining.splits.find((s) => s.personId === person.id)?.amountCents).toBe(0);
    expect(() => store.quoteRefund(first.id, original.id)).toThrow(/unfinished refund/);
    expect(
      store.snapshot(undefined, undefined, { view: 'review' }).transactions.map((t) => t.id),
    ).toEqual([second.id]);
  } finally {
    db.close();
  }
});

test('OIDC top-level callback navigation is allowed without weakening cross-site API protection', () => {
  const req = new Request('https://splitwise.test/auth/callback?code=synthetic', {
    headers: {
      host: 'splitwise.test',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    },
  });
  expect(() => checkOrigin(req, { allowExternalNavigation: true })).not.toThrow();
  expect(() => checkOrigin(req)).toThrow(/another website/);
  const fetch = new Request(req.url, {
    headers: {
      host: 'splitwise.test',
      'sec-fetch-site': 'cross-site',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
    },
  });
  expect(() => checkOrigin(fetch, { allowExternalNavigation: true })).toThrow(/another website/);
});

test('production trip, manual expense, receipt and settlement interfaces stay within the session workspace', async () => {
  vi.stubEnv('OIDC_ALLOWED_EMAILS', 'features-a@example.test,features-b@example.test');
  const alice = person('features-a@example.test'),
    bob = person('features-b@example.test'),
    a = workspaceStore(alice);
  const tokenA = createSession(alice.id),
    tokenB = createSession(bob.id);
  const participant = a.addPerson('Synthetic Trip Person', 'production_trip_person');
  const trip = await (
    await call('trips/save', tokenA, {
      name: 'Synthetic private trip',
      destination: 'Synthetic',
      from: '2026-01-01',
      to: '2026-01-03',
      context: '',
      split: { mode: 'equal', participants: ['self', participant.id] },
    })
  ).json();
  const manual = await (
    await call('transactions/manual', tokenA, {
      description: 'Synthetic private cash',
      date: '2026-01-01',
      amountCents: 1000,
      category: 'Travel',
      note: 'Synthetic note',
      tripId: trip.id,
      requestId: randomUUID(),
    })
  ).json();
  expect((await call('trips/' + trip.id + '/suggestions', tokenB)).status).toBe(404);
  expect(
    (
      await call('trips/assign', tokenB, {
        tripId: trip.id,
        items: [{ id: manual.id, version: 1 }],
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await call('transactions/quick', tokenB, {
        items: [{ id: manual.id, version: 1 }],
        mode: 'personal',
      })
    ).status,
  ).toBe(404);
  expect((await call('transaction-source/' + manual.id, tokenB)).status).toBe(404);
  expect((await call('transaction-files/' + manual.id, tokenB)).status).toBe(404);
  expect((await call('settlements/' + participant.id, tokenB)).status).toBe(404);
  expect((await call('transactions/manual', undefined, {})).status).toBe(401);
  expect((await call('trips/save', undefined, {})).status).toBe(401);
  const assistant = new AssistantService(a),
    quote = 'Synthetic private household context';
  assistant.applyOperation(
    {
      kind: 'context',
      action: 'save',
      id: randomUUID(),
      version: null,
      title: 'Private context',
      text: quote,
      quote,
      personId: participant.id,
      tripId: trip.id,
      from: null,
      to: null,
    },
    'private-job',
    0,
    quote,
  );
  const request = assistant.queue(
    'private-job',
    'expense',
    {
      kind: 'expense',
      description: 'Private manual draft',
      date: '2026-01-02',
      amountCents: 100,
      category: 'Travel',
      note: '',
      tripId: trip.id,
    },
    'Private draft',
  );
  expect((await call('assistant-requests/' + request + '/apply', tokenB, {})).status).toBe(404);
  expect((await call('assistant-requests/' + request + '/dismiss', tokenB, {})).status).toBe(409);
  expect((await call('assistant-requests/' + request + '/apply', undefined, {})).status).toBe(401);
  expect(
    (await call('context/delete', tokenB, { id: assistant.contexts()[0].id, version: 1 })).status,
  ).toBe(409);
  const other = await (await call('state', tokenB)).json();
  expect(other.userContext).toHaveLength(0);
  expect(other.assistantRequests).toHaveLength(0);
  expect((await call('assistant-requests/' + request + '/apply', tokenA, {})).status).toBe(200);
});
