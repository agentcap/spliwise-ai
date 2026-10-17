#!/usr/bin/env python3
"""Refresh official Gradle wrapper and pin the two curated mobile model artifacts."""
import hashlib
import json
from pathlib import Path
import urllib.request

root = Path(__file__).resolve().parent.parent
android = root / 'android'
def get(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()

version = '9.3.1'
for name in ['gradlew', 'gradlew.bat', 'gradle/wrapper/gradle-wrapper.jar']:
    target = android / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(get(f'https://raw.githubusercontent.com/gradle/gradle/v{version}/{name}'))
checksum = get(f'https://services.gradle.org/distributions/gradle-{version}-bin.zip.sha256').decode().strip()
(android / 'gradle/wrapper/gradle-wrapper.properties').write_text(
    'distributionBase=GRADLE_USER_HOME\ndistributionPath=wrapper/dists\n'
    f'distributionUrl=https\\://services.gradle.org/distributions/gradle-{version}-bin.zip\n'
    f'distributionSha256Sum={checksum}\nnetworkTimeout=120000\nvalidateDistributionUrl=true\n'
    'zipStoreBase=GRADLE_USER_HOME\nzipStorePath=wrapper/dists\n')
models = []
for size in ['E2B', 'E4B']:
    repository = f'litert-community/gemma-4-{size}-it-litert-lm'
    metadata = json.loads(get(f'https://huggingface.co/api/models/{repository}?blobs=true'))
    filename = f'gemma-4-{size}-it.litertlm'
    file = next(item for item in metadata['siblings'] if item['rfilename'] == filename)
    models.append(dict(id=size.lower(), name=f'Gemma 4 {size}', filename=filename,
                       url=f'https://huggingface.co/{repository}/resolve/{metadata["sha"]}/{filename}',
                       sha256=file['lfs']['sha256'], size=file['lfs']['size'], license='Apache-2.0',
                       source=f'https://huggingface.co/{repository}'))
assets = android / 'app/src/main/assets'
assets.mkdir(exist_ok=True)
(assets / 'models.json').write_text(json.dumps(models, indent=2) + '\n')
print('Pinned wrapper and model catalog.')
