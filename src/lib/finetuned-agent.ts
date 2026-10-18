import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store';
import type { AgentPlan, AgentProgress } from './agent';
import type { AssistantOperation } from './assistant-contracts';
import { expenseActionSchema } from './assistant-contracts';
import { config } from './config';
import { invariant } from './errors';

export const fineTunedModelHash =
  '035b5fb51f5f7a48634c3ebb6bb64725beb0dfe7a7ad72f6cde90750884690de';
export const localSnapshotTables = [
  'people',
  'accounts',
  'categories',
  'imports',
  'transactions',
  'rules',
  'rule_changes',
  'repayments',
  'trips',
  'split_templates',
  'merchant_aliases',
  'attachments',
  'user_context',
  'messages',
  'workspace_settings',
  'ledger_revision',
] as const;

function connection() {
  const port = Number(process.env.FINETUNED_MODEL_PORT || 8766);
  invariant(Number.isInteger(port) && port > 1023 && port < 65536, 'Invalid local model port.');
  let token = '';
  try {
    token = readFileSync(
      resolve(/*turbopackIgnore: true*/ '.tools/finetune/web-model/token'),
      'utf8',
    ).trim();
  } catch {
    /* Service has not been started on this installation. */
  }
  invariant(
    token.length >= 32,
    'The fine-tuned model is offline. Start the local model service or choose Hosted AI in Settings.',
    503,
  );
  return {
    url: `http://127.0.0.1:${port}`,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  };
}

export async function fineTunedModelStatus(): Promise<{ available: boolean }> {
  try {
    const { url, headers } = connection();
    const response = await fetch(url + '/health', {
      headers,
      signal: AbortSignal.timeout(1000),
      cache: 'no-store',
    });
    const body = await response.json();
    return {
      available:
        response.ok &&
        body.ready === true &&
        body.model === 'gemma-v2' &&
        body.sha256 === fineTunedModelHash,
    };
  } catch {
    return { available: false };
  }
}

const record = z.record(z.string(), z.unknown());
const nativeResult = z.object({
  message: z.string().max(20000),
  plan: z.object({
    organization: z.array(record).max(50),
    requests: z.array(record).max(20),
    updates: z.array(record).max(1000),
  }),
});

// The native runtime omits absent optional values; the web contract uses explicit nulls.
export function normalizeFineTunedPlan(value: unknown): AgentPlan {
  const result = nativeResult.parse(value);
  const organization = result.plan.organization.map((op) => {
    invariant(
      ['rule', 'context', 'trip', 'person', 'template', 'alias'].includes(String(op.kind)),
      'Unsupported local model action.',
    );
    const normalized = { ...op };
    if (['rule', 'context', 'trip', 'template'].includes(String(op.kind)))
      normalized.version ??= null;
    if (op.kind === 'context' && op.action === 'save') {
      for (const key of ['personId', 'tripId', 'from', 'to']) normalized[key] ||= null;
    }
    if (op.kind === 'trip' && op.action === 'save') {
      normalized.destination ??= op.name;
      normalized.context ??= '';
    }
    return normalized as unknown as AssistantOperation;
  });
  const requests = result.plan.requests.map((request) =>
    expenseActionSchema.parse({
      ...request,
      ...(request.kind === 'expense' || request.kind === 'repayment'
        ? { note: request.note || '' }
        : {}),
      ...(request.kind === 'expense' || request.kind === 'assignment'
        ? { tripId: request.tripId || null }
        : {}),
    }),
  );
  const updates = result.plan.updates.map((update) => {
    invariant(
      typeof update.id === 'string' &&
        Number.isSafeInteger(update.version) &&
        ['inbox', 'ready'].includes(String(update.state)),
      'Invalid local model proposal.',
    );
    return update as unknown as AgentPlan['updates'][number];
  });
  return { message: result.message, organization, requests, updates, rules: [] };
}

export async function askFineTunedAgent(
  store: Store,
  text: string,
  ids: string[] | undefined,
  signal?: AbortSignal,
  onProgress?: (progress: AgentProgress) => void,
): Promise<AgentPlan> {
  signal?.throwIfAborted();
  const { url, headers } = connection();
  const requestId = randomUUID();
  const timeout = AbortSignal.timeout(config().jobTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const cancel = () => {
    void fetch(url + '/infer/' + requestId, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(2000),
    }).catch(() => {});
  };
  combined.addEventListener('abort', cancel, { once: true });
  try {
    // A consistent workspace snapshot is evaluated in memory. The local runtime never opens
    // the live database; applyStep still revalidates versions, scope and confirmation cards.
    const tables = store.db.transaction(() =>
      Object.fromEntries(
        localSnapshotTables.map((table) => [table, store.all(`SELECT * FROM "${table}"`)]),
      ),
    )();
    const body = JSON.stringify({ requestId, text, ids, tables });
    invariant(
      Buffer.byteLength(body) <= 64 * 1024 * 1024,
      'This workspace is too large for the local model.',
      413,
    );
    onProgress?.({ activity: 'Running fine-tuned Gemma locally…' });
    let response: Response;
    try {
      response = await fetch(url + '/infer', { method: 'POST', headers, body, signal: combined });
    } catch (error) {
      if (combined.aborted) throw error;
      invariant(
        false,
        'The fine-tuned model is offline. Start the local model service or choose Hosted AI in Settings.',
        503,
      );
    }
    if (!response.ok) {
      invariant(
        false,
        response.status === 503
          ? 'The fine-tuned model is busy. Try again shortly.'
          : 'The fine-tuned model could not finish this request. Try a shorter instruction.',
        503,
      );
    }
    const plan = normalizeFineTunedPlan(await response.json());
    combined.throwIfAborted();
    onProgress?.({ activity: 'Checking proposed changes…', text: plan.message });
    return plan;
  } finally {
    combined.removeEventListener('abort', cancel);
  }
}
