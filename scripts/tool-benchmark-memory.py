#!/usr/bin/env python3
"""Observe Linux RSS high-water marks for this benchmark's local JVMs only.

VmHWM covers each process's lifetime, including time before this observer starts.
These are desktop process measurements, not Android RAM requirements.
"""
import argparse
import json
from pathlib import Path
import time

parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output",required=True)
parser.add_argument("--dataset",default=str(Path(__file__).resolve().parent.parent/"benchmarks/tool-calling/cases.json"))
args=parser.parse_args()
directory=Path(args.output).resolve()
target=directory/"memory.json"
observations=json.loads(target.read_text()) if target.exists() else {}
expected_count=len(json.loads(Path(args.dataset).read_text())["cases"])
while True:
    active=False
    for path in Path("/proc").iterdir():
        if not path.name.isdigit():
            continue
        try:
            command=(path/"cmdline").read_bytes().decode().split("\0")
            if "com.splitwiseai.check.ModelCheckKt" not in command or "--benchmark" not in command:
                continue
            start=command.index("--benchmark")
            model=command[start+3]
            if model not in ("e4b","e2b") or Path(command[start+4]).resolve().parent!=directory:
                continue
            active=True
            status=dict(line.split(":",1) for line in (path/"status").read_text().splitlines() if ":" in line)
            peak=int(status["VmHWM"].split()[0])*1024
            rss=int(status["VmRSS"].split()[0])*1024
            record=observations.setdefault(model,dict(processIds=[],peakRssBytes=0,observations=0))
            if int(path.name) not in record["processIds"]:
                record["processIds"].append(int(path.name))
            record.update(peakRssBytes=max(record["peakRssBytes"],peak),lastRssBytes=rss,
                          observations=record["observations"]+1,lastObservedUtc=time.strftime("%Y-%m-%dT%H:%M:%SZ",time.gmtime()),
                          source="Linux /proc VmHWM; process lifetime high-water RSS; desktop JVM CPU only")
        except (OSError,ValueError,KeyError,IndexError,UnicodeError):
            continue
    temporary=directory/"memory.json.tmp"
    temporary.write_text(json.dumps(observations,indent=2)+"\n")
    temporary.replace(target)
    counts={model:sum(bool(line.strip()) for line in (directory/f"{model}.jsonl").read_text().splitlines())
            if (directory/f"{model}.jsonl").exists() else 0 for model in ("e4b","e2b")}
    if not active and all(n>=expected_count for n in counts.values()):
        print(json.dumps(observations,indent=2),flush=True)
        break
    time.sleep(2)
