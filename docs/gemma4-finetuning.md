# Gemma 4 E2B Splitwise tool-calling fine-tuning

Training succeeded, but this adapter should remain experimental. It learned the training-family workflows strongly while transferring little to new compositions, increased request latency, and regressed on safety cases. The three additional held-out successes all came from the mixed-receipt allocation family; the other seven held-out families had unchanged completion counts.

The adapter was trained locally on the RTX 4070 using the pinned official `google/gemma-4-E2B-it` checkpoint. All measurements below compare the unchanged checkpoint and adapter with identical CUDA inference settings. The existing LiteRT/WebGPU scores use another runtime and quantization and are not a causal training comparison.

| Evaluation | Base | Tuned | Gain | Base median | Tuned median |
| --- | ---: | ---: | ---: | ---: | ---: |
| Development (familiar families) | 9/50 (18.0%) | 47/50 (94.0%) | +76.0 pp | 11.610s | 13.849s |
| New held-out compositions | 35/80 (43.8%) | 38/80 (47.5%) | +3.7 pp | 11.290s | 16.373s |
| Exposed regression benchmark | 65/140 (46.4%) | 72/140 (51.4%) | +5.0 pp | 6.299s | 9.615s |

## Protocol, latency, and resources

| Evaluation / model | First pass | Argument-error cases | Rejected calls | Unparsed finish | p95 request |
| --- | ---: | ---: | ---: | ---: | ---: |
| heldout / base | 25/80 | 42 | 63 | 0 | 26.491s |
| heldout / tuned | 38/80 | 14 | 87 | 0 | 29.262s |
| exposed / base | 50/140 | 44 | 50 | 16 | 13.538s |
| exposed / tuned | 68/140 | 19 | 173 | 0 | 24.257s |

Final training run: 75 optimizer steps, one epoch over 600 episodes, 18.0 minutes; mean training loss 0.1161; peak allocated CUDA memory 7764 MiB, reserved 8154 MiB. Rank 16 / alpha 32 QLoRA, NF4 double quantization, BF16 compute, learning rate 0.0001, effective batch 8, seed 27031. Prompts, tool-result bodies and deliberately rejected calls have no loss target. An initial memory failure and a discarded data-audit pilot are retained separately and excluded from these final-run metrics.

Inference: WSL2 CUDA / PyTorch / Unsloth / bitsandbytes, SDPA, greedy decoding, thinking off, no speculative decoding, 1,024 output tokens per turn, six rounds, nominal 120-second scenario limit. A development warm-up is excluded. Request latency includes all tool rounds and in-memory ledger validation; engine load is excluded. Input is recomputed for each round. Allocated memory excludes display/other apps. No phone latency, energy, or sustained thermal measurements exist.

- Base inference peak allocated memory: 7150 MiB; sampled whole-device memory 11478 MiB; sampled model-process host RSS 10014 MiB.
- Tuned inference peak allocated memory: 7331 MiB; sampled whole-device memory 11999 MiB; sampled model-process host RSS 10184 MiB.

## Data and evaluation safeguards

600 training episodes, 25 compositional families; 50 development episodes; 80 held-out episodes across eight separate compositions. The held-out set uses different participant handles, merchant namespace, destinations and amount ranges. All 730 oracle traces pass the production ledger and required-field/type checks. The same 16-tool catalog and policy are shared intentionally. Training has no exact prompts or eight-word prompt overlaps with the frozen 141-case benchmark; the curriculum was written independently, without importing its cases or answers. Short shared tool instructions are unavoidable; lexical audit alone is not proof against semantic overlap.

The held-out set was saved and hashed before training. Hyperparameters were fixed before scored evaluation; development and held-out scores were not used to select a checkpoint. This is one deterministic run per scenario, using synthetic template-based tasks, not an estimate of deployment reliability. Family variants are correlated. Wilson intervals and family macro scores are in comparison.json. Scoring checks expected structured plans, selected answer anchors, required fields and dispatcher acceptance; it is not a general semantic judge of every free-form reply or fact body. The exposed benchmark excludes personal-04 equally, retaining 140 headline cases. Real financial records are never read or mutated.

## Category changes on the exposed benchmark

