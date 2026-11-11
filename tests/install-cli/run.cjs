#!/usr/bin/env node
'use strict'
// tests/install-cli/run.cjs - offline proof for scripts/install-cli.mjs.
//
// Why: the Linux one-click install failed for a real user (the v0.1.x package did not ship the
// installer at all, and the Linux/macOS archive layout was never exercised). This runner proves
// both platform branches on any host, without a Linux box and without touching the real install
// root, by:
//
//   1. Building a fake release tree in %TEMP%: a Linux tar.gz shaped like the real v0.6.0 one
//      (nested craft-anything-<ver>-linux-<arch>/usr/bin/ tree holding both the GUI binary and
//      craft-anything-cli), a macOS universal zip with the CLI at the root, a matching
//      SHA256SUMS.txt, plus the negative fixtures (wrong hash, missing sums entry, archive without
//      any CLI, a release without the Linux asset).
//   2. Serving it from a local node:http server on an ephemeral port. The installer's hidden
//      seams --base-url / --api-url point at it, so no network access is needed.
//   3. Running scripts/install-cli.mjs with --platform linux / --platform darwin and --root in
//      the temp workspace, asserting byte-identical installs, chmod 755 (where the host has
//      POSIX modes), the printed target path, and non-zero exits with actionable [craft-anything]
//      ERROR lines for every failure mode, plus the CRAFT_ANYTHING_CLI short circuit.
//
// Usage: node tests/install-cli/run.cjs   (prints PASS/FAIL per case, exits non-zero on failure)
//
// No external dependencies: tar comes from the OS, the zip fixture is written by hand below.

const { execFileSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')

const SCRIPT = path.resolve(__dirname, '..', '..', 'scripts', 'install-cli.mjs')
const TAG = 'v0.6.0'
const VERSION = '0.6.0'
const LINUX_ARCH = { x64: 'x86_64', arm64: 'aarch64', riscv64: 'riscv64' }[process.arch] || 'x86_64'
const LINUX_DIR = `craft-anything-${VERSION}-linux-${LINUX_ARCH}`
const LINUX_ASSET = `${LINUX_DIR}.tar.gz`
const MAC_ASSET = `craft-anything-cli-${VERSION}-macos-universal.zip`

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-install-tests-'))
const FIXTURES = path.join(WORK, 'fixtures')
fs.mkdirSync(FIXTURES, { recursive: true })

// --- fixture bytes ------------------------------------------------------------------------------
const LINUX_CLI = Buffer.concat([
  Buffer.from('#!/bin/sh\n# fake craft-anything-cli (linux fixture)\necho "craft-anything-cli 0.6.0"\n'),
  Buffer.from(Array.from({ length: 256 }, (_, index) => index)),
])
const MAC_CLI = Buffer.concat([
  Buffer.from('#!/bin/sh\n# fake craft-anything-cli (macOS universal fixture)\necho "craft-anything-cli 0.6.0"\n'),
  Buffer.from(Array.from({ length: 256 }, (_, index) => 255 - index)),
])
const GUI_CLI = Buffer.from('#!/bin/sh\n# fake GUI-named craft-anything binary\necho "craft-anything 0.6.0"\n')
const README = Buffer.from('fixture file; not a CLI\n')

// --- tiny helpers -------------------------------------------------------------------------------
const sha256 = (buffer) => require('node:crypto').createHash('sha256').update(buffer).digest('hex')

function sumsFor(files) {
  return Buffer.from(files.map((file) => `${sha256(file.data)}  ${file.name}`).join('\n') + '\n')
}

// Write a tar.gz whose members are {path, data}; top-level entries become archive roots.
function writeTarball(outPath, entries) {
  const staging = fs.mkdtempSync(path.join(WORK, 'stage-'))
  const tops = new Set()
  for (const entry of entries) {
    const full = path.join(staging, entry.path)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, entry.data)
    tops.add(entry.path.split('/')[0])
  }
  execFileSync('tar', ['-czf', outPath, '-C', staging, ...tops], { stdio: 'ignore' })
  return outPath
}

