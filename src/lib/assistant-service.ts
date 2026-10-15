import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store';
import { Features, tripSchema } from './features';
import { invariant } from './errors';
import { isoDate, splitAmount } from './money';
import { definitionKey, normalizeMerchant } from './rule-definition';
import { optimizeRules } from './rule-optimizer';
import type {
  AssistantOperation,
  AssistantEvent,
  AssistantRequest,
  ExpenseAction,
  SplitUpdate,
  UserContext,
} from './assistant-contracts';
import { expenseActionSchema } from './assistant-contracts';
const now = () => new Date().toISOString();
export function trustedUserText(store: Store, text: string, ids?: string[]) {
  const history = store
    .all<{ text: string }>(
      "SELECT text FROM messages WHERE role='user' ORDER BY createdAt DESC,rowid DESC LIMIT 8",
    )
    .map((m) => m.text);
  const notes = (ids || [])
    .slice(0, 200)
    .flatMap((id) => store.transaction(id).notes.map((n) => n.text));
  return [text, ...history, ...notes].join('\n');
}
const validId = (id: string) => z.string().min(1).max(80).parse(id);
export class AssistantService {
  constructor(public store: Store) {}
  contexts(): UserContext[] {
    return this.store.all('SELECT * FROM user_context ORDER BY updatedAt DESC,id');
  }
  events(): AssistantEvent[] {
    return this.store.all(
      'SELECT e.*,b.undoneAt FROM (SELECT rowid AS eventOrder,* FROM assistant_events ORDER BY createdAt DESC,rowid DESC LIMIT 500) e JOIN action_batches b ON b.id=e.batchId ORDER BY e.createdAt,e.eventOrder',
    );
  }
  requests(): AssistantRequest[] {
    return this.store
      .all<Record<string, unknown>>(
        "SELECT * FROM assistant_requests WHERE status='pending' OR id IN(SELECT id FROM assistant_requests ORDER BY createdAt DESC LIMIT 100) ORDER BY createdAt,id",
      )
      .map((r) => ({
        ...r,
        payload: JSON.parse(String(r.payload)),
        reviewState: this.reviewStatus(r),
      })) as unknown as AssistantRequest[];
  }

