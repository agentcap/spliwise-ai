#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -x .tools/node/bin/node ]]; then
  mkdir -p .tools/download
  cd .tools/download
  curl --fail --location --retry 3 --output SHASUMS256.txt https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
  archive=$(awk '/ node-v24.*-linux-x64.tar.xz$/ {print $2; exit}' SHASUMS256.txt)
  [[ "$archive" =~ ^node-v24\.[0-9]+\.[0-9]+-linux-x64\.tar\.xz$ ]] || { echo 'Unexpected Node release filename'; exit 1; }
  curl --fail --location --retry 3 --output "$archive" "https://nodejs.org/dist/latest-v24.x/$archive"
  grep " $archive$" SHASUMS256.txt | sha256sum --check
  mkdir -p ../node
  tar -xJf "$archive" -C ../node --strip-components=1
  cd ../..
fi
export PATH="$PWD/.tools/node/bin:$PATH"
node --version
npm --version
