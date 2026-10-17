#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="$PWD/.tools/android/jdk"
export ANDROID_HOME="$PWD/.tools/android/sdk"
export GRADLE_USER_HOME="$PWD/.tools/android/gradle-home"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
if [[ ! -x "$JAVA_HOME/bin/java" ]]; then
  python3 scripts/android-bootstrap.py
fi
cd android
exec bash gradlew "${@:-assembleDebug}"
