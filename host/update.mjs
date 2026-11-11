// dsh-craft-anything — plugin update check, one-click update and Harness restart.
//
// The page carries a "Check for updates" button next to the environment card's one-click
// installs. It asks this module for the version of the plugin that is actually loaded
// (this package's package.json), the newest published GitHub release of the plugin, and
// then — when the user confirms — runs the Harness' own package manager on the profile
// that depends on this plugin:
//
//     <Harness exe> --expose-internals <app.asar>/…/dsh-desktop-host/lib/cli.js \
//         plugin --profile <profile> add github:<owner>/<repo>#v<latest> --config.minimumReleaseAge=0
//
// The spec is pinned to the release tag (not `main`), so an update is the same package a
// fresh `dsh plugin add` would install, old tags stay installable, and a half-finished
// release can never be picked up by accident.
//
// Installing a plugin does not reload the running Harness (module graph is fixed at
// boot), so the page offers to restart it. The restart is delegated to a detached copy of
// scripts/restart-dsh.mjs in <root>: it waits for the HTTP response to leave this process,
// stops the Harness, waits for it to exit, then launches the same executable again. On
// Windows the stop is TerminateProcess on the main process only (Electron's helper
// processes exit with it); on POSIX it is SIGTERM, then SIGKILL.
//
// Everything here is offline-safe: a network or GitHub failure only changes the report —
// it never throws into the route handler, and a failed update leaves the installed plugin
// untouched (pnpm's add is the only writer and it either replaces the dependency or fails).

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const UPDATE_ROUTE = '/craft-anything/api/update'
export const RESTART_ROUTE = '/craft-anything/api/restart'
export const UPDATE_FILE = 'update.state.json'
export const RESTART_SCRIPT = 'restart-dsh.mjs'

const REPO = 'Fanqi89/dsh-craft-anything'
const RELEASE_CACHE_MS = 10 * 60_000

// --- versions -----------------------------------------------------------------------------------

/** Parse `1.2.3`, `v1.2.3`, `1.2.3-rc.1`; returns null for anything else. */
export function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value || '').trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ? match[4].split('.') : [],
  }
}

/** -1 | 0 | 1, or null when either side cannot be parsed as a version. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    const l = left.pre[index]
    const r = right.pre[index]
    if (l === undefined) return -1
    if (r === undefined) return 1
    const ln = Number(l)
    const rn = Number(r)
    if (Number.isFinite(ln) && Number.isFinite(rn)) {
      if (ln !== rn) return ln > rn ? 1 : -1
    } else if (l !== r) {
      return l > r ? 1 : -1
    }
  }
  return 0
}

// --- service ------------------------------------------------------------------------------------

/**
 * @param {{
 *   PACKAGE_DIR: string,
 *   IS_WINDOWS: boolean,
 *   run: Function,
 *   which: Function,
 *   existsFile: Function,
 *   installRoot: Function,
 *   readEnvFile: Function,
 *   envForChild: Function,
 *   proxyUrl: Function,
 *   invalidateProbes: Function,
 * }} deps
 */
