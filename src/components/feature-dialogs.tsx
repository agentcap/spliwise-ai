'use client';
import { useState } from 'react';
import type { Snapshot, SplitSpec, Trip, Transaction } from '@/lib/types';
import { cents } from '@/lib/money';
import { api, Modal } from './ui';
import MentionInput from './mention-input';
export function SpecFields({
  data,
  spec,
  onChange,
  fixedEqual = false,
}: {
  data: Snapshot;
  spec: SplitSpec;
  onChange: (s: SplitSpec) => void;
  fixedEqual?: boolean;
}) {
  return (
    <>
      {!fixedEqual && (
        <label>
          Split method
          <select
            value={spec.mode}
            onChange={(e) =>
              onChange({
                mode: e.target.value as SplitSpec['mode'],
                participants: spec.participants,
                values: spec.participants.map(() => 0),
              })
            }
          >
            <option value="equal">Equal split</option>
            <option value="personal">Personal expense</option>
            <option value="percent">Percentages</option>
            <option value="exact">Exact amounts</option>
          </select>
        </label>
      )}
      {spec.mode !== 'personal' && (
        <fieldset className="participant-fields">
          <legend>
            Participants{' '}
            {spec.mode === 'percent' ? '· total 100%' : spec.mode === 'exact' ? '· USD' : ''}
          </legend>
          {data.people.map((p) => (
            <div className="participant-option" key={p.id}>
              <label>
                <input
                  type="checkbox"
                  checked={spec.participants.includes(p.id)}
                  onChange={(e) => {
                    const next = e.target.checked
                      ? [...spec.participants, p.id]
                      : spec.participants.filter((id) => id !== p.id);
                    onChange({
                      ...spec,
                      participants: next,
                      values: next.map((id) => spec.values?.[spec.participants.indexOf(id)] || 0),
                    });
                  }}
                />
                {p.name}
              </label>
              {spec.participants.includes(p.id) && ['percent', 'exact'].includes(spec.mode) && (
                <input
                  aria-label={p.name + (spec.mode === 'percent' ? ' percentage' : ' amount')}
                  type="number"
                  min="0"
                  step="0.01"
                  value={(spec.values?.[spec.participants.indexOf(p.id)] || 0) / 100}
                  onChange={(e) =>
                    onChange({
                      ...spec,
                      values: spec.participants.map((id, i) =>
                        id === p.id
                          ? Math.round(Number(e.target.value) * 100)
                          : spec.values?.[i] || 0,
                      ),
                    })
                  }
                />
              )}
            </div>
          ))}
        </fieldset>
      )}
    </>
  );
}
function Footer({ busy, onClose, label }: { busy: boolean; onClose: () => void; label: string }) {
  return (
    <footer className="modal-actions">
      <button type="button" className="quiet-button" onClick={onClose}>
        Cancel
      </button>
      <button className="primary" disabled={busy}>
        {busy ? 'Saving…' : label}
      </button>
    </footer>
  );
}
export function TripDialog({
  data,
  trip,
  onClose,
  onSaved,
}: {
  data: Snapshot;
  trip?: Trip;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: data.workspace?.timezone || 'America/Los_Angeles',
  }).format(new Date());
  const [name, setName] = useState(trip?.name || ''),
    [destination, setDestination] = useState(trip?.destination || ''),
    [from, setFrom] = useState(trip?.from || today),
    [to, setTo] = useState(trip?.to || today),
    [context, setContext] = useState(trip?.context || ''),
    [spec, setSpec] = useState<SplitSpec>(trip?.split || { mode: 'equal', participants: ['self'] }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title={trip ? 'Edit trip' : 'Create a trip'}
      subtitle="Dates suggest expenses. You decide which belong."
      onClose={onClose}
    >
      <form
        className="modal-body form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            const result = await api<{ id: string }>('trips/save', {
              id: trip?.id,
              version: trip?.version,
              name,
              destination,
              from,
              to,
              split: spec,
              context,
            });
            await onSaved(result.id);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Trip name
          <input
            required
            maxLength={100}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Yosemite weekend"
          />
        </label>
        <label>
          Destination
          <input
            value={destination}
            maxLength={150}
            onChange={(e) => setDestination(e.target.value)}
            placeholder="Yosemite, California"
          />
        </label>
        <div className="form-grid">
          <label>
            Trip start
            <input required type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label>
            Trip end
            <input
              required
              type="date"
              min={from}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
        </div>
        <SpecFields data={data} spec={spec} onChange={setSpec} />
        <MentionInput
          people={data.people}
          value={context}
          onChange={setContext}
          label="Trip context"
          placeholder="Who joined, which meals were shared, and any exceptions…"
        />
        <p className="muted">
          Defaults apply only to assigned expenses. AI checks context for exceptions; choose Trip
          default to use the saved split directly. Editing a trip returns its unfinished proposals
          to Inbox. Finalized splits stay as approved.
        </p>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <Footer busy={busy} onClose={onClose} label={trip ? 'Save trip' : 'Create trip'} />
      </form>
    </Modal>
  );
}
export function ManualExpenseDialog({
  data,
  tripId,
  onClose,
  onSaved,
}: {
  data: Snapshot;
  tripId: string;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const [description, setDescription] = useState(''),
    [amount, setAmount] = useState(''),
    [date, setDate] = useState(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: data.workspace?.timezone || 'America/Los_Angeles',
      }).format(new Date()),
    ),
    [category, setCategory] = useState('Uncategorized'),
    [note, setNote] = useState(''),
    [trip, setTrip] = useState(tripId),
    [requestId] = useState(() => crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title="Add an expense"
      subtitle="For cash, rent, or anything outside your statements. You are the payer."
      onClose={onClose}
    >
      <form
        className="modal-body form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            const r = await api<{ id: string }>('transactions/manual', {
              description,
              date,
              amountCents: cents(amount),
              category,
              note,
              tripId: trip || null,
              requestId,
            });
            await onSaved(r.id);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Description
          <input
            required
            autoFocus
            maxLength={200}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Dinner, rent, museum tickets…"
          />
        </label>
        <div className="form-grid">
          <label>
            Expense amount (USD)
            <input
              required
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </label>
          <label>
            Expense date
            <input required type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
        </div>
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {data.categories.map((c) => (
              <option key={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label>
          Trip
          <select value={trip} onChange={(e) => setTrip(e.target.value)}>
            <option value="">No trip</option>
            {data.trips
              ?.filter((t) => t.status === 'active')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>
        <MentionInput
          people={data.people}
          value={note}
          onChange={setNote}
          label="Expense notes"
          placeholder="Optional details to keep with this expense"
        />
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <Footer busy={busy} onClose={onClose} label="Add to Inbox" />
      </form>
    </Modal>
  );
}
export function QuickSplitDialog({
  data,
  items,
  onClose,
  onSaved,
}: {
  data: Snapshot;
  items: Transaction[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [participants, setParticipants] = useState(['self']),
    [template, setTemplate] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title={'Split ' + items.length + ' selected expense' + (items.length === 1 ? '' : 's')}
      subtitle="Each split is calculated separately and moves to Ready for review."
      onClose={onClose}
    >
      <form
        className="modal-body form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            await api('transactions/quick', {
              items: items.map((t) => ({ id: t.id, version: t.version })),
              mode: template ? 'template' : 'equal',
              participants,
              templateId: template || undefined,
            });
            await onSaved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Use a template
          <select value={template} onChange={(e) => setTemplate(e.target.value)}>
            <option value="">Equal split with selected people</option>
            {data.templates?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </label>
        {!template && (
          <SpecFields
            fixedEqual
            data={data}
            spec={{ mode: 'equal', participants }}
            onChange={(s) => setParticipants(s.participants)}
          />
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <Footer busy={busy} onClose={onClose} label={'Prepare ' + items.length + ' splits'} />
      </form>
    </Modal>
  );
}
export function AssignTripDialog({
  data,
  items,
  onClose,
  onSaved,
}: {
  data: Snapshot;
  items: Transaction[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [tripId, setTripId] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title={'Assign ' + items.length + ' expenses to a trip'}
      subtitle="Unfinished splits return to Inbox. Finalized allocations remain unchanged."
      onClose={onClose}
    >
      <form
        className="modal-body form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          try {
            await api('trips/assign', {
              items: items.map((t) => ({ id: t.id, version: t.version })),
              tripId: tripId || null,
            });
            await onSaved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Destination trip
          <select value={tripId} onChange={(e) => setTripId(e.target.value)}>
            <option value="">Remove trip assignment</option>
            {data.trips
              ?.filter((t) => t.status === 'active')
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
          </select>
        </label>
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <Footer busy={busy} onClose={onClose} label="Update assignments" />
      </form>
    </Modal>
  );
}
export function TemplateDialog({
  data,
  onClose,
  onSaved,
}: {
  data: Snapshot;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(''),
    [category, setCategory] = useState('Uncategorized'),
    [spec, setSpec] = useState<SplitSpec>({ mode: 'equal', participants: ['self'] }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  return (
    <Modal
      title="Save a split template"
      subtitle="Apply it when you choose. Templates never automatically change expenses."
      onClose={onClose}
    >
      <form
        className="modal-body form"
        onSubmit={async (e) => {
          e.preventDefault();
          if (busy) return;
          setBusy(true);
          try {
            await api('templates/save', { name, category, spec });
            await onSaved();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Template name
          <input
            required
            autoFocus
            maxLength={100}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Dinner with roommates"
          />
        </label>
        <label>
          Category
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            {data.categories.map((c) => (
              <option key={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <SpecFields data={data} spec={spec} onChange={setSpec} />
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <Footer busy={busy} onClose={onClose} label="Save template" />
      </form>
    </Modal>
  );
}
