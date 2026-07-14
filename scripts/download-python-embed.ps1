# download-python-embed.ps1
# Downloads Python Embeddable and prepares resources for Tauri bundling
# NOTE: uses -LiteralPath throughout — the project path may contain [] wildcard chars.
#
# Every byte this script puts into src-tauri/resources/ ends up inside the
# installer, so each download is pinned by SHA-256 and verified before it is
# used — the same rule integrity.json and requirements.lock already apply to the
# binaries fetched at first run.
#
# get-pip.py is fetched from an immutable pypa/get-pip commit rather than the
# rolling https://bootstrap.pypa.io/get-pip.py, because that URL serves whatever
# is current on the day you build: it cannot be pinned, and it has already
# drifted under us. Nothing is re-hosted here, so no redistribution question.
#
# To bump a pin: download the file, verify it against the publisher's own
# checksum, then paste the SHA-256 below. python.org publishes MD5 for the
# embeddable zip (release page for the version), so check MD5 there and record
# the SHA-256 you computed from the same bytes.

$ErrorActionPreference = "Stop"

$PYTHON_VERSION = "3.12.8"
$PYTHON_ZIP = "python-${PYTHON_VERSION}-embed-amd64.zip"
$PYTHON_URL = "https://www.python.org/ftp/python/${PYTHON_VERSION}/${PYTHON_ZIP}"
# md5 1e86b04bc7d27c5c06edf8f617e1184a as published on python.org/downloads/release/python-3128
$PYTHON_SHA256 = "8d3f33be9eb810f23c102f08475af2854e50484b8e4e06275e937be61ce3d2fb"

# pypa/get-pip @ "Update to 26.1.2" (2026-05-31). A commit SHA makes the URL immutable.
$GET_PIP_COMMIT = "5e84c8360eaf92009551b3eec69d734137f31cec"
$GET_PIP_URL = "https://raw.githubusercontent.com/pypa/get-pip/${GET_PIP_COMMIT}/public/get-pip.py"
$GET_PIP_SHA256 = "a341e1a43e38001c551a1508a73ff23636a11970b61d901d9a1cad2a18f57055"

$PROJECT_ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$RESOURCES_DIR = Join-Path (Join-Path $PROJECT_ROOT "src-tauri") "resources"
$PYTHON_EMBED_DIR = Join-Path $RESOURCES_DIR "python-embed"

Write-Host "=== Python Embeddable Download Script ===" -ForegroundColor Cyan
Write-Host "Python version: $PYTHON_VERSION"
Write-Host "Resources dir: $RESOURCES_DIR"

# Create resources directory
if (!(Test-Path -LiteralPath $RESOURCES_DIR)) {
    New-Item -ItemType Directory -Path $RESOURCES_DIR -Force | Out-Null
}

function Get-Sha256($literalPath) {
    return (Get-FileHash -LiteralPath $literalPath -Algorithm SHA256).Hash.ToLower()
}

function Assert-Sha256($literalPath, $expected, $label) {
    $actual = Get-Sha256 $literalPath
    if ($actual -ne $expected) {
        Write-Host "  SHA-256 MISMATCH for $label" -ForegroundColor Red
        Write-Host "    expected: $expected"
        Write-Host "    actual:   $actual"
        throw "Integrity check failed for $label - refusing to use it."
    }
    Write-Host "  SHA-256 verified: $label"
}

# Downloads go to a temp path first: Invoke-WebRequest -OutFile and Expand-Archive
# expand wildcards, which breaks on paths containing []. Verifying before the move
# also means a bad download never lands in resources/.
function Download-Verified($url, $destLiteralPath, $expectedSha256, $label) {
    $tmp = Join-Path $env:TEMP ("localsub-dl-" + [IO.Path]::GetFileName($destLiteralPath))
    Invoke-WebRequest -Uri $url -OutFile $tmp
    Assert-Sha256 $tmp $expectedSha256 $label
    Move-Item -LiteralPath $tmp -Destination $destLiteralPath -Force
}

# Step 1: Download and extract Python Embeddable
Write-Host "`n[1/4] Downloading Python Embeddable..." -ForegroundColor Yellow

