#!/usr/bin/env python3
"""Record a transport-only repair and exclude the incomplete baseline pass."""
import hashlib
import json
from pathlib import Path
import time

ROOT=Path(__file__).resolve().parent.parent
TOP=ROOT/'.tools/finetune/gemma4-e2b-v2'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
target=TOP/'evaluation-amendment-3.json';assert not target.exists()
assert not list(TOP.glob('tuned_*-*.jsonl')),'No adapter evaluation may precede this repair'
archive=TOP/'evaluation-preflight-http';archive.mkdir();retained=[]
for p in list(TOP.glob('base_full-*')):
    assert p.parent.resolve()==TOP.resolve() and archive.parent.resolve()==TOP.resolve()
    retained.append(dict(name=p.name,sha256=sha(p)));p.rename(archive/p.name)
names=['gemma-v2-model.py','gemma-v2-experiment.py']
sources=TOP/'evaluation-sources-http';sources.mkdir()
for name in names:(sources/name).write_bytes((ROOT/'scripts'/name).read_bytes())
obj=dict(time=time.time(),originalPlanSha256=sha(TOP/'plan.json'),dataManifestSha256=sha(TOP/'data-manifest.json'),
    previousAmendmentSha256=sha(TOP/'evaluation-amendment-2.json'),
    reason='Delayed post-response CUDA cleanup exposed stale socket reuse by the Java HTTP client, producing header-parser/no-bytes infrastructure errors. Add explicit Connection: close and close_connection=True. Validate 100 sequential POSTs using the actual Java HTTP client and delayed cleanup. Exclude and restart the complete baseline pass; no adapter evaluation has occurred.',
    unchanged=['Both trained adapters and training data','Tool routing, argument conversion and prompts','Model generation and memory controls','Scorer and all token/turn/time budgets'],
    excludedPreflight=retained,scripts={n:sha(ROOT/'scripts'/n) for n in names})
target.write_text(json.dumps(obj,indent=2)+'\n');print('HTTP transport repair recorded; the baseline pass will restart.')
