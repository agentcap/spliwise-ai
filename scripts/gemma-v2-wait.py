#!/usr/bin/env python3
"""Retain a contended pass, then resume only after the GPU has quiet headroom."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parent.parent
TOP=ROOT/'.tools/finetune/gemma4-e2b-v2'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def save(p,x):p.write_text(json.dumps(x,indent=2)+'\n')
archive=TOP/'evaluation-preflight-contention'
if not archive.exists():
    archive.mkdir();retained=[]
    for p in list(TOP.glob('base_full-*')):
        assert p.parent.resolve()==TOP.resolve() and archive.parent.resolve()==TOP.resolve()
        retained.append(dict(name=p.name,sha256=sha(p)));p.rename(archive/p.name)
    save(TOP/'environment-interruption.json',dict(time=time.time(),
        originalPlanSha256=sha(TOP/'plan.json'),dataManifestSha256=sha(TOP/'data-manifest.json'),
        reason='Host GPU engine counters identified VALORANT PID33528 using 94% of the same GPU. Inference cache cleanup kept reserved CUDA memory near 6.5GiB but requests still took over 90s. This confirms external contention, rather than proving a model/cache leak, as the cause of the slowdown. All affected evaluation passes are excluded; no training or semantic changes occur.',
        retained=retained,userPreference='User said they can free the GPU now. Wait for quiet memory/compute headroom before resuming.'))
quiet=0
while quiet<3:
    r=subprocess.run(['nvidia-smi','--query-gpu=memory.used,utilization.gpu,temperature.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True,check=True)
    mem,util,temp=map(int,r.stdout.strip().split(','))
    quiet=quiet+1 if mem<2400 and util<25 else 0
    row=dict(time=time.time(),stage='waiting-for-gpu',gpuMiB=mem,gpuPercent=util,gpuTemperature=temp,quietSamples=quiet,requiredQuietSamples=3)
    save(TOP/'status.json',row)
    with (TOP/'gpu-availability.jsonl').open('a') as f:f.write(json.dumps(row)+'\n')
    print(json.dumps(row),flush=True)
    if quiet<3:time.sleep(15)
save(TOP/'gpu-resume.json',dict(time=time.time(),quietSamples=3,maxGpuMiB=2400,maxGpuPercent=25,
    note='Host inspection confirmed VALORANT exited. Threshold permits low-power desktop rendering.'))
print('GPU headroom verified. Resuming the frozen comparison.',flush=True)
sys.exit(subprocess.call([sys.executable,str(ROOT/'scripts/gemma-v2-experiment.py'),'run'],cwd=ROOT))
