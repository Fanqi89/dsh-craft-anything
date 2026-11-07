#!/usr/bin/env node
// dsh-craft-anything — cross-platform CLI installer for macOS / Linux.
//
// Windows is handled by scripts/install-cli.ps1 (verified against the official portable zip);
// this script covers the platforms that ship a standalone CLI archive:
//
//   macOS : craft-anything-cli-<ver>-macos-universal.zip   (official, signed CLI)
//   Linux : craft-anything-<ver>-linux-<arch>.tar.gz      (contains the CLI next to the app)
//
// Both are downloaded from github.com/storytold/craft-anything releases, checked against the
// release's SHA256SUMS.txt, unpacked and installed under
//   ~/.dsh/plugins-data/craft-anything/<version>/craft-anything-cli
// with a stable copy at
//   ~/.dsh/plugins-data/craft-anything/bin/craft-anything-cli
//
// Usage: node install-cli.mjs [--version vX.Y.Z|latest] [--root DIR] [--force] [--dry-run]
// Exit codes: 0 installed or already present, 1 failure.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const REPO = 'storytold/craft-anything'
const PLATFORM = process.platform
const ARCH = process.arch

const args = process.argv.slice(2)
const option = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback
}
const flag = (name) => args.includes(name)

const REQUESTED_VERSION = option('--version', 'latest')
const ROOT = option('--root', join(process.env.HOME || process.env.USERPROFILE || '.', '.dsh', 'plugins-data', 'craft-anything'))
const FORCE = flag('--force')
const DRY_RUN = flag('--dry-run')
// --platform lets the packaging be exercised from another OS (tests, CI); it only changes which
// archive is downloaded, never how it is verified.
const TARGET_PLATFORM = option('--platform', PLATFORM)

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

function curl(url, outputFile) {
  const argv = ['-fsSL', '--retry', '3', '--retry-delay', '2', '--connect-timeout', '30']
  // Windows curl uses Schannel, which fails this machine's TLS-inspecting proxy unless the
  // revocation check is skipped. Other curl builds reject the option, so keep it Windows-only.
  if (process.platform === 'win32') argv.push('--ssl-no-revoke')
  if (PROXY) argv.push('--proxy', PROXY)
  if (outputFile) argv.push('-o', outputFile)
  argv.push(url)
  return execFileSync('curl', argv, { encoding: outputFile ? 'utf8' : 'utf8', stdio: outputFile ? ['ignore', 'inherit', 'pipe'] : ['ignore', 'pipe', 'pipe'] })
}

async function fetchText(url) {
  if (hasCurl) return curl(url, null)
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`)
  return response.text()
}

function download(url, outputFile) {
  if (hasCurl) {
    log(`downloading ${basename(url)}`)
    curl(url, outputFile)
    if (!existsSync(outputFile) || statSync(outputFile).size === 0) throw new Error(`download produced no bytes: ${url}`)
    return
  }
  throw new Error('curl is required to download the release (install curl or enable the system proxy helper)')
}

// --- version resolution ------------------------------------------------------------------------
async function resolveVersion() {
  if (REQUESTED_VERSION !== 'latest') return REQUESTED_VERSION.startsWith('v') ? REQUESTED_VERSION : `v${REQUESTED_VERSION}`
  log(`resolving the latest release of ${REPO}`)
  const body = await fetchText(`https://api.github.com/repos/${REPO}/releases/latest`)
  const tag = JSON.parse(body).tag_name
  if (!tag) throw new Error('GitHub returned no tag_name for the latest release')
  return tag
}

function assetName(tag) {
  const version = tag.replace(/^v/, '')
  if (TARGET_PLATFORM === 'darwin') return { asset: `craft-anything-cli-${version}-macos-universal.zip`, kind: 'zip', cli: 'craft-anything-cli' }
  if (TARGET_PLATFORM === 'linux') {
    const arch = ARCH === 'x64' ? 'x86_64' : ARCH === 'arm64' ? 'aarch64' : ARCH === 'riscv64' ? 'riscv64' : ARCH
    return { asset: `craft-anything-${version}-linux-${arch}.tar.gz`, kind: 'targz', cli: 'craft-anything-cli' }
  }
  throw new Error(`unsupported platform ${TARGET_PLATFORM}; Windows uses scripts/install-cli.ps1`)
}

