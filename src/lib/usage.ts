import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { OpenAIProvider, type Model, type ModelRequest, type ModelResponse } from '@openai/agents';
import OpenAI from 'openai';
import { controlDb } from '../db/control';
import { config, numberSetting } from './config';
import { invariant } from './errors';

export function budgetSettings() {
  return {
    // Prices are operator supplied; estimates deliberately do not assume cached-input discounts.
    inputPrice: numberSetting('OPENAI_INPUT_USD_PER_MILLION', 1, 0, 1000),
    outputPrice: numberSetting('OPENAI_OUTPUT_USD_PER_MILLION', 5, 0, 1000),
    userLimit: Math.round(numberSetting('AI_MONTHLY_USER_USD', 10, 0, 100000) * 1_000_000),
    globalLimit: Math.round(numberSetting('AI_MONTHLY_GLOBAL_USD', 100, 0, 1000000) * 1_000_000),
    maxOutput: numberSetting('AI_MAX_OUTPUT_TOKENS', 4096, 256, 8192),
  };
}
export function usageSummary(
  principalId: string,
  db = controlDb(),
  month = new Date().toISOString().slice(0, 7),
) {
  const row = db
    .prepare(
      `SELECT COUNT(*) requests, COALESCE(SUM(inputTokens),0) inputTokens,
    COALESCE(SUM(outputTokens),0) outputTokens,
    COALESCE(SUM(CASE WHEN status='reported' THEN costMicros ELSE reservedMicros END),0) chargedMicros,
    COALESCE(SUM(CASE WHEN status!='reported' THEN reservedMicros ELSE 0 END),0) heldMicros
    FROM ai_usage WHERE principalId=? AND month=?`,
    )
    .get(principalId, month) as {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    chargedMicros: number;
    heldMicros: number;
  };
  return {
    ...row,
    month,
    limitMicros: budgetSettings().userLimit,
    pricingConfigured:
      !!process.env.OPENAI_INPUT_USD_PER_MILLION && !!process.env.OPENAI_OUTPUT_USD_PER_MILLION,
  };
}
export function reserveUsage(
  principalId: string,
  model: string,
  inputBound: number,
  jobId?: string,
  db = controlDb(),
) {
  const b = budgetSettings(),
    month = new Date().toISOString().slice(0, 7),
    id = randomUUID();
  const reserve = Math.ceil(inputBound * b.inputPrice + b.maxOutput * b.outputPrice);
  invariant(reserve > 0, 'AI token prices must be greater than zero.');
  db.transaction(() => {
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN status='reported' THEN costMicros ELSE reservedMicros END),0) total,
      COALESCE(SUM(CASE WHEN principalId=? THEN CASE WHEN status='reported' THEN costMicros ELSE reservedMicros END ELSE 0 END),0) personal
      FROM ai_usage WHERE month=?`,
      )
      .get(principalId, month) as { total: number; personal: number };
    invariant(
      totals.total + reserve <= b.globalLimit && totals.personal + reserve <= b.userLimit,
      'AI monthly budget reached. Manual splits and approved rules remain available.',
      429,
    );
    db.prepare(
      'INSERT INTO ai_usage(id,principalId,jobId,model,month,status,reservedMicros,inputPrice,outputPrice,createdAt) VALUES(?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id,
      principalId,
      jobId || null,
      model,
      month,
      'reserved',
      reserve,
      b.inputPrice,
      b.outputPrice,
      new Date().toISOString(),
    );
  }).immediate();
  return id;
}
export function settleUsage(
  id: string,
  usage?: { inputTokens: number; outputTokens: number },
  responseId?: string,
  db = controlDb(),
) {
  if (
    !usage ||
    !Number.isSafeInteger(usage.inputTokens) ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.inputTokens < 0 ||
    usage.outputTokens < 0
  ) {
    db.prepare("UPDATE ai_usage SET status='uncertain' WHERE id=? AND status='reserved'").run(id);
    return;
  }
  const row = db.prepare('SELECT inputPrice,outputPrice FROM ai_usage WHERE id=?').get(id) as {
    inputPrice: number;
    outputPrice: number;
  };
  db.prepare(
    "UPDATE ai_usage SET status='reported',inputTokens=?,outputTokens=?,costMicros=?,responseId=? WHERE id=? AND status='reserved'",
  ).run(
    usage.inputTokens,
    usage.outputTokens,
    Math.ceil(usage.inputTokens * row.inputPrice + usage.outputTokens * row.outputPrice),
    responseId || null,
    id,
  );
}
export function meteredModel(
  inner: Model,
  principalId: string,
  model: string,
  jobId?: string,
  db?: Database.Database,
): Model {
  const begin = (request: ModelRequest) => {
    config(); // Validate production settings before sending data.
    const bytes = Buffer.byteLength(
      JSON.stringify({
        input: request.input,
        tools: request.tools,
        instructions: request.systemInstructions,
      }),
    );
    invariant(
      bytes <= 160_000,
      'This AI request contains too much context. Process a smaller selection.',
    );
    // A deliberately conservative text-token allowance, including tool schema/framing overhead.
    const id = reserveUsage(principalId, model, bytes * 2 + 16_384, jobId, db);
    return {
      id,
      request: {
        ...request,
        modelSettings: {
          ...request.modelSettings,
          store: false,
          maxTokens: budgetSettings().maxOutput,
        },
      },
    };
  };
  return {
    async getResponse(request) {
      const run = begin(request);
      try {
        const result = await inner.getResponse(run.request);
        settleUsage(run.id, result.usage, result.responseId, db);
        return result;
      } catch (error) {
        settleUsage(run.id, undefined, undefined, db);
        throw error;
      }
    },
    async *getStreamedResponse(request) {
      const run = begin(request);
      let settled = false;
      try {
        for await (const event of inner.getStreamedResponse(run.request)) {
          if (event.type === 'response_done') {
            settleUsage(run.id, event.response.usage, event.response.id, db);
            settled = true;
          }
          yield event;
        }
      } finally {
        if (!settled) settleUsage(run.id, undefined, undefined, db);
      }
    },
  };
}
export async function agentModel(principalId: string, jobId?: string): Promise<Model> {
  const name = process.env.OPENAI_MODEL || 'gpt-6-luna';
  // Retries are explicit so an uncertain billable request is never silently replayed.
  const provider = new OpenAIProvider({
    useResponses: true,
    openAIClient: new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      maxRetries: 0,
      timeout: config().jobTimeoutMs,
    }),
  });
  return meteredModel(await provider.getModel(name), principalId, name, jobId);
}
