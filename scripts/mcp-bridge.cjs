'use strict'
// dsh-craft-anything — MCP bridge proxy (stdio JSON-RPC) with in-process child swapping.
//
// Why this process exists
// -----------------------
// The DSH mcp-client registers every tool a stdio MCP server lists, so a bridge with the
// Essentials toolset puts ~30 schemas in every request and `--all-tools`/deep can put 321 there.
// This proxy sits between DSH and `craft-anything-cli mcp` and:
//
//   <root>/bridge.json   { "enabled": true, "allow": ["core_*", "session_*"] }
//     enabled=false      tools/list answers an empty list, tools/call answers an error, so DSH
//                        removes every mcp__craft__* tool from the context.
//     allow              optional glob patterns (`*` only) matched case-insensitively against the
//                        tool name; an empty list allows every tool. Applied to *every* tools/list
//                        response, including the bridge's own internal one.
//
//   <root>/mode.json     { "mode": "clean" | "deep" }  — the CLI picks its mode at startup, so a
//                        change swaps the CLI *child* while this bridge process stays alive.
//
// Both are polled (fs.watch is unreliable for a write-then-rename on Windows) every POLL_MS.
// bridge.json changes only re-filter + emit `notifications/tools/list_changed`, so dsh-mcp-client
// re-lists without restarting anything.
//
// Why the process no longer exits on a mode change
// ------------------------------------------------
// v0.4.0 wrote mode.json and exited, so dsh-mcp-client reconnected: any tools/call in flight at
// that instant failed, the tool list blinked, and the whole MCP session was re-initialized. Now
// the bridge is the stdio *server* for the whole life of the DSH session and only the CLI child is
// replaced, so DSH never sees a disconnect.
//
// State machine (one child at a time)
// -----------------------------------
//   starting    initial spawn; client messages are queued until the child is live
//   running     child live; client messages are forwarded and their ids tracked in `pending`
//   switching   a mode.json / mcp.restart change was seen:
//                1. drain        wait for every request already forwarded to the old child to be
//                                answered, up to CRAFT_ANYTHING_DRAIN_MS (default 20000, clamped
//                                1000..120000). Client messages that arrive meanwhile are queued,
//                                never failed and never answered with an error.
//                                Requests still unanswered when the drain expires are moved, with
//                                their original ids, into the replay list.
//                2. kill         the old child with the historic paranoia: SIGTERM, a second
//                                SIGTERM at 150 ms, SIGKILL at 1.2 s, and a 2.5 s guard that gives
//                                up *waiting* for it. The guard must never kill the bridge.
//                3. spawn        the new child with the new --deep / --clean-room flag, retrying
//                                with backoff (500 ms, 1 s, 2 s, 4 s, 4x4 s => up to 8 attempts).
//                4. handshake    an internal `initialize` (protocolVersion 2025-06-18,
//                                capabilities {}, clientInfo dsh-craft-anything-bridge/0.5.0),
//                                `notifications/initialized`, then an internal `tools/list` so the
//                                bridge can recompute total/visible. These use reserved ids
//                                ("craft-anything-bridge-internal-N") that are filtered on the way
//                                back and never reach DSH.
//                5. replay       in arrival order: the timed-out requests first, then everything
//                                queued during the switch — same ids, so DSH receives the real
//                                answers. Then emit notifications/tools/list_changed so DSH
//                                re-lists against the new mode.
//   running*    a child that died on its own is brought back the same way (reason "cli") so the
//               tools recover instead of staying broken; until a child answers, tools/call gets a
//               JSON-RPC -32603 instead of hanging forever.
//
// Drain / queue / replay semantics, precisely
// -------------------------------------------
//   * `pending` is keyed by the JSON-RPC id of a request forwarded to the current child and holds
//     the original parsed message + raw line. A response with that id forwards to DSH and clears
//     the entry.
//   * `queued` holds every client message received while `starting` or `switching`, in arrival
//     order. tools/call denials (bridge.json) are answered immediately and are never queued.
//   * At drain timeout only *requests* are moved to `replay`; their ids are remembered in
//     `suppressed` so a late answer from the old child (theoretically possible) cannot produce a
//     second response for the same id. When the entry is replayed the suppression is lifted and it
//     becomes pending again.
//   * RISK (deliberate): a timed-out call may in theory have already completed inside the old
//     process even though its response never arrived within the drain window. Replaying it executes
//     the tool a second time on the new child. The alternative — answering DSH with an error — was
//     what the reviewer objected to, and craft-anything tools are read-only by design.
//   * If all spawn attempts fail, the bridge answers every queued/replayed request with -32603 and
//     keeps running (stdin EOF remains the only reason it stops). The next request schedules a
//     background respawn; mode.json/mcp.restart also retry after a cooldown.
//
// Known limits
// ------------
//   * The internal handshake pins protocolVersion 2025-06-18 (what dsh-mcp-client negotiates)
//     instead of echoing whatever DSH used. A DSH build negotiating a different revision would get
//     an internal initialize answered at 2025-06-18; the forwarded (DSH-visible) initialize is
//     still the client's own, so only the bridge's internal view could be stale.
//   * tools/list is line-framed JSON, so a 321-tool response (~350 KB single line) is buffered
//     whole; unchanged from v0.4.0.
//   * A non-JSON line from DSH is forwarded verbatim (never swallowed) — kept for safety.
//
// The inline launcher in cordis.patch.yml only resolves the CLI and calls start(); everything it
// does is here so it can be unit-tested with a plain `node` process: tests/bridge/run.cjs.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const BRIDGE_FILE = 'bridge.json'
const STATE_FILE = 'mcp.state.json'