// --- helpers ------------------------------------------------------------------------------------
function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function findFile(root, name) {
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.name === name) return full
    }
  }
  return null
}

function findInstalled(version) {
  if (!existsSync(ROOT)) return null
  for (const entry of readdirSync(ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const candidate = join(ROOT, entry.name, 'craft-anything-cli')
    if (!existsSync(candidate)) continue
    try {
      const reported = execFileSync(candidate, ['--version'], { encoding: 'utf8' }).trim()
      if (reported.includes(version)) return candidate
    } catch { /* not runnable, keep looking */ }
  }
  return null
}

// --- main ---------------------------------------------------------------------------------------
try {
  const tag = await resolveVersion()
  const version = tag.replace(/^v/, '')
  const { asset, kind, cli } = assetName(tag)
  log(`version ${version}, platform ${PLATFORM}-${ARCH}`)

  const installed = FORCE ? null : findInstalled(version)
  if (installed) {
    log(`already installed: ${installed}`)
    process.exit(0)
  }
  if (DRY_RUN) {
    log(`would download ${asset} and install to ${join(ROOT, version, cli)}`)
    process.exit(0)
  }

  mkdirSync(ROOT, { recursive: true })
  const work = mkdtempSync(join(tmpdir(), 'craft-anything-'))
  try {
    const archive = join(work, asset)
    download(`https://github.com/${REPO}/releases/download/${tag}/${asset}`, archive)
    const sumsPath = join(work, 'SHA256SUMS.txt')
    download(`https://github.com/${REPO}/releases/download/${tag}/SHA256SUMS.txt`, sumsPath)

    const line = readFileSync(sumsPath, 'utf8').split(/\r?\n/).find((row) => row.trim().endsWith(asset))
    if (!line) fail(`${asset} is not listed in SHA256SUMS.txt`)
    const expected = line.trim().split(/\s+/)[0].toLowerCase()
    const actual = sha256(archive)
    if (expected !== actual) fail(`sha256 mismatch for ${asset}\n  expected ${expected}\n  actual   ${actual}`)
    log(`sha256 ok: ${actual}`)

    const unpacked = join(work, 'unpacked')
    mkdirSync(unpacked, { recursive: true })
    if (kind === 'zip') {
      try {
        execFileSync('unzip', ['-q', '-o', archive, '-d', unpacked], { stdio: 'inherit' })
      } catch {
        // Windows has bsdtar, which reads zip too; useful for the cross-platform layout check.
        execFileSync('tar', ['-xf', archive, '-C', unpacked], { stdio: 'inherit' })
      }
    } else {
      execFileSync('tar', ['-xzf', archive, '-C', unpacked], { stdio: 'inherit' })
    }

    const binary = findFile(unpacked, cli)
    if (!binary) {
      fail(`the ${asset} archive does not contain ${cli}; install it from source instead: cargo install --path apps/craft-anything-cli`)
    }

    const targetDir = join(ROOT, version)
    mkdirSync(targetDir, { recursive: true })
    const target = join(targetDir, cli)
    copyFileSync(binary, target)
    chmodSync(target, 0o755)
    const stableDir = join(ROOT, 'bin')
    mkdirSync(stableDir, { recursive: true })
    copyFileSync(target, join(stableDir, cli))
    chmodSync(join(stableDir, cli), 0o755)

    const reported = TARGET_PLATFORM === PLATFORM ? execFileSync(target, ['--version'], { encoding: 'utf8' }).trim() : '(cross-platform check: not runnable here)'
    log(`installed ${reported} at ${target}`)
    console.log(target)
    process.exit(0)
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
  }
} catch (error) {
  fail(String(error && error.message ? error.message : error))
}
