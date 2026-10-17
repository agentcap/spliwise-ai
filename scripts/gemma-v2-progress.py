#!/usr/bin/env python3
"""Read-only, compact progress for the queued experiment; no accuracy peeking."""
import json
import math
import os
from pathlib import Path

root=Path(__file__).resolve().parent.parent
top=Path(os.environ.get('GEMMA_V2_DIR',root/'.tools/finetune/gemma4-e2b-v2'))
state=json.loads((top/'status.json').read_text());stage=state['stage']
result={'stage':stage}
if stage=='waiting-for-gpu':
    result.update(gpuMiB=state.get('gpuMiB'),gpuPercent=state.get('gpuPercent'))
    result['message']=f"Waiting for GPU headroom: {state.get('gpuPercent')}% load, {state.get('gpuMiB')} MiB in use."
elif stage.startswith('train-'):
    interface=stage.removeprefix('train-')
    path=top/interface/'training-telemetry.jsonl'
    telemetry=[json.loads(s) for s in path.read_text().splitlines()] if path.exists() else []
    count=json.loads((top/'data-manifest.json').read_text())['splitCounts']['train']
    result.update(step=telemetry[-1]['step'] if telemetry else 0,total=math.ceil(count/8))
    if telemetry:result['loss']=telemetry[-1]['logs'].get('loss')
    result['message']=f"Training the {interface} interface adapter: {result['step']}/{result['total']} updates."
elif state.get('results'):
    p=Path(state['results']);records=[]
    if p.exists():
        for line in p.read_text().splitlines():
            if line.strip():
                try:records.append(json.loads(line))
                except json.JSONDecodeError:pass
    n=len(records)
    split=stage.rsplit('-',1)[-1]
    total=141 if split=='exposed' else 1 if split=='warmup' else json.loads((top/'data-manifest.json').read_text())['splitCounts'][split]
    result.update(completed=n,total=total,message=f"Evaluating {stage}: {n}/{total} cases completed.")
    infra=[]
    for record in records:
        err=(record.get('error') or '').lower()
        if any(s in err for s in ('header parser','http/1.1','request timed out','connection reset','openai http 5','cuda out of memory')):
            infra.append(dict(caseId=record['caseId'],error=record['error']))
    if infra:result['infrastructureErrors']=infra
else:result['message']=stage.replace('-',' ')
resources=top/'resource-samples.jsonl'
if resources.exists():
    last=resources.read_text().splitlines()[-1]
    sample=json.loads(last)
    result['gpuMiB']=sample.get('gpuMiB');result['gpuPercent']=sample.get('gpuPercent')
if state.get('error'):result['error']=state['error']
print(json.dumps(result))
