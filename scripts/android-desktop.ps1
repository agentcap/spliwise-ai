$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path -Parent $PSScriptRoot
if ($taskRoot -match '^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)\\(.*)$') {
    $taskDistro = $Matches[1]
    $taskLinuxRoot = '/' + $Matches[2].Replace('\', '/')
} else {
    $taskDistro = 'Ubuntu'
    $taskLinuxRoot = (& wsl.exe -d $taskDistro -- wslpath -u $taskRoot).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not locate this project in Ubuntu.' }
}
& wsl.exe -d $taskDistro -- bash "$taskLinuxRoot/scripts/android-desktop-launch.sh"
if ($LASTEXITCODE -ne 0) { throw 'The desktop app could not be opened. Check the message above.' }
