# Splitwise AI

A personal expense workspace for Chase Sapphire, American Express, and Chase Prime CSV exports. Review AI-proposed splits, approve them, and track what people still owe you. Standalone; no connection to the Splitwise service.

## Start in WSL

From Ubuntu:

```sh
cd /path/to/splitwise_ai
./start.sh
```

Open **http://127.0.0.1:3000**. The launcher installs a project-local native Node 24 LTS runtime if needed, verifies the download checksum, installs locked dependencies, and starts the web app and worker. Stop both with Ctrl+C.

The runtime is already installed in this checkout. To run npm commands in a new Ubuntu terminal:

```sh
export PATH="$PWD/.tools/node/bin:$PATH"
```

Use Ubuntu Node, rather than Windows Node, with this database. The app and SQLite file stay on the WSL filesystem. The server binds to loopback and checks host/origin. It has no authentication and is intended for local use.

For a production build and startup:

```sh
./start.sh --production
```

### Enable AI

A blank, ignored **.env.local** is prepared. Set **OPENAI_API_KEY** there, then restart. **OPENAI_MODEL** defaults to **gpt-6-luna**. Do not put the key in browser code or Git. On a fresh checkout:

```sh
cp -n .env.example .env.local
```

Without a key, imports, approved rules, manual splits, review, repayments, and reporting work. Unresolved expenses stay in Inbox. **AGENT_MODE=mock** is exclusively for automated tests with synthetic data.

