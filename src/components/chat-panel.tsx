'use client';
import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import {
  ArrowDown,
  ArrowUp,
  LoaderCircle,
  MessageSquare,
  ReceiptText,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  Account,
  AgentJob,
  Person,
  Message,
  Transaction,
  Rule,
  RuleChange,
} from '@/lib/types';
import ChatRuleCard from './chat-rule-card';
import MentionInput from './mention-input';
import { useDisplayTime } from './timezone';

function RichReply({ text }: { text: string }) {
  return (
    <div className="chat-markdown">
      <Markdown
        skipHtml
        components={{
          img: () => null,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

export default function ChatPanel({
  scopeLabel,
  scopeControl,
  onReviewTransactions,
  messages,
  ruleChanges,
  rules,
  accounts,
  onReviewRule,
  jobs,
  people,
  transactions,
  selected,
  configured,
  draft,
  onDraftChange,
  onSend,
  onClose,
  onClearSelection,
  onTransaction,
  onCancel,
  onRetry,
}: {
  scopeLabel: string;
  scopeControl: React.ReactNode;
  onReviewTransactions: () => void;
  messages: Message[];
  ruleChanges: RuleChange[];
  rules: Rule[];
  accounts: Account[];
  onReviewRule: (id: string, approve: boolean, processInbox: boolean) => Promise<void>;
  jobs: AgentJob[];
  people: Person[];
  transactions: Transaction[];
  selected: Transaction[];
  configured: boolean;
  draft: string;
  onDraftChange: (text: string) => void;
  onSend: (text: string) => Promise<void>;
  onClose: () => void;
  onClearSelection: () => void;
  onTransaction: (id: string) => void;
  onCancel: (id: string) => Promise<void>;
  onRetry: (id: string) => Promise<void>;
}) {
  const displayTime = useDisplayTime();
  const scroller = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lock = useRef(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [unread, setUnread] = useState(false);
  const active = jobs.filter((j) => j.status === 'queued' || j.status === 'running');
  const signature = jobs.map((j) => j.id + j.status + j.response + j.activity).join('|');
  const ruleSignature = ruleChanges.map((c) => c.id + c.status + c.matchingInboxCount).join('|');
  const historySignature = messages.map((m) => m.id + m.text).join('|');
  // Older imports stored a message per batch. Show just the last progress entry per job.
  const visible = messages.filter(
    (m, i) =>
      !/^Processed \d+ of \d+ transactions\./.test(m.text) ||
      !messages.slice(i + 1).some((n) => n.jobId === m.jobId && n.role === 'assistant'),
  );
  useEffect(() => {
    if (nearBottom.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    else setUnread(true);
  }, [historySignature, signature, ruleSignature]);
  const attachedJobs = new Set(
    visible.filter((m) => m.role === 'assistant' && m.jobId).map((m) => m.jobId!),
  );
  const otherPending = ruleChanges.filter(
    (c) => c.status === 'proposed' && (!c.jobId || !attachedJobs.has(c.jobId)),
  );
  function ruleCard(change: RuleChange) {
    return (
      <ChatRuleCard
        key={change.id}
        change={change}
        current={rules.find((r) => r.id === change.ruleId)}
        people={people}
        accounts={accounts}
        onReview={onReviewRule}
      />
    );
  }
  function latest() {
    nearBottom.current = true;
    setUnread(false);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  }
  async function submit() {
    if (!draft.trim() || lock.current || !configured) return;
    lock.current = true;
    setSending(true);
    setError('');
    nearBottom.current = true;
    try {
      await onSend(draft.trim());
      onDraftChange('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setSending(false);
    }
  }
  function jobState(job: AgentJob) {
    if (job.status === 'completed') return null;
    const busy = job.status === 'running' || job.status === 'queued';
    return (
      <div className={'chat-job-state ' + job.status}>
        <div className="chat-job-label" role="status">
          {busy ? <LoaderCircle size={13} className="spin" /> : <MessageSquare size={13} />}
          <span>
            {job.cancelRequested
              ? 'Stopping…'
              : job.status === 'queued'
                ? 'Queued · your instruction is saved'
                : job.status === 'running'
                  ? job.activity || 'Thinking through the split…'
                  : job.status === 'cancelled'
                    ? 'Stopped · your context is saved'
                    : 'Could not complete this request'}
          </span>
        </div>
        {job.status === 'running' && job.response && (
          <div className="chat-stream">
            <RichReply text={job.response} />
            <small>Preparing changes…</small>
          </div>
        )}
        {job.status === 'failed' && <p className="error-text">{job.error}</p>}
        <button
          className="text-button"
          disabled={!!job.cancelRequested}
          onClick={() => (busy ? onCancel(job.id) : onRetry(job.id))}
        >
          {busy ? (
            'Stop'
          ) : (
            <>
              <RefreshCw size={12} /> Retry
            </>
          )}
        </button>
      </div>
    );
  }
  return (
    <aside className="chat-panel" aria-label="Split assistant">
      <header>
        <span className="stat-icon">
          <Sparkles size={18} />
        </span>
        <div className="grow">
          <h3>Your split assistant</h3>
          <small>
            {active.length
              ? active.length + ' request' + (active.length > 1 ? 's' : '') + ' in progress'
              : 'A little context. A clearer split.'}
          </small>
        </div>
        <button className="icon-button" aria-label="Close chat" onClick={onClose}>
          <X size={18} />
        </button>
      </header>
      <div
        className="chat-messages"
        ref={scroller}
        onScroll={() => {
          const el = scroller.current!;
          nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (nearBottom.current) setUnread(false);
        }}
      >
        {!configured && (
          <div className="ai-setup">
            <b>Connect your AI</b>
            <p>
              Add your OpenAI API key using the setup instructions. Manual splits and approved rules
              already work.
            </p>
          </div>
        )}
        {!visible.length && (
          <div className="chat-welcome">
            <Sparkles />
            <h3>What should we split?</h3>
            <p>
              Select expenses to focus the conversation, or describe the merchant you have in mind.
            </p>
            <button onClick={() => onDraftChange('Split the selected expenses equally with ')}>
              Split selected expenses
            </button>
            <button
              onClick={() =>
                onDraftChange('Propose a rule for office lunches as my personal expense.')
              }
            >
              Remember an office-lunch rule
            </button>
          </div>
        )}
        {visible.map((m, i) => {
          const job = jobs.find((j) => j.id === m.jobId);
          const hasReply = visible.some((n) => n.jobId === m.jobId && n.role === 'assistant');
          const day = displayTime(m.createdAt, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });
          const previousDay = i
            ? displayTime(visible[i - 1].createdAt, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })
            : '';
          return (
            <div className="chat-turn" key={m.id}>
              {day !== previousDay && <div className="chat-day">{day}</div>}
              <article className={'chat-message ' + m.role}>
                <div className="chat-message-meta">
                  <b>{m.role === 'user' ? 'You' : 'Splitwise AI'}</b>
                  <time dateTime={m.createdAt}>
                    {displayTime(m.createdAt, {
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </time>
                </div>
                {m.transactionIds.length > 0 && (
                  <div className="chat-transaction-links">
                    {m.transactionIds.slice(0, 3).map((id) => {
                      const tx = transactions.find((t) => t.id === id);
                      return (
                        <button key={id} onClick={() => onTransaction(id)}>
                          <ReceiptText size={11} />
                          {tx?.description || 'View expense'}
                        </button>
                      );
                    })}
                    {m.transactionIds.length > 3 && (
                      <small>+{m.transactionIds.length - 3} more</small>
                    )}
                  </div>
                )}
                {m.role === 'assistant' ? <RichReply text={m.text} /> : <p>{m.text}</p>}
                {m.role === 'assistant' &&
                  job?.status === 'completed' &&
                  job.payload.ids?.length && (
                    <div className="chat-result-card">
                      <span>Changes saved · review before finalizing</span>
                      <button className="quiet-button" onClick={onReviewTransactions}>
                        Review proposals
                      </button>
                    </div>
                  )}
              </article>
              {m.role === 'assistant' &&
                m.jobId &&
                !visible
                  .slice(i + 1)
                  .some((next) => next.jobId === m.jobId && next.role === 'assistant') &&
                ruleChanges.filter((change) => change.jobId === m.jobId).map(ruleCard)}
              {m.role === 'user' && job && !hasReply && jobState(job)}
            </div>
          );
        })}
        {otherPending.length > 0 && (
          <section className="chat-pending-rules" aria-label="Other rule proposals">
            <h4>
              Rules awaiting your review <span>{otherPending.length}</span>
            </h4>
            {otherPending.map(ruleCard)}
          </section>
        )}
      </div>
      {unread && (
        <button className="chat-jump" onClick={latest}>
          <ArrowDown size={13} /> Jump to latest
        </button>
      )}
      <div className="chat-compose">
        {scopeControl}
        <div className="chat-scope">
          <ReceiptText size={13} />
          <span>{scopeLabel}</span>
          {selected.length > 0 && (
            <button
              aria-label="Clear chat selection"
              className="icon-button"
              onClick={onClearSelection}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <MentionInput
          value={draft}
          onChange={onDraftChange}
          people={people}
          label="Message the agent"
          placeholder="Ask about an expense, add context, or describe a split…"
          onSubmit={submit}
          disabled={sending || !configured}
        />
        {error && (
          <p role="alert" className="error-text">
            {error}
          </p>
        )}
        <div className="chat-send-row">
          <small>Enter to send · Shift+Enter for a new line</small>
          <button
            className="primary icon-only"
            aria-label="Send instruction"
            disabled={!draft.trim() || sending || !configured}
            onClick={submit}
          >
            {sending ? <LoaderCircle size={16} className="spin" /> : <ArrowUp size={16} />}
          </button>
        </div>
        <p className="chat-approval-note">
          Splits wait for your approval. Reusable rules need review.
        </p>
      </div>
    </aside>
  );
}
