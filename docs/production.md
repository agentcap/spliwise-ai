# Production deployment

This release targets an **invitation-only application on one Linux server**, with one web process and one background worker. Each signed-in user has an independent SQLite ledger. The control database stores identities, session hashes, rate-limit counters and metered AI usage. No workspace identifier supplied by the browser selects a database.

SQLite is retained intentionally for this deployment. Do not put its WAL files on network storage or run multiple app replicas. A multi-instance service requires a database and queue redesign; PostgreSQL is the next migration for that topology.

## Deployment inputs

Prepare these before starting a public instance:

- A Linux host with Docker Compose, persistent **encrypted** disk, enough space for the ledgers and backup staging, and ports 80/443 accessible.
- A domain pointing to that host.
- A confidential OpenID Connect client with a verified email claim, authorization code flow, PKCE S256 and an exact redirect URL of **https://YOUR_DOMAIN/auth/callback**. Configure MFA and account recovery in the provider.
- An explicit list of invited, verified email addresses.
- A **new production OpenAI project key**. Revoke the test key previously shared in chat. Keys in conversation history cannot be made private by changing Git.
- Current model input/output prices for accounting. Set the chosen model explicitly; the default remains gpt-6-luna. Prices are configuration, not hard-coded guesses.
- An off-host restic repository, restricted repository credentials, and a separately saved recovery password.
- An operator contact and monitoring destination. Update the privacy page/contact wording and retention policy for the actual service before inviting others.

Actual domain/identity-provider access, key rotation, remote backup delivery, notification routing and host encryption cannot be established by repository code. They must be verified on the deployment.

## Configure

From the repository root:

```sh
cp deploy/production.env.example .env.production
cp deploy/backup.env.example .env.backup
mkdir -p secrets
chmod 700 secrets
openssl rand -base64 48 > secrets/restic-password
chmod 600 .env.production .env.backup secrets/restic-password
```

Fill the ignored environment files using an editor. Generate OPS_TOKEN with **openssl rand -hex 32**. The OpenAI key is server-only. Backups and credentials never enter the Docker build context or Git.

.env.production is passed to the app. .env.backup is used only by operations containers. The proxy receives only the domain. Use the same APP_URL origin consistently; no trailing slash. Removing an email from OIDC_ALLOWED_EMAILS invalidates that account’s next request, including active streams.

Build and initialize:

```sh
docker compose --env-file .env.production build app
docker compose --env-file .env.production run --rm operations npm run db:migrate:all
docker compose --env-file .env.production run --rm operations restic init
docker compose --env-file .env.production up -d
```

Normal startup after initialization is one command:

```sh
docker compose --env-file .env.production up -d
```

Caddy obtains HTTPS certificates. Only Caddy publishes host ports; port 3000 stays private to the container network. It preserves the configured host, overwrites the client-address header, limits request bodies and flushes streaming responses. An additional CDN/load balancer needs an explicit trusted-proxy configuration; do not blindly trust incoming forwarding headers.

Check **docker compose --env-file .env.production ps**. Sign in, accept Privacy & AI in Settings, add people, create a card account and import **synthetic** data first. Verify sign-out, identity-provider recovery, manual splits, approval, repayment, date filters and Undo. Sign in with two invited accounts and confirm their data is separate.

## Keep the existing local workspace

Your local database is never automatically assigned to an internet account. To move it:

1. Sign in once with the invited production identity, then stop the app.
2. Put a consistent copy of the local database on a private path available to the operations container.
3. Run **npm run workspace:adopt -- --email YOUR_VERIFIED_EMAIL --source /private/local.sqlite --confirm** with the production environment loaded.
4. Restart and verify balances. The source is preserved. Adoption refuses a destination that already has financial data, rules or additional people; use reviewed JSON import to merge instead.

Each ledger remains USD-only, with the signed-in person as payer. Trips, split templates, merchant aliases, manual source rows and receipt bytes are stored inside that same ledger, so online backups and workspace deletion cover them together. Receipt metadata and downloads are authenticated against the session workspace; receipt bytes are never added to model prompts. Shared logins, shared workspaces, multiple payers and currency conversion are outside this private release.

## Budgets, limits and model changes

