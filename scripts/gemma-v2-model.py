#!/usr/bin/env python3
"""Prepare, train or serve one interface arm, reusing the validated CUDA loader."""
import argparse
import collections
import gc
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import time

ROOT=Path(__file__).resolve().parent.parent
TOP=Path(os.environ.get('GEMMA_V2_DIR',ROOT/'.tools/finetune/gemma4-e2b-v2')).resolve()
ARM=os.environ.get('GEMMA_V2_INTERFACE','full')
assert ARM in ('full','reduced')
OUT=TOP/ARM
os.environ['GEMMA_FINETUNE_DIR']=str(OUT)


def module(name, file):
    sp=importlib.util.spec_from_file_location(name,ROOT/'scripts'/file)
    m=importlib.util.module_from_spec(sp);sp.loader.exec_module(m);return m


m=module('gemma_training','finetune-gemma.py')
ui=module('gemma_interface','gemma-v2-interface.py')
b=module('scorer','tool-benchmark.py')


def respond_json(handler, payload, status=200):
    # The Java client can send its next POST while per-request CUDA cleanup is
    # still running. Explicit closure prevents reusing that retiring socket.
    data=json.dumps(payload).encode()
    handler.close_connection=True
    handler.send_response(status)
    handler.send_header('Content-Type','application/json')
    handler.send_header('Content-Length',str(len(data)))
    handler.send_header('Connection','close')
    handler.end_headers()
    handler.wfile.write(data)


def parsed_response(tokenizer, raw):
    """Malformed model output is a scored protocol error, never an HTTP error."""
    try:
        parsed=tokenizer.parse_response(raw)
        if not isinstance(parsed,dict):raise ValueError('Response must be an object')
        calls=parsed.get('tool_calls',[])
        if not isinstance(calls,list) or raw.count('<|tool_call>')!=len(calls):raise ValueError('Unparsed tool call')
        for tc in calls:
            if not isinstance(tc,dict) or not isinstance(tc.get('function'),dict):raise ValueError('Malformed tool-call structure')
            fn=tc['function']
            if not isinstance(fn.get('name'),str) or not fn['name'] or not isinstance(fn.get('arguments'),dict):raise ValueError('Malformed tool name or arguments')
        if not isinstance(parsed.get('content',''),str):raise ValueError('Malformed response text')
        return parsed
    except Exception as e:
        return dict(role='assistant',tool_calls=[dict(function=dict(name='__malformed_response__',arguments={'raw':raw,'error':str(e)}))])


