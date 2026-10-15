'use client';
import { useEffect, useState } from 'react';
import { Check, LoaderCircle, RefreshCw, Sparkles, Trash2 } from 'lucide-react';
import type { Rule, RuleOptimizationPreview, Snapshot } from '@/lib/types';
import { api, merchantLabel, Modal, ruleDescription } from './ui';

export function DeleteRuleDialog({
  rule,
  affected,
  data,
  onClose,
  onDelete,
}: {
  rule: Rule;
  affected: number;
  data: Snapshot;
  onClose: () => void;
  onDelete: (rule: Rule) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal title="Delete this rule?" subtitle={rule.title} onClose={onClose}>
      <div className="modal-body form">
        <div className="rule-management-summary">
          <b>{merchantLabel(rule.definition)}</b>
          <p>{ruleDescription(rule.definition, data.people)}</p>
        </div>
        <p className="rule-management-copy">
          This rule will stop applying. Its history is retained, and Undo restores it.
        </p>
        <p className="rule-management-copy">
          {affected
            ? affected +
              ' unfinished proposal' +
              (affected === 1 ? '' : 's') +
              ' from this rule will return to Inbox for a new split.'
            : 'No unfinished proposals currently depend on this rule.'}{' '}
          Finalized expenses keep their accepted splits.
        </p>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-actions">
          <button className="quiet-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary danger-button"
            disabled={busy}
            onClick={async () => {
              if (busy) return;
              setBusy(true);
              setError('');
              try {
                await onDelete(rule);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : <Trash2 size={15} />} Delete rule
          </button>
        </footer>
      </div>
    </Modal>
  );
}

export function OptimizeRulesDialog({
  data,
  onClose,
  onApplied,
}: {
  data: Snapshot;
  onClose: () => void;
  onApplied: (removed: number) => Promise<void>;
}) {
  const [preview, setPreview] = useState<RuleOptimizationPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function refresh() {
    setBusy(true);
    setError('');
    try {
      const result = await api<RuleOptimizationPreview>('rules/optimize/preview');
      setPreview(result);
      setSelected(new Set(result.groups.map((group) => group.id)));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    refresh();
  }, []);
  const chosen = preview?.groups.filter((group) => selected.has(group.id)) || [];
  const removed = chosen.reduce((count, group) => count + group.rules.length - 1, 0);
  return (
    <Modal
      title="Optimize your rules"
      subtitle="Review local cleanup suggestions before applying them."
      wide
      onClose={onClose}
    >
      <div className="modal-body form">
        <div className="optimization-intro">
          <Sparkles size={18} />
          <p>
            Remove duplicates and combine merchant alternatives with the same split, category, card,
            and dates. Cleanup preserves their matching coverage and can be undone.
          </p>
        </div>
        {busy && !preview && (
          <div className="optimization-loading" role="status">
            <LoaderCircle className="spin" size={20} /> Checking your rules…
          </div>
        )}
        {preview && (
          <>
            <div className="optimization-stats">
              <div>
                <b>{preview.scannedCount}</b>
                <span>Active rules</span>
              </div>
              <div>
                <b>{preview.groups.length}</b>
                <span>Cleanup groups</span>
              </div>
              <div>
                <b>{preview.scannedCount - removed}</b>
                <span>After selected cleanup</span>
              </div>
            </div>
            {!preview.groups.length && (
              <div className="optimization-empty">
                <Check size={20} />
                <h3>No compatible duplicates or merges found.</h3>
                <p>Rules with different splits or scopes stay separate.</p>
              </div>
            )}
            {preview.groups.map((group) => (
              <article key={group.id} className="optimization-group">
                <label className="optimization-selection">
                  <input
                    type="checkbox"
                    checked={selected.has(group.id)}
                    disabled={busy}
                    onChange={() =>
                      setSelected((old) => {
                        const next = new Set(old);
                        next.has(group.id) ? next.delete(group.id) : next.add(group.id);
                        return next;
                      })
                    }
                  />
                  <span>
                    {group.kind === 'duplicates'
                      ? 'Remove duplicate rules'
                      : 'Merge compatible merchant rules'}
                    <small>
                      {group.rules.length} rules → 1 rule
                      {group.duplicateCount
                        ? ' · ' +
                          group.duplicateCount +
                          ' exact duplicate' +
                          (group.duplicateCount === 1 ? '' : 's')
                        : ''}
                    </small>
                  </span>
                </label>
                <div className="optimization-before">
                  <small>Before</small>
                  <ul>
                    {group.rules.map((rule) => (
                      <li key={rule.id}>
                        <b>{rule.title}</b>
                        <span>{merchantLabel(rule.definition)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="optimization-after">
                  <small>After</small>
                  <h4>{group.title}</h4>
                  <p>
                    <b>Merchant contains any of:</b> {merchantLabel(group.definition)}
                  </p>
                  <p>{ruleDescription(group.definition, data.people)}</p>
                  <p>
                    {group.definition.accountId
                      ? data.accounts.find((account) => account.id === group.definition.accountId)
                          ?.name
                      : 'All cards'}{' '}
                    · {group.definition.category || 'Any bank category'} ·{' '}
                    {group.definition.from || 'Any start date'} →{' '}
                    {group.definition.to || 'Any end date'}
                  </p>
                </div>
                {(group.rebindCount > 0 || group.resetCount > 0) && (
                  <p className="optimization-impact">
                    {group.rebindCount > 0
                      ? group.rebindCount +
                        ' unfinished proposal reference' +
                        (group.rebindCount === 1 ? '' : 's') +
                        ' updated; split amounts stay the same. '
                      : ''}
                    {group.resetCount > 0
                      ? group.resetCount +
                        ' outdated proposal' +
                        (group.resetCount === 1 ? '' : 's') +
                        ' will return to Inbox.'
                      : ''}
                  </p>
                )}
              </article>
            ))}
            {preview.conflicts.length > 0 && (
              <section className="optimization-conflicts">
                <h3>Potential conflicts kept separate</h3>
                <p>These need a decision about the intended split or category.</p>
                {preview.conflicts.map((conflict, i) => (
                  <div key={i}>
                    <b>{conflict.titles.join(' / ')}</b>
                    <small>{conflict.reason}</small>
                  </div>
                ))}
              </section>
            )}
          </>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <p className="rule-management-copy">
          Finalized expenses and their balances stay unchanged. Removed rules remain in history, and
          Undo restores the complete cleanup batch.
        </p>
        <footer className="modal-actions">
          <button className="quiet-button" disabled={busy} onClick={refresh}>
            <RefreshCw size={14} /> Refresh preview
          </button>
          <button className="quiet-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !preview || !selected.size}
            onClick={async () => {
              if (busy || !preview) return;
              setBusy(true);
              setError('');
              try {
                const result = await api<{ removed: number }>('rules/optimize/apply', {
                  revision: preview.revision,
                  groupIds: [...selected],
                });
                await onApplied(result.removed);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} Apply{' '}
            {selected.size} selected {selected.size === 1 ? 'group' : 'groups'}
          </button>
        </footer>
      </div>
    </Modal>
  );
}
