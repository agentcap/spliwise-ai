#!/usr/bin/env python3
"""CUDA QLoRA training, native Gemma tool formatting, and loopback evaluation.

Use the pinned official checkpoint. Neither .litertlm nor benchmark answers train
the model. All assistant targets are masked separately from prompts/tool results.
"""
import argparse
import collections
import hashlib
import importlib.metadata
import importlib.util
import json
import os
from pathlib import Path
import random
import re
import subprocess
import time
import uuid

ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('GEMMA_FINETUNE_DIR',ROOT/'.tools/finetune/gemma4-e2b-v1')).resolve()
MODEL='google/gemma-4-E2B-it'
REVISION='3e22461f65e89153144f8adb70e3b8c2cc9845a7'
SEED=27031
os.environ.setdefault('UNSLOTH_COMPILE_LOCATION',str(OUT/'compiled-cache'))
os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF','expandable_segments:True')


def sha(p):return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def save(p,obj):Path(p).write_text(json.dumps(obj,indent=2,ensure_ascii=False)+'\n')
def readrows(p):return [json.loads(s) for s in Path(p).read_text().splitlines() if s.strip()]
def schemas():return [{'type':'function','function':s} for s in json.loads((OUT/'tools.json').read_text())]


def canonical_request(body):
    """Match synthetic UUID/timestamp inputs across the two independent ledgers.

    User text is never changed. IDs remain valid opaque UUIDs and are translated
    back before dispatch. This prevents random fixture IDs/times from confounding
    an otherwise paired base-versus-adapter comparison.
    """
    import copy
    body=copy.deepcopy(body);mapping={}
    user_text='\n'.join(r.get('content','') for r in body['input'] if r.get('role')=='user')
    pattern=re.compile(r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b',re.I)
    def text(s):
        def swap(match):
            old=match.group()
            if old not in mapping:mapping[old]=str(uuid.uuid5(uuid.NAMESPACE_URL,'splitwise-v1:'+user_text+':'+str(len(mapping))))
            return mapping[old]
        return pattern.sub(swap,s)
    def walk(v,key=''):
        if key in ('updatedAt','createdAt') and isinstance(v,str):return '2026-10-16T12:00:00Z'
        if isinstance(v,dict):return {k:walk(x,k) for k,x in v.items()}
        if isinstance(v,list):return [walk(x) for x in v]
        return text(v) if isinstance(v,str) else v
    policy,summary=body['instructions'].split('\nCurrent workspace summary: ',1)
    body['instructions']=policy+'\nCurrent workspace summary: '+json.dumps(walk(json.loads(summary)),separators=(',',':'))
    for row in body['input']:
        if row.get('type')=='function_call_output':row['output']=json.dumps(walk(json.loads(row['output'])),separators=(',',':'))
        elif row.get('type')=='function_call':row['arguments']=json.dumps(walk(json.loads(row['arguments'])),separators=(',',':'))
    return body,{new:old for old,new in mapping.items()}


def restore_ids(v,mapping):
    if isinstance(v,dict):return {k:restore_ids(x,mapping) for k,x in v.items()}
    if isinstance(v,list):return [restore_ids(x,mapping) for x in v]
    return mapping.get(v,v) if isinstance(v,str) else v


def formatter(tokenizer):
    def calltext(name,args):
        s=tokenizer.apply_chat_template([{'role':'assistant','tool_calls':[{'function':{'name':name,'arguments':args}}]}],tokenize=False,enable_thinking=False)
        return s.split('<|turn>model\n',1)[1]
    def response(name,args,result):
        s=tokenizer.apply_chat_template([{'role':'assistant','tool_calls':[{'function':{'name':name,'arguments':args}}],'tool_responses':[{'name':name,'response':result}]}],tokenize=False,enable_thinking=False)
        return '<|tool_response>'+s.split('<|tool_response>',1)[1]
    return calltext,response


def prepare():
    from transformers import AutoTokenizer
    tokenizer=AutoTokenizer.from_pretrained(OUT/'base')
    calltext,responsetext=formatter(tokenizer)
    policy=(ROOT/'benchmarks/tool-calling/policy.txt').read_text()
    spec=importlib.util.spec_from_file_location('benchmark_scorer',ROOT/'scripts/tool-benchmark.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
    contract={s['name']:s for s in json.loads((OUT/'tools.json').read_text())}
    report={};tool_counts=collections.Counter()
    for split in ['train','dev','heldout']:
        cases={r['id']:r for r in json.loads((OUT/f'{split}.cases.json').read_text())['cases']}
        rows=readrows(OUT/f'{split}.oracle.jsonl')
        assert len(rows)==len(cases)
        examples=[];failures=[];schema_errors=[]
        for row in rows:
            case=cases[row['caseId']]
            grade=b.grade(row,schemas=contract)
            if not grade['passed']:failures.append({'caseId':row['caseId'],'grade':grade})
            if grade['argumentErrors']:schema_errors.append({'caseId':row['caseId'],'errors':grade['argumentErrors']})
            messages=[{'role':'system','content':policy+'\nCurrent workspace summary: '+json.dumps(row['workspaceSummary'],separators=(',',':'))}]
            messages += [{'role':('assistant' if m['role']!='user' else 'user'),'content':m['text']} for m in case['history']]
            messages += [{'role':'user','content':case['prompt']}]
            prompt=tokenizer.apply_chat_template(messages,tools=schemas(),tokenize=False,add_generation_prompt=True,enable_thinking=False)
            ids=tokenizer.encode(prompt,add_special_tokens=False);labels=[-100]*len(ids)
            for index,t in enumerate(row['trace']):
                args=t['arguments'];name=t['name'];tool_counts[name]+=1
                text=calltext(name,args)
                # The tool-response opener is generated by Gemma. The application
                # supplies the body, which is never an assistant loss target.
                tt=tokenizer.encode(text,add_special_tokens=False)
                ids+=tt;labels+=tt if index not in case.get('unsupervisedOracleIndices',[]) else [-100]*len(tt)
                rt=responsetext(name,args,t['response'])
                assert rt.startswith('<|tool_response>')
                rt=rt[len('<|tool_response>'):]
                rr=tokenizer.encode(rt,add_special_tokens=False);ids+=rr;labels += [-100]*len(rr)
            outcome='clarification' if case['expect'].get('question') else 'changes_prepared' if any(case['expect'].get(k) for k in ('organization','requests','updates')) else 'answer'
            # Clarification dispatch itself terminates in the app. No duplicate
            # finish tool is taught after request_clarification.
            if not row['trace'] or row['trace'][-1]['name']!='request_clarification':
                end=calltext('finish_reply',dict(outcome=outcome,message=row['reply']))
                tt=tokenizer.encode(end,add_special_tokens=False);ids+=tt;labels+=tt
            assert len(ids)==len(labels) and any(x!=-100 for x in labels)
            examples.append(dict(caseId=row['caseId'],family=row['family'],input_ids=ids,labels=labels))
        save(OUT/f'{split}.tokenized.json',examples)
        report[split]=dict(cases=len(rows),passed=len(rows)-len(failures),failures=failures,schemaErrors=schema_errors,maxTokens=max(len(e['input_ids']) for e in examples),meanTokens=sum(len(e['input_ids']) for e in examples)/len(examples),supervisedTokens=sum(sum(t!=-100 for t in e['labels']) for e in examples),sha256=sha(OUT/f'{split}.tokenized.json'))
    report['toolCounts']=dict(tool_counts)
    report['masking']='Prompt, tool-result bodies, and deliberately rejected calls have -100 labels; valid assistant calls and response-openers are supervised.'
    save(OUT/'validation.json',report)
    print(json.dumps(report,indent=2))
    assert all(report[s]['passed']==report[s]['cases'] and not report[s]['schemaErrors'] for s in ('train','dev','heldout'))


def load_model(adapter=None,training=False):
    # Import before transformers so accelerated kernels/checkpointing can patch.
    from unsloth import FastLanguageModel
    import torch
    assert torch.cuda.is_available(),'CUDA is required; never silently use CPU'
    model,tokenizer=FastLanguageModel.from_pretrained(model_name=str(OUT/'base'),max_seq_length=6144 if training else 16384,dtype=torch.bfloat16,load_in_4bit=True,device_map={'':0},attn_implementation='sdpa',text_only=True)
    tokenizer=getattr(tokenizer,'tokenizer',tokenizer)
    # Use exactly the same official template that prepared the masked targets.
    tokenizer.chat_template=(OUT/'base/chat_template.jinja').read_text()
    if training:
        model=FastLanguageModel.get_peft_model(model,r=16,target_modules=['q_proj','k_proj','v_proj','o_proj','gate_proj','up_proj','down_proj'],lora_alpha=32,lora_dropout=0,bias='none',use_gradient_checkpointing='unsloth',random_state=SEED)
        for name,p in model.named_parameters():
            if any(m in name for m in ('vision_tower','audio_tower','multi_modal_projector')):p.requires_grad=False
    elif adapter:
        from peft import PeftModel
        model=PeftModel.from_pretrained(model,adapter,is_trainable=False)
    if not training:FastLanguageModel.for_inference(model)
    else:FastLanguageModel.for_training(model)
    trainable=sum(p.numel() for p in model.parameters() if p.requires_grad)
    devices=collections.Counter(str(p.device) for p in model.parameters())
    assert set(devices)=={'cuda:0'},devices
    metadata=dict(model=MODEL,revision=REVISION,officialWeightsSha256=sha(OUT/'base/model.safetensors'),configSha256=sha(OUT/'base/config.json'),tokenizerSha256=sha(OUT/'base/tokenizer.json'),backend='WSL2 CUDA; PyTorch + Unsloth + bitsandbytes NF4; SDPA',gpu=torch.cuda.get_device_name(0),cudaRuntime=torch.version.cuda,devices=dict(devices),trainableParameters=trainable,parameterCount=sum(p.numel() for p in model.parameters()),quantization=str(model.config.quantization_config),versions={p:importlib.metadata.version(p) for p in ['torch','transformers','unsloth','unsloth_zoo','peft','trl','bitsandbytes','accelerate','datasets','huggingface-hub']})
    metadata.update(chatTemplateSha256=hashlib.sha256(tokenizer.chat_template.encode()).hexdigest(),modelClass=type(model).__name__,attentionImplementation=getattr(model.config,'_attn_implementation',None))
    return model,tokenizer,metadata


def train(args):
    import torch
    model,tokenizer,metadata=load_model(training=True)
    from transformers import Trainer,TrainingArguments,TrainerCallback
    random.seed(SEED);torch.manual_seed(SEED);torch.cuda.manual_seed_all(SEED)
    class Records(torch.utils.data.Dataset):
        def __init__(self,path):self.rows=json.loads(Path(path).read_text())
        def __len__(self):return len(self.rows)
        def __getitem__(self,i):return {k:self.rows[i][k] for k in ['input_ids','labels']}
    class Collator:
        def __call__(self,rows):
            n=max(len(r['input_ids']) for r in rows)
            return {'input_ids':torch.tensor([r['input_ids']+[tokenizer.pad_token_id]*(n-len(r['input_ids'])) for r in rows]),'attention_mask':torch.tensor([[1]*len(r['input_ids'])+[0]*(n-len(r['input_ids'])) for r in rows]),'labels':torch.tensor([r['labels']+[-100]*(n-len(r['labels'])) for r in rows])}
    class Telemetry(TrainerCallback):
        def on_log(self,args,state,control,logs=None,**kw):
            with (OUT/'training-telemetry.jsonl').open('a') as f:f.write(json.dumps(dict(step=state.global_step,time=time.time(),logs=logs or {},allocatedMiB=torch.cuda.memory_allocated()/2**20,reservedMiB=torch.cuda.memory_reserved()/2**20))+'\n')
    settings=dict(output_dir=str(OUT/'checkpoints'),per_device_train_batch_size=1,gradient_accumulation_steps=8,num_train_epochs=1,learning_rate=1e-4,warmup_ratio=.05,lr_scheduler_type='cosine',weight_decay=.01,optim='adamw_8bit',bf16=True,fp16=False,logging_steps=1,save_strategy='no',eval_strategy='no',seed=SEED,data_seed=SEED,report_to='none',remove_unused_columns=False,dataloader_num_workers=0,max_grad_norm=1.,gradient_checkpointing=True)
    if args.max_steps:settings['max_steps']=args.max_steps
    metadata.update(settings=settings,dataManifestSha256=sha(OUT/'data-manifest.json'),validationSha256=sha(OUT/'validation.json'),scriptSha256=sha(__file__),startedAt=time.time(),lora=dict(rank=16,alpha=32,dropout=0,modules=['q_proj','k_proj','v_proj','o_proj','gate_proj','up_proj','down_proj']))
    save(OUT/'training-manifest.json',metadata)
    trainer=Trainer(model=model,args=TrainingArguments(**settings),train_dataset=Records(OUT/'train.tokenized.json'),data_collator=Collator(),callbacks=[Telemetry()])
    torch.cuda.reset_peak_memory_stats();start=time.perf_counter()
    result=trainer.train()
    model.save_pretrained(OUT/'adapter');tokenizer.save_pretrained(OUT/'adapter')
    result.metrics.update(elapsedSeconds=time.perf_counter()-start,peakAllocatedMiB=torch.cuda.max_memory_allocated()/2**20,peakReservedMiB=torch.cuda.max_memory_reserved()/2**20,finalStep=trainer.state.global_step)
    save(OUT/'training-metrics.json',result.metrics)
    save(OUT/'trainer-log-history.json',trainer.state.log_history)
    metadata['finishedAt']=time.time();metadata['adapterFiles']={p.name:sha(p) for p in (OUT/'adapter').iterdir() if p.is_file()};save(OUT/'training-manifest.json',metadata)
    print(json.dumps(result.metrics,indent=2))


def serve(args):
    from http.server import BaseHTTPRequestHandler,HTTPServer
    import torch
    model,tokenizer,metadata=load_model(adapter=str(OUT/'adapter') if args.adapter else None)
    calltext,responsetext=formatter(tokenizer)
    metadata.update(sampler=dict(do_sample=False,maxNewTokens=1024,thinking=False,seed=SEED),contextTokens=16384,adapter=bool(args.adapter),startedAt=time.time(),canonicalSyntheticIds=True,canonicalFixtureTimestamps=True,scriptSha256=sha(__file__),policySha256=sha(ROOT/'benchmarks/tool-calling/policy.txt'),toolsSha256=sha(OUT/'tools.json'))
    save(OUT/('tuned-inference-manifest.json' if args.adapter else 'base-inference-manifest.json'),metadata)
    counter=0
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*a):pass
        def do_GET(self):
            data=json.dumps(dict(pid=os.getpid(),adapter=bool(args.adapter),backend=metadata['backend'],devices=metadata['devices'])).encode()
            self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
        def do_POST(self):
            nonlocal counter
            try:
                body=json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                body,restore=canonical_request(body)
                messages=[{'role':'system','content':body['instructions']}]
                for row in body['input']:
                    if row.get('type')=='function_call_output':
                        previous=next(m for m in reversed(messages) if m.get('tool_calls') and any(tc['id']==row['call_id'] for tc in m['tool_calls']))
                        name=next(tc['function']['name'] for tc in previous['tool_calls'] if tc['id']==row['call_id'])
                        previous.setdefault('tool_responses',[]).append(dict(name=name,response=json.loads(row['output'])))
                    elif row.get('type')=='function_call':
                        messages.append(dict(role='assistant',tool_calls=[dict(id=row['call_id'],type='function',function=dict(name=row['name'],arguments=json.loads(row['arguments'])))]))
                    elif row.get('type')=='message':
                        messages.append(dict(role='assistant',content=''.join(c.get('text','') for c in row.get('content',[]))))
                    elif 'role' in row:messages.append(dict(role=row['role'],content=row['content']))
                tools=[dict(type='function',function={k:row[k] for k in ('name','description','parameters')}) for row in body['tools']]
                prompt=tokenizer.apply_chat_template(messages,tools=tools,tokenize=False,add_generation_prompt=True,enable_thinking=False)
                encoded=tokenizer(prompt,add_special_tokens=False,return_tensors='pt').to('cuda')
                assert encoded.input_ids.shape[1]+1024<=16384,'Context limit'
                torch.cuda.synchronize();start=time.perf_counter();torch.cuda.reset_peak_memory_stats()
                stop=[tokenizer.convert_tokens_to_ids(s) for s in ['<|tool_response>','<turn|>','<eos>']]
                with torch.inference_mode():output=model.generate(**encoded,max_new_tokens=1024,do_sample=False,eos_token_id=stop,pad_token_id=tokenizer.pad_token_id,use_cache=True)
                torch.cuda.synchronize();elapsed=time.perf_counter()-start
                tokens=output[0,encoded.input_ids.shape[1]:];raw=tokenizer.decode(tokens,skip_special_tokens=False)
                try:
                    parsed=tokenizer.parse_response(raw)
                    if raw.count('<|tool_call>')!=len(parsed.get('tool_calls',[])):raise ValueError('Unparsed native tool call')
                except Exception as parse_error:
                    parsed=dict(role='assistant',tool_calls=[dict(type='function',function=dict(name='__malformed_response__',arguments={'raw':raw,'error':str(parse_error)}))])
                counter+=1;rid=f'cuda-{counter}'
                parsed=restore_ids(parsed,restore)
                results=[]
                for i,tc in enumerate(parsed.get('tool_calls',[])):
                    results.append(dict(type='function_call',name=tc['function']['name'],arguments=json.dumps(tc['function']['arguments']),call_id=f'{rid}-{i}',id=f'{rid}-{i}'))
                content=parsed.get('content','')
                if content and not results:results.append(dict(type='message',role='assistant',content=[dict(type='output_text',text=content)]))
                usage=dict(input_tokens=encoded.input_ids.shape[1],input_tokens_details=dict(cached_tokens=0),output_tokens=len(tokens))
                response=dict(id=rid,output=results,usage=usage)
                with (OUT/('tuned-native-traces.jsonl' if args.adapter else 'base-native-traces.jsonl')).open('a') as f:f.write(json.dumps(dict(id=rid,promptSha256=hashlib.sha256(prompt.encode()).hexdigest(),raw=raw,parsed=parsed,inferenceSeconds=elapsed,usage=usage,peakAllocatedMiB=torch.cuda.max_memory_allocated()/2**20))+'\n')
                data=json.dumps(response).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
            except Exception as e:
                import traceback;traceback.print_exc()
                data=json.dumps(dict(error=str(e))).encode();self.send_response(500);self.send_header('Content-Length',str(len(data)));self.end_headers();self.wfile.write(data)
    print('READY CUDA '+('adapter' if args.adapter else 'base'),flush=True)
    HTTPServer(('127.0.0.1',8765),Handler).serve_forever()


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('action',choices=['prepare','train','serve','smoke']);p.add_argument('--adapter',action='store_true');p.add_argument('--max-steps',type=int,default=0);a=p.parse_args()
    if a.action=='prepare':prepare()
    elif a.action=='train':train(a)
    elif a.action=='serve':serve(a)
    else:
        model,tokenizer,metadata=load_model(training=True);save(OUT/'smoke-model.json',metadata);print(json.dumps(metadata,indent=2))
