#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME="$PWD/.tools/android/jdk"
export ANDROID_HOME="$PWD/.tools/android/sdk"
export ANDROID_USER_HOME="$PWD/.tools/android/user"
export ANDROID_AVD_HOME="$PWD/.tools/android/avd"
export XDG_RUNTIME_DIR="$PWD/.tools/android/runtime"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
if [[ -d "$PWD/.tools/android/gui-libs" ]]; then
  gui="$PWD/.tools/android/gui-libs/usr/lib/x86_64-linux-gnu"
  export LD_LIBRARY_PATH="$gui:$gui/pulseaudio:${LD_LIBRARY_PATH:-}"
fi
mkdir -p "$ANDROID_USER_HOME" "$ANDROID_AVD_HOME" "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
if [[ ! -d "$ANDROID_AVD_HOME/splitwise-test.avd" ]]; then
  printf 'no\n' | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n splitwise-test -k 'system-images;android-36;google_apis;x86_64' -d pixel_8
fi
"$ANDROID_HOME/platform-tools/adb" start-server
mode="${1:---headless}"
qemu=()
case "$mode" in
  --headless)
    window=(-no-window)
    memory="${ANDROID_TEST_MEMORY:-2048}"
    cores="${ANDROID_TEST_CORES:-2}"
    ;;
  --desktop)
    export QT_QPA_PLATFORM=xcb
    window=(-no-skin -no-nested-warnings)
    sed -i 's/^hw.keyboard=.*/hw.keyboard=yes/' "$ANDROID_AVD_HOME/splitwise-test.avd/config.ini"
    memory="${ANDROID_TEST_MEMORY:-8192}"
    cores="${ANDROID_TEST_CORES:-6}"
    if [[ "${ANDROID_TEST_ACCEL:-auto}" != off ]]; then
      qemu=(-qemu -cpu host)
    fi
    ;;
  *) printf 'Usage: %s [--headless|--desktop]\n' "$0" >&2; exit 2 ;;
esac
exec "$ANDROID_HOME/emulator/emulator" -avd splitwise-test "${window[@]}" -no-audio -no-boot-anim -no-snapshot -gpu swiftshader -feature -Vulkan -memory "$memory" -cores "$cores" -accel "${ANDROID_TEST_ACCEL:-auto}" -no-metrics "${qemu[@]}"