| Category | Base | Tuned |
| --- | ---: | ---: |
| clarification | 15/15 | 13/15 |
| context_and_multiaction | 1/6 | 2/6 |
| expense_and_repayment | 7/7 | 6/7 |
| memory_and_people | 3/9 | 3/9 |
| read_answers | 0/3 | 1/3 |
| rules | 3/20 | 12/20 |
| safety | 11/12 | 6/12 |
| scope_and_search | 6/11 | 5/11 |
| splits | 6/22 | 11/22 |
| templates_and_aliases | 6/6 | 6/6 |
| trips | 0/14 | 1/14 |
| web_history | 7/15 | 6/15 |

## What improved and what failed

Argument-error cases fell from 42 to 14 on held-out tasks and from 44 to 19 on exposed regression tasks; unparsed exposed finish responses fell from 16 to zero. Rules and splits improved on the exposed suite. However, safety completion fell from 11/12 to 6/12, and the exposed paired comparison contains 20 regressions. Rejected calls increased because some failures repeated until the six-turn limit.

- Trip-scoped facts often acquire an unrequested person scope.
- Applying a saved template can incorrectly save another template.
- Answer-only requests can invent `workspace_summary` or repeat a `changes_prepared` finish despite no staged action. The final curriculum contains no successful answer-only finish targets, which is a concrete coverage gap.
- Merchant scope, trip handling, missing context, and unsupported requests remain unreliable. Raw traces retain the exact calls and dispatcher rejections.

The prior unchanged LiteRT E2B FLOAT32 configuration scored 90/140, versus 72/140 for this tuned CUDA/NF4 configuration. Runtime and quantization differ, so these numbers cannot isolate a training effect across those configurations. They do establish that this experiment has not supplied a better measured replacement for the existing app configuration.

## Paired changes and remaining failures

heldout: 3 improved, 0 regressed, 77 unchanged. Remaining tuned failures:

- `heldout-holdout-trip-fact-and-alias-6001`: memory_scope; The requested changes are prepared; staged items need your confirmation.
- `heldout-holdout-rule-and-fact-6003`: runtime_or_commit, organization; Turn limit exceeded
- `heldout-holdout-both-zero-and-unsupported-6004`: runtime_or_commit, answer; Turn limit exceeded
- `heldout-holdout-template-application-6007`: organization; The requested changes are prepared; staged items need your confirmation.
- `heldout-holdout-trip-fact-and-alias-6009`: memory_scope; The requested changes are prepared; staged items need your confirmation.
- `heldout-holdout-rule-and-fact-6011`: organization, memory_scope; The requested changes are prepared; staged items need your confirmation.
- `heldout-holdout-both-zero-and-unsupported-6012`: runtime_or_commit, answer; Turn limit exceeded
- `heldout-holdout-template-application-6015`: organization; The requested changes are prepared; staged items need your confirmation.
All remaining failures, paired case IDs and category/family scores are retained in `comparison.json`.

exposed: 27 improved, 20 regressed, 93 unchanged. Remaining tuned failures:

- `web-rule-01`: organization; 
<eos>
- `web-rule-05`: organization; 
<eos>
- `web-rule-06`: organization; The requested changes are prepared; staged items need your confirmation.
- `web-rule-07`: organization; 
<eos>
- `web-rule-08`: runtime_or_commit, organization; Turn limit exceeded
- `web-rule-09`: organization; The requested changes are prepared; staged items need your confirmation.
- `web-rule-10`: organization; The requested changes are prepared; staged items need your confirmation.
- `web-followup-01`: organization; I need more information. What should the rule be called, and what should the expense category be?
All remaining failures, paired case IDs and category/family scores are retained in `comparison.json`.

## Artifacts and reproduction

- Adapter: `.tools/finetune/gemma4-e2b-v1/adapter/` (PEFT safetensors, configuration and tokenizer).
- Frozen splits, masks, validation, native outputs, ledger traces, dependency/model hashes, training settings and loss history: same experiment directory.
- Reproduction instructions: `finetuning/gemma4-e2b/README.md`. Source snapshots and adapter checksums are retained.
- Android/export feasibility: `finetuning/gemma4-e2b/deployment.md`. A trained PEFT adapter is not a loadable `.litertlm` file. No Android/phone readiness is claimed.
