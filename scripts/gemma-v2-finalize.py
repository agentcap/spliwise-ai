#!/usr/bin/env python3
"""Independently audit completed results and package the measured adapters."""
import array
import collections
import hashlib
import importlib.util
import json
import math
import re
from pathlib import Path
import statistics
import struct
import sys
import time
import zipfile

ROOT=Path(__file__).resolve().parent.parent
TOP=ROOT/'.tools/finetune/gemma4-e2b-v2'
LABELS=('base_full','base_reduced','tuned_full','tuned_reduced')
SPLITS=('dev','heldout','exposed')


def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))
def rows(p):return [json.loads(s) for s in Path(p).read_text(encoding='utf-8').splitlines() if s.strip()]
def sha(p):
    with Path(p).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def save(p,v):Path(p).write_text(json.dumps(v,indent=2)+'\n',encoding='utf-8')


def adapter_check(interface):
    folder=TOP/interface;manifest=read(folder/'training-manifest.json')
    for name,expected in manifest['adapterFiles'].items():assert sha(folder/'adapter'/name)==expected,(interface,name)
    config=read(folder/'adapter/adapter_config.json');assert config['r']==16 and config['lora_alpha']==32
    p=folder/'adapter/adapter_model.safetensors'
    with p.open('rb') as f:
        n=struct.unpack('<Q',f.read(8))[0];header=json.loads(f.read(n));start=8+n
        tensors=0;count=0;nonzero_b=0;spans=[];unused_b=[]
        for name,desc in header.items():
            if name=='__metadata__':continue
            begin,end=desc['data_offsets'];spans.append((begin,end));size=math.prod(desc['shape']);dtype=desc['dtype']
            width={'F32':4,'BF16':2,'F16':2}[dtype];assert end-begin==size*width
            f.seek(start+begin);data=f.read(end-begin);assert len(data)==end-begin
            bits=array.array('I' if width==4 else 'H');bits.frombytes(data)
            if sys.byteorder!='little':bits.byteswap()
            exponent={'F32':0x7f800000,'BF16':0x7f80,'F16':0x7c00}[dtype]
            assert all(v&exponent!=exponent for v in bits),(interface,name,'Nonfinite tensor')
            if '.lora_B.' in name:
                signless=0x7fffffff if width==4 else 0x7fff
                if any(v&signless for v in bits):nonzero_b+=1
                else:unused_b.append(name)
            tensors+=1;count+=size
        spans.sort();assert spans[0][0]==0 and all(a[1]==b[0] for a,b in zip(spans,spans[1:]))
        assert start+spans[-1][1]==p.stat().st_size
    # Last 20 of 35 layers reuse earlier K/V, so their own K/V projections
    # receive no gradient. Every other B matrix must have a learned delta.
    cfg=read(ROOT/'.tools/finetune/gemma4-e2b-v1/base/config.json')['text_config']
    first_shared=cfg['num_hidden_layers']-cfg['num_kv_shared_layers']
    for name in unused_b:
        match=re.search(r'\.layers\.(\d+)\.self_attn\.[kv]_proj\.lora_B\.weight$',name)
        assert match and first_shared<=int(match.group(1))<cfg['num_hidden_layers'],(interface,name,'Unexpected zero B matrix')
    assert tensors==490 and nonzero_b==205 and len(unused_b)==40 and count==25337856
    metrics=read(folder/'training-metrics.json');assert metrics['finalStep']==310
    return dict(sha256=sha(p),bytes=p.stat().st_size,tensors=tensors,nonzeroBMatrices=nonzero_b,unusedKvSharingBMatrices=unused_b,parameters=count,allFinite=True,allSavedFilesHashMatched=True)


