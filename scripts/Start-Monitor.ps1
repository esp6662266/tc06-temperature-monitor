param([switch]$AutoStart)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$extra = @()
if ($AutoStart) { $extra += '--autostart' }
$exe = Join-Path $root 'dist\TC06Monitor\TC06Monitor.exe'
if (Test-Path $exe) { & $exe @extra }
else {
    $python = Join-Path $root '.venv\Scripts\python.exe'
    if (-not (Test-Path $python)) { throw 'Run scripts\Setup-Windows.ps1 first.' }
    & $python collector\app.py @extra
}
