#!/usr/bin/env python3
"""Bounded CPU-only LiteRT export investigation after measured GPU evaluation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
import psutil

ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('GEMMA_FINETUNE_DIR',ROOT/'.tools/finetune/gemma4-e2b-v1')).resolve()


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--wait-evaluation',action='store_true');a=p.parse_args()
    if a.wait_evaluation:
        while True:
            state=json.loads((OUT/'experiment-status.json').read_text())
            if state['stage']=='failed':raise RuntimeError('Evaluation failed; resolve it before export')
            if state['stage']=='complete':break
            time.sleep(3)
    assert (OUT/'comparison.json').exists()
    if not (OUT/'merge-manifest.json').exists():
        with (OUT/'merge.log').open('w') as log:
            subprocess.run([sys.executable,str(ROOT/'scripts/finetune-merge.py')],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
    else:
        merged=json.loads((OUT/'merge-manifest.json').read_text())
        assert hashlib.file_digest((OUT/'adapter/adapter_model.safetensors').open('rb'),'sha256').hexdigest()==merged['adapterSha256']
    from huggingface_hub import hf_hub_download
    source=hf_hub_download('litert-community/gemma-4-E2B-it-litert-lm','chat_template.jinja',revision='b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1')
    template=OUT/'export-research/mobile-chat-template.jinja';template.write_bytes(Path(source).read_bytes())
    python=OUT/'export-venv/bin/python'
    cmd=[str(python),'-m','litert_torch.generative.export_hf','--model='+str(OUT/'merged-bf16'),'--output_dir='+str(OUT/'mobile-export'),'--task=text_generation','--prefill_lengths=128','--cache_length=16384','--externalize_embedder=True','--jinja_chat_template_override='+str(template),'--quantization_recipe=dynamic_wi8_afp32','--moe_exports_implementation=eager']
    env=os.environ.copy();env.update(CUDA_VISIBLE_DEVICES='',OMP_NUM_THREADS='4',MKL_NUM_THREADS='4')
    record=dict(command=cmd,templateSha256=hashlib.sha256(template.read_bytes()).hexdigest(),templateSourceRevision='b3ca0d2f076785a8f4b2219ddbd2bdb99954eae1',limits=dict(seconds=900,processRssMiB=10000,minimumAvailableHostMiB=1536),startedAt=time.time(),samples=[])
    logpath=OUT/'export-research/conversion.log'
    with logpath.open('w') as log:
        process=subprocess.Popen(cmd,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
        while process.poll() is None:
            rss=0
            try:
                parent=psutil.Process(process.pid)
                rss=sum(q.memory_info().rss for q in [parent]+parent.children(recursive=True) if q.is_running())/2**20
            except psutil.NoSuchProcess:pass
            available=psutil.virtual_memory().available/2**20
            record['samples'].append(dict(time=time.time(),rssMiB=rss,availableHostMiB=available))
            reason=('15 minute conversion limit' if time.time()-record['startedAt']>900 else '10 GB process-memory limit' if rss>10000 else 'host memory reserve' if available<1536 else '')
            if reason:
                record['stoppedReason']=reason
                try:
                    for child in psutil.Process(process.pid).children(recursive=True):child.terminate()
                except psutil.NoSuchProcess:pass
                process.terminate()
                try:process.wait(timeout=10)
                except subprocess.TimeoutExpired:process.kill();process.wait()
                break
            (OUT/'export-research/conversion-status.json').write_text(json.dumps({k:v for k,v in record.items() if k!='samples'},indent=2)+'\n')
            time.sleep(2)
        record['exitCode']=process.returncode
    record['seconds']=time.time()-record['startedAt'];record['peakRssMiB']=max((r['rssMiB'] for r in record['samples']),default=0)
    bundles=list((OUT/'mobile-export').glob('*.litertlm'))
    record['bundles']=[dict(path=str(p),bytes=p.stat().st_size,sha256=hashlib.file_digest(p.open('rb'),'sha256').hexdigest()) for p in bundles]
    record['conversionSucceeded']=record['exitCode']==0 and bool(bundles)
    record['androidLoadTested']=False;record['physicalPhoneTested']=False
    record['logTail']=logpath.read_text(errors='replace')[-6000:]
    (OUT/'export-manifest.json').write_text(json.dumps(record,indent=2)+'\n')
    outcome='A LiteRT bundle was generated. It has not yet been load-tested in the app or on a phone.' if record['conversionSucceeded'] else 'No successfully converted LiteRT bundle was produced. The evaluated artifact remains the PEFT adapter.'
    lines=['# Android / LiteRT deployment investigation','',outcome,'',
      'The installed `litert-torch==0.9.4` exporter starts successfully and includes Gemma 4 causal-model support. It runs in a separate environment with Torch 2.12.1, Transformers 5.5.0, ai-edge-litert 2.2.0, ai-edge-quantizer 0.9.0 and litert-converter 0.4.0. Its default `litert_moe` experts backend is not registered with this Transformers version; the first failure is retained in `export-research/attempt-1/`. The retry uses the supported `moe_exports_implementation=eager` option for dense E2B. The original training environment and Android model configuration were preserved.','',
      'The text adapter was merged into the original BF16 composite checkpoint on CPU, one shard at a time. Every LoRA module was matched to an official weight, shapes and finite values were checked, and sample numerical deltas plus file hashes were retained in `merge-manifest.json`. The merge is a separate export input; measured accuracy belongs to NF4 + adapter inference, not this BF16 merge.','',
      f"Conversion outcome: exit {record['exitCode']}; {record['seconds']:.1f}s; sampled peak host RSS {record['peakRssMiB']:.0f} MiB; stop reason: {record.get('stoppedReason','converter finished')}. See `export-research/conversion.log` and `export-manifest.json` for the exact failure/output.",'',
      'The attempted text-only export uses a 16,384-token cache, 128-token prefill chunks, externalized embeddings, INT8 weights / FP32 activations, and the Android source repository\'s chat template pinned to the same revision as the existing model. This quantization differs from both training NF4 and the official mobile bundle\'s mixed 2/4/8-bit scheme. Conversion alone would not establish preserved tool arguments, accuracy, latency or memory.','',
      'A deployment candidate must load in the pinned LiteRT-LM 0.18.0 runtime, pass the app dispatcher and tool-format checks, repeat base/tuned evaluations with matched conversion settings, and then be measured on a physical phone. The existing Android app still points to its original pinned model. No phone readiness is claimed.','',
      '## Reproduce','', 'After the measured comparison, run:', '', '```sh',
      '/path/to/gemma-4-multimodal-finetuning/.venv/bin/python scripts/finetune-export.py', '```','',
      'Create a fresh experiment directory to avoid overwriting a completed merged checkpoint. Exact converter dependencies are in `export-research/environment.json`; the converter command and resource bounds are in `export-manifest.json`.','',
      '[Official conversion guide](https://developers.google.com/edge/litert/conversion/pytorch/genai) documents Gemma 4 support, local checkpoints, quantization and template overrides. [Fine-tuned model deployment guide](https://developers.google.com/edge/litert-lm/tutorials/convert-and-run) describes conversion as a separate deployment step.','']
    (ROOT/'finetuning/gemma4-e2b/deployment.md').write_text('\n'.join(lines))
    print(json.dumps({k:v for k,v in record.items() if k not in ('samples','logTail')},indent=2))


if __name__=='__main__':main()