The app starts in **Dracula Classic** dark mode using the [official palette](https://draculatheme.com/spec). The top-bar theme switch changes between Dracula and the original light theme; your browser remembers the choice across reloads.

## Quick instructions and chat

Every Inbox expense has an instruction box. Type a split and any useful context, then press **Enter** to process that expense immediately. **Shift+Enter** adds a line. Use **@** to choose a person; Enter first accepts the highlighted mention. Clear instructions become proposals in Ready for review; ambiguous ones stay in Inbox with a question.

The complete instruction is saved under **Saved context**, including details such as what a purchase was for or which trip it belonged to. Earlier notes remain available when you add a follow-up. Context is searchable and remains visible after finalization through **View saved context**. Transaction context is one-off; reusable rules still require visible approval.

Reusable rule proposals appear as review cards directly below the assistant’s reply. Check the merchant, card, date scope, participants, and category, then **Approve rule** or **Reject** without leaving the review workspace. Approval normally affects future processing; optionally select **Also process matching Inbox expenses** to queue those expenses immediately. Existing pending proposals are also available in chat, and approval/rejection states persist across reloads.

Chat supports Markdown replies, growing input, Enter-to-send, live reply text and activity, queued requests, Stop/Retry, and links back to the relevant expense. It opens at the latest message and lets you read older messages without being pulled back down. Selected unfinished expenses scope a request; their full chat instructions are attached as context. For unselected requests, the agent can attach relevant exact quotes from your message to unfinished expenses. AI still cannot modify finalized expenses.

Conversation and context timestamps default to **America/Los_Angeles**. Set **NEXT_PUBLIC_TIME_ZONE** before starting if you use another timezone.

## Workflow

1. **Add people.** Choose a unique @handle and an optional relationship. Mention autocomplete supports arrow keys and Enter. Mentions resolve to stable person IDs.
2. **Import statements.** Select the specific card account. Review transaction/posting date ranges, duplicates, card payments, and invalid rows. Every proposed skip needs acknowledgement. “Keep as distinct” preserves a known separate occurrence.
3. **Process now or later.** New expenses/refunds start in Inbox. Card payments stay in import history and never affect balances.
4. **Review.** Approved rules run first. High-confidence AI inferences may enter Ready; uncertain items remain in Inbox. Expand merchant groups and approve/reject individually or in bulk. Approve immediately finalizes a split.
5. **Correct.** Enter personal, equal, exact, or percentage splits directly. Or save individual instructions and use Generate revised splits. Remembering an instruction proposes a rule; it does not activate it.
6. **Approve rules.** Every new/edit proposal waits on Rules & context. Date/card/category scopes override broader instructions. Conflicting equally applicable rules require clarification. Reprocess selected unfinished expenses to apply newly approved rules.
7. **Settle up.** Record repayments, partial repayments, and returns of available credit. Open a person’s card for expense/repayment details.
8. **Undo.** Reverse the latest completed review, agent, rule, or repayment batch; repeat across sessions. Imports and adding people are retained. No redo.

Only finalized splits affect balances. Finalized transactions are read-only to AI. Only you can reopen them, which removes their allocations until approved again.

### Import behavior

Supported headers:

- Amex: Date,Description,Amount
- Chase: Transaction Date,Post Date,Description,Category,Type,Amount,Memo

Chase formats are identical, so account selection is mandatory. Positive Amex purchases and negative Chase purchases become positive expenses; refunds become negative. Original rows are preserved.

The importer inspects every row; ordering and filenames do not define coverage. Fingerprints include account, transaction/post dates, normalized description, amount, and expense/refund/payment kind. Occurrence counts preserve identical purchases: two identical rows on first import remain two; three later matching occurrences add one. Overlapping dates can contain new/backfilled transactions.

Files have a 10 MB / 50,000-row limit. Malformed syntax/wrong headers block preview. Individual invalid rows require explicit acknowledgement to skip.

Reference statements were validated separately: Amex 129 source rows / 11 payments / 118 workflow transactions; Prime 200 / 7 / 193; Sapphire 626 / 13 / 613. **Real sample data is not seeded or committed.**

### Money, refunds, and dates

Amounts use integer cents. Equal/percentage splits distribute rounding cents deterministically. Exact amounts must total the transaction, and percentages must total 100%. No implicit remainder is charged to you.

Refunds can link to finalized purchases and reverse the accepted split proportionally. Repeated partial refunds use cumulative rounding to avoid over-refunding a participant. Linked refunds cannot exceed the remaining original amount. Unmatched/ambiguous refunds need your allocation. Refund approval never edits the original.

Repayments apply to oldest outstanding expenses first, with stable ID as a date tie breaker. Excess payments remain as credit; returned money cannot exceed available credit. Linked refunds reduce their original expense before remaining credits and repayments are allocated. Reopening recalculates balances while preserving repayment history.

The date filter shows **what remains unpaid from expenses in that range now**, including payments received later. Main outstanding remains all-time. Spending/category/monthly summaries use finalized transactions dated in the selected period. USD only.

## Architecture

- Next.js, React, TypeScript, Node route API.
- SQLite, Drizzle schema/migrations, WAL, foreign keys, busy timeout, atomic bulk writes.
- Durable background job queue with lease/heartbeat, checkpoint cursor, cancellation/retry, and idempotent step keys.
- OpenAI Agents SDK on Responses; one agent, Zod function contracts, qualitative confidence, local conversation history, store:false, hosted tracing disabled.
- Domain services own arithmetic, expected-version checks, permissions, finalization, and inverse snapshots for persistent Undo.
- Agent writes buffer until a run succeeds, then apply transactionally. Processing uses batches of 20. Failed/cancelled runs retain completed batches; retry resumes from the checkpoint.
- Rules are visible, reviewed, and versioned. There is no hidden learned memory.
- Agent tools can search records/context, propose unfinished splits, move Inbox ↔ Ready, request clarification, and propose rules/categories. No finalization, reopening, repayment-write, SQL, filesystem, or arbitrary network tools.
- Fonts are bundled locally. Necessary transaction details go to OpenAI when AI is enabled. Files, keys, and databases remain outside Git.

### Server interfaces

All routes start with **/api**. Mutation bodies are JSON except multipart preview. The browser is the user authority; agent tools call domain services with a fixed agent actor.

| Method | Route                                | Purpose                                                             |
| ------ | ------------------------------------ | ------------------------------------------------------------------- |
| GET    | /state?from=YYYY-MM-DD&to=YYYY-MM-DD | Workspace and balances                                              |
| GET    | /health                              | Local server health                                                 |
| POST   | /imports/preview                     | Multipart file and accountId                                        |
| GET    | /imports/:id                         | Retained row decisions and payment history                          |
| POST   | /imports/confirm                     | Preview ID, skip acknowledgements, retained duplicate row numbers   |
| POST   | /people                              | Name, unique handle, relationship                                   |
| POST   | /transactions/instruct               | Save Inbox instruction/context and queue that expense atomically    |
| POST   | /transactions/proposal               | Manual split/category, expected version, optional original purchase |
| POST   | /transactions/review                 | Atomic approve/reject/reopen/correct with IDs and expected versions |
| POST   | /rules/propose                       | New/edit rule proposal                                              |
| POST   | /rules/review                        | User approval/rejection                                             |
| POST   | /repayments                          | Person, date, positive cents, received/returned, note               |
| POST   | /undo                                | Undo latest completed batch                                         |
| POST   | /jobs                                | Process selected/Inbox transactions or chat                         |
| GET    | /jobs/:id/events                     | Stream progress                                                     |
| POST   | /jobs/:id/cancel                     | Cancel unfinished work                                              |
| POST   | /jobs/:id/retry                      | Resume failed/cancelled work                                        |

Shared contracts live in **src/lib/types.ts**. State, version, batch ID, cent amounts, participant IDs, confidence, and proposal source are explicit. Stale writes conflict or leave changed transactions untouched; refresh and regenerate.

## Backup and restore

With the project Node runtime on PATH:

```sh
npm run backup
npm run backup -- ./backups/my-backup.sqlite
```

Backups use SQLite's consistent online backup API and can run while the app is open.

Stop the app, then restore:

```sh
npm run restore -- ./backups/my-backup.sqlite --confirm
```

Restore checks integrity/application tables, migrates a temporary copy, preserves a backup of the current database, and replaces it. It refuses while the launcher lock exists. **DATABASE_PATH** overrides the default **./data/splitwise.sqlite**. Keep separate backup copies outside Git.

## Verification

```sh
npm test
npm run typecheck
npm run build
npm exec playwright install --with-deps chromium
npm run test:browser
npm run test:live
npm run validate:samples -- /path/to/sample-directory
```

Domain tests cover imports, duplicate counts, rounding, precedence/conflicts, authorization, stale edits, bulk review, persistent undo, refunds/repayments, and recovery. Browser tests use an isolated synthetic database and mocked AI for the complete workflow and mobile layout. The opt-in live smoke test uses synthetic data and skips without an API key.

Git includes source, migrations, synthetic fixtures, and the dependency lockfile. Statements, keys, databases, test artifacts, backups, logs, and the downloaded runtime are ignored.
