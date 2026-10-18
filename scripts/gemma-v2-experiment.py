#!/usr/bin/env python3
"""Frozen four-arm experiment: broad curriculum x full/reduced interface."""
import argparse
import collections
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import statistics
import subprocess
import sys
import threading
import time
import urllib.request

ROOT=Path(__file__).resolve().parent.parent
TOP=Path(os.environ.get('GEMMA_V2_DIR',ROOT/'.tools/finetune/gemma4-e2b-v2')).resolve()
PY=Path(os.environ.get('GEMMA_TRAINING_PYTHON', ROOT.parent/'gemma-4-multimodal-finetuning/.venv/bin/python'))
OLD=ROOT/'.tools/finetune/gemma4-e2b-v1'


def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(p,obj):Path(p).write_text(json.dumps(obj,indent=2)+'\n')
def rows(p):return [json.loads(s) for s in Path(p).read_text().splitlines() if s.strip()]
def status(stage,**extra):
    obj=dict(stage=stage,time=time.time(),**extra);save(TOP/'status.json',obj);print(json.dumps(obj),flush=True)


def child(script,*args,env=None,log=None):
    merged=os.environ.copy();merged['GEMMA_V2_DIR']=str(TOP)
    if env:merged.update(env)
    with (TOP/(log or script+'.log')).open('w') as f:
        subprocess.run([str(PY),str(ROOT/'scripts'/script),*map(str,args)],cwd=ROOT,env=merged,stdout=f,stderr=subprocess.STDOUT,check=True)


def setup():
    TOP.mkdir(parents=True,exist_ok=True)
    if (TOP/'data-manifest.json').exists():
        old=json.loads((TOP/'data-manifest.json').read_text())
        if old['generatorSha256']!=sha(ROOT/'scripts/gemma-v2-data.py'):
            assert not (TOP/'plan.json').exists() and not list(TOP.glob('*/training-manifest.json')),'Cannot revise data after training freeze'
            draft=TOP/'preflight-data-1';assert not draft.exists();draft.mkdir()
            # Retain the untrained candidate and failed validation for the audit.
            for p in list(TOP.iterdir()):
                if p!=draft:
                    assert p.parent.resolve()==TOP and draft.parent.resolve()==TOP
                    p.rename(draft/p.name)
    if not (TOP/'data-manifest.json').exists():child('gemma-v2-data.py',log='data.log')
    if not (TOP/'ledger-bridge.jar').exists():
        child('finetune-ledger-bridge.py','build',env={'GEMMA_FINETUNE_DIR':str(TOP)},log='bridge.log')
    for split in ('train','dev','heldout'):
        if not (TOP/f'{split}.oracle.jsonl').exists():
            status('validate-'+split)
            child('finetune-ledger-bridge.py','run','--dataset',TOP/f'{split}.cases.json','--output',TOP/f'{split}.oracle.jsonl',env={'GEMMA_FINETUNE_DIR':str(TOP)},log=f'{split}-oracle.log')
    for interface in ('full','reduced'):
        out=TOP/interface;out.mkdir(exist_ok=True)
        for name,target in [('base',OLD/'base'),('tools.json',TOP/'tools.json'),('data-manifest.json',TOP/'data-manifest.json')]:
            if not (out/name).exists():(out/name).symlink_to(target,target_is_directory=target.is_dir())
        status('prepare-'+interface)
        child('gemma-v2-model.py','prepare',env={'GEMMA_V2_INTERFACE':interface},log=interface+'-prepare.log')
    plan=dict(factors=['Broader balanced synthetic curriculum, trained from the same official base','Reduced tool interface: user-text retrieval, unit conversion, observed version bookkeeping'],
        arms=['base_full','base_reduced','tuned_full','tuned_reduced'],
        training='Two adapters, exact same semantic episodes, one epoch, rank16/alpha32, LR1e-4, effective batch8; all other CUDA training settings identical to v1.',
        selection='No checkpoint or hyperparameter selection. Fixed final epoch per interface; dev is diagnostic. Heldout scores cannot change training or routing.',
        evaluation='Same fresh held-out compositions and exposed original regression suite for all arms; one deterministic run per case; six rounds, 1024 tokens/round, 120s scenario nominal limit.',
        interfaceRouting='Fixed keyword retrieval on user messages and selected/workspace scope. No oracle, expected plan, case ID, or dataset metadata used in the model server.',
        semantics='The model chooses actions, participants, scopes, categories, and completion. The app converts USD/percent units, supplies versions from visible records, and permits omitted ID only with exactly one selected expense.',
        deployment='Experimental scripts and synthetic in-memory ledgers only. No app or deployed model changes.',
        limitations=['Both data quantity and coverage change together; this does not isolate their separate effects',
            'Reduced interface bundles selection, prompt wording and bookkeeping; individual components are not isolated',
            'Shared synthetic generator and correlated family variants limit generalization claims',
            'CUDA/NF4 results are not equivalent to Android LiteRT deployment'],
        frozenAt=time.time(),dataManifestSha256=sha(TOP/'data-manifest.json'),
        scripts={p.name:sha(p) for p in [ROOT/'scripts'/n for n in ('gemma-v2-data.py','gemma-v2-interface.py','gemma-v2-model.py','gemma-v2-experiment.py','finetune-gemma.py','finetune-ledger-bridge.py','tool-benchmark.py')]})
    snap=TOP/'sources';snap.mkdir(exist_ok=True)
    for name in plan['scripts']:(snap/name).write_bytes((ROOT/'scripts'/name).read_bytes())
    if (TOP/'plan.json').exists():
        previous=json.loads((TOP/'plan.json').read_text());assert previous['scripts']==plan['scripts'] and previous['dataManifestSha256']==plan['dataManifestSha256']
    else:save(TOP/'plan.json',plan)
    warm=json.loads((TOP/'dev.cases.json').read_text());warm['cases']=warm['cases'][:1];save(TOP/'warmup.cases.json',warm)
    status('prepared')


