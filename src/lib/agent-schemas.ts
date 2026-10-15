import { z } from 'zod';
import type { RuleDefinition } from './types';
export const splitSchema = z.object({
  mode: z.enum(['personal', 'equal', 'exact', 'percent']),
  participants: z.array(z.string()).max(30),
  values: z.array(z.number().int()).nullable(),
});
export const ruleDefinitionSchema = z.object({
  merchant: z.string().max(200),
  merchantAliases: z.array(z.string().min(1).max(200)).max(199).nullable(),
  category: z.string().nullable(),
  accountId: z.string().nullable(),
  from: z.string().nullable(),
  to: z.string().nullable(),
  split: splitSchema,
  outputCategory: z.string().min(1).max(80),
});
export function cleanRule(d: z.infer<typeof ruleDefinitionSchema>): RuleDefinition {
  return {
    merchant: d.merchant,
    merchantAliases: d.merchantAliases || undefined,
    category: d.category || undefined,
    accountId: d.accountId || undefined,
    from: d.from || undefined,
    to: d.to || undefined,
    split: { ...d.split, values: d.split.values || undefined },
    outputCategory: d.outputCategory,
  };
}
