#!/usr/bin/env python3
"""Stream PEFT text adapters into the official BF16 composite checkpoint on CPU.

The evaluated CUDA adapter uses NF4 base weights. This BF16 merge is a separate
export input and must be evaluated after conversion before deployment.
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import time

ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.environ.get('GEMMA_FINETUNE_DIR',ROOT/'.tools/finetune/gemma4-e2b-v1')).resolve()


def sha(path):return hashlib.file_digest(Path(path).open('rb'),'sha256').hexdigest()


def main():
    import torch
    from safetensors import safe_open
    from safetensors.torch import load_file,save_file
    torch.set_num_threads(4)
    config=json.loads((OUT/'adapter/adapter_config.json').read_text())
    assert config['peft_type']=='LORA' and not config.get('use_dora')
    assert not config.get('rank_pattern') and not config.get('alpha_pattern')
    adapter=load_file(OUT/'adapter/adapter_model.safetensors',device='cpu')
    pairs={}
    for key,value in adapter.items():
        if '.lora_A.' not in key:continue
        bkey=key.replace('.lora_A.','.lora_B.')
        assert bkey in adapter
        target=key.split('.lora_A.')[0].removeprefix('base_model.model.')+'.weight'
        # Text-only loading rebases model.language_model.* to model.*.
        if target.startswith('model.') and not target.startswith('model.language_model.'):
            target='model.language_model.'+target[len('model.'):]
        assert target not in pairs
        pairs[target]=(value,adapter[bkey])
    assert len(adapter)==2*len(pairs), 'Unsupported non-LoRA weights in adapter'
    dest=OUT/'merged-bf16';dest.mkdir(exist_ok=True)
    if (dest/'model.safetensors.index.json').exists():raise RuntimeError('Merged artifact already exists; refusing overwrite')
    scale=config['lora_alpha']/config['r'];start=time.perf_counter()
    shard={};size=0;weightmap={};files=[];total=0;used=set();checks=[]
    def flush():
        nonlocal shard,size
        if not shard:return
        name=f'model-{len(files)+1:05d}.safetensors'
        save_file(shard,str(dest/name),metadata={'format':'pt'})
        for k in shard:weightmap[k]=name
        files.append(name);shard={};size=0
    with safe_open(OUT/'base/model.safetensors',framework='pt',device='cpu') as base:
        assert set(pairs)<=set(base.keys()),set(pairs)-set(base.keys())
        for key in base.keys():
            tensor=base.get_tensor(key)
            if key in pairs:
                a,b=pairs[key];delta=(b.float()@a.float())*scale
                assert tensor.shape==delta.shape
                original=tensor
                tensor=(tensor.float()+delta).to(tensor.dtype).contiguous()
                assert torch.isfinite(tensor).all()
                if len(checks)<3:
                    checks.append(dict(key=key,shape=list(tensor.shape),deltaNorm=delta.norm().item(),mergedNorm=tensor.float().norm().item(),changedElements=int((tensor!=original).sum())))
                used.add(key)
            n=tensor.numel()*tensor.element_size()
            if size+n>1_000_000_000:flush()
            shard[key]=tensor;size+=n;total+=n
    flush();assert used==set(pairs)
    for name in ['config.json','generation_config.json','tokenizer.json','tokenizer_config.json','chat_template.jinja','processor_config.json']:
        shutil.copyfile(OUT/'base'/name,dest/name)
    (dest/'model.safetensors.index.json').write_text(json.dumps(dict(metadata=dict(total_size=total),weight_map=weightmap),indent=2)+'\n')
    manifest=dict(base='google/gemma-4-E2B-it',revision='3e22461f65e89153144f8adb70e3b8c2cc9845a7',baseSha256=sha(OUT/'base/model.safetensors'),adapterSha256=sha(OUT/'adapter/adapter_model.safetensors'),loraModules=len(pairs),scale=scale,tensors=len(weightmap),totalBytes=total,seconds=time.perf_counter()-start,numericalChecks=checks,files={n:sha(dest/n) for n in files},deploymentStatus='BF16 merged checkpoint for export; not a LiteRT bundle and not evaluated as a replacement for the measured NF4 adapter')
    (OUT/'merge-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    print(json.dumps({k:v for k,v in manifest.items() if k!='files'},indent=2))


if __name__=='__main__':main()