// A STORE-method zip writer so the macOS fixture needs no external zip tool (GNU tar cannot
// create zip, and `zip` is not guaranteed to exist).
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

function makeZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const crc = crc32(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0, 6) // flags
    local.writeUInt16LE(0, 8) // method: store
    local.writeUInt16LE(0, 10) // time
    local.writeUInt16LE(0x21, 12) // date: 1980-01-01
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by (MS-DOS)
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38) // external attributes
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }
  const centralSize = centrals.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, ...centrals, end])
}

// --- fixtures -----------------------------------------------------------------------------------
// The Linux fixture mirrors the real v0.6.0 tarball produced by upstream
// packaging/linux/package.sh: a single nested craft-anything-<ver>-linux-<arch>/ directory holding
// an FHS tree with BOTH usr/bin/craft-anything (GUI) and usr/bin/craft-anything-cli, so the test
// also proves the installer prefers the CLI over the GUI binary next to it.
const linuxNestedTar = writeTarball(path.join(FIXTURES, LINUX_ASSET), [
  { path: `${LINUX_DIR}/usr/bin/craft-anything`, data: GUI_CLI },
  { path: `${LINUX_DIR}/usr/bin/craft-anything-cli`, data: LINUX_CLI },
  { path: `${LINUX_DIR}/usr/share/applications/ai.storyteller.craft-anything.desktop`, data: Buffer.from('[Desktop Entry]\nName=Craft Anything\n') },
  { path: `${LINUX_DIR}/usr/share/doc/craft-anything/README.txt`, data: README },
])
const linuxGuiNamedTar = writeTarball(path.join(FIXTURES, 'gui-named.tar.gz'), [
  { path: `${LINUX_DIR}/craft-anything`, data: GUI_CLI },
])
const linuxNoCliTar = writeTarball(path.join(FIXTURES, 'no-cli.tar.gz'), [
  { path: `${LINUX_DIR}/README.txt`, data: README },
])
const macZip = path.join(FIXTURES, MAC_ASSET)
fs.writeFileSync(macZip, makeZip([
  { name: 'craft-anything-cli', data: MAC_CLI },
  { name: 'README.txt', data: README },
]))

const RELEASE_FILES = [
  { name: LINUX_ASSET, data: fs.readFileSync(linuxNestedTar) },
  { name: MAC_ASSET, data: fs.readFileSync(macZip) },
]
const RELEASE_SUMS = sumsFor(RELEASE_FILES)

function zipExtractionWorks() {
  const probeZip = path.join(WORK, 'probe.zip')
  fs.writeFileSync(probeZip, makeZip([{ name: 'probe.txt', data: Buffer.from('probe') }]))
  const destination = fs.mkdtempSync(path.join(WORK, 'zip-probe-'))
  try {
    execFileSync('unzip', ['-q', '-o', probeZip, '-d', destination], { stdio: 'ignore' })
  } catch {
    try {
      execFileSync('tar', ['-xf', probeZip, '-C', destination], { stdio: 'ignore' })
    } catch {
      return false
    }
  }
  return fs.existsSync(path.join(destination, 'probe.txt'))
}

// --- fixture HTTP server (release metadata + release downloads) ---------------------------------
function startServer({ files, sums, apiMode = 'ok', assetNames }) {
  return new Promise((resolve, reject) => {
    const requests = []
    const routes = new Map()
    for (const file of files) routes.set(`/dl/${TAG}/${file.name}`, file.data)
    if (sums) routes.set(`/dl/${TAG}/SHA256SUMS.txt`, sums)
    const names = assetNames || files.map((file) => file.name)

    const server = http.createServer((request, response) => {
      requests.push(request.url || '')
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1')
      if (requestUrl.pathname.startsWith('/api/releases/')) {
        if (apiMode === 'error') {
          response.writeHead(500, { 'content-type': 'text/plain' })
          response.end('fixture: release metadata unavailable')
          return
        }
        const port = server.address().port
        const body = JSON.stringify({
          tag_name: TAG,
          assets: names.map((name) => ({ name, browser_download_url: `http://127.0.0.1:${port}/dl/${TAG}/${name}` })),
        })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(body)
        return
      }
      const data = routes.get(decodeURIComponent(requestUrl.pathname))
      if (data) {
        response.writeHead(200, { 'content-type': 'application/octet-stream' })
        response.end(data)
        return
      }
      response.writeHead(404, { 'content-type': 'text/plain' })
      response.end('not found')
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        base: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((done) => {
          if (typeof server.closeAllConnections === 'function') server.closeAllConnections()
          server.close(() => done())
        }),
      })
    })
  })
}

