$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if (-not (Get-Command py -ErrorAction SilentlyContinue)) { throw 'Install official Python 3.12 (with Tcl/Tk and py launcher) first: https://www.python.org/downloads/windows/' }
& py -3.12 -m venv .venv
if ($LASTEXITCODE -ne 0) { throw 'Python 3.12 is required.' }
& .\.venv\Scripts\python.exe -m pip install -r requirements.txt
if ($LASTEXITCODE -ne 0) { throw 'Python dependency installation failed.' }
$tesseract = Join-Path $env:ProgramFiles 'Tesseract-OCR\tesseract.exe'
if (-not (Test-Path $tesseract)) { Write-Warning 'Install Tesseract separately or specify its path in the GUI. See docs/WINDOWS_HANDOFF.md.' }
Write-Host 'Setup complete. Run scripts\Start-Monitor.ps1. No server deployment was performed.'
