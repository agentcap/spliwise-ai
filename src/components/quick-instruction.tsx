'use client';
import { useRef, useState } from 'react';
import { ArrowUp, LoaderCircle } from 'lucide-react';
import type { AgentJob, Person, Transaction } from '@/lib/types';
import MentionInput from './mention-input';

export default function QuickInstruction({
  tx,
  people,
  job,
  configured,
  onSend,
  onRetry,
  onCancel,
}: {
  tx: Transaction;
  people: Person[];
  job?: AgentJob;
  configured: boolean;
  onSend: (tx: Transaction, text: string) => Promise<void>;
  onRetry: (id: string) => Promise<void>;
  onCancel: (id: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const lock = useRef(false);
  const busy = job?.status === 'queued' || job?.status === 'running';
  async function submit() {
    if (!draft.trim() || lock.current || busy || !configured) return;
    lock.current = true;
    setSending(true);
    setError('');
    try {
      await onSend(tx, draft.trim());
      setDraft('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  return (
    <div className="quick-instruction">
      <div className="quick-composer">
        <MentionInput
          value={draft}
          onChange={setDraft}
          people={people}
          compact
          label={'Instructions for ' + tx.description}
          placeholder="Who shares this? Add context, then press Enter…"
          maxLength={4000}
          onSubmit={submit}
          disabled={sending || busy || !configured}
        />
        <button
          type="button"
          className="quick-send"
          aria-label={'Generate split for ' + tx.description}
          title="Generate split (Enter)"
          onClick={submit}
          disabled={!draft.trim() || sending || busy || !configured}
        >
          {sending || busy ? <LoaderCircle size={15} className="spin" /> : <ArrowUp size={16} />}
        </button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {busy ? (
        <div className="quick-job" role="status">
          <span>
            {job.cancelRequested
              ? 'Stopping…'
              : job.status === 'queued'
                ? 'Queued for the assistant…'
                : job.activity || 'Preparing your split…'}
          </span>
          <button
            type="button"
            className="text-button"
            disabled={!!job.cancelRequested}
            onClick={() => onCancel(job.id)}
          >
            Stop
          </button>
        </div>
      ) : job?.status === 'failed' || job?.status === 'cancelled' ? (
        <div className="quick-job">
          <span>{job.error || 'Stopped. Your instruction is saved.'}</span>
          <button type="button" className="text-button" onClick={() => onRetry(job.id)}>
            Retry
          </button>
        </div>
      ) : (
        <small>
          {configured
            ? 'Enter to split · Shift+Enter for a new line · Context is saved'
            : 'Connect AI to use quick instructions. Manual splits are available.'}
        </small>
      )}
    </div>
  );
}
