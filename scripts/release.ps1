# dsh-craft-anything — release one version, safely.
#
# One command creates the immutable tag and the GitHub Release for the version that
# package.json declares:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1
#
#   -NotesFile <file>   Release body (default: the version's section in CHANGELOG.md)
#   -Token <token>      GitHub token (default: `git credential fill` for github.com)
#   -SkipPush           validate + tag locally only
#   -Message <text>     annotated tag message (default: "dsh-craft-anything vX.Y.Z")
#
# Rules (see RELEASING.md): version numbers are never reused, tags never move and old
# releases are never deleted. The script refuses to continue when anything disagrees.

[CmdletBinding()]
param(
    [string]$NotesFile = '',
    [string]$Token = '',
    [string]$Message = '',
    [switch]$SkipPush
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Root = Split-Path -Parent $PSScriptRoot
$Repo = 'Fanqi89/dsh-craft-anything'

function Write-Step([string]$Text) { Write-Host "[release] $Text" }
function Fail([string]$Text) { Write-Host "[release] ERROR: $Text" -ForegroundColor Red; exit 1 }

Push-Location $Root
try {
    # ---- 1. the two manifests must agree on the version -------------------------------
    $utf8 = New-Object System.Text.UTF8Encoding($false); $manifest = [IO.File]::ReadAllText((Join-Path $Root 'package.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
    $pluginManifest = [IO.File]::ReadAllText((Join-Path $Root 'dsh.plugin.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
    $Version = [string]$manifest.version
    if (-not $Version) { Fail 'package.json has no version' }
    if ([string]$pluginManifest.version -ne $Version) {
        Fail "package.json version $Version does not match dsh.plugin.json version $($pluginManifest.version)"
    }
    if (-not $manifest.engines -or -not $manifest.engines.dsh) { Fail 'package.json has no engines.dsh' }
    if (-not $pluginManifest.engines -or -not $pluginManifest.engines.dsh) { Fail 'dsh.plugin.json has no engines.dsh' }
    if ([string]$manifest.engines.dsh -ne [string]$pluginManifest.engines.dsh) {
        Fail "engines.dsh differs: package.json=$($manifest.engines.dsh) dsh.plugin.json=$($pluginManifest.engines.dsh)"
    }
    $Tag = "v$Version"
    Write-Step "version $Version (engines.dsh $($manifest.engines.dsh)), tag $Tag"

    # ---- 2. repository state ----------------------------------------------------------
    $dirty = @(git status --porcelain)
    if ($dirty.Count -gt 0) { Fail "working tree is not clean:`n$($dirty -join "`n")" }
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    if ($branch -ne 'main') { Fail "current branch is '$branch', expected main" }

    # ---- 3. syntax and manifest checks ------------------------------------------------
    & node --check (Join-Path $Root 'host\index.js'); if ($LASTEXITCODE -ne 0) { Fail 'host/index.js failed node --check' }
    & node --check (Join-Path $Root 'client.js'); if ($LASTEXITCODE -ne 0) { Fail 'client.js failed node --check' }
    foreach ($json in @('package.json', 'dsh.plugin.json', 'locale\en.json', 'locale\zh.json')) {
        try { [IO.File]::ReadAllText((Join-Path $Root $json), [Text.Encoding]::UTF8) | ConvertFrom-Json | Out-Null }
        catch { Fail "$json is not valid JSON: $($_.Exception.Message)" }
    }
    Write-Step 'syntax and manifests ok'

    # ---- 4. tags are immutable -------------------------------------------------------
    $localTag = (git tag --list $Tag)
    if ($localTag) { Fail "tag $Tag already exists locally; published tags never move — bump the version" }
    $remoteTag = (git ls-remote --tags origin "refs/tags/$Tag")
    if ($remoteTag) { Fail "tag $Tag already exists on origin; published tags never move — bump the version" }

    # ---- 5. tag and push -------------------------------------------------------------
    if (-not $Message) { $Message = "dsh-craft-anything $Tag" }
    git tag -a $Tag -m $Message
    if ($LASTEXITCODE -ne 0) { Fail 'git tag failed' }
    Write-Step "created annotated tag $Tag"

    if (-not $SkipPush) {
        git push origin main
        if ($LASTEXITCODE -ne 0) { Fail 'git push main failed' }
        git push origin "refs/tags/$Tag"
        if ($LASTEXITCODE -ne 0) { Fail 'git push tag failed' }
        Write-Step 'pushed main and the tag'
    } else {
        Write-Step 'SkipPush set: tag created locally only'
        exit 0
    }

    # ---- 6. release body -------------------------------------------------------------
    $body = ''
    if ($NotesFile) {
        if (-not (Test-Path $NotesFile)) { Fail "notes file not found: $NotesFile" }
        $body = [IO.File]::ReadAllText((Resolve-Path $NotesFile), [Text.Encoding]::UTF8)
    } else {
        $changelog = [IO.File]::ReadAllText((Join-Path $Root 'CHANGELOG.md'), [Text.Encoding]::UTF8)
        $pattern = "(?ms)^## \[$([regex]::Escape($Tag))\].*?(?=^## \[|\z)"
        $match = [regex]::Match($changelog, $pattern)
        if (-not $match.Success) { Fail "CHANGELOG.md has no '## [$Tag]' section; add one or pass -NotesFile" }
        $body = $match.Value.Trim()
    }
    $installBlock = '```powershell' + "`n" + "dsh plugin --profile desktop add github:$Repo#$Tag" + "`n" + '```' + "`n"
    $body = ($body.TrimEnd()) + "`n`n### Install`n`n" + $installBlock
    $bodyFile = Join-Path ([System.IO.Path]::GetTempPath()) ("craft-release-body-" + [Guid]::NewGuid().ToString('N') + '.md')
    [IO.File]::WriteAllText($bodyFile, $body, (New-Object System.Text.UTF8Encoding($false)))

    # ---- 7. token + proxy ------------------------------------------------------------
    if (-not $Token) {
        $lines = "protocol=https`nhost=github.com`n`n" | git credential fill
        $Token = (($lines | Where-Object { $_ -like 'password=*' }) -replace '^password=', '')
    }
    if (-not $Token) { Fail 'no GitHub token (pass -Token or store one in the credential manager)' }
    $Proxy = ''
    try {
        $key = Get-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction Stop
        if ($key.ProxyEnable -eq 1 -and $key.ProxyServer) {
            $server = [string]$key.ProxyServer
            if ($server -notmatch '^\w+://') { $server = "http://$server" }
            $Proxy = $server
        }
    } catch { }

    # ---- 8. create the release through the API (JSON assembled by node) --------------
    $payloadFile = Join-Path ([System.IO.Path]::GetTempPath()) ("craft-release-" + [Guid]::NewGuid().ToString('N') + '.json')
    $env:REL_TAG = $Tag
    $env:REL_NAME = "dsh-craft-anything $Tag"
    $env:REL_BODY_FILE = $bodyFile
    $env:REL_OUT = $payloadFile
    $nodeScript = @'
const fs = require('node:fs')
const payload = {
  tag_name: process.env.REL_TAG,
  name: process.env.REL_NAME,
  body: fs.readFileSync(process.env.REL_BODY_FILE, 'utf8'),
  draft: false,
  prerelease: /-/.test(process.env.REL_TAG.replace(/^v/, '')),
}
fs.writeFileSync(process.env.REL_OUT, JSON.stringify(payload), 'utf8')
'@
    & node -e $nodeScript
    if ($LASTEXITCODE -ne 0) { Fail 'could not build the release payload' }

    $curlArgs = @('-sS', '--ssl-no-revoke', '-H', "Authorization: Bearer $Token", '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28')
    if ($Proxy) { $curlArgs += @('--proxy', $Proxy) }

    function Invoke-Api([string]$Method, [string]$Uri, [string]$BodyFile) {
        $call = @($curlArgs) + @('-X', $Method, '-w', "`n>HTTP %{http_code}")
        if ($BodyFile) { $call += @('--data-binary', "@$BodyFile") }
        $call += $Uri
        return (& curl.exe @call) -join "`n"
    }

    $existing = Invoke-Api 'GET' "https://api.github.com/repos/$Repo/releases/tags/$Tag" $null
    if ($existing -match '>HTTP 200') {
        Write-Step "release $Tag already exists: updating its notes"
        $result = Invoke-Api 'PATCH' "https://api.github.com/repos/$Repo/releases/tags/$Tag" $payloadFile
    } else {
        $result = Invoke-Api 'POST' "https://api.github.com/repos/$Repo/releases" $payloadFile
    }
    Remove-Item -Force $payloadFile, $bodyFile -ErrorAction SilentlyContinue
    if ($result -notmatch '>HTTP (200|201)') { Fail "GitHub release API failed:`n$result" }
    Write-Step 'release published'

    # ---- 9. verify -------------------------------------------------------------------
    $check = Invoke-Api 'GET' "https://api.github.com/repos/$Repo/releases/tags/$Tag" $null
    if ($check -notmatch '>HTTP 200') { Fail "release $Tag is not readable after publishing" }
    $release = ($check -replace '>HTTP \d+\s*$', '') | ConvertFrom-Json
    $remote = (git ls-remote --tags origin "refs/tags/$Tag" | Select-Object -First 1).Trim()
    if (-not $remote) { Fail "tag $Tag is not on origin" }
    Write-Step "verified: tag $Tag on origin ($($remote.Split("`t")[0].Substring(0, 7))), release $($release.html_url)"
    Write-Step "install this version: dsh plugin --profile desktop add github:$Repo#$Tag"
} finally {
    Pop-Location
}
