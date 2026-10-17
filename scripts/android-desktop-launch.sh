#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
adb="$root/.tools/android/sdk/platform-tools/adb"
apk="$root/android/app/build/outputs/apk/debug/app-debug.apk"
serial=emulator-5554
logs="$root/.tools/android/desktop"
mkdir -p "$logs"
[[ -f "$apk" ]] || { echo 'Build the Android app first.' >&2; exit 1; }
python3 scripts/android-desktop-prepare.py
"$adb" start-server
if ! "$adb" -s "$serial" get-state >/dev/null 2>&1; then
  echo 'Opening the Android desktop window...'
  if [[ -r /dev/kvm && -w /dev/kvm ]]; then
    nohup bash "$root/scripts/android-emulator.sh" --desktop > "$logs/emulator.log" 2>&1 < /dev/null &
  elif [[ -n "${WSL_DISTRO_NAME:-}" ]]; then
    # Apply the KVM group to this emulator process, without changing account membership.
    nohup wsl.exe -d "$WSL_DISTRO_NAME" -u root -- runuser -u "$(id -un)" -g kvm -- bash "$root/scripts/android-emulator.sh" --desktop > "$logs/emulator.log" 2>&1 < /dev/null &
  else
    echo 'KVM access is required. Give this account access to /dev/kvm and try again.' >&2
    exit 1
  fi
fi
ready=false
for ((attempt=0; attempt<120; attempt++)); do
  if [[ "$("$adb" -s "$serial" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == 1 ]]; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || { echo "Emulator startup failed. See $logs/emulator.log" >&2; exit 1; }
avd="$("$adb" -s "$serial" emu avd name | head -n 1 | tr -d '\r')"
[[ "$avd" == splitwise-test ]] || { echo "Port 5554 is occupied by another emulator ($avd)." >&2; exit 1; }
"$adb" -s "$serial" install -r "$apk"
python3 scripts/android-desktop-model.py --serial "$serial"
"$adb" -s "$serial" shell am start -n com.splitwiseai.app/.MainActivity
echo 'Splitwise AI is open. Use your mouse and keyboard in the Android Emulator window.'
echo 'The emulator keeps its workspace when you close and reopen it.'
