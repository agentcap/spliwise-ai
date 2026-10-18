# Fine-tuned Gemma E2B Android test build

The v2 reduced-interface adapter has been merged with the retained official
checkpoint and converted into a text-only LiteRT-LM bundle. This is an
experimental device-testing build. The measured CUDA benchmark in
`gemma4-experiment-v2.md` does not measure this conversion or phone performance.

## Install on the test phone

Files are in `.tools/android/releases/gemma-v2-mobile/`:

1. Transfer `splitwise-ai-finetuned-v2.apk` and
   `splitwise-gemma4-e2b-v2-reduced.litertlm` to the phone's Downloads folder.
2. Open the APK and allow installation from the file-opening application if
   Android asks. This build uses the existing application ID and debug signing
   key, so it can update a matching existing installation.
3. Open Splitwise AI, then Settings and the AI model section.
4. Find **Gemma E2B fine-tuned v2 (experimental)**, tap **Import model file**,
   and choose the supplied `.litertlm` file.
5. After verification, tap **Use this model**. Inference runs locally.

The model is 3,695,941,584 bytes (3.70 GB). Keep at least 8 GB free before
copying/importing both files, since the Downloads copy and private imported
copy coexist. After successful import the Downloads model copy can be removed.
Android 12 or later is required. The APK contains ARM64 and x86-64 native
libraries. Physical-phone testing has not been completed for this build.

Test with a sample expense and explicit participant handles first, such as
“Split the selected lunch equally between @me and @alex.” Inspect the proposed
shares before finalizing. The original experiment still has ambiguity and
error-recovery failures; this conversion does not establish that those are fixed.

## Conversion and runtime

The reduced adapter SHA-256 is
`2b4465b4185f260ecb67bbcbd5df13dd73c274e46b114a76ebb8b069dafb009e`.
The official base revision is
`3e22461f65e89153144f8adb70e3b8c2cc9845a7`.
The mobile bundle SHA-256 is
`035b5fb51f5f7a48634c3ebb6bb64725beb0dfe7a7ad72f6cde90750884690de`.

The merge adds the LoRA deltas in FP32, rounds to the base BF16 dtype, and
stores FP32 shards for memory-mapped export. Export uses LiteRT Torch 0.9.4,
INT8 fully-connected weights, INT4 embeddings, FP32 activations, a 16,384-token
cache, and 128-token prefill. The Android runtime is LiteRT-LM 0.18.0. The
experimental model explicitly requests FP32 activation precision and uses
the reduced tool interface, greedy decoding and thinking disabled. GPU is
attempted on physical devices, with CPU fallback on initialization failure.

The installed converter has the upstream metadata bug documented at
https://github.com/google-ai-edge/litert-torch/issues/1329. The packaging script
applies the upstream removal of the obsolete field in memory. Installed
dependencies and completed model tensors are unchanged by this compatibility fix.

Decoder, token embeddings, and per-layer embeddings were converted and
quantized in separate processes, with 12 GiB memory and 2 GiB swap limits.
No additional swap files were created. Logs, source hashes, merge manifest and
stage manifests are retained under `.tools/finetune/gemma4-e2b-v2/android/`.

## Reproduction

Use the preserved export environment at
`.tools/finetune/gemma4-e2b-v1/export-venv/bin/python`.
For a fresh run, `scripts/gemma-v2-mobile.py prepare` creates the verified
merged checkpoint. Do not reuse a stale merge manifest after deleting its
output; preserve that manifest separately first.

With `scripts/gemma-v2-mobile-stages.py`, run `decoder`, quantize its
`model.tflite`, run `embedder`, quantize `embedder.tflite`, run `additional`,
quantize `per_layer_embedder.tflite`, then run `pack`. Work files are in
`android/mobile-export/tmpeg4px6__` beneath the v2 experiment directory.
Verify host Windows disk capacity in addition to Linux virtual filesystem
space. This run began with approximately 114 GiB free on Windows C:.

Run `scripts/gemma-v2-mobile-package.py` to stage the bundle and write its exact
size/hash into the Android model catalog. It preserves the existing base
model entries. Build with `scripts/android-build.sh :app:assembleDebug` and
copy the resulting APK to the release directory. `model-manifest.json` records
the candidate's identity. `validation.json` records the final checks.

The supplied model loaded successfully and passed the equal-split scenario in
the production Kotlin dispatcher on a synthetic ledger using desktop CPU
inference. This is a runtime smoke check, not a repeat of the full benchmark
or a measurement of physical-phone latency, memory, heat, or battery usage.

Final validation: all 38 existing assistant/ledger unit tests pass. The native
CPU smoke suite passes 9/10 scenarios: equal split, recurring rule, saved fact,
trip, repayment, manual expense, template, merchant alias and immutable finalized
expense. The ambiguity case fails because the model chooses Alex for “my friend”
instead of requesting clarification. The suite therefore exits nonzero; this
known model failure is recorded, not suppressed. Model loading and the other
native scenarios complete without infrastructure errors.

The exact delivered APK signature verifies, its embedded catalog matches the
model's hash and size, and its signing certificate matches the retained v1.1.1
APK. APK SHA-256:
`5c75eaced5e8e487f5d682abdb8a1f0d1d22207654e6edd2dcdf4ac0c960bfb1`.
