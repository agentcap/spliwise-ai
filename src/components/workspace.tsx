'use client';
import { useCallback, useEffect, useState, useRef } from 'react';
import {
  ArrowDownLeft,
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  CircleHelp,
  FileUp,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Plus,
  Search,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Undo2,
  Users,
  X,
  CheckCheck,
  CalendarDays,
  CreditCard,
  Leaf,
  RefreshCw,
  ReceiptText,
  Settings,
  Trash2,
} from 'lucide-react';
import { money } from '@/lib/money';
import type { Snapshot, Transaction, Rule, ImportPreview } from '@/lib/types';
import QuickInstruction from './quick-instruction';
import TransactionContext from './transaction-context';
import ChatPanel from './chat-panel';
import { DeleteRuleDialog, OptimizeRulesDialog } from './rule-management';
import DataTransferDialog from './data-transfer-dialog';
import ThemeToggle from './theme-toggle';
import SettingsDialog from './settings-dialog';
import PersonLedger from './person-ledger';
import { WorkspaceProviders } from './timezone';
import { api, Modal, ruleDescription, merchantLabel } from './ui';
import { ImportDialog, PersonDialog, RepaymentDialog, SplitDialog, RuleDialog } from './dialogs';
type View = 'overview' | 'review' | 'finalized' | 'people' | 'rules' | 'imports';
export default function Workspace() {
  const [page, setPage] = useState(0),
    [settingsOpen, setSettingsOpen] = useState(false),
    [fetchedDetail, setFetchedDetail] = useState<Transaction | null>(null);
  const [data, setData] = useState<Snapshot | null>(null),
    [view, setView] = useState<View>('overview'),
    [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null),
    [loading, setLoading] = useState(false);
  const [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [search, setSearch] = useState(''),
    [personFilter, setPersonFilter] = useState(''),
    [accountFilter, setAccountFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set()),
    [chatOpen, setChatOpen] = useState(false),
    [chat, setChat] = useState('');
  const [importDetail, setImportDetail] = useState<{
    preview: ImportPreview;
    summary: string;
    rows: { rowNumber: number; status: string; kind: string }[];
  } | null>(null);
  const [importOpen, setImportOpen] = useState(false),
    [personOpen, setPersonOpen] = useState(false),
    [repayPerson, setRepayPerson] = useState<string | null>(null),
    [personDetail, setPersonDetail] = useState<string | null>(null),
    [editTx, setEditTx] = useState<Transaction | null>(null),
    [detailTxId, setDetailTxId] = useState<string | null>(null),
    [ruleEditor, setRuleEditor] = useState<Rule | 'new' | null>(null),
    [deletingRule, setDeletingRule] = useState<Rule | null>(null),
    [optimizingRules, setOptimizingRules] = useState(false),
    [transferKind, setTransferKind] = useState<'transactions' | 'rules' | null>(null);
  const fetchSequence = useRef(0);
  const fetchData = useCallback(async () => {
    const q = new URLSearchParams({ paged: '1', view, page: String(page) });
    if (search) q.set('search', search);
    if (accountFilter) q.set('account', accountFilter);
    if (personFilter) q.set('person', personFilter);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    const sequence = ++fetchSequence.current;
    try {
      const next = await api<Snapshot>('state?' + q);
      if (sequence === fetchSequence.current) setData(next);
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
    }
  }, [from, to, view, page, search, accountFilter, personFilter]);
  useEffect(() => {
    setPage(0);
    setSelected(new Set());
  }, [view, from, to, search, accountFilter, personFilter]);
  useEffect(() => {
    if (!detailTxId) {
      setFetchedDetail(null);
      return;
    }
    let active = true;
    api<Transaction>('transactions/' + detailTxId)
      .then((tx) => {
        if (active) setFetchedDetail(tx);
      })
      .catch((e) => {
        if (active) setNotice({ text: e.message, error: true });
      });
    return () => {
      active = false;
    };
  }, [detailTxId]);
  useEffect(() => {
    fetchData();
  }, [fetchData]);
  const currentJob = data?.jobs.find((j) => j.status === 'queued' || j.status === 'running');
  useEffect(() => {
    if (!currentJob) return;
    const source = new EventSource('/api/jobs/' + currentJob.id + '/events');
    source.onmessage = (event) => {
      try {
        if (view === 'review' && JSON.parse(event.data).status === 'completed') setPage(0);
      } catch {}
      fetchData();
    };
    source.onerror = () => {
      source.close();
      fetchData();
    };
    const timer = setInterval(fetchData, 5000);
    return () => {
      source.close();
      clearInterval(timer);
    };
  }, [currentJob?.id, fetchData]);
  async function action(work: () => Promise<unknown>, message?: string) {
    setLoading(true);
    setNotice(null);
    try {
      await work();
      if (message) setNotice({ text: message });
      await fetchData();
      return true;
    } catch (e) {
      setNotice({ text: (e as Error).message, error: true });
      return false;
    } finally {
      setLoading(false);
    }
  }
  async function undo() {
    await action(() => api('undo', {}), 'Last action undone.');
  }
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key === 'z' &&
        !['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) &&
        !document.querySelector('dialog[open]')
      ) {
        e.preventDefault();
        undo();
      }
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  });
  function navigate(next: View) {
    setView(next);
    setSelected(new Set());
    setSearch('');
    setPersonFilter('');
    setAccountFilter('');
  }
  function toggle(id: string) {
    setSelected((old) => {
      const next = new Set(old);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  async function review(items: Transaction[], kind: 'approve' | 'reject' | 'reopen') {
    if (
      await action(
        () =>
          api('transactions/review', {
            action: kind,
            items: items.map((t) => ({ id: t.id, version: t.version })),
          }),
        kind === 'approve'
          ? 'Splits finalized. Balances updated.'
          : kind === 'reopen'
            ? 'Reopened for review. Balances updated.'
            : 'Returned to Inbox.',
      )
    )
      setSelected(new Set());
  }
  async function process(ids?: string[]) {
    await action(
      () => api('jobs', { kind: 'process', ids }),
      'Processing started. You can keep reviewing.',
    );
    setView('review');
  }
  async function sendChat(text: string) {
    const ids = data?.transactions
      .filter((t) => selected.has(t.id) && t.state !== 'finalized')
      .map((t) => t.id);
    if (selected.size && !ids?.length)
      throw new Error(
        'Select Inbox or Ready expenses to send instructions. Finalized expenses are read-only.',
      );
    await api('jobs', { kind: 'chat', text, ids: ids?.length ? ids : undefined });
    await fetchData();
  }
  async function sendInstruction(tx: Transaction, text: string) {
    await api('transactions/instruct', { items: [{ id: tx.id, version: tx.version }], text });
    await fetchData();
  }
  async function cancelJob(id: string) {
    await action(() => api('jobs/' + id + '/cancel', {}));
  }
  async function retryJob(id: string) {
    await action(() => api('jobs/' + id + '/retry', {}));
  }
  async function reviewChatRule(id: string, approve: boolean, processInbox: boolean) {
    const result = await api<{ processed: number }>('rules/review', { id, approve, processInbox });
    await fetchData();
    setNotice({
      text: !approve
        ? 'Rule proposal rejected.'
        : result.processed
          ? 'Rule activated. Processing ' +
            result.processed +
            ' matching Inbox expense' +
            (result.processed === 1 ? '.' : 's.')
          : 'Rule activated for future processing.',
    });
  }
  if (!data)
    return (
      <div className="initial-loading">
        <span className="brand-symbol">
          <Sparkles />
        </span>
        <h2>Splitwise AI</h2>
        <p>{notice?.text || 'Opening your workspace…'}</p>
        {notice && <button onClick={fetchData}>Try again</button>}
      </div>
    );
  const d = data.dashboard;
  const detailTx =
    data.transactions.find((t) => t.id === detailTxId) ||
    (fetchedDetail?.id === detailTxId ? fetchedDetail : null);
  const filtered = data.transactions.filter(
    (t) =>
      (!from || t.date >= from) &&
      (!to || t.date <= to) &&
      (!search ||
        [
          t.description,
          t.instruction,
          t.proposal?.category || '',
          ...t.notes.map((n) => n.text),
        ].some((value) => value.toLowerCase().includes(search.toLowerCase()))) &&
      (!personFilter || t.proposal?.splits.some((s) => s.personId === personFilter)) &&
      (!accountFilter || t.accountId === accountFilter),
  );
  const chosen = filtered.filter((t) => selected.has(t.id));
  const title = {
    overview: 'Overview',
    review: 'Review workspace',
    finalized: 'Finalized expenses',
    people: 'Your people',
    rules: 'Rules & context',
    imports: 'Import history',
  }[view];
  const nav = [
    { view: 'overview' as const, label: 'Overview', icon: LayoutDashboard },
    {
      view: 'review' as const,
      label: 'Review workspace',
      icon: ListChecks,
      count: d.inboxCount + d.readyCount,
    },
    { view: 'finalized' as const, label: 'Finalized', icon: ShieldCheck },
    { view: 'people' as const, label: 'People', icon: Users },
    {
      view: 'rules' as const,
      label: 'Rules & context',
      icon: SlidersHorizontal,
      count: data.ruleChanges.filter((r) => r.status === 'proposed').length,
    },
    { view: 'imports' as const, label: 'Import history', icon: ReceiptText },
  ];
  const filters = (
    <div className="filters">
      <div className="search-input">
        <Search size={16} />
        <input
          aria-label="Search transactions"
          placeholder="Search transactions…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <select
        aria-label="Filter by person"
        value={personFilter}
        onChange={(e) => setPersonFilter(e.target.value)}
      >
        <option value="">All people</option>
        {data.people.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter by card"
        value={accountFilter}
        onChange={(e) => setAccountFilter(e.target.value)}
      >
        <option value="">All cards</option>
        {data.accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </select>
    </div>
  );
  function groups(transactions: Transaction[], state: 'inbox' | 'ready') {
    const grouped = new Map<string, Transaction[]>();
    for (const t of transactions) {
      const pattern = t.proposal
        ? JSON.stringify([
            t.proposal.source,
            t.proposal.ruleId,
            t.proposal.spec,
            t.proposal.splits.map((s) => s.personId).sort(),
          ])
        : 'none';
      const key =
        state === 'inbox'
          ? t.id
          : t.batchId + '|' + t.description.replace(/\s+/g, ' ').toUpperCase() + '|' + pattern;
      grouped.set(key, [...(grouped.get(key) || []), t]);
    }
    let lastBatch: string | null | undefined;
    return [...grouped].map(([key, items]) => {
      const t = items[0],
        p = t.proposal,
        marker = t.batchId !== lastBatch;
      lastBatch = t.batchId;
      const batch = data!.batches.find((b) => b.id === t.batchId);
      return (
        <div key={key}>
          {marker && batch && (
            <div className="batch-marker">
              <span />
              {batch.label}
              <span />
            </div>
          )}
          <article className="transaction-card">
            <div className="transaction-main">
              <input
                type="checkbox"
                aria-label={'Select ' + t.description + (items.length > 1 ? ' group' : '')}
                checked={items.every((t) => selected.has(t.id))}
                onChange={() =>
                  setSelected((old) => {
                    const n = new Set(old),
                      all = items.every((t) => old.has(t.id));
                    for (const t of items) {
                      if (all) n.delete(t.id);
                      else n.add(t.id);
                    }
                    return n;
                  })
                }
              />
              <span className={'merchant-icon ' + (t.amountCents < 0 ? 'refund' : '')}>
                <ReceiptText size={17} />
              </span>
              <div className="grow">
                <h4>{t.description}</h4>
                <small>
                  {data!.accounts.find((a) => a.id === t.accountId)?.name} · {t.date}
                  {items.length > 1 ? ' · ' + items.length + ' expenses' : ''}
                </small>
              </div>
              <strong>{money(items.reduce((s, t) => s + t.amountCents, 0))}</strong>
            </div>
            {p ? (
              <>
                <div className="proposal-line">
                  <span className="pill">
                    {p.category}
                    {!data!.categories.some((c) => c.name === p.category) ? ' · New category' : ''}
                  </span>
                  <span className={'confidence ' + p.confidence}>{p.confidence} confidence</span>
                </div>
                <div className="split-preview">
                  {p.splits.map((s) => (
                    <span key={s.personId}>
                      <i>{data!.people.find((p) => p.id === s.personId)?.name[0]}</i>
                      {data!.people.find((p) => p.id === s.personId)?.name}
                      <b>
                        {items.length === 1
                          ? money(s.amountCents)
                          : money(
                              items.reduce(
                                (n, t) =>
                                  n +
                                  (t.proposal?.splits.find((x) => x.personId === s.personId)
                                    ?.amountCents || 0),
                                0,
                              ),
                            )}
                      </b>
                    </span>
                  ))}
                </div>
                <p className="explanation">
                  <Sparkles size={13} />
                  <span>
                    {p.source === 'rule'
                      ? 'Rule: '
                      : p.source === 'inference'
                        ? 'AI inference: '
                        : ''}
                    {p.explanation}
                  </span>
                </p>
              </>
            ) : (
              <p className="needs-input">
                <CircleHelp size={15} />
                {t.attention ||
                  (t.instruction
                    ? 'Saved instruction: ' + t.instruction
                    : 'Tell the agent who should share this expense.')}
              </p>
            )}
            {items.length > 1 && (
              <details className="group-details">
                <summary>
                  See all {items.length} expenses <ChevronDown size={13} />
                </summary>
                {items.map((t) => (
                  <div className="group-row" key={t.id}>
                    <input
                      type="checkbox"
                      aria-label={'Select expense ' + t.date + ' ' + t.description}
                      checked={selected.has(t.id)}
                      onChange={() => toggle(t.id)}
                    />
                    <span>{t.date}</span>
                    <strong>{money(t.amountCents)}</strong>
                    <button className="text-button" onClick={() => setEditTx(t)}>
                      Edit split
                    </button>
                  </div>
                ))}
              </details>
            )}
            <TransactionContext transactions={items} />
            {state === 'inbox' && (
              <QuickInstruction
                tx={t}
                people={data!.people}
                configured={data!.aiConfigured}
                job={data!.jobs.find((j) => j.payload.ids?.includes(t.id))}
                onSend={sendInstruction}
                onCancel={cancelJob}
                onRetry={retryJob}
              />
            )}
            <footer className="card-actions">
              <button className="text-button" onClick={() => setEditTx(t)}>
                {items.length > 1 ? 'Edit first split' : 'Edit split'}
              </button>
              <div>
                {state === 'ready' && (
                  <>
                    <button
                      className="quiet-button"
                      disabled={loading}
                      onClick={() => review(items, 'reject')}
                    >
                      Reject{items.length > 1 ? ' all' : ''}
                    </button>
                    <button
                      className="approve-button"
                      disabled={loading}
                      onClick={() => review(items, 'approve')}
                    >
                      <Check size={14} />
                      Approve{items.length > 1 ? ' ' + items.length : ''}
                    </button>
                  </>
                )}
              </div>
            </footer>
          </article>
        </div>
      );
    });
  }
  return (
    <WorkspaceProviders
      error={notice?.error ? notice.text : null}
      timeZone={data.workspace?.timezone || 'America/Los_Angeles'}
    >
      <div className={'app-shell ' + (chatOpen ? 'has-chat' : '')}>
        <aside className="sidebar">
          <a href="/" className="brand">
            <span className="brand-symbol">
              <Sparkles size={22} />
            </span>
            <span>
              Splitwise <b>AI</b>
            </span>
          </a>
          <p className="sidebar-caption">A CLEARER SHARE</p>
          <nav>
            {nav.map((n) => (
              <button
                key={n.view}
                aria-label={n.label}
                className={view === n.view ? 'active' : ''}
                onClick={() => navigate(n.view)}
              >
                <n.icon size={18} />
                <span>{n.label}</span>
                {!!n.count && <b>{n.count}</b>}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="local-badge">
              <span />
              Personal workspace
              <small>
                {data.workspace?.production ? 'Private server storage' : 'Saved on this computer'}
              </small>
            </div>
            <button className="sidebar-import" onClick={() => setImportOpen(true)}>
              <Plus size={18} />
              Import statements
            </button>
            <div className="self-profile">
              <span className="avatar">M</span>
              <div>
                My workspace
                <small>USD · {data.workspace?.production ? 'Private' : 'Local'}</small>
              </div>
              <Leaf size={17} />
            </div>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumbs">
              My workspace <span>/</span>
              <b>{title}</b>
            </div>
            <div className="topbar-actions">
              <button
                className="icon-button"
                aria-label="Workspace settings"
                title="Settings"
                onClick={() => setSettingsOpen(true)}
              >
                <Settings size={18} />
              </button>
              <ThemeToggle />
              <button
                className="quiet-button"
                onClick={undo}
                disabled={loading || !data.batches.some((b) => !b.undoneAt)}
                title="Undo last action (Ctrl+Z)"
              >
                <Undo2 size={16} />
                Undo
              </button>
              <button
                className={'quiet-button ' + (chatOpen ? 'active' : '')}
                onClick={() => setChatOpen(!chatOpen)}
              >
                <Sparkles size={16} />
                Ask AI
              </button>
              <span className="avatar small">M</span>
            </div>
          </header>
          <main>
            <div className="page-heading">
              <div>
                <div className="eyebrow">
                  <span />
                  {view === 'overview' ? 'YOUR MONEY, IN VIEW' : 'YOUR PERSONAL WORKSPACE'}
                </div>
                <h1>{title}</h1>
                <p>
                  {view === 'overview'
                    ? 'Less sorting. More settling up.'
                    : view === 'review'
                      ? 'Give every expense the right share. You make the final call.'
                      : view === 'rules'
                        ? 'Teach it once. Review every change.'
                        : view === 'people'
                          ? 'The people you share life—and expenses—with.'
                          : view === 'imports'
                            ? 'Every statement, with a record of what was added.'
                            : 'Accepted splits that count toward your balances.'}
                </p>
              </div>
              <div className="rule-page-actions">
                <button
                  className="quiet-button"
                  onClick={() => setTransferKind(view === 'rules' ? 'rules' : 'transactions')}
                >
                  <ArrowDownUp size={16} /> Import / export
                </button>
                <button className="primary" onClick={() => setImportOpen(true)}>
                  <FileUp size={17} />
                  Import statements
                </button>
              </div>
            </div>
            <div className="date-strip">
              <CalendarDays size={16} />
              <span>Expense dates</span>
              <input
                aria-label="Start date"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
              <span>to</span>
              <input
                aria-label="End date"
                type="date"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
              {from || to ? (
                <button
                  className="text-button"
                  onClick={() => {
                    setFrom('');
                    setTo('');
                  }}
                >
                  Clear
                </button>
              ) : (
                <span className="all-time">All time</span>
              )}
            </div>
            {notice && (
              <div
                className={'notice ' + (notice.error ? 'error' : '')}
                role={notice.error ? 'alert' : 'status'}
              >
                <span>{notice.error ? <CircleHelp size={17} /> : <Check size={17} />}</span>
                {notice.text}
                <button
                  className="icon-button"
                  aria-label="Dismiss message"
                  onClick={() => setNotice(null)}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            {currentJob && (
              <div className="job-progress" role="status">
                <LoaderCircle className="spin" size={17} />
                <div className="grow">
                  <b>
                    {currentJob.kind === 'chat' ? 'Agent is working' : 'Processing transactions'} ·{' '}
                    {currentJob.progress}%
                  </b>
                  <small>{currentJob.result || 'Preparing your proposals…'}</small>
                  <progress max={100} value={currentJob.progress} />
                </div>
                <button
                  className="text-button"
                  onClick={() => action(() => api('jobs/' + currentJob.id + '/cancel', {}))}
                >
                  Cancel
                </button>
              </div>
            )}
            {data.jobs
              .filter((j) => j.status === 'failed' || j.status === 'cancelled')
              .slice(0, 1)
              .map((j) => (
                <div className="notice error" key={j.id}>
                  <CircleHelp size={17} />
                  <span className="grow">{j.error || 'Processing cancelled.'}</span>
                  <button
                    className="quiet-button"
                    onClick={() => action(() => api('jobs/' + j.id + '/retry', {}))}
                  >
                    <RefreshCw size={14} />
                    Retry remaining
                  </button>
                </div>
              ))}
            {view === 'overview' && (
              <>
                <section className="summary-grid">
                  <article className="balance-hero">
                    <div className="hero-top">
                      <span>Total outstanding</span>
                      <span className="round-icon">
                        <ArrowDownLeft size={22} />
                      </span>
                    </div>
                    <h2>{money(d.totalOutstandingCents)}</h2>
                    <p>
                      Across {d.people.filter((p) => p.outstandingCents > 0).length} people · all
                      finalized expenses
                    </p>
                    <div className="hero-divider" />
                    <div className="hero-bottom">
                      <span>
                        <i />
                        You’re owed this amount
                      </span>
                      <span>USD</span>
                    </div>
                  </article>
                  <article className="stat-card">
                    <span className="stat-icon">
                      <Users size={20} />
                    </span>
                    <p>{from || to ? 'Unpaid from selected dates' : 'Shared expenses'}</p>
                    <h2>{money(from || to ? d.filteredOutstandingCents : d.sharedCents)}</h2>
                    <small>
                      {from || to
                        ? 'Includes repayments received later'
                        : 'Other people’s shares in this period'}
                    </small>
                  </article>
                  <article className="stat-card">
                    <span className="stat-icon warm">
                      <CreditCard size={20} />
                    </span>
                    <p>Your share</p>
                    <h2>{money(d.personalCents)}</h2>
                    <small>Personal share of finalized spending</small>
                  </article>
                </section>
                <section className="review-banner">
                  <div className="banner-icon">
                    <Sparkles size={24} />
                  </div>
                  <div className="grow">
                    <h3>
                      {d.inboxCount + d.readyCount
                        ? 'A few expenses need your eye.'
                        : 'A fresh start for your shared expenses.'}
                    </h3>
                    <p>
                      {d.inboxCount} in Inbox · {d.readyCount} ready for review. Finalize splits to
                      update balances.
                    </p>
                  </div>
                  <button className="white-button" onClick={() => navigate('review')}>
                    Open review <ArrowRight size={16} />
                  </button>
                </section>
                <div className="section-title">
                  <div>
                    <h2>Who owes you</h2>
                    <p>
                      {from || to
                        ? 'Unpaid shares from expenses in the selected dates.'
                        : 'A clear picture of every shared tab.'}
                    </p>
                  </div>
                  <button className="text-button" onClick={() => setPersonOpen(true)}>
                    <Plus size={15} />
                    Add person
                  </button>
                </div>
                {d.people.length ? (
                  <section className="people-balance-grid">
                    {d.people.map((b, i) => (
                      <article className="person-balance-card" key={b.person.id}>
                        <div className="person-top">
                          <span className={'avatar color-' + (i % 4)}>{b.person.name[0]}</span>
                          <div className="grow">
                            <h3>{b.person.name}</h3>
                            <small>{b.person.relation || 'Shared expenses'}</small>
                          </div>
                          <button
                            className="icon-button"
                            aria-label={'View ' + b.person.name + ' transactions'}
                            onClick={() => setPersonDetail(b.person.id)}
                          >
                            <ArrowUpRight size={18} />
                          </button>
                        </div>
                        <p className="muted">{from || to ? 'Unpaid in range' : 'Still owes you'}</p>
                        <strong className="person-amount">
                          {money(from || to ? b.inRangeOutstandingCents : b.outstandingCents)}
                        </strong>
                        {b.creditCents > 0 && (
                          <p className="credit-text">
                            {money(b.creditCents)} credit · you owe them
                          </p>
                        )}
                        <div className="person-card-footer">
                          <span>
                            {b.unpaidExpenseCount ??
                              b.expenses.filter((e) => e.remainingCents > 0).length}{' '}
                            unpaid expenses
                          </span>
                          <button
                            className="text-button"
                            onClick={() => setRepayPerson(b.person.id)}
                          >
                            Record repayment
                          </button>
                        </div>
                      </article>
                    ))}
                  </section>
                ) : (
                  <div className="empty-state compact">
                    <Users />
                    <h3>Good company starts here.</h3>
                    <p>Add people, then mention them with @ in chat.</p>
                    <button className="quiet-button" onClick={() => setPersonOpen(true)}>
                      <Plus size={16} />
                      Add your first person
                    </button>
                  </div>
                )}
                <section className="analytics-grid">
                  <article className="panel">
                    <div className="section-title">
                      <div>
                        <h3>Spending over time</h3>
                        <p>Finalized expenses, including refunds</p>
                      </div>
                      <span className="pill">Monthly</span>
                    </div>
                    {d.months.length ? (
                      <div className="bar-chart">
                        {d.months.slice(-12).map((m) => (
                          <div
                            key={m.month}
                            className="bar-column"
                            title={m.month + ': ' + money(m.amountCents)}
                          >
                            <span className="bar-value">{money(m.amountCents)}</span>
                            <div className="bar-track">
                              <div
                                className={'bar ' + (m.amountCents < 0 ? 'negative' : '')}
                                style={{
                                  height:
                                    Math.max(
                                      4,
                                      (Math.abs(m.amountCents) /
                                        Math.max(
                                          1,
                                          ...d.months.map((m) => Math.abs(m.amountCents)),
                                        )) *
                                        100,
                                    ) + '%',
                                }}
                              />
                            </div>
                            <span>
                              {new Date(m.month + '-02').toLocaleDateString('en-US', {
                                month: 'short',
                              })}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="chart-empty">
                        <span className="ghost-bars">
                          {[25, 50, 38, 68, 58, 90].map((h, i) => (
                            <i key={i} style={{ height: h + '%' }} />
                          ))}
                        </span>
                        <p>Your spending story will appear here.</p>
                      </div>
                    )}
                  </article>
                  <article className="panel">
                    <div className="section-title">
                      <div>
                        <h3>By category</h3>
                        <p>Where your expenses go</p>
                      </div>
                    </div>
                    {d.categories.length ? (
                      d.categories.slice(0, 6).map((c, i) => (
                        <div className="category-row" key={c.name}>
                          <div>
                            <span>
                              <i className={'dot color-' + (i % 4)} />
                              {c.name}
                            </span>
                            <b>{money(c.amountCents)}</b>
                          </div>
                          <progress
                            max={Math.max(1, ...d.categories.map((c) => Math.abs(c.amountCents)))}
                            value={Math.abs(c.amountCents)}
                          />
                        </div>
                      ))
                    ) : (
                      <div className="chart-empty">
                        <ReceiptText size={30} />
                        <p>Categories appear after you finalize splits.</p>
                      </div>
                    )}
                  </article>
                </section>
                <p className="footnote">
                  <ShieldCheck size={14} />
                  Only finalized splits affect these numbers. AI processing sends necessary
                  transaction details to OpenAI.
                </p>
              </>
            )}
            {view === 'review' && (
              <>
                {filters}
                <div className="review-toolbar">
                  <span>
                    {selected.size
                      ? selected.size + ' selected'
                      : filtered.filter((t) => t.state !== 'finalized').length +
                        ' unfinished expenses'}
                    {selected.size > 0 && (
                      <button className="text-button" onClick={() => setSelected(new Set())}>
                        Clear
                      </button>
                    )}
                  </span>
                  <div>
                    <button
                      className="quiet-button"
                      disabled={
                        loading ||
                        !data.transactions.some((t) => t.state === 'inbox' && t.instruction)
                      }
                      onClick={() =>
                        process(
                          data.transactions
                            .filter((t) => t.state === 'inbox' && t.instruction)
                            .map((t) => t.id),
                        )
                      }
                    >
                      Generate revised splits
                    </button>
                    <button
                      className="primary"
                      disabled={loading || !!currentJob}
                      onClick={() =>
                        process(
                          selected.size
                            ? chosen.filter((t) => t.state !== 'finalized').map((t) => t.id)
                            : filtered.filter((t) => t.state === 'inbox').map((t) => t.id),
                        )
                      }
                    >
                      <Sparkles size={16} />
                      {selected.size
                        ? 'Process selected'
                        : data.pagination &&
                            data.pagination.inbox >
                              filtered.filter((t) => t.state === 'inbox').length
                          ? 'Process this page (' +
                            filtered.filter((t) => t.state === 'inbox').length +
                            ')'
                          : 'Process Inbox'}
                    </button>
                  </div>
                </div>
                {chosen.some((t) => t.state === 'ready') && (
                  <div className="selection-bar">
                    <b>
                      {chosen.filter((t) => t.state === 'ready').length} Ready proposals selected
                    </b>
                    <button
                      className="quiet-button"
                      onClick={() =>
                        review(
                          chosen.filter((t) => t.state === 'ready'),
                          'reject',
                        )
                      }
                    >
                      Reject selected
                    </button>
                    <button
                      className="primary"
                      onClick={() =>
                        review(
                          chosen.filter((t) => t.state === 'ready'),
                          'approve',
                        )
                      }
                    >
                      <CheckCheck size={15} />
                      Approve {chosen.filter((t) => t.state === 'ready').length}
                    </button>
                  </div>
                )}
                <div className="review-board">
                  {(['inbox', 'ready'] as const).map((state) => (
                    <section className={'review-column ' + state} key={state}>
                      <header className="column-heading">
                        <div>
                          <span className={'state-dot ' + state} />
                          <input
                            type="checkbox"
                            aria-label={'Select all ' + (state === 'inbox' ? 'Inbox' : 'Ready')}
                            checked={
                              filtered.some((t) => t.state === state) &&
                              filtered
                                .filter((t) => t.state === state)
                                .every((t) => selected.has(t.id))
                            }
                            onChange={() =>
                              setSelected((old) => {
                                const next = new Set(old),
                                  items = filtered.filter((t) => t.state === state),
                                  all = items.every((t) => old.has(t.id));
                                for (const t of items) {
                                  if (all) next.delete(t.id);
                                  else next.add(t.id);
                                }
                                return next;
                              })
                            }
                          />
                          <h2>{state === 'inbox' ? 'Inbox' : 'Ready for review'}</h2>
                          <b>{filtered.filter((t) => t.state === state).length}</b>
                        </div>
                        <small>
                          {state === 'inbox'
                            ? 'Needs context or a proposed split'
                            : 'Check the split. Make it final.'}
                        </small>
                      </header>
                      <div className="column-body">
                        {groups(
                          filtered.filter((t) => t.state === state),
                          state,
                        )}
                        {!filtered.some((t) => t.state === state) && (
                          <div className="empty-state">
                            <span className="empty-icon">
                              {state === 'inbox' ? <ReceiptText /> : <CheckCheck />}
                            </span>
                            <h3>{state === 'inbox' ? 'All clear here.' : 'Ready when you are.'}</h3>
                            <p>
                              {state === 'inbox'
                                ? 'Import a statement to start reviewing.'
                                : 'Process Inbox or enter a split to see proposals here.'}
                            </p>
                          </div>
                        )}
                      </div>
                    </section>
                  ))}
                </div>
                <p className="footnote">
                  <Undo2 size={14} />
                  Each divider marks an action batch that Undo can reverse.
                </p>
              </>
            )}
            {(view === 'review' || view === 'finalized' || view === 'imports') &&
              data.pagination && (
                <div className="pagination">
                  <button
                    className="quiet-button"
                    disabled={!page}
                    onClick={() => setPage(page - 1)}
                  >
                    Previous page
                  </button>
                  <span>
                    Page {page + 1} · up to {data.pagination.size}
                    {view === 'review' ? ' per column' : ''} ·{' '}
                    {view === 'review'
                      ? data.pagination.inbox + data.pagination.ready
                      : view === 'imports'
                        ? data.pagination.imports
                        : data.pagination.finalized}{' '}
                    matching {view === 'imports' ? 'imports' : 'transactions'}
                  </span>
                  <button
                    className="quiet-button"
                    disabled={(page + 1) * data.pagination.size >= data.pagination.total}
                    onClick={() => setPage(page + 1)}
                  >
                    Next page
                  </button>
                </div>
              )}
            {view === 'finalized' && (
              <>
                {filters}
                <div className="review-toolbar">
                  <span>
                    {filtered.filter((t) => t.state === 'finalized').length} finalized transactions
                  </span>
                  {chosen.some((t) => t.state === 'finalized') && (
                    <button
                      className="quiet-button"
                      onClick={() =>
                        review(
                          chosen.filter((t) => t.state === 'finalized'),
                          'reopen',
                        )
                      }
                    >
                      Reopen {chosen.filter((t) => t.state === 'finalized').length} selected
                    </button>
                  )}
                </div>
                <div className="panel table-panel">
                  <table>
                    <thead>
                      <tr>
                        <th>
                          <input
                            type="checkbox"
                            aria-label="Select all finalized expenses"
                            checked={
                              filtered.some((t) => t.state === 'finalized') &&
                              filtered
                                .filter((t) => t.state === 'finalized')
                                .every((t) => selected.has(t.id))
                            }
                            onChange={() => {
                              const ids = filtered
                                .filter((t) => t.state === 'finalized')
                                .map((t) => t.id);
                              setSelected(
                                ids.every((id) => selected.has(id)) ? new Set() : new Set(ids),
                              );
                            }}
                          />
                        </th>
                        <th>Expense</th>
                        <th>Date</th>
                        <th>Split</th>
                        <th>Amount</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {filtered
                        .filter((t) => t.state === 'finalized')
                        .map((t) => (
                          <tr key={t.id}>
                            <td>
                              <input
                                type="checkbox"
                                aria-label={'Select ' + t.description}
                                checked={selected.has(t.id)}
                                onChange={() => toggle(t.id)}
                              />
                            </td>
                            <td>
                              <b>{t.description}</b>
                              <small>{t.proposal?.category}</small>
                              {t.notes.length > 0 || t.instruction ? (
                                <button
                                  className="text-button saved-context-link"
                                  onClick={() => setDetailTxId(t.id)}
                                >
                                  View saved context
                                </button>
                              ) : null}
                            </td>
                            <td>{t.date}</td>
                            <td>
                              {t.proposal?.splits.map((s) => (
                                <small key={s.personId}>
                                  {data.people.find((p) => p.id === s.personId)?.name}:{' '}
                                  {money(s.amountCents)}
                                </small>
                              ))}
                            </td>
                            <td>
                              <strong>{money(t.amountCents)}</strong>
                            </td>
                            <td>
                              <button className="text-button" onClick={() => review([t], 'reopen')}>
                                Reopen
                              </button>
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                  {!filtered.some((t) => t.state === 'finalized') && (
                    <div className="empty-state">
                      <ShieldCheck />
                      <h3>Your accepted splits live here.</h3>
                      <p>Approve a proposal to finalize it.</p>
                    </div>
                  )}
                </div>
              </>
            )}
            {view === 'people' && (
              <>
                <div className="section-title">
                  <h2>{data.people.length - 1} people in your circle</h2>
                  <button className="primary" onClick={() => setPersonOpen(true)}>
                    <Plus size={16} />
                    Add person
                  </button>
                </div>
                <div className="people-balance-grid">
                  {data.people.map((p, i) => (
                    <article className="person-balance-card" key={p.id}>
                      <div className="person-top">
                        <span className={'avatar color-' + (i % 4)}>{p.name[0]}</span>
                        <div className="grow">
                          <h3>{p.name}</h3>
                          <small>@{p.handle}</small>
                        </div>
                        {p.isSelf ? <span className="pill">You</span> : null}
                      </div>
                      <p>{p.relation || 'No relationship tag'}</p>
                      {!p.isSelf && (
                        <button className="text-button" onClick={() => setPersonDetail(p.id)}>
                          View expenses <ArrowRight size={14} />
                        </button>
                      )}
                    </article>
                  ))}
                </div>
                <div className="tip">
                  <Sparkles size={18} />
                  <p>
                    Type <b>@handle</b> to mention someone. Relationship tags add context; they
                    never create a split by themselves.
                  </p>
                </div>
              </>
            )}
            {view === 'rules' && (
              <>
                <div className="section-title">
                  <div>
                    <h2>Your reusable rules</h2>
                    <p>
                      Rules define splits. People and transaction context are stored separately.
                    </p>
                  </div>
                  <div className="rule-page-actions">
                    <button className="quiet-button" onClick={() => setTransferKind('rules')}>
                      <ArrowDownUp size={15} /> Import / export rules
                    </button>
                    <button className="quiet-button" onClick={() => setOptimizingRules(true)}>
                      <Sparkles size={15} /> Optimize rules
                    </button>
                    <button className="primary" onClick={() => setRuleEditor('new')}>
                      <Plus size={16} /> Propose rule
                    </button>
                  </div>
                </div>
                {data.ruleChanges
                  .filter((r) => r.status === 'proposed')
                  .map((c) => {
                    const current = data.rules.find((rule) => rule.id === c.ruleId);
                    const stale =
                      !!c.ruleId && (!current?.active || current.version !== c.baseVersion);
                    return (
                      <article className="rule-card proposed" key={c.id}>
                        <div className="rule-top">
                          <span className="pill amber">Needs your approval</span>
                          <h3>{c.title}</h3>
                        </div>
                        {c.ruleId && current && (
                          <div className="rule-before">
                            <small>Previously</small>
                            <p>{ruleDescription(current.definition, data.people)}</p>
                          </div>
                        )}
                        <p>
                          <b>{merchantLabel(c.definition)}</b>
                          {c.definition.category ? ' · ' + c.definition.category : ''}
                          {c.definition.accountId
                            ? ' · ' +
                              data.accounts.find((a) => a.id === c.definition.accountId)?.name
                            : ''}
                        </p>
                        <p>{ruleDescription(c.definition, data.people)}</p>
                        <small>
                          {c.definition.from || 'Any date'} → {c.definition.to || 'Any date'}
                        </small>
                        {stale && (
                          <p className="error-text">
                            This rule changed or was deleted. Reject this proposal and propose the
                            change again.
                          </p>
                        )}
                        <footer>
                          <button
                            className="quiet-button"
                            onClick={() =>
                              action(
                                () => api('rules/review', { id: c.id, approve: false }),
                                'Rule proposal rejected.',
                              )
                            }
                          >
                            Reject
                          </button>
                          <button
                            className="primary"
                            disabled={stale}
                            onClick={() =>
                              action(
                                () => api('rules/review', { id: c.id, approve: true }),
                                'Rule activated. Process Inbox to apply it.',
                              )
                            }
                          >
                            <Check size={15} />
                            Approve rule
                          </button>
                        </footer>
                      </article>
                    );
                  })}
                {data.rules
                  .filter((r) => r.active)
                  .map((r) => (
                    <article className="rule-card" key={r.id}>
                      <div className="rule-top">
                        <span className="rule-check">
                          <Check size={17} />
                        </span>
                        <h3>{r.title}</h3>
                        <span className="pill">Active · v{r.version}</span>
                        <button className="text-button" onClick={() => setRuleEditor(r)}>
                          Propose edit
                        </button>
                        <button
                          className="icon-button delete-rule-button"
                          aria-label={'Delete ' + r.title}
                          title="Delete rule"
                          onClick={() => setDeletingRule(r)}
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                      <p>
                        <b>{merchantLabel(r.definition)}</b> ·{' '}
                        {ruleDescription(r.definition, data.people)}
                      </p>
                      <small>
                        {r.definition.from || 'Any date'} → {r.definition.to || 'Any date'}
                        {r.definition.accountId
                          ? ' · ' + data.accounts.find((a) => a.id === r.definition.accountId)?.name
                          : ''}
                      </small>
                    </article>
                  ))}
                {!data.rules.some((rule) => rule.active) &&
                  !data.ruleChanges.some((r) => r.status === 'proposed') && (
                    <div className="empty-state panel">
                      <SlidersHorizontal />
                      <h3>Start with something you know.</h3>
                      <p>For example: “Supercharging is split equally with @someone.”</p>
                      <button className="quiet-button" onClick={() => setRuleEditor('new')}>
                        Create your first rule
                      </button>
                    </div>
                  )}
              </>
            )}
            {view === 'imports' && (
              <div className="panel table-panel">
                <table>
                  <thead>
                    <tr>
                      <th>Statement</th>
                      <th>Card</th>
                      <th>Imported</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.imports.map((i) => (
                      <tr key={i.id}>
                        <td>
                          <b>{i.fileName}</b>
                        </td>
                        <td>{data.accounts.find((a) => a.id === i.accountId)?.name}</td>
                        <td>
                          {new Date(i.createdAt).toLocaleDateString(undefined, {
                            timeZone: data.workspace?.timezone,
                          })}
                        </td>
                        <td>
                          {i.summary}
                          <small>
                            <button
                              className="text-button"
                              onClick={() =>
                                action(async () => setImportDetail(await api('imports/' + i.id)))
                              }
                            >
                              View rows
                            </button>
                          </small>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!data.imports.length && (
                  <div className="empty-state">
                    <FileUp />
                    <h3>No statements yet.</h3>
                    <p>Start with an Amex, Sapphire, or Prime CSV.</p>
                    <button className="primary" onClick={() => setImportOpen(true)}>
                      Import statements
                    </button>
                  </div>
                )}
              </div>
            )}
          </main>
        </div>
        {chatOpen && (
          <ChatPanel
            messages={data.messages}
            ruleChanges={data.ruleChanges}
            rules={data.rules}
            accounts={data.accounts}
            onReviewRule={reviewChatRule}
            jobs={data.jobs}
            people={data.people}
            transactions={data.transactions}
            selected={data.transactions.filter(
              (t) => selected.has(t.id) && t.state !== 'finalized',
            )}
            configured={data.aiConfigured}
            draft={chat}
            onDraftChange={setChat}
            onSend={sendChat}
            onClose={() => setChatOpen(false)}
            onClearSelection={() => setSelected(new Set())}
            onTransaction={setDetailTxId}
            onCancel={cancelJob}
            onRetry={retryJob}
          />
        )}
        {loading && (
          <div className="working-indicator" aria-label="Saving">
            <LoaderCircle className="spin" size={18} />
          </div>
        )}
        {importOpen && (
          <ImportDialog
            data={data}
            onClose={() => setImportOpen(false)}
            onImported={async (_ids, summary, run) => {
              setImportOpen(false);
              await fetchData();
              setNotice({ text: summary });
              navigate(run ? 'review' : 'overview');
            }}
          />
        )}
        {importDetail && (
          <Modal
            title={importDetail.preview.fileName}
            subtitle={importDetail.summary}
            wide
            onClose={() => setImportDetail(null)}
          >
            <div className="modal-body">
              {importDetail.preview.completion?.context && (
                <section className="import-context-history">
                  <h3>Context provided at import</h3>
                  <small>
                    {importDetail.preview.completion.from || 'All new dates'} →{' '}
                    {importDetail.preview.completion.to || 'All new dates'} ·{' '}
                    {importDetail.preview.completion.affectedCount} new expenses
                  </small>
                  <p>{importDetail.preview.completion.context}</p>
                </section>
              )}
              <div className="preview-table">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Transaction</th>
                      <th>Amount</th>
                      <th>Import decision</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importDetail.preview.rows.map((r) => (
                      <tr key={r.rowNumber}>
                        <td>{r.rowNumber}</td>
                        <td>
                          <b>{r.description}</b>
                          <small>
                            {r.date}
                            {r.postDate ? ' · posted ' + r.postDate : ''}
                          </small>
                          {r.error && <small className="error-text">{r.error}</small>}
                        </td>
                        <td>{r.amountCents === null ? '—' : money(r.amountCents)}</td>
                        <td>
                          {importDetail.rows.find((s) => s.rowNumber === r.rowNumber)?.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </Modal>
        )}
        {personOpen && (
          <PersonDialog
            onClose={() => setPersonOpen(false)}
            onSave={async (name, handle, relation) => {
              if (await action(() => api('people', { name, handle, relation }), 'Person added.'))
                setPersonOpen(false);
            }}
          />
        )}
        {repayPerson && (
          <RepaymentDialog
            data={data}
            personId={repayPerson}
            onClose={() => setRepayPerson(null)}
            onSave={async (body) => {
              if (await action(() => api('repayments', body), 'Repayment saved.'))
                setRepayPerson(null);
            }}
          />
        )}
        {settingsOpen && (
          <SettingsDialog
            data={data}
            onClose={() => setSettingsOpen(false)}
            onChanged={fetchData}
          />
        )}
        {personDetail && (
          <Modal
            title={data.people.find((p) => p.id === personDetail)?.name + "'s expenses"}
            subtitle="Repayments apply to oldest expenses first."
            wide
            onClose={() => setPersonDetail(null)}
          >
            <div className="modal-body">
              <PersonLedger
                id={personDetail}
                from={from}
                to={to}
                onOpen={(id) => {
                  setPersonDetail(null);
                  setDetailTxId(id);
                }}
              />
              <button
                className="primary spaced"
                onClick={() => {
                  setRepayPerson(personDetail);
                  setPersonDetail(null);
                }}
              >
                Record repayment
              </button>
            </div>
          </Modal>
        )}
        {detailTx && (
          <Modal
            title={detailTx.description}
            subtitle={
              detailTx.date +
              ' · ' +
              money(detailTx.amountCents) +
              ' · ' +
              (detailTx.state === 'finalized'
                ? 'Finalized'
                : detailTx.state === 'ready'
                  ? 'Ready for review'
                  : 'Inbox')
            }
            onClose={() => setDetailTxId(null)}
          >
            <div className="modal-body transaction-detail">
              <p className="muted">
                {data.accounts.find((a) => a.id === detailTx.accountId)?.name}
              </p>
              {detailTx.proposal && (
                <>
                  <h3>{detailTx.proposal.category}</h3>
                  <div className="detail-splits">
                    {detailTx.proposal.splits.map((share) => (
                      <div key={share.personId}>
                        <span>{data.people.find((p) => p.id === share.personId)?.name}</span>
                        <b>{money(share.amountCents)}</b>
                      </div>
                    ))}
                  </div>
                  <p className="explanation">{detailTx.proposal.explanation}</p>
                </>
              )}
              <TransactionContext transactions={[detailTx]} expanded />
              {!detailTx.notes.length && !detailTx.instruction && (
                <p className="muted">No additional context has been saved for this expense.</p>
              )}
            </div>
          </Modal>
        )}
        {editTx && (
          <SplitDialog
            tx={editTx}
            data={data}
            onClose={() => setEditTx(null)}
            onSave={async (body) => {
              if (
                await action(
                  () => api('transactions/proposal', body),
                  'Split saved in Ready for review.',
                )
              )
                setEditTx(null);
            }}
            onCorrect={async (text, remember) => {
              const t = editTx;
              if (
                await action(async () => {
                  await api('transactions/review', {
                    action: 'correct',
                    items: [{ id: t.id, version: t.version }],
                    instruction: text,
                  });
                  if (remember)
                    await api('jobs', {
                      kind: 'chat',
                      text:
                        'Propose a reusable rule for merchant ' +
                        t.description +
                        ' based on this instruction: ' +
                        text,
                    });
                }, 'Instruction saved. Generate revised splits when ready.')
              )
                setEditTx(null);
            }}
          />
        )}
        {transferKind && (
          <DataTransferDialog
            initialKind={transferKind}
            data={data}
            from={from}
            to={to}
            onClose={() => setTransferKind(null)}
            onImported={async (kind, summary) => {
              await fetchData();
              setTransferKind(null);
              setView(kind === 'rules' ? 'rules' : 'review');
              setNotice({ text: summary });
            }}
          />
        )}
        {deletingRule && (
          <DeleteRuleDialog
            rule={deletingRule}
            data={data}
            affected={deletingRule.unfinishedCount || 0}
            onClose={() => setDeletingRule(null)}
            onDelete={async (rule) => {
              const result = await api<{ affected: number }>('rules/delete', {
                id: rule.id,
                version: rule.version,
              });
              await fetchData();
              setDeletingRule(null);
              setNotice({
                text:
                  'Rule deleted. ' +
                  (result.affected
                    ? result.affected + ' unfinished proposals returned to Inbox. '
                    : '') +
                  'Undo restores it.',
              });
            }}
          />
        )}
        {optimizingRules && (
          <OptimizeRulesDialog
            data={data}
            onClose={() => setOptimizingRules(false)}
            onApplied={async (removed) => {
              await fetchData();
              setOptimizingRules(false);
              setNotice({
                text:
                  'Rule cleanup complete. ' +
                  removed +
                  ' redundant rule' +
                  (removed === 1 ? '' : 's') +
                  ' removed. Undo restores the batch.',
              });
            }}
          />
        )}
        {ruleEditor && (
          <RuleDialog
            data={data}
            rule={ruleEditor === 'new' ? undefined : ruleEditor}
            onClose={() => setRuleEditor(null)}
            onSave={async (body) => {
              if (
                await action(
                  () => api('rules/propose', body),
                  'Rule proposed. Review it before activation.',
                )
              )
                setRuleEditor(null);
            }}
          />
        )}
      </div>
    </WorkspaceProviders>
  );
}
