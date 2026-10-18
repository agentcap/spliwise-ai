import { randomUUID } from 'node:crypto';
import { Features, displayMerchant } from './features';
import { config } from './config';
import type { Store } from './store';
import { askAgent, type AgentPlan } from './agent';
import { ruleProposal } from './rules';
import type { AgentJob } from './types';
import { invariant } from './errors';
import { AssistantService, trustedUserText } from './assistant-service';
import { randomUUID as operationId } from 'node:crypto';
const timestamp = () => new Date().toISOString();
export function claimJob(store: Store): AgentJob | undefined {
  return store.db
    .transaction(() => {
      store.db
        .prepare(
          "UPDATE jobs SET status='cancelled',updatedAt=? WHERE cancelRequested=1 AND status IN ('queued','running') AND leaseUntil<?",
        )
        .run(timestamp(), Date.now());
      store.db
        .prepare(
          "UPDATE jobs SET status='failed',error='Recovery attempt limit reached. Review completed batches before retrying.',leaseUntil=0,leaseToken=NULL,updatedAt=? WHERE status IN ('queued','running') AND leaseUntil<? AND attempts>=?",
        )
        .run(timestamp(), Date.now(), config().maxJobAttempts);
      const row = store.one<{ id: string }>(
        "SELECT id FROM jobs WHERE cancelRequested=0 AND (status='queued' OR (status='running' AND leaseUntil<?)) ORDER BY createdAt LIMIT 1",
        Date.now(),
      );
      if (!row) return;
      store.db
        .prepare(
          "UPDATE jobs SET status='running',leaseUntil=?,updatedAt=?,leaseToken=?,attempts=attempts+1 WHERE id=?",
        )
        .run(Date.now() + 30000, timestamp(), randomUUID(), row.id);
      return store.job(row.id);
    })
    .immediate();
}
export function applyStep(
  store: Store,
  jobId: string,
  cursor: number,
  plan: AgentPlan,
  nextCursor: number,
  progress: number,
  leaseToken?: string | null,
): void {
  store.db
    .transaction(() => {
      const job = store.job(jobId);
      if (job.cancelRequested) throw new Error('Job cancelled.');
      if (leaseToken)
        invariant(
          job.status === 'running' && job.leaseToken === leaseToken && job.leaseUntil > Date.now(),
          'Job lease was lost.',
          409,
        );
      if (job.cursor !== cursor) return;
      for (const u of plan.updates)
        invariant(
          !job.payload.ids || job.payload.ids.includes(u.id),
          'Agent result is outside the selected scope.',
          403,
        );
      const updates = plan.updates.filter((u) => {
        const t = store.transaction(u.id);
        return t.state !== 'finalized' && t.version === u.version;
      });
      const skipped = plan.updates.length - updates.length;

      const assistant = new AssistantService(store);
      const operations = [
        ...(plan.organization || []),
        ...plan.rules.map((r) => ({
          kind: 'rule' as const,
          action: 'save' as const,
          id: r.ruleId || operationId(),
          version: r.ruleId
            ? (r.baseVersion ?? store.rules().find((x) => x.id === r.ruleId)?.version ?? null)
            : null,
          title: r.title,
          definition: r.definition,
        })),
      ];
      invariant(operations.length <= 50, 'Too many workspace changes in one batch.');
      const sourceText = trustedUserText(
        store,
        job.payload.text || '',
        job.kind === 'process' ? job.payload.ids?.slice(cursor, cursor + 20) : job.payload.ids,
      );
      operations.forEach((op, i) =>
        assistant.applyOperation(op, jobId, cursor * 100 + i, sourceText),
      );
      const proposals = [];
      for (const update of updates) {
        let current = store.transaction(update.id);
        const changed =
          current.state !== update.state ||
          JSON.stringify(current.proposal) !== JSON.stringify(update.proposal);
        // Additional facts and focused questions are visible metadata; never apply a split/state as a side effect.
        if (
          update.context ||
          (!changed && update.attention !== undefined && update.attention !== current.attention)
        ) {
          store.saveProposals(
            [
              {
                id: current.id,
                version: current.version,
                state: current.state as 'inbox' | 'ready',
                proposal: current.proposal,
                attention: changed ? current.attention : update.attention,
                context: update.context,
              },
            ],
            'agent',
            jobId + ':' + cursor + ':context:' + current.id,
          );
          current = store.transaction(update.id);
        }
        if (changed)
          proposals.push({
            ...update,
            version: current.version,
            context: undefined,
            transaction: {
              description: current.description,
              date: current.date,
              amountCents: current.amountCents,
            },
          });
      }
      if (proposals.length)
        assistant.queue(
          jobId,
          'splits',
          proposals,
          'Apply ' + proposals.length + ' proposed split' + (proposals.length === 1 ? '' : 's'),
        );
      invariant((plan.requests?.length || 0) <= 20, 'Too many transaction action cards.');
      for (const request of plan.requests || []) {
        assistant.validateExpenseAction(
          request,
          job.payload.ids ? new Set(job.payload.ids) : undefined,
        );
        assistant.queue(
          jobId,
          request.kind,
          request,
          request.kind === 'assignment'
            ? 'Assign ' + request.items.length + ' expenses to trip'
            : request.kind === 'expense'
              ? 'Add expense: ' + request.description
              : 'Record repayment',
        );
      }

      if (plan.message)
        store.addMessage(
          'assistant',
          plan.message +
            (proposals.length
              ? '\n\n' +
                proposals.length +
                ' transaction change(s) await your confirmation below. No expenses have moved.'
              : '') +
            (skipped ? ' ' + skipped + ' changed transaction(s) were left untouched.' : ''),
          jobId,
          job.payload.ids,
        );
      store.db
        .prepare('UPDATE jobs SET cursor=?,progress=?,result=?,updatedAt=? WHERE id=?')
        .run(nextCursor, progress, plan.message, timestamp(), jobId);
    })
    .immediate();
}
export async function executeJob(store: Store, job: AgentJob, signal?: AbortSignal): Promise<void> {
  if (job.kind === 'chat') {
    if (job.cursor === 0) {
      for (const item of job.payload.versions || []) {
        const tx = store.transaction(item.id);
        invariant(
          tx.version === item.version && tx.state !== 'finalized',
          'This expense changed after the instruction was sent. Send an updated instruction.',
          409,
        );
      }
      let lastWrite = 0;
      let response = '';
      let activity = 'Reading your instructions…';
      const progress = (update: { text?: string; activity?: string }) => {
        if (update.text !== undefined) response = update.text;
        const activityChanged = update.activity !== undefined && update.activity !== activity;
        if (update.activity) activity = update.activity;
        if (Date.now() - lastWrite < 200 && !activityChanged) return;
        lastWrite = Date.now();
        store.db
          .prepare(
            "UPDATE jobs SET response=?,activity=?,updatedAt=? WHERE id=? AND status='running' AND cancelRequested=0",
          )
          .run(response, activity, timestamp(), job.id);
      };
      const plan = await askAgent(
        store,
        job.payload.text!,
        job.payload.ids,
        signal,
        progress,
        job.id,
      );
      if (signal?.aborted) throw new Error('Job interrupted.');
      applyStep(store, job.id, 0, plan, 1, 100, job.leaseToken);
    }
  } else {
    const ids = job.payload.ids || [];
    for (let cursor = job.cursor; cursor < ids.length; cursor += 20) {
      if (signal?.aborted || store.job(job.id).cancelRequested) throw new Error('Job cancelled.');
      const batch = ids
        .slice(cursor, cursor + 20)
        .map((id) => store.transaction(id))
        .filter((t) => t.state !== 'finalized');
      const plan: AgentPlan = { message: '', updates: [], rules: [] };
      const needsAI: string[] = [];
      for (const tx of batch) {
        if (tx.instruction) {
          needsAI.push(tx.id);
          continue;
        }
        if (tx.amountCents < 0) {
          const refund = store.refundProposal(tx);
          plan.updates.push({
            id: tx.id,
            version: tx.version,
            proposal: refund || null,
            state: refund ? 'ready' : 'inbox',
            attention: refund
              ? ''
              : 'Which purchase does this refund belong to? Choose a finalized purchase or provide an allocation.',
          });
          continue;
        }
        const features = new Features(store);
        if (tx.tripId && features.trip(tx.tripId).context) {
          needsAI.push(tx.id);
          continue;
        }
        const trip = features.tripProposal(tx);
        const canonical = displayMerchant(tx.description, features.aliases());
        const matched =
          trip.proposal || trip.error
            ? trip
            : ruleProposal({ ...tx, description: tx.description + ' ' + canonical }, store.rules());
        if (matched.proposal || matched.error)
          plan.updates.push({
            id: tx.id,
            version: tx.version,
            proposal: matched.proposal || null,
            state: matched.proposal ? 'ready' : 'inbox',
            attention: matched.error,
          });
        else needsAI.push(tx.id);
      }
      const aiAllowed = !config().production || !!store.settings().consentAt;
      if (
        needsAI.length &&
        aiAllowed &&
        (store.settings().aiModel === 'gemma-v2' ||
          process.env.OPENAI_API_KEY ||
          process.env.AGENT_MODE === 'mock')
      ) {
        const ai = await askAgent(
          store,
          'Process the selected unfinished transactions. Follow their saved individual instructions and approved rules. Infer only when the evidence is strong; otherwise ask a focused question.',
          needsAI,
          signal,
          undefined,
          job.id,
        );
        plan.updates.push(...ai.updates);
        plan.rules.push(...ai.rules);
        (plan.organization ??= []).push(...(ai.organization || []));
        (plan.requests ??= []).push(...(ai.requests || []));
      } else {
        for (const id of needsAI) {
          const tx = store.transaction(id);
          plan.updates.push({
            id,
            version: tx.version,
            proposal: null,
            state: 'inbox',
            attention: !aiAllowed
              ? 'Enable AI processing in Settings, or enter a split manually.'
              : 'No approved rule matches. Add a rule, edit the split manually, or enable AI with your API key.',
          });
        }
      }
      const next = Math.min(cursor + 20, ids.length);
      plan.message =
        'Processed ' +
        next +
        ' of ' +
        ids.length +
        ' transactions. ' +
        plan.updates.filter((u) => u.state === 'ready').length +
        ' split proposals prepared in this batch. Apply the confirmation card to move them into review.';
      if (signal?.aborted) throw new Error('Job interrupted.');
      applyStep(
        store,
        job.id,
        cursor,
        plan,
        next,
        Math.round((next / Math.max(1, ids.length)) * 100),
        job.leaseToken,
      );
    }
  }
  store.db
    .prepare(
      "UPDATE jobs SET status=CASE WHEN cancelRequested=1 THEN 'cancelled' ELSE 'completed' END,progress=100,activity='',response='',leaseUntil=0,updatedAt=? WHERE id=? AND (leaseToken=? OR leaseToken IS NULL)",
    )
    .run(timestamp(), job.id, job.leaseToken);
}
