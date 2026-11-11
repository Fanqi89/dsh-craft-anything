# dsh-craft-anything — download / update the Craft Anything CLI for this machine.
#
# Installs the official Windows portable build of github.com/storytold/craft-anything
# into %USERPROFILE%\.dsh\plugins-data\craft-anything\<version>\ and verifies its
# SHA256 against the release's SHA256SUMS.txt. Nothing else on the machine is touched.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-cli.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-cli.ps1 -Version v0.4.0
#
# Downloads go through the fastest reachable mirror from CRAFT_ANYTHING_GITHUB_MIRRORS
# (default: the ghproxy family) and always fall back to github.com; every candidate is checked
# against SHA256SUMS.txt, so a mirror can serve the bytes but cannot change what is installed.
# curl.exe is preferred (Invoke-WebRequest is the fallback: it broke on a reporter's machine with
# "InvalidOperation: System.Net.HttpWebRequest").
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
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$Repo = 'storytold/craft-anything'
if (-not $Root) { $Root = Join-Path $env:USERPROFILE '.dsh\plugins-data\craft-anything' }

function Write-Step([string]$Text) { Write-Host "[craft-anything] $Text" }

# --- proxy: the Windows system proxy is honoured because some networks only reach GitHub through it
function Enable-SystemProxy {
    try {
        $key = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
        if ($key.ProxyEnable -eq 1 -and $key.ProxyServer) {
            $server = [string]$key.ProxyServer
            if ($server -notmatch '^\w+://') { $server = "http://$server" }
            $uri = [Uri]$server
            $bypass = @('localhost', '127.0.0.1', 'registry.npmjs.org')
            [System.Net.WebRequest]::DefaultWebProxy = New-Object System.Net.WebProxy($uri, $true, $bypass, $null)
            if (-not $env:HTTPS_PROXY) { $env:HTTPS_PROXY = $uri.AbsoluteUri }
            if (-not $env:HTTP_PROXY) { $env:HTTP_PROXY = $uri.AbsoluteUri }
            if (-not $env:NO_PROXY) { $env:NO_PROXY = ($bypass -join ',') }
            Write-Step "using system proxy $($uri.AbsoluteUri)"
        }
    } catch {
        Write-Step "no system proxy detected (continuing direct): $($_.Exception.Message)"
    }
}

$script:CurlExe = $null
try {
    $candidate = (Get-Command curl.exe -ErrorAction SilentlyContinue).Source
    if ($candidate -and (Test-Path $candidate)) { $script:CurlExe = $candidate }
} catch { }

function Save-Url([string]$Uri, [string]$OutFile) {
    $tmp = "$OutFile.part"
    if (Test-Path $tmp) { Remove-Item -Force $tmp }
    if ($script:CurlExe) {
        $a = @('-fsSL', '--retry', '2', '--retry-delay', '2', '--connect-timeout', '20', '--max-time', '900', '-o', $tmp)
        if ($env:HTTPS_PROXY) { $a += @('--proxy', $env:HTTPS_PROXY) }
        $a += $Uri
        & $script:CurlExe @a
        if ($LASTEXITCODE -ne 0) { throw "curl exited $LASTEXITCODE for $Uri" }
    } else {
        Invoke-WebRequest -Uri $Uri -OutFile $tmp -UseBasicParsing -TimeoutSec 900
    }
    if (-not (Test-Path $tmp) -or (Get-Item $tmp).Length -eq 0) { throw "no bytes from $Uri" }
    Move-Item -Force $tmp $OutFile
}

function Resolve-Latest {
    try {
        $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/latest" -UseBasicParsing -TimeoutSec 60
        if ($release.tag_name) { return [string]$release.tag_name }
    } catch {
        Write-Step "the GitHub API is not reachable ($($_.Exception.Message)); trying the releases page"
    }
    if ($script:CurlExe) {
        $head = & $script:CurlExe @('-sS', '-I', '--max-time', '20', "https://github.com/$Repo/releases/latest") 2>&1
        foreach ($line in $head) {
            if ([string]$line -match '(?i)^location:\s*\S*/tag/([^/?#\s]+)') { return $Matches[1] }
        }
    }
    throw "cannot resolve the latest release here; pass -Version vX.Y.Z (from https://github.com/$Repo/releases)"
}

Enable-SystemProxy

