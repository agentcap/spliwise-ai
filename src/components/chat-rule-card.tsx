'use client';
import { useRef, useState } from 'react';
import { Check, LoaderCircle, SlidersHorizontal, X } from 'lucide-react';
import type { Account, Person, Rule, RuleChange } from '@/lib/types';
import { ruleDescription, merchantLabel } from './ui';

export default function ChatRuleCard({
  change,
  current,
  people,
  accounts,
  onReview,
}: {
  change: RuleChange;
  current?: Rule;
  people: Person[];
  accounts: Account[];
  onReview: (id: string, approve: boolean, processInbox: boolean) => Promise<void>;
}) {
  const pending = change.status === 'proposed';
  const approved = change.status === 'approved';
  const stale =
    pending && !!change.ruleId && (!current?.active || current.version !== change.baseVersion);
  const [processInbox, setProcessInbox] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const definition = change.definition;
  async function review(approve: boolean) {
    if (lock.current) return;
    lock.current = true;
    setSaving(true);
    setError('');
    try {
      await onReview(change.id, approve, approve && processInbox);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setSaving(false);
    }
  }
  const description = (
    <div className="chat-rule-description">
      {change.ruleId && current && (
        <div className="chat-rule-before">
          <small>Currently</small>
          <p>{ruleDescription(current.definition, people)}</p>
        </div>
      )}
      <dl>
        <div>
          <dt>Merchant contains</dt>
          <dd>{merchantLabel(definition)}</dd>
        </div>
        <div>
          <dt>Card</dt>
          <dd>
            {definition.accountId
              ? accounts.find((a) => a.id === definition.accountId)?.name || definition.accountId
              : 'All cards'}
          </dd>
        </div>
        {definition.category && (
          <div>
            <dt>Bank category</dt>
            <dd>{definition.category}</dd>
          </div>
        )}
        <div>
          <dt>Dates</dt>
          <dd>
            {definition.from || 'Any start date'} → {definition.to || 'Any end date'}
          </dd>
        </div>
      </dl>
      <p className="chat-rule-split">{ruleDescription(definition, people)}</p>
    </div>
  );
  return (
    <article
      className={'chat-rule-card ' + change.status}
      aria-label={'Rule proposal: ' + change.title}
    >
      <div className="chat-rule-heading">
        <SlidersHorizontal size={14} />
        <span>
          {pending
            ? change.ruleId
              ? 'Update reusable rule'
              : 'New reusable rule'
            : approved
              ? 'Rule approved'
              : 'Rule rejected'}
        </span>
        {!pending && (approved ? <Check size={14} /> : <X size={14} />)}
      </div>
      <h4>{change.title}</h4>
      {pending ? (
        description
      ) : (
        <details className="chat-rule-resolved">
          <summary>View rule details</summary>
          {description}
        </details>
      )}
      {pending && (
        <>
          <p className="chat-rule-note">Review this rule here before it becomes active.</p>
          {stale && (
            <p className="error-text" role="alert">
              This rule changed after the proposal was created. Reject it and request a fresh
              proposal.
            </p>
          )}
          {change.matchingInboxCount > 0 && (
            <label className="chat-rule-apply">
              <input
                type="checkbox"
                checked={processInbox}
                onChange={(e) => setProcessInbox(e.target.checked)}
                disabled={saving || stale}
              />
              <span>
                Also process {change.matchingInboxCount} matching Inbox expense
                {change.matchingInboxCount === 1 ? '' : 's'}
              </span>
            </label>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <footer>
            <button className="quiet-button" disabled={saving} onClick={() => review(false)}>
              Reject
            </button>
            <button className="primary" disabled={saving || stale} onClick={() => review(true)}>
              {saving ? <LoaderCircle size={13} className="spin" /> : <Check size={13} />} Approve
              rule
            </button>
          </footer>
        </>
      )}
    </article>
  );
}
