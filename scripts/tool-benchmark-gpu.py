#!/usr/bin/env python3
"""Run both pinned Gemma models on Windows GPU and retain device telemetry."""
import argparse
import csv
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parent.parent
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--output", required=True)
parser.add_argument("--java", required=True)
parser.add_argument("--filter", default="")
parser.add_argument("--activation", choices=["default", "float16", "float32"], default="default")
parser.add_argument("--runner-jar")
args = parser.parse_args()
if platform.system() != "Windows":
    raise SystemExit("Use native Windows Python/Java for Direct3D access on this computer")
out = Path(args.output).resolve()
out.mkdir(parents=True, exist_ok=True)
java = Path(args.java).resolve()
smi = Path(os.environ.get("SystemRoot", "C:/Windows")) / "System32/nvidia-smi.exe"
if not java.is_file() or not smi.is_file():
    raise SystemExit("Java 21 and NVIDIA telemetry utility are required")
compiler = java.parent / "dxcompiler.dll"
validator = java.parent / "dxil.dll"
for dependency in (compiler, validator):
    if not dependency.is_file():
        raise SystemExit(f"Missing shader compiler dependency: {dependency.name}")
telemetry = dict(
    description="Whole-device NVIDIA samples; includes display/other apps, not per-process VRAM",
    javaSha256=hashlib.file_digest(java.open("rb"), "sha256").hexdigest(),
    shaderCompilerSha256=hashlib.file_digest(compiler.open("rb"), "sha256").hexdigest(),
    shaderValidatorSha256=hashlib.file_digest(validator.open("rb"), "sha256").hexdigest(),
    runs={},
)
device_info=subprocess.run([str(smi),"--query-gpu=name,driver_version,memory.total","--format=csv,noheader,nounits"],capture_output=True,text=True)
telemetry["deviceInfoCsv"]=device_info.stdout.strip()
telemetry["platform"]=platform.platform()
telemetry_path = out / ("gpu-telemetry.json" if args.activation == "default" else f"gpu-{args.activation}-telemetry.json")
for model in ("e4b", "e2b"):
    run_name = f"{model}-gpu" + (f"-{args.activation}" if args.activation != "default" else "")
    command = [sys.executable, "-X", "utf8", str(ROOT / "scripts/tool-benchmark.py"),
               "run", "--model", model, "--backend", "gpu", "--java", str(java),
               "--output", str(out), "--filter", args.filter, "--activation", args.activation]
    if args.runner_jar:
        command += ["--runner-jar", str(Path(args.runner_jar).resolve())]
    record = dict(startedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), samples=[])
    telemetry["runs"][run_name] = record
    process = subprocess.Popen(command, cwd=ROOT)
    while process.poll() is None:
        result = subprocess.run([str(smi),
            "--query-gpu=timestamp,name,utilization.gpu,memory.used,power.draw,temperature.gpu",
            "--format=csv,noheader,nounits"], capture_output=True, text=True)
        if result.returncode == 0:
            for fields in csv.reader(result.stdout.splitlines()):
                if len(fields) == 6:
                    record["samples"].append(dict(zip(
                        ("timestamp", "device", "gpuPercent", "deviceMemoryMiB", "powerWatts", "temperatureC"),
                        [v.strip() for v in fields])))
        telemetry_path.write_text(json.dumps(telemetry, indent=2)+"\n", encoding="utf-8")
        time.sleep(2)
    record["exitCode"] = process.returncode
    for field, label in (("gpuPercent", "peakGpuPercent"), ("deviceMemoryMiB", "peakWholeDeviceMemoryMiB")):
        values = [float(s[field]) for s in record["samples"] if s[field] != "[N/A]"]
        record[label] = max(values) if values else None
    telemetry_path.write_text(json.dumps(telemetry, indent=2)+"\n", encoding="utf-8")
    print(json.dumps({k:v for k,v in record.items() if k!="samples"}), flush=True)
    if process.returncode:
        raise SystemExit(process.returncode)
