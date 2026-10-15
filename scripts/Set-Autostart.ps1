param([switch]$Enable, [switch]$Disable)
$ErrorActionPreference = 'Stop'
if ($Enable -eq $Disable) { throw 'Specify exactly one of -Enable or -Disable.' }
$root = Split-Path -Parent $PSScriptRoot
$link = Join-Path ([Environment]::GetFolderPath('Startup')) 'TC06Monitor.lnk'
if ($Disable) { Remove-Item -LiteralPath $link -ErrorAction SilentlyContinue; Write-Host 'Autostart removed.'; exit }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shortcut.Arguments = '-NoProfile -File "' + (Join-Path $PSScriptRoot 'Start-Monitor.ps1') + '" -AutoStart'
$shortcut.WorkingDirectory = $root
$shortcut.Save()
Write-Host 'Autostart added for this Windows user. Save the server URL and capture source in the GUI first. No keys or login are required.'
