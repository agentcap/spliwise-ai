'use client';
import { useEffect, useState } from 'react';
import { Modal, api } from './ui';
import type { Snapshot } from '@/lib/types';
interface Settings {
  production: boolean;
  email?: string;
  name?: string;
  timezone: string;
  consentAt: string | null;
  usage: {
    pricingConfigured?: boolean;
    month: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    chargedMicros: number;
    heldMicros: number;
    limitMicros: number;
  };
}
export default function SettingsDialog({
  data,
  onClose,
  onChanged,
}: {
  data: Snapshot;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [settings, setSettings] = useState<Settings | null>(null),
    [timezone, setTimezone] = useState(''),
    [consent, setConsent] = useState(false),
    [name, setName] = useState(''),
    [format, setFormat] = useState('chase'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [confirm, setConfirm] = useState('');
  const load = async () => {
    const s = await api<Settings>('settings');
    setSettings(s);
    setTimezone(s.timezone);
    setConsent(!!s.consentAt);
  };
  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, []);
  async function save(work: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await load();
      await onChanged();
      setNotice(message);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title="Workspace settings"
      subtitle="Your preferences, privacy and AI usage."
      onClose={onClose}
      wide
    >
      <div className="modal-body settings-body">
        {error && (
          <p className="notice error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        {settings ? (
          <>
            <section>
              <h3>{settings.name || 'Personal workspace'}</h3>
              <p className="muted">{settings.email || 'Local access'} · USD</p>
              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(() => api('settings', { timezone, consent }), 'Preferences saved.');
                }}
              >
                <label>
                  Time zone
                  <input
                    aria-label="Time zone"
                    required
                    list="timezones"
                    value={timezone}
                    onChange={(e) => setTimezone(e.target.value)}
                  />
                </label>
                <datalist id="timezones">
                  {[
                    'America/Los_Angeles',
                    'America/New_York',
                    'America/Chicago',
                    'Europe/London',
                    'Asia/Kolkata',
                    'UTC',
                  ].map((z) => (
                    <option key={z}>{z}</option>
                  ))}
                </datalist>
                <h3>Privacy & AI</h3>
                <p>
                  Statements, people, rules, chat and action history are stored on this app’s
                  server. Using AI sends necessary expense details, names, rules and your
                  instructions to OpenAI. Financial decisions always require your review.
                </p>
                <p>
                  Hosted agent tracing and response storage are disabled. OpenAI’s API retention
                  rules still apply. Read{' '}
                  <a href="/privacy" target="_blank" rel="noreferrer">
                    Privacy & data
                  </a>
                  .
                </p>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={consent}
                    onChange={(e) => setConsent(e.target.checked)}
                  />
                  Allow AI processing of my workspace data
                </label>
                <button className="primary" disabled={busy}>
                  Save preferences
                </button>
              </form>
            </section>
            <section>
              <h3>AI usage · {settings.usage.month} UTC</h3>
              <div className="usage-grid">
                <div>
                  <b>
                    {'$'}
                    {(settings.usage.chargedMicros / 1e6).toFixed(2)}
                  </b>
                  <small>Estimated usage & reservations</small>
                </div>
                <div>
                  <b>
                    {'$'}
                    {(settings.usage.limitMicros / 1e6).toFixed(2)}
                  </b>
                  <small>Monthly workspace limit</small>
                </div>
                <div>
                  <b>{settings.usage.requests}</b>
                  <small>Model requests</small>
                </div>
              </div>
              {!settings.usage.pricingConfigured && (
                <p className="muted">
                  Cost estimates use provisional allowances until token prices are configured by the
                  operator.
                </p>
              )}
              <p className="muted">
                {settings.usage.inputTokens.toLocaleString()} input tokens ·{' '}
                {settings.usage.outputTokens.toLocaleString()} output tokens.
                {settings.usage.heldMicros > 0
                  ? ' Includes $' +
                    (settings.usage.heldMicros / 1e6).toFixed(2) +
                    ' reserved for requests without confirmed usage.'
                  : ''}{' '}
                Estimates use operator-configured prices; the provider invoice is authoritative.
                Budgets include conservative reservations before each request.
              </p>
            </section>
            <section>
              <h3>Card accounts</h3>
              <p>
                Choose the matching account at upload. Account names distinguish cards with the same
                CSV format.
              </p>
              {data.accounts.map((a) => (
                <div className="settings-account" key={a.id}>
                  <span>{a.name}</span>
                  <small>{a.format === 'chase' ? 'Chase CSV' : 'Amex CSV'}</small>
                </div>
              ))}
              <form
                className="form"
                onSubmit={(e) => {
                  e.preventDefault();
                  void save(async () => {
                    await api('accounts', { name, format });
                    setName('');
                  }, 'Card account added.');
                }}
              >
                <div className="form-grid">
                  <label>
                    Account name
                    <input
                      required
                      maxLength={80}
                      value={name}
                      placeholder="e.g. Sapphire ending 1234"
                      onChange={(e) => setName(e.target.value)}
                    />
                  </label>
                  <label>
                    CSV format
                    <select
                      aria-label="CSV format"
                      value={format}
                      onChange={(e) => setFormat(e.target.value)}
                    >
                      <option value="chase">Chase (Sapphire / Prime)</option>
                      <option value="amex">American Express</option>
                    </select>
                  </label>
                </div>
                <button className="quiet-button" disabled={busy}>
                  Add card account
                </button>
              </form>
            </section>
            <section>
              <h3>Your data</h3>
              <p>
                Download a complete SQLite copy containing transactions, source rows, splits, rules,
                repayments, chat and Undo history. Keep this file private.
              </p>
              <a className="quiet-button auth-link" href="/api/account/export">
                Download full workspace
              </a>
              <p className="muted">
                Transaction and rule exports in JSON or CSV remain available from Import / export.
              </p>
              {settings.production && (
                <details className="delete-account">
                  <summary>Delete my workspace</summary>
                  <p>
                    This revokes every session and stops processing immediately. Scheduled cleanup
                    permanently removes your live workspace after a two-minute grace period.
                    Encrypted backups expire under the operator’s retention policy.
                  </p>
                  <label>
                    Type DELETE to confirm
                    <input
                      aria-label="Delete confirmation"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                    />
                  </label>
                  <button
                    className="danger-button"
                    disabled={busy || confirm !== 'DELETE'}
                    onClick={() =>
                      void save(async () => {
                        await api('account/delete', { confirm });
                        window.location.assign('/login');
                      }, 'Deletion requested.')
                    }
                  >
                    Request permanent deletion
                  </button>
                </details>
              )}
            </section>
            {settings.production && (
              <form action="/auth/logout" method="post">
                <input type="hidden" name="action" value="logout" />
                <button className="quiet-button">Sign out</button>
              </form>
            )}
          </>
        ) : (
          <p>Loading settings…</p>
        )}
      </div>
    </Modal>
  );
}
