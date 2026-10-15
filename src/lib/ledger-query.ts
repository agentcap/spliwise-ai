import type { Sqlite } from '../db';
import { isoDate } from './money';
import { invariant } from './errors';
import type { Transaction } from './types';
export interface LedgerQuery {
  view?: string;
  tripId?: string;
  positive?: boolean;
  page?: number;
  search?: string;
  accountId?: string;
  personId?: string;
  from?: string;
  to?: string;
}
export function queryLedger(db: Sqlite, query: LedgerQuery, size = 100) {
  const page = query.page || 0;
  invariant(Number.isInteger(page) && page >= 0 && page <= 1_000_000, 'Invalid page.');
  if (query.from) isoDate(query.from);
  if (query.to) isoDate(query.to);
  const conditions: string[] = [],
    args: unknown[] = [];
  for (const [field, value, op] of [
    ['date', query.from, '>='],
    ['date', query.to, '<='],
    ['accountId', query.accountId, '='],
    ['tripId', query.tripId, '='],
  ] as const)
    if (value) {
      conditions.push(field + op + '?');
      args.push(value);
    }
  if (query.search) {
    invariant(query.search.length <= 200, 'Search is too long.');
    conditions.push(
      "(instr(lower(description||' '||instruction||' '||COALESCE(proposal,'')||' '||notes),lower(?))>0 OR EXISTS(SELECT 1 FROM merchant_aliases a WHERE instr(lower(transactions.description),lower(a.pattern))>0 AND instr(lower(a.name),lower(?))>0))",
    );
    args.push(query.search, query.search);
  }
  if (query.personId) {
    conditions.push(
      "EXISTS(SELECT 1 FROM json_each(json_extract(transactions.proposal,'$.splits')) s WHERE json_extract(s.value,'$.personId')=?)",
    );
    args.push(query.personId);
  }
  if (query.positive) conditions.push('amountCents>0');
  const base = conditions.length ? conditions.join(' AND ') : '1=1';
  const counts = { inbox: 0, ready: 0, finalized: 0 };
  for (const row of db
    .prepare('SELECT state,COUNT(*) count FROM transactions WHERE ' + base + ' GROUP BY state')
    .all(...args) as { state: keyof typeof counts; count: number }[])
    counts[row.state] = row.count;
  const read = (state?: string) => {
    const where = base + (state ? ' AND state=?' : '');
    return (
      db
        .prepare(
          'SELECT * FROM transactions WHERE ' +
            where +
            ' ORDER BY updatedAt DESC,id LIMIT ? OFFSET ?',
        )
        .all(...args, ...(state ? [state] : []), size, page * size) as Record<string, unknown>[]
    ).map((row) => ({
      ...row,
      proposal: row.proposal ? JSON.parse(row.proposal as string) : null,
      notes: JSON.parse(row.notes as string),
    })) as unknown as Transaction[];
  };
  const transactions =
    query.view === 'review'
      ? [...read('inbox'), ...read('ready')].sort(
          (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
        )
      : read(query.view === 'finalized' ? 'finalized' : undefined);
  const total =
    query.view === 'review'
      ? Math.max(counts.inbox, counts.ready)
      : query.view === 'finalized'
        ? counts.finalized
        : counts.inbox + counts.ready + counts.finalized;
  return { transactions, pagination: { page, size, total, ...counts } };
}
