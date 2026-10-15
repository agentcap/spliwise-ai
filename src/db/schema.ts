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
  (t) => [index('transaction_state').on(t.state), index('transaction_date').on(t.date)],
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
