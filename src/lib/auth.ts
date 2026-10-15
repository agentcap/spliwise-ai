import { randomBytes, randomUUID, createHash } from 'node:crypto';
import * as oidc from 'openid-client';
import type Database from 'better-sqlite3';
import { controlDb, type Principal } from '../db/control';
import { config } from './config';
import { invariant } from './errors';
export const SESSION_COOKIE = '__Host-splitwise-session';
export const FLOW_COOKIE = '__Host-splitwise-login';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function cookieValue(cookie: string | null, name: string): string | undefined {
  const value = (cookie || '')
    .split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + '='))
    ?.slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
export function secureCookie(name: string, value: string, maxAge: number) {
  return name + '=' + value + '; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=' + maxAge;
}
export function findSession(
  token?: string,
  db = controlDb(),
  now = Date.now(),
): Principal | undefined {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
  const user = db
    .prepare(
      "SELECT p.* FROM sessions s JOIN principals p ON p.id=s.principalId WHERE s.hash=? AND s.expiresAt>? AND p.status='active'",
    )
    .get(hash(token), now) as Principal | undefined;
  if (user && !config().allowedEmails.includes(user.email.toLowerCase())) return;
  return user;
}
export function authenticate(req: Request) {
  if (!config().production) return undefined;
  const user = findSession(cookieValue(req.headers.get('cookie'), SESSION_COOKIE));
  invariant(user, 'Your session expired. Sign in to continue.', 401);
  return user;
}
export function createSession(principalId: string, db = controlDb()) {
  const token = randomBytes(32).toString('base64url'),
    now = Date.now();
  db.prepare('DELETE FROM sessions WHERE expiresAt<?').run(now);
  db.prepare('INSERT INTO sessions(hash,principalId,expiresAt,createdAt) VALUES(?,?,?,?)').run(
    hash(token),
    principalId,
    now + config().sessionHours * 3_600_000,
    now,
  );
  return token;
}
export function revokeSession(token?: string, db = controlDb()) {
  if (token) db.prepare('DELETE FROM sessions WHERE hash=?').run(hash(token));
}
export function provisionIdentity(
  claims: { sub?: string; email?: unknown; email_verified?: unknown; name?: unknown },
  db: Database.Database = controlDb(),
) {
  const cfg = config();
  invariant(
    claims.sub && typeof claims.email === 'string' && claims.email_verified === true,
    'A verified email address is required.',
    403,
  );
  const email = claims.email.toLowerCase();
  invariant(cfg.allowedEmails.includes(email), 'This account has not been invited.', 403);
  return db
    .transaction(() => {
      const existing = db
        .prepare('SELECT * FROM principals WHERE issuer=? AND subject=?')
        .get(cfg.issuer, claims.sub) as Principal | undefined;
      if (existing) {
        invariant(existing.status === 'active', 'This account is unavailable.', 403);
        invariant(
          existing.email === email,
          'Account email changed. Contact the operator to verify the change.',
          403,
        );
        return existing;
      }
      invariant(
        !db.prepare('SELECT id FROM principals WHERE email=?').get(email),
        'This email belongs to another identity. Contact the operator.',
        403,
      );
      const id = randomUUID(),
        name = typeof claims.name === 'string' ? claims.name.slice(0, 100) : email.split('@')[0];
      db.prepare(
        'INSERT INTO principals(id,issuer,subject,email,name,createdAt) VALUES(?,?,?,?,?,?)',
      ).run(id, cfg.issuer, claims.sub, email, name, new Date().toISOString());
      return db.prepare('SELECT * FROM principals WHERE id=?').get(id) as Principal;
    })
    .immediate();
}
let configuration: Promise<oidc.Configuration> | undefined;
function client() {
  const cfg = config();
  return (configuration ??= oidc
    .discovery(new URL(cfg.issuer), cfg.clientId, cfg.clientSecret)
    .catch((error) => {
      configuration = undefined;
      throw error;
    }));
}
export async function startLogin(db = controlDb(), clientOverride?: oidc.Configuration) {
  const cfg = config();
  invariant(cfg.production, 'Sign-in is only available in production mode.');
  const flow = randomBytes(32).toString('base64url'),
    state = oidc.randomState(),
    verifier = oidc.randomPKCECodeVerifier(),
    nonce = oidc.randomNonce();
  db.prepare('DELETE FROM auth_flows WHERE expiresAt<?').run(Date.now());
  db.prepare('INSERT INTO auth_flows(hash,state,verifier,nonce,expiresAt) VALUES(?,?,?,?,?)').run(
    hash(flow),
    state,
    verifier,
    nonce,
    Date.now() + 600_000,
  );
  const url = oidc.buildAuthorizationUrl(clientOverride || (await client()), {
    redirect_uri: cfg.origin + '/auth/callback',
    scope: 'openid email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url, flow };
}
export async function completeLogin(
  url: URL,
  flow?: string,
  db = controlDb(),
  clientOverride?: oidc.Configuration,
) {
  invariant(flow, 'Sign-in expired. Start again.', 401);
  const row = db
    .transaction(() => {
      const row = db
        .prepare('SELECT * FROM auth_flows WHERE hash=? AND expiresAt>?')
        .get(hash(flow), Date.now()) as
        { state: string; verifier: string; nonce: string } | undefined;
      db.prepare('DELETE FROM auth_flows WHERE hash=?').run(hash(flow));
      return row;
    })
    .immediate();
  invariant(row, 'Sign-in expired. Start again.', 401);
  const tokens = await oidc.authorizationCodeGrant(clientOverride || (await client()), url, {
    pkceCodeVerifier: row.verifier,
    expectedState: row.state,
    expectedNonce: row.nonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  invariant(claims, 'The provider did not return an identity.', 401);
  const user = provisionIdentity(claims, db);
  return createSession(user.id, db);
}
