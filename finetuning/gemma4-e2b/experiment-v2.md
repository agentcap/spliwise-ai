# Broader data and reduced tools experiment

Run from `/path/to/splitwise_ai` with the existing, unchanged training environment:

```sh
PY=/path/to/gemma-4-multimodal-finetuning/.venv/bin/python
"$PY" scripts/gemma-v2-check.py
"$PY" scripts/gemma-v2-experiment.py setup
"$PY" scripts/gemma-v2-experiment.py run
```

Default output: `.tools/finetune/gemma4-e2b-v2/`. `GEMMA_V2_DIR` can select a
fresh output directory. Both adapters link to the retained official base from
the first experiment rather than downloading or duplicating its weights.

The four arms are base/full tools, base/reduced tools, newly trained/full tools,
and newly trained/reduced tools. Two adapters start independently from the same
official checkpoint and see the exact same semantic episodes. Their tool
serialization differs. All other training settings match the first experiment:
NF4/BF16 CUDA QLoRA, rank 16, alpha 32, learning rate 1e-4, effective batch 8,
one epoch. No test-based checkpoint selection or hyperparameter search occurs.

The broader curriculum includes answer-only replies, clarification, supported
and unsupported actions, exact facts with explicit scopes, saved template
application versus creation, and disjoint composition families. Development
and held-out compositions are separate from training. All oracle trajectories
are checked against the actual ledger before training. Native argument targets
and reduced targets must round-trip to the same ledger calls, except for the
explanation that the reduced interface deliberately supplies from user text.

The reduced interface selects tools using fixed retrieval rules on user text,
history and current selection. It supplies observed versions, converts dollars
and percentages, supplies the visible category when omitted, and permits an
omitted transaction ID only with exactly one selected expense. It never uses
case IDs, expected plans, oracle calls or grades during model inference. It
does not infer participants, requested scopes, missing dates or ambiguous IDs.
The original ledger still validates all actions and calculates rounded shares.

The plan, scripts and data are hashed before training. One fixed development
warmup is excluded for each arm. All four arms use greedy decoding, thinking
off, the same CUDA/NF4 backend, the same production dispatcher, the same six
round limit and 1,024 output-token cap. The exposed original benchmark retains
its published scorer and the same `personal-04` exclusion. Fresh cases add an
explicit check rejecting unrequested fact scopes.

An untrained preflight candidate and its failed retrieval validation are
retained separately if setup needed repair. No model scores inform these
repairs. The app's deployed model and production Kotlin code are unchanged.

Results are written to `comparison.json`, `report.md`, and
`docs/gemma4-experiment-v2.md`. Inspect `status.json`, training telemetry and the
per-arm result files for progress. Completed training is not overwritten.
Evaluation can resume only while frozen data and source hashes still match.

The retained v2 run is complete. `scripts/gemma-v2-finalize.py` independently
regrades its results, checks all source/data/adapter hashes and every initial
prompt by case ID, then builds the detailed report and the ZIP with both
adapters. This finalizer documents the retained v2 measurements; use the
experiment runner's dynamic report for a new trial. Run it with Python 3.11+
from the repository root after the retained experiment completes:

```sh
python scripts/gemma-v2-finalize.py
```

For an interrupted, already frozen run, resume with `run`; do not rerun setup.
The retained study has three explicit evaluation amendments for malformed
parser output, memory cleanup, and HTTP connection closure. A separate record
identifies external GPU contention. These affect the evaluation wrapper only;
training data, trained weights, action semantics and scorer are unchanged.
Excluded preflight passes remain in their own directories. Final passes contain
no HTTP or resource failures. The four arms use identical memory headroom and
connection handling. Close competing GPU workloads before running evaluation.

The safetensors audit verifies 490 finite tensors per adapter and learned deltas
in 205 B matrices. Forty zero B matrices are precisely the unused key/value
projections in the final 20 KV-sharing layers of the pinned architecture.

The resulting ZIP is `splitwise-gemma4-e2b-v2-experiment.zip`. Its external
`package-manifest.json` gives the archive SHA-256 and each member's hash. It
includes adapters, frozen data, final traces, settings, sources and reports;
shared official base weights and compiled caches are excluded. Explicitly load
the pinned base before loading a relocated PEFT adapter, since its original
configuration contains a local base path. These are not Android `.litertlm`
bundles, and the reduced adapter expects the reduced inference interface.

Limits: synthetic templates and family variants are correlated; results are
not estimates of production traffic reliability. This compares broader data
as a package, and reduced tools as a package. It does not isolate each example
type or bookkeeping feature. CUDA results do not establish Android performance.
