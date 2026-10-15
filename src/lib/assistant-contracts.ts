import { z } from 'zod';
import type { Proposal, RuleDefinition, SplitSpec } from './types';

export interface UserContext {
  id: string;
  title: string;
  text: string;
  quote: string;
  personId: string | null;
  tripId: string | null;
  from: string | null;
  to: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface AssistantEvent {
  id: string;
  jobId: string;
  kind: string;
  targetId: string;
  title: string;
  detail: string;
  batchId: string;
  createdAt: string;
  undoneAt: string | null;
}
export interface AssistantRequest {
  id: string;
  jobId: string;
  kind: 'splits' | 'assignment' | 'expense' | 'repayment';
  payload: unknown;
  title: string;
  status: 'pending' | 'applied' | 'dismissed';
  createdAt: string;
  batchId: string | null;
  reviewState?: 'ready' | 'finalized' | 'changed' | 'undone';
}
export type AssistantOperation =
  | {
      kind: 'rule';
      action: 'save';
      id: string;
      version: number | null;
      title: string;
      definition: RuleDefinition;
    }
  | { kind: 'rule'; action: 'delete'; id: string; version: number }
  | { kind: 'rule'; action: 'optimize' }
  | {
      kind: 'context';
      action: 'save';
      id: string;
      version: number | null;
      title: string;
      text: string;
      quote: string;
      personId: string | null;
      tripId: string | null;
      from: string | null;
      to: string | null;
    }
  | { kind: 'context'; action: 'delete'; id: string; version: number }
  | {
      kind: 'trip';
      action: 'save';
      id: string;
      version: number | null;
      name: string;
      destination: string;
      from: string;
      to: string;
      split: SplitSpec;
      context: string;
    }
  | { kind: 'trip'; action: 'archive' | 'reopen'; id: string; version: number }
  | { kind: 'person'; id: string; name: string; handle: string; relation: string }
  | {
      kind: 'template';
      id: string;
      version: number | null;
      name: string;
      spec: SplitSpec;
      category: string;
    }
  | { kind: 'alias'; id: string; pattern: string; name: string };
export type SplitUpdate = {
  id: string;
  version: number;
  proposal: Proposal | null;
  state: 'inbox' | 'ready';
  attention?: string;
  context?: string;
};
export const referenceItems = z
  .array(z.object({ id: z.string().min(1), version: z.number().int().positive() }))
  .min(1)
  .max(100);
export const expenseActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('assignment'), items: referenceItems, tripId: z.string().nullable() }),
  z.object({
    kind: z.literal('expense'),
    description: z.string().trim().min(1).max(200),
    date: z.string(),
    amountCents: z.number().int().positive().safe().max(1_000_000_000_000),
    category: z.string().min(1).max(80),
    note: z.string().max(4000),
    tripId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal('repayment'),
    personId: z.string(),
    date: z.string(),
    amountCents: z.number().int().positive().safe(),
    direction: z.enum(['received', 'returned']),
    note: z.string().max(4000),
  }),
]);
export type ExpenseAction = z.infer<typeof expenseActionSchema>;
