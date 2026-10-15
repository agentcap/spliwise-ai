import { invariant } from './errors';
import type { Share, SplitSpec } from './types';
export function cents(value: string): number {
  const cleaned = value.trim().replace(/[$,]/g, '');
  invariant(
    /^-?\d+(\.\d{1,2})?$/.test(cleaned),
    'Enter a valid amount with at most two decimal places.',
  );
  const negative = cleaned.startsWith('-');
  const [whole, fraction = ''] = cleaned.replace('-', '').split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  invariant(Number.isSafeInteger(amount) && amount <= 1_000_000_000_000, 'Amount is too large.');
  return negative ? -amount : amount;
}
export const money = (amount: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(amount / 100);
export function allocate(total: number, ids: string[], weights: number[]): Share[] {
  invariant(Number.isSafeInteger(total), 'Amounts must be integer cents.');
  invariant(
    ids.length > 0 && ids.length === weights.length && new Set(ids).size === ids.length,
    'Choose distinct participants.',
  );
  invariant(
    weights.every((w) => Number.isSafeInteger(w) && w >= 0) && weights.some((w) => w > 0),
    'Invalid split weights.',
  );
  const weightTotal = weights.reduce((a, b) => a + b, 0);
  const sign = total < 0 ? -1 : 1,
    absolute = Math.abs(total);
  const parts = ids.map((personId, i) => ({
    personId,
    amountCents: Number((BigInt(absolute) * BigInt(weights[i])) / BigInt(weightTotal)),
    remainder: (BigInt(absolute) * BigInt(weights[i])) % BigInt(weightTotal),
  }));
  const remaining = absolute - parts.reduce((s, p) => s + p.amountCents, 0);
  const order = [...parts].sort((a, b) =>
    a.remainder === b.remainder
      ? a.personId.localeCompare(b.personId)
      : a.remainder > b.remainder
        ? -1
        : 1,
  );
  for (let i = 0; i < remaining; i++) order[i % order.length].amountCents++;
  return parts.map((p) => ({ personId: p.personId, amountCents: p.amountCents * sign }));
}
export function splitAmount(total: number, spec: SplitSpec, selfId = 'self'): Share[] {
  if (spec.mode === 'personal') return [{ personId: selfId, amountCents: total }];
  invariant(spec.participants.length > 0, 'Choose participants.');
  if (spec.mode === 'equal')
    return allocate(
      total,
      spec.participants,
      spec.participants.map(() => 1),
    );
  invariant(spec.values?.length === spec.participants.length, 'Every participant needs a value.');
  const values = spec.values!;
  if (spec.mode === 'percent') {
    invariant(values.reduce((a, b) => a + b, 0) === 10000, 'Percentages must add up to 100%.');
    return allocate(total, spec.participants, values);
  }
  invariant(
    new Set(spec.participants).size === spec.participants.length,
    'Choose distinct participants.',
  );
  invariant(values.every(Number.isSafeInteger), 'Exact amounts must be integer cents.');
  invariant(
    values.reduce((a, b) => a + b, 0) === total,
    'Fixed split amounts must equal the transaction amount.',
  );
  invariant(
    values.every((v) => (total < 0 ? v <= 0 : v >= 0)),
    'Split amounts must have the same sign as the transaction.',
  );
  return spec.participants.map((personId, i) => ({ personId, amountCents: values[i] }));
}
export function isoDate(text: string): string {
  invariant(/^\d{4}-\d{2}-\d{2}$/.test(text), 'Invalid date.');
  const parsed = new Date(text + 'T00:00:00Z');
  invariant(
    !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text,
    'Invalid date.',
  );
  return text;
}

/** Cumulative proportional allocation avoids over-refunding a participant by rounding each refund independently. */
export function linkedRefundShares(
  original: Share[],
  refundCents: number,
  previous: Share[][],
): Share[] {
  invariant(refundCents < 0, 'Refund amount must be negative.');
  const total = original.reduce((sum, s) => sum + s.amountCents, 0);
  const used = previous.flat().reduce((sum, s) => sum - s.amountCents, 0);
  invariant(-refundCents <= total - used, 'Refund exceeds the remaining refundable amount.');
  const target = allocate(
    -(used - refundCents),
    original.map((s) => s.personId),
    original.map((s) => s.amountCents),
  );
  return target.map((s) => ({
    personId: s.personId,
    amountCents:
      s.amountCents -
      previous
        .flat()
        .filter((p) => p.personId === s.personId)
        .reduce((sum, p) => sum + p.amountCents, 0),
  }));
}
