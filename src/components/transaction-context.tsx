import { NotebookPen, ChevronDown } from 'lucide-react';
import type { Transaction } from '@/lib/types';
import { money } from '@/lib/money';
import { displayTime } from '@/lib/display-time';

export default function TransactionContext({
  transactions,
  expanded = false,
}: {
  transactions: Transaction[];
  expanded?: boolean;
}) {
  const entries = transactions.flatMap((tx) => tx.notes.map((note) => ({ tx, note })));
  // Existing saved corrections remain visible even if they predate the context migration.
  for (const tx of transactions) {
    if (tx.instruction && !tx.notes.some((note) => note.text === tx.instruction)) {
      entries.push({
        tx,
        note: {
          id: tx.id + '-legacy',
          text: tx.instruction,
          source: 'instruction',
          createdAt: tx.updatedAt,
        },
      });
    }
  }
  if (!entries.length) return null;
  return (
    <details className="transaction-context" open={expanded || undefined}>
      <summary>
        <NotebookPen size={13} /> Saved context <span>{entries.length}</span>
        <ChevronDown size={13} />
      </summary>
      <div className="context-entries">
        {entries.map(({ tx, note }) => (
          <div className="context-entry" key={tx.id + note.id}>
            <small>
              {transactions.length > 1 ? tx.date + ' · ' + money(tx.amountCents) + ' · ' : ''}
              {note.source === 'chat'
                ? 'From chat'
                : note.source === 'import'
                  ? 'From statement import'
                  : 'Your instruction'}{' '}
              · {displayTime(note.createdAt, { dateStyle: 'medium', timeStyle: 'short' })}
            </small>
            <p>{note.text}</p>
          </div>
        ))}
      </div>
    </details>
  );
}