def verify_frozen():
    plan=json.loads((TOP/'plan.json').read_text());assert sha(TOP/'data-manifest.json')==plan['dataManifestSha256']
    expected_sources=plan['scripts'].copy()
    for number in (1,2,3):
        amendment=TOP/f'evaluation-amendment-{number}.json'
        if amendment.exists():
            change=json.loads(amendment.read_text())
            assert change['originalPlanSha256']==sha(TOP/'plan.json') and change['dataManifestSha256']==plan['dataManifestSha256']
            if number>1:assert change['previousAmendmentSha256']==sha(TOP/f'evaluation-amendment-{number-1}.json')
            assert set(change['scripts'])<={'gemma-v2-model.py','gemma-v2-experiment.py'}
            expected_sources.update(change['scripts'])
    for name,expected in expected_sources.items():assert sha(ROOT/'scripts'/name)==expected,('Source changed after freeze',name)
    data=json.loads((TOP/'data-manifest.json').read_text())
    for split,expected in data['fileSha256'].items():assert sha(TOP/f'{split}.cases.json')==expected
    assert sha(ROOT/'benchmarks/tool-calling/cases.json')==data['frozenExposedBenchmarkSha256']


def resource_monitor(stop):
    import psutil
    while not stop.wait(5):
        try:
            proc=psutil.Process();kids=proc.children(recursive=True)
            sample=dict(time=time.time(),phase=json.loads((TOP/'status.json').read_text())['stage'],
                rssMiB=sum(p.memory_info().rss for p in kids if p.is_running())/2**20,
                hostAvailableMiB=psutil.virtual_memory().available/2**20)
            r=subprocess.run(['nvidia-smi','--query-gpu=memory.used,utilization.gpu,temperature.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=3)
            values=r.stdout.strip().split(',');sample.update(gpuMiB=int(values[0]),gpuPercent=int(values[1]),gpuTemperature=int(values[2]))
            with (TOP/'resource-samples.jsonl').open('a') as f:f.write(json.dumps(sample)+'\n')
        except Exception:pass


def run():
    verify_frozen()
    stop=threading.Event();thread=threading.Thread(target=resource_monitor,args=(stop,),daemon=True);thread.start()
    try:
        for interface in ('full','reduced'):
            if not (TOP/interface/'training-metrics.json').exists():
                status('train-'+interface)
                child('gemma-v2-model.py','train',env={'GEMMA_V2_INTERFACE':interface},log=interface+'-training.log')
        for label in ('base_full','base_reduced','tuned_full','tuned_reduced'):
            adapter=label.startswith('tuned');interface=label.split('_')[1]
            env=os.environ.copy();env.update(GEMMA_V2_DIR=str(TOP),GEMMA_V2_INTERFACE=interface)
            status('load-'+label)
            with (TOP/f'{label}-server.log').open('w') as log:
                command=[str(PY),str(ROOT/'scripts/gemma-v2-model.py'),'serve']+(['--adapter'] if adapter else [])
                server=subprocess.Popen(command,cwd=ROOT,env=env,stdout=log,stderr=subprocess.STDOUT)
                try:
                    for _ in range(180):
                        if server.poll() is not None:raise RuntimeError(label+' server exited')
                        try:
                            with urllib.request.urlopen('http://127.0.0.1:8765/health',timeout=.5) as r:health=json.load(r)
                            assert health['pid']==server.pid and health['adapter']==adapter and health['interface']==interface and set(health['devices'])=={'cuda:0'}
                            break
                        except OSError:time.sleep(1)
                    else:raise RuntimeError('Server readiness timeout')
                    for split in ('warmup','dev','heldout','exposed'):
                        dataset=ROOT/'benchmarks/tool-calling/cases.json' if split=='exposed' else TOP/f'{split}.cases.json'
                        target=TOP/f'{label}-{split}.jsonl'
                        # Resume only under identical frozen source/data/model configuration.
                        verify_frozen();status(label+'-'+split,results=str(target))
                        child('finetune-ledger-bridge.py','run','--model','cuda','--dataset',dataset,'--output',target,
                            env={'GEMMA_FINETUNE_DIR':str(TOP)},log=f'{label}-{split}.log')
                finally:
                    server.terminate()
                    try:server.wait(timeout=20)
                    except subprocess.TimeoutExpired:server.kill();server.wait()
        report();status('complete')
    finally:stop.set();thread.join(timeout=6)


def report():
    spec=importlib.util.spec_from_file_location('scorer',ROOT/'scripts/tool-benchmark.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
    schemas={s['name']:s for s in json.loads((TOP/'tools.json').read_text())}
    summary={};allgrades={}
    for split in ('dev','heldout','exposed'):
        summary[split]={};allgrades[split]={}
        for label in ('base_full','base_reduced','tuned_full','tuned_reduced'):
            data=rows(TOP/f'{label}-{split}.jsonl')
            if split=='exposed':data=[r for r in data if r['caseId']!='personal-04']
            expected=140 if split=='exposed' else json.loads((TOP/'data-manifest.json').read_text())['splitCounts'][split]
            assert len(data)==len({r['caseId'] for r in data})==expected
            grades={};groups=collections.defaultdict(list);categories=collections.defaultdict(list)
            for row in data:
                grade=b.grade(row,schemas=schemas)
                if split!='exposed':
                    wanted=[x for x in row['expect']['organization'] if x.get('kind')=='context' and x.get('action')=='save']
                    actual=[x for x in row['plan']['organization'] if x.get('kind')=='context' and x.get('action')=='save']
                    for x in actual:
                        if not any(all((x.get(k) or '')==(w.get(k) or '') for k in ('personId','tripId','from','to')) for w in wanted):
                            grade['failures'].append('memory_scope');grade['passed']=False;grade['firstPass']=False
                grades[row['caseId']]=grade;groups[row['family']].append(grade);categories[row['category']].append(grade)
            allgrades[split][label]=grades
            score=dict(total=len(data),passed=sum(g['passed'] for g in grades.values()),
                medianSeconds=statistics.median(r['elapsedMs']/1000 for r in data),p95Seconds=b.percentile([r['elapsedMs']/1000 for r in data],.95),
                firstPass=sum(g['firstPass'] for g in grades.values()),rejectedCalls=sum(g['toolErrors'] for g in grades.values()),
                argumentErrorCases=sum(bool(g['argumentErrors']) for g in grades.values()),financialStateUnchanged=all(r['financialStateUnchanged'] for r in data),
                inputTokens=sum(r['inputTokens'] for r in data),outputTokens=sum(r['outputTokens'] for r in data),
                families={f:dict(passed=sum(g['passed'] for g in gs),total=len(gs)) for f,gs in groups.items()},
                categories={c:dict(passed=sum(g['passed'] for g in gs),total=len(gs)) for c,gs in categories.items()},
                failures=[dict(caseId=r['caseId'],grade=grades[r['caseId']],reply=r['reply'],error=r['error']) for r in data if not grades[r['caseId']]['passed']])
            score.update(accuracy=score['passed']/score['total'],wilson95=b.wilson(score['passed'],score['total']),familyMacroAccuracy=statistics.mean(x['passed']/x['total'] for x in score['families'].values()))
            summary[split][label]=score
        pairs={}
        for before,after in [('base_full','tuned_full'),('base_full','base_reduced'),('base_reduced','tuned_reduced'),('base_full','tuned_reduced'),('tuned_full','tuned_reduced')]:
            x=allgrades[split][before];y=allgrades[split][after];assert x.keys()==y.keys()
            pairs[before+'__'+after]=dict(improved=[i for i in x if not x[i]['passed'] and y[i]['passed']],regressed=[i for i in x if x[i]['passed'] and not y[i]['passed']],unchanged=sum(x[i]['passed']==y[i]['passed'] for i in x))
        summary[split]['paired']=pairs
    # Initial prompts must match for base vs adapter within each interface.
    for interface in ('full','reduced'):
        prompts={}
        for kind in ('base','tuned'):
            traces=rows(TOP/f'{kind}_{interface}-native-traces.jsonl')
            prompts[kind]={r['userText']:r['promptSha256'] for r in traces if r['initial']}
        assert prompts['base']==prompts['tuned'],('Initial prompts differ',interface)
    summary['training']={i:json.loads((TOP/i/'training-metrics.json').read_text()) for i in ('full','reduced')}
    summary['interfaces']={label:dict(meanInitialTools=statistics.mean(len(r['toolsExposed']) for r in rows(TOP/f'{label}-native-traces.jsonl') if r['initial']),
        peakAllocatedMiB=max(r['peakAllocatedMiB'] for r in rows(TOP/f'{label}-native-traces.jsonl'))) for label in ('base_full','base_reduced','tuned_full','tuned_reduced')}
    save(TOP/'comparison.json',summary)
    text=['# Gemma E2B: broader curriculum and reduced interface experiment','',
        'Four measured configurations share the pinned official base and CUDA/NF4 inference settings. The two adapters were trained from that base on the same semantic episodes, serialized for their respective interfaces. The app model and production Kotlin code are unchanged.','',
        '| Configuration | Fresh held-out success | Original regression success | Held-out median |',
        '| --- | ---: | ---: | ---: |']
    for label in ('base_full','base_reduced','tuned_full','tuned_reduced'):
        h=summary['heldout'][label];e=summary['exposed'][label]
        text.append(f"| {label} | {h['passed']}/{h['total']} ({h['accuracy']:.1%}) | {e['passed']}/{e['total']} ({e['accuracy']:.1%}) | {h['medianSeconds']:.2f}s |")
    text+=['','## What changed','',
        'The curriculum covers answer-only replies, clarification, scoped facts, applying versus saving templates, one-off versus recurring instructions, unsupported requests, untrusted source text, and compositional actions. Training, development, and held-out composition families and entity namespaces are disjoint. Primitive capabilities are shared intentionally.','',
        'The reduced interface retrieves tools from user text and current selection. It converts dollar and percentage inputs to ledger units, supplies versions from already visible records, and permits an omitted transaction ID only with exactly one selected expense. It never reads expected answers or oracle traces at inference. The model still chooses intent, participants, scope and completion.','',
        '## Reproduction and limits','',
        'The frozen plan, hashes, data, oracle validation, training settings, native model outputs, ledger traces, resource samples and complete paired/category/family scores are retained beside this report. Two fixed final-epoch checkpoints were evaluated; no held-out-based selection occurred. The original benchmark excludes the same inconsistent personal-04 fixture from every headline score.','',
        'This is a synthetic experiment with correlated variants and a shared generator, not a deployment reliability estimate. Data quantity and diversity change together. The reduced interface bundles tool retrieval, prompt changes and bookkeeping, so their separate effects are not identified. Argument validity, ledger acceptance, structured plans and selected answer anchors are checked; free-form prose is not fully semantically judged. CUDA/NF4 results do not establish Android LiteRT or phone performance.','']
    for split in ('heldout','exposed'):
        text += [f'## {split} details','', '| Configuration | First pass | Argument-error cases | Rejected calls | p95 |','| --- | ---: | ---: | ---: | ---: |']
        for label in ('base_full','base_reduced','tuned_full','tuned_reduced'):
            x=summary[split][label];text.append(f"| {label} | {x['firstPass']}/{x['total']} | {x['argumentErrorCases']} | {x['rejectedCalls']} | {x['p95Seconds']:.2f}s |")
        text.append('')
    for label in ('base_full','base_reduced','tuned_full','tuned_reduced'):
        text += [f'### {label}: regression categories','']
        for category,x in summary['exposed'][label]['categories'].items():text.append(f"- {category}: {x['passed']}/{x['total']}")
        text.append('')
    (TOP/'report.md').write_text('\n'.join(text));(ROOT/'docs/gemma4-experiment-v2.md').write_text('\n'.join(text))
    print(json.dumps({s:{k:{f:v[f] for f in ('passed','total','medianSeconds')} for k,v in summary[s].items() if k!='paired'} for s in ('dev','heldout','exposed')},indent=2),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['setup','run','report']);a=p.parse_args()
    try:
        if a.action=='setup':setup()
        elif a.action=='run':run()
        else:report()
    except Exception as e:
        if TOP.exists():status('failed',error=str(e))
        raise
