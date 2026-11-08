// dsh-craft-anything — Host half.
//
// Adds three tools beside the MCP bridge that the bundle inserts
// (@deepseek-ai/dsh-mcp-client -> `mcp__craft__*`):
//   craft_status   what the local Craft Anything install can do right now
//   craft_cli      run any craft-anything-cli subcommand (rebuild, doctor, report, ...)
//   craft_install  download / update the official CLI build for this machine
//
// Everything here only reads local state or runs the local CLI. No network call
// is made except by craft_install, which downloads the official release.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')
const INSTALLER = path.join(PACKAGE_DIR, 'scripts', 'install-cli.ps1')
const INSTALLER_NODE = path.join(PACKAGE_DIR, 'scripts', 'install-cli.mjs')

const IS_WINDOWS = process.platform === 'win32'
const EXE_NAME = IS_WINDOWS ? 'craft-anything-cli.exe' : 'craft-anything-cli'

const DEFAULT_ROOT = path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.dsh', 'plugins-data', 'craft-anything')

const MAX_CAPTURE = 200_000

function existsFile(candidate) {
  if (!candidate) return false
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** Version-ish descending order so `0.10.0` wins over `0.9.0`. */
function newestFirst(names) {
  const score = (name) => name.split(/[^0-9]+/).filter(Boolean).map((part) => Number(part))
  return [...names].sort((a, b) => {
    const av = score(a)
    const bv = score(b)
    for (let i = 0; i < Math.max(av.length, bv.length); i += 1) {
      const d = (bv[i] ?? -1) - (av[i] ?? -1)
      if (d !== 0) return d
    }
    return 0
  })
}

function resolveCli(config = {}) {
  const root = config.installDir || process.env.CRAFT_ANYTHING_ROOT || DEFAULT_ROOT
  const explicit = config.cliPath || process.env.CRAFT_ANYTHING_CLI
  if (explicit && existsFile(explicit)) return { cli: explicit, root, source: 'config' }
  // A stale CRAFT_ANYTHING_CLI must not hide a working install: fall through to the scan.
  const staged = path.join(root, 'bin', EXE_NAME)
  if (existsFile(staged)) return { cli: staged, root, source: 'bin' }
  // Newest version directory wins; dedupe numeric-equivalent names (0.4.0 vs v0.4.0).
  const seenVersions = new Set()
  const versioned = newestFirst(listDirs(root))
    .filter((name) => {
      const key = name.replace(/^v/i, '')
      if (seenVersions.has(key)) return false
      seenVersions.add(key)
      return true
    })
    .map((name) => path.join(root, name, EXE_NAME))
  const found = versioned.find(existsFile)
  if (found) return { cli: found, root, source: 'versioned' }
  return { cli: null, root, source: explicit ? 'config-missing' : 'missing', tried: explicit || undefined }
}

// --- analysis mode: the MCP server reads its mode once at startup, so the launcher keeps it in
// mode.json and restarts the server when the file changes (dsh-mcp-client then reconnects).

function installRoot(config = {}) {
  return config.installDir || process.env.CRAFT_ANYTHING_ROOT || DEFAULT_ROOT
}

function modeFile(config = {}) {
  return path.join(installRoot(config), 'mode.json')
}

function stateFile(config = {}) {
  return path.join(installRoot(config), 'mcp.state.json')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function readMode(config = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(modeFile(config), 'utf8'))
    return parsed && parsed.mode === 'deep' ? 'deep' : 'clean'
  } catch {
    return 'clean'
  }
}

function readMcpState(config = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(config), 'utf8'))
    if (!parsed || typeof parsed !== 'object') return null
    return {
      mode: parsed.mode === 'deep' ? 'deep' : 'clean',
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : null,
      args: Array.isArray(parsed.args) ? parsed.args.map(String) : [],
      cli: typeof parsed.cli === 'string' ? parsed.cli : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      pid: Number.isFinite(parsed.pid) ? parsed.pid : null,
    }
  } catch {
    return null
  }
}

/** Persist the mode and wait (bounded) until the MCP server reports it is running in that mode. */
async function setMode(config, mode) {
  const wanted = mode === 'deep' ? 'deep' : 'clean'
  const before = readMcpState(config)
  const root = installRoot(config)
  fs.mkdirSync(root, { recursive: true })
  fs.writeFileSync(modeFile(config), `${JSON.stringify({ mode: wanted, changedAt: new Date().toISOString() }, null, 2)}\n`)
  if (before && before.mode === wanted) {
    return { mode: wanted, changed: false, applied: true, restarted: false, note: 'the MCP server was already running in this mode' }
  }
  // No state file means the bridge has never started here (no CLI, or the row is off): do not sit
  // on the HTTP request for 20 s, just persist the mode and say so.
  if (!before) {
    return {
      mode: wanted,
      changed: true,
      applied: true,
      restarted: false,
      note: 'mode saved; the bridge is not running in this Harness yet, so it will start in this mode next time.',
    }
  }
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const state = readMcpState(config)
    if (state && state.mode === wanted) {
      return { mode: wanted, changed: true, applied: true, restarted: true, server: state }
    }
    await sleep(200)
  }
  return {
    mode: wanted,
    changed: true,
    applied: false,
    restarted: false,
    note: 'mode.json was written, but the MCP server has not confirmed the new mode yet; it reconnects within a few seconds (or start the plugin again).',
  }
}

function run(command, args, options = {}) {
  const { cwd, timeoutMs = 120_000, signal, env, shell, verbatim } = options
  return new Promise((resolve) => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let child
    try {
      child = spawn(command, args, {
        cwd: cwd || undefined,
        env: env || process.env,
        shell: shell === true,
        windowsVerbatimArguments: verbatim === true,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error?.message || error), timedOut: false, error: String(error?.message || error), ms: 0 })
      return
    }
    const killHard = () => {
      if (!child) return
      try { if (!child.killed) child.kill('SIGTERM') } catch { /* already gone */ }
      // craft-anything exits on the SECOND SIGTERM (its ctrlc handler flushes and exits on the
      // second signal) and ignores the first, so send a second one, then SIGKILL, then settle
      // even if the child is still alive. Without this the tool call would hang despite timeout.
      setTimeout(() => { try { child.kill('SIGTERM') } catch { /* already gone */ } }, 150).unref?.()
      setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 1200).unref?.()
      setTimeout(() => finish(null, 'killed after timeout'), 2500).unref?.()
    }
    const onAbort = () => killHard()
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        killHard()
      }, timeoutMs)
      : null
    const finish = (code, errorMessage) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (signal) signal.removeEventListener('abort', onAbort)
      resolve({
        code: code ?? (timedOut ? null : 0),
        stdout: stdout.slice(0, MAX_CAPTURE),
        stderr: stderr.slice(0, MAX_CAPTURE),
        timedOut,
        ms: Date.now() - started,
        ...(errorMessage ? { error: errorMessage } : {}),
      })
    }
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => finish(null, String(error?.message || error)))
    child.on('close', (code) => finish(code))
  })
}

// PATH lookups were ~30 ms each and the status report asks twice; cache them briefly.
const whichCache = new Map()
const WHICH_TTL_MS = 60_000

