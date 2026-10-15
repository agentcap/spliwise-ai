import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStatement } from '../src/lib/importer';
const directory = process.argv[2];
if (!directory) throw new Error('Usage: npm run validate:samples -- /path/to/sample-directory');
for (const [file, format, total, payments] of [
  ['Amex Nov2025-Sep2026.csv', 'amex', 129, 11],
  ['Prime Nov2025-Sep2026.csv', 'chase', 200, 7],
  ['Saphire Nov2025-Sep2026.csv', 'chase', 626, 13],
] as const) {
  const rows = parseStatement(readFileSync(join(directory, file), 'utf8'), format);
  if (
    rows.length !== total ||
    rows.filter((r) => r.kind === 'payment').length !== payments ||
    rows.some((r) => r.error)
  )
    throw new Error(file + ': unexpected parsing result');
  console.log(
    file +
      ': ' +
      rows.length +
      ' rows, ' +
      payments +
      ' payments, ' +
      (total - payments) +
      ' workflow transactions. PASS',
  );
}
