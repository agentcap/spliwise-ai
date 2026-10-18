# Fine-tuned Gemma in the webapp

Open **Workspace settings → AI model**, choose **Fine-tuned Gemma E2B
(experimental)**, and click **Save preferences**. This workspace preference
applies to chat and AI-assisted transaction processing. Hosted AI remains the
default and can be selected again at any time.

The local service must run on the same computer and network namespace as the
Next.js server and worker. From the repository in WSL/Linux, run:

```sh
npm run model:local
```

Keep that process running alongside `npm run dev` (or the production webapp and
worker). It builds the existing Kotlin runner using the bundled Android tools
and starts a loopback-only service on port 8766. `FINETUNED_MODEL_PORT` can change
the port; set it consistently for the service, webapp and worker. It requires the
converted model in `.tools/android/releases/gemma-v2-mobile/` and the retained
Java 21 runtime. The model's SHA-256 is verified before requests are accepted.
No OpenAI API key is needed for this choice.

The model is the same v2 reduced-interface mobile bundle documented in
`gemma4-android-v2.md`, using LiteRT-LM 0.18.0, FP32 activations, greedy sampling
and the matching reduced tool contract. CPU inference is the default. An
operator can set `FINETUNED_MODEL_BACKEND=gpu` for the local model process; the
existing runtime falls back to CPU if GPU initialization fails. This host was
verified with CPU inference. CUDA adapter inference and the original benchmark
scores are separate from this deployment.

## Data and validation

- Only the workspace's ledger data, settings and conversation are copied to the
  local inference process. Sign-in identities, session data, API credentials,
  and the control database are not sent.
- The service evaluates each snapshot in an in-memory SQLite database. It never
  opens or writes the live workspace file. Snapshots and prompts are not logged
  or written to temporary files.
- Native tools validate candidate actions against the copied ledger. The webapp
  then independently checks live versions, selected scope, facts and action
  contracts. Expense changes remain confirmation cards; inference does not
  finalize transactions or execute repayments.
- The service binds to `127.0.0.1` and requires a generated bearer token stored
  with mode 0600 at `.tools/finetune/web-model/token`. The browser never receives
  the token. Keep the repository and token private to the app operator.
- Requests are serialized, bounded to 64 MiB, and limited to three minutes.
  The web worker forwards cancellation to the native session. An offline or
  busy local model produces an explicit error, without a hosted-provider fallback.
- The usual workspace isolation and AI-consent rules still apply. Hosted token
  budgets and usage accounting continue to apply only to hosted API calls.

The model is experimental. It can guess an ambiguous person and has other
known reasoning/recovery failures. Use explicit handles and inspect proposed
changes. This integration does not repair or remeasure the training experiment.

## Checks

`npm test -- tests/finetuned-agent.test.ts` exercises persistence, provider
routing without an API key, pending confirmation cards, native/web contract
normalization, model identity and offline handling.

`npm run test:browser -- tests/browser/model-choice.spec.ts` checks selection,
saving, reload persistence and switching back in an isolated browser workspace.

With the service running, execute:

```sh
node --import tsx scripts/test-finetuned-web.ts
```

This explicit integration check uses a synthetic in-memory workspace through
the real web job pipeline and fine-tuned runtime. It verifies a $12 equal split,
a scoped saved fact, a pending manual expense card, and explicit split
confirmation, with no OpenAI key. It never processes the real workspace.

The schema migration adds `workspace_settings.aiModel`, defaulting existing
workspaces to `hosted`. Production operators must run the normal workspace
migrations before starting the upgraded web and worker processes. Container
hosting must additionally provision the Java/model runtime and shared token
in the same network namespace; that deployment is not configured by this change.