function which(name) {
  const cached = whichCache.get(name)
  if (cached && Date.now() - cached.at < WHICH_TTL_MS) return cached.value
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts = IS_WINDOWS ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  let found = null
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (existsFile(candidate)) { found = candidate; break }
    }
    if (found) break
  }
  whichCache.set(name, { at: Date.now(), value: found })
  return found
}

// The CLI probes are subprocesses (`--version` and the ~90 KB `capabilities` scan). The status
// page and the craft_status tool used to run both on every request; cache them for a while so a
// polling page costs nothing. `refresh`/`?full=1` bypasses the cache.
const VERSION_TTL_MS = 5 * 60_000
const CAPABILITIES_TTL_MS = 10 * 60_000
const probeCache = { cli: null, version: null, versionAt: 0, capabilities: null, capabilitiesAt: 0 }

async function statusReport(config = {}, options = {}) {
  const refresh = options.full === true
  const resolved = resolveCli(config)
  const report = {
    installed: Boolean(resolved.cli),
    cliPath: resolved.cli,
    cliSource: resolved.source,
    root: resolved.root,
    version: null,
    portable: false,
    versions: listDirs(resolved.root),
    prerequisites: {
      codingAgent: which('claude') || which('claude.cmd') || null,
      ghidra: process.env.GHIDRA_INSTALL_DIR || null,
    },
    mcp: {
      serverName: 'craft',
      toolPrefix: 'mcp__craft__',
      defaultToolCount: 30,
      notes: 'The MCP server lists the Essentials toolset; enable more groups for this Harness process with mcp__craft__list_toolsets and mcp__craft__enable_toolset.',
    },
    mode: readMode(config),
    mcpState: readMcpState(config),
    projectsRoot: config.projectsRoot || null,
    notes: [],
    noteCodes: [],
  }
  if (!resolved.cli) {
    report.notes.push('craft-anything-cli was not found. Run the craft_install tool, then reload the plugin.')
    return report
  }
  report.portable = existsFile(path.join(path.dirname(resolved.cli), 'portable.txt'))
  if (probeCache.cli !== resolved.cli) {
    probeCache.cli = resolved.cli
    probeCache.version = null
    probeCache.versionAt = 0
    probeCache.capabilities = null
    probeCache.capabilitiesAt = 0
  }
  const now = Date.now()
  if (!refresh && probeCache.version && now - probeCache.versionAt < VERSION_TTL_MS) {
    report.version = probeCache.version
  } else {
    const version = await run(resolved.cli, ['--version'], { timeoutMs: 20_000, env: envForChild(config) })
    report.version = (version.stdout || version.stderr || '').trim().split(/\r?\n/)[0] || null
    probeCache.version = report.version
    probeCache.versionAt = Date.now()
    if (version.code !== 0) report.notes.push(`\`--version\` exited ${version.code}: ${(version.stderr || '').trim().slice(0, 400)}`)
  }
  if (!refresh && probeCache.capabilities && now - probeCache.capabilitiesAt < CAPABILITIES_TTL_MS) {
    report.capabilities = probeCache.capabilities
  } else {
    const capabilities = await run(resolved.cli, ['capabilities'], { timeoutMs: 60_000, env: envForChild(config) })
    if (capabilities.code === 0) {
      try {
        const parsed = JSON.parse(capabilities.stdout)
        // Build only defined keys: the tool result must stay lossless JSON, and an
        // `undefined` member fails the call after the work already ran.
        const summary = {}
        if (typeof parsed.analysis_mode === 'string') summary.analysisMode = parsed.analysis_mode
        if (Array.isArray(parsed.toolsets)) summary.toolsets = parsed.toolsets.length
        if (Number.isFinite(parsed.tools)) summary.tools = parsed.tools
        if (Array.isArray(parsed.engines)) {
          summary.enginesFound = parsed.engines
            .filter((engine) => engine && engine.found)
            .map((engine) => String(engine.id || engine.name || '?'))
            .slice(0, 24)
        }
        report.capabilities = summary
        probeCache.capabilities = summary
        probeCache.capabilitiesAt = Date.now()
      } catch {
        report.notes.push('`capabilities` did not return JSON; raw output trimmed to 600 chars.')
        report.capabilitiesRaw = (capabilities.stdout || '').slice(0, 600)
      }
    } else {
      report.notes.push(`\`capabilities\` exited ${capabilities.code}: ${(capabilities.stderr || '').trim().slice(0, 400)}`)
    }
  }
  if (!report.prerequisites.codingAgent) {
    report.notes.push('No `claude` coding agent on PATH: study and inspect tools work, but `rebuild` needs a coding agent signed in (see `craft-anything-cli doctor`).')
    report.noteCodes.push('no-coding-agent')
  }
  // GHIDRA_INSTALL_DIR being set does not prove the CLI found Ghidra; report both facts.
  if (report.capabilities && Array.isArray(report.capabilities.enginesFound)) {
    report.prerequisites.ghidraDetected = report.capabilities.enginesFound.includes('ghidra')
  }
  // The host tools resolve the newest installed CLI, while the MCP bridge keeps the one it
  // started with. Say so instead of silently reporting one version for two processes.
  if (report.mcpState && report.mcpState.version && report.version && !report.version.includes(report.mcpState.version)) {
    report.notes.push(`The MCP bridge is still running craft-anything ${report.mcpState.version} while the host tools already use ${report.version}; switch mode or reinstall once and the bridge restarts into ${report.version}.`)
    report.noteCodes.push('bridge-version-mismatch')
  }
  return report
}