- Before **every model request**, reserve a conservative text/token allowance against both the workspace and project monthly budgets. Reservations and usage are recorded transactionally in the control database.
- Reported input/output tokens settle the estimate using the prices saved on that request. No cached-input discount is assumed. These are estimates; the provider invoice remains authoritative.
- Failed/interrupted requests without usage keep their reservation. Do not delete those rows merely to unblock a budget: reconcile them with provider usage first. A crash cannot silently free an uncertain allowance.
- Monthly periods use UTC. Deleting a workspace anonymizes usage but preserves the project spend total.
- Automatic SDK HTTP retries are disabled. Explicit job retry resumes only unfinished checkpoints. Each completed batch has an idempotent step key.
- Defaults: 1,000 transactions per job, five queued/running jobs per workspace, 180-second job deadline, three crash-recovery attempts, 4,096 output tokens per model request and 12 model turns.
- Production API limits: 600 reads/minute, 180 writes/minute, 20 processing requests/minute and 10 uploads/minute per user; sign-in has a separate IP limit. The app counts streamed body bytes before JSON/multipart parsing. Proxy limits provide an additional boundary.
- Manual splits, imports, review, balances and approved local rules work without an OpenAI key.

Run **npm run test:eval -- --live** in a staging environment before changing the model, SDK or system instructions. It uses only synthetic records but incurs API charges. Run the deterministic tests and mocked evaluation suite on every change.

