export type TransactionState = 'inbox' | 'ready' | 'finalized';
export type Confidence = 'high' | 'medium' | 'low';
export type Actor = 'user' | 'agent';
export interface Person {
  id: string;
  name: string;
  handle: string;
  relation: string;
  isSelf: number;
}
export interface Account {
  id: string;
  name: string;
  format: 'amex' | 'chase';
}
export interface Category {
  id: string;
  name: string;
}
export interface Share {
  personId: string;
  amountCents: number;
}
export interface SplitSpec {
  mode: 'personal' | 'equal' | 'exact' | 'percent';
  participants: string[];
  values?: number[];
}
export interface Proposal {
  splits: Share[];
  category: string;
  confidence: Confidence;
  source: 'rule' | 'instruction' | 'inference' | 'refund' | 'manual';
  explanation: string;
  ruleId?: string;
  ruleVersion?: number;
  refundOf?: string;
  spec?: SplitSpec;
}
export interface TransactionNote {
  id: string;
  text: string;
  source: 'instruction' | 'chat' | 'import';
  createdAt: string;
}
export interface Transaction {
  id: string;
  accountId: string;
  importRowId: string;
  date: string;
  postDate: string | null;
  description: string;
  amountCents: number;
  kind: 'expense' | 'refund';
  bankCategory: string;
  attention: string;
  state: TransactionState;
  proposal: Proposal | null;
  instruction: string;
  notes: TransactionNote[];
  version: number;
  batchId: string | null;
  updatedAt: string;
}
export interface RuleDefinition {
  merchant: string;
  merchantAliases?: string[];
  category?: string;
  accountId?: string;
  from?: string;
  to?: string;
  split: SplitSpec;
  outputCategory: string;
}
export interface Rule {
  id: string;
  title: string;
  definition: RuleDefinition;
  version: number;
  active: number;
}
export interface RuleOptimizationGroup {
  id: string;
  kind: 'duplicates' | 'merge';
  rules: Rule[];
  keepRuleId: string;
  title: string;
  definition: RuleDefinition;
  duplicateCount: number;
  rebindCount: number;
  resetCount: number;
}
export interface RuleOptimizationPreview {
  revision: string;
  scannedCount: number;
  groups: RuleOptimizationGroup[];
  conflicts: { titles: string[]; reason: string }[];
}
export interface RuleChange {
  id: string;
  ruleId: string | null;
  title: string;
  definition: RuleDefinition;
  status: string;
  baseVersion: number | null;
  jobId: string | null;
  matchingInboxCount: number;
}
export interface ParsedRow {
  rowNumber: number;
  raw: Record<string, string>;
  date: string | null;
  postDate: string | null;
  description: string;
  amountCents: number | null;
  bankCategory: string;
  kind: 'expense' | 'refund' | 'payment';
  fingerprint: string;
  error?: string;
}
export interface PreviewRow extends ParsedRow {
  duplicate: boolean;
  existing: { id: string; date: string; description: string; amountCents: number; state: string }[];
}
export interface ImportResult {
  ids: string[];
  summary: string;
  items: { id: string; version: number; date: string }[];
  dateRange: { from: string | null; to: string | null };
}
export interface ImportCompletion {
  context: string;
  from: string | null;
  to: string | null;
  savedAt: string;
  affectedCount: number;
  process: boolean;
  jobId?: string;
  digest: string;
  summary: string;
}
export interface ImportPreview {
  completion?: ImportCompletion;
  id: string;
  accountId: string;
  fileName: string;
  rows: PreviewRow[];
  dateRange: { from: string | null; to: string | null };
  postDateRange: { from: string | null; to: string | null };
  counts: { total: number; new: number; duplicates: number; payments: number; invalid: number };
}
export interface Repayment {
  id: string;
  personId: string;
  date: string;
  amountCents: number;
  direction: 'received' | 'returned';
  note: string;
}
export interface ActionBatch {
  id: string;
  sequence: number;
  label: string;
  actor: Actor;
  createdAt: string;
  undoneAt: string | null;
}
export interface AgentJob {
  id: string;
  kind: 'process' | 'chat';
  payload: {
    ids?: string[];
    text?: string;
    mentionIds?: string[];
    origin?: 'transaction';
    versions?: { id: string; version: number }[];
  };
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  cursor: number;
  result: string;
  activity: string;
  response: string;
  error: string;
  cancelRequested: number;
  leaseUntil: number;
  createdAt: string;
  updatedAt: string;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  jobId: string | null;
  transactionIds: string[];
  createdAt: string;
}
export interface ExpenseBalance {
  transactionId: string;
  date: string;
  description: string;
  allocatedCents: number;
  refundedCents: number;
  paidCents: number;
  remainingCents: number;
}
export interface PersonBalance {
  person: Person;
  outstandingCents: number;
  inRangeOutstandingCents: number;
  creditCents: number;
  receivedCents: number;
  returnedCents: number;
  expenses: ExpenseBalance[];
}
export interface Dashboard {
  people: PersonBalance[];
  totalOutstandingCents: number;
  filteredOutstandingCents: number;
  creditCents: number;
  personalCents: number;
  sharedCents: number;
  totalSpentCents: number;
  inboxCount: number;
  readyCount: number;
  finalizedCount: number;
  categories: { name: string; amountCents: number }[];
  months: { month: string; amountCents: number }[];
}
export interface Snapshot {
  people: Person[];
  accounts: Account[];
  categories: Category[];
  transactions: Transaction[];
  rules: Rule[];
  ruleChanges: RuleChange[];
  repayments: Repayment[];
  batches: ActionBatch[];
  jobs: AgentJob[];
  messages: Message[];
  dashboard: Dashboard;
  imports: {
    id: string;
    fileName: string;
    accountId: string;
    createdAt: string;
    summary: string;
  }[];
  aiConfigured: boolean;
}
