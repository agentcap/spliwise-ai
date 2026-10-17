#!/usr/bin/env python3
"""Install the Java 21 runtime required by LiteRT-LM's desktop verification library."""
import hashlib
from pathlib import Path
import shutil
import tarfile
import urllib.request
root = Path(__file__).resolve().parent.parent / '.tools/android'
if not (root / 'jdk21/bin/java').exists():
    url = 'https://aka.ms/download-jdk/microsoft-jdk-21.0.12.1-linux-x64.tar.gz'
    with urllib.request.urlopen(url + '.sha256sum.txt') as response:
        checksum = response.read().decode().split()[0]
    path = root / 'jdk21.tar.gz'
    with urllib.request.urlopen(url, timeout=120) as response, path.open('wb') as target:
        shutil.copyfileobj(response, target)
    with path.open('rb') as source:
        assert hashlib.file_digest(source, 'sha256').hexdigest() == checksum, 'JDK checksum mismatch'
    with tarfile.open(path) as bundle:
        top = bundle.getnames()[0].split('/')[0]
        bundle.extractall(root, filter='data')
    (root / top).rename(root / 'jdk21')
    path.unlink()
print(root / 'jdk21')
