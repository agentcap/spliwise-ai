#!/usr/bin/env python3
"""Prepare the measured reduced adapter for a bounded, reproducible LiteRT export.

Store FP32 export weights on disk before loading the converter. This lets the
Transformers safetensors loader map its requested dtype instead of allocating a
second, converted copy of every BF16 parameter in a 16 GiB WSL guest.
"""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
import struct
import time

ROOT = Path(__file__).resolve().parent.parent
TOP = ROOT / '.tools/finetune/gemma4-e2b-v2'
OUT = TOP / 'android'
BASE = ROOT / '.tools/finetune/gemma4-e2b-v1/base'
PYTHON = ROOT / '.tools/finetune/gemma4-e2b-v1/export-venv/bin/python'


def save(path, value):
    path.write_text(json.dumps(value, indent=2) + '\n')


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def prepare():
    import torch
    from safetensors import safe_open
    from safetensors.torch import load_file
    torch.set_num_threads(4)
    OUT.mkdir(exist_ok=True)
    dest = OUT / 'merged-fp32'
    if (OUT / 'merge-manifest.json').exists():
        manifest = json.loads((OUT / 'merge-manifest.json').read_text())
        assert manifest['adapterSha256'] == sha(TOP / 'reduced/adapter/adapter_model.safetensors')
        for name, digest in manifest['files'].items():
            assert sha(dest / name) == digest, name
        print('Verified existing merged export checkpoint.', flush=True)
        return
    dest.mkdir(exist_ok=True)
    if any(dest.iterdir()):
        raise RuntimeError('Incomplete merge directory; preserve or move it before restarting.')
    config = json.loads((TOP / 'reduced/adapter/adapter_config.json').read_text())
    assert config['peft_type'] == 'LORA' and not config.get('use_dora')
    assert not config.get('rank_pattern') and not config.get('alpha_pattern')
    adapter = load_file(TOP / 'reduced/adapter/adapter_model.safetensors', device='cpu')
    pairs = {}
    for key, value in adapter.items():
        if '.lora_A.' not in key:
            continue
        target = key.split('.lora_A.')[0].removeprefix('base_model.model.') + '.weight'
        if target.startswith('model.') and not target.startswith('model.language_model.'):
            target = 'model.language_model.' + target[len('model.'):]
        pairs[target] = (value, adapter[key.replace('.lora_A.', '.lora_B.')])
    assert len(adapter) == 2 * len(pairs)
    files, weightmap, checks = [], {}, []
    total = 0
    used = set()
    scale = config['lora_alpha'] / config['r']
    started = time.time()

    with safe_open(BASE / 'model.safetensors', framework='pt', device='cpu') as source:
        assert set(pairs) <= set(source.keys())
        groups, group, size = [], [], 0
        for key in source.keys():
            view = source.get_slice(key)
            assert view.get_dtype() in ('BF16', 'F32', 'F16'), (key, view.get_dtype())
            shape = view.get_shape()
            count = math.prod(shape) * 4
            if group and size + count > 256_000_000:
                groups.append(group)
                group, size = [], 0
            group.append((key, shape, count))
            size += count
            total += count
        if group:
            groups.append(group)
        for group in groups:
            name = f'model-{len(files) + 1:05d}.safetensors'
            header = {'__metadata__': {'format': 'pt'}}
            offset = 0
            for key, shape, count in group:
                header[key] = dict(dtype='F32', shape=shape, data_offsets=[offset, offset + count])
                offset += count
            encoded = json.dumps(header, separators=(',', ':')).encode()
            encoded += b' ' * (-len(encoded) % 8)
            with (dest / name).open('wb') as stream:
                stream.write(struct.pack('<Q', len(encoded)))
                stream.write(encoded)
                for key, shape, count in group:
                    view = source.get_slice(key)
                    rows = max(1, 8_000_000 // max(1, math.prod(shape[1:])))
                    for first in range(0, shape[0] if shape else 1, rows):
                        tensor = view[first:first + rows] if shape else source.get_tensor(key)
                        if key in pairs:
                            a, b = pairs[key]
                            delta = (b[first:first + rows].float() @ a.float()) * scale
                            assert tensor.shape == delta.shape
                            tensor = (tensor.float() + delta).to(tensor.dtype)
                            used.add(key)
                            if first == 0 and len(checks) < 3:
                                checks.append(dict(key=key, firstChunkDeltaNorm=delta.norm().item()))
                        tensor = tensor.float().contiguous()
                        assert torch.isfinite(tensor).all(), key
                        stream.write(tensor.numpy().tobytes())
                    weightmap[key] = name
            files.append(name)
            print(f'Wrote {name}', flush=True)
    assert used == set(pairs)
    for name in ('config.json', 'generation_config.json', 'tokenizer.json',
                 'tokenizer_config.json', 'chat_template.jinja', 'processor_config.json'):
        shutil.copyfile(BASE / name, dest / name)
    cfg = json.loads((dest / 'config.json').read_text())
    cfg['dtype'] = 'float32'
    for name in ('text_config', 'audio_config', 'vision_config'):
        if name in cfg:
            cfg[name]['dtype'] = 'float32'
    save(dest / 'config.json', cfg)
    save(dest / 'model.safetensors.index.json', dict(metadata=dict(total_size=total), weight_map=weightmap))
    save(OUT / 'merge-manifest.json', dict(
        baseRevision='3e22461f65e89153144f8adb70e3b8c2cc9845a7',
        baseSha256=sha(BASE / 'model.safetensors'),
        adapterSha256=sha(TOP / 'reduced/adapter/adapter_model.safetensors'),
        interface='reduced', loraModules=len(pairs), tensors=len(weightmap),
        totalBytes=total, seconds=time.time() - started, numericalChecks=checks,
        files={name: sha(dest / name) for name in files},
        rounding='BF16 merge, promoted to FP32 for memory-mapped conversion',
        evaluated=False))


def convert():
    import psutil
    assert (OUT / 'merge-manifest.json').exists()
    dest = OUT / 'mobile-export'
    dest.mkdir(exist_ok=True)
    if any(dest.iterdir()):
        raise RuntimeError('Refusing to overwrite existing converter outputs.')
    template = ROOT / '.tools/finetune/gemma4-e2b-v1/export-research/mobile-chat-template.jinja'
    command = [str(PYTHON), str(ROOT / 'scripts/gemma-v2-export-runner.py'),
        '--model=' + str(OUT / 'merged-fp32'), '--output_dir=' + str(dest),
        '--task=text_generation', '--prefill_lengths=128', '--cache_length=16384',
        '--externalize_embedder=True', '--jinja_chat_template_override=' + str(template),
        '--quantization_recipe=dynamic_wi8_emb4_afp32', '--moe_exports_implementation=eager',
        '--experimental_lightweight_conversion=True']
    env = dict(os.environ, CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='4', MKL_NUM_THREADS='4',
               HF_HUB_OFFLINE='1', TOKENIZERS_PARALLELISM='false')
    record = dict(command=command, startedAt=time.time(), samples=[],
                  templateSha256=sha(template), androidLoadTested=False)
    low_since = None
    with (OUT / 'conversion.log').open('w') as log:
        process = subprocess.Popen(command, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT)
        record['pid'] = process.pid
        while process.poll() is None:
            mem = psutil.virtual_memory()
            swap = psutil.swap_memory()
            try:
                parent = psutil.Process(process.pid)
                rss = sum(p.memory_info().rss for p in [parent] + parent.children(recursive=True))
            except psutil.NoSuchProcess:
                rss = 0
            sample = dict(time=time.time(), rssMiB=rss / 2**20,
                          availableMiB=mem.available / 2**20, swapFreeMiB=swap.free / 2**20)
            record['samples'].append(sample)
            low = mem.available < 768 * 2**20 or swap.free < 1024 * 2**20
            low_since = (low_since or time.time()) if low else None
            reason = ('memory reserve' if low_since and time.time() - low_since > 3 else
                      '60 minute conversion limit' if time.time() - record['startedAt'] > 3600 else '')
            if reason:
                record['stoppedReason'] = reason
                process.terminate()
                try:
                    process.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
            save(OUT / 'conversion-status.json', {k: v for k, v in record.items() if k != 'samples'} | sample)
            time.sleep(1)
        record['exitCode'] = process.returncode
    record['seconds'] = time.time() - record['startedAt']
    record['bundles'] = [dict(path=str(p), bytes=p.stat().st_size, sha256=sha(p))
                         for p in dest.glob('*.litertlm')]
    record['conversionSucceeded'] = process.returncode == 0 and bool(record['bundles'])
    save(OUT / 'export-manifest.json', record)
    print(json.dumps({k: v for k, v in record.items() if k != 'samples'}, indent=2))
    if not record['conversionSucceeded']:
        raise SystemExit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('prepare', 'convert'))
    args = parser.parse_args()
    {'prepare': prepare, 'convert': convert}[args.action]()
