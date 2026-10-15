import type { Rule, RuleOptimizationGroup, RuleOptimizationPreview } from './types';
import {
  canonicalSplit,
  definitionKey,
  merchantPatterns,
  outcomeKey,
  scopeKey,
  specificity,
} from './rule-definition';

function overlaps(a: Rule, b: Rule) {
  const x = a.definition,
    y = b.definition;
  if (x.accountId && y.accountId && x.accountId !== y.accountId) return false;
  if (x.category && y.category && x.category.toLowerCase() !== y.category.toLowerCase())
    return false;
  if ((x.to && y.from && x.to < y.from) || (y.to && x.from && y.to < x.from)) return false;
  const p = merchantPatterns(x),
    q = merchantPatterns(y);
  return !p.length || !q.length || p.some((s) => q.some((t) => s.includes(t) || t.includes(s)));
}
export function optimizeRules(rules: Rule[]): Omit<RuleOptimizationPreview, 'revision'> {
  const active = rules.filter((rule) => rule.active).sort((a, b) => a.id.localeCompare(b.id));
  const buckets = new Map<string, Rule[]>();
  for (const rule of active) {
    const key = scopeKey(rule.definition) + outcomeKey(rule.definition);
    buckets.set(key, [...(buckets.get(key) || []), rule]);
  }
  const groups: RuleOptimizationGroup[] = [];
  function addGroup(items: Rule[]) {
    if (items.length < 2) return;
    const sorted = [...items].sort((a, b) => b.version - a.version || a.id.localeCompare(b.id));
    const keep = sorted[0];
    const patterns = [
      ...new Set(items.flatMap((rule) => merchantPatterns(rule.definition))),
    ].sort();
    // Substrings covered by a broader existing alternative add no new matches.
    const minimal = patterns.filter(
      (pattern) => !patterns.some((other) => other !== pattern && pattern.includes(other)),
    );
    const distinct = new Set(items.map((rule) => definitionKey(rule.definition))).size;
    const kind = distinct === 1 ? 'duplicates' : 'merge';
    groups.push({
      id: 'group:' + keep.id,
      kind,
      rules: sorted,
      keepRuleId: keep.id,
      title:
        kind === 'duplicates'
          ? keep.title
          : (keep.definition.outputCategory + ' · ' + keep.definition.split.mode + ' split').slice(
              0,
              160,
            ),
      definition: {
        ...keep.definition,
        merchant: minimal[0] || '',
        merchantAliases: minimal.length > 1 ? minimal.slice(1) : undefined,
        split: canonicalSplit(keep.definition.split),
      },
      duplicateCount: items.length - distinct,
      rebindCount: 0,
      resetCount: 0,
    });
  }
  for (const items of buckets.values()) {
    if (new Set(items.flatMap((rule) => merchantPatterns(rule.definition))).size <= 200)
      addGroup(items);
    else {
      const duplicates = new Map<string, Rule[]>();
      for (const rule of items) {
        const key = definitionKey(rule.definition);
        duplicates.set(key, [...(duplicates.get(key) || []), rule]);
      }
      for (const exact of duplicates.values()) addGroup(exact);
    }
  }
  const conflicts: RuleOptimizationPreview['conflicts'] = [];
  for (let i = 0; i < active.length; i++) {
    for (const other of active.slice(i + 1)) {
      const rule = active[i];
      if (
        specificity(rule.definition) === specificity(other.definition) &&
        outcomeKey(rule.definition) !== outcomeKey(other.definition) &&
        overlaps(rule, other)
      ) {
        conflicts.push({
          titles: [rule.title, other.title],
          reason:
            'These equally specific rules overlap but use different splits or categories. Kept separate for your review.',
        });
      }
    }
  }
  return { scannedCount: active.length, groups, conflicts };
}
