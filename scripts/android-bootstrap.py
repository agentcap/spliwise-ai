#!/usr/bin/env python3
"""Install a checksum-verified, project-local Android toolchain (run in WSL)."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parent.parent
TOOLS = ROOT / '.tools' / 'android'
TOOLS.mkdir(parents=True, exist_ok=True)

def fetch(url):
    with urllib.request.urlopen(url, timeout=120) as response:
        return response.read()

def download(url, target, checksum, algorithm='sha256'):
    if target.exists() and hashlib.new(algorithm, target.read_bytes()).hexdigest() == checksum:
        return
    print('Downloading', target.name, flush=True)
    temporary = target.with_suffix(target.suffix + '.partial')
    with urllib.request.urlopen(url, timeout=120) as source, temporary.open('wb') as out:
        shutil.copyfileobj(source, out)
    if hashlib.new(algorithm, temporary.read_bytes()).hexdigest() != checksum:
        temporary.unlink()
        raise RuntimeError('Checksum mismatch: ' + target.name)
    temporary.replace(target)

def archive(package, host):
    for item in package.findall('./archives/archive'):
        if item.findtext('host-os') == host:
            complete = item.find('complete')
            return complete.findtext('url'), complete.findtext('checksum')
    raise RuntimeError('Missing archive for ' + host)

if not (TOOLS / 'jdk' / 'bin' / 'java').exists():
    url = 'https://aka.ms/download-jdk/microsoft-jdk-17.0.20.1-linux-x64.tar.gz'
    checksum = fetch(url + '.sha256sum.txt').decode().split()[0]
    path = TOOLS / 'jdk.tar.gz'
    download(url, path, checksum)
    with tarfile.open(path) as bundle:
        top = bundle.getnames()[0].split('/')[0]
        bundle.extractall(TOOLS, filter='data')
    (TOOLS / top).rename(TOOLS / 'jdk')
    path.unlink()

metadata = ET.fromstring(fetch('https://dl.google.com/android/repository/repository2-3.xml'))
packages = {p.attrib['path']: p for p in metadata.findall('remotePackage')}
sdk = TOOLS / 'sdk'
sdk.mkdir(exist_ok=True)
if not (sdk / 'cmdline-tools' / 'latest' / 'bin' / 'sdkmanager').exists():
    candidates = [p for name, p in packages.items() if name.startswith('cmdline-tools;') and p.findtext('channelRef', '') != 'channel-3']
    stable = [p for p in candidates if p.find('revision/preview') is None]
    package = max(stable, key=lambda p: int(p.findtext('revision/major', '0')))
    name, checksum = archive(package, 'linux')
    path = TOOLS / 'commandline.zip'
    download('https://dl.google.com/android/repository/' + name, path, checksum, 'sha1')
    target = TOOLS / 'unpacked-cli'
    with zipfile.ZipFile(path) as bundle:
        bundle.extractall(target)
    (sdk / 'cmdline-tools').mkdir(exist_ok=True)
    shutil.move(str(target / 'cmdline-tools'), sdk / 'cmdline-tools' / 'latest')
    shutil.rmtree(target)
    path.unlink()
    for executable in (sdk / 'cmdline-tools' / 'latest' / 'bin').iterdir():
        executable.chmod(0o755)

env = dict(os.environ, JAVA_HOME=str(TOOLS / 'jdk'), ANDROID_HOME=str(sdk))
env['PATH'] = str(TOOLS / 'jdk' / 'bin') + ':' + env['PATH']
manager = str(sdk / 'cmdline-tools' / 'latest' / 'bin' / 'sdkmanager')
subprocess.run([manager, '--licenses'], input='y\n' * 100, text=True, env=env, check=True, stdout=subprocess.DEVNULL)
subprocess.run([manager, 'platform-tools', 'platforms;android-37', 'build-tools;36.0.0'], env=env, check=True)

windows = TOOLS / 'windows'
if not (windows / 'platform-tools' / 'adb.exe').exists():
    name, checksum = archive(packages['platform-tools'], 'windows')
    path = TOOLS / 'windows-platform-tools.zip'
    download('https://dl.google.com/android/repository/' + name, path, checksum, 'sha1')
    with zipfile.ZipFile(path) as bundle:
        bundle.extractall(windows)
    path.unlink()
print('Android toolchain ready:', TOOLS, flush=True)