  private reviewStatus(row: Record<string, unknown>): AssistantRequest['reviewState'] {
    if (row.kind !== 'splits' || row.status !== 'applied' || !row.batchId) return;
    const batch = this.store.one<{ undo: string; undoneAt: string | null }>(
      'SELECT undo,undoneAt FROM action_batches WHERE id=?',
      row.batchId,
    );
    if (!batch) return 'changed';
    if (batch.undoneAt) return 'undone';
    const updates = (
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    ) as SplitUpdate[];
    const ready = updates.filter((u) => u.state === 'ready' && u.proposal);
    if (!ready.length) return;
    const before = JSON.parse(batch.undo) as { id: string; before: { version: number } | null }[];
    try {
      const current = ready.map((u) => ({ u, t: this.store.transaction(u.id) }));
      if (
        current.every(
          ({ u, t }) =>
            t.state === 'finalized' && JSON.stringify(t.proposal) === JSON.stringify(u.proposal),
        )
      )
        return 'finalized';
      return current.every(
        ({ u, t }) =>
          t.state === 'ready' &&
          t.version === (before.find((e) => e.id === u.id)?.before?.version || 0) + 1 &&
          JSON.stringify(t.proposal) === JSON.stringify(u.proposal),
      )
        ? 'ready'
        : 'changed';
    } catch {
      return 'changed';
    }
  }
  finalizeRequest(id: string, actor: 'user' | 'agent' = 'user') {
    invariant(actor === 'user', 'Only you can finalize splits.', 403);
    return this.store.db
      .transaction(() => {
        const row = this.store.one<Record<string, unknown>>(
          'SELECT * FROM assistant_requests WHERE id=?',
          id,
        );
        invariant(row, 'Request not found.', 404);
        const status = this.reviewStatus(row);
        if (status === 'finalized') return { ok: true, alreadyFinalized: true };
        invariant(
          status === 'ready',
          'These expenses changed. Review the latest splits before finalizing.',
          409,
        );
        const updates = JSON.parse(String(row.payload)) as SplitUpdate[];
        this.store.review(
          updates
            .filter((u) => u.state === 'ready' && u.proposal)
            .map((u) => {
              const t = this.store.transaction(u.id);
              return { id: t.id, version: t.version };
            }),
          'approve',
          '',
          'user',
        );
        return { ok: true };
      })
      .immediate();
  }
  private dates(from: string | null, to: string | null) {
    if (from) isoDate(from);
    if (to) isoDate(to);
    invariant(!from || !to || from <= to, 'Start date must precede end date.');
  }
  private spec(spec: Parameters<Store['validateRule']>[0]['split']) {
    this.store.validateRule({ merchant: 'Trip default', outputCategory: 'Travel', split: spec });
    splitAmount(
      spec.mode === 'exact' ? (spec.values || []).reduce((a, b) => a + b, 0) : 10000,
      spec,
    );
  }
  applyOperation(op: AssistantOperation, jobId: string, index: number, sourceText: string) {
    return this.store.db.transaction(() => this.apply(op, jobId, index, sourceText)).immediate();
  }
  private apply(op: AssistantOperation, jobId: string, index: number, sourceText: string) {
    invariant(Number.isSafeInteger(index) && index >= 0, 'Invalid assistant step.');
    const stepKey = jobId + ':organization:' + index;
    if (this.store.one('SELECT id FROM action_batches WHERE stepKey=?', stepKey)) return;
    type Entity = Parameters<Store['batch']>[2][number];
    let refs: Entity[] = [],
      title = '',
      detail = '',
      targetId = 'id' in op ? validId(op.id) : 'rules';
    let work: () => void = () => {};
    const version = (table: string, id: string, expected: number | null) => {
      const old = this.store.one<{ version: number }>(
        'SELECT version FROM ' + table + ' WHERE id=?',
        id,
      );
      invariant(
        expected === null ? !old : old?.version === expected,
        'This record changed. Ask again with the latest information.',
        409,
      );
      return old;
    };
    const nextVersion = () =>
      this.store.one<{ n: number }>('SELECT COALESCE(MAX(sequence),0)+1 n FROM action_batches')!.n;
    if (op.kind === 'rule') {
      if (op.action === 'optimize') {
        const preview = optimizeRules(this.store.rules()),
          groups = preview.groups;
        for (const g of groups) this.store.validateRule(g.definition);
        refs = groups.flatMap((g) => g.rules.map((r) => ({ table: 'rules' as const, id: r.id })));
        title = 'Optimized reusable rules';
        detail =
          groups.length +
          ' duplicate or compatible groups merged. ' +
          preview.conflicts.length +
          ' conflicts kept separate. Existing transaction proposals were left for review.';
        work = () => {
          for (const g of groups) {
            this.store.db
              .prepare('UPDATE rules SET title=?,definition=?,version=?,active=1 WHERE id=?')
              .run(g.title, JSON.stringify(g.definition), nextVersion(), g.keepRuleId);
            for (const r of g.rules)
              if (r.id !== g.keepRuleId)
                this.store.db
                  .prepare('UPDATE rules SET active=0,version=? WHERE id=?')
                  .run(nextVersion(), r.id);
          }
        };
      } else if (op.action === 'delete') {
        version('rules', op.id, op.version);
        invariant(
          this.store.rules().some((r) => r.id === op.id && r.active),
          'Rule is no longer active.',
          409,
        );
        refs = [{ table: 'rules', id: op.id }];
        title = 'Removed reusable rule';
        detail = 'Future processing uses the remaining rules. Existing splits are unchanged.';
        work = () => {
          this.store.db
            .prepare('UPDATE rules SET active=0,version=? WHERE id=?')
            .run(nextVersion(), op.id);
        };
      } else {
        this.store.validateRule(op.definition);
        z.string().trim().min(1).max(160).parse(op.title);
        version('rules', op.id, op.version);
        const duplicate = this.store
          .rules()
          .find(
            (r) =>
              r.active &&
              r.id !== op.id &&
              definitionKey(r.definition) === definitionKey(op.definition),
          );
        if (duplicate) {
          targetId = duplicate.id;
          title = 'Rule already remembered';
          detail = duplicate.title;
        } else {
          const changeId = randomUUID();
          refs = [
            { table: 'rules', id: op.id },
            { table: 'rule_changes', id: changeId },
          ];
          title = (op.version === null ? 'Remembered rule: ' : 'Updated rule: ') + op.title;
          detail =
            'Active for future processing. Existing proposals and finalized allocations are unchanged.';
          work = () => {
            this.store.db
              .prepare(
                'INSERT INTO rules(id,title,definition,version,active) VALUES(?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET title=excluded.title,definition=excluded.definition,version=excluded.version,active=1',
              )
              .run(op.id, op.title, JSON.stringify(op.definition), nextVersion());
            this.store.db
              .prepare(
                "INSERT INTO rule_changes(id,ruleId,title,definition,status,baseVersion) VALUES(?,?,?,?,'auto-applied',?)",
              )
              .run(changeId, op.id, op.title, JSON.stringify(op.definition), op.version);
          };
        }
      }
    } else if (op.kind === 'context') {
      version('user_context', op.id, op.version);
      refs = [{ table: 'user_context', id: op.id }];
      if (op.action === 'delete') {
        title = 'Forgot saved context';
        detail = 'Removed from future assistant context.';
        work = () => {
          this.store.db.prepare('DELETE FROM user_context WHERE id=?').run(op.id);
        };
      } else {
        z.string().trim().min(1).max(120).parse(op.title);
        z.string().trim().min(1).max(4000).parse(op.text);
        invariant(
          op.quote.length > 0 && sourceText.includes(op.quote),
          'Save only facts supplied in the current user message.',
        );
        if (op.personId)
          invariant(
            this.store.people().some((p) => p.id === op.personId),
            'Unknown person.',
          );
        if (op.tripId) new Features(this.store).trip(op.tripId);
        this.dates(op.from, op.to);
        const duplicate = this.contexts().find(
          (c) =>
            c.id !== op.id &&
            c.text.trim().toLowerCase() === op.text.trim().toLowerCase() &&
            c.personId === op.personId &&
            c.tripId === op.tripId &&
            c.from === op.from &&
            c.to === op.to,
        );
        if (duplicate) {
          refs = [];
          targetId = duplicate.id;
          title = 'Context already remembered';
          detail = duplicate.title;
        } else {
          title = 'Remembered: ' + op.title;
          detail = op.text;
          work = () => {
            this.store.db
              .prepare(
                'INSERT INTO user_context(id,title,text,quote,personId,tripId,"from","to",version,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,text=excluded.text,quote=excluded.quote,personId=excluded.personId,tripId=excluded.tripId,"from"=excluded."from","to"=excluded."to",version=user_context.version+1,updatedAt=excluded.updatedAt',
              )
              .run(
                op.id,
                op.title,
                op.text,
                op.quote,
                op.personId,
                op.tripId,
                op.from,
                op.to,
                1,
                now(),
                now(),
              );
          };
        }
      }
    } else if (op.kind === 'trip') {
      version('trips', op.id, op.version);
      refs = [{ table: 'trips', id: op.id }];
      if (op.action === 'save') {
        const a = tripSchema.parse({ ...op, version: op.version ?? undefined });
        this.dates(a.from, a.to);
        this.spec(a.split);
        this.store.resolveMentions(a.context);
        title = (op.version === null ? 'Created trip: ' : 'Updated trip: ') + op.name;
        detail = op.from + ' – ' + op.to + '. ' + op.context;
        work = () => {
          this.store.db
            .prepare(
              'INSERT INTO trips(id,name,destination,"from","to",participants,split,context,createdAt) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,destination=excluded.destination,"from"=excluded."from","to"=excluded."to",participants=excluded.participants,split=excluded.split,context=excluded.context,version=trips.version+1',
            )
            .run(
              op.id,
              op.name,
              op.destination,
              op.from,
              op.to,
              JSON.stringify(op.split.participants),
              JSON.stringify(op.split),
              op.context,
              now(),
            );
        };
      } else {
        if (op.action === 'archive')
          invariant(
            !this.store.one(
              "SELECT id FROM transactions WHERE tripId=? AND state!='finalized' LIMIT 1",
              op.id,
            ),
            'Review every trip expense before archiving.',
          );
        title = op.action === 'archive' ? 'Archived trip' : 'Reopened trip';
        detail = 'Transaction allocations are unchanged.';
        work = () => {
          this.store.db
            .prepare('UPDATE trips SET status=?,version=version+1 WHERE id=?')
            .run(op.action === 'archive' ? 'archived' : 'active', op.id);
        };
      }
    } else if (op.kind === 'person') {
      const name = z.string().trim().min(1).max(80).parse(op.name),
        handle = z
          .string()
          .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/)
          .parse(op.handle)
          .toLowerCase(),
        relation = z.string().max(150).parse(op.relation);
      const existing = this.store.people().find((p) => p.handle.toLowerCase() === handle);
      if (existing) {
        targetId = existing.id;
        title = 'Person already exists';
        detail = existing.name;
      } else {
        invariant(
          !this.store.one('SELECT id FROM people WHERE id=?', op.id),
          'Person ID already exists.',
          409,
        );
        refs = [{ table: 'people', id: op.id }];
        title = 'Added ' + name;
        detail = '@' + handle + (relation ? ' · ' + relation : '');
        work = () => {
          this.store.db
            .prepare('INSERT INTO people(id,name,handle,relation,isSelf) VALUES(?,?,?,?,0)')
            .run(op.id, name, handle, relation);
        };
      }
    } else if (op.kind === 'template') {
      version('split_templates', op.id, op.version);
      this.spec(op.spec);
      z.string().trim().min(1).max(80).parse(op.name);
      z.string().trim().min(1).max(80).parse(op.category);
      refs = [{ table: 'split_templates', id: op.id }];
      title = 'Saved template: ' + op.name;
      detail = 'Apply it to expenses whenever needed.';
      work = () => {
        this.store.db
          .prepare(
            'INSERT INTO split_templates(id,name,spec,category) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,spec=excluded.spec,category=excluded.category,version=split_templates.version+1',
          )
          .run(op.id, op.name, JSON.stringify(op.spec), op.category);
      };
    } else {
      const pattern = normalizeMerchant(op.pattern);
      z.string().min(2).max(200).parse(pattern);
      z.string().trim().min(1).max(80).parse(op.name);
      const existing = new Features(this.store).aliases().find((a) => a.pattern === pattern);
      invariant(
        !existing || existing.name === op.name,
        'That merchant already has a different name. Ask to remove it first.',
        409,
      );
      refs = existing ? [] : [{ table: 'merchant_aliases', id: op.id }];
      targetId = existing?.id || op.id;
      title = 'Named merchant: ' + op.name;
      detail = 'Original statement descriptions are preserved.';
      work = () => {
        if (!existing)
          this.store.db
            .prepare('INSERT INTO merchant_aliases(id,pattern,name) VALUES(?,?,?)')
            .run(op.id, pattern, op.name);
      };
    }
    const batchId = this.store.batch(
      'agent',
      title,
      refs,
      (id) => {
        work();
        return id;
      },
      stepKey,
    );
    if (batchId)
      this.store.db
        .prepare(
          'INSERT INTO assistant_events(id,jobId,kind,targetId,title,detail,batchId,createdAt) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(randomUUID(), jobId, op.kind, targetId, title, detail, batchId, now());
  }

