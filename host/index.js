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

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_DIR = path.resolve(HERE, '..')
const INSTALLER = path.join(PACKAGE_DIR, 'scripts', 'install-cli.ps1')

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
  if (explicit) {
    if (existsFile(explicit)) return { cli: explicit, root, source: 'config' }
    return { cli: null, root, source: 'config-missing', tried: explicit }
  }
  const staged = path.join(root, 'bin', EXE_NAME)
  if (existsFile(staged)) return { cli: staged, root, source: 'bin' }
  const versioned = newestFirst(listDirs(root)).map((name) => path.join(root, name, EXE_NAME))
  const found = versioned.find(existsFile)
  if (found) return { cli: found, root, source: 'versioned' }
  return { cli: null, root, source: 'missing' }
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
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const state = readMcpState(config)
    if (state && state.mode === wanted) {
      return { mode: wanted, changed: true, applied: true, restarted: true, server: state }
    }
    await sleep(250)
  }
  return {
    mode: wanted,
    changed: true,
    applied: false,
    restarted: false,
    note: 'mode.json was written, but the MCP server has not reported the new mode yet; it reconnects within a few seconds (or start the plugin again).',
  }
}

function run(command, args, options = {}) {
  const { cwd, timeoutMs = 120_000, signal, env } = options
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
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error?.message || error), timedOut: false, error: String(error?.message || error), ms: 0 })
      return
    }
    const onAbort = () => {
      if (child && !child.killed) child.kill()
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true
        if (child && !child.killed) child.kill()
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

function which(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const exts = IS_WINDOWS ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean) : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      if (existsFile(candidate)) return candidate
    }
  }
  return null
}

async function statusReport(config = {}) {
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
  }
  if (!resolved.cli) {
    report.notes.push('craft-anything-cli was not found. Run the craft_install tool (or scripts/install-cli.ps1), then reload the plugin.')
    return report
  }
  report.portable = existsFile(path.join(path.dirname(resolved.cli), 'portable.txt'))
  const version = await run(resolved.cli, ['--version'], { timeoutMs: 20_000 })
  report.version = (version.stdout || version.stderr || '').trim().split(/\r?\n/)[0] || null
  if (version.code !== 0) report.notes.push(`\`--version\` exited ${version.code}: ${(version.stderr || '').trim().slice(0, 400)}`)
  const capabilities = await run(resolved.cli, ['capabilities'], { timeoutMs: 60_000 })
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
        summary.enginesFound = parsed.engines.filter((engine) => engine && engine.found).map((engine) => String(engine.id || engine.name || '?')).slice(0, 24)
      }
      report.capabilities = summary
    } catch {
      report.notes.push('`capabilities` did not return JSON; raw output trimmed to 600 chars.')
      report.capabilitiesRaw = (capabilities.stdout || '').slice(0, 600)
    }
  } else {
    report.notes.push(`\`capabilities\` exited ${capabilities.code}: ${(capabilities.stderr || '').trim().slice(0, 400)}`)
  }
  if (!report.prerequisites.codingAgent) {
    report.notes.push('No `claude` coding agent on PATH: study and inspect tools work, but `rebuild` needs a coding agent signed in (see `craft-anything-cli doctor`).')
  }
  // GHIDRA_INSTALL_DIR being set does not prove the CLI found Ghidra; report both facts.
  if (report.capabilities && Array.isArray(report.capabilities.enginesFound)) {
    report.prerequisites.ghidraDetected = report.capabilities.enginesFound.includes('ghidra')
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
      'Report the local Craft Anything install: CLI path and version, portable or not, capability counts, coding-agent and Ghidra availability, and how the MCP bridge is wired (tools appear as mcp__craft__*). Read-only; use it before rebuild work or to diagnose a missing CLI.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => renderStatus(value),
    },
    async execute() {
      return statusReport(config)
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
      const result = await run(resolved.cli, argv, { cwd, timeoutMs, signal: exec?.signal })
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
      'Download or update the official Craft Anything CLI for this machine from github.com/storytold/craft-anything releases into the plugin data directory, verifying the release SHA256 before unpacking. Needs the system proxy on this machine. After installing, reload the plugin (or restart the Harness) so the MCP bridge starts the server. Windows only; on other platforms the CLI has to be installed by hand.',
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
      if (!IS_WINDOWS) {
        throw new Error(`Automatic install is Windows-only. On ${process.platform} install craft-anything-cli from the project README and set CRAFT_ANYTHING_CLI or config.cliPath.`)
      }
      if (!existsFile(INSTALLER)) throw new Error(`installer script is missing from the plugin package: ${INSTALLER}`)
      const version = typeof args?.version === 'string' && args.version.trim() ? args.version.trim() : 'latest'
      const argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALLER, '-Version', version]
      if (args?.force) argv.push('-Force')
      if (config.installDir) argv.push('-Root', config.installDir)
      const result = await run('powershell.exe', argv, { timeoutMs: 900_000, signal: exec?.signal })
      const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd()
      const payload = {
        ok: result.code === 0,
        exitCode: result.code,
        output: output.length > 8_000 ? `${output.slice(0, 8_000)}\n... [trimmed]` : (output || '(installer printed nothing)'),
        ms: result.ms,
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
      const status = await cachedStatus(getSettings())
      send(200, { ok: true, status })
    } catch (error) {
      send(500, { ok: false, error: String(error?.message || error) })
    }
  }
}

let statusCache = { at: 0, report: null }
const STATUS_TTL_MS = 15_000

async function cachedStatus(settings) {
  const now = Date.now()
  if (statusCache.report && now - statusCache.at < STATUS_TTL_MS) return statusCache.report
  const report = await statusReport(settings)
  statusCache = { at: now, report }
  return report
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
  }
  const definitions = [statusTool(settings), cliTool(settings), installTool(settings), modeTool(settings)]
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

  // The Web page reads live install state from this route. webServer is optional:
  // without it (TUI-only profile) the tools still work and the page is not mounted.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: STATUS_ROUTE, handler: statusRouteHandler(() => settings) }),
      'dsh-craft-anything: status route',
    )
    webCtx.effect(
      () => webCtx.webServer.register({ kind: 'exact', path: MODE_ROUTE, handler: modeRouteHandler(() => settings) }),
      'dsh-craft-anything: mode route',
    )
  })
}
