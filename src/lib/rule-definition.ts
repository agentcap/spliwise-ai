import type { RuleDefinition, SplitSpec } from './types';

export const normalizeMerchant = (value: string) => value.trim().replace(/\s+/g, ' ').toUpperCase();
export function merchantPatterns(definition: RuleDefinition): string[] {
  if (!definition.merchant.trim()) return [];
  return [
    ...new Set(
      [definition.merchant, ...(definition.merchantAliases || [])]
        .map(normalizeMerchant)
        .filter(Boolean),
    ),
  ].sort();
}
export function merchantLabel(definition: RuleDefinition) {
  return merchantPatterns(definition).join(' OR ') || 'Any merchant';
}
export function canonicalSplit(split: SplitSpec): SplitSpec {
  if (split.mode === 'personal') return { mode: 'personal', participants: ['self'] };
  const entries = split.participants
    .map((id, i) => ({ id, value: split.values?.[i] }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    mode: split.mode,
    participants: entries.map((entry) => entry.id),
    ...(split.mode === 'equal' ? {} : { values: entries.map((entry) => entry.value!) }),
  };
}
export function outcomeKey(definition: RuleDefinition) {
  return JSON.stringify([definition.outputCategory, canonicalSplit(definition.split)]);
}
export function scopeKey(definition: RuleDefinition) {
  return JSON.stringify([
    merchantPatterns(definition).length > 0,
    definition.accountId || '',
    definition.category?.toLowerCase() || '',
    definition.from || '',
    definition.to || '',
  ]);
}
export function definitionKey(definition: RuleDefinition) {
  return JSON.stringify([
    merchantPatterns(definition),
    scopeKey(definition),
    outcomeKey(definition),
  ]);
}
export function specificity(definition: RuleDefinition) {
  return (
    (definition.from || definition.to ? 4 : 0) +
    (definition.accountId ? 2 : 0) +
    (definition.category ? 1 : 0) +
    (merchantPatterns(definition).length ? 1 : 0)
  );
}
