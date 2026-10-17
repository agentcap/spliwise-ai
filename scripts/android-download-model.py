#!/usr/bin/env python3
"""Download pinned model files for optional desktop inference verification."""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
root = Path(__file__).resolve().parent.parent
models = json.loads((root / 'android/app/src/main/assets/models.json').read_text())
directory = root / '.tools/android/models'
directory.mkdir(exist_ok=True)
for model in models:
    if len(sys.argv) > 1 and model['id'] not in sys.argv[1:]:
        continue
    path = directory / model['filename']
    if not path.exists():
        partial = path.with_suffix('.partial')
        subprocess.run(['curl', '--fail', '--location', '--retry', '3', '--continue-at', '-', '--output', str(partial), model['url']], check=True)
        with partial.open('rb') as source:
            digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if digest != model['sha256']:
            partial.unlink()
            raise RuntimeError('Model checksum mismatch')
        partial.rename(path)
    print(model['id'], path, flush=True)
