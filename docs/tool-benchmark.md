# App tool-calling benchmark — October 16, 2026

GPT-6 Luna completed the most tasks across the full tool catalog. On this RTX 4070, the FLOAT32 GPU configuration made Gemma E2B about 4.5 times faster and E4B about 3.6 times faster than their recorded CPU runs, with similar task-completion rates. The runtime's default GPU configuration produced damaged arguments and much lower completion rates.

The suite contains **141 scenarios, 39 families and 12 categories**. Fifteen anonymized adaptations come from saved web-app conversations; 126 extend those patterns. Eight configurations completed every scenario: **1,128 retained scenario-runs**. One inconsistent fixture is excluded equally for every model, leaving 140 headline cases per configuration. These are measured results on synthetic, in-memory ledgers.

## Full-catalog results

| Model / configuration | Passed | Pass rate | Median request | p95 request |
| --- | ---: | ---: | ---: | ---: |
| GPT-6 Luna, medium reasoning / 4,096 output tokens | 132/140 | 94.3% | 4.51s | 9.18s |
| GPT-6 Luna, reasoning off / 1,024 output tokens | 125/140 | 89.3% | 3.58s | 6.26s |
| Gemma 4 E4B, GPU / FLOAT32 activations | 106/140 | 75.7% | 5.98s | 7.27s |
| Gemma 4 E2B, GPU / FLOAT32 activations | 90/140 | 64.3% | 2.57s | 4.68s |
| Gemma 4 E4B, CPU / six threads | 103/140 | 73.6% | 21.51s | 26.72s |
| Gemma 4 E2B, CPU / six threads | 88/140 | 62.9% | 11.59s | 15.50s |
| Gemma 4 E4B, default GPU precision | 36/140 | 25.7% | 5.38s | 9.30s |
| Gemma 4 E2B, default GPU precision | 32/140 | 22.9% | 2.01s | 2.80s |

Times include inference, subsequent tool turns, validation and commit. They include failed cases; quick failures do not establish useful speed. Local engine initialization and fixture setup are excluded. Hosted timings include network time. These are desktop measurements, **not phone timings**.