export function createUpdateService(deps) {
  const { PACKAGE_DIR, IS_WINDOWS, run, which, existsFile, installRoot, readEnvFile, envForChild, proxyUrl, invalidateProbes } = deps

  // --- current plugin ---------------------------------------------------------------------------
  const packageCache = { at: 0, version: null }
  function pluginVersion() {
    try {
      const stat = fs.statSync(path.join(PACKAGE_DIR, 'package.json'))
      if (!packageCache.version || packageCache.at !== stat.mtimeMs) {
        const parsed = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8'))
        packageCache.version = typeof parsed.version === 'string' ? parsed.version : null
        packageCache.at = stat.mtimeMs
      }
      return packageCache.version
    } catch {
      return packageCache.version
    }
  }

  // --- HTTP (fetch, then curl: both are present on the platforms this plugin supports) ----------
  async function httpJson(url, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15_000
    const headers = { 'user-agent': 'dsh-craft-anything', accept: 'application/vnd.github+json' }
    let fetchError = ''
    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) })
      if (response.ok) return { ok: true, data: await response.json() }
      fetchError = `HTTP ${response.status}`
    } catch (error) {
      fetchError = String((error && error.message) || error)
    }
    const curl = which('curl') || (IS_WINDOWS ? which('curl.exe') : null)
    if (!curl) return { ok: false, error: fetchError || 'no network client available' }
    const argv = ['-sS', '-L', '--max-time', String(Math.max(5, Math.ceil(timeoutMs / 1000)))]
    // Windows curl uses Schannel; this machine's TLS-inspecting proxy fails its revocation
    // check. Other builds reject the flag, so keep it Windows-only (same rule as install-cli).
    if (IS_WINDOWS) argv.push('--ssl-no-revoke')
    const proxy = proxyUrl() || (readEnvFile() || {}).HTTPS_PROXY || (readEnvFile() || {}).https_proxy
    if (proxy) argv.push('--proxy', proxy)
    argv.push('-H', 'user-agent: dsh-craft-anything', '-H', 'accept: application/vnd.github+json', url)
    const result = await run(curl, argv, { timeoutMs: timeoutMs + 8_000 })
    if (result.code === 0 && result.stdout) {
      try {
        return { ok: true, data: JSON.parse(result.stdout) }
      } catch {
        return { ok: false, error: 'GitHub answered something that is not JSON' }
      }
    }
    return { ok: false, error: `${fetchError}; curl exited ${result.code}: ${(result.stderr || '').trim().slice(0, 300)}` }
  }

  // --- newest release ---------------------------------------------------------------------------
  const releaseCache = { at: 0, release: null, error: null }
  async function releaseInfo(options = {}) {
    const force = options.force === true
    if (!force && releaseCache.release && Date.now() - releaseCache.at < RELEASE_CACHE_MS) {
      return { release: releaseCache.release, error: null }
    }
    const result = await httpJson(`https://api.github.com/repos/${REPO}/releases/latest`)
    if (!result.ok) {
      releaseCache.at = Date.now()
      releaseCache.error = result.error || 'the release lookup failed'
      return { release: null, error: releaseCache.error }
    }
    const data = result.data || {}
    const tag = typeof data.tag_name === 'string' ? data.tag_name.trim() : ''
    const version = tag.replace(/^v/i, '')
    if (!tag || !parseVersion(version)) {
      const error = `the latest release tag "${tag || '(none)'}" is not a version this plugin understands`
      releaseCache.at = Date.now()
      releaseCache.error = error
      return { release: null, error }
    }
    const release = {
      tag,
      version,
      name: typeof data.name === 'string' && data.name ? data.name : tag,
      htmlUrl: typeof data.html_url === 'string' ? data.html_url : `https://github.com/${REPO}/releases/tag/${tag}`,
      publishedAt: typeof data.published_at === 'string' ? data.published_at : null,
      notes: typeof data.body === 'string' ? data.body.slice(0, 8_000) : '',
      prerelease: data.prerelease === true,
    }
    releaseCache.at = Date.now()
    releaseCache.release = release
    releaseCache.error = null
    return { release, error: null }
  }

  // --- where this plugin is installed -----------------------------------------------------------
  function homeDir() {
    return process.env.USERPROFILE || process.env.HOME || os.homedir()
  }

  function readJson(file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  /** The profile that depends on this plugin (the one an update has to touch). */
  function findProfile() {
    const root = path.join(homeDir(), '.dsh', 'profiles')
    let names = []
    try {
      names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return { profile: null, spec: null, profiles: [] }
    }
    const matches = []
    for (const name of names) {
      const file = path.join(root, name, 'package.json')
      const pkg = readJson(file)
      const spec = pkg && pkg.dependencies ? pkg.dependencies['dsh-craft-anything'] : null
      if (typeof spec === 'string' && spec) matches.push({ profile: name, spec, file })
    }
    const preferred = process.env.DSH_PROFILE || process.env.DSH_PROFILE_NAME || ''
    const picked = matches.find((entry) => entry.profile === preferred) || matches[0] || null
    return { ...(picked || { profile: null, spec: null, file: null }), profiles: matches.map((entry) => entry.profile) }
  }

  /** How to run the Harness' own CLI on this machine (desktop app, argv or PATH). */
  function dshCli() {
    const candidates = []
    // Explicit override first: a packaged desktop build knows its own CLI path, but a source or
    // test run (and a shell-launched `dsh`) does not, so allow CRAFT_ANYTHING_DSH_CLI to name it.
    const explicitDsh = process.env.CRAFT_ANYTHING_DSH_CLI
    if (explicitDsh && existsFile(explicitDsh)) {
      if (/\.js$/i.test(explicitDsh)) {
        candidates.push({ kind: 'env-js', command: process.execPath, args: ['--expose-internals', explicitDsh], env: { ELECTRON_RUN_AS_NODE: '1' } })
      } else {
        candidates.push({ kind: 'env', command: explicitDsh, args: [], env: {}, shell: IS_WINDOWS })
      }
    }
    const resources = typeof process.resourcesPath === 'string' ? process.resourcesPath : ''
    if (resources) {
      const cliJs = path.join(resources, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')
      if (existsFile(cliJs)) {
        candidates.push({
          kind: 'app',
          command: process.execPath,
          args: ['--expose-internals', cliJs],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        })
      }
    }
    const argv1 = process.argv && process.argv[1]
    if (argv1 && existsFile(argv1) && /(cli\.js|dsh(\.mjs|\.js)?|\/dsh)$/.test(argv1) && argv1 !== process.execPath) {
      candidates.push({ kind: 'argv', command: process.execPath, args: [argv1], env: {} })
    }
    const onPath = which('dsh') || which('dsh.cmd') || which('dsh.exe')
    if (onPath) {
      // On Windows a .cmd cannot be spawned without a shell; build one command line.
      candidates.push({ kind: 'path', command: onPath, args: [], env: {}, shell: IS_WINDOWS })
    }
    return candidates
  }

  async function runDshCli(candidate, dshArgs, options = {}) {
    if (candidate.shell) {
      const quote = (value) => `"${String(value).replace(/"/g, '\\"')}"`
      const line = [quote(candidate.command), ...dshArgs.map(quote)].join(' ')
      return run(line, [], { ...options, shell: true })
    }
    return run(candidate.command, [...candidate.args, ...dshArgs], options)
  }

  // --- install environment ----------------------------------------------------------------------
  function installEnv() {
    const env = { ...envForChild(), ...(readEnvFile() || {}) }
    const proxy = proxyUrl() || env.HTTPS_PROXY || env.https_proxy
    if (proxy) {
      if (!env.HTTPS_PROXY) env.HTTPS_PROXY = proxy
      if (!env.HTTP_PROXY) env.HTTP_PROXY = proxy
      // pnpm fetches the GitHub tarball itself; behind a TLS-inspecting proxy its certificate
      // store does not include the local root, so allow the same escape hatch the release tooling
      // uses. Only added when a proxy is configured, and only for this child.
      if (!env.NODE_EXTRA_CA_CERTS && !env.NODE_TLS_REJECT_UNAUTHORIZED) env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
    }
    return env
  }

  function stateFile() {
    return path.join(installRoot(), UPDATE_FILE)
  }

  function readState() {
    return readJson(stateFile()) || null
  }

  function writeState(patch) {
    try {
      fs.mkdirSync(installRoot(), { recursive: true })
      fs.writeFileSync(stateFile(), `${JSON.stringify({ ...(readState() || {}), ...patch }, null, 2)}\n`)
    } catch {
      /* the report is best effort */
    }
  }

  // --- update job -------------------------------------------------------------------------------
  const job = { id: 'plugin-update', status: 'idle', startedAt: null, updatedAt: null, detail: '', error: null, log: [], version: null, result: null }

  function logLine(line) {
    const text = String(line == null ? '' : line).slice(0, 4_000)
    for (const part of text.split(/\r?\n/)) {
      if (!part.trim()) continue
      job.log.push(part.slice(0, 600))
    }
    if (job.log.length > 120) job.log.splice(0, job.log.length - 120)
    job.updatedAt = new Date().toISOString()
  }

  function jobSnapshot() {
    return {
      id: job.id,
      status: job.status,
      startedAt: job.startedAt,
      updatedAt: job.updatedAt,
      detail: job.detail,
      error: job.error,
      version: job.version,
      result: job.result,
      log: job.log.slice(-40).join('\n'),
    }
  }

  function startInstall(options = {}) {
    if (job.status === 'running') return jobSnapshot()
    const force = options.force === true
    job.status = 'running'
    job.startedAt = new Date().toISOString()
    job.updatedAt = job.startedAt
    job.detail = 'checking the latest release'
    job.error = null
    job.version = null
    job.result = null
    job.log = []
    ;(async () => {
      const { release, error } = await releaseInfo({ force: true })
      if (!release) throw new Error(error || 'could not read the latest release')
      job.version = release.version
      if (compareVersions(release.version, pluginVersion()) !== 1 && !force) {
        job.status = 'done'
        job.detail = `already on the latest version (${pluginVersion()})`
        job.result = { alreadyLatest: true, version: pluginVersion() }
        job.updatedAt = new Date().toISOString()
        return
      }
      const found = findProfile()
      if (!found.profile) throw new Error('this plugin is not installed from a Harness profile, so there is nothing to update here')
      const spec = `github:${REPO}#${release.tag}`
      const cli = dshCli()[0]
      if (!cli) throw new Error('could not find the Harness CLI (dsh) on this machine')
      const dshArgs = ['plugin', '--profile', found.profile, 'add', spec, '--config.minimumReleaseAge=0']
      job.detail = `installing ${release.tag} into profile "${found.profile}"`
      logLine(`$ ${cli.command} ${[...cli.args, ...dshArgs].join(' ')}`)
      const result = await runDshCli(cli, dshArgs, { timeoutMs: 900_000, env: { ...installEnv(), ...(cli.env || {}) } })
      logLine([result.stdout, result.stderr].filter(Boolean).join('\n').slice(-6_000))
      if (result.timedOut) throw new Error('the Harness CLI timed out while installing the plugin')
      if (result.code !== 0) throw new Error(`the Harness CLI exited ${result.code}: ${(result.stderr || result.stdout || '').trim().slice(0, 500)}`)
      job.status = 'done'
      job.detail = `installed ${release.tag}; restart the Harness to load it`
      job.result = { installed: true, version: release.version, tag: release.tag, profile: found.profile, spec }
      writeState({ version: release.version, tag: release.tag, profile: found.profile, spec, at: new Date().toISOString(), previous: pluginVersion() })
      invalidateProbes()
      job.updatedAt = new Date().toISOString()
    })().catch((error) => {
      job.status = 'error'
      job.error = String((error && error.message) || error).slice(0, 900)
      job.detail = 'update failed'
      logLine(`error: ${job.error}`)
      job.updatedAt = new Date().toISOString()
    })
    return jobSnapshot()
  }

  // --- restart ----------------------------------------------------------------------------------
  function pendingRestartFile() {
    return path.join(installRoot(), 'restart.pending.json')
  }

  function relaunchCommand() {
    const exe = process.execPath
    if (!IS_WINDOWS && process.platform === 'darwin') {
      const index = exe.indexOf('.app/')
      if (index > 0) return { cmd: ['open', '-n', exe.slice(0, index + 4)], how: 'open -n (macOS bundle)' }
    }
    if (IS_WINDOWS && /DeepSeek Harness(\.exe)?$/i.test(exe)) return { cmd: [exe], how: 'the Harness executable' }
    const base = path.basename(exe).toLowerCase()
    if (/^node(\.exe)?$/.test(base) && process.argv && process.argv[1]) {
      return { cmd: [exe, ...process.argv.slice(1)], how: 'node + the Harness CLI arguments' }
    }
    return { cmd: [exe], how: 'the current executable' }
  }

  function restart(options = {}) {
    try {
      const pending = readJson(pendingRestartFile())
      if (pending && Number.isFinite(pending.at) && Date.now() - pending.at < 120_000) {
        return { ok: false, error: 'a restart was already scheduled; wait for the Harness to come back', pending }
      }
    } catch { /* no pending marker */ }
    const helper = path.join(installRoot(), RESTART_SCRIPT)
    if (!existsFile(helper)) return { ok: false, error: `the restart helper is missing: ${helper} (reload the plugin and retry)` }
    const launch = relaunchCommand()
    const logFile = path.join(installRoot(), 'restart.log')
    const argv = ['--pid', String(process.pid), '--delay', '900', '--cmd', JSON.stringify(launch.cmd), '--cwd', process.cwd(), '--log', logFile]
    try {
      fs.writeFileSync(pendingRestartFile(), `${JSON.stringify({ at: Date.now(), pid: process.pid, cmd: launch.cmd })}\n`)
    } catch { /* marker is best effort */ }
    try {
      const child = spawn(process.execPath, [helper, ...argv], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      })
      child.unref()
      return { ok: true, pid: process.pid, helper, relaunch: launch.cmd, how: launch.how, logFile, note: 'the Harness stops in under a second and is launched again; reload this page when it is back' }
    } catch (error) {
      try { fs.rmSync(pendingRestartFile(), { force: true }) } catch { /* ignore */ }
      return { ok: false, error: String((error && error.message) || error) }
    }
  }

  // --- report -----------------------------------------------------------------------------------
  async function report(options = {}) {
    const force = options.force === true
    const current = pluginVersion()
    const { release, error } = await releaseInfo({ force })
    const found = findProfile()
    const cli = dshCli()
    const order = release ? compareVersions(release.version, current) : null
    const hasUpdate = order === 1
    const devCopy = typeof found.spec === 'string' && found.spec.startsWith('link:')
    const canInstall = Boolean(release && hasUpdate && found.profile && cli.length > 0)
    return {
      ok: true,
      current: { version: current, packageDir: PACKAGE_DIR },
      latest: release,
      hasUpdate,
      error: error || null,
      devCopy,
      install: {
        available: canInstall,
        profile: found.profile,
        spec: found.spec,
        profiles: found.profiles,
        tag: release ? release.tag : null,
        command: release && found.profile ? `dsh plugin --profile ${found.profile} add github:${REPO}#${release.tag} --config.minimumReleaseAge=0` : null,
        hint: !release ? 'the release lookup failed; retry when the network is back' : hasUpdate ? '' : 'nothing to do',
      },
      job: jobSnapshot(),
      state: readState(),
      checkedAt: new Date().toISOString(),
    }
  }

  return {
    pluginVersion,
    compareVersions,
    releaseInfo,
    findProfile,
    updateReport: report,
    startInstall,
    jobSnapshot,
    restart,
    stateFile,
    pendingRestartFile,
  }
}
