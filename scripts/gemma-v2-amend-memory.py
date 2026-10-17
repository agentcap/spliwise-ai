#!/usr/bin/env python3
"""Retain the resource-failed pass and freeze equal inference memory controls."""
import hashlib
import json
from pathlib import Path
import time

ROOT=Path(__file__).resolve().parent.parent
TOP=ROOT/'.tools/finetune/gemma4-e2b-v2'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
target=TOP/'evaluation-amendment-2.json';assert not target.exists()
assert not list(TOP.glob('tuned_*-*.jsonl')),'No adapter evaluation may precede this amendment'
data=json.loads((TOP/'data-manifest.json').read_text())
for split,h in data['fileSha256'].items():assert sha(TOP/f'{split}.cases.json')==h
for interface in ('full','reduced'):
    trained=json.loads((TOP/interface/'training-manifest.json').read_text())
    for name,h in trained['adapterFiles'].items():assert sha(TOP/interface/'adapter'/name)==h
archive=TOP/'evaluation-preflight-memory';archive.mkdir();retained=[]
for p in list(TOP.glob('base_full-*')):
    assert p.parent.resolve()==TOP.resolve() and archive.parent.resolve()==TOP.resolve()
    retained.append(dict(name=p.name,sha256=sha(p)));p.rename(archive/p.name)
(archive/'stopped-status.json').write_bytes((TOP/'status.json').read_bytes())
names=['gemma-v2-model.py','gemma-v2-experiment.py']
sources=TOP/'evaluation-sources-memory';sources.mkdir()
for name in names:(sources/name).write_bytes((ROOT/'scripts'/name).read_bytes())
obj=dict(time=time.time(),originalPlanSha256=sha(TOP/'plan.json'),dataManifestSha256=sha(TOP/'data-manifest.json'),
    previousAmendmentSha256=sha(TOP/'evaluation-amendment-1.json'),
    reason='Whole-device memory grew near the 12GB limit during variable-shape inference, followed by 90s HTTP timeouts and stale queued requests. One 81-token generation took 137s despite 6.4GiB peak live tensor allocation. Release unused CUDA allocations between requests, reserve display/driver headroom with a .78 allocator fraction, and record live/reserved memory. Restart all four arms. This is resource/protocol repair, not model or data selection.',
    unchanged=['Frozen datasets, expectations and splits','Both trained adapters','Tool selection and argument semantics','Greedy sampling, token/turn limits, production dispatcher and scorer'],
    memoryPolicy=dict(processFraction=.78,releaseUnusedCacheAfterEachRequest=True),
    excludedPreflight=retained,scripts={n:sha(ROOT/'scripts'/n) for n in names})
target.write_text(json.dumps(obj,indent=2)+'\n')
print('Memory-policy repair recorded. Data and trained adapter hashes verified unchanged.')
