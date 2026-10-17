#!/usr/bin/env python3
"""One-time audit amendment for a pre-heldout inference-wrapper defect."""
import hashlib
import json
from pathlib import Path
import time

ROOT=Path(__file__).resolve().parent.parent
TOP=ROOT/'.tools/finetune/gemma4-e2b-v2'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
target=TOP/'evaluation-amendment-1.json'
assert not target.exists()
assert not list(TOP.glob('*-heldout.jsonl')),'Repair must precede heldout model evaluation'
assert all((TOP/i/'training-metrics.json').exists() for i in ('full','reduced'))
archive=TOP/'evaluation-preflight-parser';archive.mkdir()
retained=[]
for p in list(TOP.glob('base_full-*')):
    assert p.parent.resolve()==TOP.resolve() and archive.parent.resolve()==TOP.resolve()
    retained.append(dict(name=p.name,sha256=sha(p)));p.rename(archive/p.name)
(archive/'failed-status.json').write_bytes((TOP/'status.json').read_bytes())
names=['gemma-v2-model.py','gemma-v2-experiment.py']
sources=TOP/'evaluation-sources';sources.mkdir()
for name in names:(sources/name).write_bytes((ROOT/'scripts'/name).read_bytes())
obj=dict(time=time.time(),originalPlanSha256=sha(TOP/'plan.json'),dataManifestSha256=sha(TOP/'data-manifest.json'),
    reason='The tokenizer returned a malformed tool-call object without a function key; the wrapper raised HTTP500 rather than recording a model protocol failure. Add structural validation and score malformed output as __malformed_response__. Restart every arm under the same corrected wrapper.',
    unchanged=['Training data and splits','Both completed adapters','Interface routing and translation','Prompt, sampler, budgets and scorer'],
    excludedPreflight=retained,scripts={n:sha(ROOT/'scripts'/n) for n in names})
target.write_text(json.dumps(obj,indent=2)+'\n')
print('Parser repair recorded; all model evaluations will restart. No heldout predictions existed.')