const MODE_FILE = 'mode.json'
const RESTART_FILE = 'mcp.restart'

const INTERNAL_ID_PREFIX = 'craft-anything-bridge-internal-'
const INTERNAL_PROTOCOL_VERSION = '2025-06-18'
const INTERNAL_CLIENT_INFO = { name: 'dsh-craft-anything-bridge', version: '0.5.0' }

const DEFAULT_DRAIN_MS = 20_000
const MIN_DRAIN_MS = 1_000
const MAX_DRAIN_MS = 120_000
const HANDSHAKE_TIMEOUT_MS = 15_000
const SECOND_SIGTERM_MS = 150
const SIGKILL_AT_MS = 1_200
const KILL_GUARD_MS = 2_500
// Delays between spawn attempts; the list length + 1 is the number of attempts (8).
const SPAWN_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 4_000, 4_000, 4_000]
const POLL_MS = 300
const RESTART_DEBOUNCE_MS = 500
const FAILED_SWITCH_COOLDOWN_MS = 15_000
const RECOVERY_DELAY_MS = 3_000

function readBridge(root) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(root, BRIDGE_FILE), 'utf8'))
    const enabled = !(parsed && parsed.enabled === false)
    const allow = parsed && Array.isArray(parsed.allow)
      ? parsed.allow.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim())
      : []
    return { enabled, allow }
  } catch {
    return { enabled: true, allow: [] }
  }
}

function compileAllow(allow) {
  return allow.map((pattern) => {
    const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
    return new RegExp('^' + escaped + '$', 'i')
  })
}

function writeState(stateFile, state) {
  // Best effort, never throws: the Host/Web UI polls this file, so a status write must not be able
  // to crash the bridge. Preferred path is write-temp + rename so a reader never sees a half file;
  // on Windows MoveFileEx fails with EPERM while another process has the target open (measured:
  // ~half of the attempts under a tight reader), so fall back to a direct write. A reader that
  // lands mid-truncate parses an empty file, treats it as "no state" and retries — a stale state
  // file, by contrast, would hide the mode/restarts counters forever.
  const payload = `${JSON.stringify(state)}\n`
  let temp = null
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    try {
      temp = `${stateFile}.tmp-${process.pid}`
      fs.writeFileSync(temp, payload)
      fs.renameSync(temp, stateFile)
      temp = null
      return
    } catch {
      if (temp) {
        try { fs.unlinkSync(temp) } catch { /* ignore */ }
        temp = null
      }
    }
    fs.writeFileSync(stateFile, payload)
  } catch {
    /* status is best effort */
  } finally {
    if (temp) {
      try { fs.unlinkSync(temp) } catch { /* ignore */ }
    }
  }
}

function normalizeMode(mode) {
  return mode === 'deep' ? 'deep' : 'clean'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function idKey(id) {
  return typeof id === 'number' ? `n:${id}` : `s:${String(id)}`
}

function isInternalId(id) {
  return typeof id === 'string' && id.startsWith(INTERNAL_ID_PREFIX)
}

function hasOwn(object, key) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key)
}

