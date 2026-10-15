'use client';
import { useState } from 'react';
import { ArrowDownToLine, Check, FileUp, LoaderCircle, RefreshCw } from 'lucide-react';
import type { Snapshot } from '@/lib/types';
import type { TransferKind, TransferPreview } from '@/lib/data-transfer';
import { money } from '@/lib/money';
import { api, merchantLabel, Modal, ruleDescription } from './ui';

export default function DataTransferDialog({
  initialKind,
  data,
  from,
  to,
  onClose,
  onImported,
}: {
  initialKind: TransferKind;
  data: Snapshot;
  from: string;
  to: string;
  onClose: () => void;
  onImported: (kind: TransferKind, summary: string) => Promise<void>;
}) {
  const [kind, setKind] = useState(initialKind);
  const [exportFrom, setExportFrom] = useState(from),
    [exportTo, setExportTo] = useState(to);
  const [state, setState] = useState(''),
    [format, setFormat] = useState('json'),
    [pending, setPending] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [keep, setKeep] = useState<Set<number>>(new Set());
  const [ackSkips, setAckSkips] = useState(false),
    [ackPeople, setAckPeople] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [downloaded, setDownloaded] = useState('');
  const [page, setPage] = useState(0),
    [onlyDuplicates, setOnlyDuplicates] = useState(false);
  const rows = preview?.rows.filter((row) => !onlyDuplicates || row.duplicate) || [];
  const skipped =
    preview?.rows.filter((row) => row.duplicate && !keep.has(row.rowNumber)).length || 0;
  const adding = (preview?.rows.length || 0) - skipped;
  const needsPeopleReview = !!preview && preview.people.length > 1;
  function resetPreview() {
    setPreview(null);
    setKeep(new Set());
    setAckSkips(false);
    setAckPeople(false);
    setPage(0);
    setOnlyDuplicates(false);
    setError('');
  }
  async function inspect() {
    if (!file || busy) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.set('kind', kind);
      form.set('file', file);
      const response = await fetch('/api/transfer/preview', { method: 'POST', body: form });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Could not preview this file.');
      resetPreview();
      setPreview(result);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function download() {
    setBusy(true);
    setError('');
    setDownloaded('');
    try {
      const query = new URLSearchParams({
        kind,
        format: kind === 'rules' ? 'json' : format,
        includePending: String(pending),
      });
      if (kind === 'transactions') {
        if (exportFrom) query.set('from', exportFrom);
        if (exportTo) query.set('to', exportTo);
        if (state) query.set('state', state);
      }
      const response = await fetch('/api/transfer/export?' + query, { cache: 'no-store' });
      if (!response.ok) throw new Error((await response.json()).error || 'Could not export.');
      const blob = await response.blob(),
        url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download =
        response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ||
        'splitwise-ai-export.json';
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      setDownloaded('Your ' + kind + ' export is ready in Downloads.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const sourcePeople = preview?.people.map((p) => p.source) || [];
  return (
    <Modal
      title="Import & export"
      subtitle="Move your transactions and reusable rules."
      onClose={onClose}
      wide
    >
      <div className="modal-body form transfer-body">
        <div className="transfer-tabs" role="tablist" aria-label="Data type">
          {(['transactions', 'rules'] as const).map((value) => (
            <button
              key={value}
              role="tab"
              aria-selected={kind === value}
              disabled={busy}
              onClick={() => {
                setKind(value);
                setFile(null);
                setDownloaded('');
                resetPreview();
              }}
            >
              {value === 'transactions' ? 'Transactions' : 'Rules'}
            </button>
          ))}
        </div>
        {!preview && (
          <section className="transfer-section">
            <div className="transfer-section-heading">
              <ArrowDownToLine size={18} />
              <h3>Export {kind}</h3>
            </div>
            {kind === 'transactions' ? (
              <>
                <p>
                  JSON keeps splits, saved context, original source rows, and linked refunds. CSV is
                  for spreadsheets; use JSON to import back into Splitwise AI.
                </p>
                <div className="form-grid">
                  <label>
                    Export from
                    <input
                      type="date"
                      value={exportFrom}
                      onChange={(e) => setExportFrom(e.target.value)}
                    />
                  </label>
                  <label>
                    Export through
                    <input
                      type="date"
                      value={exportTo}
                      onChange={(e) => setExportTo(e.target.value)}
                    />
                  </label>
                  <label>
                    Transaction state
                    <select value={state} onChange={(e) => setState(e.target.value)}>
                      <option value="">All states</option>
                      <option value="inbox">Inbox</option>
                      <option value="ready">Ready for review</option>
                      <option value="finalized">Finalized</option>
                    </select>
                  </label>
                  <label>
                    Export format
                    <select value={format} onChange={(e) => setFormat(e.target.value)}>
                      <option value="json">JSON · importable</option>
                      <option value="csv">CSV · spreadsheet copy</option>
                    </select>
                  </label>
                </div>
                <small>
                  Leave dates blank for all time. Related purchases and finalized refund history are
                  included to preserve links. Repayments are separate and aren’t included.
                </small>
              </>
            ) : (
              <>
                <p>
                  Export active rules with their merchant alternatives, scopes, categories, and
                  participants. Deleted and rejected rules are excluded.
                </p>
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={pending}
                    onChange={(e) => setPending(e.target.checked)}
                  />
                  Include pending rule proposals
                </label>
                <small>
                  {data.rules.filter((r) => r.active).length} active rules ·{' '}
                  {data.ruleChanges.filter((r) => r.status === 'proposed').length} pending proposals
                </small>
              </>
            )}
            <button className="quiet-button" disabled={busy} onClick={download}>
              <ArrowDownToLine size={15} />
              Download {kind === 'rules' ? 'rules JSON' : format.toUpperCase()}
            </button>
            {downloaded && (
              <p role="status" className="transfer-success">
                <Check size={15} />
                {downloaded}
              </p>
            )}
          </section>
        )}
        <section className="transfer-section">
          <div className="transfer-section-heading">
            <FileUp size={18} />
            <h3>{preview ? 'Review your import' : 'Import ' + kind}</h3>
          </div>
          <p>
            {kind === 'rules'
              ? 'Imported rules become proposals. Review and approve them before they can apply.'
              : 'Choose a Splitwise AI JSON export. Saved splits return for review, and linked refunds wait in Inbox. Importing never changes balances. Use Import statements for bank CSVs.'}
          </p>
          <label>
            Splitwise AI JSON file
            <input
              key={kind}
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(e) => {
                resetPreview();
                setFile(e.target.files?.[0] || null);
              }}
            />
          </label>
          {!preview && (
            <button className="primary" onClick={inspect} disabled={!file || busy}>
              {busy ? <LoaderCircle className="spin" size={15} /> : <FileUp size={15} />}Preview{' '}
              {kind} import
            </button>
          )}
          {preview && (
            <>
              <div className="optimization-stats">
                <div>
                  <b>{preview.counts.total}</b>
                  <span>In file</span>
                </div>
                <div>
                  <b>{adding}</b>
                  <span>To import</span>
                </div>
                <div>
                  <b>{skipped}</b>
                  <span>To skip</span>
                </div>
              </div>
              {kind === 'transactions' && (
                <p className="transfer-note">
                  {preview.counts.savedSplits} saved splits · {preview.counts.previouslyFinalized}{' '}
                  previously finalized. Saved splits need your approval again. No existing
                  transaction will be replaced.
                </p>
              )}
              {preview.people.length > 1 && (
                <div className="transfer-people">
                  <h4>People in this file</h4>
                  {preview.people
                    .filter((p) => !p.source.isSelf)
                    .map((p) => (
                      <div key={p.source.id}>
                        <span>
                          <b>{p.source.name}</b> @{p.source.handle}
                          {p.source.relation ? ' · ' + p.source.relation : ''}
                        </span>
                        <span>
                          {p.isNew
                            ? 'Add new person'
                            : 'Match to ' + p.target.name + ' (@' + p.target.handle + ')'}
                        </span>
                      </div>
                    ))}
                  <small>
                    Existing people are matched by their unique @handle. Their name and relationship
                    won’t be overwritten.
                  </small>
                  <label className="check-line">
                    <input
                      type="checkbox"
                      checked={ackPeople}
                      onChange={(e) => setAckPeople(e.target.checked)}
                    />
                    I reviewed these person matches and new people.
                  </label>
                </div>
              )}
              {preview.counts.duplicates > 0 && (
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={onlyDuplicates}
                    onChange={(e) => {
                      setOnlyDuplicates(e.target.checked);
                      setPage(0);
                    }}
                  />
                  Show duplicate matches only
                </label>
              )}
              <div className="transfer-records">
                {rows.slice(page * 25, (page + 1) * 25).map((row) => (
                  <article className="transfer-record" key={row.rowNumber}>
                    <div className="transfer-record-title">
                      <span className={'pill ' + (row.duplicate ? 'amber' : '')}>
                        {row.duplicate
                          ? keep.has(row.rowNumber)
                            ? 'Keep as distinct'
                            : 'Skip duplicate'
                          : 'New'}
                      </span>
                      <b>{row.transaction?.description || row.rule?.title}</b>
                      {row.transaction && <strong>{money(row.transaction.amountCents)}</strong>}
                    </div>
                    {row.transaction && (
                      <small>
                        {row.transaction.date} ·{' '}
                        {data.accounts.find((a) => a.id === row.transaction!.accountId)?.name} ·{' '}
                        {row.transaction.state === 'finalized'
                          ? 'Previously finalized'
                          : row.transaction.state}
                      </small>
                    )}
                    {row.existingLabel && (
                      <p className="transfer-match">
                        Matches: {row.existingLabel} · {row.existingState} ·{' '}
                        {row.existingId?.startsWith('file-row:')
                          ? row.existingId.replace('file-row:', 'earlier file row ')
                          : row.existingId}
                      </p>
                    )}
                    {row.duplicate && (
                      <label className="check-line">
                        <input
                          type="checkbox"
                          checked={keep.has(row.rowNumber)}
                          disabled={busy}
                          onChange={(e) => {
                            setKeep((old) => {
                              const next = new Set(old);
                              e.target.checked
                                ? next.add(row.rowNumber)
                                : next.delete(row.rowNumber);
                              return next;
                            });
                            setAckSkips(false);
                          }}
                        />
                        Keep row {row.rowNumber} as a distinct{' '}
                        {kind === 'rules' ? 'rule proposal' : 'transaction'}
                      </label>
                    )}
                    <details>
                      <summary>
                        View {row.rule ? 'rule details' : 'saved split and context'}
                      </summary>
                      {row.rule ? (
                        <div className="transfer-details">
                          <b>{merchantLabel(row.rule.definition)}</b>
                          <p>{ruleDescription(row.rule.definition, sourcePeople)}</p>
                          <p>
                            {row.rule.definition.accountId || 'All cards'} ·{' '}
                            {row.rule.definition.category || 'Any bank category'} ·{' '}
                            {row.rule.definition.from || 'Any start'} →{' '}
                            {row.rule.definition.to || 'Any end'}
                          </p>
                        </div>
                      ) : (
                        <div className="transfer-details">
                          {row.transaction?.proposal ? (
                            <>
                              <b>{row.transaction.proposal.category}</b>
                              <p>
                                {row.transaction.proposal.splits
                                  .map(
                                    (s) =>
                                      (sourcePeople.find((p) => p.id === s.personId)?.name || '?') +
                                      ' ' +
                                      money(s.amountCents),
                                  )
                                  .join(' · ')}
                              </p>
                              <p>{row.transaction.proposal.explanation}</p>
                              {row.transaction.proposal.refundOf && (
                                <p>
                                  Linked purchase: {row.transaction.proposal.refundOf}. Refund will
                                  wait in Inbox for review.
                                </p>
                              )}
                            </>
                          ) : (
                            <p>No saved split. This expense will enter Inbox.</p>
                          )}
                          {row.transaction?.instruction && (
                            <p>
                              <b>Instruction: </b>
                              {row.transaction.instruction}
                            </p>
                          )}
                          {row.transaction?.notes.map((note) => (
                            <p key={note.id}>{note.text}</p>
                          ))}
                        </div>
                      )}
                    </details>
                  </article>
                ))}
                {!rows.length && <p>No records in this view.</p>}
              </div>
              {rows.length > 25 && (
                <div className="transfer-pagination">
                  <button
                    className="quiet-button"
                    disabled={page === 0 || busy}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous
                  </button>
                  <span>
                    {page * 25 + 1}–{Math.min(rows.length, (page + 1) * 25)} of {rows.length}
                  </span>
                  <button
                    className="quiet-button"
                    disabled={(page + 1) * 25 >= rows.length || busy}
                    onClick={() => setPage(page + 1)}
                  >
                    Next
                  </button>
                </div>
              )}
              {skipped > 0 && (
                <label className="check-line">
                  <input
                    type="checkbox"
                    checked={ackSkips}
                    onChange={(e) => setAckSkips(e.target.checked)}
                  />
                  I reviewed the {skipped} duplicate {skipped === 1 ? 'record' : 'records'} that
                  will be skipped.
                </label>
              )}
            </>
          )}
        </section>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <footer className="modal-actions transfer-actions">
          {preview && (
            <button className="quiet-button" disabled={busy} onClick={inspect}>
              <RefreshCw size={14} />
              Refresh preview
            </button>
          )}
          <button className="quiet-button" disabled={busy} onClick={onClose}>
            Close
          </button>
          {preview && (
            <button
              className="primary"
              disabled={busy || (skipped > 0 && !ackSkips) || (needsPeopleReview && !ackPeople)}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  const result = await api<{ summary: string }>('transfer/confirm', {
                    id: preview.id,
                    acknowledgeSkips: ackSkips,
                    keepRows: [...keep],
                    acknowledgePeople: ackPeople,
                  });
                  await onImported(kind, result.summary);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}Import{' '}
              {adding}{' '}
              {kind === 'rules'
                ? adding === 1
                  ? 'rule proposal'
                  : 'rule proposals'
                : adding === 1
                  ? 'transaction'
                  : 'transactions'}
            </button>
          )}
        </footer>
      </div>
    </Modal>
  );
}
