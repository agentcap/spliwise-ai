import { splitAmount } from './money';
import { merchantPatterns, normalizeMerchant, outcomeKey, specificity } from './rule-definition';
import type { Rule, Transaction, Proposal } from './types';
export function matchingRules(tx: Transaction, rules: Rule[]): Rule[] {
  return rules.filter((r) => {
    const d = r.definition;
    return (
      r.active &&
      (!merchantPatterns(d).length ||
        merchantPatterns(d).some((pattern) =>
          normalizeMerchant(tx.description).includes(pattern),
        )) &&
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
  const max = Math.max(...matches.map((rule) => specificity(rule.definition)));
  const best = matches.filter((r) => specificity(r.definition) === max);
  const outcomes = new Set(best.map((r) => outcomeKey(r.definition)));
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