function renderStatus(value) {
  const lines = []
  lines.push(value.installed ? `Craft Anything CLI: ${value.version || 'unknown version'}` : 'Craft Anything CLI: NOT INSTALLED')
  if (value.cliPath) lines.push(`  binary: ${value.cliPath} (${value.cliSource}${value.portable ? ', portable mode' : ''})`)
  lines.push(`  install root: ${value.root}`)
  if (value.versions?.length) lines.push(`  versions: ${value.versions.join(', ')}`)
  if (value.capabilities) {
    const parts = []
    if (value.capabilities.analysisMode) parts.push(`mode ${value.capabilities.analysisMode}`)
    if (value.capabilities.toolsets !== undefined) parts.push(`${value.capabilities.toolsets} toolsets`)
    if (value.capabilities.tools !== undefined) parts.push(`${value.capabilities.tools} tools`)
    if (parts.length) lines.push(`  capabilities: ${parts.join(', ')}`)
    if (Array.isArray(value.capabilities.enginesFound) && value.capabilities.enginesFound.length > 0) {
      lines.push(`  engines found: ${value.capabilities.enginesFound.join(', ')}`)
    }
  }
  lines.push('')
  lines.push(`MCP bridge: server "${value.mcp.serverName}" -> ${value.mcp.toolPrefix}* (${value.mcp.defaultToolCount} tools by default)`)
  lines.push(`  mode: ${value.mode === 'deep' ? 'deep (reads code, files and page source)' : 'clean room (nothing inside a target is read)'}${
    value.mcpState && value.mcpState.mode !== value.mode ? ` — note: the running server still reports ${value.mcpState.mode}; it switches on the next reconnect` : ''
  }`)
  if (value.mcpState) {
    const running = value.mcpState.version ? `craft-anything ${value.mcpState.version}` : 'the bridge process'
    lines.push(`  bridge: ${running}${value.mcpState.pid ? ` (pid ${value.mcpState.pid})` : ''}${value.mcpState.startedAt ? `, started ${value.mcpState.startedAt}` : ''}`)
  }
  lines.push(`  coding agent: ${value.prerequisites.codingAgent || 'not found on PATH'}`)
  lines.push(`  Ghidra: ${value.prerequisites.ghidraDetected
    ? 'detected by the CLI'
    : value.prerequisites.ghidra
      ? `${value.prerequisites.ghidra} (GHIDRA_INSTALL_DIR is set, but the CLI does not detect it)`
      : 'not configured (optional, Deep mode)'}`)
  if (value.projectsRoot) lines.push(`  projects root: ${value.projectsRoot}`)
  for (const note of value.notes) lines.push(`note: ${note}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

function statusTool(config) {
  return {
    name: 'craft_status',
    description:
      'Report the local Craft Anything install: CLI path and version, portable or not, capability counts, coding-agent and Ghidra availability, and how the MCP bridge is wired (tools appear as mcp__craft__*). Read-only; results are cached for a few minutes, pass refresh:true to re-run the CLI probes.',
    parameters: {
      type: 'object',
      properties: {
        refresh: { type: 'boolean', description: 'Re-run `craft-anything-cli --version` and `capabilities` instead of using the cache.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => renderStatus(value),
    },
    async execute(args) {
      return statusReport(config, { full: args?.refresh === true })
    },
  }
}

function cliTool(config) {
  return {
    name: 'craft_cli',
    description:
      'Run the local craft-anything-cli with any arguments and return exit code, stdout and stderr. Use it for the workflow commands that are not MCP tools: `rebuild <target> "<what you want>" [--rounds N] [--project-folder DIR] [--existing edit|material] [--deep]`, `doctor`, `setup`, `report`, `triage`, `commands`, `capabilities`. Argument array is passed verbatim (no shell). Long rebuilds need a large timeoutMs; when the call is cancelled the child process is killed.',
    parameters: {
      type: 'object',
      properties: {
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Exact CLI arguments, e.g. ["rebuild","https://example.com","Recreate this website","--rounds","1"].',
        },
        cwd: { type: 'string', description: 'Working directory for the command (defaults to the configured project directory or the current directory).' },
        timeoutMs: { type: 'integer', description: 'Kill the command after this many milliseconds (default 120000, 0 = no timeout).' },
        maxOutputChars: { type: 'integer', description: 'Trim each stream to this many characters for the model (default 6000, max 60000). The exit code is always reported.' },
      },
      required: ['args'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const lines = [`$ ${value.command}`, `exit ${value.exitCode ?? 'null'}${value.timedOut ? ' (timed out, killed)' : ''} in ${value.ms} ms`]
        if (value.stdout) lines.push('--- stdout ---', value.stdout.trimEnd())
        if (value.stderr) lines.push('--- stderr ---', value.stderr.trimEnd())
        if (!value.stdout && !value.stderr) lines.push('(no output)')
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const resolved = resolveCli(config)
      if (!resolved.cli) {
        throw new Error('craft-anything-cli is not installed. Run craft_install first (it downloads the official build and verifies its SHA256).')
      }
      const argv = Array.isArray(args?.args) ? args.args.map(String) : []
      if (argv.length === 0) throw new Error('args must contain at least one CLI argument, e.g. ["commands"].')
      const timeoutMs = Number.isFinite(args?.timeoutMs) ? Math.max(0, Math.trunc(args.timeoutMs)) : 120_000
      const cwd = args?.cwd ? path.resolve(String(args.cwd)) : (config.projectDir || undefined)
      const maxChars = Math.min(60_000, Math.max(500, Number.isFinite(args?.maxOutputChars) ? Math.trunc(args.maxOutputChars) : 6_000))
      const result = await run(resolved.cli, argv, { cwd, timeoutMs, signal: exec?.signal, env: envForChild(config) })
      const command = [resolved.cli, ...argv].map((part) => (/[\s"]/.test(part) ? JSON.stringify(part) : part)).join(' ')
      const trim = (text) => {
        const value = text.trimEnd()
        if (value.length <= maxChars) return value
        return `${value.slice(0, maxChars)}\n... [${value.length - maxChars} more characters trimmed; raise maxOutputChars or read the CLI output yourself]`
      }
      const payload = {
        ok: result.code === 0,
        exitCode: result.timedOut ? null : result.code,
        timedOut: Boolean(result.timedOut),
        stdout: trim(result.stdout),
        stderr: trim(result.stderr),
        command,
        ms: result.ms,
      }
      if (result.error) payload.error = result.error
      return payload
    },
  }
}

function installTool(config) {
  return {
    name: 'craft_install',
    description:
      'Download or update the official Craft Anything CLI for this machine from github.com/storytold/craft-anything releases into the plugin data directory, verifying the release SHA256 before unpacking. Windows uses the official portable zip; macOS uses the official universal CLI zip; Linux uses the release tarball (best effort). Uses the system proxy. A successful install asks the running MCP bridge to restart so it picks up the new CLI (no Harness restart needed).',
    parameters: {
      type: 'object',
      properties: {
        version: { type: 'string', description: 'Release tag such as "v0.4.0", or "latest" (default).' },
        force: { type: 'boolean', description: 'Re-download even when that version is already present.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: value.output || (value.ok ? 'done' : 'failed') }],
    },
    async execute(args, exec) {
      const version = typeof args?.version === 'string' && args.version.trim() ? args.version.trim() : 'latest'
      const output = []
      let result
      result = await runCliInstaller(config, { version, force: Boolean(args?.force), signal: exec?.signal })
      output.push(result.stdout, result.stderr)
      const text = output.filter(Boolean).join('\n').trimEnd()
      const payload = {
        ok: result.code === 0,
        exitCode: result.code,
        output: text.length > 8_000 ? `${text.slice(0, 8_000)}\n... [trimmed]` : (text || '(installer printed nothing)'),
        ms: result.ms,
      }
      if (payload.ok) {
        // New binaries usually mean a newer version than the one the bridge started with; the
        // launcher watches this marker file and restarts the server, so the MCP tools move to the
        // new CLI without a Harness restart. Reset the status caches so the page shows it.
        try {
          const root = installRoot(config)
          fs.mkdirSync(root, { recursive: true })
          fs.writeFileSync(path.join(root, 'mcp.restart'), `${new Date().toISOString()}\n`)
        } catch { /* the restart marker is best effort */ }
        probeCache.cli = null
        probeCache.version = null
        probeCache.versionAt = 0
        probeCache.capabilities = null
        probeCache.capabilitiesAt = 0
        statusCache = { at: 0, report: null }
        payload.output += '\n\nThe running MCP bridge restarts now to use the new CLI (its tool list re-syncs in a second or two).'
      }
      if (!payload.ok) {
        payload.output += '\n\nIf the download failed, check the system proxy and try `craft_cli` with ["--version"] afterwards.'
      }
      return payload
    },
  }
}

function modeTool(config) {
  return {
    name: 'craft_mode',
    description:
      'Read or switch the analysis mode of the Craft Anything MCP bridge. "clean" (clean room) is the default: nothing inside a target is read, only what a visitor sees. "deep" lets every tool read code, files and page source, for private use. The MCP server reads the mode once at startup, so switching restarts the server process and dsh-mcp-client reconnects: the mcp__craft__ tool list re-syncs in a second or two, and calls in flight fail. Call with no mode to just read it.',
    parameters: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['clean', 'deep'], description: 'Leave out to read the current mode.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const lines = [`Craft Anything mode: ${value.mode === 'deep' ? 'deep' : 'clean room'}`]
        if (value.changed) lines.push(value.applied ? '  switched; the MCP server restarted and its tool list re-syncs' : '  mode.json written; the server has not confirmed the new mode yet')
        if (value.server && value.server.startedAt) lines.push(`  server started ${value.server.startedAt} with ${value.server.args.join(' ')}`)
        if (value.note) lines.push(`  ${value.note}`)
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(args, exec) {
      const requested = args && typeof args.mode === 'string' ? args.mode : null
      if (requested === null) {
        return { mode: readMode(config), changed: false, applied: true, restarted: false, server: readMcpState(config) }
      }
      if (requested !== 'clean' && requested !== 'deep') throw new Error('mode must be "clean" or "deep".')
      const result = await setMode(config, requested)
      if (!result.applied) {
        // Still report the persisted mode; the caller can re-run or rely on reconnect.
        return { ...result, mode: readMode(config) }
      }
      void exec
      return result
    },
  }
}

export const inject = ['tools']

// --- HTTP management-interface authentication ---------------------------------------------------
// Named routes on the DSH Web server have no server-wide auth (the carrier README says route owners
// "enforce their own request policy"), so every management route below is guarded here:
//   1. Host fence: only 127.0.0.1 / localhost (or an explicitly configured trustedHosts entry).
//   2. Origin fence: a browser request must come from the same local origin; a cross-site request
//      is refused before any work happens (CSRF).
//   3. Host connection admission: browser-originated requests must carry the DSH session credential
//      (ctx.connection.requestRejection applies DSH's own Host/Origin/browser checks and answers
//      401/403 for unauthenticated requests).
//   4. Bearer token: this plugin's own random per-process token, required on every management
//      request. The Web page bootstraps it from GET /craft-anything/api/token (itself behind the
//      DSH connection admission) and it is also written to <root>/http.token (0600) for local CLI
//      clients. No password or manual input is involved.

const TOKEN_ROUTE = '/craft-anything/api/token'
const HTTP_TOKEN_FILE = 'http.token'
const HTTP_TOKEN_MIN_LENGTH = 32

function createHttpAuth(ctx, settings = {}) {
  const override = typeof process.env.CRAFT_ANYTHING_HTTP_TOKEN === 'string' ? process.env.CRAFT_ANYTHING_HTTP_TOKEN.trim() : ''
  const token = override.length >= HTTP_TOKEN_MIN_LENGTH ? override : randomBytes(32).toString('hex')
  const tokenFile = path.join(installRoot(settings), HTTP_TOKEN_FILE)
  try {
    fs.mkdirSync(installRoot(settings), { recursive: true })
    fs.writeFileSync(tokenFile, `${token}\n`, { mode: 0o600 })
    try { fs.chmodSync(tokenFile, 0o600) } catch { /* Windows ignores POSIX modes */ }
  } catch { /* the in-memory token still guards the routes */ }
  return {
    token,
    tokenFile,
    trustedHosts: Array.isArray(settings.trustedHosts) ? settings.trustedHosts.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()) : [],
    allowNonLoopback: settings.allowNonLoopback === true,
    connection: () => {
      try {
        const connection = ctx.get('connection')
        return connection && typeof connection.requestRejection === 'function' ? connection : undefined
      } catch {
        return undefined
      }
    },
  }
}

function headerOf(headers, name) {
  if (!headers) return undefined
  const value = headers[name] ?? headers[name.toLowerCase()]
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'string' ? value : undefined
}

function authorityOf(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try { return new URL(`http://${value}`) } catch { return undefined }
}

function isLoopbackHostname(hostname) {
  const normal = String(hostname || '').toLowerCase()
  if (normal === 'localhost' || normal === '::1' || normal === '[::1]') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normal)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  return octets.every((part) => part >= 0 && part <= 255) && octets[0] === 127
}