def prepare():
    from transformers import AutoTokenizer
    tok=AutoTokenizer.from_pretrained(OUT/'base');ct,rt=m.formatter(tok)
    policy=(ROOT/'benchmarks/tool-calling/policy.txt').read_text()
    schemas=json.loads((TOP/'tools.json').read_text());contract={s['name']:s for s in schemas}
    stats={};coverage=[];roundtrip=[]
    for split in ('train','dev','heldout'):
        cases={r['id']:r for r in json.loads((TOP/f'{split}.cases.json').read_text())['cases']}
        examples=[];outcomes=collections.Counter();counts=collections.Counter()
        for row in m.readrows(TOP/f'{split}.oracle.jsonl'):
            case=cases[row['caseId']];summary=row['workspaceSummary']
            grade=b.grade(row,schemas=contract)
            if not grade['passed'] or grade['argumentErrors']:raise ValueError((row['caseId'],grade))
            p=ui.policy_view(policy) if ARM=='reduced' else policy
            tools=ui.schema_view(schemas,case['prompt'],summary) if ARM=='reduced' else schemas
            if ARM=='reduced':
                unavailable={t['name'] for t in row['trace']}-{t['name'] for t in tools}
                if unavailable:coverage.append(dict(caseId=row['caseId'],tools=sorted(unavailable)))
            messages=[dict(role='system',content=p+'\nCurrent workspace summary: '+json.dumps(summary,separators=(',',':'))),dict(role='user',content=case['prompt'])]
            prompt=tok.apply_chat_template(messages,tools=[dict(type='function',function=s) for s in tools],tokenize=False,add_generation_prompt=True,enable_thinking=False)
            ids=tok.encode(prompt,add_special_tokens=False);labels=[-100]*len(ids);responses=[]
            for t in row['trace']:
                name=t['name'];native=t['arguments'];a=ui.model_args(name,native,summary) if ARM=='reduced' else native
                if ARM=='reduced':
                    restored=ui.native_args(name,a,summary,responses,case['prompt'])
                    # The explanation is deliberately delegated to the app.
                    left={k:v for k,v in native.items() if k!='explanation'}
                    right={k:v for k,v in restored.items() if k!='explanation'}
                    if left!=right:roundtrip.append(dict(caseId=row['caseId'],name=name,native=left,restored=right))
                text=ct(name,a);tt=tok.encode(text,add_special_tokens=False);ids+=tt;labels+=tt;counts[name]+=1
                result=rt(name,a,t['response']);assert result.startswith('<|tool_response>')
                rr=tok.encode(result[len('<|tool_response>'):],add_special_tokens=False);ids+=rr;labels += [-100]*len(rr);responses.append(t['response'])
            outcome='clarification' if case['expect'].get('question') else 'changes_prepared' if any(case['expect'][k] for k in ('organization','requests','updates')) else 'answer'
            outcomes[outcome]+=1
            if not row['trace'] or row['trace'][-1]['name']!='request_clarification':
                tt=tok.encode(ct('finish_reply',dict(outcome=outcome,message=row['reply'])),add_special_tokens=False);ids+=tt;labels+=tt;counts['finish_reply:'+outcome]+=1
            examples.append(dict(caseId=row['caseId'],family=row['family'],input_ids=ids,labels=labels))
        m.save(OUT/f'{split}.tokenized.json',examples)
        stats[split]=dict(cases=len(examples),maxTokens=max(len(r['input_ids']) for r in examples),meanTokens=sum(len(r['input_ids']) for r in examples)/len(examples),supervisedTokens=sum(sum(x!=-100 for x in r['labels']) for r in examples),outcomes=dict(outcomes),toolCounts=dict(counts),sha256=m.sha(OUT/f'{split}.tokenized.json'))
    stats.update(interface=ARM,missingRoutedOracleTools=coverage,roundtripFailures=roundtrip)
    m.save(OUT/'validation.json',stats);print(json.dumps(stats,indent=2))
    assert not coverage,coverage[:10]
    assert not roundtrip,roundtrip[:10]
    assert max(stats[s]['maxTokens'] for s in ('train','dev','heldout'))<=6144


