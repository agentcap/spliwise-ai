import { resolve } from 'node:path';

export function numberSetting(
  name: string,
  fallback: number,
  min = 1,
  max = Number.MAX_SAFE_INTEGER,
) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max)
    throw new Error('Invalid configuration: ' + name);
  return value;
}
export function config() {
  const mode =
    process.env.APP_MODE || (process.env.NODE_ENV === 'production' ? 'production' : 'local');
  if (!['local', 'production'].includes(mode))
    throw new Error('APP_MODE must be local or production.');
  const production = mode === 'production';
  const appUrl = process.env.APP_URL || 'http://127.0.0.1:3000';
  const url = new URL(appUrl);
  if (url.origin !== appUrl || url.username || url.password)
    throw new Error('APP_URL must be an origin without a trailing slash.');
  if (production) {
    for (const key of [
      'APP_URL',
      'OIDC_ISSUER',
      'OIDC_CLIENT_ID',
      'OIDC_CLIENT_SECRET',
      'OIDC_ALLOWED_EMAILS',
    ])
      if (!process.env[key]?.trim()) throw new Error('Production requires ' + key);
    if (url.protocol !== 'https:' || new URL(process.env.OIDC_ISSUER!).protocol !== 'https:')
      throw new Error('Production requires HTTPS for the application and identity provider.');
    if (process.env.AGENT_MODE) throw new Error('Test agents are forbidden in production.');
    if (
      process.env.OPENAI_API_KEY &&
      (!process.env.OPENAI_INPUT_USD_PER_MILLION || !process.env.OPENAI_OUTPUT_USD_PER_MILLION)
    )
      throw new Error('Production requires explicit OpenAI token prices for budget accounting.');
  }
  return {
    production,
    appUrl,
    origin: url.origin,
    dataRoot: resolve(/*turbopackIgnore: true*/ process.env.WORKSPACE_ROOT || './data/workspaces'),
    controlPath: resolve(
      /*turbopackIgnore: true*/ process.env.CONTROL_DATABASE_PATH ||
        (production
          ? './data/control.sqlite'
          : (process.env.DATABASE_PATH || './data/splitwise.sqlite') + '.control.sqlite'),
    ),
    issuer: process.env.OIDC_ISSUER || '',
    clientId: process.env.OIDC_CLIENT_ID || '',
    clientSecret: process.env.OIDC_CLIENT_SECRET || '',
    allowedEmails: (process.env.OIDC_ALLOWED_EMAILS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    sessionHours: numberSetting('SESSION_HOURS', 12, 1, 168),
    maxJobTransactions: numberSetting('MAX_JOB_TRANSACTIONS', 1000, 1, 5000),
    maxQueuedJobs: numberSetting('MAX_QUEUED_JOBS', 5, 1, 100),
    jobTimeoutMs: numberSetting('JOB_TIMEOUT_SECONDS', 180, 10, 900) * 1000,
    maxJobAttempts: numberSetting('MAX_JOB_ATTEMPTS', 3, 1, 10),
    minFreeBytes: numberSetting('MIN_FREE_DISK_MB', 256, 0) * 1024 * 1024,
  };
}
