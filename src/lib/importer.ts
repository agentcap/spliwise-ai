import { parse } from 'csv-parse/sync';
import { createHash } from 'node:crypto';
import { cents, isoDate } from './money';
import { invariant, AppError } from './errors';
import type { Account, ParsedRow } from './types';
export function normalizedDescription(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}
function date(value: string): string {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  invariant(m, 'Expected MM/DD/YYYY.');
  return isoDate(m[3] + '-' + m[1] + '-' + m[2]);
}
export function parseStatement(content: string, format: Account['format']): ParsedRow[] {
  invariant(Buffer.byteLength(content) <= 10_000_000, 'Statements must be smaller than 10 MB.');
  let records: string[][];
  try {
    records = parse(content, {
      bom: true,
      skip_empty_lines: true,
      relax_column_count: true,
      trim: false,
    });
  } catch {
    throw new AppError('Unable to read CSV. Check its quotation marks and export format.');
  }
  invariant(records.length >= 2, 'CSV needs a header and at least one transaction.');
  invariant(records.length <= 50001, 'Import at most 50,000 rows at a time.');
  const header = records[0].map((s) => s.trim());
  const expected =
    format === 'amex'
      ? ['Date', 'Description', 'Amount']
      : ['Transaction Date', 'Post Date', 'Description', 'Category', 'Type', 'Amount', 'Memo'];
  invariant(
    header.length === expected.length && expected.every((s, i) => header[i] === s),
    'This file does not match the selected card format. Expected: ' + expected.join(', '),
  );
  return records.slice(1).map((cells, i) => {
    const raw = Object.fromEntries(header.map((name, n) => [name, cells[n] ?? '']));
    const row: ParsedRow = {
      rowNumber: i + 2,
      raw,
      date: null,
      postDate: null,
      description: raw.Description?.trim() || '',
      amountCents: null,
      bankCategory: raw.Category?.trim() || '',
      kind: 'expense',
      fingerprint: '',
    };
    try {
      invariant(cells.length === header.length, 'Column count does not match header.');
      row.date = date(raw[format === 'amex' ? 'Date' : 'Transaction Date']);
      row.postDate = format === 'chase' ? date(raw['Post Date']) : null;
      invariant(row.description.length > 0, 'Description is empty.');
      const original = cents(raw.Amount);
      row.amountCents = format === 'chase' ? -original : original;
      invariant(original !== 0, 'Zero-amount rows need manual correction before import.');
      const type = raw.Type?.trim().toLowerCase();
      const payment =
        format === 'chase'
          ? type === 'payment'
          : /^(AUTOPAY PAYMENT|MOBILE PAYMENT|ONLINE PAYMENT|PAYMENT RECEIVED)(\s|$)/i.test(
              row.description,
            );
      row.kind = payment ? 'payment' : row.amountCents < 0 ? 'refund' : 'expense';
      row.fingerprint = createHash('sha256')
        .update(
          JSON.stringify([
            row.date,
            row.postDate,
            normalizedDescription(row.description),
            row.amountCents,
            row.kind,
          ]),
        )
        .digest('hex');
    } catch (e) {
      row.error = e instanceof Error ? e.message : 'Invalid row.';
    }
    return row;
  });
}
