#!/usr/bin/env node
// dsh-craft-anything — cross-platform CLI installer for macOS / Linux.
//
// Windows is handled by scripts/install-cli.ps1 (verified against the official portable zip);
// this script covers the platforms whose release ships a standalone CLI archive:
//
//   macOS : craft-anything-cli-<ver>-macos-universal.zip   (official CLI, universal Mach-O)
//   Linux : craft-anything-<ver>-linux-<arch>.tar.gz      (CLI inside the release tree)
//
// Flow
//   1. Resolve the tag: --version, or the latest release (release metadata API).
//   2. Read the release metadata (api.github.com/repos/storytold/craft-anything) and pick the
//      archive whose name matches this platform, e.g.
//        ^craft-anything-<ver>-linux-(x86_64|aarch64|riscv64)\.tar\.gz$
//        ^craft-anything-cli-<ver>-macos-universal\.zip$
//      with the arch derived from process.arch (x64->x86_64, arm64->aarch64). A failed metadata
//      request is never fatal by itself: the constructed name is used as the fallback and the
//      download + SHA256SUMS gate still decide. When the metadata IS reachable but lists no
//      matching asset, that is fatal (the closest asset names are printed) instead of guessing.
//   3. Download the archive and SHA256SUMS.txt from the same release. The SHA-256 check is
//      mandatory — there is no --no-verify; a mismatch prints both hashes and stops.
//   4. Unpack it and find the CLI anywhere inside. The real v0.6.0 Linux tarball is an FHS tree
//      under a single nested directory:
//        craft-anything-<ver>-linux-<arch>/usr/bin/{craft-anything,craft-anything-cli}
//      older/manual archives may keep the CLI at the top level, and a file named plain
//      `craft-anything` is accepted only when no `craft-anything-cli` exists (the chosen path is
//      always logged).
//   5. Install it as
//        <root>/<version>/craft-anything-cli
//        <root>/bin/craft-anything-cli     (stable copy)
//      chmod 755 on both, and print the <root>/<version>/craft-anything-cli path last.
//
// Already have a CLI?
//   Set CRAFT_ANYTHING_CLI=/abs/path/to/craft-anything-cli. The installer then reports
//   "using the CLI provided by CRAFT_ANYTHING_CLI: <path>" and exits 0 without touching the
//   network or the install root. `--force` deliberately ignores that variable and installs a
//   managed copy under --root (so an env-provided CLI can be replaced by a managed one).
//
// Usage
//   node install-cli.mjs [--version vX.Y.Z|latest] [--root DIR] [--force] [--dry-run]
//                        [--platform linux|darwin] [--base-url URL] [--api-url URL]
//
//   --platform  packaging override for tests/CI (hidden seam): only chooses which archive is
//               downloaded, never how it is verified. Default: process.platform.
//   --base-url  hidden test seam: replaces
//               https://github.com/storytold/craft-anything/releases/download
//   --api-url   hidden test seam: replaces
//               https://api.github.com/repos/storytold/craft-anything
//   --dry-run   print the resolved version/asset/URL and exit without downloading.
//
// Exit codes: 0 = installed / already present / CLI provided by CRAFT_ANYTHING_CLI, 1 = failure.
// Every failure prints exactly one "[craft-anything] ERROR:" line that names the manual fix.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { githubCandidates, rankSync } from './mirrors.mjs'

const REPO = 'storytold/craft-anything'
const RELEASES_PAGE = `https://github.com/${REPO}/releases`
const DEFAULT_DOWNLOAD_BASE = `https://github.com/${REPO}/releases/download`
const DEFAULT_API_BASE = `https://api.github.com/repos/${REPO}`
const CLI_NAME = 'craft-anything-cli'
const PROVIDER_HINT = `download the archive by hand from ${RELEASES_PAGE} and point CRAFT_ANYTHING_CLI at the extracted ${CLI_NAME}`

const PLATFORM = process.platform
const ARCH = process.arch
const LINUX_ARCH = { x64: 'x86_64', arm64: 'aarch64', riscv64: 'riscv64' }[ARCH] || ARCH

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}
const flag = (name) => args.includes(name)
const trimUrl = (value) => value.replace(/\/+$/, '')
const firstLine = (error) => String(error && error.message ? error.message : error).split(/\r?\n/)[0].trim()

