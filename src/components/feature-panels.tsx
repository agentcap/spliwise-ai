'use client';
import { useEffect, useState } from 'react';
import {
  ArrowRight,
  MapPin,
  Plus,
  Paperclip,
  Download,
  Trash2,
  Check,
  ChevronLeft,
} from 'lucide-react';
import type { Snapshot, TripSummary, Transaction, Attachment } from '@/lib/types';
import { money } from '@/lib/money';
import { api, ruleDescription } from './ui';
import { TemplateDialog } from './feature-dialogs';
export function Onboarding({
  data,
  onPeople,
  onImport,
  onManual,
  onReview,
  onRepay,
  onDismiss,
}: {
  data: Snapshot;
  onPeople: () => void;
  onImport: () => void;
  onManual: () => void;
  onReview: () => void;
  onRepay: () => void;
  onDismiss: () => void;
}) {
  const steps = [
    { label: 'Add people', done: data.people.some((p) => !p.isSelf), run: onPeople },
    {
      label: 'Add your first expense',
      done: !!(
        data.dashboard.inboxCount +
        data.dashboard.readyCount +
        data.dashboard.finalizedCount
      ),
      run: onManual,
    },
    {
      label: 'Prepare a split',
      done: !!(data.dashboard.readyCount + data.dashboard.finalizedCount),
      run: onReview,
    },
    { label: 'Finalize your split', done: !!data.dashboard.finalizedCount, run: onReview },
    { label: 'Record a repayment', done: !!data.repayments.length, run: onRepay },
  ];
  return (
    <section className="onboarding panel">
      <div className="section-title">
        <div>
          <span className="eyebrow">GET STARTED</span>
          <h3>Your first shared expense</h3>
          <p>
            {steps.filter((s) => s.done).length} of {steps.length} steps complete · manual splits
            work without AI
          </p>
        </div>
        <button className="text-button" onClick={onDismiss}>
          Dismiss guide
        </button>
      </div>
      <div className="setup-steps">
        {steps.map((s, i) => (
          <button key={s.label} className={s.done ? 'complete' : ''} onClick={s.run}>
            <span>{s.done ? <Check size={14} /> : i + 1}</span>
            {s.label}
            <ArrowRight size={14} />
          </button>
        ))}
      </div>
      <button className="text-button" onClick={onImport}>
        Have a statement? Import a CSV instead
      </button>
    </section>
  );
}
export function TripsPanel({
  data,
  tripId,
  onSelect,
  onReview,
  onCreate,
  onEdit,
  onChanged,
  onManual,
  onChat,
}: {
  data: Snapshot;
  tripId: string;
  onSelect: (id: string) => void;
  onReview: () => void;
  onCreate: () => void;
  onEdit: (trip: TripSummary) => void;
  onChanged: () => Promise<void>;
  onManual: () => void;
  onChat: () => void;
}) {
  const [archived, setArchived] = useState(false),
    [suggestions, setSuggestions] = useState<Transaction[]>([]),
    [selection, setSelection] = useState<Set<string>>(new Set()),
    [page, setPage] = useState(0),
    [total, setTotal] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const trip = data.trips?.find((t) => t.id === tripId);
  useEffect(() => {
    setSelection(new Set());
    if (!tripId) return;
    let active = true;
    api<{ transactions: Transaction[]; total: number }>(
      'trips/' + tripId + '/suggestions?page=' + page,
    )
      .then((d) => {
        if (active) {
          setSuggestions(d.transactions);
          setTotal(d.total);
          setError('');
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [tripId, page, trip?.version, trip?.count]);
  async function assign() {
    if (!trip) return;
    setBusy(true);
    try {
      await api('trips/assign', {
        tripId: trip.id,
        items: suggestions
          .filter((t) => selection.has(t.id))
          .map((t) => ({ id: t.id, version: t.version })),
      });
      setSelection(new Set());
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!trip)
    return (
      <section>
        <div className="section-title">
          <div>
            <h2>Your trips</h2>
            <p>Keep the people, context and expenses together.</p>
          </div>
          <button className="primary" onClick={onCreate}>
            <Plus size={16} />
            New trip
          </button>
        </div>
        <label className="inline-check">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Show archived trips
        </label>
        <div className="trip-grid">
          {data.trips
            ?.filter((t) => archived || t.status === 'active')
            .map((t) => (
              <button
                className="trip-card panel"
                key={t.id}
                onClick={() => {
                  setPage(0);
                  onSelect(t.id);
                }}
              >
                <span className="trip-icon">
                  <MapPin size={22} />
                </span>
                <span className="pill">{t.status}</span>
                <h3>{t.name}</h3>
                <p>{t.destination || 'Shared adventure'}</p>
                <small>
                  {t.from} — {t.to}
                </small>
                <div className="trip-card-stats">
                  <strong>{money(t.totalCents)}</strong>
                  <span>
                    {t.count} expenses · {t.unfinished} to review
                  </span>
                </div>
                <span className="text-button">
                  Open trip <ArrowRight size={14} />
                </span>
              </button>
            ))}
        </div>
        {!data.trips?.length && (
          <div className="empty-state">
            <MapPin size={36} />
            <h3>A place for every adventure</h3>
            <p>
              Create a trip, choose who is coming, and review suggested expenses. Earlier flight
              bookings can be added too.
            </p>
            <button className="primary" onClick={onCreate}>
              Create your first trip
            </button>
          </div>
        )}
      </section>
    );
  return (
    <section className="trip-workspace">
      <button className="text-button" onClick={() => onSelect('')}>
        <ChevronLeft size={15} />
        All trips
      </button>
      <div className="section-title">
        <div>
          <span className="eyebrow">{trip.destination || 'TRIP WORKSPACE'}</span>
          <h2>{trip.name}</h2>
          <p>
            {trip.from} — {trip.to} ·{' '}
            {trip.participants.map((id) => data.people.find((p) => p.id === id)?.name).join(', ')}
          </p>
        </div>
        <div className="action-cluster">
          <button className="quiet-button" onClick={() => onEdit(trip)}>
            Edit trip
          </button>
          <button
            className="quiet-button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await api('trips/archive', {
                  id: trip.id,
                  version: trip.version,
                  archived: trip.status === 'active',
                });
                await onChanged();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {trip.status === 'active' ? 'Archive trip' : 'Reopen trip'}
          </button>
        </div>
      </div>
      <div className="summary-grid trip-summary">
        <article className="stat-card">
          <p>Finalized trip cost</p>
          <h2>{money(trip.totalCents)}</h2>
          <small>
            {trip.count} assigned expenses · {trip.unfinished} unfinished
          </small>
        </article>
        <article className="stat-card">
          <p>Your finalized share</p>
          <h2>{money(trip.yourShareCents)}</h2>
          <small>USD · expenses you paid</small>
        </article>
        <article className="stat-card">
          <p>Ready to finish?</p>
          <button className="primary" onClick={onReview}>
            Review trip expenses <ArrowRight size={15} />
          </button>
          <small>Only finalized allocations affect balances.</small>
        </article>
      </div>
      <div className="trip-context panel">
        <h3>Trip defaults & context</h3>
        <p>
          {ruleDescription(
            { merchant: '', split: trip.split, outputCategory: 'Per-expense category' },
            data.people,
          )}
        </p>
        <p>
          {trip.context ||
            'Add context such as shared meals, late arrivals, or personal purchases.'}
        </p>
        <div className="action-cluster">
          <button className="quiet-button" onClick={onChat}>
            Ask AI about this trip
          </button>
          <button className="quiet-button" onClick={onManual}>
            Add manual expense
          </button>
          <a
            className="quiet-button"
            href={'/api/transfer/export?kind=transactions&trip=' + trip.id}
          >
            Export trip JSON
          </a>
        </div>
        <small>
          To add expenses outside these dates, select them in Transactions and choose Assign trip.
        </small>
      </div>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {trip.status === 'active' && (
        <div className="panel trip-candidates">
          <div className="section-title">
            <div>
              <h3>Suggested expenses</h3>
              <p>Unassigned expenses in this date range. Nothing is added until you select it.</p>
            </div>
            <button className="primary" disabled={!selection.size || busy} onClick={assign}>
              Assign {selection.size} selected
            </button>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      aria-label="Select all trip suggestions"
                      checked={
                        !!suggestions.length && suggestions.every((t) => selection.has(t.id))
                      }
                      onChange={(e) =>
                        setSelection(
                          e.target.checked ? new Set(suggestions.map((t) => t.id)) : new Set(),
                        )
                      }
                    />
                  </th>
                  <th>Expense</th>
                  <th>Date</th>
                  <th>Amount</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {suggestions.map((t) => (
                  <tr key={t.id}>
                    <td>
                      <input
                        type="checkbox"
                        aria-label={'Assign ' + t.description}
                        checked={selection.has(t.id)}
                        onChange={(e) =>
                          setSelection((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(t.id);
                            else n.delete(t.id);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td>{t.description}</td>
                    <td>{t.date}</td>
                    <td>{money(t.amountCents)}</td>
                    <td>{t.state}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!suggestions.length && <p className="muted">No unassigned expenses in these dates.</p>}
          <div className="pagination">
            <button className="quiet-button" disabled={!page} onClick={() => setPage(page - 1)}>
              Previous suggestions
            </button>
            <span>
              {total} suggestions · page {page + 1}
            </span>
            <button
              className="quiet-button"
              disabled={(page + 1) * 50 >= total}
              onClick={() => setPage(page + 1)}
            >
              Next suggestions
            </button>
          </div>
        </div>
      )}
      <div className="panel trip-context">
        <h3>Settlement summaries</h3>
        <p>
          Download a private summary to share yourself. It includes current unpaid amounts after
          repayments.
        </p>
        <div className="action-cluster">
          {trip.participants
            .filter((id) => id !== 'self')
            .map((id) => (
              <a
                className="quiet-button"
                key={id}
                href={'/api/settlements/' + id + '?trip=' + trip.id}
              >
                <Download size={14} />
                {data.people.find((p) => p.id === id)?.name}
              </a>
            ))}
        </div>
      </div>
    </section>
  );
}
export function WorkspaceTools({
  data,
  onChanged,
}: {
  data: Snapshot;
  onChanged: () => Promise<void>;
}) {
  const [templateOpen, setTemplateOpen] = useState(false),
    [pattern, setPattern] = useState(''),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function remove(kind: string, id: string, version: number) {
    setBusy(true);
    try {
      await api(kind + '/delete', { id, version });
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="workspace-tools">
      <div className="panel trip-context">
        <div className="section-title">
          <div>
            <h3>Split templates</h3>
            <p>Reusable methods you apply explicitly.</p>
          </div>
          <button className="quiet-button" onClick={() => setTemplateOpen(true)}>
            <Plus size={14} />
            New template
          </button>
        </div>
        {data.templates?.map((t) => (
          <div className="tool-row" key={t.id}>
            <div>
              <b>{t.name}</b>
              <small>
                {ruleDescription(
                  { merchant: '', split: t.spec, outputCategory: t.category },
                  data.people,
                )}
              </small>
            </div>
            <button
              className="icon-button"
              aria-label={'Delete template ' + t.name}
              disabled={busy}
              onClick={() => remove('templates', t.id, t.version)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
        {!data.templates?.length && (
          <p className="muted">Save equal, percentage or fixed splits for quick review.</p>
        )}
      </div>
      <div className="panel trip-context">
        <h3>Merchant names</h3>
        <p>
          Turn statement labels into readable names. Original statement text stays in expense
          details. Approved rules can match either name.
        </p>
        <form
          className="alias-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            try {
              await api('aliases/save', { pattern, name });
              setPattern('');
              setName('');
              await onChanged();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            Statement contains
            <input
              required
              minLength={2}
              maxLength={200}
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              placeholder="TST* CURRY PIZZA"
            />
          </label>
          <label>
            Display as
            <input
              required
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Curry Pizza House"
            />
          </label>
          <button className="primary" disabled={busy}>
            Save merchant name
          </button>
        </form>
        {data.aliases?.map((a) => (
          <div className="tool-row" key={a.id}>
            <div>
              <b>{a.name}</b>
              <small>{a.pattern}</small>
            </div>
            <button
              className="icon-button"
              aria-label={'Delete merchant name ' + a.name}
              disabled={busy}
              onClick={() => remove('aliases', a.id, a.version)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {templateOpen && (
        <TemplateDialog
          data={data}
          onClose={() => setTemplateOpen(false)}
          onSaved={async () => {
            await onChanged();
            setTemplateOpen(false);
          }}
        />
      )}
    </section>
  );
}
export function ExpenseFiles({
  refreshToken,
  tx,
  onChanged,
}: {
  tx: Transaction;
  refreshToken?: string;
  onChanged: () => Promise<void>;
}) {
  const [files, setFiles] = useState<Attachment[]>([]),
    [source, setSource] = useState<{
      source: string;
      row?: { raw: string; rowNumber: number };
      history: { id: string; label: string; createdAt: string; undoneAt: string | null }[];
    } | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    Promise.all([
      api<Attachment[]>('transaction-files/' + tx.id),
      api<typeof source>('transaction-source/' + tx.id),
    ])
      .then(([f, s]) => {
        if (active) {
          setFiles(f);
          setSource(s);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [tx.id, tx.version, revision, refreshToken]);
  async function upload(file: File) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('transactionId', tx.id);
      const r = await fetch('/api/attachments/upload', { method: 'POST', body: form });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      setRevision((v) => v + 1);
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="expense-files">
      <h3>
        <Paperclip size={16} />
        Receipts
      </h3>
      <p className="muted">
        Stored privately with this expense. PNG, JPEG or PDF · up to 5 MB each.
      </p>
      <input
        type="file"
        aria-label="Attach receipt"
        accept="image/png,image/jpeg,application/pdf"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload(file);
        }}
      />
      {files.map((f) => (
        <div className="tool-row" key={f.id}>
          <a href={'/api/attachments/' + f.id}>
            <Paperclip size={13} />
            {f.name} · {Math.ceil(f.size / 1024)} KB
          </a>
          <button
            disabled={busy}
            className="icon-button"
            aria-label={'Remove receipt ' + f.name}
            onClick={async () => {
              setBusy(true);
              try {
                await api('attachments/delete', { id: f.id });
                setRevision((v) => v + 1);
                await onChanged();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Trash2 size={15} />
          </button>
        </div>
      ))}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {source && (
        <>
          <details>
            <summary>
              Original {source.source === 'manual' ? 'manual entry' : 'statement row'}
            </summary>
            <dl className="source-fields">
              {Object.entries(JSON.parse(source.row?.raw || '{}') as Record<string, string>).map(
                ([k, v]) => (
                  <div key={k}>
                    <dt>{k}</dt>
                    <dd>{v}</dd>
                  </div>
                ),
              )}
            </dl>
          </details>
          <details>
            <summary>Action history</summary>
            {source.history.map((h) => (
              <div className="history-row" key={h.id}>
                <b>{h.label}</b>
                <small>
                  {h.createdAt.slice(0, 16).replace('T', ' ')}
                  {h.undoneAt ? ' · Undone' : ''}
                </small>
              </div>
            ))}
          </details>
        </>
      )}
    </section>
  );
}