def audit():
    assert read(TOP/'status.json')['stage']=='complete'
    data=read(TOP/'data-manifest.json');plan=read(TOP/'plan.json')
    assert sha(TOP/'data-manifest.json')==plan['dataManifestSha256']
    expected=plan['scripts'].copy()
    for number in (1,2,3):
        amendment=read(TOP/f'evaluation-amendment-{number}.json')
        assert amendment['originalPlanSha256']==sha(TOP/'plan.json')
        assert amendment['dataManifestSha256']==sha(TOP/'data-manifest.json')
        if number>1:assert amendment['previousAmendmentSha256']==sha(TOP/f'evaluation-amendment-{number-1}.json')
        expected.update(amendment['scripts'])
    for name,h in expected.items():assert sha(ROOT/'scripts'/name)==h,name
    assert sha(ROOT/'benchmarks/tool-calling/cases.json')==data['frozenExposedBenchmarkSha256']
    families={};entities={}
    for split,h in data['fileSha256'].items():
        p=TOP/f'{split}.cases.json';assert sha(p)==h
        cases=read(p)['cases'];assert len(cases)==data['splitCounts'][split]
        families[split]={frozenset(c['atoms']) for c in cases};entities[split]={n for c in cases for n in c['people']}
        for interface in ('full','reduced'):
            validation=read(TOP/interface/'validation.json')
            assert not validation['missingRoutedOracleTools'] and not validation['roundtripFailures']
            assert sha(TOP/interface/f'{split}.tokenized.json')==validation[split]['sha256']
    for a,b in (('train','dev'),('train','heldout'),('dev','heldout')):
        assert not families[a]&families[b] and not entities[a]&entities[b]
    schemas={s['name']:s for s in read(TOP/'tools.json')}
    spec=importlib.util.spec_from_file_location('shared_scorer',ROOT/'scripts/tool-benchmark.py')
    scorer=importlib.util.module_from_spec(spec);spec.loader.exec_module(scorer)
    comparison=read(TOP/'comparison.json');results={};prompts={};traces={};inference={};grades={}
    for label in LABELS:
        inference[label]=read(TOP/f'{label}-inference-manifest.json')
        assert set(inference[label]['devices'])=={'cuda:0'}
        native=rows(TOP/f'{label}-native-traces.jsonl');traces[label]=native;iterator=iter(native);prompts[label]={};results[label]={};grades[label]={}
        for split in ('warmup',)+SPLITS:
            batch=rows(TOP/f'{label}-{split}.jsonl')
            expected_count=1 if split=='warmup' else 141 if split=='exposed' else data['splitCounts'][split]
            assert len(batch)==len({r['caseId'] for r in batch})==expected_count
            if split!='warmup':grades[label][split]={}
            for row in batch:
                err=(row.get('error') or '').lower()
                assert not any(s in err for s in ('header parser','http/1.1','request timed out','connection reset','openai http 5','cuda out of memory')),(label,row['caseId'],err)
                assert row['financialStateUnchanged'] and row['modelInvoked'] and row['rounds']>=1
                turns=[next(iterator) for _ in range(row['rounds'])]
                assert turns[0]['initial'] and all(not t['initial'] for t in turns[1:])
                prompts[label][split+':'+row['caseId']]=turns[0]['promptSha256']
                if split=='warmup' or (split=='exposed' and row['caseId']=='personal-04'):continue
                grade=scorer.grade(row,schemas=schemas)
                if split!='exposed':
                    wanted=[x for x in row['expect']['organization'] if x.get('kind')=='context' and x.get('action')=='save']
                    for x in row['plan']['organization']:
                        if x.get('kind')=='context' and x.get('action')=='save' and not any(all((x.get(k) or '')==(w.get(k) or '') for k in ('personId','tripId','from','to')) for w in wanted):
                            grade['passed']=False;grade['firstPass']=False;grade['failures'].append('memory_scope')
                grades[label][split][row['caseId']]=grade
            assert split=='warmup' or sum(g['passed'] for g in grades[label][split].values())==comparison[split][label]['passed']
            results[label][split]=dict(rows=len(batch),sha256=sha(TOP/f'{label}-{split}.jsonl'))
        assert next(iterator,None) is None,'Unattributed native generations'
    common=('model','revision','officialWeightsSha256','configSha256','tokenizerSha256','backend','gpu','cudaRuntime','quantization','versions','chatTemplateSha256','attentionImplementation','sampler','scriptSha256','interfaceSha256','memoryPolicy')
    for label in LABELS[1:]:
        for key in common:assert inference[label][key]==inference['base_full'][key],(label,key)
    for interface in ('full','reduced'):
        assert prompts['base_'+interface]==prompts['tuned_'+interface]
        assert len(prompts['base_'+interface])==334
    # Contract/dataset hashes must match across all arms for every case.
    for split in SPLITS:
        contracts=[]
        for label in LABELS:
            contracts.append({r['caseId']:(r['datasetHash'],r['contractHash']) for r in rows(TOP/f'{label}-{split}.jsonl')})
        assert all(c==contracts[0] for c in contracts)
    frozen=dict(time=time.time(),matchedInitialPromptsPerInterface=334,
        rawCasesIncludingWarmups=1336,allFinancialStateUnchanged=True,infrastructureErrors=0,
        sourceAndDataHashesVerified=True,exposedBenchmarkUnchanged=True,
        compositionFamilyCounts={s:len(v) for s,v in families.items()},entityNamespacesDisjoint=True,
        adapters={i:adapter_check(i) for i in ('full','reduced')},results=results,
        perCaseGrades=grades,finalizeScriptSha256=sha(Path(__file__)))
    save(TOP/'final-audit.json',frozen)
    return comparison,frozen


