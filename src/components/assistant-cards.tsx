'use client';
import { useState } from 'react';
import { Check, MapPin, Brain, SlidersHorizontal, ArrowRight, LoaderCircle, X } from 'lucide-react';
import type {
  AssistantEvent,
  AssistantRequest,
  SplitUpdate,
  ExpenseAction,
} from '@/lib/assistant-contracts';
import type { Snapshot, Person, Transaction } from '@/lib/types';
import { money } from '@/lib/money';
import { api } from './ui';
export function AssistantChangeCard({
  event,
  onOpen,
}: {
  event: AssistantEvent;
  onOpen: (kind: string, id: string) => void;
}) {
  return (
    <article className={'assistant-change-card ' + (event.undoneAt ? 'undone' : '')}>
      <span className="assistant-change-icon">
        {event.kind === 'trip' ? (
          <MapPin size={17} />
        ) : event.kind === 'context' ? (
          <Brain size={17} />
        ) : (
          <SlidersHorizontal size={17} />
        )}
      </span>
      <div className="grow">
        <small>{event.undoneAt ? 'Undone' : 'Saved automatically'}</small>
        <h4>{event.title}</h4>
        <p>{event.detail}</p>
      </div>
      {!event.undoneAt && (
        <button
          className="icon-button"
          aria-label={'Open ' + event.title}
          onClick={() => onOpen(event.kind, event.targetId)}
        >
          <ArrowRight size={16} />
        </button>
      )}
    </article>
  );
}
export function AssistantRequestCard({
  request,
  people,
  transactions,
  batches,
  onChanged,
  onReview,
}: {
  request: AssistantRequest;
  people: Person[];
  transactions: Transaction[];
  batches: Snapshot['batches'];
  onChanged: () => Promise<void>;
  onReview: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const undone =
    request.reviewState === 'undone' ||
    (request.batchId && batches.find((b) => b.id === request.batchId)?.undoneAt);
  const person = (id: string) => people.find((p) => p.id === id)?.name || 'Unknown person';
  const pending = request.status === 'pending';
  async function decide(action: 'apply' | 'dismiss' | 'finalize') {
    setBusy(true);
    setError('');
    try {
      await api('assistant-requests/' + request.id + '/' + action, {});
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const payload = request.payload as ExpenseAction & {
    tripName?: string;
    expenses?: { id: string; description: string; date: string; amountCents: number }[];
  };
  const updates =
    request.kind === 'splits'
      ? (request.payload as (SplitUpdate & {
          transaction?: { description: string; date: string; amountCents: number };
        })[])
      : [];
  return (
    <article className={'assistant-request-card ' + request.status} aria-label={request.title}>
      <div className="section-title">
        <span className="pill">
          {pending
            ? 'Your confirmation'
            : undone
              ? 'Undone'
              : request.status === 'applied'
                ? request.reviewState === 'finalized'
                  ? 'Finalized'
                  : 'Applied'
                : 'Dismissed'}
        </span>
        <span className="request-kind">
          {request.kind === 'splits'
            ? updates.length + ' expenses'
            : request.kind === 'assignment'
              ? payload.kind === 'assignment'
                ? payload.items.length + ' expenses'
                : ''
              : request.kind === 'expense'
                ? 'Manual expense'
                : 'Repayment'}
        </span>
      </div>
      <h4>{request.title}</h4>
      {request.kind === 'splits' && (
        <div className="request-splits">
          {updates.slice(0, 3).map((u) => (
            <div key={u.id} className="request-split">
              <div>
                <b>
                  {u.transaction?.description ||
                    transactions.find((t) => t.id === u.id)?.description ||
                    'Expense'}
                </b>
                <small>
                  {u.transaction?.date} · {u.proposal?.category || 'Needs clarification'} ·{' '}
                  {u.state === 'ready' ? 'Ready for review' : 'Inbox'}
                </small>
                {u.proposal && (
                  <small>
                    {u.proposal.confidence} confidence · {u.proposal.source}
                  </small>
                )}
              </div>
              <strong>
                {money(
                  u.transaction?.amountCents ||
                    transactions.find((t) => t.id === u.id)?.amountCents ||
                    0,
                )}
              </strong>
              <div className="request-participants">
                {u.proposal?.splits.map((s) => (
                  <span key={s.personId}>
                    {person(s.personId)} <b>{money(s.amountCents)}</b>
                  </span>
                ))}
              </div>
              <p>{u.proposal?.explanation || u.attention}</p>
            </div>
          ))}
          {updates.length > 3 && (
            <details>
              <summary>See all {updates.length} proposed changes</summary>
              {updates.slice(3).map((u) => (
                <div key={u.id} className="request-split">
                  <b>{u.transaction?.description || 'Expense'}</b>
                  <small>
                    {u.transaction?.date} · {u.state === 'ready' ? 'Ready for review' : 'Inbox'} ·{' '}
                    {u.proposal?.category}
                  </small>
                  {u.proposal?.splits.map((s) => (
                    <p key={s.personId}>
                      {person(s.personId)}: {money(s.amountCents)}
                    </p>
                  ))}
                  <p>{u.proposal?.explanation || u.attention}</p>
                </div>
              ))}
            </details>
          )}
        </div>
      )}
      {request.kind === 'assignment' && (
        <>
          <p>
            Trip: <b>{payload.tripName || 'Everyday expenses'}</b>
          </p>
          <ul>
            {(payload.expenses || []).slice(0, 5).map((t) => (
              <li key={t.id}>
                {t.description} · {t.date} · {money(t.amountCents)}
              </li>
            ))}
          </ul>
          {payload.kind === 'assignment' && payload.items.length > 5 && (
            <details>
              <summary>See all {payload.items.length} expenses</summary>
              {(payload.expenses || []).slice(5).map((t) => (
                <p key={t.id}>
                  {t.description} · {t.date} · {money(t.amountCents)}
                </p>
              ))}
            </details>
          )}
          <p className="muted">
            Unfinished splits return to Inbox so trip defaults can be reviewed.
          </p>
        </>
      )}
      {request.kind === 'expense' && payload.kind === 'expense' && (
        <>
          <strong className="request-amount">{money(payload.amountCents)}</strong>
          <p>
            {payload.date} · {payload.category} · Paid by you
          </p>
          {payload.tripName && <p>{payload.tripName}</p>}
          <p>{payload.note}</p>
          <small>Starts in Inbox. It affects balances after you approve its split.</small>
        </>
      )}
      {request.kind === 'repayment' && payload.kind === 'repayment' && (
        <>
          <strong className="request-amount">{money(payload.amountCents)}</strong>
          <p>
            {payload.direction === 'received' ? 'Received from ' : 'Returned to '}
            {person(payload.personId)} · {payload.date}
          </p>
          <p>{payload.note}</p>
          <small>Confirming updates current balances.</small>
        </>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {pending ? (
        <div className="request-actions">
          <button className="primary" disabled={busy} onClick={() => decide('apply')}>
            {busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />}Confirm{' '}
            {request.kind === 'splits'
              ? 'split changes'
              : request.kind === 'assignment'
                ? 'assignment'
                : request.kind === 'expense'
                  ? 'expense'
                  : 'repayment'}
          </button>
          <button className="quiet-button" disabled={busy} onClick={() => decide('dismiss')}>
            <X size={14} />
            Dismiss
          </button>
        </div>
      ) : (
        request.status === 'applied' &&
        !undone && (
          <div className="request-actions">
            {request.reviewState === 'ready' && (
              <button className="primary" disabled={busy} onClick={() => decide('finalize')}>
                <Check size={15} />
                Finalize {updates.filter((u) => u.state === 'ready').length} splits
              </button>
            )}
            {request.reviewState === 'changed' && (
              <p className="muted">
                These expenses changed. Review their latest splits before approving.
              </p>
            )}
            <button className="text-button" onClick={onReview}>
              Review expenses <ArrowRight size={14} />
            </button>
          </div>
        )
      )}
    </article>
  );
}
