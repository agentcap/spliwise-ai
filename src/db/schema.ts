import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const people = sqliteTable('people', {
  id: text().primaryKey(),
  name: text().notNull(),
  handle: text().notNull().unique(),
  relation: text().notNull().default(''),
  isSelf: integer().notNull().default(0),
});
export const accounts = sqliteTable('accounts', {
  id: text().primaryKey(),
  name: text().notNull(),
  format: text().notNull(),
});
export const categories = sqliteTable('categories', {
  id: text().primaryKey(),
  name: text().notNull().unique(),
});
export const imports = sqliteTable('imports', {
  id: text().primaryKey(),
  accountId: text()
    .notNull()
    .references(() => accounts.id),
  fileName: text().notNull(),
  hash: text().notNull(),
  status: text().notNull(),
  preview: text().notNull(),
  createdAt: text().notNull(),
  summary: text().notNull().default(''),
});
export const importRows = sqliteTable(
  'import_rows',
  {
    id: text().primaryKey(),
    importId: text()
      .notNull()
      .references(() => imports.id),
    accountId: text()
      .notNull()
      .references(() => accounts.id),
    rowNumber: integer().notNull(),
    fingerprint: text().notNull(),
    raw: text().notNull(),
    kind: text().notNull(),
    status: text().notNull(),
  },
  (t) => [
    index('import_fingerprint').on(t.accountId, t.fingerprint),
    uniqueIndex('import_line').on(t.importId, t.rowNumber),
  ],
);
export const trips = sqliteTable('trips', {
  id: text().primaryKey(),
  name: text().notNull(),
  destination: text().notNull().default(''),
  from: text().notNull(),
  to: text().notNull(),
  participants: text().notNull(),
  split: text().notNull(),
  context: text().notNull().default(''),
  status: text().notNull().default('active'),
  version: integer().notNull().default(1),
  createdAt: text().notNull(),
});
export const splitTemplates = sqliteTable('split_templates', {
  id: text().primaryKey(),
  name: text().notNull(),
  spec: text().notNull(),
  category: text().notNull(),
  version: integer().notNull().default(1),
});
export const merchantAliases = sqliteTable('merchant_aliases', {
  id: text().primaryKey(),
  pattern: text().notNull().unique(),
  name: text().notNull(),
  version: integer().notNull().default(1),
});
export const transactions = sqliteTable(
  'transactions',
  {
    id: text().primaryKey(),
    accountId: text()
      .notNull()
      .references(() => accounts.id),
    importRowId: text()
      .notNull()
      .unique()
      .references(() => importRows.id),
    date: text().notNull(),
    postDate: text(),
    tripId: text().references(() => trips.id),
    source: text().notNull().default('import'),
    description: text().notNull(),
    amountCents: integer().notNull(),
    kind: text().notNull(),
    bankCategory: text().notNull().default(''),
    state: text().notNull().default('inbox'),
    attention: text().notNull().default(''),
    proposal: text(),
    instruction: text().notNull().default(''),
    notes: text().notNull().default('[]'),
    version: integer().notNull().default(1),
    batchId: text(),
    updatedAt: text().notNull(),
  },
  (t) => [
    index('transaction_state').on(t.state),
    index('transaction_date').on(t.date),
    index('transaction_trip').on(t.tripId),
    index('transaction_review_order').on(t.state, t.updatedAt, t.id),
  ],
);
export const rules = sqliteTable('rules', {
  id: text().primaryKey(),
  title: text().notNull(),
  definition: text().notNull(),
  version: integer().notNull().default(1),
  active: integer().notNull().default(1),
});
export const ruleChanges = sqliteTable('rule_changes', {
  id: text().primaryKey(),
  ruleId: text().references(() => rules.id),
  title: text().notNull(),
  definition: text().notNull(),
  status: text().notNull().default('proposed'),
  baseVersion: integer(),
});
export const repayments = sqliteTable('repayments', {
  id: text().primaryKey(),
  personId: text()
    .notNull()
    .references(() => people.id),
  date: text().notNull(),
  amountCents: integer().notNull(),
  direction: text().notNull(),
  note: text().notNull().default(''),
});
export const actionBatches = sqliteTable('action_batches', {
  sequence: integer().primaryKey({ autoIncrement: true }),
  id: text().notNull().unique(),
  label: text().notNull(),
  actor: text().notNull(),
  undo: text().notNull(),
  createdAt: text().notNull(),
  undoneAt: text(),
  stepKey: text().unique(),
});
export const jobs = sqliteTable('jobs', {
  id: text().primaryKey(),
  kind: text().notNull(),
  payload: text().notNull(),
  status: text().notNull().default('queued'),
  progress: integer().notNull().default(0),
  cursor: integer().notNull().default(0),
  result: text().notNull().default(''),
  activity: text().notNull().default(''),
  response: text().notNull().default(''),
  error: text().notNull().default(''),
  cancelRequested: integer().notNull().default(0),
  leaseUntil: integer().notNull().default(0),
  leaseToken: text(),
  attempts: integer().notNull().default(0),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});