if ($Version -eq 'latest') {
    Write-Step "resolving latest release of $Repo"
    $Version = Resolve-Latest
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
$Target = Join-Path $Root $PlainVersion
$Exe = Join-Path $Target 'craft-anything-cli.exe'

# Already installed? The folder may be named with or without the leading "v", so scan the root.
function Find-Installed([string]$Wanted) {
    if (-not (Test-Path $Root)) { return $null }
    foreach ($dir in @(Get-ChildItem -Path $Root -Directory -ErrorAction SilentlyContinue)) {
        $candidate = Join-Path $dir.FullName 'craft-anything-cli.exe'
        if (-not (Test-Path $candidate)) { continue }
        $reported = (& $candidate --version 2>&1 | Out-String).Trim()
        if ($reported -match [regex]::Escape($Wanted)) { return $candidate }
    }
    return $null
}

if (-not $Force) {
    $installed = Find-Installed -Wanted $PlainVersion
    if ($installed) {
        Write-Step "already installed: $installed"
        Write-Output $installed
        exit 0
    }
}

# --- rank the download sources: mirrors by latency, github.com always last
$MirrorPrefixes = @()
if ($env:CRAFT_ANYTHING_GITHUB_MIRRORS) {
    $MirrorPrefixes = @($env:CRAFT_ANYTHING_GITHUB_MIRRORS -split ',' | ForEach-Object { $_.Trim().TrimEnd('/') } | Where-Object { $_ })
} else {
    $MirrorPrefixes = @(
        'https://ghfast.top/https://github.com',
        'https://gh-proxy.com/https://github.com',
        'https://ghproxy.net/https://github.com',
        'https://mirror.ghproxy.com/https://github.com'
    )
}
$Ranked = @()
foreach ($prefix in $MirrorPrefixes) {
    $base = "$prefix/$Repo/releases/download/$Version"
    $ok = $false
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        if ($script:CurlExe) {
            & $script:CurlExe @('-sS', '-o', 'NUL', '--max-time', '4', '-r', '0-0', "$base/SHA256SUMS.txt") 2>$null | Out-Null
            $ok = ($LASTEXITCODE -eq 0)
        } else {
            $null = Invoke-WebRequest -Uri "$base/SHA256SUMS.txt" -Method Head -UseBasicParsing -TimeoutSec 4
            $ok = $true
        }
    } catch { $ok = $false }
    $sw.Stop()
    if ($ok) { $Ranked += [pscustomobject]@{ Base = $base; Ms = $sw.ElapsedMilliseconds } }
}
$Sources = @($Ranked | Sort-Object Ms | ForEach-Object { $_.Base })
$Sources += "https://github.com/$Repo/releases/download/$Version"
if ($Ranked.Count -gt 0) {
    Write-Step ("fastest mirror: {0} ({1} ms)" -f $Ranked[0].Base, $Ranked[0].Ms)
} else {
    Write-Step 'no mirror answered; using github.com directly'
}

New-Item -ItemType Directory -Force -Path $Root | Out-Null
$Temp = Join-Path ([System.IO.Path]::GetTempPath()) ("craft-anything-" + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Temp | Out-Null

$Failures = @()
$Done = $false
try {
    foreach ($source in ($Sources | Select-Object -Unique)) {
        try {
            $Zip = Join-Path $Temp $Asset
            $Sums = Join-Path $Temp 'SHA256SUMS.txt'
            Write-Step "downloading $Asset from $source"
            Save-Url -Uri "$source/$Asset" -OutFile $Zip
            Save-Url -Uri "$source/SHA256SUMS.txt" -OutFile $Sums

            $line = Select-String -Path $Sums -Pattern ([regex]::Escape($Asset) + '$') | Select-Object -First 1
            if (-not $line) { throw "$Asset is not listed in SHA256SUMS.txt" }
            $expected = ($line.Line -split '\s+')[0].ToLowerInvariant()
            $actual = (Get-FileHash -Path $Zip -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($expected -ne $actual) { throw "sha256 mismatch for $Asset`n  expected $expected`n  actual   $actual" }
            Write-Step "sha256 ok: $actual"

            if (Test-Path $Target) { Remove-Item -Recurse -Force $Target }
            New-Item -ItemType Directory -Force -Path $Target | Out-Null
            Expand-Archive -Path $Zip -DestinationPath $Target -Force
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
            $Done = $true
            break
        } catch {
            $message = $_.Exception.Message
            $Failures += "$source -> $message"
            Write-Step "source failed: $message"
        }
    }
    if (-not $Done) {
        throw ("every download source failed:`n  " + ($Failures -join "`n  "))
    }
} finally {
    Remove-Item -Recurse -Force $Temp -ErrorAction SilentlyContinue
}