/** Host header fence: loopback only unless the profile explicitly widens it. */
function hostAllowed(req, auth) {
  const authority = authorityOf(headerOf(req.headers, 'host'))
  if (!authority) return false
  if (isLoopbackHostname(authority.hostname)) return true
  if (!auth.allowNonLoopback) return false
  const normalized = authority.host.toLowerCase()
  return auth.trustedHosts.some((entry) => {
    const trusted = authorityOf(entry)
    return trusted !== undefined && trusted.host.toLowerCase() === normalized
  })
}

/** Origin fence: a browser Origin must equal the request authority and stay local. */
function originAllowed(req, auth) {
  const origin = headerOf(req.headers, 'origin')
  if (origin === undefined) return true // non-browser client: gated by the Bearer token
  let parsed
  try { parsed = new URL(origin) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (!isLoopbackHostname(parsed.hostname) && !(auth.allowNonLoopback && auth.trustedHosts.length > 0)) return false
  const authority = authorityOf(headerOf(req.headers, 'host'))
  if (!authority) return false
  return parsed.host.toLowerCase() === authority.host.toLowerCase()
}

function isBrowserRequest(req) {
  const site = headerOf(req.headers, 'sec-fetch-site')
  if (site !== undefined) return site !== 'none'
  return headerOf(req.headers, 'origin') !== undefined || headerOf(req.headers, 'referer') !== undefined
}

function bearerOf(req) {
  const value = headerOf(req.headers, 'authorization')
  if (typeof value !== 'string') return undefined
  const match = /^Bearer[ \t]+([A-Za-z0-9._~+/=-]{8,4096})$/i.exec(value.trim())
  return match ? match[1] : undefined
}

function constantEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('vary', 'Origin')
  res.end(JSON.stringify(payload))
}

/** undefined: authorized; 401/403: answer that status and stop before any side effect. */
async function rejectRequest(req, auth, options = {}) {
  const requireToken = options.requireToken !== false
  const requireConnection = options.requireConnection === 'always'
  if (!hostAllowed(req, auth)) return 403
  if (!originAllowed(req, auth)) return 403
  if (requireConnection || isBrowserRequest(req)) {
    const connection = auth.connection()
    if (!connection) return 401
    const rejection = connection.requestRejection({ headers: req.headers })
    if (rejection === 401 || rejection === 403) return rejection
  }
  if (requireToken && !constantEquals(bearerOf(req), auth.token)) return 401
  return undefined
}

function guarded(handler, auth, options = {}) {
  return async (req, res) => {
    const rejection = await rejectRequest(req, auth, options)
    if (rejection !== undefined) {
      sendJson(res, rejection, {
        ok: false,
        error: rejection === 401 ? 'unauthorized' : 'forbidden',
        hint: rejection === 401 && options.requireToken !== false ? 'management routes require Authorization: Bearer <token> from /craft-anything/api/token' : undefined,
      })
      return
    }
    return handler(req, res)
  }
}