export const messages = sqliteTable('messages', {
  id: text().primaryKey(),
  role: text().notNull(),
  text: text().notNull(),
  jobId: text(),
  transactionIds: text().notNull().default('[]'),
  createdAt: text().notNull(),
});

export const dataTransfers = sqliteTable('data_transfers', {
  id: text().primaryKey(),
  kind: text().notNull(),
  fileName: text().notNull(),
  payload: text().notNull(),
  preview: text().notNull(),
  status: text().notNull().default('draft'),
  createdAt: text().notNull(),
  summary: text().notNull().default(''),
});

export const receipts = sqliteTable('receipts', {
  key: text().primaryKey(),
  digest: text().notNull(),
  response: text().notNull(),
  createdAt: text().notNull(),
});
export const workspaceSettings = sqliteTable('workspace_settings', {
  id: text().primaryKey().default('main'),
  timezone: text().notNull().default('America/Los_Angeles'),
  consentAt: text(),
  onboardingDismissed: integer().notNull().default(0),
});

export const ledgerRevision = sqliteTable('ledger_revision', {
  id: text().primaryKey(),
  revision: integer().notNull().default(0),
});

export const attachments = sqliteTable(
  'attachments',
  {
    id: text().primaryKey(),
    transactionId: text()
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    name: text().notNull(),
    mime: text().notNull(),
    size: integer().notNull(),
    data: text().notNull(),
    createdAt: text().notNull(),
  },
  (t) => [index('attachment_transaction').on(t.transactionId)],
);

export const userContext = sqliteTable('user_context', {
  id: text().primaryKey(),
  title: text().notNull(),
  text: text().notNull(),
  quote: text().notNull(),
  personId: text().references(() => people.id),
  tripId: text().references(() => trips.id),
  from: text(),
  to: text(),
  version: integer().notNull().default(1),
  createdAt: text().notNull(),
  updatedAt: text().notNull(),
});
export const assistantEvents = sqliteTable(
  'assistant_events',
  {
    id: text().primaryKey(),
    jobId: text().notNull(),
    kind: text().notNull(),
    targetId: text().notNull(),
    title: text().notNull(),
    detail: text().notNull(),
    batchId: text()
      .notNull()
      .references(() => actionBatches.id),
    createdAt: text().notNull(),
  },
  (t) => [index('assistant_event_job').on(t.jobId)],
);
export const assistantRequests = sqliteTable(
  'assistant_requests',
  {
    id: text().primaryKey(),
    jobId: text().notNull(),
    kind: text().notNull(),
    payload: text().notNull(),
    title: text().notNull(),
    status: text().notNull().default('pending'),
    createdAt: text().notNull(),
    batchId: text(),
  },
  (t) => [index('assistant_request_status').on(t.status)],
);
