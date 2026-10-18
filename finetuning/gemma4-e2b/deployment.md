# Android / LiteRT deployment investigation

No successfully converted LiteRT bundle was produced. The evaluated artifact remains the PEFT adapter.

The installed `litert-torch==0.9.4` exporter starts successfully and includes Gemma 4 causal-model support. It runs in a separate environment with Torch 2.12.1, Transformers 5.5.0, ai-edge-litert 2.2.0, ai-edge-quantizer 0.9.0 and litert-converter 0.4.0. Its default `litert_moe` experts backend is not registered with this Transformers version; the first failure is retained in `export-research/attempt-1/`. The retry uses the supported `moe_exports_implementation=eager` option for dense E2B. The original training environment and Android model configuration were preserved.

The text adapter was merged into the original BF16 composite checkpoint on CPU, one shard at a time. Every LoRA module was matched to an official weight, shapes and finite values were checked, and sample numerical deltas plus file hashes were retained in `merge-manifest.json`. The merge is a separate export input; measured accuracy belongs to NF4 + adapter inference, not this BF16 merge.

Conversion outcome: exit -15; 8.6s; sampled peak host RSS 14915 MiB; stop reason: 10 GB process-memory limit. See `export-research/conversion.log` and `export-manifest.json` for the exact failure/output.

The attempted text-only export uses a 16,384-token cache, 128-token prefill chunks, externalized embeddings, INT8 weights / FP32 activations, and the Android source repository's chat template pinned to the same revision as the existing model. This quantization differs from both training NF4 and the official mobile bundle's mixed 2/4/8-bit scheme. Conversion alone would not establish preserved tool arguments, accuracy, latency or memory.

A deployment candidate must load in the pinned LiteRT-LM 0.18.0 runtime, pass the app dispatcher and tool-format checks, repeat base/tuned evaluations with matched conversion settings, and then be measured on a physical phone. The existing Android app still points to its original pinned model. No phone readiness is claimed.

## Reproduce

After the measured comparison, run:

```sh
"${GEMMA_TRAINING_PYTHON:-../gemma-4-multimodal-finetuning/.venv/bin/python}" scripts/finetune-export.py
```

Create a fresh experiment directory to avoid overwriting a completed merged checkpoint. Exact converter dependencies are in `export-research/environment.json`; the converter command and resource bounds are in `export-manifest.json`.

[Official conversion guide](https://developers.google.com/edge/litert/conversion/pytorch/genai) documents Gemma 4 support, local checkpoints, quantization and template overrides. [Fine-tuned model deployment guide](https://developers.google.com/edge/litert-lm/tutorials/convert-and-run) describes conversion as a separate deployment step.
