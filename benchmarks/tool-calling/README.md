# Splitwise AI tool-calling benchmark

141 frozen scenarios across 39 families and 12 categories. Fifteen anonymized adaptations come from saved web-app interactions inspected read-only on October 16, 2026: Tesla charging/insurance, DoorDash, office food, badminton merchants, FasTrak, groceries and a Colorado trip. The remaining scenarios extend those workflows. No private ledger, original names, API key or real financial amounts are distributed.

`cases.json` contains readable prompts, synthetic setup, recent conversation, semantic expected plans and oracle tool traces. `generate.py` recreates it deterministically. `policy.txt` is shared by every model. Each oracle trace is validated against an in-memory database migrated with the app's real migrations and processed by its real assistant dispatcher. Expected plans are checked independently of the model's final prose.

## Run in Ubuntu

```sh
python3 benchmarks/tool-calling/generate.py
bash scripts/android-build.sh :model-check:installDist
python3 -m unittest discover -s benchmarks/tool-calling -p 'test_*.py'
python3 scripts/tool-benchmark.py validate --output .tools/benchmarks/oracle-v1

# Uses the configured .env.local key; never prints it. This incurs API charges.
python3 scripts/tool-benchmark.py run --model gpt-6-luna --output .tools/benchmarks/full-v1

# Additional reasoning-enabled configuration, closer to the web app defaults.
python3 scripts/tool-benchmark.py run --model gpt-6-luna --reasoning medium --max-output 4096 --output .tools/benchmarks/full-v1

# Run local models sequentially to avoid CPU and memory contention.
python3 scripts/tool-benchmark.py run --model e4b --output .tools/benchmarks/full-v1
python3 scripts/tool-benchmark.py run --model e2b --output .tools/benchmarks/full-v1
python3 scripts/tool-benchmark.py report --output .tools/benchmarks/full-v1
```

## Run on this computer's GPU

WSL exposes CUDA here but does not expose the graphics adapter required by this LiteRT-LM build. The retained GPU experiments therefore use native Windows Java 21, the same JVM JARs and pinned `.litertlm` files, and WebGPU/Direct3D on the RTX 4070 12 GB. This preserves the tool-calling implementation without converting weights. A portable Temurin JRE and Microsoft's DirectX Shader Compiler were downloaded into ignored `.tools/android/windows/`; source metadata and archive checksums are retained there. Place the x64 `dxcompiler.dll` and `dxil.dll` next to `java.exe`. No system installation is required.

From Windows PowerShell, after the Ubuntu build:

```powershell
python -X utf8 scripts/tool-benchmark-gpu.py --java '.tools/android/windows/jre21/jdk-21.0.12.1+1-jre/bin/java.exe' --output .tools/benchmarks/full-v1
python -X utf8 scripts/tool-benchmark.py report --output .tools/benchmarks/full-v1 --require-complete
```

The launcher runs E4B then E2B sequentially. Results use `e4b-gpu` and `e2b-gpu` filenames; CPU results remain separate. `--backend gpu --java PATH` also works with the main runner and a scenario filter. Engine initialization errors stop GPU runs without a CPU fallback. `gpu-telemetry.json` records sampled GPU utilization, whole-device memory and power, including display/other applications; it is not a per-model VRAM or energy estimate. A missing shader-compiler probe and a successful one-case probe were kept separately from the complete comparison. Do not mix probe results into the full run.

