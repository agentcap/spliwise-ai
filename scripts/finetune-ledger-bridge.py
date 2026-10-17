#!/usr/bin/env python3
"""Build an isolated copy of the production benchmark with a loopback CUDA backend.

The original Kotlin sources, frozen cases, and retained runner JARs are never edited.
The bridge runs only synthetic SQLite :memory: fixtures.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent
OUT = Path(os.environ.get('GEMMA_FINETUNE_DIR',ROOT / '.tools/finetune/gemma4-e2b-v1')).resolve()


def build():
    OUT.mkdir(parents=True, exist_ok=True)
    original = ROOT / 'android/model-check/src/main/kotlin/com/splitwiseai/check/ToolBenchmark.kt'
    text = original.read_text()
    # Only the local copy uses HTTP. No credential or paid API is needed.
    text = text.replace('requireNotNull(System.getenv("OPENAI_API_KEY")) { "OPENAI_API_KEY required" }', '"loopback-only"')
    text = text.replace('https://api.openai.com/v1/responses', 'http://127.0.0.1:8765/v1/responses')
    text = text.replace('"gpt-6-luna"', '"cuda"')
    text = text.replace('"loadMs" to (native?.loadMs ?: 0),', '"loadMs" to (native?.loadMs ?: 0),\n                    "workspaceSummary" to initialSummary,')
    text = text.replace('val initialTransactions =', 'val initialSummary = summary(f)\n            val initialTransactions =')
    # All generated cases choose disjoint entity handles. Existing cases keep defaults.
    text = text.replace('listOf("alex", "zara", "sam").forEach {', '(if (case.has("people")) case.a("people").map { it.asString } else listOf("alex", "zara", "sam")).forEach {')
    text = text.replace('ids.getValue("$" + "alex")', 'ids.getValue("$" + (if (case.has("people")) case.a("people")[0].asString else "alex"))')
    oracle_start=text.index('val response =\n                            dispatcher.dispatchTool(')
    oracle_end=text.index('\n                        trace +=',oracle_start)
    original_dispatch=text[oracle_start:oracle_end]
    text=text[:oracle_start]+original_dispatch.replace('val response =\n                            dispatcher.dispatchTool(', 'val response = try {\n                            dispatcher.dispatchTool(')+'\n                        } catch (e: Exception) { obj("error" to (e.message ?: "rejected")) }'+text[oracle_end:]
    # Preserve independent initial workspace context in oracle exports.
    source = OUT / 'ToolBenchmark.kt'
    source.write_text(text)
    main = OUT / 'BridgeMain.kt'
    main.write_text('package com.splitwiseai.check\nfun main(args: Array<String>) { benchmarkMain(args) }\n')
    cache = ROOT / '.tools/android/gradle-home/caches/modules-2/files-2.1'
    compiler = next(cache.glob('org.jetbrains.kotlin/kotlin-compiler-embeddable/2.4.0/*/*.jar'))
    compiler_deps = []
    for group, module in [('org.jetbrains.kotlin','kotlin-stdlib'), ('org.jetbrains.kotlin','kotlin-script-runtime'), ('org.jetbrains.kotlin','kotlin-reflect'), ('org.jetbrains.kotlin','kotlin-daemon-embeddable'), ('org.jetbrains.intellij.deps','trove4j'), ('org.jetbrains','annotations'), ('org.jetbrains.kotlinx','kotlinx-coroutines-core-jvm')]:
        compiler_deps.extend((cache/group/module).glob('*/*/*.jar'))
    libs = list((ROOT/'android/model-check/build/install/model-check/lib').glob('*.jar'))
    jar = OUT/'ledger-bridge.jar'
    command = [str(ROOT/'.tools/android/jdk21/bin/java'), '-Xmx1g', '-cp', os.pathsep.join(map(str,[compiler]+compiler_deps)), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target','17','-classpath',os.pathsep.join(map(str,libs)),str(source),str(main),'-d',str(jar)]
    subprocess.run(command,check=True,cwd=ROOT)
    manifest = {'originalSourceSha256':hashlib.sha256(original.read_bytes()).hexdigest(),'bridgeSourceSha256':hashlib.sha256(source.read_bytes()).hexdigest(),'jarSha256':hashlib.sha256(jar.read_bytes()).hexdigest(),'changes':['loopback inference transport','export initial summary','configurable synthetic people'],'financialRecords':'synthetic in-memory fixtures only'}
    (OUT/'bridge-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')


def run(dataset, model, output):
    libs=ROOT/'android/model-check/build/install/model-check/lib'
    env=os.environ.copy()
    env.update(TOOL_BENCH_REASONING='none',TOOL_BENCH_MAX_OUTPUT='1024')
    subprocess.run([str(ROOT/'.tools/android/jdk21/bin/java'),'-Xmx512m','-cp',str(OUT/'ledger-bridge.jar')+os.pathsep+str(libs/'*'),'com.splitwiseai.check.BridgeMainKt',str(ROOT),str(Path(dataset).resolve()),model,str(Path(output).resolve()),''],env=env,cwd=ROOT,check=True)


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['build','run'])
    p.add_argument('--dataset');p.add_argument('--model',default='oracle',choices=['oracle','cuda']);p.add_argument('--output')
    a=p.parse_args()
    if a.action=='build':build()
    else:run(a.dataset,a.model,a.output)