def report(comparison,audited):
    names={'base_full':'Base, full tools','base_reduced':'Base, reduced interface','tuned_full':'Broader training, full tools','tuned_reduced':'Broader training + reduced interface'}
    lines=['# Gemma E2B: broader training and a reduced tool interface','',
        'Both changes improved completion in the matched CUDA experiment. Broader training supplied most of the gain; the reduced interface added a smaller accuracy gain and improved speed compared with the trained model using full tools. The combined configuration is the strongest measured candidate.','',
        '**Keep the adapters experimental.** The combined configuration still fails 24/128 fresh cases and 30/140 regression cases. Clarification falls from 15/15 to 10/15, and some raw replies claim an action succeeded after its tool was rejected. Passing the small 12-case safety category does not establish overall safe behavior. The deployed app model is unchanged.','',
        '| Configuration | Fresh held-out success | Original regression success | Held-out median | Regression median |',
        '| --- | ---: | ---: | ---: | ---: |']
    for label in LABELS:
        h=comparison['heldout'][label];e=comparison['exposed'][label]
        lines.append(f"| {names[label]} | {h['passed']}/{h['total']} ({h['accuracy']:.1%}) | {e['passed']}/{e['total']} ({e['accuracy']:.1%}) | {h['medianSeconds']:.2f}s | {e['medianSeconds']:.2f}s |")
    lines+=['','## Protocol reliability','',
        '| Configuration / set | First-pass success | Cases with argument errors | Rejected calls | p95 |',
        '| --- | ---: | ---: | ---: | ---: |']
    for split in ('heldout','exposed'):
        for label in LABELS:
            s=comparison[split][label]
            lines.append(f"| {names[label]} / {split} | {s['firstPass']}/{s['total']} | {s['argumentErrorCases']} | {s['rejectedCalls']} | {s['p95Seconds']:.2f}s |")
    lines+=['','First-pass success additionally requires no rejected call or schema error. Primary completion can count a successful recovery. Scenario timings include failures and all tool rounds, so they do not isolate decoder throughput or LoRA compute overhead.']
    lines+=['','## Interpretation','',
        'Broader training with full tools improved 87 fresh cases and regressed none, raising completion from 12/128 to 99/128. On the original benchmark it improved 49 cases and regressed eight, raising completion from 65/140 to 106/140.','',
        'The reduced interface alone raised the unchanged base from 65/140 to 90/140 on the original benchmark, and from 12/128 to 26/128 on fresh combinations. It exposed an average of 5.28 tools instead of 16. This is evidence that contract complexity was a substantial bottleneck.','',
        'The combined configuration reached 104/128 and 110/140. Relative to the trained full interface, this is 11 improvements versus six regressions on fresh cases, and 14 improvements versus ten regressions on the original benchmark. The incremental accuracy gain is modest and not uniform. Its median was 10.8% faster on fresh cases and 31.0% faster on the original benchmark than the trained full interface. It remained slower than the unchanged base/full interface: 16.22 versus 14.04 seconds on fresh cases, and 7.31 versus 6.70 seconds on the original benchmark.','',
        'The CUDA baseline still scores the same 65/140 as the first experiment. The new 128-case composition test differs from the first experiment\'s 80-case test, so their percentages should not be compared as a common benchmark. The existing LiteRT/Android model uses a different runtime and quantization; these CUDA results do not establish phone performance.','',
        '## Data and training','',
        '2,476 synthetic training episodes cover 96 composition families and 40 primitive scenario types. They include 420 answer-only outcomes and 320 clarification outcomes. Development has 64 cases across 16 unseen combinations; held-out has 128 cases across 32 other combinations. Train, development and held-out combinations and entity namespaces are disjoint. All oracle traces pass the production ledger; reduced targets round-trip to the same native actions. The exposed benchmark has no exact training-prompt matches or eight-word training-prompt overlaps; lexical checks cannot rule out all semantic similarity.','',
        'Two independent adapters start from the pinned official google/gemma-4-E2B-it revision 3e22461f65e89153144f8adb70e3b8c2cc9845a7. Each sees the same semantic episodes, serialized for its respective interface. Both use NF4/BF16 CUDA QLoRA, rank 16, alpha 32, learning rate 1e-4, effective batch eight, one epoch and 310 optimizer updates. No checkpoint or hyperparameter selection uses held-out scores. The full-interface run took 74.3 minutes; the reduced run took 48.1 minutes.','',
        'The reduced interface uses fixed retrieval rules over user messages and current selection. It converts dollars and percentages to ledger units, supplies versions from records already observed, defaults an omitted split category to the visible category, and permits an omitted expense ID only with exactly one selected expense. The model still chooses the requested operation, participants, scope and completion. No oracle, expected plan or case metadata enters model inference.','',
        '## Important regressions and remaining failures','',
        '| Category on original benchmark | Base/full | Broader/full | Broader/reduced |',
        '| --- | ---: | ---: | ---: |']
    for category in ('safety','clarification','splits','scope_and_search','rules','trips','web_history','context_and_multiaction'):
        x=[comparison['exposed'][l]['categories'][category] for l in ('base_full','tuned_full','tuned_reduced')]
        lines.append('| '+category+' | '+' | '.join(f"{s['passed']}/{s['total']}" for s in x)+' |')
    lines += ['','The combined configuration improves 93 fresh cases and regresses one versus the base/full configuration. On the original benchmark it improves 54 and regresses nine. Failures remain concentrated in these behaviors:','',
        '- Ambiguous people: “split with my friend” can select a person instead of asking which friend. The clarification category therefore remains a deployment blocker.',
        '- Multiple selected expenses: the model sometimes omits transaction IDs even when several are visible, then asks the user for IDs after the interface rejects the call.',
        '- Trip facts: it can use an expense ID as a trip ID, or add an unrequested person/date scope. Two fresh trip-fact combinations score 0/4 each.',
        '- Error recovery and truthful completion: a rejected fact or repayment can be followed by a reply saying it was saved or prepared. For example, v2-heldout-30000 uses the receipt ID as a trip ID and falsely claims the note was saved; v2-heldout-30006 selects self as repayment person and still claims the repayment is prepared.',
        '- Reads and clarification: the model can answer a balance using staged shares instead of the snapshot balance, or ask about a refund while omitting another requested balance answer.',
        '- Empty lookups: queries such as “DOORDASH rule” or “Colorado trip” may return no exact match; the model stops instead of retrying the entity name alone.','',
        'The next bounded iteration should address those behaviors before deployment: explicit ambiguity contrasts, correction trajectories after rejected tools, broader-query recovery, and batch-selection examples. Application-generated completion summaries should reflect actual successful actions and failures. These changes have not been implemented or retested in this experiment.','',
        '## Verification and limits','',
        'An independent audit regrades every final result with the production scorer and the same additional fresh-case memory-scope check. It verifies all data/source/adapter hashes, all 490 finite LoRA tensors per adapter, 205 nonzero B matrices, identical inference settings, and all 334 initial prompts per interface by case ID. The remaining 40 zero B matrices correspond exactly to unused key/value projections in the last 20 KV-sharing layers. All 1,336 raw cases including warmups preserve the synthetic financial state. The final four passes contain zero HTTP/connection/resource infrastructure failures. The same inconsistent personal-04 fixture is excluded from every headline regression score.','',
        'Untrained data preflight, a malformed-parser failure, GPU contention, and a local HTTP closure race are retained separately. Evaluation amendments record the fixes, timestamps and hashes. An external game workload was confirmed by host GPU counters and closed before the final passes. The final runtime uses identical per-request cache cleanup, allocator headroom and explicit connection closure for all arms. Training data, completed weights, tool semantics and scoring were unchanged by those repairs. Discarded passes do not contribute to the headline metrics.','',
        'The cases are synthetic and family variants are correlated. Shared authoring/generation limits external validity. Data quantity and diversity change together, and the reduced interface combines retrieval, prompt wording and bookkeeping changes, so their individual contributions are not identified. Scores check structured actions, required arguments, ledger acceptance and selected answer anchors; they are not a complete semantic audit of every reply. No physical phone, energy, thermal, LiteRT export, or Android loading tests were run for these new adapters.','',
        '## Artifacts and reproduction','',
        '- Full and reduced adapters: full/adapter/ and reduced/adapter/ in the experiment directory.',
        '- Complete paired/category/family results: comparison.json. Independent integrity and per-case grades: final-audit.json.',
        '- Data, masks, validations, settings, original sources, corrected evaluation sources, raw native outputs and ledger traces remain beside this report.',
        '- Reproduction: finetuning/gemma4-e2b/experiment-v2.md. The ZIP contains both adapters and the measured evidence; it excludes the shared base checkpoint and compiled caches.',
        '- To relocate an adapter, explicitly load the pinned official base before loading PEFT weights. Saved adapter configuration references the original local base path.','']
    text='\n'.join(lines)
    (TOP/'report.md').write_text(text,encoding='utf-8');(ROOT/'docs/gemma4-experiment-v2.md').write_text(text,encoding='utf-8')