The two retained Luna runs have estimated uncached API costs of **$0.0767** (reasoning off) and **$0.0878** (medium), each covering all 141 scenarios and their multiple inference turns. Discarded adapter pilots are additional and are not included in those totals. Local runs make no paid model API calls; hardware and energy costs were not measured. Pricing assumptions and token usage are retained in the generated report. [OpenAI model reference](https://developers.openai.com/api/docs/models/gpt-6-luna).

## What the cases cover

The original-history examples include Tesla charging and insurance, shared DoorDash expenses, office food, badminton merchants, Uber One membership, FasTrak follow-ups, groceries and a Colorado trip. People are renamed and the ledgers and amounts are synthetic.

Extensions cover equal/exact/percentage/personal allocations, rounding, refunds, multiple selected expenses, search pagination, missing participants, conflicting instructions, saved rules and updates, person/trip/date scopes, memory quotes, people, trips, assignments, templates, merchant names, manual expenses, repayments, finalized expenses, untrusted statement text and read-only questions.

Every provider receives the same **16-tool Android catalog**, policy, logical fixtures and conversation history. The app's real ledger dispatcher validates calls. The web app has a different SDK interface, so these results measure the shared Android contract rather than end-to-end web-app behavior. The ordinary optimized equal-split route is excluded from the full-catalog score and checked separately.

Baseline configurations permit six inference turns, 1,024 output tokens per turn and a nominal 120-second scenario limit. Local context is 16,384 tokens. The medium Luna configuration has a larger output allowance and is a separate budget comparison. Local runs use LiteRT-LM 0.18.0, the pinned Gemma artifacts, thinking disabled, speculative decoding enabled and the SDK's default sampler seed 0. CPU runs use an i7-14700F under WSL2; GPU runs use native Windows Java and WebGPU/Direct3D on an RTX 4070 12 GB, without CPU fallback in the common runner.

## Findings for app design

- **GPU configuration matters for correctness.** E4B's default GPU run had 23 native tool-parser failures; both full FLOAT32 runs had none. FLOAT32 requests higher-precision activations with the same quantized weights. Separate caches and generated fixture UUIDs mean this comparison does not prove the internal cause. An [upstream report on another GPU platform](https://github.com/google-ai-edge/LiteRT-LM/issues/3913) motivated the diagnostic, which preceded the full FLOAT32 runs.
- **Keep merchant scope precise.** A rule for Tesla insurance must not expand to all Tesla charges; Uber One membership must not expand to all Uber expenses. Correct tool names alone would miss these failures.
- **Make lookup behavior explicit.** Models sometimes search for phrases such as “Colorado trip” or “refund” instead of using a shorter literal query or the selected transaction already supplied. Empty results can lead to unnecessary clarification.
- **Review required category fields.** Some original requests omit a category, while `save_rule` requires one. The completion rubric expects the rule to be saved and leaves inferred categories ungraded. A category-only follow-up fails completion even when it is a reasonable conservative response. Making category preservation explicit would remove this ambiguity.
- **Separate completion from protocol compliance.** Some native calls omit required fields that the dispatcher fills in by default. The report records argument-schema errors, rejected calls and unparsed finish-control replies separately from final plan success.

The broad results favor Luna for the general assistant. Local models warrant narrower workflows with validated outputs; the small app-path experiment below is useful evidence for that route but cannot establish reliability across the catalog.

## Existing app equal-split path

The real Android assistant's smaller five-tool route was tested separately on GPU, using its default activation precision and early validation. The request splits a selected $12 lunch equally between self and Alex, with category Food & Drink. Each model received eight repetitions with fresh synthetic records; every trial reported the actual GPU backend and verified the resulting plan.

| Model | Passed | First request, including initialization | Warm median | Warm range |
| --- | ---: | ---: | ---: | --- |
| Gemma 4 E2B | 8/8 | 24.23s | 0.72s | 0.67–0.77s |
| Gemma 4 E4B | 8/8 | 69.20s | 1.21s | 1.20–1.29s |

The first request reads model files through the WSL share and includes engine initialization; it is not a phone cold-start measurement. Warm statistics use the remaining seven requests with the engine reused. This is one narrow request repeated eight times, not eight independent workflow types, and is not pooled into the main benchmark. The result supports investigating focused local routes alongside a broader hosted assistant.

## Review and reproduce

- [Benchmark cases](../benchmarks/tool-calling/cases.json), [method and commands](../benchmarks/tool-calling/README.md), [rubric audit](../benchmarks/tool-calling/rubric-audit.json).
- Local retained outputs: [detailed report](../.tools/benchmarks/full-v1/report.md), [searchable trace viewer](../.tools/benchmarks/full-v1/report.html), [machine-readable summary](../.tools/benchmarks/full-v1/summary.json). These generated files are intentionally ignored by Git.
- Manifests retain model-file checksums, settings, source fingerprints and platform information; preserved GPU runner JARs, source snapshots, logs and whole-device GPU telemetry are in the same output directory.

All 141 oracle traces passed against the production ledger, and the scorer's 19 regression checks passed. The ledger/assistant test suites and web TypeScript check also passed. No real ledger was modified.

This is one trial per scenario/configuration. Family variants are correlated and the suite is not traffic-weighted. The report includes family macro scores, paired outcomes and Wilson intervals, not claims of deployment reliability. Balance replies use numeric/verbal anchors, and fact bodies use required text fragments plus quote and scope checks; there is no general prose judge. The fixed audit excludes one mismatched merchant fixture and accepts one optional source-grounded office-food fact equally for every model. Images, import parsing, full statement scale, phone memory, energy, sustained thermal behavior and physical-device latency remain unmeasured.
