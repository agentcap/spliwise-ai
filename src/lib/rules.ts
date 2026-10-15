import { splitAmount } from './money';
import { normalizedDescription } from './importer';
import type { Rule, Transaction, Proposal } from './types';
export function matchingRules(tx: Transaction, rules: Rule[]): Rule[] {
  return rules.filter((r) => {
    const d = r.definition;
    return (
      r.active &&
      (!d.merchant ||
        normalizedDescription(tx.description).includes(normalizedDescription(d.merchant))) &&
      (!d.category || tx.bankCategory.toLowerCase() === d.category.toLowerCase()) &&
      (!d.accountId || d.accountId === tx.accountId) &&
      (!d.from || tx.date >= d.from) &&
      (!d.to || tx.date <= d.to)
    );
  });
}
export function ruleProposal(
  tx: Transaction,
  rules: Rule[],
): { proposal?: Proposal; error?: string } {
  const matches = matchingRules(tx, rules);
  if (!matches.length) return {};
  const specificity = (r: Rule) =>
    (r.definition.from || r.definition.to ? 4 : 0) +
    (r.definition.accountId ? 2 : 0) +
    (r.definition.category ? 1 : 0) +
    (r.definition.merchant ? 1 : 0);
  const max = Math.max(...matches.map(specificity));
  const best = matches.filter((r) => specificity(r) === max);
  const outcomes = new Set(
    best.map((r) => JSON.stringify([r.definition.split, r.definition.outputCategory])),
  );
  if (outcomes.size > 1)
    return {
      error: 'Conflicting rules: ' + best.map((r) => r.title).join(', ') + '. Which should apply?',
    };
  const rule = best[0];
  try {
    return {
      proposal: {
        splits: splitAmount(tx.amountCents, rule.definition.split),
        category: rule.definition.outputCategory,
        confidence: 'high',
        source: 'rule',
        explanation: rule.title,
        ruleId: rule.id,
        ruleVersion: rule.version,
        spec: rule.definition.split,
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Rule split is invalid.' };
  }
}
