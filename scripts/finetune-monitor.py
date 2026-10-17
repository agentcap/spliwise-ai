#!/usr/bin/env python3
"""Sample whole-device GPU and experiment-process CPU memory during this run."""
import json
import os
from pathlib import Path
import subprocess
import time
import psutil

ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('GEMMA_FINETUNE_DIR',ROOT/'.tools/finetune/gemma4-e2b-v1')).resolve()

with (OUT/'resource-samples.jsonl').open('a',buffering=1) as dest:
    while True:
        state=json.loads((OUT/'experiment-status.json').read_text())
        if state['stage'] in ('complete','failed'):break
        data=dict(time=time.time(),phase=state['stage'],processes=[])
        for p in psutil.process_iter(['pid','cmdline','memory_info']):
            try:
                if any(str(s).endswith('finetune-gemma.py') for s in p.info['cmdline'] or []):
                    data['processes'].append(dict(pid=p.pid,rssMiB=p.info['memory_info'].rss/2**20))
            except (psutil.NoSuchProcess,psutil.AccessDenied):pass
        smi=subprocess.run(['nvidia-smi','--query-gpu=memory.used,utilization.gpu,power.draw,temperature.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True)
        if smi.returncode==0:
            values=smi.stdout.strip().split(',')
            if len(values)==4:data.update(dict(zip(['wholeDeviceMiB','gpuPercent','powerWatts','temperatureC'],[float(x.strip()) for x in values])))
        data['availableHostMiB']=psutil.virtual_memory().available/2**20
        dest.write(json.dumps(data)+'\n')
        time.sleep(5)
