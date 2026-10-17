#!/usr/bin/env python3
"""Load an already downloaded, checksum-verified model into the project emulator."""
import argparse
import hashlib
import json
from pathlib import Path
import shlex
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--serial', default='emulator-5554')
parser.add_argument('--model', choices=['e4b', 'e2b'], default='e4b')
args = parser.parse_args()
root = Path(__file__).resolve().parent.parent
adb = str(root / '.tools/android/sdk/platform-tools/adb')
command = [adb, '-s', args.serial]
package = 'com.splitwiseai.app'

def shell(script):
    return subprocess.check_output([*command, 'shell', script], text=True).strip()

if shell('getprop ro.kernel.qemu') != '1':
    raise SystemExit('Model preload is restricted to an Android emulator.')
models = json.loads((root / 'android/app/src/main/assets/models.json').read_text())
model = next(m for m in models if m['id'] == args.model)
label = model['name']
filename = model['filename']
assert Path(filename).name == filename
source = root / '.tools/android/models' / filename
if not source.exists():
    print(f'Download {label} in the app settings to enable this model.')
    raise SystemExit(0)
target = f'no_backup/models/{filename}'
qtarget = shlex.quote(target)
check = shell(f"run-as {package} sh -c {shlex.quote(f'cat {qtarget}.verified 2>/dev/null; echo; stat -c %s {qtarget} 2>/dev/null; true')}")
if [line for line in check.splitlines() if line] == [model['sha256'], str(model['size'])]:
    canonical = f'printf "%s" {shlex.quote(model["sha256"])} > {qtarget}.verified && chmod 600 {qtarget} {qtarget}.verified'
    shell(f'run-as {package} sh -c {shlex.quote(canonical)}')
    print(f'{label} is already available in the emulator.')
    raise SystemExit(0)
assert source.stat().st_size == model['size'], 'Local model size mismatch'
with source.open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == model['sha256'], 'Local model checksum mismatch'
shell(f'run-as {package} mkdir -p no_backup/models')
print(f'Copying the local {label} model into the emulator...', flush=True)
remote = f'run-as {package} sh -c {shlex.quote(f"cat > {qtarget}.partial")}'
with source.open('rb') as stream:
    subprocess.run([*command, 'shell', '-T', remote], stdin=stream, check=True)
actual = shell(f'run-as {package} sha256sum {qtarget}.partial').split()[0]
assert actual == model['sha256'], 'Emulator model checksum mismatch'
finish = f'mv {qtarget}.partial {qtarget} && printf "%s" {shlex.quote(actual)} > {qtarget}.verified && chmod 600 {qtarget} {qtarget}.verified'
shell(f'run-as {package} sh -c {shlex.quote(finish)}')
print(f'{label} is verified and ready for offline use.')
