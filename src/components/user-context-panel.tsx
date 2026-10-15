'use client';
import { useState } from 'react';
import { Brain, Trash2, MessageSquare } from 'lucide-react';
import type { Snapshot } from '@/lib/types';
import { api } from './ui';
export default function UserContextPanel({
  data,
  onChanged,
  onAsk,
}: {
  data: Snapshot;
  onChanged: () => Promise<void>;
  onAsk: (s: string) => void;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState('');
  return (
    <section className="user-context-panel panel">
      <div className="section-title">
        <div>
          <h3>
            <Brain size={18} /> Saved user context
          </h3>
          <p>
            Facts, relationships and temporary arrangements the assistant remembers separately from
            split rules.
          </p>
        </div>
        <button className="quiet-button" onClick={() => onAsk('Remember that ')}>
          <MessageSquare size={15} />
          Tell the assistant
        </button>
      </div>
      {!data.userContext?.length && (
        <p className="muted">
          Tell chat about your household, preferences, or a trip. Saved facts will appear here with
          their scope.
        </p>
      )}
      <div className="context-grid">
        {data.userContext?.map((c) => (
          <article key={c.id}>
            <div className="section-title">
              <h4>{c.title}</h4>
              <button
                className="icon-button"
                aria-label={'Forget ' + c.title}
                disabled={!!busy}
                onClick={async () => {
                  setBusy(c.id);
                  setError('');
                  try {
                    await api('context/delete', { id: c.id, version: c.version });
                    await onChanged();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy('');
                  }
                }}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <p>{c.text}</p>
            <small>
              {c.personId ? '@' + data.people.find((p) => p.id === c.personId)?.handle + ' · ' : ''}
              {c.tripId ? (data.trips?.find((t) => t.id === c.tripId)?.name || 'Trip') + ' · ' : ''}
              {c.from || c.to
                ? (c.from || 'Beginning') + ' to ' + (c.to || 'Ongoing')
                : 'Ongoing context'}
            </small>
            <details>
              <summary>Your original words</summary>
              <blockquote>{c.quote}</blockquote>
            </details>
            <button
              className="text-button"
              onClick={() => onAsk('Update my saved context "' + c.title + '": ')}
            >
              Update in chat
            </button>
          </article>
        ))}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
