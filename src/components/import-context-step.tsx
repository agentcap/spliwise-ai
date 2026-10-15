'use client';
import { Check, LoaderCircle, NotebookPen, Sparkles } from 'lucide-react';
import type { ImportResult, Snapshot } from '@/lib/types';
import MentionInput from './mention-input';

export default function ImportContextStep({
  result,
  data,
  accountId,
  context,
  onContext,
  from,
  onFrom,
  to,
  onTo,
  busy,
  onFinish,
}: {
  result: ImportResult;
  data: Snapshot;
  accountId: string;
  context: string;
  onContext: (text: string) => void;
  from: string;
  onFrom: (value: string) => void;
  to: string;
  onTo: (value: string) => void;
  busy: boolean;
  onFinish: (process: boolean) => Promise<void>;
}) {
  const scoped = result.items.filter(
    (tx) => (!from || tx.date >= from) && (!to || tx.date <= to),
  ).length;
  const invalidRange = !!from && !!to && from > to;
  const hasContext = !!context.trim();
  const disabled = busy || (hasContext && (!scoped || invalidRange));
  return (
    <>
      <div className="import-success">
        <span>
          <Check size={30} />
        </span>
        <h3>{result.ids.length} new transactions</h3>
        <p>{result.summary}</p>
        <small>Saved in Inbox. Your balances haven’t changed.</small>
      </div>
      {result.ids.length > 0 ? (
        <section className="import-context-prompt">
          <div className="import-context-heading">
            <NotebookPen size={18} />
            <h3>Anything to know about this period?</h3>
            <span className="pill">Optional</span>
          </div>
          <p className="import-context-period">
            {data.accounts.find((account) => account.id === accountId)?.name} ·{' '}
            {result.dateRange.from} → {result.dateRange.to}
          </p>
          <p>
            A trip, visitors, or a temporary sharing arrangement? Add details that could help split
            these expenses.
          </p>
          <MentionInput
            label="Context for this import (optional)"
            value={context}
            onChange={onContext}
            people={data.people}
            disabled={busy}
            maxLength={4000}
            placeholder="For example: We were on a trip June 3–8. Split food equally with @…; souvenirs are personal."
          />
          <details className="import-context-dates">
            <summary>Use a narrower date range</summary>
            <div className="form-grid">
              <label>
                Context start date
                <input
                  type="date"
                  value={from}
                  min={result.dateRange.from || undefined}
                  max={result.dateRange.to || undefined}
                  disabled={busy}
                  onChange={(e) => onFrom(e.target.value)}
                />
              </label>
              <label>
                Context end date
                <input
                  type="date"
                  value={to}
                  min={result.dateRange.from || undefined}
                  max={result.dateRange.to || undefined}
                  disabled={busy}
                  onChange={(e) => onTo(e.target.value)}
                />
              </label>
            </div>
          </details>
          <small role="status">
            {invalidRange
              ? 'Start date must precede end date.'
              : 'Applies to ' +
                scoped +
                ' newly imported ' +
                (scoped === 1 ? 'transaction' : 'transactions') +
                ' from this upload only.'}{' '}
            Saved with those expenses for processing now or later. Reusable rules still need your
            approval.
          </small>
          {hasContext && !scoped && !invalidRange && (
            <p className="error-text">
              No newly imported transactions fall in this range. Adjust the dates or leave context
              blank.
            </p>
          )}
        </section>
      ) : (
        <p className="muted small-text">
          There are no new expenses to add context to. Existing transactions keep their saved
          context.
        </p>
      )}
      <footer className="modal-actions import-context-actions">
        <button className="quiet-button" disabled={disabled} onClick={() => onFinish(false)}>
          {busy && <LoaderCircle className="spin" size={15} />}
          {hasContext ? 'Save context & finish' : 'Finish for now'}
        </button>
        <button
          className="primary"
          disabled={disabled || !result.ids.length}
          onClick={() => onFinish(true)}
        >
          <Sparkles size={16} />
          {hasContext ? 'Save context & process' : 'Process now'}
        </button>
      </footer>
    </>
  );
}
