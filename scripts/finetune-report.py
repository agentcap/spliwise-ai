#!/usr/bin/env python3
"""Score paired CUDA results with the retained production benchmark scorer."""
import collections
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import statistics
import zipfile

ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('GEMMA_FINETUNE_DIR',ROOT/'.tools/finetune/gemma4-e2b-v1')).resolve()
sp=importlib.util.spec_from_file_location('benchmark',ROOT/'scripts/tool-benchmark.py');b=importlib.util.module_from_spec(sp);sp.loader.exec_module(b)
SCHEMAS={s['name']:s for s in json.loads((OUT/'tools.json').read_text())}


def rows(path):return [json.loads(l) for l in Path(path).read_text().splitlines() if l.strip()]
def score(path,exposed=False):
    data=rows(path)
    # The fixed public audit excludes the inconsistent personal-04 fixture equally.
    if exposed:data=[r for r in data if r['caseId']!='personal-04']
    grades={r['caseId']:b.grade(r,schemas=SCHEMAS) for r in data}
    # Frozen new-case expectations omit scopes that the user did not request.
    # Apply this additional check equally to base/tuned; preserve the existing
    # exposed benchmark's published rubric exactly.
    if not exposed:
        for row in data:
            expected=[o for o in row['expect']['organization'] if o.get('kind')=='context' and o.get('action')=='save']
            for item in row['plan']['organization']:
                if item.get('kind')=='context' and item.get('action')=='save':
                    if not any(all((item.get(k) or '')==(want.get(k) or '') for k in ('personId','tripId','from','to')) for want in expected):
                        grades[row['caseId']]['failures'].append('memory_scope')
                        grades[row['caseId']]['passed']=False;grades[row['caseId']]['firstPass']=False
    group=collections.defaultdict(list);fail=collections.Counter()
    for r in data:
        g=grades[r['caseId']];group[r['family']].append(g);fail.update(g['failures'])
    bycat={}
    for cat in sorted({r['category'] for r in data}):
        gs=[grades[r['caseId']] for r in data if r['category']==cat];bycat[cat]=dict(passed=sum(g['passed'] for g in gs),total=len(gs))
    passed=sum(g['passed'] for g in grades.values())
    return dict(total=len(data),passed=passed,accuracy=passed/len(data),wilson95=b.wilson(passed,len(data)),firstPass=sum(g['firstPass'] for g in grades.values()),casesWithArgumentErrors=sum(bool(g['argumentErrors']) for g in grades.values()),argumentErrorCount=sum(len(g['argumentErrors']) for g in grades.values()),rejectedToolCalls=sum(g['toolErrors'] for g in grades.values()),unparsedControlCases=sum(g['unparsedControlResponse'] for g in grades.values()),medianSeconds=statistics.median(r['elapsedMs']/1000 for r in data),p95Seconds=b.percentile([r['elapsedMs']/1000 for r in data],.95),meanSeconds=statistics.mean(r['elapsedMs']/1000 for r in data),inputTokens=sum(r['inputTokens'] for r in data),outputTokens=sum(r['outputTokens'] for r in data),financialStateUnchanged=all(r['financialStateUnchanged'] for r in data),familyMacroAccuracy=statistics.mean(sum(g['passed'] for g in gs)/len(gs) for gs in group.values()),failureCounts=dict(fail),categories=bycat,families={f:dict(passed=sum(g['passed'] for g in gs),total=len(gs)) for f,gs in group.items()},failures=[dict(caseId=r['caseId'],family=r['family'],grade=grades[r['caseId']],reply=r.get('reply'),error=r.get('error')) for r in data if not grades[r['caseId']]['passed']],grades=grades)


