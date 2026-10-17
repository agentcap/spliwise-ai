#!/usr/bin/env python3
"""Keep optional Ubuntu emulator-window libraries inside the project."""
import os
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent.parent
downloads = root / '.tools/android/gui-packages'
libraries = root / '.tools/android/gui-libs'
downloads.mkdir(parents=True, exist_ok=True)
libraries.mkdir(parents=True, exist_ok=True)
requested = ['libpulse0', 'libxcb-cursor0', 'libxcb-icccm4', 'libxcb-keysyms1', 'libxkbcommon-x11-0']
environment = {**os.environ, 'LC_ALL': 'C'}
simulation = subprocess.check_output(
    ['apt-get', '--simulate', 'install', '--no-install-recommends', *requested],
    text=True, env=environment,
)
packages = re.findall(r'^Inst ([^ ]+)(?: \[[^]]+\])? \(([^ ]+)', simulation, re.MULTILINE)
if packages:
    subprocess.run(['apt-get', 'download', *[f'{name}={version}' for name, version in packages]],
                   cwd=downloads, env=environment, check=True)
    for archive in sorted(downloads.glob('*.deb')):
        subprocess.run(['dpkg-deb', '-x', str(archive), str(libraries)], check=True)
print('Desktop emulator libraries are ready.')
