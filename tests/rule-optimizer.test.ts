import { describe, expect, it } from 'vitest';
import { optimizeRules } from '../src/lib/rule-optimizer';
import { ruleProposal } from '../src/lib/rules';
import type { Rule, Transaction } from '../src/lib/types';

const rule = (id: string, merchant: string, extra: Partial<Rule['definition']> = {}): Rule => ({
  id,
  title: id,
  active: 1,
  version: 1,
  definition: {
    merchant,
    outputCategory: 'Food & Drink',
    split: { mode: 'equal', participants: ['self', 'alex'] },
    ...extra,
  },
});
const tx = (
  description: string,
  amountCents: number,
  accountId = 'sapphire',
  date = '2026-02-10',
) =>
  ({
    id: description,
    description,
    amountCents,
    accountId,
    date,
    bankCategory: 'Food & Drink',
  }) as Transaction;
function result(transaction: Transaction, rules: Rule[]) {
  const { proposal, error } = ruleProposal(transaction, rules);
  return proposal
    ? [proposal.category, [...proposal.splits].sort((a, b) => a.personId.localeCompare(b.personId))]
    : error
      ? ['error', /Conflicting/.test(error) ? 'conflict' : error]
      : [];
}
function optimized(rules: Rule[]) {
  const groups = optimizeRules(rules).groups;
  return [
    ...rules.filter((r) => !groups.some((g) => g.rules.some((member) => member.id === r.id))),
    ...groups.map((g) => ({
      id: g.keepRuleId,
      title: g.title,
      active: 1,
      version: 2,
      definition: g.definition,
    })),
  ];
}
describe('local rule optimization', () => {
  it('recognizes duplicate rules despite participant order, case and whitespace', () => {
    const a = rule('a', '  COFFEE SHOP  ');
    const b = rule('b', 'coffee   shop', {
      split: { mode: 'equal', participants: ['alex', 'self'] },
    });
    const preview = optimizeRules([a, b]);
    expect(preview.groups).toHaveLength(1);
    expect(preview.groups[0]).toMatchObject({ kind: 'duplicates', duplicateCount: 1 });
    expect(ruleProposal(tx('COFFEE SHOP', 101), [a, b]).error).toBeUndefined();
    expect(result(tx('COFFEE SHOP', 101), [a, b])).toEqual(
      result(tx('COFFEE SHOP', 101), optimized([a, b])),
    );
  });
  it('pairs exact and percentage values with IDs when canonicalizing participants', () => {
    for (const mode of ['exact', 'percent'] as const) {
      const values = mode === 'exact' ? [1200, 800] : [6000, 4000];
      const a = rule('a', 'COFFEE', { split: { mode, participants: ['self', 'alex'], values } });
      const b = rule('b', 'COFFEE', {
        split: { mode, participants: ['alex', 'self'], values: [...values].reverse() },
      });
      expect(optimizeRules([a, b]).groups[0].kind).toBe('duplicates');
      expect(result(tx('COFFEE', 2000), [a, b])).toEqual(
        result(tx('COFFEE', 2000), optimized([a, b])),
      );
    }
  });
  it('merges merchant alternatives while preserving matches, rounding, scope precedence and conflicts', () => {
    const rules = [
      rule('a', 'COFFEE'),
      rule('b', 'TEA'),
      rule('c', 'COFFEE SHOP'),
      rule('d', 'COFFEE', {
        accountId: 'amex',
        split: { mode: 'personal', participants: ['self'] },
      }),
      rule('e', 'TEA', {
        from: '2026-03-01',
        to: '2026-03-31',
        split: { mode: 'personal', participants: ['self'] },
      }),
      rule('f', 'COFFEE SHOP', { split: { mode: 'personal', participants: ['self'] } }),
    ];
    const after = optimized(rules);
    expect(optimizeRules(rules).groups[0].definition.merchantAliases).toContain('TEA');
    for (const description of ['COFFEE', 'COFFEE SHOP', 'TEA', 'COFFEE AND TEA', 'OTHER']) {
      for (const amount of [1, 101, 2000, -101]) {
        for (const account of ['sapphire', 'amex']) {
          for (const date of ['2026-02-10', '2026-03-10']) {
            expect(result(tx(description, amount, account, date), after)).toEqual(
              result(tx(description, amount, account, date), rules),
            );
          }
        }
      }
    }
    expect(optimizeRules(rules).conflicts.length).toBeGreaterThan(0);
  });
  it('keeps differing scopes, output categories and split instructions separate', () => {
    const rules = [
      rule('a', 'COFFEE'),
      rule('b', 'COFFEE', { accountId: 'amex' }),
      rule('c', 'COFFEE', { from: '2026-01-01', to: '2026-01-31' }),
      rule('d', 'COFFEE', { outputCategory: 'Groceries' }),
      rule('e', 'COFFEE', { split: { mode: 'personal', participants: ['self'] } }),
      rule('g', 'COFFEE', { outputCategory: 'Food & Drink ' }),
      rule('f', ''), // A blanket rule has lower precedence than a merchant rule.
    ];
    expect(optimizeRules(rules).groups).toEqual([]);
    expect(optimizeRules(rules).conflicts.some((c) => c.titles.includes('d'))).toBe(true);
  });
  it('handles empty and already optimized rulebooks without proposing new changes', () => {
    expect(optimizeRules([])).toMatchObject({ groups: [], scannedCount: 0 });
    const after = optimized([rule('a', 'COFFEE'), rule('b', 'TEA')]);
    expect(optimizeRules(after).groups).toHaveLength(0);
    expect(ruleProposal(tx('TEA', 101), after).proposal?.splits).toHaveLength(2);
  });
});
