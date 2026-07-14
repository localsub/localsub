# first-run-e2e.ps1
# Clean-room reproduction of the app's first-run provisioning, using the
# bundled embedded Python 3.12 in an isolated temp dir. Mirrors
# setup_manager.rs without the Tauri wizard / NSIS installer.
#
# Validates, against a pristine cp312 environment:
#   1. get-pip bootstrap into a fresh target dir
#   2. requirements.lock installs under --require-hashes (integrity)
#   3. the pinned dependency set imports (runtime compatibility)
#   4. the llama-cpp wheel installs --no-deps + imports
#   5. ffmpeg downloads and passes its sha256 (from integrity.json)
#   6. the FastAPI app boots and /health responds (whole stack assembles)
#
# Does NOT touch system Python or %APPDATA%/LocalSub. Gaps vs a real install:
# NSIS packaging and the wizard UI only.
#
# Usage:  scripts/first-run-e2e.ps1 [-Backend cpu|cuda]  (default: auto-detect GPU)

param(
    [ValidateSet('auto', 'cpu', 'cuda')]
    [string]$Backend = 'auto'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$res = Join-Path $root 'src-tauri\resources'
$work = Join-Path $env:TEMP ('localsub-e2e-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$port = 9131  # off the app's default 9111 to avoid clashing with a running dev server

function Step($n, $msg) { Write-Host "`n[$n] $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "  PASS: $msg" -ForegroundColor Green }
function Die($msg) { Write-Host "  FAIL: $msg" -ForegroundColor Red; exit 1 }

# Runs a native exe, capturing stderr to a FILE (never 2>&1 into the pipeline,
# which PS 5.1 turns into terminating NativeCommandError records). Judges
# success purely by exit code; prints captured streams on failure.
function Run-Native {
    param([string]$Exe, [string[]]$Argv, [string]$What)
    # Function-scoped: a native command writing to stderr must not become a
    # terminating error here. Judge success by exit code only. (Restores on return.)
    $ErrorActionPreference = 'Continue'
    $errFile = [IO.Path]::GetTempFileName()
    $out = & $Exe @Argv 2>$errFile
    $code = $LASTEXITCODE
    $err = Get-Content -LiteralPath $errFile -Raw -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $errFile -Force -ErrorAction SilentlyContinue
    if ($code -ne 0) {
        if ($out) { Write-Host ($out | Select-Object -Last 6 | Out-String) }
        if ($err) { Write-Host $err -ForegroundColor DarkYellow }
        Die "$What failed (exit $code)"
    }
    return $out
}

if ($Backend -eq 'auto') {
    $null = & nvidia-smi 2>$null
    $Backend = if ($LASTEXITCODE -eq 0) { 'cuda' } else { 'cpu' }
}
Write-Host "=== LocalSub first-run E2E (backend=$Backend, work=$work) ===" -ForegroundColor Yellow

# --- preconditions ---
foreach ($f in @(
        "$res\python-embed\python.exe", "$res\python-embed\python312._pth",
        "$res\get-pip.py", "$res\integrity.json",
        "$root\python-server\requirements.lock", "$root\python-server\main.py")) {
    if (-not (Test-Path -LiteralPath $f)) { Die "missing prerequisite: $f (run scripts/download-python-embed.ps1)" }
}

# --- 1. pristine embedded python copy + env dir ---
Step 1 "Copy pristine embedded Python + create env dir"
$pyDir = Join-Path $work 'python-embed'
$envDir = Join-Path $work 'python-env'
New-Item -ItemType Directory -Path $work -Force | Out-Null
Copy-Item -LiteralPath "$res\python-embed" -Destination $pyDir -Recurse -Force
New-Item -ItemType Directory -Path $envDir -Force | Out-Null
$py = Join-Path $pyDir 'python.exe'

# Patch ._pth so the embedded interpreter sees packages installed into envDir
# (embedded Python ignores PYTHONPATH when a ._pth file exists) — same as
# setup_manager::patch_pth_file.
$pth = Join-Path $pyDir 'python312._pth'
$pthContent = Get-Content -LiteralPath $pth -Raw
if ($pthContent -notmatch [regex]::Escape($envDir)) {
    ($pthContent -replace 'import site', "$envDir`r`nimport site") | Set-Content -LiteralPath $pth -NoNewline
}
Ok "embedded python at $py"

# --- 2. bootstrap pip ---
Step 2 "Bootstrap pip (get-pip.py --target env)"
Run-Native $py @("$res\get-pip.py", '--no-user', '--target', $envDir) 'get-pip' | Out-Null
Ok "pip bootstrapped"

# --- 3. install hash-locked requirements ---
Step 3 "pip install --require-hashes -r requirements.lock"
Run-Native $py @('-m', 'pip', 'install', '--no-user', '--require-hashes', '-r',
    "$root\python-server\requirements.lock", '--target', $envDir) 'requirements.lock install' | Out-Null
Ok "hash-locked dependencies installed"

# --- 4. llama-cpp wheel: download + verify sha256 + install --no-deps ---
Step 4 "Download + verify + install llama-cpp wheel ($Backend)"
$manifest = Get-Content -LiteralPath "$res\integrity.json" -Raw | ConvertFrom-Json
$wheelEntry = $manifest.llama_cpp.$Backend
$wheelPath = Join-Path $work ([IO.Path]::GetFileName($wheelEntry.url))
Invoke-WebRequest -Uri $wheelEntry.url -OutFile $wheelPath
$got = (Get-FileHash -LiteralPath $wheelPath -Algorithm SHA256).Hash.ToLower()
if ($got -ne $wheelEntry.sha256.ToLower()) { Die "wheel sha256 mismatch: got $got want $($wheelEntry.sha256)" }
Ok "wheel sha256 verified ($($wheelEntry.sha256.Substring(0,12))...)"
Run-Native $py @('-m', 'pip', 'install', '--no-user', '--no-deps', $wheelPath, '--target', $envDir) 'llama wheel install' | Out-Null
Ok "llama-cpp installed --no-deps"

# --- 5. ffmpeg download + verify ---
Step 5 "Download + verify ffmpeg zip (sha256 from manifest)"
$ffPath = Join-Path $work 'ffmpeg.zip'
Invoke-WebRequest -Uri $manifest.ffmpeg.url -OutFile $ffPath
$ffGot = (Get-FileHash -LiteralPath $ffPath -Algorithm SHA256).Hash.ToLower()
if ($ffGot -ne $manifest.ffmpeg.sha256.ToLower()) { Die "ffmpeg sha256 mismatch: got $ffGot" }
Ok "ffmpeg sha256 verified"

# --- 6. smoke-import the full pinned stack ---
Step 6 "Import the full dependency stack"
# Write to a temp .py file rather than -c "..." — PowerShell 5.1 strips the
# inner double quotes from a native -c argument, mangling string literals.
$impPy = Join-Path $work 'smoke_import.py'
@'
import fastapi, uvicorn, sse_starlette, faster_whisper, onnxruntime
import numpy, sklearn, soundfile, psutil, llama_cpp
print("IMPORTS_OK")
'@ | Set-Content -LiteralPath $impPy -Encoding ascii
$impOut = Run-Native $py @($impPy) 'stack import'
if ($impOut -notmatch 'IMPORTS_OK') { Write-Host ($impOut | Out-String); Die "import did not report IMPORTS_OK" }
Ok "all pinned modules import"

# --- 7. boot the FastAPI app + hit /health ---
Step 7 "Boot FastAPI app and GET /health"
$srv = Start-Process -FilePath $py -PassThru -WindowStyle Hidden `
    -WorkingDirectory "$root\python-server" `
    -ArgumentList @('-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', "$port")
try {
    $healthy = $false
    foreach ($i in 1..30) {
        Start-Sleep -Milliseconds 700
        try {
            $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -TimeoutSec 3 -UseBasicParsing
            if ($r.StatusCode -eq 200) { $healthy = $true; break }
        }
        catch {}
    }
    if (-not $healthy) { Die "server did not become healthy on :$port" }
    Ok "server booted, /health 200"
}
finally {
    if ($srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force }
}

# --- cleanup ---
Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "`n=== E2E PASSED (backend=$Backend) ===" -ForegroundColor Green
