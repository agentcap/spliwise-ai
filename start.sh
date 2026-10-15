#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
bash scripts/bootstrap.sh
export PATH="$PWD/.tools/node/bin:$PATH"
if [[ ! -d node_modules ]]; then npm ci; fi
if [[ "$*" == '--production' ]]; then
  npm run build
  exec npm start
fi
exec npm run dev