async function withServer(scenario, body) {
  const server = await startServer(scenario)
  try {
    return await body(server)
  } finally {
    await server.close()
  }
}

// --- running the installer / assertions ---------------------------------------------------------
const PROXY_ENV = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'NO_PROXY', 'no_proxy']
const PATH_KEY = process.platform === 'win32' ? 'Path' : 'PATH'

// Asynchronous on purpose: the fixture HTTP server lives in this process, so a blocking
// spawnSync would starve the event loop and deadlock the installer's downloads.
function runInstaller(installArgs, extraEnv = {}) {
  const env = { ...process.env }
  for (const key of PROXY_ENV) delete env[key]
  delete env.CRAFT_ANYTHING_CLI
  Object.assign(env, extraEnv)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...installArgs], { cwd: WORK, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    const timer = setTimeout(() => child.kill(), 300000)
    child.on('error', (error) => { clearTimeout(timer); reject(error) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }) })
  })
}

function ok(condition, message) {
  if (!condition) throw new Error(message)
}

function lastLine(text) {
  return text.trimEnd().split(/\r?\n/).pop() || ''
}

function expectExitCode(result, expected) {
  ok(result.code === expected, `expected exit ${expected}, got ${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`)
}

function expectContains(text, needle, label) {
  ok(text.includes(needle), `${label} does not contain ${JSON.stringify(needle)}\n--- ${label} ---\n${text}`)
}

function expectMatch(text, pattern, label) {
  ok(pattern.test(text), `${label} does not match ${pattern}\n--- ${label} ---\n${text}`)
}

function expectFile(file) {
  ok(fs.existsSync(file), `missing ${file}`)
}

function expectBytes(file, expected, label) {
  expectFile(file)
  ok(fs.readFileSync(file).equals(expected), `${label} is not byte-identical to the fixture: ${file}`)
}

function expectExecutable(file) {
  if (process.platform === 'win32') return // chmod is a no-op on Windows; presence is asserted separately
  const mode = fs.statSync(file).mode & 0o777
  ok((mode & 0o111) !== 0, `${file} is not executable (mode ${mode.toString(8)})`)
}

function expectAbsent(file) {
  ok(!fs.existsSync(file), `did not expect ${file} to exist`)
}

let rootCounter = 0
function freshRoot(label) {
  rootCounter += 1
  const root = path.join(WORK, 'roots', `${label}-${rootCounter}`)
  fs.mkdirSync(root, { recursive: true })
  return root
}

function installerArgs(server, root, platform, extra = []) {
  return [
    '--version', TAG,
    '--platform', platform,
    '--base-url', `${server.base}/dl`,
    '--api-url', `${server.base}/api`,
    '--root', root,
    ...extra,
  ]
}

// --- cases --------------------------------------------------------------------------------------
const summary = { passed: 0, failed: 0, skipped: 0 }

async function runCase(name, body) {
  try {
    const outcome = await body()
    if (outcome === 'skip') {
      summary.skipped += 1
      console.log(`SKIP ${name}`)
      return
    }
    summary.passed += 1
    console.log(`PASS ${name}`)
  } catch (error) {
    summary.failed += 1
    const message = String((error && error.message) || error)
    console.log(`FAIL ${name}`)
    for (const line of message.split('\n')) console.log(`     ${line}`)
  }
}

