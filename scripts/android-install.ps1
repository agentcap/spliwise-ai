param([string]$DeviceSerial = "", [string]$Apk = "")
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
$taskAdb = Join-Path $taskRoot '.tools/android/windows/platform-tools/adb.exe'
if (-not (Test-Path -LiteralPath $taskAdb)) { throw 'Run python3 scripts/android-bootstrap.py in Ubuntu first.' }
if (-not $Apk) { $Apk = Join-Path $taskRoot 'android/app/build/outputs/apk/debug/app-debug.apk' }
if (-not (Test-Path -LiteralPath $Apk)) { throw 'Build the APK with bash scripts/android-build.sh first.' }
$taskLines = & $taskAdb devices
if (-not $DeviceSerial) {
    $taskDevices = @($taskLines | Where-Object { $_ -match '^\S+\s+device$' } | ForEach-Object { ($_ -split '\s+')[0] })
    if ($taskDevices.Count -ne 1) { throw 'Connect and unlock your phone, enable USB debugging, and accept its computer authorization prompt. If multiple devices are connected, pass -DeviceSerial SERIAL.' }
    $DeviceSerial = $taskDevices[0]
}
& $taskAdb -s $DeviceSerial install -r $Apk
if ($LASTEXITCODE -ne 0) { throw 'Installation failed. Existing app data has been retained.' }
& $taskAdb -s $DeviceSerial shell am start -n 'com.splitwiseai.app/.MainActivity'
if ($LASTEXITCODE -ne 0) { throw 'The app installed but could not be launched.' }
Write-Host 'Splitwise AI is installed. Open Settings in the app to download Gemma 4 E4B, then restore your workspace.'
