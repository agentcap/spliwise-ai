#!/usr/bin/env python3
"""Keep finite, mapped checkpoint weights read-only during LiteRT lowering.

The installed converter clamps every floating constant in place. For finite
checkpoint parameters that is an identity operation, but writes private copies
of the entire memory-mapped model. Skip only that proven identity operation for
the hash-verified parameters; keep the converter's handling of generated masks
and all other constants. Drop dead constant nodes before materializing them.
No installed library files are modified.
"""
import hashlib
import json
from pathlib import Path
import runpy

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.tools/finetune/gemma4-e2b-v2/android'
manifest = json.loads((OUT / 'merge-manifest.json').read_text())
assert manifest['rounding'] == 'BF16 merge, promoted to FP32 for memory-mapped conversion'
for name, expected in manifest['files'].items():
    with (OUT / 'merged-fp32' / name).open('rb') as stream:
        assert hashlib.file_digest(stream, 'sha256').hexdigest() == expected, name

from litert_torch.backend import inline_consts
from litert_torch.generative.export_hf.core import export_lib

original_load = export_lib.load_model
original_clamp = inline_consts._clamp_inf_values
original_inline = inline_consts.inline_consts
parameters = []
verified_storages = set()


def fingerprint(tensor):
    return (tensor.untyped_storage().data_ptr(), tensor.storage_offset(),
            tuple(tensor.shape), tuple(tensor.stride()), tensor.dtype)


def load(*args, **kwargs):
    artifacts = original_load(*args, **kwargs)
    # Retain references to prevent allocator pointer reuse during conversion.
    parameters.extend(artifacts.model.parameters())
    verified_storages.update(fingerprint(p) for p in parameters)
    print(f'Preserving {len(verified_storages)} verified parameter mappings.', flush=True)
    return artifacts


def clamp(tensor):
    if fingerprint(tensor) in verified_storages:
        return tensor
    return original_clamp(tensor)


def constants(program):
    original_inline(program)
    before = len(list(program.graph.nodes))
    program.graph.eliminate_dead_code()
    print(f'Removed {before - len(list(program.graph.nodes))} unused graph nodes before constant lowering.', flush=True)


export_lib.load_model = load
inline_consts._clamp_inf_values = clamp
inline_consts.inline_consts = constants
if __name__ == '__main__':
    runpy.run_module('litert_torch.generative.export_hf', run_name='__main__')