The default GPU profile produced many damaged IDs and malformed arguments. A separate `--activation float32` profile tests a precision override while keeping the weights, policy, catalog, sampler and limits unchanged. Its filenames end in `-gpu-float32` and its telemetry is separate. This profile was added after observing the default GPU failures, with a four-case diagnostic before the full run; it is a runtime investigation on the same suite, not a held-out model-selection result. Default GPU arithmetic is selected by LiteRT-LM; its [configuration documentation](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.18.0/kotlin/java/com/google/ai/edge/litertlm/Config.kt) describes the usual GPU default as FLOAT16. An [upstream report on another GPU platform](https://github.com/google-ai-edge/LiteRT-LM/issues/3913) motivated the experiment but does not establish the cause on this NVIDIA card.

Different backends, arithmetic precision and generated fixture UUIDs can change answers. The local sampler uses the SDK's default seed 0. Accuracy is measured independently for CPU and GPU, and desktop GPU speed does not predict phone speed.

Precision profiles use separate runtime cache directories to avoid reusing compiled artifacts across types. Together with regenerated fixture UUIDs, this means the results compare runnable configurations; they do not prove the precise internal cause of a runtime defect.

## Outputs and interpretation

Optional while the full local runs execute in another terminal: `python3 scripts/tool-benchmark-memory.py --output .tools/benchmarks/full-v1`. This observes Linux process-lifetime RSS peaks for only these benchmark JVMs. It stops after both full local runs finish. Desktop process memory is not a phone RAM requirement.

The existing Android runtime and pinned model files must already be installed; see [Android setup](../../docs/android.md). `--filter '^equal-'` selects a family. Runs append one result per completed case and skip completed IDs when resumed. Use a fresh output directory after changing the dataset, policy, model artifact or runner. Store generated reports and raw traces under ignored `.tools/`, since future locally added scenarios may contain personal information.

Outputs: per-case JSONL plans and tool traces, model manifests with checksums/settings, `summary.json`, `report.md`, and a searchable `report.html`. Failed scenarios remain in the denominator. Infrastructure failures are visible; an API authorization or model-access failure stops the hosted run.

## Interpretation

This is a **shared full-catalog tool benchmark**, not a replay against your live database or a benchmark of the web app's different SDK schema. Every provider receives the same policy, tools, logical workspace, conversation and limits. Tools execute through the Android app's production validators. It excludes the Android assistant's smaller equal-split catalog, model-specific retries and pre-inference finalized-record guard, so those shortcuts cannot inflate model quality. It never applies confirmation cards or finalizes expenses.

Local inference uses LiteRT-LM 0.18.0 on desktop CPU (six threads) or the separately labelled Windows GPU backend, temperature 0.2, thinking disabled, speculative decoding enabled. The GPT-6 Luna baseline uses Responses with reasoning `none`. Baseline runs receive six turns and 1,024 output tokens per turn; local context is 16,384 tokens. A separately labelled medium-reasoning/4,096-token run measures an API budget closer to the web app defaults, with the same turn and time limits. API sampling is not equivalent to the local sampler. Engine initialization is separate from scenario latency. `firstTurnMs` is not time to first token. Fixtures have four initial people and up to 22 expenses. No phone latency, energy, sustained thermal behavior or token throughput is claimed.

A pass requires the expected targets/actions/participants/cents, valid commit, scoped rules and no financial mutation before confirmation. Extra organization actions fail the strict rubric even if a source-grounded extra fact might be acceptable in the product; examine such failures in the trace viewer. In particular, descriptive sentences in real-history examples may admit more than one sensible saved-context behavior. Categories inferred from original history are not graded when the user did not specify one. Merchant spelling alternatives are explicitly listed. Arbitrary additional rule scopes or aliases are rejected. The three read-only balance questions use numeric/verbal answer anchors; this is not a general semantic evaluator of prose. Successful action plans can pass even when the SDK leaves malformed finish-control text, because the app derives its confirmation-card summary from the plan; protocol diagnostics count these separately.

One trial per case is a screening comparison. Family variants are correlated. Wilson intervals describe the observed scenario sample, not production traffic or repeated-run stability; family macro scores reduce paraphrase weighting. The suite is not traffic-weighted. It does not cover images/receipts, import parsing, every refund-link edge case, physical device initialization or all long-conversation conditions. Broader deployment decisions need a phone run and repeated trials.

Some history-derived rule requests omit a category although `save_rule` declares `outputCategory` required. The completion rubric expects the requested rule to be saved and does not grade an inferred category when the user omitted it. A category-only follow-up therefore fails completion even when it could be a reasonable conservative product response. This contract ambiguity is a finding for app design, not proof that every failed response is nonsensical.

The fixed [rubric audit](rubric-audit.json) excludes one inconsistent merchant fixture from headline accuracy (140 eligible cases) and permits an additional exact source-grounded office-food fact in one original-history example. Both corrections apply equally to every model. All 141 requests and the unadjusted strict scores remain in the outputs.

Official model references: [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Gemma 4 function calling](https://ai.google.dev/gemma/docs/capabilities/text/function-calling-gemma4). The installed model artifact revisions and SHA-256 hashes are recorded in each run manifest.

Optional focused check: `python3 scripts/tool-benchmark-focused.py --output .tools/benchmarks/full-v1/focused --trials 8` repeats the actual Android assistant's selected-$12 equal-split path, with its smaller tool catalog and early candidate validation. It measures a different workload and must not be pooled with the full-catalog accuracy score. The first request includes engine initialization; the remaining requests reuse the engine. This is a narrow regression/performance check, not a representative model-quality score.

The retained app-path measurement instead uses native Windows GPU: after building the latest runner in Ubuntu, use `python -X utf8 scripts/tool-benchmark-focused.py --skip-build --backend gpu --java '.tools/android/windows/jre21/jdk-21.0.12.1+1-jre/bin/java.exe' --trials 8 --output .tools/benchmarks/full-v1/focused-gpu`. It checks the actual engine backend on every trial and refuses to report GPU timings if the app fell back to CPU. `--runner-jar` can select a preserved compiled artifact; the retained runs record its checksum. This path uses the app's default GPU precision and is separate from the full-catalog FLOAT32 configuration.