async function main() {
  if (!fs.existsSync(SCRIPT)) {
    console.error(`installer not found: ${SCRIPT}`)
    process.exit(1)
  }
  const zipUsable = zipExtractionWorks()

  console.log(`install-cli tests - host ${process.platform}-${process.arch}, fixtures in ${WORK}`)
  console.log(`installer: ${SCRIPT}`)
  console.log(`linux asset: ${LINUX_ASSET}`)
  console.log(`macOS asset: ${MAC_ASSET}`)
  console.log('')

  await runCase('linux: nested craft-anything-cli in the release tar.gz installs byte-identically', async () => {
    await withServer({ files: RELEASE_FILES, sums: RELEASE_SUMS }, async (server) => {
      const root = freshRoot('linux')
      const result = await runInstaller(installerArgs(server, root, 'linux'))
      expectExitCode(result, 0)
      const target = path.join(root, VERSION, 'craft-anything-cli')
      const stable = path.join(root, 'bin', 'craft-anything-cli')
      expectBytes(target, LINUX_CLI, 'installed CLI')
      expectBytes(stable, LINUX_CLI, 'stable copy')
      expectExecutable(target)
      expectExecutable(stable)
      ok(lastLine(result.stdout) === target, `last stdout line is not the target path: ${JSON.stringify(lastLine(result.stdout))}`)
      expectContains(result.stdout, 'resolved from the release metadata', 'stdout')
      expectContains(result.stdout, 'sha256 ok', 'stdout')
      expectContains(result.stdout, `${LINUX_DIR}/usr/bin/craft-anything-cli`, 'stdout')
      ok(!result.stdout.includes('using the craft-anything binary'), `the GUI-named binary was picked instead of craft-anything-cli:\n${result.stdout}`)
      expectContains(result.stdout, 'cross-platform install', 'stdout') // it must not try to run a Linux binary here
      const downloads = server.requests.filter((request) => request.startsWith('/dl/'))
      ok(downloads.some((request) => request.endsWith(LINUX_ASSET)), `archive not downloaded: ${downloads.join(', ')}`)
      ok(downloads.some((request) => request.endsWith('/SHA256SUMS.txt')), 'SHA256SUMS.txt was not downloaded')
    })
  })

  await runCase('darwin: craft-anything-cli at the zip root installs byte-identically', async () => {
    if (!zipUsable) return 'skip'
    await withServer({ files: RELEASE_FILES, sums: RELEASE_SUMS }, async (server) => {
      const root = freshRoot('darwin')
      const result = await runInstaller(installerArgs(server, root, 'darwin'))
      expectExitCode(result, 0)
      const target = path.join(root, VERSION, 'craft-anything-cli')
      const stable = path.join(root, 'bin', 'craft-anything-cli')
      expectBytes(target, MAC_CLI, 'installed CLI')
      expectBytes(stable, MAC_CLI, 'stable copy')
      expectExecutable(target)
      ok(lastLine(result.stdout) === target, `last stdout line is not the target path: ${JSON.stringify(lastLine(result.stdout))}`)
      expectContains(result.stdout, 'resolved from the release metadata', 'stdout')
      expectContains(result.stdout, MAC_ASSET, 'stdout')
      expectContains(result.stdout, 'craft-anything-cli at craft-anything-cli', 'stdout') // picked file is logged
      ok(server.requests.some((request) => request.endsWith(MAC_ASSET)), 'macOS zip not downloaded')
    })
  })

  await runCase('linux: archive without craft-anything-cli falls back to the craft-anything binary', async () => {
    const files = [{ name: LINUX_ASSET, data: fs.readFileSync(linuxGuiNamedTar) }]
    await withServer({ files, sums: sumsFor(files) }, async (server) => {
      const root = freshRoot('gui-named')
      const result = await runInstaller(installerArgs(server, root, 'linux'))
      expectExitCode(result, 0)
      const target = path.join(root, VERSION, 'craft-anything-cli')
      expectBytes(target, GUI_CLI, 'installed CLI')
      expectContains(result.stdout, 'using the craft-anything binary', 'stdout')
      expectContains(result.stdout, `no craft-anything-cli in this archive`, 'stdout')
    })
  })

  await runCase('failure: sha256 mismatch exits non-zero and prints both hashes', async () => {
    const actual = sha256(RELEASE_FILES[0].data)
    const bad = '0'.repeat(64)
    const sums = Buffer.from(`${bad}  ${LINUX_ASSET}\n${sha256(RELEASE_FILES[1].data)}  ${MAC_ASSET}\n`)
    await withServer({ files: RELEASE_FILES, sums }, async (server) => {
      const root = freshRoot('bad-sum')
      const result = await runInstaller(installerArgs(server, root, 'linux'))
      ok(result.code !== 0, `expected a non-zero exit, got ${result.code}`)
      expectMatch(result.stderr, /sha256 mismatch for/, 'stderr')
      expectContains(result.stderr, bad, 'stderr')
      expectContains(result.stderr, actual, 'stderr')
      expectMatch(result.stderr, /\[craft-anything\] ERROR:/, 'stderr')
      expectAbsent(path.join(root, VERSION))
    })
  })

  await runCase('failure: asset missing from SHA256SUMS.txt exits non-zero', async () => {
    const sums = Buffer.from(`${sha256(RELEASE_FILES[1].data)}  ${MAC_ASSET}\n`)
    await withServer({ files: RELEASE_FILES, sums }, async (server) => {
      const root = freshRoot('missing-sums-entry')
      const result = await runInstaller(installerArgs(server, root, 'linux'))
      ok(result.code !== 0, `expected a non-zero exit, got ${result.code}`)
      expectMatch(result.stderr, /is not listed in SHA256SUMS\.txt/, 'stderr')
      expectContains(result.stderr, 'refusing to install an unverified file', 'stderr')
      expectAbsent(path.join(root, VERSION))
    })
  })

  await runCase('failure: archive without any CLI exits non-zero and names the workaround', async () => {
    const files = [{ name: LINUX_ASSET, data: fs.readFileSync(linuxNoCliTar) }]
    await withServer({ files, sums: sumsFor(files) }, async (server) => {
      const root = freshRoot('no-cli')
      const result = await runInstaller(installerArgs(server, root, 'linux'))
      ok(result.code !== 0, `expected a non-zero exit, got ${result.code}`)
      expectMatch(result.stderr, /does not contain the craft-anything CLI/, 'stderr')
      expectContains(result.stderr, 'CRAFT_ANYTHING_CLI', 'stderr')
      expectContains(result.stderr, 'cargo install --path apps/craft-anything-cli', 'stderr')
      expectContains(result.stderr, 'archive top level:', 'stderr')
      expectContains(result.stderr, LINUX_DIR, 'stderr')
      expectAbsent(path.join(root, VERSION))
    })
  })

  await runCase('CRAFT_ANYTHING_CLI short-circuits without any network access', async () => {
    const provided = path.join(WORK, 'provided-cli')
    fs.writeFileSync(provided, '#!/bin/sh\necho "craft-anything-cli 0.6.0"\n')
    await withServer({ files: RELEASE_FILES, sums: RELEASE_SUMS }, async (server) => {
      const root = freshRoot('provided')
      const result = await runInstaller(installerArgs(server, root, 'linux', ['--dry-run']), { CRAFT_ANYTHING_CLI: provided })
      expectExitCode(result, 0)
      expectContains(result.stdout, `using the CLI provided by CRAFT_ANYTHING_CLI: ${provided}`, 'stdout')
      ok(lastLine(result.stdout) === provided, `last stdout line is not the provided path: ${JSON.stringify(lastLine(result.stdout))}`)
      ok(server.requests.length === 0, `installer touched the network: ${server.requests.join(', ')}`)
      expectAbsent(path.join(root, VERSION))
    })
  })

  await runCase('release metadata failure falls back to the constructed asset name', async () => {
    await withServer({ files: RELEASE_FILES, sums: RELEASE_SUMS, apiMode: 'error' }, async (server) => {
      const root = freshRoot('api-down')
      const result = await runInstaller(installerArgs(server, root, 'linux'))
      expectExitCode(result, 0)
      expectContains(result.stdout, 'release metadata unavailable', 'stdout')
      expectContains(result.stdout, 'constructed name; release metadata unavailable', 'stdout')
      expectBytes(path.join(root, VERSION, 'craft-anything-cli'), LINUX_CLI, 'installed CLI')
    })
  })

  await runCase('failure: asset absent from the release lists the closest asset names', async () => {
    await withServer({
      files: RELEASE_FILES,
      sums: RELEASE_SUMS,
      assetNames: [MAC_ASSET, `craft-anything-${VERSION}-linux-aarch64.AppImage`],
    }, async (server) => {
      const root = freshRoot('no-asset')
      const result = await runInstaller(installerArgs(server, root, 'linux'))
      ok(result.code !== 0, `expected a non-zero exit, got ${result.code}`)
      expectContains(result.stderr, 'is not part of release', 'stderr')
      expectContains(result.stderr, 'closest matching assets:', 'stderr')
      expectContains(result.stderr, MAC_ASSET, 'stderr')
      expectContains(result.stderr, 'CRAFT_ANYTHING_CLI', 'stderr')
      expectAbsent(path.join(root, VERSION))
    })
  })

  await runCase('--dry-run reports the resolved asset without downloading', async () => {
    await withServer({ files: RELEASE_FILES, sums: RELEASE_SUMS }, async (server) => {
      const root = freshRoot('dry-run')
      const result = await runInstaller(installerArgs(server, root, 'linux', ['--dry-run']))
      expectExitCode(result, 0)
      expectContains(result.stdout, LINUX_ASSET, 'stdout')
      expectContains(result.stdout, 'would download', 'stdout')
      expectContains(result.stdout, `install to ${path.join(root, VERSION, 'craft-anything-cli')}`, 'stdout')
      ok(server.requests.every((request) => request.startsWith('/api/')), `dry run downloaded: ${server.requests.join(', ')}`)
      expectAbsent(path.join(root, VERSION))
    })
  })

  await runCase('failure: missing curl names the manual workaround', async () => {
    const emptyPath = path.join(WORK, 'empty-path')
    fs.mkdirSync(emptyPath, { recursive: true })
    await withServer({ files: RELEASE_FILES, sums: RELEASE_SUMS }, async (server) => {
      const root = freshRoot('no-curl')
      const result = await runInstaller(installerArgs(server, root, 'linux'), { [PATH_KEY]: emptyPath })
      ok(result.code !== 0, `expected a non-zero exit, got ${result.code}`)
      expectMatch(result.stderr, /install curl/, 'stderr')
      expectContains(result.stderr, 'https://github.com/storytold/craft-anything/releases', 'stderr')
      expectContains(result.stderr, 'CRAFT_ANYTHING_CLI', 'stderr')
      expectAbsent(path.join(root, VERSION))
    })
  })

  await runCase('--force ignores CRAFT_ANYTHING_CLI and installs a managed copy', async () => {
    const provided = path.join(WORK, 'provided-cli-force')
    fs.writeFileSync(provided, '#!/bin/sh\necho "craft-anything-cli 0.6.0"\n')
    await withServer({ files: RELEASE_FILES, sums: RELEASE_SUMS }, async (server) => {
      const root = freshRoot('force')
      const result = await runInstaller(installerArgs(server, root, 'linux', ['--force']), { CRAFT_ANYTHING_CLI: provided })
      expectExitCode(result, 0)
      expectContains(result.stdout, '--force: ignoring CRAFT_ANYTHING_CLI', 'stdout')
      expectBytes(path.join(root, VERSION, 'craft-anything-cli'), LINUX_CLI, 'installed CLI')
    })
  })

  console.log('')
  console.log(`${summary.passed} passed, ${summary.failed} failed, ${summary.skipped} skipped`)
  if (summary.failed > 0) {
    console.log(`fixtures kept for inspection: ${WORK}`)
    process.exit(1)
  }
  fs.rmSync(WORK, { recursive: true, force: true })
  process.exit(0)
}

main().catch((error) => {
  console.error(`install-cli tests crashed: ${(error && error.stack) || error}`)
  console.error(`fixtures kept for inspection: ${WORK}`)
  process.exit(1)
})