def serve(adapter):
    from http.server import BaseHTTPRequestHandler,HTTPServer
    import torch
    model,tok,meta=m.load_model(adapter=str(OUT/'adapter') if adapter else None)
    # Leave room for the Windows display/driver and release cached allocations
    # between independent requests with different sequence shapes.
    gc.collect();torch.cuda.empty_cache()
    torch.cuda.set_per_process_memory_fraction(.78)
    label=('tuned_' if adapter else 'base_')+ARM
    meta.update(interface=ARM,adapter=adapter,sampler=dict(do_sample=False,maxNewTokens=1024,thinking=False),
        scriptSha256=m.sha(__file__),interfaceSha256=m.sha(ROOT/'scripts/gemma-v2-interface.py'),startedAt=time.time(),
        memoryPolicy=dict(processFraction=.78,releaseUnusedCacheAfterEachRequest=True,trainingUnchanged=True))
    m.save(TOP/f'{label}-inference-manifest.json',meta)
    counter=0
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*a):pass
        def do_GET(self):
            respond_json(self,dict(pid=os.getpid(),adapter=adapter,interface=ARM,devices=meta['devices'],allocatedMiB=torch.cuda.memory_allocated()/2**20,reservedMiB=torch.cuda.memory_reserved()/2**20))
        def do_POST(self):
            nonlocal counter
            try:
                original=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                canonical,restore=m.canonical_request(original)
                body,context=ui.request_view(canonical,ARM=='reduced')
                messages=[dict(role='system',content=body['instructions'])]
                for r in body['input']:
                    if r.get('type')=='function_call_output':
                        prev=next(x for x in reversed(messages) if x.get('tool_calls') and any(tc['id']==r['call_id'] for tc in x['tool_calls']))
                        name=next(tc['function']['name'] for tc in prev['tool_calls'] if tc['id']==r['call_id'])
                        prev.setdefault('tool_responses',[]).append(dict(name=name,response=json.loads(r['output'])))
                    elif r.get('type')=='function_call':
                        messages.append(dict(role='assistant',tool_calls=[dict(id=r['call_id'],type='function',function=dict(name=r['name'],arguments=json.loads(r['arguments'])))]))
                    elif r.get('type')=='message':messages.append(dict(role='assistant',content=''.join(c.get('text','') for c in r.get('content',[]))))
                    elif 'role' in r:messages.append(dict(role=r['role'],content=r['content']))
                tools=[dict(type='function',function={k:s[k] for k in ('name','description','parameters')}) for s in body['tools']]
                prompt=tok.apply_chat_template(messages,tools=tools,tokenize=False,add_generation_prompt=True,enable_thinking=False)
                encoded=tok(prompt,add_special_tokens=False,return_tensors='pt').to('cuda')
                assert encoded.input_ids.shape[1]+1024<=16384,'Context limit'
                torch.cuda.synchronize();start=time.perf_counter();torch.cuda.reset_peak_memory_stats()
                stop=[tok.convert_tokens_to_ids(s) for s in ('<|tool_response>','<turn|>','<eos>')]
                with torch.inference_mode():result=model.generate(**encoded,max_new_tokens=1024,do_sample=False,eos_token_id=stop,pad_token_id=tok.pad_token_id,use_cache=True)
                torch.cuda.synchronize();elapsed=time.perf_counter()-start
                tokens=result[0,encoded.input_ids.shape[1]:];raw=tok.decode(tokens,skip_special_tokens=False)
                parsed=parsed_response(tok,raw)
                counter+=1;rid=f'{label}-{counter}';output=[];translations=[]
                for i,tc in enumerate(parsed.get('tool_calls',[])):
                    name=tc['function']['name'];a=tc['function']['arguments'];model_a=a
                    if ARM=='reduced':
                        try:
                            if name not in {s['name'] for s in body['tools']}:raise ValueError('Tool not exposed by reduced interface')
                            errors=b.argument_errors(a,next(s for s in body['tools'] if s['name']==name)['parameters'])
                            if errors:raise ValueError('; '.join(errors))
                            a=ui.native_args(name,a,**context)
                        except Exception as e:
                            name='__interface_error__';a=dict(requestedTool=tc['function']['name'],error=str(e),arguments=model_a)
                    translations.append(dict(name=name,modelArguments=model_a,nativeArguments=a))
                    output.append(dict(type='function_call',name=name,arguments=json.dumps(m.restore_ids(a,restore)),call_id=f'{rid}-{i}',id=f'{rid}-{i}'))
                if parsed.get('content') and not output:output.append(dict(type='message',role='assistant',content=[dict(type='output_text',text=parsed['content'])]))
                usage=dict(input_tokens=encoded.input_ids.shape[1],input_tokens_details=dict(cached_tokens=0),output_tokens=len(tokens))
                trace=dict(id=rid,promptSha256=hashlib.sha256(prompt.encode()).hexdigest(),initial=not any(r.get('type')=='function_call' for r in original['input']),userText='\n'.join(r.get('content','') for r in original['input'] if r.get('role')=='user'),raw=raw,parsed=parsed,translations=translations,inferenceSeconds=elapsed,usage=usage,toolsExposed=[s['name'] for s in body['tools']],peakAllocatedMiB=torch.cuda.max_memory_allocated()/2**20,peakReservedMiB=torch.cuda.max_memory_reserved()/2**20)
                encoded=result=tokens=None
                gc.collect();torch.cuda.empty_cache()
                trace.update(afterCleanupAllocatedMiB=torch.cuda.memory_allocated()/2**20,afterCleanupReservedMiB=torch.cuda.memory_reserved()/2**20)
                with (TOP/f'{label}-native-traces.jsonl').open('a') as f:f.write(json.dumps(trace)+'\n')
                respond_json(self,dict(id=rid,output=output,usage=usage))
            except (BrokenPipeError,ConnectionResetError):
                pass
            except Exception as e:
                import traceback;traceback.print_exc()
                respond_json(self,dict(error=str(e)),500)
            finally:
                encoded=result=tokens=None
                gc.collect();torch.cuda.empty_cache()
    print('READY '+label,flush=True);HTTPServer(('127.0.0.1',8765),Handler).serve_forever()


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('action',choices=['prepare','train','serve']);p.add_argument('--adapter',action='store_true');a=p.parse_args()
    if a.action=='prepare':prepare()
    elif a.action=='train':
        if (OUT/'training-metrics.json').exists():raise RuntimeError('Refusing to overwrite a completed training run')
        (OUT/'training-source.py').write_bytes((ROOT/'scripts/finetune-gemma.py').read_bytes())
        m.train(argparse.Namespace(max_steps=0))
    else:serve(a.adapter)
