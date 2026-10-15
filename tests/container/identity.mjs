// Synthetic OIDC server for the isolated container test; never deployed with the app.
import { createServer } from 'node:http';
import { generateKeyPairSync, randomUUID, createHash, sign } from 'node:crypto';
import assert from 'node:assert/strict';
const issuer = process.env.SMOKE_ISSUER;
assert.ok(issuer?.startsWith('https://identity.test:'));
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'synthetic', use: 'sig', alg: 'RS256' };
const codes = new Map();
const jwt = (claims) => {
  const unsigned = [{ alg: 'RS256', kid: 'synthetic', typ: 'JWT' }, claims]
    .map((value) => Buffer.from(JSON.stringify(value)).toString('base64url'))
    .join('.');
  return (
    unsigned + '.' + sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')
  );
};
createServer(async (req, res) => {
  const json = (value) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  try {
    const url = new URL(req.url, issuer);
    if (url.pathname === '/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: issuer + '/authorize',
        token_endpoint: issuer + '/token',
        jwks_uri: issuer + '/jwks',
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/jwks') return json({ keys: [jwk] });
    if (url.pathname === '/authorize') {
      assert.equal(url.searchParams.get('client_id'), 'synthetic-client');
      assert.equal(
        url.searchParams.get('redirect_uri'),
        process.env.SMOKE_APP_URL + '/auth/callback',
      );
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const code = randomUUID(),
        callback = new URL(url.searchParams.get('redirect_uri'));
      codes.set(code, {
        nonce: url.searchParams.get('nonce'),
        challenge: url.searchParams.get('code_challenge'),
        redirect: callback.href,
        user: url.searchParams.get('synthetic_user') || 'alice',
      });
      callback.searchParams.set('code', code);
      callback.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(303, { Location: callback.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const form = new URLSearchParams(body),
        code = form.get('code'),
        grant = codes.get(code);
      codes.delete(code);
      assert.ok(grant, 'Authorization code must be valid and single use.');
      const basic =
        req.headers.authorization &&
        Buffer.from(req.headers.authorization.slice(6), 'base64').toString();
      assert.ok(
        basic === 'synthetic-client:synthetic-secret' ||
          (form.get('client_id') === 'synthetic-client' &&
            form.get('client_secret') === 'synthetic-secret'),
      );
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('redirect_uri'), grant.redirect);
      assert.equal(
        createHash('sha256')
          .update(form.get('code_verifier') || '')
          .digest('base64url'),
        grant.challenge,
      );
      const now = Math.floor(Date.now() / 1000);
      return json({
        access_token: randomUUID(),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: jwt({
          iss: issuer,
          sub: grant.user,
          aud: 'synthetic-client',
          iat: now,
          exp: now + 300,
          nonce: grant.nonce,
          email: grant.user + '@example.test',
          email_verified: grant.user !== 'unverified',
          name: 'Synthetic ' + grant.user,
        }),
      });
    }
    res.writeHead(404);
    res.end();
  } catch {
    res.writeHead(400);
    res.end('Synthetic identity request rejected.');
  }
}).listen(9000, '0.0.0.0');