const REQUESTED_VERSION = option('--version', 'latest')
const ROOT = option('--root', join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh', 'plugins-data', 'craft-anything'))
const FORCE = flag('--force')
const DRY_RUN = flag('--dry-run')
const TARGET_PLATFORM = option('--platform', PLATFORM)
const DOWNLOAD_BASE = trimUrl(option('--base-url', DEFAULT_DOWNLOAD_BASE))
const API_BASE = trimUrl(option('--api-url', DEFAULT_API_BASE))
const PROVIDED_CLI = (process.env.CRAFT_ANYTHING_CLI || '').trim()

const log = (message) => console.log(`[craft-anything] ${message}`)

function fail(message) {
  console.error(`[craft-anything] ERROR: ${message}`)
  process.exit(1)
}

// --- network: use the system proxy when there is one -------------------------------------------
function detectProxy() {
  if (process.env.HTTPS_PROXY || process.env.HTTP_PROXY) return process.env.HTTPS_PROXY || process.env.HTTP_PROXY
  return ''
}

const PROXY = detectProxy()
const hasCurl = (() => {
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

function curlArgs() {
  const argv = ['-fsSL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '30']
  // Windows curl uses Schannel, which fails this machine's TLS-inspecting proxy unless the
  // revocation check is skipped. Other curl builds reject the option, so keep it Windows-only.
  if (process.platform === 'win32') argv.push('--ssl-no-revoke')
  if (PROXY) argv.push('--proxy', PROXY)
  return argv
}

function curl(url, outputFile) {
  const argv = curlArgs()
  if (outputFile) argv.push('-o', outputFile)
  argv.push(url)
  return execFileSync('curl', argv, { encoding: 'utf8', stdio: outputFile ? ['ignore', 'inherit', 'pipe'] : ['ignore', 'pipe', 'pipe'] })
}

async function fetchText(url) {
  if (hasCurl) return curl(url, null)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response.text()
}

function download(url, outputFile, what) {
  if (!hasCurl) {
    throw new Error(`curl is required to download ${what} but was not found on PATH; install curl (it ships with macOS; Debian/Ubuntu: sudo apt-get install curl), or ${PROVIDER_HINT}`)
  }
  log(`downloading ${basename(url)}`)
  try {
    curl(url, outputFile)
  } catch (error) {
    throw new Error(`cannot download ${what} from ${url} (${firstLine(error)}); the asset may be missing from this release; ${PROVIDER_HINT}, or install from source: cargo install --path apps/craft-anything-cli`)
  }
  if (!existsSync(outputFile) || statSync(outputFile).size === 0) {
    throw new Error(`the download of ${what} produced no bytes (${url}); ${PROVIDER_HINT}`)
  }
}

// --- release metadata: tag + asset resolution --------------------------------------------------
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function desiredAsset(version) {
  if (TARGET_PLATFORM === 'darwin') {
    return {
      name: `${CLI_NAME}-${version}-macos-universal.zip`,
      pattern: new RegExp(`^${CLI_NAME}-${escapeRegExp(version)}-macos-universal\\.zip$`),
      kind: 'zip',
    }
  }
  if (TARGET_PLATFORM === 'linux') {
    return {
      name: `craft-anything-${version}-linux-${LINUX_ARCH}.tar.gz`,
      pattern: new RegExp(`^craft-anything-${escapeRegExp(version)}-linux-(x86_64|aarch64|riscv64)\\.tar\\.gz$`),
      kind: 'targz',
    }
  }
  throw new Error(`unsupported platform ${TARGET_PLATFORM}: on Windows use scripts/install-cli.ps1; elsewhere set CRAFT_ANYTHING_CLI to an existing ${CLI_NAME} or run this from macOS/Linux`)
}

// Best-effort tag recovery when api.github.com is unreachable/rate-limited: the /releases/latest
// page redirects to /releases/tag/<tag>. Only useful for the real GitHub host (no test seam).
function latestTagFromRedirect() {
  if (!hasCurl || DOWNLOAD_BASE !== DEFAULT_DOWNLOAD_BASE) return null
  try {
    const devNull = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const argv = [...curlArgs(), '-o', devNull, '-w', '%{url_effective}', `${RELEASES_PAGE}/latest`]
    const effective = execFileSync('curl', argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    const match = /\/tag\/(v[^/?#]+)$/.exec(effective)
    return match ? match[1] : null
  } catch {
    return null
  }
}

async function resolveLatestTag() {
  const apiUrl = `${API_BASE}/releases/latest`
  try {
    const body = await fetchText(apiUrl)
    const tag = JSON.parse(body).tag_name
    if (tag) return tag
    throw new Error('the release metadata contains no tag_name')
  } catch (error) {
    log(`cannot resolve the latest release from ${apiUrl} (${firstLine(error)})`)
    const fromRedirect = latestTagFromRedirect()
    if (fromRedirect) {
      log(`resolved ${fromRedirect} from the release page redirect`)
      return fromRedirect
    }
    throw new Error(`cannot resolve the latest release of ${REPO}: ${firstLine(error)}; pass --version vX.Y.Z explicitly, or ${PROVIDER_HINT}`)
  }
}

async function fetchReleaseMetadata(tag, useLatestEndpoint) {
  const url = useLatestEndpoint ? `${API_BASE}/releases/latest` : `${API_BASE}/releases/tags/${encodeURIComponent(tag)}`
  const body = await fetchText(url)
  const release = JSON.parse(body)
  if (!release || !Array.isArray(release.assets)) throw new Error(`${url} returned no asset list`)
  return release
}

function closestNames(names, desired) {
  const tokens = new Set(desired.name.split(/[-.]/))
  const scored = names
    .map((name) => ({ name, score: name.split(/[-.]/).filter((token) => tokens.has(token)).length }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
  return scored.slice(0, 6).map((entry) => entry.name)
}

async function resolveAsset(tag, version, useLatestEndpoint) {
  const desired = desiredAsset(version)
  let release = null
  try {
    release = await fetchReleaseMetadata(tag, useLatestEndpoint)
  } catch (error) {
    // A failed metadata request is not fatal by itself: try the constructed name and let the
    // download + SHA256SUMS verification decide.
    log(`release metadata unavailable (${firstLine(error)}); falling back to the constructed asset name`)
    return { ...desired, url: `${DOWNLOAD_BASE}/${tag}/${desired.name}`, fromMetadata: false }
  }

  const exact = release.assets.find((asset) => asset && asset.name === desired.name)
  const matched = exact || release.assets.find((asset) => asset && typeof asset.name === 'string' && desired.pattern.test(asset.name))
  if (!matched) {
    const names = release.assets.map((asset) => (asset && asset.name) || '').filter(Boolean)
    const closest = closestNames(names, desired)
    throw new Error(`${desired.name} is not part of release ${release.tag_name || tag} (that release lists ${names.length} assets).`
      + (closest.length ? `\nclosest matching assets: ${closest.join(', ')}` : '\nno asset name matches the expected platform pattern')
      + `\n${PROVIDER_HINT}, or install from source: cargo install --path apps/craft-anything-cli`)
  }
  if (!exact) {
    log(`WARNING: ${desired.name} is not published for ${tag}; using ${matched.name} (it may target a different CPU architecture)`)
  }
  const url = matched.browser_download_url && DOWNLOAD_BASE === DEFAULT_DOWNLOAD_BASE
    ? matched.browser_download_url
    : `${DOWNLOAD_BASE}/${tag}/${matched.name}`
  return { name: matched.name, url, kind: desired.kind, fromMetadata: true }
}

// --- local helpers -----------------------------------------------------------------------------
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function parseSums(text) {
  const entries = new Map()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    if (match) entries.set(match[2].trim(), match[1].toLowerCase())
  }
  return entries
}

// Every regular file named `name` anywhere under root (symlinks are followed so archives that
// ship the CLI as a link still work).
function findAllFiles(root, name) {
  const found = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (entry.name !== name) continue
      try {
        if (statSync(full).isFile()) found.push(full)
      } catch { /* dangling link or unreadable entry */ }
    }
  }
  return found
}

// Prefer craft-anything-cli; accept plain craft-anything only when there is no -cli binary.
function locateCli(root) {
  for (const name of [CLI_NAME, 'craft-anything']) {
    const matches = findAllFiles(root, name)
    if (matches.length === 0) continue
    const depth = (file) => relative(root, file).split(/[\\/]/).length
    matches.sort((left, right) => depth(left) - depth(right) || left.localeCompare(right))
    return { name, path: matches[0] }
  }
  return null
}

/** Download bases in order: fastest mirror first, github.com last. Tests keep one base. */
function sourceBases(tag) {
  if (DOWNLOAD_BASE !== DEFAULT_DOWNLOAD_BASE) return [DOWNLOAD_BASE + '/' + tag]
  const probe = githubCandidates(`${DEFAULT_DOWNLOAD_BASE}/${tag}/SHA256SUMS.txt`)
  const ranked = rankSync(probe)
  return ranked.map((url) => url.replace(/\/SHA256SUMS\.txt$/, ''))
}

function topLevelEntries(root) {
  try { return readdirSync(root).slice(0, 12) } catch { return [] }
}

function unpack(archive, kind, destination) {
  const run = (command, argv) => execFileSync(command, argv, { stdio: 'inherit' })
  try {
    if (kind === 'zip') {
      try {
        run('unzip', ['-q', '-o', archive, '-d', destination])
      } catch {
        // Windows ships bsdtar, which reads zip as well; useful for the cross-platform layout check.
        run('tar', ['-xf', archive, '-C', destination])
      }
    } else {
      run('tar', ['-xzf', archive, '-C', destination])
    }
  } catch (error) {
    throw new Error(`cannot unpack ${basename(archive)} (${firstLine(error)}); install tar (and unzip for macOS archives), or ${PROVIDER_HINT}, or install from source: cargo install --path apps/craft-anything-cli`)
  }
}

// A previous managed install is reused only when its binary can actually run on this host.
function findInstalled(version) {
  if (FORCE) return null
  if (TARGET_PLATFORM !== PLATFORM) return null
  if (!existsSync(ROOT)) return null
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(ROOT, entry.name, CLI_NAME)
    if (!existsSync(candidate)) continue
    try {
      const reported = execFileSync(candidate, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
      if (reported.includes(version)) return candidate
    } catch { /* not runnable, keep looking */ }
  }
  return null
}

// --- main ---------------------------------------------------------------------------------------
try {
  // An env-provided CLI means the user already has one: report it and do not download anything.
  // --force opts back into a managed copy (documented in the header).
  if (PROVIDED_CLI) {
    if (!existsSync(PROVIDED_CLI)) {
      log(`ignoring CRAFT_ANYTHING_CLI: ${PROVIDED_CLI} does not exist`)
    } else if (FORCE) {
      log(`--force: ignoring CRAFT_ANYTHING_CLI=${PROVIDED_CLI}; installing a managed copy under ${ROOT}`)
    } else {
      let detail = ''
      try {
        const reported = execFileSync(PROVIDED_CLI, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        if (reported) detail = ` (${reported})`
      } catch { /* not runnable on this host; the path is still what the caller asked for */ }
      log(`using the CLI provided by CRAFT_ANYTHING_CLI: ${PROVIDED_CLI}${detail}`)
      console.log(PROVIDED_CLI)
      process.exit(0)
    }
  }

  const useLatestEndpoint = REQUESTED_VERSION === 'latest'
  const tag = useLatestEndpoint
    ? await resolveLatestTag()
    : (REQUESTED_VERSION.startsWith('v') ? REQUESTED_VERSION : `v${REQUESTED_VERSION}`)
  const version = tag.replace(/^v/, '')
  const asset = await resolveAsset(tag, version, useLatestEndpoint)

  log(`version ${version}, platform ${TARGET_PLATFORM}-${ARCH}${TARGET_PLATFORM === PLATFORM ? '' : ` (host ${PLATFORM}-${ARCH})`}`)
  log(`asset ${asset.name} (${asset.fromMetadata ? 'resolved from the release metadata' : 'constructed name; release metadata unavailable'})`)

  const installed = findInstalled(version)
  if (installed) {
    log(`already installed: ${installed}`)
    console.log(installed)
    process.exit(0)
  }

  if (DRY_RUN) {
    log(`would download ${asset.url} and install to ${join(ROOT, version, CLI_NAME)}`)
    process.exit(0)
  }

  mkdirSync(ROOT, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'craft-anything-'))
  try {
    const archive = join(work, asset.name)
    const sumsPath = join(work, 'SHA256SUMS.txt')
    const bases = sourceBases(tag)
    if (bases.length > 1) log(`download sources: ${bases.join(' | ')}`)

    // A mirror only serves bytes: the checksum decides whether they are the official archive, so a
    // bad/truncated mirror download simply moves on to the next source.
    let usedBase = null
    let checksum = null
    const failures = []
    for (const base of bases) {
      try {
        download(`${base}/${asset.name}`, archive, `the release archive ${asset.name}`)
        download(`${base}/SHA256SUMS.txt`, sumsPath, 'SHA256SUMS.txt (checksum verification is mandatory)')
        const sums = parseSums(readFileSync(sumsPath, 'utf8'))
        const expected = sums.get(asset.name)
        if (!expected) {
          const closest = closestNames([...sums.keys()], asset)
          throw new Error(`${asset.name} is not listed in SHA256SUMS.txt (${sums.size} entries); refusing to install an unverified file`
            + (closest.length ? `\nclosest SHA256SUMS.txt entries: ${closest.join(', ')}` : '')
            + `\n${PROVIDER_HINT}, or install from source: cargo install --path apps/craft-anything-cli`)
        }
        const actual = sha256(archive)
        if (actual !== expected) {
          throw new Error(`sha256 mismatch for ${asset.name}\n  expected ${expected}\n  actual   ${actual}\nrefusing to install a corrupt or tampered download; re-run the installer, or ${PROVIDER_HINT}`)
        }
        usedBase = base
        checksum = actual
        break
      } catch (error) {
        failures.push(`${base}: ${String((error && error.message) || error).slice(0, 600)}`)
        log(`source failed: ${firstLine(error)}`)
      }
    }
    if (!usedBase) {
      throw new Error(`every download source failed:\n  ${failures.join('\n  ')}`)
    }
    log(`sha256 ok: ${checksum}`)

    const unpacked = join(work, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    unpack(archive, asset.kind, unpacked)

    const picked = locateCli(unpacked)
    if (!picked) {
      const listed = topLevelEntries(unpacked)
      throw new Error(`${basename(archive)} does not contain the craft-anything CLI (looked for ${CLI_NAME} anywhere inside, then craft-anything).`
        + (listed.length ? `\narchive top level: ${listed.join(', ')}` : '')
        + `\neither point CRAFT_ANYTHING_CLI at an existing ${CLI_NAME}, or install from source: cargo install --path apps/craft-anything-cli`)
    }
    const pickedPath = (relative(unpacked, picked.path) || picked.name).split(sep).join('/')
    log(picked.name === CLI_NAME
      ? `using ${CLI_NAME} at ${pickedPath}`
      : `using the ${picked.name} binary at ${pickedPath} (no ${CLI_NAME} in this archive)`)

    const targetDir = join(ROOT, version)
    mkdirSync(targetDir, { recursive: true })
    const target = join(targetDir, CLI_NAME)
    copyFileSync(picked.path, target)
    chmodSync(target, 0o755)
    const stableDir = join(ROOT, 'bin')
    mkdirSync(stableDir, { recursive: true })
    copyFileSync(target, join(stableDir, CLI_NAME))
    chmodSync(join(stableDir, CLI_NAME), 0o755)

    let reported = '(cross-platform install: the binary is not runnable on this host)'
    if (TARGET_PLATFORM === PLATFORM) {
      try {
        const versionText = execFileSync(target, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
        if (versionText) reported = versionText
      } catch {
        reported = '(installed, but --version did not run on this host)'
      }
    }
    log(`installed ${reported} at ${target}`)
    console.log(target)
    process.exit(0)
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
  }
} catch (error) {
  fail(String(error && error.message ? error.message : error))
}
