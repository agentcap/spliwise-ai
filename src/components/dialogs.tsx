'use client';
import { useState } from 'react';
import { ArrowRight, Check, FileUp, LoaderCircle, Plus, ShieldCheck, Sparkles } from 'lucide-react';
import { money, cents, splitAmount, linkedRefundShares } from '@/lib/money';
import type {
  Snapshot,
  Transaction,
  ImportPreview,
  ImportResult,
  ImportCompletion,
  SplitSpec,
  Rule,
} from '@/lib/types';
import MentionInput from './mention-input';
import ImportContextStep from './import-context-step';
import { merchantPatterns } from '@/lib/rule-definition';
import { api, Modal } from './ui';
const today = () => {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
};
export function PersonDialog({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string, handle: string, relation: string) => Promise<void>;
}) {
  const [name, setName] = useState(''),
    [handle, setHandle] = useState(''),
    [relation, setRelation] = useState('');
  return (
    <Modal
      title="Add someone to your circle"
      subtitle="They don’t need an account. This workspace is yours."
      onClose={onClose}
    >
      <form
        className="modal-body form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave(name, handle, relation);
        }}
      >
        <label>
          Name
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        <label>
          @handle
          <input
            required
            pattern="[a-z][a-z0-9_]{0,39}"
            value={handle}
            onChange={(e) => setHandle(e.target.value.toLowerCase())}
          />
          <small>Letters, numbers, underscores. Used in instructions.</small>
        </label>
        <label>
          Relationship (optional)
          <input
            value={relation}
            maxLength={100}
            onChange={(e) => setRelation(e.target.value)}
            placeholder="Partner, friend, roommate…"
          />
        </label>
        <footer className="modal-actions">
          <button type="button" className="quiet-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" type="submit">
            Add person
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function RepaymentDialog({
  data,
  personId,
  onClose,
  onSave,
}: {
  data: Snapshot;
  personId: string;
  onClose: () => void;
  onSave: (body: unknown) => Promise<void>;
}) {
  const [amount, setAmount] = useState(''),
    [date, setDate] = useState(today()),
    [direction, setDirection] = useState('received'),
    [note, setNote] = useState(''),
    [error, setError] = useState('');
  return (
    <Modal
      title={'Record repayment · ' + data.people.find((p) => p.id === personId)?.name}
      subtitle="Partial payments are welcome. Extra payments remain as credit."
      onClose={onClose}
    >
      <form
        className="modal-body form"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            onSave({ personId, date, amountCents: cents(amount), direction, note });
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <label>
          Direction
          <select value={direction} onChange={(e) => setDirection(e.target.value)}>
            <option value="received">They paid me</option>
            <option value="returned">I returned money to them</option>
          </select>
        </label>
        <label>
          Amount (USD)
          <input
            aria-label="Repayment amount"
            required
            inputMode="decimal"
            placeholder="0.00"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <label>
          Date
          <input required type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </label>
        <label>
          Note (optional)
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </label>
        {error && <p className="error-text">{error}</p>}
        <footer className="modal-actions">
          <button type="button" className="quiet-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save repayment
          </button>
        </footer>
      </form>
    </Modal>
  );
}
function SplitFields({
  data,
  mode,
  setMode,
  participants,
  setParticipants,
  values,
  setValues,
  category,
  setCategory,
}: {
  data: Snapshot;
  mode: SplitSpec['mode'];
  setMode: (m: SplitSpec['mode']) => void;
  participants: string[];
  setParticipants: (p: string[]) => void;
  values: Record<string, string>;
  setValues: (v: Record<string, string>) => void;
  category: string;
  setCategory: (s: string) => void;
}) {
  return (
    <>
      <div className="form-grid">
        <label>
          Split method
          <select value={mode} onChange={(e) => setMode(e.target.value as SplitSpec['mode'])}>
            <option value="equal">Equal split</option>
            <option value="personal">Personal expense</option>
            <option value="exact">Exact amounts</option>
            <option value="percent">Percentages</option>
          </select>
        </label>
        <label>
          Category
          <input
            list="category-options"
            required
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Choose or propose a category"
          />
          <datalist id="category-options">
            {data.categories.map((c) => (
              <option key={c.id} value={c.name} />
            ))}
          </datalist>
        </label>
      </div>
      {mode !== 'personal' && (
        <fieldset className="participant-fields">
          <legend>Participants{mode === 'percent' ? ' · total must be 100%' : ''}</legend>
          {data.people.map((p) => (
            <div className="participant-option" key={p.id}>
              <label>
                <input
                  type="checkbox"
                  aria-label={p.name}
                  checked={participants.includes(p.id)}
                  onChange={() =>
                    setParticipants(
                      participants.includes(p.id)
                        ? participants.filter((id) => id !== p.id)
                        : [...participants, p.id],
                    )
                  }
                />
                <span className="avatar small">{p.name[0]}</span>
                {p.name}
              </label>
              {participants.includes(p.id) && (mode === 'exact' || mode === 'percent') && (
                <div className="amount-input">
                  <span>{mode === 'exact' ? '$' : '%'}</span>
                  <input
                    aria-label={p.name + (mode === 'exact' ? ' amount' : ' percentage')}
                    inputMode="decimal"
                    value={values[p.id] || ''}
                    onChange={(e) => setValues({ ...values, [p.id]: e.target.value })}
                    placeholder="0.00"
                  />
                </div>
              )}
            </div>
          ))}
        </fieldset>
      )}
    </>
  );
}
function specFor(
  mode: SplitSpec['mode'],
  participants: string[],
  values: Record<string, string>,
): SplitSpec {
  return {
    mode,
    participants: mode === 'personal' ? ['self'] : participants,
    values:
      mode === 'exact' || mode === 'percent'
        ? participants.map((id) => cents(values[id] || '0'))
        : undefined,
  };
}
export function SplitDialog({
  tx,
  data,
  onClose,
  onSave,
  onCorrect,
}: {
  tx: Transaction;
  data: Snapshot;
  onClose: () => void;
  onSave: (body: unknown) => Promise<void>;
  onCorrect: (text: string, remember: boolean) => Promise<void>;
}) {
  const [mode, setMode] = useState<SplitSpec['mode']>(tx.proposal?.spec?.mode || 'equal'),
    [participants, setParticipants] = useState(
      tx.proposal?.splits.map((s) => s.personId) || ['self'],
    );
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(
      tx.proposal?.splits.map((s, i) => [
        s.personId,
        (
          (tx.proposal?.spec?.mode === 'percent'
            ? tx.proposal.spec.values?.[i] || 0
            : s.amountCents) / 100
        ).toFixed(2),
      ]) || [],
    ),
  );
  const [category, setCategory] = useState(
      tx.proposal?.category || tx.bankCategory || 'Uncategorized',
    ),
    [instruction, setInstruction] = useState(tx.instruction),
    [remember, setRemember] = useState(false),
    [error, setError] = useState(''),
    [refundOf, setRefundOf] = useState(tx.proposal?.refundOf || ''),
    [tab, setTab] = useState<'manual' | 'instruction'>('manual');
  let preview = '';
  try {
    preview = splitAmount(tx.amountCents, specFor(mode, participants, values))
      .map(
        (s) =>
          (data.people.find((p) => p.id === s.personId)?.name || '?') + ' ' + money(s.amountCents),
      )
      .join(' · ');
  } catch (e) {
    preview = (e as Error).message;
  }
  return (
    <Modal
      title="Make the split yours"
      subtitle={tx.description + ' · ' + tx.date + ' · ' + money(tx.amountCents)}
      wide
      onClose={onClose}
    >
      <div className="modal-body form">
        <div className="tab-switch">
          <button className={tab === 'manual' ? 'active' : ''} onClick={() => setTab('manual')}>
            Enter a split
          </button>
          <button
            className={tab === 'instruction' ? 'active' : ''}
            onClick={() => setTab('instruction')}
          >
            Give an instruction
          </button>
        </div>
        {tab === 'instruction' ? (
          <>
            <MentionInput
              label="Correction instruction"
              value={instruction}
              onChange={setInstruction}
              people={data.people}
              placeholder="Split equally with @someone, or give me exact amounts…"
            />
            <label className="check-label">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Ask AI to propose a reusable rule too
            </label>
            <p className="muted">
              This returns the expense to Inbox. Use Generate revised splits when ready. Rules need
              separate approval.
            </p>
            <footer className="modal-actions">
              <button className="quiet-button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="primary"
                disabled={!instruction.trim()}
                onClick={() => onCorrect(instruction, remember)}
              >
                Save instruction
              </button>
            </footer>
          </>
        ) : (
          <>
            {tx.amountCents < 0 && (
              <label>
                Original purchase (optional)
                <select
                  value={refundOf}
                  onChange={(e) => {
                    setRefundOf(e.target.value);
                    const original = data.transactions.find((t) => t.id === e.target.value);
                    if (original?.proposal) {
                      try {
                        const shares = linkedRefundShares(
                          original.proposal.splits,
                          tx.amountCents,
                          data.transactions
                            .filter(
                              (t) =>
                                t.id !== tx.id &&
                                t.state === 'finalized' &&
                                t.proposal?.refundOf === original.id,
                            )
                            .map((t) => t.proposal!.splits),
                        );
                        setMode('exact');
                        setParticipants(shares.map((s) => s.personId));
                        setValues(
                          Object.fromEntries(
                            shares.map((s) => [s.personId, (s.amountCents / 100).toFixed(2)]),
                          ),
                        );
                        setCategory(original.proposal.category);
                      } catch (error) {
                        setRefundOf('');
                        setError((error as Error).message);
                      }
                    }
                  }}
                >
                  <option value="">Allocate this refund independently</option>
                  {data.transactions
                    .filter((t) => t.state === 'finalized' && t.amountCents > 0)
                    .map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.date} · {t.description} · {money(t.amountCents)}
                      </option>
                    ))}
                </select>
              </label>
            )}
            <SplitFields
              {...{
                data,
                mode,
                setMode,
                participants,
                setParticipants,
                values,
                setValues,
                category,
                setCategory,
              }}
            />
            <div className="allocation-preview">{preview}</div>
            {error && <p className="error-text">{error}</p>}
            <footer className="modal-actions">
              <button className="quiet-button" onClick={onClose}>
                Cancel
              </button>
              <button
                className="primary"
                onClick={() => {
                  try {
                    const spec = specFor(mode, participants, values);
                    splitAmount(tx.amountCents, spec);
                    onSave({
                      id: tx.id,
                      version: tx.version,
                      category,
                      ...spec,
                      refundOf: refundOf || undefined,
                    });
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                Save to Ready
              </button>
            </footer>
          </>
        )}
      </div>
    </Modal>
  );
}
export function RuleDialog({
  data,
  rule,
  onClose,
  onSave,
}: {
  data: Snapshot;
  rule?: Rule;
  onClose: () => void;
  onSave: (body: unknown) => Promise<void>;
}) {
  const d = rule?.definition;
  const [title, setTitle] = useState(rule?.title || ''),
    [merchant, setMerchant] = useState(d ? merchantPatterns(d).join('\n') : ''),
    [accountId, setAccountId] = useState(d?.accountId || ''),
    [bankCategory, setBankCategory] = useState(d?.category || ''),
    [from, setFrom] = useState(d?.from || ''),
    [to, setTo] = useState(d?.to || '');
  const [mode, setMode] = useState<SplitSpec['mode']>(d?.split.mode || 'equal'),
    [participants, setParticipants] = useState(d?.split.participants || ['self']),
    [values, setValues] = useState<Record<string, string>>(
      Object.fromEntries(
        d?.split.participants.map((id, i) => [id, ((d.split.values?.[i] || 0) / 100).toFixed(2)]) ||
          [],
      ),
    ),
    [category, setCategory] = useState(d?.outputCategory || 'Food & Drink'),
    [error, setError] = useState('');
  return (
    <Modal
      title={rule ? 'Propose a rule change' : 'Propose a reusable rule'}
      subtitle="Review this proposal before it becomes active."
      wide
      onClose={onClose}
    >
      <form
        className="modal-body form"
        onSubmit={(e) => {
          e.preventDefault();
          try {
            onSave({
              title,
              ruleId: rule?.id,
              definition: {
                merchant:
                  merchant
                    .split('\n')
                    .map((value) => value.trim())
                    .filter(Boolean)[0] || '',
                merchantAliases: merchant
                  .split('\n')
                  .map((value) => value.trim())
                  .filter(Boolean)
                  .slice(1),
                accountId: accountId || undefined,
                category: bankCategory || undefined,
                from: from || undefined,
                to: to || undefined,
                split: specFor(mode, participants, values),
                outputCategory: category,
              },
            });
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      >
        <label>
          Rule name
          <input
            required
            maxLength={160}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Supercharging together"
          />
        </label>
        <label>
          Merchant description contains
          <textarea
            rows={2}
            value={merchant}
            onChange={(e) => setMerchant(e.target.value)}
            placeholder="One merchant alternative per line (blank means any merchant)"
          />
        </label>
        <div className="form-grid">
          <label>
            Card scope
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">All cards</option>
              {data.accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Bank category scope
            <select value={bankCategory} onChange={(e) => setBankCategory(e.target.value)}>
              <option value="">Any bank category</option>
              {data.categories.map((c) => (
                <option key={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="form-grid">
          <label>
            From (optional)
            <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Through (optional)
            <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
        <SplitFields
          {...{
            data,
            mode,
            setMode,
            participants,
            setParticipants,
            values,
            setValues,
            category,
            setCategory,
          }}
        />
        {error && <p className="error-text">{error}</p>}
        <footer className="modal-actions">
          <button type="button" className="quiet-button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary">
            Save rule proposal
          </button>
        </footer>
      </form>
    </Modal>
  );
}
export function ImportDialog({
  data,
  onClose,
  onImported,
}: {
  data: Snapshot;
  onClose: () => void;
  onImported: (ids: string[], summary: string, process: boolean) => Promise<void>;
}) {
  const [account, setAccount] = useState('sapphire'),
    [file, setFile] = useState<File | null>(null),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [ack, setAck] = useState(false),
    [skipInvalid, setSkipInvalid] = useState(false),
    [keep, setKeep] = useState<number[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [result, setResult] = useState<ImportResult | null>(null),
    [context, setContext] = useState(''),
    [contextFrom, setContextFrom] = useState(''),
    [contextTo, setContextTo] = useState('');
  async function loadPreview() {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('accountId', account);
      const r = await fetch('/api/imports/preview', { method: 'POST', body: form });
      const v = await r.json();
      if (!r.ok) throw new Error(v.error);
      setPreview(v);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!preview) return;
    setBusy(true);
    setError('');
    try {
      const confirmed = await api<ImportResult>('imports/confirm', {
        id: preview.id,
        acknowledgeSkips: ack,
        keepRows: keep,
        skipInvalid,
      });
      setResult(confirmed);
      setContextFrom(confirmed.dateRange.from || '');
      setContextTo(confirmed.dateRange.to || '');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function finish(run: boolean) {
    if (!result || !preview || busy) return;
    setBusy(true);
    setError('');
    try {
      const completion = await api<ImportCompletion>('imports/finish', {
        id: preview.id,
        items: result.items.map(({ id, version }) => ({ id, version })),
        context,
        process: run,
        from: contextFrom || undefined,
        to: contextTo || undefined,
      });
      await onImported(result.ids, completion.summary, run);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={
        result
          ? 'Your statement is in.'
          : preview
            ? 'Review your import'
            : 'Bring your expenses together'
      }
      subtitle={
        result
          ? 'Add optional context for the newly imported dates, then process now or later.'
          : preview
            ? 'Check the date ranges and every proposed skip.'
            : 'Upload an exported Amex, Chase Sapphire, or Chase Prime CSV.'
      }
      onClose={() => {
        if (busy) return;
        if (result) void finish(false);
        else onClose();
      }}
      wide={!!preview && !result}
    >
      <div className="modal-body form">
        <div className="steps">
          <span className={preview ? 'complete' : 'active'}>
            1 <b>Upload</b>
          </span>
          <span className={preview && !result ? 'active' : ''}>
            2 <b>Review</b>
          </span>
          <span className={result ? 'active' : ''}>
            3 <b>Context</b>
          </span>
        </div>
        {result ? (
          <ImportContextStep
            result={result}
            data={data}
            accountId={account}
            context={context}
            onContext={setContext}
            from={contextFrom}
            onFrom={setContextFrom}
            to={contextTo}
            onTo={setContextTo}
            busy={busy}
            onFinish={finish}
          />
        ) : preview ? (
          <>
            <div className="import-ranges">
              <div>
                <small>Transaction dates</small>
                <strong>
                  {preview.dateRange.from || '—'} → {preview.dateRange.to || '—'}
                </strong>
              </div>
              <div>
                <small>Posting dates</small>
                <strong>
                  {preview.postDateRange.from || 'Not provided'}
                  {preview.postDateRange.to ? ' → ' + preview.postDateRange.to : ''}
                </strong>
              </div>
            </div>
            <p className="muted small-text">
              Observed dates only. Overlapping dates can still contain new transactions.
            </p>
            <div className="import-counts">
              {[
                ['New', preview.counts.new],
                ['Duplicates', preview.counts.duplicates],
                ['Card payments', preview.counts.payments],
                ['Invalid', preview.counts.invalid],
              ].map(([label, count]) => (
                <div key={label}>
                  <strong>{count}</strong>
                  <span>{label}</span>
                </div>
              ))}
            </div>
            <div className="preview-table">
              <table>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Transaction</th>
                    <th>Amount</th>
                    <th>Decision</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((r) => (
                    <tr
                      key={r.rowNumber}
                      className={r.error ? 'invalid-row' : r.duplicate ? 'duplicate-row' : ''}
                    >
                      <td>{r.rowNumber}</td>
                      <td>
                        <b>{r.description || 'Invalid row'}</b>
                        <small>
                          {r.date || 'No valid date'}
                          {r.postDate ? ' · posted ' + r.postDate : ''}
                        </small>
                        {r.duplicate &&
                          r.existing.map((m) => (
                            <small key={m.id}>
                              Matches: {m.description} · {m.date} · {money(m.amountCents)} ·{' '}
                              {m.state}
                            </small>
                          ))}
                        {r.error && <small className="error-text">{r.error}</small>}
                      </td>
                      <td>{r.amountCents === null ? '—' : money(r.amountCents)}</td>
                      <td>
                        {r.error ? (
                          'Skip invalid'
                        ) : r.duplicate ? (
                          <label className="check-label">
                            <input
                              type="checkbox"
                              checked={keep.includes(r.rowNumber)}
                              onChange={() =>
                                setKeep(
                                  keep.includes(r.rowNumber)
                                    ? keep.filter((n) => n !== r.rowNumber)
                                    : [...keep, r.rowNumber],
                                )
                              }
                            />
                            Keep as distinct
                          </label>
                        ) : r.kind === 'payment' ? (
                          'Retain in history'
                        ) : (
                          'Add to Inbox'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.counts.duplicates > keep.length && (
              <label className="check-label import-ack">
                <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />I
                reviewed the {preview.counts.duplicates - keep.length} matching rows that will be
                skipped.
              </label>
            )}
            {preview.counts.invalid > 0 && (
              <label className="check-label import-ack">
                <input
                  type="checkbox"
                  checked={skipInvalid}
                  onChange={(e) => setSkipInvalid(e.target.checked)}
                />
                Skip the {preview.counts.invalid} invalid rows shown above and import the valid
                rows.
              </label>
            )}
            <p className="muted small-text">
              Card-bill payments remain in history and do not enter expense splitting.
            </p>
            <footer className="modal-actions">
              <button
                className="quiet-button"
                onClick={() => {
                  setPreview(null);
                  setAck(false);
                  setKeep([]);
                }}
              >
                Back
              </button>
              <button
                className="primary"
                disabled={
                  busy ||
                  (preview.counts.duplicates > keep.length && !ack) ||
                  (preview.counts.invalid > 0 && !skipInvalid)
                }
                onClick={confirm}
              >
                {busy ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}Confirm
                import
              </button>
            </footer>
          </>
        ) : (
          <>
            <label>
              Which card is this statement for?
              <select value={account} onChange={(e) => setAccount(e.target.value)}>
                {data.accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="upload-zone">
              <span className="upload-icon">
                <FileUp size={27} />
              </span>
              <strong>{file ? file.name : 'Choose your statement CSV'}</strong>
              <span>Click to browse · up to 10 MB</span>
              <input
                aria-label="Statement CSV"
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setFile(e.target.files?.[0] || null)}
              />
            </label>
            <div className="tip">
              <ShieldCheck size={18} />
              <p>
                You’ll see a preview before anything is imported. Repeated exports are checked for
                duplicates.
              </p>
            </div>
            <footer className="modal-actions">
              <button className="quiet-button" onClick={onClose}>
                Cancel
              </button>
              <button className="primary" disabled={!file || busy} onClick={loadPreview}>
                {busy ? <LoaderCircle className="spin" size={16} /> : null}Preview import{' '}
                <ArrowRight size={16} />
              </button>
            </footer>
          </>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