if (!(Test-Path -LiteralPath $PYTHON_EMBED_DIR)) {
    $tmpZip = Join-Path $env:TEMP $PYTHON_ZIP

    # A zip left in %TEMP% by an earlier run is not trusted on its name alone.
    if (Test-Path -LiteralPath $tmpZip) {
        if ((Get-Sha256 $tmpZip) -eq $PYTHON_SHA256) {
            Write-Host "  Reusing verified ZIP from temp"
        } else {
            Write-Host "  Cached ZIP does not match the pin - re-downloading" -ForegroundColor Yellow
            Remove-Item -LiteralPath $tmpZip -Force
        }
    }

    if (!(Test-Path -LiteralPath $tmpZip)) {
        Invoke-WebRequest -Uri $PYTHON_URL -OutFile $tmpZip
        Write-Host "  Downloaded: $PYTHON_ZIP"
    }

    Assert-Sha256 $tmpZip $PYTHON_SHA256 $PYTHON_ZIP

    $tmpExtract = Join-Path $env:TEMP "localsub-python-embed"
    if (Test-Path -LiteralPath $tmpExtract) {
        Remove-Item -LiteralPath $tmpExtract -Recurse -Force
    }
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
    Move-Item -LiteralPath $tmpExtract -Destination $PYTHON_EMBED_DIR
    Write-Host "  Extracted to: $PYTHON_EMBED_DIR"

    Remove-Item -LiteralPath $tmpZip -Force
    Write-Host "  Cleaned up ZIP file"
} else {
    Write-Host "  Python embed directory already exists, skipping"
}

# Step 2: Fix python312._pth to enable import site
Write-Host "`n[2/4] Fixing python312._pth..." -ForegroundColor Yellow
$pthFile = Join-Path $PYTHON_EMBED_DIR "python312._pth"
if (Test-Path -LiteralPath $pthFile) {
    $content = Get-Content -LiteralPath $pthFile -Raw
    $content = $content -replace "#import site", "import site"
    Set-Content -LiteralPath $pthFile -Value $content -NoNewline
    Write-Host "  Uncommented 'import site' in python312._pth"
} else {
    Write-Host "  WARNING: python312._pth not found!" -ForegroundColor Red
}

# Step 3: Download get-pip.py
Write-Host "`n[3/4] Downloading get-pip.py..." -ForegroundColor Yellow
$getPipPath = Join-Path $RESOURCES_DIR "get-pip.py"

# An existing copy predating the pin (or fetched from the rolling URL) is replaced,
# not trusted — that drift is the reason this is pinned.
if (Test-Path -LiteralPath $getPipPath) {
    if ((Get-Sha256 $getPipPath) -eq $GET_PIP_SHA256) {
        Write-Host "  SHA-256 verified: existing get-pip.py"
    } else {
        Write-Host "  Existing get-pip.py does not match the pin - replacing" -ForegroundColor Yellow
        Remove-Item -LiteralPath $getPipPath -Force
    }
}

if (!(Test-Path -LiteralPath $getPipPath)) {
    Download-Verified $GET_PIP_URL $getPipPath $GET_PIP_SHA256 "get-pip.py"
    Write-Host "  Downloaded get-pip.py (pypa/get-pip @ $($GET_PIP_COMMIT.Substring(0,12)))"
}

# Step 4: Sync python-server files
Write-Host "`n[4/4] Syncing python-server files..." -ForegroundColor Yellow

# Delegated to sync-python-resources.mjs so exactly one place decides what ships.
# `npm run tauri build` runs that same script via beforeBuildCommand; copying the
# files here with a looser rule (every *.py) pulled test_*.py into the bundle.
$syncScript = Join-Path (Join-Path $PROJECT_ROOT "scripts") "sync-python-resources.mjs"
& node $syncScript
if ($LASTEXITCODE -ne 0) {
    throw "sync-python-resources.mjs failed (exit $LASTEXITCODE). Is Node.js on PATH?"
}

Write-Host "`n=== Done! ===" -ForegroundColor Green
Write-Host "Resources prepared in: $RESOURCES_DIR"
Write-Host "  - python-embed/ (Python $PYTHON_VERSION embeddable, SHA-256 pinned)"
Write-Host "  - get-pip.py (pinned commit)"
Write-Host "  - python-server/ (via sync-python-resources.mjs)"