function tokenRouteHandler(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'GET only' })
      return
    }
    sendJson(res, 200, { ok: true, token: auth.token })
  }, auth, { requireToken: false, requireConnection: 'always' })
}


// --- MCP bridge on/off + tool allowlist ---------------------------------------------------------
// The DSH mcp-client registers every tool a stdio server lists, so the Essentials toolset alone puts
// ~30 schemas in every request. scripts/mcp-bridge.cjs (copied next to the launcher) proxies the
// CLI stdio and filters tools/list from <root>/bridge.json; it emits notifications/tools/list_changed
// so dsh-mcp-client re-syncs the context without restarting the CLI or the Harness.

const BRIDGE_ROUTE = '/craft-anything/api/bridge'
const BRIDGE_FILE = 'bridge.json'
const DEFAULT_BRIDGE = { enabled: true, allow: [] }

function bridgeFile(config = {}) {
  return path.join(installRoot(config), BRIDGE_FILE)
}

function readBridge(config = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(bridgeFile(config), 'utf8'))
    return {
      enabled: !(parsed && parsed.enabled === false),
      allow: parsed && Array.isArray(parsed.allow)
        ? parsed.allow.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
        : [],
      updatedAt: parsed && typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  } catch {
    return { enabled: DEFAULT_BRIDGE.enabled, allow: DEFAULT_BRIDGE.allow.slice(), updatedAt: null }
  }
}

function writeBridge(config = {}, patch = {}) {
  const current = readBridge(config)
  const next = {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
    allow: Array.isArray(patch.allow)
      ? patch.allow.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
      : current.allow,
    updatedAt: new Date().toISOString(),
  }
  fs.mkdirSync(installRoot(config), { recursive: true })
  fs.writeFileSync(bridgeFile(config), `${JSON.stringify(next, null, 2)}\n`)
  return next
}

function bridgeReport(config = {}) {
  const bridge = readBridge(config)
  let state = null
  try { state = JSON.parse(fs.readFileSync(stateFile(config), 'utf8')) } catch { /* bridge not running */ }
  return {
    ok: true,
    bridge,
    bridgeFile: bridgeFile(config),
    tools: state && state.tools && Number.isFinite(state.tools.visible) ? state.tools : null,
    server: state
      ? { mode: state.mode === 'deep' ? 'deep' : 'clean', pid: Number.isFinite(state.pid) ? state.pid : null, startedAt: typeof state.startedAt === 'string' ? state.startedAt : null }
      : null,
  }
}

function bridgeTool(config) {
  return {
    name: 'craft_bridge',
    description:
      'Turn the MCP bridge on/off and limit which mcp__craft__* tools DSH registers in the context. The bridge proxy answers tools/list from <root>/bridge.json and emits notifications/tools/list_changed, so dsh-mcp-client re-syncs in about a second without restarting the CLI or the Harness (a clean/deep mode switch still restarts the CLI, because mode is fixed at startup). With no arguments it only reports the current state. Pattern syntax: "*" wildcard only, matched case-insensitively against the tool name; an empty allow list allows every tool.',
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'false removes every mcp__craft__* tool from the context; true brings them back.' },
        allow: { type: 'array', items: { type: 'string' }, description: 'Glob patterns such as ["core_*","session_*"]; empty array allows every tool.' },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => {
        const tools = value.tools ? `${value.tools.visible} visible of ${value.tools.total}` : 'not listed yet'
        return [{
          type: 'text',
          text: [
            `MCP bridge: ${value.bridge.enabled ? 'on' : 'off'}`,
            `  allow: ${value.bridge.allow.length ? value.bridge.allow.join(', ') : '(all tools)'}`,
            `  tools: ${tools}`,
            `  bridge file: ${value.bridgeFile}`,
            'note: dsh-mcp-client re-syncs after notifications/tools/list_changed (about 1 s).',
          ].join('\n'),
        }]
      },
    },
    async execute(args) {
      const patch = {}
      if (typeof args?.enabled === 'boolean') patch.enabled = args.enabled
      if (Array.isArray(args?.allow)) patch.allow = args.allow.map(String)
      if (patch.enabled !== undefined || patch.allow !== undefined) writeBridge(config, patch)
      return bridgeReport(config)
    },
  }
}

