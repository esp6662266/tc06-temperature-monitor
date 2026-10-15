$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$python = Join-Path $root '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { throw 'Run scripts\Setup-Windows.ps1 first.' }
& $python -m pip install -r requirements-dev.txt
if ($LASTEXITCODE -ne 0) { throw 'Build dependency installation failed.' }
& $python -m pytest -q
if ($LASTEXITCODE -ne 0) { throw 'Python checks failed.' }
& $python -m PyInstaller --noconfirm --clean --onedir --windowed --name TC06Monitor --paths collector --add-data 'collector\speech.ps1;.' collector\app.py
if ($LASTEXITCODE -ne 0) { throw 'Windows build failed.' }
Get-FileHash dist\TC06Monitor\TC06Monitor.exe -Algorithm SHA256
Write-Host 'Copy the entire dist\TC06Monitor folder. Tesseract and the Korean female voice remain separate prerequisites.'