/**
 * Start the proxy. Never returns until the bridge stops (stdin EOF or a signal).
 * @param {{ cli: string, root: string, mode: string, argv: string[], env?: Record<string,string>, meta?: Record<string, unknown> }} options
 */
function start(options) {
  const opts = options || {}
  const cli = opts.cli
  const root = opts.root
  if (!cli || !root) throw new Error('mcp-bridge.start() needs a cli and a root')

  const launcherEnv = opts.env && typeof opts.env === 'object' ? opts.env : {}
  const meta = opts.meta && typeof opts.meta === 'object' ? opts.meta : {}
  const rawArgv = Array.isArray(opts.argv) ? opts.argv.slice() : []

  const modeFile = path.join(root, MODE_FILE)
  const bridgeFile = path.join(root, BRIDGE_FILE)
  const stateFile = path.join(root, STATE_FILE)
  const restartFile = path.join(root, RESTART_FILE)

  const startedAt = new Date().toISOString()
  const bridgeStartedAtMs = Date.now()
  const bridgePid = process.pid

  // The launcher passes ['mcp', ...extra, '--clean-room'|'--deep']; only that trailing mode flag has
  // to change on a switch, so strip it once and re-append the target mode's flag.
  const supportsModeFlags = rawArgv.some((arg) => arg === '--deep' || arg === '--clean-room')
  const baseArgv = rawArgv.filter((arg) => arg !== '--deep' && arg !== '--clean-room')
  const argvFor = (target) => (supportsModeFlags
    ? baseArgv.concat([target === 'deep' ? '--deep' : '--clean-room'])
    : baseArgv.slice())

  // ---- mutable bridge state ----------------------------------------------------------------
  let bridge = readBridge(root)
  let matchers = compileAllow(bridge.allow)
  let currentMode = normalizeMode(opts.mode)
  let childArgv = argvFor(currentMode)
  let detail = { total: null, visible: null }

  let child = null
  let childReady = false
  let activeGeneration = 0
  let starting = true
  let switching = false
  let shuttingDown = false

  const pending = new Map() // idKey -> { message, line }
  const internalWaiters = new Map() // idKey -> waiter
  const suppressed = new Set() // idKeys that outlived the drain window
  let queued = [] // client messages received while starting/switching
  let replayEntries = [] // requests left unanswered at the drain timeout
  let internalSeq = 0

  let drainResolver = null
  let restarts = 0
  let lastSwitchAt = null
  let lastRestartReason = null
  let lastRestartMtime = 0
  let restartTimer = null
  let recoveryTimer = null
  let lastRecoveryAt = 0
  let modeRetryNotBefore = 0
  let clientBuffer = ''

  // ---- logging (stderr only; stdout is the JSON-RPC channel) -------------------------------
  function log(message) {
    try { process.stderr.write(`[dsh-craft-anything] ${message}\n`) } catch { /* ignore */ }
  }
  function logError(prefix, error) {
    log(`${prefix}: ${error && error.message ? error.message : String(error)}`)
  }

  // ---- client side (DSH) --------------------------------------------------------------------
  function sendToClient(message) {
    try { process.stdout.write(`${JSON.stringify(message)}\n`) } catch { /* client gone */ }
  }
  function sendRawToClient(line) {
    try { process.stdout.write(`${line}\n`) } catch { /* client gone */ }
  }

  const allowed = (name) => {
    if (!bridge.enabled) return false
    if (matchers.length === 0) return true
    return matchers.some((matcher) => matcher.test(name))
  }

  function applyToolsFilter(tools) {
    const list = Array.isArray(tools) ? tools : []
    const visible = list.filter((tool) => tool && typeof tool.name === 'string' && allowed(tool.name))
    detail = { total: list.length, visible: visible.length }
    return visible
  }

  function persistState() {
    writeState(stateFile, Object.assign({}, meta, {
      cli,
      mode: currentMode,
      args: childArgv,
      pid: child ? child.pid : null,
      startedAt,
      bridgePid,
      bridge: { enabled: bridge.enabled, allow: bridge.allow },
      tools: detail,
      switching,
      pendingCalls: pending.size,
      restarts,
      lastSwitchAt,
      lastRestartReason,
    }))
  }

  // ---- child writes -------------------------------------------------------------------------
  function writeChildLine(line) {
    try {
      if (!child || !child.stdin || child.stdin.destroyed) throw new Error('no child stdin')
      child.stdin.write(line)
      return true
    } catch (error) {
      logError('cannot write to the MCP child', error)
      return false
    }
  }

  function forwardEntry(entry) {
    if (!entry) return
    if (!child || !childReady || !child.stdin) {
      queued.push(entry)
      return
    }
    const message = entry.message
    if (message === undefined) {
      // Unparsed client line: forward it verbatim (never swallow protocol data).
      writeChildLine(`${entry.line}\n`)
      return
    }
    if (message && typeof message === 'object' && hasOwn(message, 'id') && typeof message.method === 'string') {
      const key = idKey(message.id)
      suppressed.delete(key)
      pending.set(key, entry)
    }
    writeChildLine(`${JSON.stringify(message)}\n`)
  }

  function answerWithoutChild(entry, code, text) {
    const message = entry && entry.message
    if (!message || typeof message !== 'object' || !hasOwn(message, 'id')) return
    sendToClient({ jsonrpc: '2.0', id: message.id, error: { code, message: text } })
  }

  function failsafeQueued(code, text) {
    const items = replayEntries.concat(queued)
    replayEntries = []
    queued = []
    for (const entry of items) {
      try { answerWithoutChild(entry, code, text) } catch (error) { logError('cannot answer queued request', error) }
    }
  }

  // ---- child stdout -> client ---------------------------------------------------------------
  function noteAnswered() {
    if (drainResolver && pending.size === 0) drainResolver()
  }

  function onChildMessage(message) {
    if (!message || typeof message !== 'object') {
      sendToClient(message)
      return
    }
    const key = hasOwn(message, 'id') ? idKey(message.id) : null

    if (isInternalId(message.id)) {
      // Internal handshake traffic: filtered here and never forwarded to DSH.
      if (key && internalWaiters.has(key)) {
        const waiter = internalWaiters.get(key)
        if (message.result && Array.isArray(message.result.tools)) applyToolsFilter(message.result.tools)
        waiter.resolve(message)
      } else {
        log(`dropping late internal response ${String(message.id)}`)
      }
      return
    }

    // bridge.json filtering (enabled + allow globs) for every client-visible tools/list.
    const isToolList = Boolean(message.result && Array.isArray(message.result.tools))
    if (isToolList) {
      message.result.tools = applyToolsFilter(message.result.tools)
    }

    if (key && pending.has(key)) {
      pending.delete(key)
      suppressed.delete(key)
      // Persist before handing the answer to DSH so the state file is never behind a response the
      // Host/Web UI could already react to (pendingCalls, tools, mode).
      persistState()
      sendToClient(message)
      noteAnswered()
      return
    }
    if (key && suppressed.has(key)) {
      // The call outlived the drain window and was replayed with the same id; a late answer from
      // the old child must not become a second response for that id.
      log(`dropping late response for replayed id ${String(message.id)}`)
      return
    }
    if (isToolList) persistState()
    sendToClient(message)
  }

  function attachChild(target, generation) {
    let buffer = ''
    target.stdout.setEncoding('utf8')
    target.stdout.on('data', (chunk) => {
      try {
        buffer += chunk
        let index
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (!line.trim()) continue
          if (generation !== activeGeneration) continue
          let message
          try {
            message = JSON.parse(line)
          } catch {
            sendRawToClient(line)
            continue
          }
          try { onChildMessage(message) } catch (error) { logError('child message handler', error) }
        }
      } catch (error) {
        logError('child stdout handler', error)
      }
    })
    target.stderr.on('data', (chunk) => { try { process.stderr.write(chunk) } catch { /* ignore */ } })
    target.stdin.on('error', () => { /* the exit handler deals with a broken child */ })
    target.on('error', (error) => { if (generation === activeGeneration) logError('MCP child error', error) })
    target.on('exit', (code, signal) => {
      try {
        if (generation !== activeGeneration) return
        log(`MCP child exited code=${code} signal=${signal}`)
        if (shuttingDown || switching || starting) return
        // The child died on its own: keep the bridge alive, hand the outstanding calls to the
        // replay path (their answers will never arrive) and bring a child back.
        child = null
        childReady = false
        for (const [key, entry] of pending) {
          suppressed.add(key)
          replayEntries.push(entry)
        }
        pending.clear()
        persistState()
        scheduleRecovery(0)
      } catch (error) {
        logError('child exit handler', error)
      }
    })
  }

  // ---- spawn + internal handshake -----------------------------------------------------------
  function childEnv() {
    return Object.assign({}, process.env, launcherEnv)
  }

  function spawnAttempt(target) {
    return new Promise((resolve, reject) => {
      let spawned
      try {
        spawned = spawn(cli, argvFor(target), {
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
          env: childEnv(),
        })
      } catch (error) {
        reject(error)
        return
      }
      const onSpawn = () => { cleanup(); resolve(spawned) }
      const onError = (error) => { cleanup(); reject(error) }
      const cleanup = () => {
        spawned.removeListener('spawn', onSpawn)
        spawned.removeListener('error', onError)
      }
      spawned.once('spawn', onSpawn)
      spawned.once('error', onError)
    })
  }

  function nextInternalId() {
    internalSeq += 1
    return `${INTERNAL_ID_PREFIX}${internalSeq}`
  }

  function internalRequest(target, message, timeoutMs) {
    const key = idKey(message.id)
    return new Promise((resolve, reject) => {
      const waiter = { resolve: null, reject: null, timer: null, onExit: null }
      const finish = (fn, value) => {
        if (!internalWaiters.has(key)) return
        internalWaiters.delete(key)
        if (waiter.timer) clearTimeout(waiter.timer)
        if (waiter.onExit) target.removeListener('exit', waiter.onExit)
        fn(value)
      }
      waiter.resolve = (response) => finish(resolve, response)
      waiter.reject = (error) => finish(reject, error)
      waiter.timer = setTimeout(() => {
        waiter.reject(new Error(`timed out waiting for the internal ${message.method} response`))
      }, timeoutMs)
      waiter.onExit = () => waiter.reject(new Error(`the MCP child exited during internal ${message.method}`))
      internalWaiters.set(key, waiter)
      target.once('exit', waiter.onExit)
      try {
        target.stdin.write(`${JSON.stringify(message)}\n`)
      } catch (error) {
        waiter.reject(error)
      }
    })
  }

  async function handshakeNewChild(target) {
    const initializeId = nextInternalId()
    const initialized = await internalRequest(target, {
      jsonrpc: '2.0',
      id: initializeId,
      method: 'initialize',
      params: {
        protocolVersion: INTERNAL_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: INTERNAL_CLIENT_INFO,
      },
    }, HANDSHAKE_TIMEOUT_MS)
    if (!initialized || !initialized.result) throw new Error('internal initialize returned no result')
    try {
      target.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    } catch (error) {
      throw new Error(`cannot send notifications/initialized: ${error && error.message ? error.message : error}`)
    }
    // Best effort: this only refreshes total/visible; the handshake itself already succeeded.
    try {
      const listId = nextInternalId()
      const response = await internalRequest(target, {
        jsonrpc: '2.0',
        id: listId,
        method: 'tools/list',
        params: {},
      }, HANDSHAKE_TIMEOUT_MS)
      if (response && response.result && Array.isArray(response.result.tools)) {
        applyToolsFilter(response.result.tools)
      }
    } catch (error) {
      logError('internal tools/list after handshake failed (counts may be stale)', error)
    }
  }

  function killChildProcess(target) {
    return new Promise((resolve) => {
      if (!target) { resolve(); return }
      // Already gone (e.g. it died during the handshake): no exit event will fire again.
      if (target.exitCode !== null || target.signalCode !== null) { resolve(); return }
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(second)
        clearTimeout(hard)
        clearTimeout(guard)
        resolve()
      }
      target.once('exit', finish)
      try { target.kill('SIGTERM') } catch { /* already gone */ }
      // craft-anything-cli ignores the FIRST SIGTERM on purpose and exits on the second; SIGKILL
      // follows, and after the guard we simply stop waiting. The guard must never kill the bridge.
      const second = setTimeout(() => { try { target.kill('SIGTERM') } catch { /* already gone */ } }, SECOND_SIGTERM_MS)
      const hard = setTimeout(() => { try { target.kill('SIGKILL') } catch { /* already gone */ } }, SIGKILL_AT_MS)
      const guard = setTimeout(() => {
        log('the old MCP child did not exit within the kill guard; continuing anyway')
        finish()
      }, KILL_GUARD_MS)
      if (second.unref) second.unref()
      if (hard.unref) hard.unref()
      if (guard.unref) guard.unref()
    })
  }

  async function spawnWithRetry(target, wantHandshake) {
    const attempts = SPAWN_BACKOFF_MS.length + 1
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (shuttingDown) return false
      let spawned = null
      try {
        spawned = await spawnAttempt(target)
        activeGeneration += 1
        const generation = activeGeneration
        child = spawned
        childReady = false
        childArgv = argvFor(target)
        attachChild(spawned, generation)
        if (wantHandshake) await handshakeNewChild(spawned)
        childReady = true
        currentMode = target
        persistState()
        log(`MCP child ready mode=${target} pid=${spawned.pid}`)
        return true
      } catch (error) {
        logError(`spawn attempt ${attempt + 1}/${attempts} for ${target} failed`, error)
        const dead = child
        child = null
        childReady = false
        if (dead) await killChildProcess(dead)
        if (attempt < attempts - 1 && !shuttingDown) await sleep(SPAWN_BACKOFF_MS[attempt])
      }
    }
    return false
  }

  // ---- drain --------------------------------------------------------------------------------
  function drainDuration() {
    const raw = Number(process.env.CRAFT_ANYTHING_DRAIN_MS)
    if (!Number.isFinite(raw)) return DEFAULT_DRAIN_MS
    return Math.min(MAX_DRAIN_MS, Math.max(MIN_DRAIN_MS, Math.floor(raw)))
  }

  function drainPending() {
    return new Promise((resolve) => {
      if (pending.size === 0) { resolve(); return }
      const limit = drainDuration()
      let finished = false
      const finish = (timedOut) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        drainResolver = null
        if (timedOut && pending.size > 0) {
          // Same ids are replayed to the new child so DSH still gets the real answer. See the
          // double-execution risk in the header comment.
          for (const [key, entry] of pending) {
            suppressed.add(key)
            replayEntries.push(entry)
          }
          pending.clear()
          log(`drain timeout after ${limit}ms: replaying ${replayEntries.length} unanswered request(s)`)
        }
        resolve()
      }
      const timer = setTimeout(() => finish(true), limit)
      drainResolver = () => { if (pending.size === 0) finish(false) }
      if (pending.size === 0) finish(false)
    })
  }

  // ---- switch pipeline ----------------------------------------------------------------------
  async function runSwitch(reason, target) {
    switching = true
    lastRestartReason = reason
    // Keep replayEntries: when a child died on its own its outstanding calls were already moved
    // there by the exit handler. Stale suppression is dropped because that child is gone.
    suppressed.clear()
    persistState()
    log(`switch start (${reason}) -> ${target}`)
    try {
      await drainPending()
      const oldChild = child
      child = null
      childReady = false
      if (oldChild) await killChildProcess(oldChild)
      const live = await spawnWithRetry(target, true)
      if (!live) {
        switching = false
        modeRetryNotBefore = Date.now() + FAILED_SWITCH_COOLDOWN_MS
        persistState()
        log(`switch failed (${reason}): no MCP child is running; requests get -32603 until a retry`)
        failsafeQueued(-32603, `craft-anything bridge: the MCP server is not running (${reason} restart failed)`)
        return
      }
      // Replay is synchronous, so no new client message can slip between the queue swap and the
      // list_changed notification (JS runs this block to completion).
      const items = replayEntries.concat(queued)
      replayEntries = []
      queued = []
      switching = false
      for (const entry of items) forwardEntry(entry)
      currentMode = target
      restarts += 1
      lastSwitchAt = new Date().toISOString()
      modeRetryNotBefore = 0
      sendToClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
      persistState()
      log(`switch done (${reason}) -> ${target}: replayed ${items.length} request(s)`)
    } catch (error) {
      // A bug in the switch pipeline must never kill the bridge.
      logError('switch pipeline failed', error)
      switching = false
      modeRetryNotBefore = Date.now() + FAILED_SWITCH_COOLDOWN_MS
      persistState()
      failsafeQueued(-32603, 'craft-anything bridge: internal switch error')
    }
  }

  function beginSwitch(reason, target) {
    if (shuttingDown || switching || starting) return
    if (reason === 'mode' && target === currentMode) return
    runSwitch(reason, target).catch((error) => logError('switch pipeline crashed', error))
  }

  function scheduleRecovery(delayMs) {
    if (recoveryTimer || shuttingDown) return
    const wait = typeof delayMs === 'number' ? delayMs : RECOVERY_DELAY_MS
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null
      try {
        if (shuttingDown || switching || starting || child) return
        lastRecoveryAt = Date.now()
        beginSwitch('cli', currentMode)
      } catch (error) {
        logError('recovery timer', error)
      }
    }, wait)
    if (recoveryTimer.unref) recoveryTimer.unref()
  }

  // ---- client input -------------------------------------------------------------------------
  function handleClientMessage(message, line) {
    if (!message || typeof message !== 'object') {
      forwardEntry({ line, message: undefined })
      return
    }
    // bridge.json denies a tool immediately, whether or not a child is live.
    if (message.method === 'tools/call' && message.params && typeof message.params.name === 'string' && !allowed(message.params.name)) {
      sendToClient({
        jsonrpc: '2.0',
        id: message.id === undefined ? null : message.id,
        error: {
          code: -32601,
          message: `craft-anything bridge: tool "${message.params.name}" is not enabled in bridge.json`,
        },
      })
      return
    }
    const entry = { line, message }

    if (switching || starting) {
      // Queued, never failed and never answered with an error: they are replayed in order once the
      // new child is ready (see runSwitch).
      queued.push(entry)
      persistState()
      return
    }
    if (!child || !childReady) {
      // No child at all (spawn failed / between recoveries): answer requests with -32603 instead of
      // hanging forever, and try to bring a child back in the background.
      if (hasOwn(message, 'id') && typeof message.method === 'string') {
        answerWithoutChild(entry, -32603, 'craft-anything bridge: the MCP server is not running; retrying in the background')
        if (Date.now() - lastRecoveryAt > RECOVERY_DELAY_MS) scheduleRecovery(RECOVERY_DELAY_MS)
      } else {
        queued.push(entry)
      }
      return
    }
    forwardEntry(entry)
  }

  function handleClientLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      forwardEntry({ line, message: undefined })
      return
    }
    handleClientMessage(message, line)
  }

  // ---- bridge.json reconciliation -----------------------------------------------------------
  let lastBridgeJson = JSON.stringify(bridge)
  function reconcileBridge() {
    if (shuttingDown) return
    const next = readBridge(root)
    const nextJson = JSON.stringify(next)
    if (nextJson === lastBridgeJson) return
    lastBridgeJson = nextJson
    bridge = next
    matchers = compileAllow(bridge.allow)
    persistState()
    sendToClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    log(`bridge ${bridge.enabled ? 'enabled' : 'disabled'}${bridge.allow.length ? ` allow=${bridge.allow.join(',')}` : ''}`)
  }

  // ---- mode.json / mcp.restart watchers -----------------------------------------------------
  function readModeFile() {
    try {
      const parsed = JSON.parse(fs.readFileSync(modeFile, 'utf8'))
      return normalizeMode(parsed && parsed.mode)
    } catch {
      return 'clean'
    }
  }

  function checkModeFile() {
    if (shuttingDown || switching || starting) return
    if (Date.now() < modeRetryNotBefore) return
    const wanted = readModeFile()
    if (wanted === currentMode) return
    beginSwitch('mode', wanted)
  }

  function checkRestartFile() {
    if (shuttingDown || switching || starting || restartTimer) return
    let stat
    try {
      stat = fs.statSync(restartFile)
    } catch {
      return
    }
    const mtime = stat.mtimeMs
    // Only a marker newer than this bridge run (a fresh CLI install) triggers a restart, and only
    // once per marker mtime, so the file left on disk cannot loop.
    if (!(mtime > bridgeStartedAtMs) || mtime <= lastRestartMtime) return
    lastRestartMtime = mtime
    restartTimer = setTimeout(() => {
      restartTimer = null
      try {
        if (shuttingDown || switching || starting || !child) return
        beginSwitch('cli', currentMode)
      } catch (error) {
        logError('restart timer', error)
      }
    }, RESTART_DEBOUNCE_MS)
    if (restartTimer.unref) restartTimer.unref()
  }

  // ---- timers -------------------------------------------------------------------------------
  const poll = setInterval(() => {
    try { reconcileBridge() } catch (error) { logError('bridge.json poll', error) }
    try { checkModeFile() } catch (error) { logError('mode.json poll', error) }
    try { checkRestartFile() } catch (error) { logError('mcp.restart poll', error) }
    try { if (switching) persistState() } catch (error) { logError('state poll', error) }
  }, POLL_MS)
  if (poll.unref) poll.unref()

  // fs.watch only shortens the reaction time; the poll above stays authoritative because a watched
  // path can be replaced (write-then-rename) and the watch silently stops. Watching the *root*
  // directory instead of three files also survives a marker file that does not exist yet, and the
  // filename filter keeps our own mcp.state.json writes from waking the bridge up.
  let watcher = null
  try {
    watcher = fs.watch(root, { persistent: false }, (eventType, filename) => {
      try {
        const name = filename === null || filename === undefined ? '' : String(filename)
        if (!name || name === MODE_FILE) checkModeFile()
        if (!name || name === RESTART_FILE) checkRestartFile()
        if (!name || name === BRIDGE_FILE) reconcileBridge()
      } catch (error) {
        logError('root watch handler', error)
      }
    })
    if (watcher.unref) watcher.unref()
  } catch { /* polling covers it */ }
  if (watcher) process.on('exit', () => { try { watcher.close() } catch { /* ignore */ } })

  // ---- shutdown -----------------------------------------------------------------------------
  function shutdown() {
    if (shuttingDown) return
    shuttingDown = true
    switching = false
    persistState()
    try { clearInterval(poll) } catch { /* ignore */ }
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
    if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null }
    const target = child
    child = null
    childReady = false
    // Teardown stays paranoid (the macOS "install and DSH hangs" fix) but now exits the bridge
    // only because DSH closed stdin or sent a signal.
    if (!target) { process.exit(0); return }
    target.once('exit', () => process.exit(0))
    try { target.kill('SIGTERM') } catch { /* already gone */ }
    setTimeout(() => { try { target.kill('SIGTERM') } catch { /* already gone */ } }, SECOND_SIGTERM_MS)
    setTimeout(() => { try { target.kill('SIGKILL') } catch { /* already gone */ } }, SIGKILL_AT_MS)
    const final = setTimeout(() => process.exit(0), KILL_GUARD_MS)
    if (final.unref) final.unref()
  }

  // ---- stdin --------------------------------------------------------------------------------
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    try {
      clientBuffer += chunk
      let index
      while ((index = clientBuffer.indexOf('\n')) >= 0) {
        const line = clientBuffer.slice(0, index)
        clientBuffer = clientBuffer.slice(index + 1)
        if (!line.trim()) continue
        try { handleClientLine(line) } catch (error) { logError('client message handler', error) }
      }
    } catch (error) {
      logError('stdin handler', error)
    }
  })
  process.stdin.on('end', () => { try { shutdown() } catch (error) { logError('stdin end', error) } })
  process.stdin.on('close', () => { try { shutdown() } catch (error) { logError('stdin close', error) } })
  process.stdin.resume()

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => { try { shutdown() } catch (error) { logError('signal handler', error) } })
  }
  // The bridge is the MCP server for the whole DSH session: an unexpected exception must be logged
  // and survived, never turned into a disconnect.
  process.on('uncaughtException', (error) => logError('uncaught exception (staying alive)', error))
  process.on('unhandledRejection', (reason) => logError('unhandled rejection (staying alive)', reason))

  // ---- initial child ------------------------------------------------------------------------
  persistState()
  spawnWithRetry(currentMode, false).then((live) => {
    starting = false
    if (!live) {
      log('initial MCP child could not be started; requests get -32603 until a retry')
      modeRetryNotBefore = Date.now() + FAILED_SWITCH_COOLDOWN_MS
      persistState()
      failsafeQueued(-32603, 'craft-anything bridge: the MCP server is not running (initial start failed)')
      return
    }
    // DSH does its own initialize against the first child (unchanged from v0.4.0); only requests
    // that arrived while it was spawning are replayed here.
    const items = queued
    queued = []
    for (const entry of items) forwardEntry(entry)
    persistState()
  }).catch((error) => {
    starting = false
    logError('initial spawn pipeline failed', error)
    failsafeQueued(-32603, 'craft-anything bridge: the MCP server is not running (initial start failed)')
  })
}

module.exports = { start, readBridge, compileAllow, BRIDGE_FILE, STATE_FILE }