  queue(jobId: string, kind: AssistantRequest['kind'], payload: unknown, title: string) {
    const id = randomUUID();
    if (kind === 'assignment' || kind === 'expense') {
      const a = payload as ExpenseAction;
      payload = {
        ...a,
        tripName:
          'tripId' in a && a.tripId ? new Features(this.store).trip(a.tripId).name : undefined,
        tripVersion:
          'tripId' in a && a.tripId ? new Features(this.store).trip(a.tripId).version : undefined,
        ...(a.kind === 'assignment'
          ? {
              expenses: a.items.map((i) => {
                const t = this.store.transaction(i.id);
                return {
                  id: t.id,
                  description: t.description,
                  date: t.date,
                  amountCents: t.amountCents,
                };
              }),
            }
          : {}),
      };
    }
    this.store.db
      .prepare(
        "INSERT INTO assistant_requests(id,jobId,kind,payload,title,status,createdAt) VALUES(?,?,?,?,?,'pending',?)",
      )
      .run(id, jobId, kind, JSON.stringify(payload), title, now());
    return id;
  }
  applyRequest(id: string, actor: 'user' | 'agent' = 'user') {
    invariant(actor === 'user', 'Only you can approve transaction actions.', 403);
    return this.store.db
      .transaction(() => {
        const row = this.store.one<AssistantRequest & { payload: string }>(
          'SELECT * FROM assistant_requests WHERE id=?',
          id,
        );
        invariant(row, 'Request not found.', 404);
        if (row.status === 'applied') return { ok: true, alreadyApplied: true };
        invariant(row.status === 'pending', 'This request was dismissed.', 409);
        const payload = JSON.parse(row.payload);
        if (payload.tripId && payload.tripVersion)
          invariant(
            new Features(this.store).trip(payload.tripId).version === payload.tripVersion,
            'Trip changed since this card was prepared. Ask for a refreshed action.',
            409,
          );
        if (row.kind === 'splits') {
          const items = payload as SplitUpdate[];
          invariant(items.length > 0 && items.length <= 100, 'Choose up to 100 proposals.');
          for (const item of items)
            invariant(
              this.store.transaction(item.id).state !== 'finalized',
              'Finalized expenses cannot be changed by this proposal.',
              403,
            );
          for (const item of items)
            if (item.proposal)
              this.store.validateProposal(this.store.transaction(item.id), item.proposal, true);
          this.store.saveProposals(items, 'user');
        } else {
          const action = expenseActionSchema.parse({ ...payload, kind: row.kind });
          const features = new Features(this.store);
          if (action.kind === 'assignment') features.assign(action.items, action.tripId);
          else if (action.kind === 'expense') features.manual({ ...action, requestId: id });
          else
            this.store.addRepayment(
              action.personId,
              action.date,
              action.amountCents,
              action.direction,
              action.note,
              'user',
              id,
            );
        }
        const batch = this.store.one<{ id: string }>(
          'SELECT id FROM action_batches ORDER BY sequence DESC LIMIT 1',
        )!;
        this.store.db
          .prepare("UPDATE assistant_requests SET status='applied',batchId=? WHERE id=?")
          .run(batch.id, id);
        return { ok: true };
      })
      .immediate();
  }
  dismissRequest(id: string) {
    invariant(
      this.store.db
        .prepare("UPDATE assistant_requests SET status='dismissed' WHERE id=? AND status='pending'")
        .run(id).changes === 1,
      'Pending request not found.',
      409,
    );
  }
  validateExpenseAction(action: ExpenseAction, allowed?: Set<string>) {
    const f = new Features(this.store);
    if (action.kind === 'assignment') {
      if (action.tripId) f.trip(action.tripId);
      for (const item of action.items) {
        const tx = this.store.transaction(item.id);
        invariant(!allowed || allowed.has(item.id), 'Expense is outside the selected scope.', 403);
        invariant(
          tx.state !== 'finalized',
          'Finalized expenses can only be organized manually.',
          403,
        );
        invariant(tx.version === item.version, 'Expense changed.', 409);
      }
    } else {
      isoDate(action.date);
      if (action.kind === 'expense') {
        if (action.tripId) f.trip(action.tripId);
        this.store.resolveMentions(action.note);
      } else
        invariant(
          this.store.people().some((p) => p.id === action.personId && !p.isSelf),
          'Choose an existing person.',
        );
    }
  }
}
