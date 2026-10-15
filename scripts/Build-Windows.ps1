param([string]$Python = '', [switch]$Installer)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
if ($env:OS -ne 'Windows_NT') { throw 'Build on 64-bit Windows.' }
if (-not $Python) { $Python = Join-Path $root '.venv\Scripts\python.exe' }
New-Item -ItemType Directory -Force dist\release, build\downloads | Out-Null
$release = Join-Path $root 'dist\release'
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version

function Download-Verified($item, $target) {
    if (-not (Test-Path $target)) { Invoke-WebRequest -Uri $item.url -OutFile $target }
    if ((Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant() -ne $item.sha256) {
        throw "Download checksum mismatch: $target"
    }
}
function Run-Checked($exe, $arguments, $seconds = 180) {
    $process = Start-Process -FilePath $exe -ArgumentList $arguments -PassThru
    if (-not $process.WaitForExit($seconds * 1000)) {
        Stop-Process -Id $process.Id -Force
        throw "Timed out: $exe"
    }
    if ($process.ExitCode -ne 0) { throw "Process failed ($($process.ExitCode)): $exe" }
}

try {
    & $Python -m pip install -r requirements-dev.txt 'pyinstaller==6.22.3'
    if ($LASTEXITCODE -ne 0) { throw 'Build dependency installation failed.' }
    $deps = Get-Content packaging\windows-deps.json -Raw | ConvertFrom-Json
    $download = Join-Path $root 'build\downloads\tesseract.exe'
    $eng = Join-Path $root 'build\downloads\eng.traineddata'
    Download-Verified $deps.tesseract $download
    Download-Verified $deps.eng $eng
    $seven = Join-Path $env:ProgramFiles '7-Zip\7z.exe'
    if (-not (Test-Path $seven)) { throw 'Build prerequisite: 7-Zip is required.' }
    $unpacked = Join-Path $root 'build\ocr-upstream'
    & $seven x -y "-o$unpacked" $download | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'OCR extraction failed.' }
    New-Item -ItemType Directory -Force "$unpacked\tessdata" | Out-Null
    Copy-Item $eng "$unpacked\tessdata\eng.traineddata" -Force
    $env:TESSDATA_PREFIX = "$unpacked\tessdata"
    $env:PATH = "$unpacked;$env:PATH"
    & $Python -m pytest -q --junitxml=dist/release/python-tests.xml
    if ($LASTEXITCODE -ne 0) { throw 'Python checks failed.' }
    & $Python -m PyInstaller --noconfirm --clean --onedir --windowed --name TC06Monitor --paths collector --hidden-import tc06.selftest collector\app.py
    if ($LASTEXITCODE -ne 0) { throw 'Windows executable build failed.' }
    $bundle = Join-Path $root 'dist\TC06Monitor'
    $ocr = Join-Path $bundle 'ocr'
    New-Item -ItemType Directory -Force "$ocr\tessdata" | Out-Null
    Copy-Item "$unpacked\tesseract.exe", "$unpacked\*.dll" $ocr
    Copy-Item "$unpacked\doc" "$ocr\doc" -Recurse
    Copy-Item $eng "$ocr\tessdata\eng.traineddata"
    Copy-Item packaging\windows-deps.json "$bundle\runtime-origins.json"
    Copy-Item README.md, docs\WINDOWS_INSTALL.md, packaging\THIRD_PARTY.md $bundle
    & $Python scripts\collect-licenses.py "$bundle\licenses"
    if ($LASTEXITCODE -ne 0) { throw 'License collection failed.' }

    if ($Installer) {
        $iscc = Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
        if (-not (Test-Path $iscc)) { throw 'Build prerequisite: Inno Setup 6 is required.' }
        & $iscc "/DAppVersion=$version" packaging\windows.iss
        if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
    }

    $previousPath = $env:PATH
    $previousLocal = $env:LOCALAPPDATA
    $previousHome = $env:PYTHONHOME
    $previousPythonPath = $env:PYTHONPATH
    $previousData = $env:TESSDATA_PREFIX
    $scratch = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { $env:TEMP }
    $testRoot = Join-Path $scratch ('tc06-installed-' + [Guid]::NewGuid().ToString('N'))
    try {
        # No installed Python or OCR may resolve during installed-app tests.
        $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
        $env:PYTHONHOME = $null
        $env:PYTHONPATH = $null
        $env:TESSDATA_PREFIX = 'C:\missing-external-tessdata'
        $env:LOCALAPPDATA = Join-Path $testRoot 'UserData'
        New-Item -ItemType Directory -Force $env:LOCALAPPDATA | Out-Null
        $exe = Join-Path $bundle 'TC06Monitor.exe'
        if ($Installer) {
            $setup = Join-Path $release "TC06Monitor-Setup-$version-x64.exe"
            $installed = Join-Path $testRoot 'Installed App'
            Run-Checked $setup "/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /DIR=`"$installed`" /LOG=`"$release\install.log`""
            $exe = Join-Path $installed 'TC06Monitor.exe'
            if (-not (Test-Path $exe)) { throw 'Installer did not create the application.' }
        }
        Run-Checked $exe "--self-test `"$release\installed-self-test.json`""
        $self = Get-Content "$release\installed-self-test.json" -Raw | ConvertFrom-Json
        if (-not $self.ok -or -not $self.bundled) { throw 'Installed OCR self-test failed.' }
        Run-Checked $exe "--smoke-gui `"$release\installed-gui.json`"" 30
        $gui = Get-Content "$release\installed-gui.json" -Raw | ConvertFrom-Json
        if (-not $gui.ok -or -not $gui.visible -or $gui.capture_started) { throw 'Installed GUI smoke test failed.' }
        if ($Installer) {
            $marker = Join-Path $env:LOCALAPPDATA 'TC06Monitor\preserve-test.txt'
            New-Item -ItemType Directory -Force (Split-Path $marker) | Out-Null
            Set-Content $marker 'Synthetic test marker; no user data.'
            Run-Checked (Join-Path $installed 'unins000.exe') '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART'
            if ((Test-Path $exe) -or -not (Test-Path $marker)) { throw 'Uninstall/preserve test failed.' }
        }
        @{ version=$version; windows=$PSVersionTable.OS; python_removed_from_path=$true;
           installed_ocr=$true; installed_gui=$true; uninstall_preserved_userdata=[bool]$Installer;
           actual_camera_tested=$false; actual_hmi_tested=$false } |
           ConvertTo-Json | Set-Content "$release\verification.json"
    } finally {
        $env:PATH = $previousPath
        $env:LOCALAPPDATA = $previousLocal
        $env:PYTHONHOME = $previousHome
        $env:PYTHONPATH = $previousPythonPath
        $env:TESSDATA_PREFIX = $previousData
    }
    Compress-Archive -Path "$bundle\*" -DestinationPath "$release\TC06Monitor-Portable-$version-x64.zip" -Force
    $lines = Get-ChildItem $release -File | Where-Object { $_.Extension -in '.exe','.zip' } | ForEach-Object {
        (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + $_.Name
    }
    $lines | Set-Content "$release\SHA256SUMS.txt"
    Write-Host 'Installer and installed-runtime checks completed. See dist\release.'
} catch {
    $_ | Out-String | Set-Content "$release\build-failure.txt"
    throw
}
