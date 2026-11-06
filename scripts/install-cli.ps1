# dsh-craft-anything — download / update the Craft Anything CLI for this machine.
#
# Installs the official Windows portable build of github.com/storytold/craft-anything
# into %USERPROFILE%\.dsh\plugins-data\craft-anything\<version>\ and verifies its
# SHA256 against the release's SHA256SUMS.txt. Nothing else on the machine is touched.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-cli.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-cli.ps1 -Version v0.4.0
#
# Exit codes: 0 installed or already present, 1 failure.

[CmdletBinding()]
param(
    [string]$Version = 'latest',
    [string]$Root = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Repo = 'storytold/craft-anything'
if (-not $Root) { $Root = Join-Path $env:USERPROFILE '.dsh\plugins-data\craft-anything' }

function Write-Step([string]$Text) { Write-Host "[craft-anything] $Text" }

# --- proxy: honour the Windows system proxy (this machine only reaches the internet through it)
function Enable-SystemProxy {
    try {
        $key = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
        if ($key.ProxyEnable -eq 1 -and $key.ProxyServer) {
            $server = [string]$key.ProxyServer
            if ($server -notmatch '^[a-zA-Z]+://') { $server = "http://$server" }
            if ($server -notmatch '^\w+://') { $server = "http://$server" }
            $uri = [Uri]$server
            $bypass = @('localhost', '127.0.0.1', 'registry.npmjs.org')
            [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy($uri, $true, $bypass, $null)
            $env:HTTP_PROXY = $uri.AbsoluteUri
            $env:HTTPS_PROXY = $uri.AbsoluteUri
            $env:NO_PROXY = ($bypass -join ',')
            Write-Step "using system proxy $($uri.AbsoluteUri)"
        }
    } catch {
        Write-Step "no system proxy detected (continuing direct): $($_.Exception.Message)"
    }
}

function Invoke-Download([string]$Uri, [string]$OutFile) {
    $tmp = "$OutFile.part"
    if (Test-Path $tmp) { Remove-Item -Force $tmp }
    Invoke-WebRequest -Uri $Uri -OutFile $tmp -UseBasicParsing -TimeoutSec 600
    Move-Item -Force $tmp $OutFile
}

Enable-SystemProxy

if ($Version -eq 'latest') {
    Write-Step "resolving latest release of $Repo"
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing -TimeoutSec 120
    $Version = [string]$release.tag_name
    if (-not $Version) { throw "GitHub returned no tag_name for the latest release" }
}
if ($Version -notmatch '^v?[0-9]') { throw "unexpected version '$Version'" }
if ($Version -notmatch '^v') { $Version = "v$Version" }
$PlainVersion = $Version.TrimStart('v')

$Arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    'x86'   { 'x86' }
    default { 'x64' }
}

$Asset = "craft-anything-$PlainVersion-windows-$Arch-portable.zip"
$Base = "https://github.com/$Repo/releases/download/$Version"
$Target = Join-Path $Root $PlainVersion
$Exe = Join-Path $Target 'craft-anything-cli.exe'

# Already installed? The folder may be named with or without the leading "v" (this machine
# uses v0.4.0), so scan the install root instead of trusting one exact path.
function Find-Installed([string]$Version) {
    if (-not (Test-Path $Root)) { return $null }
    $directories = @(Get-ChildItem -Path $Root -Directory -ErrorAction SilentlyContinue)
    foreach ($dir in $directories) {
        $candidate = Join-Path $dir.FullName 'craft-anything-cli.exe'
        if (-not (Test-Path $candidate)) { continue }
        $reported = (& $candidate --version 2>&1 | Out-String).Trim()
        if ($reported -match [regex]::Escape($Version)) { return $candidate }
    }
    return $null
}

if (-not $Force) {
    $installed = Find-Installed -Version $PlainVersion
    if ($installed) {
        Write-Step "already installed: $installed"
        Write-Output $installed
        exit 0
    }
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("craft-anything-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Temp | Out-Null

try {
    $Zip = Join-Path $Temp $Asset
    $Sums = Join-Path $Temp 'SHA256SUMS.txt'
    Write-Step "downloading $Asset"
    Invoke-Download -Uri "$Base/$Asset" -OutFile $Zip
    Write-Step 'downloading SHA256SUMS.txt'
    Invoke-Download -Uri "$Base/SHA256SUMS.txt" -OutFile $Sums

    # --- verify the download before unpacking it
    $line = Select-String -Path $Sums -Pattern ([regex]::Escape($Asset) + '$') | Select-Object -First 1
    if (-not $line) { throw "$Asset is not listed in SHA256SUMS.txt" }
    $expected = ($line.Line -split '\s+')[0].ToLowerInvariant()
    $actual = (Get-FileHash -Path $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw "sha256 mismatch for $Asset`n  expected $expected`n  actual   $actual" }
    Write-Step "sha256 ok: $actual"

    if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
    New-Item -ItemType Directory -Force -Path $Target | Out-Null
    Expand-Archive -Path $Zip -DestinationPath $Target -Force
    # the release packs its files in one top-level folder; flatten it
    $nested = @(Get-ChildItem -Path $Target -Directory)
    if ($nested.Count -eq 1) {
        Get-ChildItem -Path $nested[0].FullName -Force | Move-Item -Destination $Target -Force
        Remove-Item -Recurse -Force $nested[0].FullName
    }

    if (-not (Test-Path $Exe)) {
        $found = Get-ChildItem -Path $Target -Recurse -Filter 'craft-anything-cli.exe' | Select-Object -First 1
        if (-not $found) { throw "the release archive does not contain craft-anything-cli.exe" }
        $Exe = $found.FullName
    }
    $ver = (& $Exe --version 2>&1 | Out-String).Trim()
    Write-Step "installed $ver at $Exe"
    Write-Output $Exe
} finally {
    Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
