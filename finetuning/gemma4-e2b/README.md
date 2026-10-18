# Gemma 4 E2B tool-calling adapter

Trainable checkpoint: `google/gemma-4-E2B-it`, pinned to revision
`3e22461f65e89153144f8adb70e3b8c2cc9845a7`. The inference-only `.litertlm`
bundle is never trained. Outputs live in `.tools/finetune/gemma4-e2b-v1/`.
The frozen benchmark and previous results remain intact.

Requires WSL2/Linux, CUDA, approximately 12 GB GPU memory, and Python 3.12. The
experiment uses the Python environment configured by `GEMMA_TRAINING_PYTHON`,
defaulting to `../gemma-4-multimodal-finetuning/.venv/bin/python` from the repository.
It does not change that environment's packages. `requirements.txt` pins the observed versions;
install a matching CUDA PyTorch wheel separately when recreating the environment.
Manifests capture exact dependencies, model hashes, seeds, settings and devices.

Run from the repository directory. For a new trial, set `GEMMA_FINETUNE_DIR`
to a fresh absolute directory inside `.tools/finetune/`. Scripts refuse to mix
evaluation trials; omit the variable for the retained v1 defaults.

```sh
PY="${GEMMA_TRAINING_PYTHON:-../gemma-4-multimodal-finetuning/.venv/bin/python}"
OUT=${GEMMA_FINETUNE_DIR:-$PWD/.tools/finetune/gemma4-e2b-v1}
bash scripts/android-build.sh :model-check:installDist
mkdir -p "$OUT"
"$PY" -c 'from huggingface_hub import snapshot_download; import os; from pathlib import Path; dest=Path(os.environ.get("GEMMA_FINETUNE_DIR",".tools/finetune/gemma4-e2b-v1"))/"base"; snapshot_download("google/gemma-4-E2B-it", revision="3e22461f65e89153144f8adb70e3b8c2cc9845a7", local_dir=str(dest))'
python3 scripts/finetune-data.py
python3 scripts/finetune-ledger-bridge.py build
for split in train dev heldout; do
  python3 scripts/finetune-ledger-bridge.py run \
    --dataset "$OUT/$split.cases.json" \
    --output "$OUT/$split.oracle.jsonl"
done
"$PY" scripts/finetune-gemma.py prepare
"$PY" scripts/finetune-gemma.py train
"$PY" scripts/finetune-experiment.py
"$PY" scripts/finetune-report.py
```

The experiment script creates its one-case development warmup from the frozen dev
split. Base/tuned inference runs sequentially on one GPU. Engine initialization
and that warmup are excluded from scored request latency.

The ledger bridge compiles an isolated copy of the production runner with a
loopback inference transport, initial summary export, configurable synthetic
people, and oracle error recovery. Its source and JAR hashes are retained. It
uses SQLite `:memory:` only; no production Kotlin source or real financial record
is changed.

Data: 600 training episodes across 25 compositional families, 50 development
episodes, and 80 held-out episodes across eight other compositions. Held-out
entities, merchant namespace, destinations and amount ranges differ from training.
All 730 oracle traces pass production ledger and required-field/type validation.
All 16 app tools occur, including finish controls. Prompts, tool-result bodies and
deliberately rejected calls have no loss target. Assistant tool calls and their
response openers are supervised with the official native chat-template format.

No exposed benchmark row or answer becomes training data. Training has no exact
benchmark prompt or eight-word prompt overlap; independent scenario design also
avoids rewrites of its complete cases. Lexical checks cannot prove absence of all
semantic similarities. Shared capabilities, policy and contract are intentional.
The held-out set was saved and hashed before tuning. Family variants are
correlated, synthetic tasks are not traffic-weighted, and neither evaluation is
a deployment reliability claim. Exposed regression scores are reported separately.
Both new-data evaluations additionally reject unrequested memory scopes; the
exposed evaluation preserves the published rubric unchanged. Synthetic UUIDs and
fixture timestamps are normalized identically at inference, with IDs restored
before real ledger dispatch. The report asserts identical initial prompt hashes
for the paired cases.

To serve a standalone local base or adapter (choose one):

```sh
"$PY" scripts/finetune-gemma.py serve
"$PY" scripts/finetune-gemma.py serve --adapter
```

The server binds only to `127.0.0.1:8765`; the bridge uses `--model cuda`.
Both models use NF4 weights, BF16 compute, greedy sampling, thinking disabled,
six rounds and 1,024 output tokens per turn, without CPU fallback. Compare these
CUDA runs to one another; the prior Windows LiteRT/WebGPU FLOAT32 runs have
different runtime and quantization effects.

Official references: [function calling](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4),
[checkpoint](https://huggingface.co/google/gemma-4-E2B-it),
[tool-calling fine-tuning](https://huggingface.co/docs/google-cloud/main/examples/vertex-ai-notebooks-fine-tune-gemma-4).
See [deployment.md](deployment.md) for the separate export investigation.