def main():
    summary={s:{m:score(OUT/f'{m}-{s}.jsonl',s=='exposed') for m in ['base','tuned']} for s in ['dev','heldout','exposed']}
    for split,models in summary.items():
        base=models['base'];tuned=models['tuned']
        dataset=ROOT/'benchmarks/tool-calling/cases.json' if split=='exposed' else OUT/f'{split}.cases.json'
        expected=len(json.loads(dataset.read_text())['cases'])-(1 if split=='exposed' else 0)
        assert base['total']==tuned['total']==expected,(split,base['total'],tuned['total'],expected)
        ids=set(base['grades']);assert ids==set(tuned['grades'])
        models['paired']=dict(improved=[i for i in sorted(ids) if not base['grades'][i]['passed'] and tuned['grades'][i]['passed']],regressed=[i for i in sorted(ids) if base['grades'][i]['passed'] and not tuned['grades'][i]['passed']],unchanged=sum(base['grades'][i]['passed']==tuned['grades'][i]['passed'] for i in ids))
        for m in ('base','tuned'):del models[m]['grades']
    metadata={m:json.loads((OUT/f'{m}-inference-manifest.json').read_text()) for m in ('base','tuned')}
    for k in ('officialWeightsSha256','configSha256','tokenizerSha256','chatTemplateSha256','attentionImplementation','backend','quantization','sampler','versions','canonicalSyntheticIds','canonicalFixtureTimestamps','scriptSha256','policySha256','toolsSha256'):
        assert metadata['base'][k]==metadata['tuned'][k],f'Inference configuration differs: {k}'
    prompts={}
    for model in ('base','tuned'):
        native=iter(rows(OUT/f'{model}-native-traces.jsonl'));prompts[model]={}
        for split in ('warmup','dev','heldout','exposed'):
            for row in rows(OUT/f'{model}-{split}.jsonl'):
                turns=[next(native) for _ in range(row['rounds'])]
                if turns:prompts[model][row['caseId']]=turns[0]['promptSha256']
    assert prompts['base']==prompts['tuned'],'Base and tuned initial model prompts differ'
    summary['matchedInitialPrompts']=len(prompts['base'])
    metrics=json.loads((OUT/'training-metrics.json').read_text())
    manifest=json.loads((OUT/'training-manifest.json').read_text())
    summary['training']=metrics
    summary['scoring']=dict(sharedScorerSha256=hashlib.sha256((ROOT/'scripts/tool-benchmark.py').read_bytes()).hexdigest(),reportScorerSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    (OUT/'reproduction-sources'/Path(__file__).name).write_bytes(Path(__file__).read_bytes())
    summary['inference']={m:dict(backend=metadata[m]['backend'],gpu=metadata[m]['gpu'],peakAllocatedMiB=max(r['peakAllocatedMiB'] for r in rows(OUT/f'{m}-native-traces.jsonl'))) for m in metadata}
    if (OUT/'resource-samples.jsonl').exists():
        samples=rows(OUT/'resource-samples.jsonl')
        for m in ('base','tuned'):
            batch=[r for r in samples if r['phase'].startswith(m+'-')]
            summary['inference'][m].update(resourceSamples=len(batch),peakWholeDeviceMiB=max((r.get('wholeDeviceMiB',0) for r in batch),default=0),peakProcessRssMiB=max((sum(p['rssMiB'] for p in r['processes']) for r in batch),default=0),peakGpuPercent=max((r.get('gpuPercent',0) for r in batch),default=0))
    (OUT/'comparison.json').write_text(json.dumps(summary,indent=2)+'\n')
    lines=['# Gemma 4 E2B Splitwise tool-calling fine-tuning','',
      'Training succeeded, but this adapter should remain experimental. It learned the training-family workflows strongly while transferring little to new compositions, increased request latency, and regressed on safety cases. The three additional held-out successes all came from the mixed-receipt allocation family; the other seven held-out families had unchanged completion counts.','',
      'The adapter was trained locally on the RTX 4070 using the pinned official `google/gemma-4-E2B-it` checkpoint. All measurements below compare the unchanged checkpoint and adapter with identical CUDA inference settings. The existing LiteRT/WebGPU scores use another runtime and quantization and are not a causal training comparison.','',
      '| Evaluation | Base | Tuned | Gain | Base median | Tuned median |',
      '| --- | ---: | ---: | ---: | ---: | ---: |']
    labels={'dev':'Development (familiar families)','heldout':'New held-out compositions','exposed':'Exposed regression benchmark'}
    for s in ('dev','heldout','exposed'):
        x=summary[s]['base'];y=summary[s]['tuned'];lines.append(f"| {labels[s]} | {x['passed']}/{x['total']} ({x['accuracy']:.1%}) | {y['passed']}/{y['total']} ({y['accuracy']:.1%}) | {(y['accuracy']-x['accuracy'])*100:+.1f} pp | {x['medianSeconds']:.3f}s | {y['medianSeconds']:.3f}s |")
    lines+=['','## Protocol, latency, and resources','', '| Evaluation / model | First pass | Argument-error cases | Rejected calls | Unparsed finish | p95 request |','| --- | ---: | ---: | ---: | ---: | ---: |']
    for s in ('heldout','exposed'):
        for m in ('base','tuned'):
            x=summary[s][m];lines.append(f"| {s} / {m} | {x['firstPass']}/{x['total']} | {x['casesWithArgumentErrors']} | {x['rejectedToolCalls']} | {x['unparsedControlCases']} | {x['p95Seconds']:.3f}s |")
    lines+=['',f"Final training run: {metrics['finalStep']} optimizer steps, one epoch over 600 episodes, {metrics['elapsedSeconds']/60:.1f} minutes; mean training loss {metrics['train_loss']:.4f}; peak allocated CUDA memory {metrics['peakAllocatedMiB']:.0f} MiB, reserved {metrics['peakReservedMiB']:.0f} MiB. Rank 16 / alpha 32 QLoRA, NF4 double quantization, BF16 compute, learning rate 0.0001, effective batch 8, seed 27031. Prompts, tool-result bodies and deliberately rejected calls have no loss target. An initial memory failure and a discarded data-audit pilot are retained separately and excluded from these final-run metrics.", '',
      'Inference: WSL2 CUDA / PyTorch / Unsloth / bitsandbytes, SDPA, greedy decoding, thinking off, no speculative decoding, 1,024 output tokens per turn, six rounds, nominal 120-second scenario limit. A development warm-up is excluded. Request latency includes all tool rounds and in-memory ledger validation; engine load is excluded. Input is recomputed for each round. Allocated memory excludes display/other apps. No phone latency, energy, or sustained thermal measurements exist.','']
    for m,x in summary['inference'].items():lines.append(f"- {m.capitalize()} inference peak allocated memory: {x['peakAllocatedMiB']:.0f} MiB; sampled whole-device memory {x.get('peakWholeDeviceMiB',0):.0f} MiB; sampled model-process host RSS {x.get('peakProcessRssMiB',0):.0f} MiB.")
    lines+=['','## Data and evaluation safeguards','',
      '600 training episodes, 25 compositional families; 50 development episodes; 80 held-out episodes across eight separate compositions. The held-out set uses different participant handles, merchant namespace, destinations and amount ranges. All 730 oracle traces pass the production ledger and required-field/type checks. The same 16-tool catalog and policy are shared intentionally. Training has no exact prompts or eight-word prompt overlaps with the frozen 141-case benchmark; the curriculum was written independently, without importing its cases or answers. Short shared tool instructions are unavoidable; lexical audit alone is not proof against semantic overlap.','',
      'The held-out set was saved and hashed before training. Hyperparameters were fixed before scored evaluation; development and held-out scores were not used to select a checkpoint. This is one deterministic run per scenario, using synthetic template-based tasks, not an estimate of deployment reliability. Family variants are correlated. Wilson intervals and family macro scores are in comparison.json. Scoring checks expected structured plans, selected answer anchors, required fields and dispatcher acceptance; it is not a general semantic judge of every free-form reply or fact body. The exposed benchmark excludes personal-04 equally, retaining 140 headline cases. Real financial records are never read or mutated.','',
      '## Category changes on the exposed benchmark','', '| Category | Base | Tuned |','| --- | ---: | ---: |']
    for cat,x in summary['exposed']['base']['categories'].items():
        y=summary['exposed']['tuned']['categories'][cat];lines.append(f"| {cat} | {x['passed']}/{x['total']} | {y['passed']}/{y['total']} |")
    lines+=['','## What improved and what failed','',
      'Argument-error cases fell from 42 to 14 on held-out tasks and from 44 to 19 on exposed regression tasks; unparsed exposed finish responses fell from 16 to zero. Rules and splits improved on the exposed suite. However, safety completion fell from 11/12 to 6/12, and the exposed paired comparison contains 20 regressions. Rejected calls increased because some failures repeated until the six-turn limit.','',
      '- Trip-scoped facts often acquire an unrequested person scope.',
      '- Applying a saved template can incorrectly save another template.',
      '- Answer-only requests can invent `workspace_summary` or repeat a `changes_prepared` finish despite no staged action. The final curriculum contains no successful answer-only finish targets, which is a concrete coverage gap.',
      '- Merchant scope, trip handling, missing context, and unsupported requests remain unreliable. Raw traces retain the exact calls and dispatcher rejections.','',
      'The prior unchanged LiteRT E2B FLOAT32 configuration scored 90/140, versus 72/140 for this tuned CUDA/NF4 configuration. Runtime and quantization differ, so these numbers cannot isolate a training effect across those configurations. They do establish that this experiment has not supplied a better measured replacement for the existing app configuration.','',
      '## Paired changes and remaining failures','']
    for s in ('heldout','exposed'):
        p=summary[s]['paired'];lines+=[f"{s}: {len(p['improved'])} improved, {len(p['regressed'])} regressed, {p['unchanged']} unchanged. Remaining tuned failures:",'']
        for f in summary[s]['tuned']['failures'][:8]:lines.append(f"- `{f['caseId']}`: {', '.join(f['grade']['failures'])}; {f['error'] or f['reply'][:160]}")
        if len(summary[s]['tuned']['failures'])>8:lines.append('All remaining failures, paired case IDs and category/family scores are retained in `comparison.json`.')
        lines.append('')
    lines+=['## Artifacts and reproduction','',
      '- Adapter: `.tools/finetune/gemma4-e2b-v1/adapter/` (PEFT safetensors, configuration and tokenizer).',
      '- Frozen splits, masks, validation, native outputs, ledger traces, dependency/model hashes, training settings and loss history: same experiment directory.',
      '- Reproduction instructions: `finetuning/gemma4-e2b/README.md`. Source snapshots and adapter checksums are retained.',
      '- Android/export feasibility: `finetuning/gemma4-e2b/deployment.md`. A trained PEFT adapter is not a loadable `.litertlm` file. No Android/phone readiness is claimed.','']
    text='\n'.join(lines)
    (OUT/'report.md').write_text(text)
    dest=ROOT/'docs/gemma4-finetuning.md';dest.write_text(text)
    package=OUT/'splitwise-gemma4-e2b-tool-adapter.zip'
    with zipfile.ZipFile(package,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=4) as archive:
        for p in sorted((OUT/'adapter').iterdir()):
            if p.is_file():archive.write(p,'adapter/'+p.name)
        for name in ('training-manifest.json','training-metrics.json','data-manifest.json','validation.json','comparison.json','report.md','training-source.py'):
            archive.write(OUT/name,name)
        archive.write(ROOT/'finetuning/gemma4-e2b/README.md','REPRODUCE.md')
        archive.write(ROOT/'finetuning/gemma4-e2b/requirements.txt','requirements.txt')
    (OUT/'package-manifest.json').write_text(json.dumps(dict(path=str(package),bytes=package.stat().st_size,sha256=hashlib.file_digest(package.open('rb'),'sha256').hexdigest(),contents='PEFT adapter, tokenizer, reproduction instructions, settings and measured report; base checkpoint excluded',relocation='Load the pinned official base explicitly before PeftModel.from_pretrained; the retained adapter configuration references its local base directory'),indent=2)+'\n')
    print(json.dumps({s:{m:{k:summary[s][m][k] for k in ('passed','total','accuracy','medianSeconds')} for m in ('base','tuned')} for s in ('dev','heldout','exposed')},indent=2))


if __name__=='__main__':main()
