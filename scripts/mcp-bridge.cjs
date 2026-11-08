'use strict'
// dsh-craft-anything — MCP bridge proxy.
//
// The DSH mcp-client registers every tool a stdio MCP server lists, so a bridge with the
// Essentials toolset puts ~30 schemas in every request and `--all-tools`/deep can put 321 there.
// This proxy sits between DSH and `craft-anything-cli mcp` and lets the plugin turn tools on and
// off without restarting anything:
//
//   <root>/bridge.json   { "enabled": true, "allow": ["core_*", "session_*"] }
//     enabled=false      tools/list answers an empty list, tools/call answers an error, so DSH
//                        removes every mcp__craft__* tool from the context.
//     allow              optional glob patterns (`*` only) matched case-insensitively against the
//                        tool name; an empty list allows every tool.
//
// On a change it emits `notifications/tools/list_changed`; dsh-mcp-client subscribes to that
// notification and re-lists (its SDK handler calls refreshTools()), so the context updates in
// about a second without restarting the CLI, the bridge or the Harness. A mode change still
// restarts the CLI (clean-room/deep is fixed at startup) exactly as before.
//
// The inline launcher in cordis.patch.yml only resolves the CLI and calls start(); everything it
// does is here so it can be unit-tested with a plain `node` process.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

const BRIDGE_FILE = 'bridge.json'
const STATE_FILE = 'mcp.state.json'

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

function writeState(stateFile, patch) {
  try {
    fs.mkdirSync(path.dirname(stateFile), { recursive: true })
    fs.writeFileSync(stateFile, `${JSON.stringify(patch)}\n`)
  } catch { /* status is best effort */ }
}

/**
 * Start the proxy. Never returns until the bridge stops.
 * @param {{ cli: string, root: string, mode: string, argv: string[], env?: Record<string,string> }} options
 */
function start(options) {
  const { cli, root, mode, argv } = options
  const modeFile = path.join(root, 'mode.json')
  const bridgeFile = path.join(root, BRIDGE_FILE)
  const stateFile = path.join(root, STATE_FILE)
  const startedAt = new Date().toISOString()

  let bridge = readBridge(root)
  let matchers = compileAllow(bridge.allow)
  let stopped = false
  let killTimer = null
  let finalTimer = null
  let detail = { total: null, visible: null }

  const allowed = (name) => {
    if (!bridge.enabled) return false
    if (matchers.length === 0) return true
    return matchers.some((matcher) => matcher.test(name))
  }

  const sendToClient = (message) => {
    try { process.stdout.write(`${JSON.stringify(message)}\n`) } catch { /* client gone */ }
  }
  const meta = options.meta && typeof options.meta === 'object' ? options.meta : {}
  const persistState = () => writeState(stateFile, Object.assign({}, meta, {
    mode,
    args: argv,
    pid: child ? child.pid : null,
    startedAt,
    bridge: { enabled: bridge.enabled, allow: bridge.allow },
    tools: detail,
  }))

  let child = null
  try {
    child = spawn(cli, argv, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: Object.assign({}, process.env, options.env || {}),
    })
  } catch (error) {
    console.error(`[dsh-craft-anything] cannot start ${cli}: ${error && error.message ? error.message : error}`)
    process.exit(1)
  }

  persistState()

  // ---- client (DSH) -> CLI ------------------------------------------------------------------
  let clientBuffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    clientBuffer += chunk
    let index
    while ((index = clientBuffer.indexOf('\n')) >= 0) {
      const line = clientBuffer.slice(0, index)
      clientBuffer = clientBuffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // Not a JSON line we understand: forward it verbatim so we never swallow protocol data.
        try { child.stdin.write(`${line}\n`) } catch { /* child gone */ }
        continue
      }
      if (message && message.method === 'tools/call' && message.params && typeof message.params.name === 'string') {
        if (!allowed(message.params.name)) {
          sendToClient({
            jsonrpc: '2.0',
            id: message.id === undefined ? null : message.id,
            error: {
              code: -32601,
              message: `craft-anything bridge: tool "${message.params.name}" is not enabled in bridge.json`,
            },
          })
          continue
        }
      }
      try { child.stdin.write(`${JSON.stringify(message)}\n`) } catch { /* child gone */ }
    }
  })
  process.stdin.on('end', () => { try { child.stdin.end() } catch { /* already closed */ } })
  process.stdin.on('close', () => { try { child.stdin.end() } catch { /* already closed */ } })
  process.stdin.resume()

  // ---- CLI -> client (DSH) ------------------------------------------------------------------
  let serverBuffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    serverBuffer += chunk
    let index
    while ((index = serverBuffer.indexOf('\n')) >= 0) {
      const line = serverBuffer.slice(0, index)
      serverBuffer = serverBuffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        try { process.stdout.write(`${line}\n`) } catch { /* client gone */ }
        continue
      }
      if (message && message.result && Array.isArray(message.result.tools)) {
        const tools = message.result.tools
        detail = { total: tools.length, visible: tools.filter((tool) => tool && typeof tool.name === 'string' && allowed(tool.name)).length }
        message.result.tools = tools.filter((tool) => tool && typeof tool.name === 'string' && allowed(tool.name))
        persistState()
      }
      sendToClient(message)
    }
  })
  child.stderr.on('data', (chunk) => { try { process.stderr.write(chunk) } catch { /* ignore */ } })

  // ---- bridge.json changes: re-filter and ask DSH to re-list ---------------------------------
  let lastBridgeJson = JSON.stringify(bridge)
  const reconcile = () => {
    if (stopped) return
    const next = readBridge(root)
    const nextJson = JSON.stringify(next)
    if (nextJson === lastBridgeJson) return
    lastBridgeJson = nextJson
    bridge = next
    matchers = compileAllow(bridge.allow)
    persistState()
    sendToClient({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    console.error(`[dsh-craft-anything] bridge ${bridge.enabled ? 'enabled' : 'disabled'}${bridge.allow.length ? ` allow=${bridge.allow.join(',')}` : ''}`)
  }
  try { fs.watch(bridgeFile, { persistent: false }, reconcile) } catch { /* file may not exist yet */ }

  // ---- mode.json changes still restart the CLI ----------------------------------------------
  let startedMode = mode
  const readMode = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(modeFile, 'utf8'))
      return parsed && parsed.mode === 'deep' ? 'deep' : 'clean'
    } catch {
      return 'clean'
    }
  }
  const poll = setInterval(() => {
    reconcile()
    if (readMode() !== startedMode) stop()
  }, 1000)
  if (poll.unref) poll.unref()

  function stop() {
    if (stopped) return
    stopped = true
    try { child.kill('SIGTERM') } catch { /* already gone */ }
    setTimeout(() => { try { child.kill('SIGTERM') } catch { /* already gone */ } }, 150).unref()
    killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* already gone */ } }, 1200)
    finalTimer = setTimeout(() => process.exit(0), 2500)
    if (killTimer.unref) killTimer.unref()
    if (finalTimer.unref) finalTimer.unref()
  }

  child.on('error', (error) => {
    console.error(`[dsh-craft-anything] cannot start ${cli}: ${error && error.message ? error.message : error}`)
    process.exit(1)
  })
  child.on('exit', (code, signal) => {
    if (!stopped) process.exit(code === null ? (signal ? 1 : 0) : code)
    clearInterval(poll)
    if (killTimer) clearTimeout(killTimer)
    if (finalTimer) clearTimeout(finalTimer)
    process.exit(0)
  })

  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, stop)
}

module.exports = { start, readBridge, compileAllow, BRIDGE_FILE, STATE_FILE }
