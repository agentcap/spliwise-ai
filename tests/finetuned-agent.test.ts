import { afterEach, expect, test, vi } from 'vitest';
import { openDatabase } from '../src/db';
import { Store } from '../src/lib/store';
import { Features } from '../src/lib/features';
import { askAgent } from '../src/lib/agent';
import { claimJob, executeJob } from '../src/lib/jobs';
import { AssistantService } from '../src/lib/assistant-service';
import {
  fineTunedModelHash,
  fineTunedModelStatus,
  normalizeFineTunedPlan,
} from '../src/lib/finetuned-agent';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>();
  return {
    ...fs,
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) =>
      String(args[0]).replaceAll('\\', '/').endsWith('/web-model/token')
        ? 't'.repeat(64)
        : fs.readFileSync(...args),
  };
});
const databases: ReturnType<typeof openDatabase>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function setup() {
  vi.stubEnv('OPENAI_API_KEY', '');
  vi.stubEnv('APP_MODE', 'local');
  const db = openDatabase(':memory:');
  databases.push(db);
  const store = new Store(db);
  return store;
}

test('model choice defaults to hosted and remains saved when only privacy preferences change', () => {
  const store = setup();
  expect(store.settings().aiModel).toBe('hosted');
  store.updateSettings('UTC', true, 'gemma-v2');
  store.updateSettings('America/Los_Angeles', false);
  expect(new Store(store.db).settings().aiModel).toBe('gemma-v2');
  expect(() => store.updateSettings('UTC', true, 'unknown' as 'hosted')).toThrow(
    'supported AI model',
  );
});

test('fine-tuned chat bypasses OpenAI and prepares a confirmation card without moving the expense', async () => {
  const store = setup();
  const person = store.addPerson('Alex', 'alex', 'Friend');
  const id = new Features(store).manual({
    description: 'CAFE lunch',
    date: '2026-10-17',
    amountCents: 1200,
    category: 'Food & Drink',
    note: '',
    tripId: null,
    requestId: crypto.randomUUID(),
  }).id;
  store.updateSettings('UTC', true, 'gemma-v2');
  const jobId = store.enqueue('chat', {
    text: 'Split this equally between @me and @alex.',
    ids: [id],
  });
  const tx = store.transaction(id);
  const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(options.body as string);
    expect(body.tables.transactions).toHaveLength(1);
    expect(body.ids).toEqual([id]);
    expect(body.tables).not.toHaveProperty('principals');
    return Response.json({
      message: 'Prepared for confirmation.',
      plan: {
        organization: [],
        requests: [],
        updates: [
          {
            id,
            version: tx.version,
            state: 'ready',
            proposal: {
              splits: [
                { personId: 'self', amountCents: 600 },
                { personId: person.id, amountCents: 600 },
              ],
              category: 'Food & Drink',
              confidence: 'high',
              source: 'instruction',
              explanation: 'Equal split.',
              spec: { mode: 'equal', participants: ['self', person.id] },
            },
          },
        ],
      },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  const job = claimJob(store)!;
  expect(job.id).toBe(jobId);
  await executeJob(store, job);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:8766/infer');
  expect(store.transaction(id).state).toBe('inbox');
  const request = new AssistantService(store).requests().find((r) => r.kind === 'splits')!;
  expect(request.status).toBe('pending');
  new AssistantService(store).applyRequest(request.id);
  expect(store.transaction(id).state).toBe('ready');
});

test('offline local model fails explicitly without falling back to hosted AI', async () => {
  const store = setup();
  store.updateSettings('UTC', true, 'gemma-v2');
  const fetchMock = vi.fn().mockRejectedValue(new Error('connection refused'));
  vi.stubGlobal('fetch', fetchMock);
  await expect(askAgent(store, 'What do I owe?', undefined)).rejects.toThrow(
    'fine-tuned model is offline',
  );
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await fineTunedModelStatus()).toEqual({ available: false });
});

test('status rejects a different model and confirms the pinned fine-tuned bundle', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ ready: true, model: 'gemma-v2', sha256: 'wrong' })),
  );
  expect(await fineTunedModelStatus()).toEqual({ available: false });
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json({ ready: true, model: 'gemma-v2', sha256: fineTunedModelHash }),
      ),
  );
  expect(await fineTunedModelStatus()).toEqual({ available: true });
});

test('native creations normalize nullable fields before web validation', () => {
  const plan = normalizeFineTunedPlan({
    message: 'Prepared.',
    plan: {
      organization: [
        {
          kind: 'context',
          action: 'save',
          id: 'fact',
          title: 'Friend',
          text: 'Alex is my friend',
          quote: 'Alex is my friend',
        },
      ],
      updates: [],
      requests: [
        {
          kind: 'expense',
          description: 'Lunch',
          date: '2026-10-17',
          amountCents: 1200,
          category: 'Food & Drink',
        },
      ],
    },
  });
  expect(plan.organization![0]).toMatchObject({
    version: null,
    personId: null,
    tripId: null,
    from: null,
    to: null,
  });
  expect(plan.requests![0]).toMatchObject({ note: '', tripId: null });
  expect(() =>
    normalizeFineTunedPlan({
      message: 'Done',
      plan: { organization: [{ kind: 'finalize' }], updates: [], requests: [] },
    }),
  ).toThrow();
});