def package():
    target=TOP/'splitwise-gemma4-e2b-v2-experiment.zip';items=[]
    with zipfile.ZipFile(target,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=4) as z:
        def add(p,name):
            z.write(p,name);items.append(dict(name=name,sha256=sha(p),bytes=p.stat().st_size))
        for interface in ('full','reduced'):
            for p in sorted((TOP/interface/'adapter').iterdir()):
                if p.is_file():add(p,f'{interface}/adapter/{p.name}')
            for name in ('training-manifest.json','training-metrics.json','validation.json','training-source.py','trainer-log-history.json'):
                add(TOP/interface/name,f'{interface}/{name}')
        for name in ('data-manifest.json','plan.json','comparison.json','final-audit.json','report.md','evaluation-amendment-1.json','evaluation-amendment-2.json','evaluation-amendment-3.json','environment-interruption.json','gpu-resume.json','bridge-manifest.json'):
            add(TOP/name,name)
        for split in ('train','dev','heldout'):
            for suffix in ('cases.json','oracle.jsonl'):add(TOP/f'{split}.{suffix}',f'data/{split}.{suffix}')
        for label in LABELS:
            for split in ('warmup',)+SPLITS:add(TOP/f'{label}-{split}.jsonl',f'results/{label}-{split}.jsonl')
            for suffix in ('inference-manifest.json','native-traces.jsonl'):add(TOP/f'{label}-{suffix}',f'results/{label}-{suffix}')
        for directory in ('sources','evaluation-sources','evaluation-sources-memory','evaluation-sources-http'):
            for p in sorted((TOP/directory).iterdir()):
                if p.is_file():add(p,f'{directory}/{p.name}')
        for p in sorted((ROOT/'scripts').glob('gemma-v2-*.py')):add(p,'current-scripts/'+p.name)
        for name in ('generate.py','policy.txt','cases.json','rubric-audit.json','test_scoring.py'):
            add(ROOT/'benchmarks/tool-calling'/name,'benchmarks/tool-calling/'+name)
        add(ROOT/'finetuning/gemma4-e2b/experiment-v2.md','REPRODUCE.md')
        add(ROOT/'finetuning/gemma4-e2b/requirements.txt','requirements.txt')
    with zipfile.ZipFile(target) as z:assert z.testzip() is None
    manifest=dict(path=str(target),bytes=target.stat().st_size,sha256=sha(target),items=items,
        excludes='Official base weights, compiled caches, and unscored preflight passes; retained separately in original experiment directory.')
    save(TOP/'package-manifest.json',manifest)
    print(json.dumps(dict(audit='passed',packageBytes=manifest['bytes'],packageSha256=manifest['sha256'],members=len(items))))


if __name__=='__main__':
    c,a=audit();report(c,a);package()
