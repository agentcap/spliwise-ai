# Android inference performance — October 16, 2026

The development build is version **1.1.2**, using Gemma 4 E4B and LiteRT-LM 0.18.0. The desktop emulator uses 8 GB RAM, six virtual CPU cores and KVM host CPU features. AVX2 and FMA were verified inside Android. These measurements do not establish Galaxy GPU performance.

## Observed timings

| Request | Total time | Result |
| --- | ---: | --- |
| Original selected $12 equal split, four-core emulator | 78 s | Correct $6/$6 proposal |
| Updated first split after emulator restart | 37.1 s | Correct proposal; includes 13.5 s of model initialization |
| Updated repeat split in the same engine session | 14.2 s | Correct proposal; one inference round |
| Two selected expenses, $12 and $10.01 | 26.3 s | Both prepared; correct $6/$6 and $5/$5.01 allocation |
| Free-form equal-split request using the full tool catalog | 32.5 s | Correct proposal |

These are individual observations on this computer, not statistical latency estimates. The original and updated emulator CPU configurations differ, and cache state affects startup. Each test uses an isolated synthetic ledger. Splits remain pending for confirmation, expenses stay in Inbox and outstanding balances remain zero throughout the tests.

## Changes

- Clear, single-intent equal-split requests for 1–20 selected positive, unfinished expenses use five relevant tools and shorter instructions. Known people and categories are required. A descriptive target must match the selected expense, and a singular target cannot force changes to a larger selection. Other split methods, ambiguous targets, refunds and multi-action requests retain all tools.
- Selected records are included in the model input with real IDs and current versions. Their merchant fields remain untrusted data. The existing category is preserved when the user does not request another category.
- Once every selected proposal is validated, the app derives the confirmation summary directly from that plan. It avoids another inference round just to describe the same result. Partial focused results are discarded, and the dispatcher rejects unrelated tools in this path.
- Speculative decoding is enabled and thinking is explicitly disabled through the SDK configuration. Emulator CPU threads follow available virtual cores, up to eight. Phones keep their existing GPU preference and default CPU fallback thread configuration. See the [pinned SDK configuration](https://github.com/google-ai-edge/LiteRT-LM/blob/v0.18.0/kotlin/java/com/google/ai/edge/litertlm/Config.kt).
- The desktop launcher exposes host CPU features with KVM instead of the emulator's restricted default CPU model. This follows [QEMU's host CPU configuration guidance](https://www.qemu.org/docs/master/system/i386/cpu.html). Software-only emulation does not use host passthrough.
- Debug timing logs under `LocalAiPerformance` contain model/backend, model-load time, first-response time, inference-round count and total duration. They contain no prompts, tool arguments or ledger contents.

## Validation

Seven routing tests cover explicit requests, scope matching, unknown people/categories, duplicate participants, multi-intent requests and allowed tool capabilities. The 27 ledger tests and five Android navigation/storage tests pass. Android lint reports zero errors and 22 advisory warnings.

Ten targeted E4B scenarios passed for the full assistant configuration; the selected-split path was additionally checked on native Android, including a repeat request and a two-expense selection. The full-catalog Android check also passed. The finalized-expense scenario is an application guard before inference. This remains a limited test set rather than a general model-reliability score.

The E2B cash-expense regression still failed after the runtime changes (17 seconds, with no valid expense action). E4B remains selected for reliability. Advanced requests can still take considerably longer than the focused example.

Raw evidence is under `.tools/android/evaluations/`: `e4b-speed-hostcpu-native.log`, `e4b-speed-hostcpu-multiple.log`, `e4b-speed-hostcpu-general.log`, `e4b-speed-hostcpu-detail.log`, `e4b-speed-host-suite.log`, `e4b-speed-final-regression.log` and `e2b-speed-expense-failure.log`.

For the faster desktop path, select an expense in Review, choose **Give one instruction**, and enter `Split equally between me and @alex`. Use the manual **Split…** editor for immediate splitting without model inference. The desktop test workspace was backed up before the update and retained during installation.
