# EZiL OS - local mode launcher (Windows PowerShell 5.1+).
#
# Checks Docker and Bun, pulls the pinned desktop image, runs the doctor,
# starts the local host, opens the browser once it answers, and cleans up
# on Ctrl-C. Nothing here is installed for you: a missing prerequisite is
# printed with the one command that fixes it, and the script exits 2.
#
# Mirrors deploy/launcher/ezil-os.sh step for step; read that file's header
# for the outbound-host list this script is held to (registry pull, the
# Docker/Bun install pages printed only, and its own loopback host).
#
# PowerShell 5.1 compatible on purpose: no null-coalescing '??', no ternary
# '?:', no 'ForEach-Object -Parallel' - all PowerShell 7-only.

[CmdletBinding()]
param(
    [switch]$NoBrowser
)

function Info($msg) { Write-Host "[ezil-os] $msg" }
function ErrMsg($msg) { Write-Host "[ezil-os] ERROR: $msg" -ForegroundColor Red }

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$LocalDir = Join-Path $RepoRoot "local"
$ImagesEnv = Join-Path $RepoRoot "deploy\images.env"

# -- 1. Docker --------------------------------------------------------------
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    ErrMsg "docker was not found on PATH."
    Write-Host "Install Docker Desktop: https://docs.docker.com/get-docker/"
    exit 2
}
$dockerVersionOut = & docker version 2>&1
if ($LASTEXITCODE -ne 0) {
    ErrMsg "docker is on PATH but the daemon did not answer 'docker version':"
    Write-Host $dockerVersionOut
    Write-Host "Start Docker Desktop, then re-run this script."
    exit 2
}

# -- 2. Bun -------------------------------------------------------------------
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    ErrMsg "bun was not found on PATH. The local host runs on Bun, and this script will not install it for you."
    Write-Host "Install it: powershell -c `"irm bun.sh/install.ps1 | iex`""
    exit 2
}

# -- 3. Resolve the image reference -----------------------------------------
function Read-EnvKey($key, $file) {
    if (-not (Test-Path $file)) { return "" }
    $pattern = "^\s*" + [regex]::Escape($key) + "\s*="
    $line = Get-Content $file | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if (-not $line) { return "" }
    $idx = $line.IndexOf("=")
    return $line.Substring($idx + 1).Trim()
}

$ExpectDigest = ""
if ($env:EZIL_LAUNCHER_IMAGE) {
    $ImageRef = $env:EZIL_LAUNCHER_IMAGE
    $ImageSource = "EZIL_LAUNCHER_IMAGE override"
} else {
    if (-not (Test-Path $ImagesEnv)) {
        ErrMsg "deploy/images.env not found at $ImagesEnv"
        exit 2
    }
    $DesktopImage = Read-EnvKey "EZIL_DESKTOP_IMAGE" $ImagesEnv
    $DesktopTag = Read-EnvKey "EZIL_DESKTOP_TAG" $ImagesEnv
    $ExpectDigest = Read-EnvKey "EZIL_DESKTOP_DIGEST" $ImagesEnv
    if (-not $DesktopImage -or -not $DesktopTag) {
        ErrMsg "deploy/images.env is missing EZIL_DESKTOP_IMAGE or EZIL_DESKTOP_TAG."
        exit 2
    }
    # Docker's tag grammar (local/src/container/run-spec.ts's isDockerTag).
    # deploy/images.env ships a placeholder until a release pins a real tag
    # (docs/TASKS.csv row T7) - refuse to compose a reference from it.
    if ($DesktopTag -notmatch '^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$') {
        ErrMsg "EZIL_DESKTOP_TAG in deploy/images.env ('$DesktopTag') is not a valid Docker tag - this checkout has no image pinned yet."
        Write-Host "Set EZIL_LAUNCHER_IMAGE=<image:tag> to point at an image you already have, or use a published release tarball."
        exit 2
    }
    $ImageRef = "${DesktopImage}:${DesktopTag}"
    $ImageSource = "deploy/images.env"
}

# -- 4. Pull it ---------------------------------------------------------------
if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") {
    Info "Host architecture is ARM64; the desktop image is amd64 and will run under emulation - expect a slower boot."
}

& docker image inspect $ImageRef *> $null
if ($LASTEXITCODE -eq 0) {
    Info "Image $ImageRef already present locally ($ImageSource) - skipping pull."
} else {
    Info "Pulling $ImageRef from the registry ($ImageSource)."
    Info "Expect roughly 1.4 GB to transfer and about 4.6 GB on disk (amd64)."
    & docker pull $ImageRef
    if ($LASTEXITCODE -ne 0) { ErrMsg "docker pull $ImageRef failed."; exit 1 }
}

if ($ExpectDigest) {
    $actual = & docker image inspect $ImageRef --format '{{join .RepoDigests ","}}' 2>$null
    if ($actual -notmatch [regex]::Escape($ExpectDigest)) {
        ErrMsg "EZIL_DESKTOP_DIGEST=$ExpectDigest in deploy/images.env does not match the pulled image's digest(s): $actual"
        exit 2
    }
    Info "Digest pin verified: $ExpectDigest"
}

# -- 5. The doctor --------------------------------------------------------
# Any EZIL_* the caller already set in this session's environment reaches
# `bun run` unchanged - nothing here needs to re-forward it by name.
Info "Running the doctor..."
& bun run --cwd $LocalDir doctor
if ($LASTEXITCODE -ne 0) {
    ErrMsg "The doctor found something that will stop a desktop from starting (see above)."
    exit 1
}

# -- 6. Start, wait for /os, open the browser, clean up on Ctrl-C -----------
$Port = $env:EZIL_LOCAL_PORT
if (-not $Port) { $Port = "7080" }
if ($Port -eq "0") {
    ErrMsg "EZIL_LOCAL_PORT=0 means 'the OS picks a free port', which this launcher cannot poll a fixed URL for. Unset it or set a specific port."
    exit 2
}
$OsUrl = "http://127.0.0.1:$Port/os"

$LogFile = [System.IO.Path]::GetTempFileName()
$PreContainers = @(& docker ps -aq --filter "name=^ezil-os-")

$proc = Start-Process -FilePath "bun" -ArgumentList @("run", "--cwd", $LocalDir, "start") `
    -RedirectStandardOutput $LogFile -RedirectStandardError "$LogFile.err" -PassThru -NoNewWindow

function Cleanup {
    Info "Stopping the local host..."
    if ($proc -and -not $proc.HasExited) {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
    }
    $nowContainers = @(& docker ps -aq --filter "name=^ezil-os-")
    foreach ($id in $nowContainers) {
        if ($PreContainers -notcontains $id) {
            Info "Removing container $id"
            & docker rm -f $id *> $null
        }
    }
}

try {
    Info "Waiting for $OsUrl to answer..."
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        if ($proc.HasExited) {
            ErrMsg "The local host exited before it answered. Log:"
            Get-Content $LogFile -ErrorAction SilentlyContinue
            exit 1
        }
        try {
            $resp = Invoke-WebRequest -Uri $OsUrl -UseBasicParsing -TimeoutSec 2
            if ($resp.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    }

    if (-not $ready) {
        ErrMsg "$OsUrl did not answer 200 within 30s. Log:"
        Get-Content $LogFile -ErrorAction SilentlyContinue
        exit 1
    }

    Info "EZiL OS is up: $OsUrl"
    if (-not $NoBrowser) {
        Start-Process $OsUrl
    }

    Info "Press Ctrl-C to stop."
    while (-not $proc.HasExited) {
        Start-Sleep -Milliseconds 500
    }
} finally {
    Cleanup
}
