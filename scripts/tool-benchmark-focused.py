#!/usr/bin/env python3
"""Repeat the actual app's selected-$12 equal-split path; keep apart from full-catalog scores."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import statistics
import subprocess
import time

ROOT=Path(__file__).resolve().parent.parent
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output",required=True)
parser.add_argument("--trials",type=int,default=8)
parser.add_argument("--wait-pid",type=int)
parser.add_argument("--backend",choices=["cpu","gpu"],default="cpu")
parser.add_argument("--java")
parser.add_argument("--runner-jar")
parser.add_argument("--skip-build",action="store_true")
args=parser.parse_args()
assert 2<=args.trials<=20
out=Path(args.output).resolve()
out.mkdir(parents=True,exist_ok=True)
if args.wait_pid:
    print("Waiting for the full-catalog local benchmark to finish before using the CPU.",flush=True)
    while True:
        try:
            command=Path(f"/proc/{args.wait_pid}/cmdline").read_bytes()
            if b"com.splitwiseai.check.ModelCheckKt" not in command or b"--benchmark" not in command:
                break
        except OSError:
            break
        time.sleep(2)
if not args.skip_build:
    with (out/"build.log").open("w") as log:
        subprocess.run(["bash","scripts/android-build.sh",":model-check:installDist"],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,check=True)
java=Path(args.java).resolve() if args.java else ROOT/".tools/android/jdk21/bin/java"
classpath=str(ROOT/"android/model-check/build/install/model-check/lib/*")
if args.runner_jar:
    classpath=str(Path(args.runner_jar).resolve())+os.pathsep+classpath
env=os.environ.copy()
env["TOOL_BENCH_BACKEND"]=args.backend
results={}
models=json.loads((ROOT/"android/app/src/main/assets/models.json").read_text())
for model_id in ("e4b","e2b"):
    model=next(m for m in models if m["id"]==model_id)
    path=ROOT/".tools/android/models"/model["filename"]
    with path.open("rb") as stream:
        assert hashlib.file_digest(stream,"sha256").hexdigest()==model["sha256"]
    command=[str(java),"-Xmx1g","-cp",classpath,
             "com.splitwiseai.check.ModelCheckKt",str(ROOT),str(path),"equal",str(args.trials)]
    print(f"App equal-split path: {model_id}; {args.trials} trials",flush=True)
    with (out/f"{model_id}.log").open("w") as log:
        process=subprocess.run(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
    rows=[]
    for line in (out/f"{model_id}.log").read_text().splitlines():
        try:
            row=json.loads(line)
            if row.get("case")=="equal" and "passed" in row:
                rows.append(row)
        except (ValueError,AttributeError):
            continue
    if len(rows)!=args.trials:
        raise RuntimeError(f"Incomplete app-path trials: {model_id}")
    if any(r.get("backend","").lower()!=args.backend for r in rows):
        raise RuntimeError("Requested backend not used on every trial; inspect logs before claiming GPU timings")
    warm=rows[1:]
    results[model_id]=dict(trials=len(rows),passed=sum(r["passed"] for r in rows),
                          firstRequestSeconds=rows[0]["seconds"],
                          warmMedianSeconds=statistics.median(r["seconds"] for r in warm),
                          warmMinSeconds=min(r["seconds"] for r in warm),warmMaxSeconds=max(r["seconds"] for r in warm),
                          backend=args.backend,cpuThreads=6 if args.backend=="cpu" else None,
                          runnerSha256=hashlib.file_digest(Path(args.runner_jar).open("rb"),"sha256").hexdigest() if args.runner_jar else None,
                          exitCode=process.returncode,modelSha256=model["sha256"],rawTrials=rows)
    (out/"summary.json").write_text(json.dumps(results,indent=2)+"\n")
    print(json.dumps({k:v for k,v in results[model_id].items() if k not in ("rawTrials","modelSha256")}),flush=True)
print("Focused app-path checks complete.",flush=True)
