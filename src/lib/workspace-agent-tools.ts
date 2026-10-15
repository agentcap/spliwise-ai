import { tool } from '@openai/agents';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from './store';
import type { AgentPlan, AgentProgress } from './agent';
import { splitSchema } from './agent-schemas';
import { Features } from './features';
import { AssistantService } from './assistant-service';
import { expenseActionSchema, type AssistantOperation } from './assistant-contracts';
import { invariant } from './errors';
import { isoDate, splitAmount } from './money';
export function workspaceAgentTools(
  store: Store,
  plan: AgentPlan,
  text: string,
  allowed: Set<string> | undefined,
  onProgress?: (p: AgentProgress) => void,
) {
  const queue = (op: AssistantOperation) => {
    invariant((plan.organization?.length || 0) < 50, 'Too many workspace changes in one request.');
    (plan.organization ??= []).push(op);
    onProgress?.({ activity: 'Organizing your workspace…' });
    return JSON.stringify({
      id: 'id' in op ? op.id : null,
      status: 'Queued; saved atomically when this request completes. No transaction was moved.',
    });
  };
  const people = () => [
    ...store.people(),
    ...(plan.organization || []).filter((o) => o.kind === 'person'),
  ];
  const validateSpec = (spec: z.infer<typeof splitSchema>) => {
    invariant(
      spec.participants.length > 0 && new Set(spec.participants).size === spec.participants.length,
      'Choose distinct participants.',
    );
    for (const id of spec.participants)
      invariant(
        people().some((p) => p.id === id),
        'Unknown participant. Look up or add this person first.',
      );
    const clean = { ...spec, values: spec.values ?? undefined };
    splitAmount(
      clean.mode === 'exact' ? (clean.values || []).reduce((s, n) => s + n, 0) : 10000,
      clean,
    );
    return clean;
  };
  return [
    tool({
      name: 'workspace_summary',
      description:
        'Read balances, current unpaid expenses, repayments, review counts, trips and saved templates. Date filters use expense dates and include repayments received later.',
      parameters: z.object({
        from: z.string().nullable(),
        to: z.string().nullable(),
        personId: z.string().nullable(),
      }),
      execute: async (a) => {
        if (a.from) isoDate(a.from);
        if (a.to) isoDate(a.to);
        invariant(!a.from || !a.to || a.from <= a.to, 'Invalid date range.');
        const dashboard = store.dashboard(a.from || undefined, a.to || undefined);
        return JSON.stringify({
          dashboard: {
            ...dashboard,
            people: dashboard.people
              .filter((p) => !a.personId || p.person.id === a.personId)
              .map((p) => ({ ...p, expenses: p.expenses.slice(0, 100) })),
          },
          trips: new Features(store).snapshot().trips,
          templates: new Features(store).templates(),
          pendingActions: new AssistantService(store)
            .requests()
            .filter((r) => r.status === 'pending')
            .map((r) => ({ id: r.id, kind: r.kind, title: r.title })),
        });
      },
    }),
    tool({
      name: 'manage_saved_context',
      description:
        'Automatically remember, update or forget user-provided facts separately from allocation rules. No approval needed. Facts must quote provided user messages or saved user instructions exactly; never infer sensitive facts. Scope trip/person/date context correctly. Use id and version to update/delete; null creates.',
      parameters: z.object({
        action: z.enum(['save', 'delete']),
        id: z.string().nullable(),
        version: z.number().int().positive().nullable(),
        title: z.string().max(120),
        text: z.string().max(4000),
        quote: z.string().max(4000),
        personId: z.string().nullable(),
        tripId: z.string().nullable(),
        from: z.string().nullable(),
        to: z.string().nullable(),
      }),
      execute: async (a) => {
        if (a.action === 'delete') {
          invariant(a.id && a.version, 'Choose existing context and version.');
          return queue({ kind: 'context', action: 'delete', id: a.id, version: a.version });
        }
        invariant(
          a.title.trim() && a.text.trim() && a.quote && text.includes(a.quote),
          'Remember only a fact quoted from the provided user context.',
        );
        if (a.personId)
          invariant(
            people().some((p) => p.id === a.personId),
            'Unknown person.',
          );
        if (a.tripId)
          invariant(
            new Features(store).trips().some((t) => t.id === a.tripId) ||
              (plan.organization || []).some((o) => o.kind === 'trip' && o.id === a.tripId),
            'Unknown trip.',
          );
        return queue({
          ...a,
          kind: 'context',
          action: 'save',
          id: a.id || randomUUID(),
          version: a.id ? a.version : null,
        });
      },
    }),
    tool({
      name: 'manage_trip',
      description:
        'Create or edit a trip automatically from user context, with dates, people, default split and trip-only notes. Ask only when essential details are missing. Search existing trips first to avoid duplicates. Does not assign or move expenses. For archive/reopen provide existing id/version; other fields can be null.',
      parameters: z.object({
        action: z.enum(['save', 'archive', 'reopen']),
        id: z.string().nullable(),
        version: z.number().int().positive().nullable(),
        name: z.string().max(100).nullable(),
        destination: z.string().max(150).nullable(),
        from: z.string().nullable(),
        to: z.string().nullable(),
        split: splitSchema.nullable(),
        context: z.string().max(4000).nullable(),
      }),
      execute: async (a) => {
        if (a.action !== 'save') {
          invariant(a.id && a.version, 'Choose an existing trip.');
          return queue({ kind: 'trip', action: a.action, id: a.id, version: a.version });
        }
        invariant(
          a.name?.trim() && a.from && a.to && a.split,
          'Provide a trip name, dates and participants.',
        );
        isoDate(a.from);
        isoDate(a.to);
        invariant(a.from <= a.to, 'Trip dates are reversed.');
        const id = a.id || randomUUID(),
          split = validateSpec(a.split);
        return queue({
          kind: 'trip',
          action: 'save',
          id,
          version: a.id ? a.version : null,
          name: a.name!,
          destination: a.destination || '',
          from: a.from,
          to: a.to,
          split,
          context: a.context || '',
        });
      },
    }),
    tool({
      name: 'add_person',
      description:
        'Add a person the user clearly names, with a unique handle and optional relationship. Reuse existing people first. Never invent a participant or relationship. Returns a stable ID usable in the same request.',
      parameters: z.object({
        name: z.string().min(1).max(80),
        handle: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/),
        relation: z.string().max(150),
      }),
      execute: async (a) => {
        const existing = people().find((p) => p.handle.toLowerCase() === a.handle.toLowerCase());
        if (existing) return JSON.stringify(existing);
        return queue({ kind: 'person', id: randomUUID(), ...a, handle: a.handle.toLowerCase() });
      },
    }),
    tool({
      name: 'remove_or_optimize_rules',
      description:
        'Automatically delete an obsolete rule by id/version or merge exact duplicates and compatible rules locally. Conflicting splits are retained for clarification. No approval required. Existing transaction states and allocations stay untouched.',
      parameters: z.object({
        action: z.enum(['delete', 'optimize']),
        id: z.string().nullable(),
        version: z.number().int().positive().nullable(),
      }),
      execute: async (a) => {
        if (a.action === 'optimize') return queue({ kind: 'rule', action: 'optimize' });
        invariant(a.id && a.version, 'Choose an existing rule and version.');
        return queue({ kind: 'rule', action: 'delete', id: a.id, version: a.version });
      },
    }),
    tool({
      name: 'save_split_template',
      description:
        'Save a named split template automatically. It is applied to expenses only when requested. Use null id/version to create.',
      parameters: z.object({
        id: z.string().nullable(),
        version: z.number().int().positive().nullable(),
        name: z.string().min(1).max(80),
        split: splitSchema,
        category: z.string().min(1).max(80),
      }),
      execute: async (a) =>
        queue({
          kind: 'template',
          id: a.id || randomUUID(),
          version: a.id ? a.version : null,
          name: a.name,
          spec: validateSpec(a.split),
          category: a.category,
        }),
    }),
    tool({
      name: 'name_merchant',
      description:
        'Save a readable merchant name automatically while retaining the original statement description. Reuse existing aliases.',
      parameters: z.object({
        pattern: z.string().min(2).max(200),
        name: z.string().min(1).max(80),
      }),
      execute: async (a) => queue({ kind: 'alias', id: randomUUID(), ...a }),
    }),
    tool({
      name: 'prepare_expense_action',
      description:
        'Prepare an explicit user-confirmation card to assign selected unfinished expenses to a trip, create a manual USD expense the user paid, or record a repayment. Never executes financial actions. Dates YYYY-MM-DD; amounts integer cents. Return the card and ask the user to confirm it.',
      parameters: z.object({ action: expenseActionSchema }),
      execute: async ({ action }) => {
        // New trips/people are validated against the pending local changes, then rechecked on commit/application.
        if (action.kind === 'assignment')
          for (const item of action.items) {
            const tx = store.transaction(item.id);
            invariant(
              tx.state !== 'finalized' && (!allowed || allowed.has(item.id)),
              'Only unfinished expenses in scope can be proposed.',
            );
            invariant(tx.version === item.version, 'Stale expense.');
          }
        else isoDate(action.date);
        (plan.requests ??= []).push(action);
        return 'Confirmation card queued. Nothing has been assigned, created or repaid yet. Tell the user to review the card.';
      },
    }),
  ];
}
