#!/usr/bin/env python3
"""Register and stage the converted experimental adapter for Android testing."""
import hashlib
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / '.tools/finetune/gemma4-e2b-v2/android'
RELEASE = ROOT / '.tools/android/releases/gemma-v2-mobile'
MODEL_NAME = 'splitwise-gemma4-e2b-v2-reduced.litertlm'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    pack = json.loads((OUT / 'pack-stage.json').read_text())
    model = Path(pack['litert_lm_model_path'])
    assert model.is_relative_to(OUT) and model.is_file()
    merge = json.loads((OUT / 'merge-manifest.json').read_text())
    adapter = OUT.parent / 'reduced/adapter/adapter_model.safetensors'
    assert digest(adapter) == merge['adapterSha256']
    sha = digest(model)
    entry = dict(id='e2b-v2-reduced', name='Gemma E2B fine-tuned v2 (experimental)',
                 filename=MODEL_NAME, url='', sha256=sha, size=model.stat().st_size,
                 license='Apache-2.0', source='Local Gemma E2B v2 reduced adapter experiment',
                 toolInterface='reduced-v2')
    path = ROOT / 'android/app/src/main/assets/models.json'
    models = json.loads(path.read_text())
    models = [entry] + [m for m in models if m['id'] != entry['id']]
    path.write_text(json.dumps(models, indent=2) + '\n')
    RELEASE.mkdir(parents=True, exist_ok=True)
    dest = RELEASE / MODEL_NAME
    if dest.exists():
        assert digest(dest) == sha, 'Refusing to overwrite another mobile model'
    else:
        os.link(model, dest)
    manifest = dict(model=entry, adapterSha256=merge['adapterSha256'],
                    baseRevision=merge['baseRevision'],
                    quantization='INT8 fully-connected weights, INT4 embeddings, FP32 activations',
                    contextTokens=16384, physicalPhoneTested=False,
                    metadataCompatibilityFix='https://github.com/google-ai-edge/litert-torch/issues/1329')
    (RELEASE / 'model-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    print(json.dumps(entry, indent=2))


if __name__ == '__main__':
    main()
