#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
task_root="$PWD"
task_model="$task_root/.tools/android/releases/gemma-v2-mobile/splitwise-gemma4-e2b-v2-reduced.litertlm"
task_runtime="$task_root/.tools/finetune/web-model"
if [[ ! -f "$task_model" ]]; then
  echo "The converted fine-tuned model is missing. See docs/gemma4-web-model.md." >&2
  exit 1
fi
mkdir -p "$task_runtime"
chmod 700 "$task_runtime"
python3 - <<'PY'
import os, secrets
from pathlib import Path
path = Path('.tools/finetune/web-model/token')
if not path.exists():
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as stream:
        stream.write(secrets.token_hex(32) + '\n')
path.chmod(0o600)
PY
bash scripts/android-build.sh :model-check:installDist
export JAVA_HOME="$task_root/.tools/android/jdk21"
exec android/model-check/build/install/model-check/bin/model-check --serve-web \
  "$task_root" "$task_model" "$task_runtime/token" "${FINETUNED_MODEL_PORT:-8766}"