function bridgeRouteHandler(getSettings) {
  return async (req, res) => {
    const send = (code, payload) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        send(200, bridgeReport(getSettings()))
      } catch (error) {
        send(500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
      return
    }
    if (req.method !== 'POST') {
      send(405, { ok: false, error: 'GET or POST only' })
      return
    }
    const body = await readJsonBody(req, 16 * 1024)
    if (!body || typeof body !== 'object') {
      send(400, { ok: false, error: 'body must be {"enabled":boolean,"allow":["core_*"]}' })
      return
    }
    try {
      const patch = {}
      if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
      if (Array.isArray(body.allow)) patch.allow = body.allow.map(String)
      if (patch.enabled === undefined && patch.allow === undefined) {
        send(400, { ok: false, error: 'body must contain enabled and/or allow' })
        return
      }
      writeBridge(getSettings(), patch)
      send(200, bridgeReport(getSettings()))
    } catch (error) {
      send(500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }
}


const STATUS_ROUTE = '/craft-anything/api/status'
const MODE_ROUTE = '/craft-anything/api/mode'

function readJsonBody(req, limit = 4096) {
  return new Promise((resolve) => {
    let size = 0
    let text = ''
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        req.destroy()
        resolve(null)
        return
      }
      text += chunk.toString()
    })
    req.on('end', () => {
      try {
        resolve(JSON.parse(text || '{}'))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

/** GET returns the persisted mode and the running server's view; POST {"mode":"clean"|"deep"} switches it. */
function modeRouteHandler(getSettings) {
  return async (req, res) => {
    const send = (code, payload) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      send(200, { ok: true, mode: readMode(getSettings()), server: readMcpState(getSettings()) })
      return
    }
    if (req.method !== 'POST') {
      send(405, { ok: false, error: 'GET or POST only' })
      return
    }
    const body = await readJsonBody(req)
    const wanted = body && (body.mode === 'clean' || body.mode === 'deep') ? body.mode : null
    if (!wanted) {
      send(400, { ok: false, error: 'body must be {"mode":"clean"|"deep"}' })
      return
    }
    try {
      const result = await setMode(getSettings(), wanted)
      statusCache = { at: 0, report: null }
      send(200, { ok: true, ...result })
    } catch (error) {
      send(500, { ok: false, error: String(error?.message || error) })
    }
  }
}

/** One shared, briefly cached status snapshot for the Web page (it polls). */
function statusRouteHandler(getSettings) {
  return async (req, res) => {
    const send = (code, payload) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(405, { ok: false, error: 'GET only' })
      return
    }
    try {
      const full = typeof req.url === 'string' && /[?&]full=1(?:&|$)/.test(req.url)
      const status = full ? await refreshStatus(getSettings()) : await cachedStatus(getSettings())
      send(200, { ok: true, status })
    } catch (error) {
      send(500, { ok: false, error: String(error?.message || error) })
    }
  }
}

let statusCache = { at: 0, report: null }
const STATUS_TTL_MS = 60_000

async function cachedStatus(settings) {
  const now = Date.now()
  if (statusCache.report && now - statusCache.at < STATUS_TTL_MS) return statusCache.report
  const report = await statusReport(settings)
  statusCache = { at: Date.now(), report }
  return report
}

async function refreshStatus(settings) {
  const report = await statusReport(settings, { full: true })
  statusCache = { at: Date.now(), report }
  return report
}

// --- environment & dependencies ---------------------------------------------------------------
// The page shows a platform-aware checklist and can run one-click installs from the Host half.
// Only installs this plugin can really perform are marked `auto: true`; everything else carries
// the exact command for the current OS and is copied to the clipboard from the page.

const ENV_ROUTE = '/craft-anything/api/env'
const ENV_FILE = 'env.json'

function envFile(config = {}) {
  return path.join(installRoot(config), ENV_FILE)
}

function readEnvFile(config = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(envFile(config), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const env = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === 'string' && value) env[key] = value
    }
    return env
  } catch {
    return {}
  }
}

function writeEnvFile(config, patch) {
  const merged = { ...readEnvFile(config), ...patch }
  fs.mkdirSync(installRoot(config), { recursive: true })
  fs.writeFileSync(envFile(config), `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

/** Environment for spawned CLI processes: the Harness env plus install-time overrides. */
function envForChild(config = {}) {
  return { ...process.env, ...readEnvFile(config) }
}

function proxyUrl() {
  return process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy || ''
}

function invalidateProbes() {
  probeCache.cli = null
  probeCache.version = null
  probeCache.versionAt = 0
  probeCache.capabilities = null
  probeCache.capabilitiesAt = 0
  statusCache = { at: 0, report: null }
  whichCache.clear()
}

const envJobs = new Map()

function envJobsSnapshot() {
  return [...envJobs.values()].map((job) => ({
    id: job.id,
    status: job.status,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    detail: job.detail || '',
    error: job.error || null,
    log: job.log.slice(-30).join('\n'),
  }))
}

function jobLog(job, line) {
  const text = String(line == null ? '' : line).slice(0, 2000)
  if (!text) return
  for (const part of text.split(/\r?\n/)) {
    if (!part.trim()) continue
    job.log.push(part.slice(0, 500))
  }
  if (job.log.length > 80) job.log.splice(0, job.log.length - 80)
  job.updatedAt = new Date().toISOString()
}

function jobDetail(job, detail) {
  job.detail = String(detail || '').slice(0, 400)
  job.updatedAt = new Date().toISOString()
}

function startEnvJob(config, id, runner) {
  const existing = envJobs.get(id)
  if (existing && existing.status === 'running') return existing
  const job = {
    id,
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    detail: '',
    error: null,
    log: [],
  }
  envJobs.set(id, job)
  runner(job)
    .then(() => {
      job.status = 'done'
      job.updatedAt = new Date().toISOString()
      invalidateProbes()
    })
    .catch((error) => {
      job.status = 'error'
      job.error = String(error && error.message ? error.message : error).slice(0, 800)
      job.updatedAt = new Date().toISOString()
      jobLog(job, `error: ${job.error}`)
      invalidateProbes()
    })
  return job
}

function manualCommandFor(id) {
  if (id === 'java') {
    if (IS_WINDOWS) return 'winget install --id EclipseAdoptium.Temurin.21.JDK -e'
    if (process.platform === 'darwin') return 'brew install --cask temurin@21'
    return 'sudo apt install openjdk-21-jdk'
  }
  if (id === 'gdb') {
    if (IS_WINDOWS) return 'winget install -e --id MSYS2.MSYS2\npacman -S --needed mingw-w64-ucrt-x86_64-gdb'
    if (process.platform === 'darwin') return 'brew install gdb'
    return 'sudo apt install gdb'
  }
  if (id === 'chromium') {
    if (IS_WINDOWS) return 'winget install -e --id Google.Chrome'
    if (process.platform === 'darwin') return 'brew install --cask google-chrome'
    return 'sudo apt install chromium'
  }
  return ''
}

const enginesCache = { at: 0, cli: null, data: null }

/** Ground truth for engines and dependencies comes from the CLI itself (engines_list). */
async function enginesList(config = {}) {
  const resolved = resolveCli(config)
  if (!resolved.cli) return null
  const now = Date.now()
  if (enginesCache.data && enginesCache.cli === resolved.cli && now - enginesCache.at < 120_000) return enginesCache.data
  const result = await run(resolved.cli, ['engines_list', '--json', '{}'], { timeoutMs: 30_000, env: envForChild(config) })
  if (result.code !== 0) return null
  try {
    const parsed = JSON.parse(result.stdout)
    const data = parsed && parsed.result ? parsed.result : parsed
    enginesCache.cli = resolved.cli
    enginesCache.at = Date.now()
    enginesCache.data = data
    return data
  } catch {
    return null
  }
}

function invalidateEngines() {
  enginesCache.cli = null
  enginesCache.at = 0
  enginesCache.data = null
}

/** Ghidra headless launcher inside a folder (the folder itself may hold a ghidra_* child). */
function ghidraLauncherIn(dir) {
  if (!dir) return null
  try { if (fs.statSync(dir).isFile()) return dir } catch { return null }
  const names = ['analyzeHeadless.bat', 'analyzeHeadless']
  for (const name of names) {
    const candidate = path.join(dir, 'support', name)
    if (existsFile(candidate)) return candidate
  }
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      for (const name of names) {
        const candidate = path.join(dir, entry.name, 'support', name)
        if (existsFile(candidate)) return candidate
      }
    }
  } catch { /* unreadable folder: not a candidate */ }
  return null
}

async function installCliInto(config, job, options = {}) {
  const version = options.version || 'latest'
  jobDetail(job, `installing craft-anything-cli (${version})`)
  jobLog(job, `installing craft-anything-cli (${version})`)
  const result = await runCliInstaller(config, { version, force: Boolean(options.force), signal: options.signal })
  jobLog(job, [result.stdout, result.stderr].filter(Boolean).join('\n'))
  if (result.code !== 0) throw new Error(`installer exited ${result.code}: ${(result.stderr || '').trim().slice(0, 400)}`)
  try { fs.writeFileSync(path.join(installRoot(config), 'mcp.restart'), `${new Date().toISOString()}\n`) } catch { /* best effort */ }
  jobLog(job, 'done; the MCP bridge restarts onto the new CLI')
}

async function runCliInstaller(config, options = {}) {
  const version = options.version || 'latest'
  const force = Boolean(options.force)
  const signal = options.signal
  if (IS_WINDOWS) {
    if (!existsFile(INSTALLER)) throw new Error(`installer script is missing from the plugin package: ${INSTALLER}`)
    const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER, '-Version', version]
    if (force) argv.push('-Force')
    if (config.installDir) argv.push('-Root', config.installDir)
    return run('powershell.exe', argv, { timeoutMs: 900_000, signal })
  }
  if (!existsFile(INSTALLER_NODE)) throw new Error(`installer script is missing from the plugin package: ${INSTALLER_NODE}`)
  const argv = [INSTALLER_NODE, '--version', version]
  if (force) argv.push('--force')
  if (config.installDir) argv.push('--root', config.installDir)
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  return run(process.execPath, argv, { timeoutMs: 900_000, signal, env })
}

async function installCodingAgentInto(config, job) {
  const npm = which('npm') || which('npm.cmd') || which('npm.exe')
  const packageName = '@anthropic-ai/claude-code'
  const runNpmInstall = async (command, argv) => {
    jobDetail(job, 'installing the Claude Code CLI')
    jobLog(job, command + ' ' + argv.join(' '))
    // Windows: npm.CMD cannot be spawned directly (Node refuses .cmd without a shell, and the
    // shell path needs quoting), so run npm own JS entry through the Harness Node instead.
    let result
    const npmJs = /[\\/]npm(\.cmd|\.exe)?$/i.test(command)
      ? path.join(path.dirname(command), 'node_modules', 'npm', 'bin', 'npm-cli.js')
      : null
    if (npmJs && existsFile(npmJs)) {
      result = await run(process.execPath, [npmJs, ...argv], {
        timeoutMs: 900_000,
        env: { ...envForChild(config), ELECTRON_RUN_AS_NODE: '1' },
      })
    } else {
      result = await run(command, argv, { timeoutMs: 900_000, env: envForChild(config) })
    }
    jobLog(job, [result.stdout, result.stderr].filter(Boolean).join('\n'))
    if (result.code !== 0) throw new Error(command + ' exited ' + result.code + ': ' + (result.stderr || '').trim().slice(0, 400))
  }
  if (npm) {
    await runNpmInstall(npm, ['install', '-g', packageName])
    jobLog(job, 'done; sign in once with `claude` (or set an API key) before rebuild can use it')
    return
  }
  const pnpmScript = path.join(path.dirname(process.execPath), 'resources', 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  if (existsFile(pnpmScript)) {
    jobLog(job, 'npm is not on PATH; using the pnpm shipped with the Harness')
    await runNpmInstall(process.execPath, [pnpmScript, 'add', '-g', packageName])
    jobLog(job, 'If `claude` is still not found, add the pnpm global bin directory to PATH (`pnpm bin -g`).')
    jobLog(job, 'Sign in once with `claude` before rebuild can use it.')
    return
  }
  throw new Error('Neither npm nor the Harness pnpm wrapper was found. Install Node.js/npm first, then retry.')
}

async function installGhidraInto(config, job) {
  const resolved = resolveCli(config)
  if (!resolved.cli) throw new Error('craft-anything-cli is not installed; install the CLI first')
  // Prefer a Ghidra that is already on this machine (no 570 MB download): point the CLI own
  // setting at it. The CLI then reports it through engines_list, capabilities and doctor.
  const candidates = []
  for (const value of [envForChild(config).GHIDRA_INSTALL_DIR, readEnvFile(config).GHIDRA_INSTALL_DIR]) {
    if (value) candidates.push(value)
  }
  const toolsDir = path.join(installRoot(config), 'tools')
  try {
    for (const entry of fs.readdirSync(toolsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && /ghidra/i.test(entry.name)) candidates.push(path.join(toolsDir, entry.name))
    }
  } catch { /* no tools folder */ }
  const existing = candidates.find((dir) => ghidraLauncherIn(dir))
  if (existing) {
    const launcher = ghidraLauncherIn(existing)
    jobDetail(job, 'configuring the existing Ghidra')
    jobLog(job, 'found an existing Ghidra: ' + launcher)
    const set = await run(resolved.cli, ['settings_set', '--json', JSON.stringify({ key: 'engines.ghidra.install_dir', value: existing })], { timeoutMs: 60_000, env: envForChild(config) })
    jobLog(job, [set.stdout, set.stderr].filter(Boolean).join('\n'))
    if (set.code !== 0) throw new Error('settings_set failed: ' + (set.stderr || '').trim().slice(0, 400))
    invalidateEngines()
    invalidateProbes()
    jobLog(job, 'Ghidra configured; the CLI now reports it as installed')
    return
  }
  jobDetail(job, 'asking the CLI to install Ghidra (large download)')
  jobLog(job, 'no Ghidra found on this machine; asking the CLI to install Ghidra and its Java (large download, several minutes)')
  const install = await run(resolved.cli, ['engines_install', '--json', JSON.stringify({ engine: 'ghidra' })], { timeoutMs: 3_600_000, env: envForChild(config) })
  jobLog(job, [install.stdout, install.stderr].filter(Boolean).join('\n'))
  if (install.code !== 0) throw new Error('engines_install exited ' + install.code + ': ' + (install.stdout || install.stderr || '').trim().slice(0, 400))
  invalidateEngines()
  invalidateProbes()
  const data = await enginesList(config)
  const engine = data && Array.isArray(data.engines) ? data.engines.find((item) => item.id === 'ghidra') : null
  if (!engine || !engine.found) throw new Error('the CLI finished but still does not report Ghidra as installed')
  jobLog(job, 'Ghidra installed: ' + engine.found)
}

const AUTO_INSTALLABLE = new Set(['cli', 'coding-agent', 'ghidra'])

function startEnvJobById(config, id) {
  if (!AUTO_INSTALLABLE.has(id)) return null
  if (id === 'cli') return startEnvJob(config, 'cli', (job) => installCliInto(config, job, { version: 'latest' }))
  if (id === 'coding-agent') return startEnvJob(config, 'coding-agent', (job) => installCodingAgentInto(config, job))
  return startEnvJob(config, 'ghidra', (job) => installGhidraInto(config, job))
}

﻿async function envReport(config = {}) {
  const resolved = resolveCli(config)
  const status = await statusReport(config) // cached probes: cheap after the first call
  const data = resolved.cli ? await enginesList(config) : null
  const engines = data && Array.isArray(data.engines) ? data.engines : []
  const findEngine = (id) => engines.find((item) => item && item.id === id) || null
  const foundOf = (id) => {
    const engine = findEngine(id)
    return engine && engine.found ? String(engine.found) : null
  }
  const envValues = readEnvFile(config)
  const agent = which('claude') || which('claude.cmd')
  const npm = which('npm') || which('npm.cmd') || which('npm.exe')
  const ghidra = findEngine('ghidra')
  const ghidraFound = foundOf('ghidra')
  const chromiumFound = foundOf('chromium')
  const javaFound = foundOf('java')
  const gdbFound = foundOf('gdb')
  const checks = [
    {
      id: 'cli',
      group: 'core',
      auto: true,
      label: { en: 'craft-anything CLI', zh: 'craft-anything CLI' },
      hint: { en: 'The local CLI behind every mcp__craft__* tool.', zh: '所有 mcp__craft__* 工具背后的本地 CLI。' },
      state: resolved.cli ? 'ok' : 'missing',
      detail: resolved.cli ? `${status.version || 'installed'}${status.portable ? ' · portable' : ''}` : 'not installed',
    },
    {
      id: 'chromium',
      group: 'core',
      auto: false,
      label: { en: 'Chromium based browser', zh: 'Chromium 内核浏览器' },
      hint: { en: 'Used by the browser recording and inspection tools.', zh: '浏览器录制/检查工具需要它。' },
      state: chromiumFound ? 'ok' : 'missing',
      detail: chromiumFound || 'not detected by the CLI',
      command: manualCommandFor('chromium'),
    },
    {
      id: 'coding-agent',
      group: 'deep',
      auto: true,
      label: { en: 'Coding agent (Claude Code)', zh: '编码智能体（Claude Code）' },
      hint: { en: 'Needed for rebuild; study and inspect tools work without it.', zh: 'rebuild 需要它；只用研究与检查工具可以不装。' },
      state: agent ? 'ok' : 'missing',
      detail: agent || (npm ? `npm found: ${npm}` : 'npm not on PATH (the Harness pnpm fallback will be used)'),
    },
    {
      id: 'ghidra',
      group: 'deep',
      auto: true,
      label: { en: 'Ghidra (native decompiling)', zh: 'Ghidra（原生反编译）' },
      hint: {
        en: 'Reuses an existing Ghidra (GHIDRA_INSTALL_DIR) by pointing the CLI at it; otherwise the CLI downloads Ghidra and its Java (large, several minutes).',
        zh: '优先复用本机已有的 Ghidra（GHIDRA_INSTALL_DIR）并写入 CLI 设置；没有时由 CLI 自动下载 Ghidra 与自带 Java（较大，需几分钟）。',
      },
      state: ghidraFound ? 'ok' : 'missing',
      detail: ghidraFound || (ghidra && ghidra.installable_here ? 'not installed (the CLI can install it here)' : 'not installed'),
    },
    {
      id: 'java',
      group: 'deep',
      auto: false,
      label: { en: 'Java 21+', zh: 'Java 21+' },
      hint: { en: 'Runtime required by Ghidra.', zh: 'Ghidra 需要的运行时。' },
      state: javaFound ? 'ok' : 'missing',
      detail: javaFound || 'not detected by the CLI',
      command: manualCommandFor('java'),
    },
    {
      id: 'gdb',
      group: 'deep',
      auto: false,
      label: { en: 'GDB', zh: 'GDB' },
      hint: { en: 'Debugger used by some native analysis tools.', zh: '部分原生分析工具用到的调试器。' },
      state: gdbFound ? 'ok' : 'missing',
      detail: gdbFound || 'not detected by the CLI',
      command: manualCommandFor('gdb'),
    },
  ]
  return {
    ok: true,
    platform: `${process.platform}-${process.arch}`,
    envFile: envFile(config),
    envValues,
    engineStore: data && data.engine_store ? String(data.engine_store) : null,
    deepMode: data && data.deep_mode ? data.deep_mode : null,
    jobs: envJobsSnapshot(),
    checks,
  }
}

function envRouteHandler(getSettings) {
  return async (req, res) => {
    const send = (code, payload) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      try {
        // Manual refresh (page Refresh button) bypasses the engines cache so a dependency that was
        // installed outside the page is picked up immediately.
        if (typeof req.url === 'string' && /[?&]full=1(?:&|$)/.test(req.url)) invalidateEngines()
        send(200, await envReport(getSettings()))
      } catch (error) {
        send(500, { ok: false, error: String(error && error.message ? error.message : error) })
      }
      return
    }
    if (req.method !== 'POST') {
      send(405, { ok: false, error: 'GET or POST only' })
      return
    }
    const body = await readJsonBody(req, 64 * 1024)
    const action = body && typeof body.action === 'string' ? body.action : ''
    const settings = getSettings()
    try {
      if (action === 'install') {
        const id = body && typeof body.id === 'string' ? body.id : ''
        const job = id ? startEnvJobById(settings, id) : null
        if (!job) {
          send(400, { ok: false, error: `no automatic install for "${id}"; use the command shown on the page` })
          return
        }
        send(200, { ok: true, started: [job.id], jobs: envJobsSnapshot() })
        return
      }
      if (action === 'fix-all') {
        const report = await envReport(settings)
        const wanted = report.checks.filter((check) => check.auto && check.state !== 'ok').map((check) => check.id)
        const started = []
        for (const id of wanted) {
          const job = startEnvJobById(settings, id)
          if (job) started.push(job.id)
        }
        send(200, { ok: true, started, jobs: envJobsSnapshot() })
        return
      }
      send(400, { ok: false, error: 'body must be {"action":"install","id":"..."} or {"action":"fix-all"}' })
    } catch (error) {
      send(500, { ok: false, error: String(error && error.message ? error.message : error) })
    }
  }
}

export function apply(ctx, config) {
  // A patch row with only comments parses as `config: null`, so normalize both null and
  // undefined before reading the knobs.
  const raw = config || {}
  const settings = {
    cliPath: typeof raw.cliPath === 'string' && raw.cliPath.trim() ? raw.cliPath.trim() : undefined,
    installDir: typeof raw.installDir === 'string' && raw.installDir.trim() ? raw.installDir.trim() : undefined,
    projectDir: typeof raw.projectDir === 'string' && raw.projectDir.trim() ? raw.projectDir.trim() : undefined,
    projectsRoot: typeof raw.projectsRoot === 'string' && raw.projectsRoot.trim() ? raw.projectsRoot.trim() : undefined,
    trustedHosts: Array.isArray(raw.trustedHosts) ? raw.trustedHosts : [],
    allowNonLoopback: raw.allowNonLoopback === true,
  }
  // The MCP proxy is copied next to the launcher so the inline `-e` script can require it; if the
  // copy fails the launcher falls back to a plain pass-through until the next apply.
  try {
    fs.mkdirSync(installRoot(settings), { recursive: true })
    fs.copyFileSync(path.join(PACKAGE_DIR, 'scripts', 'mcp-bridge.cjs'), path.join(installRoot(settings), 'mcp-bridge.cjs'))
  } catch { /* launcher falls back to pass-through */ }

  const definitions = [statusTool(settings), cliTool(settings), installTool(settings), modeTool(settings), bridgeTool(settings)]
  ctx.effect(() => {
    const disposers = []
    try {
      for (const definition of definitions) disposers.push(ctx.tools.register(definition))
      return () => {
        while (disposers.length > 0) {
          const dispose = disposers.pop()
          try { dispose?.() } catch { /* keep unloading the rest */ }
        }
      }
    } catch (error) {
      while (disposers.length > 0) { try { disposers.pop()?.() } catch { /* ignore */ } }
      throw error
    }
  }, 'dsh-craft-anything: craft tools')

  // Management-interface auth: one random token per Harness process, written owner-only for local
  // CLI clients and bootstrapped by the Web page; every route below sits behind guarded().
  const httpAuth = createHttpAuth(ctx, settings)

  // The Web page reads live install state from this route. webServer is optional:
  // without it (TUI-only profile) the tools still work and the page is not mounted.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: TOKEN_ROUTE, handler: tokenRouteHandler(httpAuth) }),
      'dsh-craft-anything: token route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: STATUS_ROUTE, handler: guarded(statusRouteHandler(() => settings), httpAuth) }),
      'dsh-craft-anything: status route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: MODE_ROUTE, handler: guarded(modeRouteHandler(() => settings), httpAuth) }),
      'dsh-craft-anything: mode route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: ENV_ROUTE, handler: guarded(envRouteHandler(() => settings), httpAuth) }),
      'dsh-craft-anything: environment route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: BRIDGE_ROUTE, handler: guarded(bridgeRouteHandler(() => settings), httpAuth) }),
      'dsh-craft-anything: bridge route',
    )
  })
}
