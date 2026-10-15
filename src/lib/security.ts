import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { config } from './config';
import { invariant, AppError } from './errors';
export function checkOrigin(req: Request, options: { allowExternalNavigation?: boolean } = {}) {
  const navigation =
    options.allowExternalNavigation &&
    req.method === 'GET' &&
    req.headers.get('sec-fetch-mode') === 'navigate' &&
    req.headers.get('sec-fetch-dest') === 'document';
  const cfg = config(),
    host = req.headers.get('host') || new URL(req.url).host;
  let parsed: URL;
  try {
    parsed = new URL('http://' + host);
  } catch {
    throw new AppError('Unrecognized host.', 403);
  }
  invariant(parsed.host === host, 'Unrecognized host.', 403);
  if (cfg.production) invariant(host === new URL(cfg.appUrl).host, 'Unrecognized host.', 403);
  else
    invariant(
      ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname),
      'Local access only.',
      403,
    );
  const origin = req.headers.get('origin');
  invariant(
    req.headers.get('sec-fetch-site') !== 'cross-site' || navigation,
    'This request came from another website.',
    403,
  );
  if (origin && !navigation) {
    let source: URL;
    try {
      source = new URL(origin);
    } catch {
      throw new AppError('Unrecognized origin.', 403);
    }
    invariant(
      source.origin === (cfg.production ? cfg.origin : new URL('http://' + host).origin),
      'This request came from another website.',
      403,
    );
  } else if (cfg.production && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    throw new AppError('A same-origin request is required.', 403);
  }
}
export function rateLimit(
  db: Database.Database,
  identity: string,
  lane: string,
  limit: number,
  windowMs = 60_000,
  now = Date.now(),
) {
  const key = createHash('sha256')
    .update(identity + ':' + lane + ':' + Math.floor(now / windowMs))
    .digest('hex');
  db.transaction(() => {
    db.prepare('DELETE FROM rates WHERE expiresAt<?').run(now);
    const row = db.prepare('SELECT count FROM rates WHERE key=?').get(key) as
      { count: number } | undefined;
    invariant(!row || row.count < limit, 'Too many requests. Please wait a minute.', 429);
    db.prepare(
      'INSERT INTO rates(key,count,expiresAt) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1',
    ).run(key, now + windowMs);
  }).immediate();
}
// Count the actual stream before invoking JSON or multipart parsers, including chunked requests.
export async function boundedBody(
  req: Request,
  maxBytes: number,
  timeoutMs = 15_000,
): Promise<Uint8Array> {
  invariant(
    Number(req.headers.get('content-length') || 0) <= maxBytes,
    'Request is too large.',
    413,
  );
  invariant(req.body, 'A request body is required.');
  const reader = req.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        void reader.cancel().catch(() => {});
        reject(new AppError('Request timed out.', 408));
      }, timeoutMs);
    });
    while (true) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      size += next.value.byteLength;
      invariant(size <= maxBytes, 'Request is too large.', 413);
      chunks.push(next.value);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    void reader.cancel().catch(() => {});
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
export async function boundedJson(req: Request, limit: number): Promise<unknown> {
  invariant(req.headers.get('content-type')?.startsWith('application/json'), 'Expected JSON.', 415);
  const bytes = await boundedBody(req, limit);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError('Malformed JSON.');
  }
}
export async function boundedForm(req: Request) {
  invariant(
    req.headers.get('content-type')?.startsWith('multipart/form-data;'),
    'Expected a file upload.',
    415,
  );
  const bytes = await boundedBody(req, 10_100_000);
  return new Response(bytes as BodyInit, {
    headers: { 'content-type': req.headers.get('content-type')! },
  }).formData();
}
