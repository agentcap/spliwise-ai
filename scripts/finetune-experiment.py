#!/usr/bin/env python3
"""Run unchanged-base and trained-adapter comparisons sequentially on one GPU."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.request

ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('GEMMA_FINETUNE_DIR',ROOT/'.tools/finetune/gemma4-e2b-v1')).resolve()


def status(stage,**extra):
    row=dict(stage=stage,updatedAt=time.time(),**extra)
    (OUT/'experiment-status.json').write_text(json.dumps(row,indent=2)+'\n')
    print(json.dumps(row),flush=True)


def run():
    assert (OUT/'training-metrics.json').is_file(),'Finish training before evaluation'
    frozen=json.loads((OUT/'data-manifest.json').read_text())
    assert hashlib.sha256((ROOT/'benchmarks/tool-calling/cases.json').read_bytes()).hexdigest()==frozen['frozenExposedBenchmarkSha256']
    for split,expected in frozen['fileSha256'].items():
        assert hashlib.sha256((OUT/f'{split}.cases.json').read_bytes()).hexdigest()==expected
    warm=json.loads((OUT/'dev.cases.json').read_text())
    warm['cases']=warm['cases'][:1]
    (OUT/'smoke.cases.json').write_text(json.dumps(warm,indent=2)+'\n')
    sources=OUT/'reproduction-sources';sources.mkdir(exist_ok=True)
    for name in ['finetune-data.py','finetune-ledger-bridge.py','finetune-gemma.py','finetune-experiment.py','finetune-report.py','finetune-merge.py','finetune-export.py','finetune-monitor.py','tool-benchmark.py']:
        p=ROOT/'scripts'/name
        if p.exists():(sources/name).write_bytes(p.read_bytes())
    for name in ['base-native-traces.jsonl','tuned-native-traces.jsonl']:
        p=OUT/name
        if p.exists() and not (OUT/('pilot-'+name)).exists():p.rename(OUT/('pilot-'+name))
    manifests=[]
    for label in ['base','tuned']:
        log=(OUT/f'{label}-evaluation-server.log').open('w')
        cmd=[sys.executable,str(ROOT/'scripts/finetune-gemma.py'),'serve']+(['--adapter'] if label=='tuned' else [])
        status(label+'-loading')
        server=subprocess.Popen(cmd,cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
        try:
            ready=False
            for _ in range(180):
                if server.poll() is not None:raise RuntimeError('CUDA server exited; inspect '+str(OUT/f'{label}-evaluation-server.log'))
                try:
                    with urllib.request.urlopen('http://127.0.0.1:8765/health',timeout=.5) as response:
                        health=json.load(response)
                    assert health['pid']==server.pid and health['adapter']==(label=='tuned') and set(health['devices'])=={'cuda:0'},health
                    ready=True
                    break
                except OSError:time.sleep(1)
            assert ready,'CUDA server failed to start'
            for split in ['warmup','dev','heldout','exposed']:
                dataset=ROOT/'benchmarks/tool-calling/cases.json' if split=='exposed' else OUT/('smoke.cases.json' if split=='warmup' else f'{split}.cases.json')
                target=OUT/f'{label}-{split}.jsonl'
                if target.exists():raise RuntimeError('Refusing to mix trials: '+str(target))
                status(label+'-'+split,results=str(target))
                with (OUT/f'{label}-{split}.log').open('w') as runlog:
                    subprocess.run([sys.executable,str(ROOT/'scripts/finetune-ledger-bridge.py'),'run','--model','cuda','--dataset',str(dataset),'--output',str(target)],cwd=ROOT,stdout=runlog,stderr=subprocess.STDOUT,check=True)
                manifests.append(dict(model=label,split=split,datasetSha256=hashlib.sha256(dataset.read_bytes()).hexdigest(),resultsSha256=hashlib.sha256(target.read_bytes()).hexdigest()))
                (OUT/'evaluation-manifest.json').write_text(json.dumps(dict(runs=manifests,settings='greedy; 1024 new tokens; 6 tool rounds; 120s scenario limit; NF4/BF16 CUDA; thinking disabled; no speculative decoding',warmup='one fixed development scenario per model; excluded from scores and latency',limits='Cold load and compile excluded; whole request latency includes sequential tool rounds; no physical phone measurements'),indent=2)+'\n')
        finally:
            server.terminate()
            try:server.wait(timeout=20)
            except subprocess.TimeoutExpired:server.kill();server.wait()
            log.close()
    subprocess.run([sys.executable,str(ROOT/'scripts/finetune-report.py')],cwd=ROOT,check=True)
    status('complete')


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--wait-training-pid',type=int);a=p.parse_args()
    try:
        if a.wait_training_pid:
            status('waiting-for-training',trainingPid=a.wait_training_pid)
            while True:
                try:os.kill(a.wait_training_pid,0)
                except ProcessLookupError:break
                time.sleep(3)
        run()
    except Exception as e:
        status('failed',error=str(e));raise
