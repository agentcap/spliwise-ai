#!/usr/bin/env python3
"""Format native sources using a pinned, verified ktfmt release."""
import hashlib
from pathlib import Path
import subprocess
import urllib.request
root = Path(__file__).resolve().parent.parent
directory = root / '.tools/android/format'
directory.mkdir(exist_ok=True)
url = 'https://repo.maven.apache.org/maven2/com/facebook/ktfmt/0.64/ktfmt-0.64-with-dependencies.jar'
jar = directory / 'ktfmt.jar'
with urllib.request.urlopen(url + '.sha1') as response:
    checksum = response.read().decode().split()[0]
if not jar.exists():
    with urllib.request.urlopen(url) as response:
        jar.write_bytes(response.read())
assert hashlib.sha1(jar.read_bytes()).hexdigest() == checksum, 'Formatter checksum mismatch'
sources = []
for module in ['app', 'ledger', 'assistant', 'model-check']:
    sources.extend((root / 'android' / module / 'src').rglob('*.kt'))
sources.extend((root / 'android').glob('*.kts'))
sources.extend((root / 'android').glob('*/build.gradle.kts'))
subprocess.run([str(root / '.tools/android/jdk21/bin/java'), '-jar', str(jar), '--kotlinlang-style', *map(str, sources)], check=True)
