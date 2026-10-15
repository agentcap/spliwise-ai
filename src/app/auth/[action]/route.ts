import { randomUUID } from 'node:crypto';
import { config } from '@/lib/config';
import { checkOrigin, rateLimit, boundedBody } from '@/lib/security';
import { controlDb } from '@/db/control';
import { AppError } from '@/lib/errors';
import { log } from '@/lib/log';
import {
  SESSION_COOKIE,
  FLOW_COOKIE,
  cookieValue,
  secureCookie,
  startLogin,
  completeLogin,
  revokeSession,
} from '@/lib/auth';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function handle(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const requestId = randomUUID();
  try {
    const action = (await params).action;
    checkOrigin(req, { allowExternalNavigation: action === 'callback' });
    const cfg = config();
    if (!cfg.production) return Response.redirect(new URL('/', req.url), 303);
    // The proxy overwrites this header; direct app ports must never be public.
    const address = req.headers.get('x-real-ip') || 'unknown';
    rateLimit(controlDb(), address, 'auth', 30);
    const headers = new Headers({ 'Cache-Control': 'no-store' });
    if (action === 'login' && req.method === 'GET') {
      const { url, flow } = await startLogin();
      headers.set('Location', url.toString());
      headers.append('Set-Cookie', secureCookie(FLOW_COOKIE, flow, 600));
      return new Response(null, { status: 303, headers });
    }
    if (action === 'callback' && req.method === 'GET') {
      const input = new URL(req.url),
        callback = new URL(cfg.origin + '/auth/callback');
      callback.search = input.search;
      const token = await completeLogin(
        callback,
        cookieValue(req.headers.get('cookie'), FLOW_COOKIE),
      );
      headers.append('Set-Cookie', secureCookie(SESSION_COOKIE, token, cfg.sessionHours * 3600));
      headers.append('Set-Cookie', secureCookie(FLOW_COOKIE, '', 0));
      headers.set('Location', '/');
      return new Response(null, { status: 303, headers });
    }
    if (action === 'logout' && req.method === 'POST') {
      await boundedBody(req, 1024);
      revokeSession(cookieValue(req.headers.get('cookie'), SESSION_COOKIE));
      headers.append('Set-Cookie', secureCookie(SESSION_COOKIE, '', 0));
      headers.set('Location', '/login');
      return new Response(null, { status: 303, headers });
    }
    return new Response('Not found.', { status: 404, headers });
  } catch (error) {
    const status = error instanceof AppError ? error.status : 500;
    log('auth_failed', { requestId, status });
    if (req.method === 'GET' && status !== 429) {
      try {
        const cfg = config();
        if (cfg.production)
          return new Response(null, {
            status: 303,
            headers: {
              Location: cfg.origin + '/login?error=' + (status === 403 ? 'access' : 'signin'),
              'Cache-Control': 'no-store',
              'Set-Cookie': secureCookie(FLOW_COOKIE, '', 0),
            },
          });
      } catch {}
    }
    return Response.json(
      {
        error:
          error instanceof AppError
            ? error.message
            : 'Sign-in could not be completed. Start again or contact the operator.',
        requestId,
      },
      { status, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
export const GET = handle;
export const POST = handle;