The application sends necessary ledger details to OpenAI only for requested AI work. Tracing is disabled and Responses uses store:false. These settings do not establish zero data retention; review the [official API data controls](https://developers.openai.com/api/docs/guides/your-data) against your deployment requirements.

## Backups and scheduled cleanup

Initialize the off-host repository once, then run:

```sh
docker compose --env-file .env.production run --rm operations npm run backup:all
```

This creates consistent SQLite online copies, checks integrity/foreign keys, records SHA-256 checksums, and uploads the snapshot through **restic encryption**. Private plaintext staging is removed even on failure. Retention defaults to 30 days. The forget command groups by host/tags, rather than temporary staging paths. A success timestamp is written only after upload and retention finish.

Install **deploy/splitwise-backup.service** and **deploy/splitwise-backup.timer** on the host, adjusting WorkingDirectory. Enable the timer with systemd and inspect its first successful run. A scheduled encrypted backup is not established until that run reaches the remote repository.

The running worker performs retention and deletion cleanup every minute. Draft imports/transfers expire after 7 days; conversations default to 90 days; completed/failed/cancelled jobs expire after 30 days. Financial records, source rows, repayment receipts and Undo history are retained until workspace deletion. Settings deletion revokes every session, stops jobs, then removes the live ledger after at least two minutes. A minimal identity tombstone prevents accidental account resurrection. Backup copies expire according to the configured policy.

**npm run maintenance** runs cleanup manually. Do not run a second worker.

## Restore and rollback

Test restoration monthly into a **fresh private staging volume**, using the same encryption/repository recovery procedure required after host loss.

```sh
restic check --read-data
restic snapshots --tag splitwise-ai
restic restore SNAPSHOT_ID --target /private/restore-drill
```

Find the snapshot directory containing manifest.json in the restored tree. Extract the **latest** deletion ledger from the newest available control database/snapshot, even when restoring an older ledger snapshot. Use **npm run deletions** against that latest control database to produce the JSON array. An empty verified array is still required if no deletions exist. Store deletion requests off-host with backups; for stricter deletion recovery guarantees, replicate that ledger immediately to a separately controlled service.

Stop the destination app and run:

```sh
npm run restore:all -- /private/restore-drill/PATH_TO_SNAPSHOT --confirm --deletions /private/latest-deletions.json
```

Load the destination production environment and mount those private paths into an operations container if using Docker. Restore verifies every checksum, path, integrity check and migration **before replacing any live database**. It rejects symlinks, traversal, duplicate entries and restores made while the launcher lock exists. Sessions are revoked, recovered running jobs resume from their checkpoint, and deletion tombstones are reapplied. Previous database copies are retained beside their replacements. All app processes must stay stopped if a filesystem installation step fails.

After a drill, compare known synthetic balances, refund totals, repayments, rules, source rows and persistent Undo, then measure recovery time and record the result. The automated restore regression covers essential data and deletion/session safeguards; it does not replace a remote repository drill.

For upgrades:

1. Require green CI; use a separate staging origin, OIDC client, volume and restricted API project.
2. Take and verify a remote backup. Keep the previous immutable image.
3. Stop app and worker, deploy the new image and run **db:migrate:all**.
4. Start and verify readiness, sign-in and the synthetic expense workflow.
5. If rollback is necessary, stop service and restore the matching pre-migration backup plus the latest deletion ledger before using the previous image. Older binaries reject newer schema versions. Never run an old image against a migrated database.

## Monitoring and response

- **/api/health**: process/config liveness.
- **/api/ready**: database access, free disk and fresh worker heartbeat; returns only ok/status publicly.
- **/api/ops**: bearer-protected Prometheus metrics for worker age, free bytes, queued/running/failed jobs, oldest queued age and last successful off-host backup. OPS_TOKEN must contain at least 32 characters.
- **deploy/prometheus.yml** and **deploy/alerts.yml** provide scrape/alert templates. Configure the real target, protected token file and Alertmanager receivers, then test delivery to the operator.
- Logs are structured JSON with allowlisted request/job IDs, durations, status and error codes. Application logs exclude statements, prompts, emails, request URLs, session tokens and provider error bodies. Container logs rotate.
- The launcher supervises web and worker together, waits for graceful exit, and uses a process-start-aware lock. Docker restarts the service after unexpected exits. Worker lease tokens prevent a recovered job’s old worker from applying late results.

For a suspected secret leak, revoke the key, replace the server secret, restart, review provider usage and preserve redacted audit evidence. For a stuck queue, check worker/disk/backup metrics before retrying. Failed jobs keep completed batches; review those batches before retry or Undo.

## Assistant permissions

The Assistant home is the main interface. Agent runs can automatically create/update trips, active allocation rules, scoped user facts, people, templates and merchant names. Successful changes have local audit receipts and persistent Undo. Rule/trip edits do not move existing transactions or rewrite finalized allocations. Agent-generated split changes, trip assignments, manual expenses and repayments remain durable confirmation cards until a signed-in user explicitly applies them. Final split approval is a separate user action available in chat. Record-version checks and transactional writes protect stale or repeated clicks; no agent tool can apply cards, finalize, reopen expenses or execute repayments.

Scoped user facts, automatic-change receipts and pending cards are included in full workspace exports and encrypted backups. They remain private to the signed-in ledger. Statement rows are untrusted input; facts need provenance from user messages or saved user instructions.

## Verification status and release gate

The compiled production smoke test also runs natively in WSL and checks sign-in protection, CSRF, CSP/security headers and worker readiness. Luna live regressions and metered streaming were verified with synthetic data.

Repository tests cover signed OIDC success/failure, session expiry/revocation, cross-workspace reads and writes, streamed request limits, repayment retries, quota reservation/settlement, stale-worker fencing, retention, full backup restoration and deletion replay. Browser tests cover the full financial workflow and Settings/export at desktop/mobile sizes.

Docker Engine 29.9.1, Compose 5.6.0 and Buildx 0.38.0 are installed in the development Ubuntu WSL distribution using the [official Docker apt repository](https://docs.docker.com/engine/install/ubuntu/). Docker starts with systemd. CLI access currently uses administrator commands; ordinary user access requires separately approved Docker group membership, which grants root-equivalent host privileges.

**npm run test:container** builds the actual production image and exercises the production Compose file with temporary overrides. It uses a random loopback HTTPS port, an isolated certificate authority, a synthetic signed OIDC provider and private test volumes; it does not load .env.local or access the local ledger. Run it with a Docker-authorized Linux user and Node 24. On CI hosts whose UID differs from the image’s UID 1000, use **sudo "$(command -v node)" scripts/container-smoke.mjs** so private test bind mounts can be assigned correctly. Compose 2.24.4 or later is required for override tags.

The container suite passed locally: production image/build artifact isolation, non-root runtime, certificate-chain verification, CSP/CSRF, sign-in, verified invitation checks, separate ledgers, import/finalization, repayment retry safety, filtered balances, immediate restart, clean worker shutdown, encrypted restic backups/check/restore, deletion replay, session revocation and persistent Undo. The same suite runs in CI. The container launches Node directly so Docker stop signals reach the launcher and worker. The proxy preserves custom HTTPS ports for origin validation. Test fixtures and internal CA settings are never included in the runtime image or production configuration.

The recovery drill uses a local encrypted restic repository. Real-provider sign-in, public certificate issuance, off-host backup recovery, alert delivery and disk encryption still require deployment acceptance checks. Synthetic Luna evaluations have passed; actual model quality should be assessed against the intended workload.

This is a private single-server release foundation. Public self-service signup, billing, collaborative groups, multi-payer ledgers, currencies/FX, a PostgreSQL/multi-replica deployment and jurisdiction-specific legal policies require separate product scope.
