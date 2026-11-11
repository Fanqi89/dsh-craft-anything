'use strict'
// End-to-end tests for scripts/mcp-bridge.cjs.
//
//   node tests/bridge/run.cjs
//
// The runner spawns `node -e "require('<repo>/scripts/mcp-bridge.cjs').start({...})"` with pipes,
// acts as DSH (line-framed JSON-RPC on stdin/stdout), and uses tests/bridge/fake-mcp-server.cjs as
// the CLI child. Every artifact lives under %TEMP%\craft-bridge-test (removed before each run), so
// nothing in the real install (…\.dsh\plugins-data\craft-anything) is touched.
//
// It prints one PASS/FAIL line per assertion and a summary; exit code is non-zero on any failure.

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const REPO = path.resolve(__dirname, '..', '..')
const BRIDGE_PATH = path.join(REPO, 'scripts', 'mcp-bridge.cjs')
const FAKE_PATH = path.join(__dirname, 'fake-mcp-server.cjs')
const ROOT = path.join(os.tmpdir(), 'craft-bridge-test')

let passed = 0
const failures = []
const bridges = []

function check(label, ok, evidence) {
  if (ok) {
    passed += 1
    console.log(`PASS ${label}`)
    return
  }
  failures.push(label)
  console.log(`FAIL ${label}${evidence ? ` — ${evidence}` : ''}`)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, probe, options = {}) {
  const timeout = options.timeout || 10000
  const interval = options.interval || 40
  const deadline = Date.now() + timeout
  for (;;) {
    let value
    try {
      value = await probe()
    } catch {
      value = null
    }
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label} (${timeout}ms)`)
    await sleep(interval)
  }
}

function count(haystack, needle) {
  return haystack.split(needle).length - 1
}

/** The DSH side of the stdio link: a tiny JSON-RPC client talking to the bridge process. */
class Bridge {
  constructor(root, extraEnv, overrides) {
    this.root = root
    this.messages = [] // every message the bridge sent to "DSH"
    this.notifications = []
    this.listeners = []
    this.waiters = new Map()
    this.nextId = 0
    this.stderr = ''
    this.stdoutJunk = []

    const options = Object.assign({
      cli: process.execPath,
      root,
      mode: 'clean',
      argv: [FAKE_PATH, '--clean-room'],
      env: {},
      meta: {},
    }, overrides || {})
    const boot = `require(${JSON.stringify(BRIDGE_PATH)}).start(${JSON.stringify(options)})`
    this.proc = spawn(process.execPath, ['-e', boot], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: Object.assign({}, process.env, extraEnv || {}),
    })

    let buffer = ''
    this.proc.stdout.setEncoding('utf8')
    this.proc.stdout.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          this.stdoutJunk.push(line)
          continue
        }
        this.onMessage(message)
      }
    })
    this.proc.stderr.setEncoding('utf8')
    this.proc.stderr.on('data', (chunk) => {
      this.stderr += chunk
    })
  }

  onMessage(message) {
    this.messages.push(message)
    if (message && typeof message === 'object' && message.id !== undefined) {
      const waiter = this.waiters.get(message.id)
      if (waiter) {
        this.waiters.delete(message.id)
        waiter(message)
        return
      }
    }
    if (message && typeof message === 'object' && typeof message.method === 'string') {
      this.notifications.push(message)
      for (const listener of this.listeners.slice()) {
        try {
          listener(message)
        } catch { /* ignore */ }
      }
    }
  }

  request(method, params, timeoutMs = 20000) {
    const id = ++this.nextId
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id)
        reject(new Error(`timeout waiting for ${method} (id ${id})`))
      }, timeoutMs)
      this.waiters.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) {
          const error = new Error(`${method}: ${message.error.message}`)
          error.rpcError = message.error
          reject(error)
          return
        }
        resolve(message.result)
      })
      try {
        this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
      } catch (error) {
        this.waiters.delete(id)
        clearTimeout(timer)
        reject(error)
      }
    })
    promise.id = id
    return promise
  }

  notify(method, params) {
    try {
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`)
    } catch { /* ignore */ }
  }

  waitNotification(method, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timeout waiting for notification ${method}`))
      }, timeoutMs)
      const listener = (message) => {
        if (message.method === method) {
          cleanup()
          resolve(message)
        }
      }
      const cleanup = () => {
        clearTimeout(timer)
        const index = this.listeners.indexOf(listener)
        if (index >= 0) this.listeners.splice(index, 1)
      }
      this.listeners.push(listener)
    })
  }

  writeMode(mode) {
    fs.mkdirSync(this.root, { recursive: true })
    fs.writeFileSync(path.join(this.root, 'mode.json'), `${JSON.stringify({ mode, changedAt: new Date().toISOString() })}\n`)
  }

  writeBridge(value) {
    fs.mkdirSync(this.root, { recursive: true })
    fs.writeFileSync(path.join(this.root, 'bridge.json'), `${JSON.stringify(value)}\n`)
  }

  touchRestart() {
    fs.mkdirSync(this.root, { recursive: true })
    fs.writeFileSync(path.join(this.root, 'mcp.restart'), `${Date.now()}\n`)
  }

  state() {
    const file = path.join(this.root, 'mcp.state.json')
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch {
        // Tolerate a read that lands exactly between write and rename on a slow filesystem.
        try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20) } catch { /* ignore */ }
      }
    }
    return null
  }

  alive() {
    return this.proc.exitCode === null && !this.proc.killed
  }

  async stop() {
    if (this.proc.exitCode !== null) return this.proc.exitCode
    const exited = new Promise((resolve) => this.proc.once('exit', (code) => resolve(code)))
    try {
      this.proc.stdin.end()
    } catch { /* ignore */ }
    const timer = setTimeout(() => {
      try {
        this.proc.kill('SIGKILL')
      } catch { /* ignore */ }
    }, 10000)
    const code = await exited
    clearTimeout(timer)
    return code
  }
}

async function main() {
  fs.rmSync(ROOT, { recursive: true, force: true })
  fs.mkdirSync(ROOT, { recursive: true })
  console.log(`bridge: ${BRIDGE_PATH}`)
  console.log(`fake:   ${FAKE_PATH}`)
  console.log(`root:   ${ROOT}`)
  console.log('')

  const bridge = new Bridge(ROOT, {})
  bridges.push(bridge)

  // ---- startup -----------------------------------------------------------------------------
  await bridge.request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bridge-test-harness', version: '1.0.0' },
  })
  bridge.notify('notifications/initialized')
  const initialList = await bridge.request('tools/list', {})
  const initialNames = Array.isArray(initialList.tools) ? initialList.tools.map((tool) => tool.name) : []
  check('initial tools/list returns the 3 fake tools', initialNames.length === 3, JSON.stringify(initialNames))

  const initialPid = bridge.proc.pid
  let state = bridge.state()
  check(
    'mcp.state.json keeps the pre-existing fields',
    Boolean(state)
      && state.cli === process.execPath
      && state.mode === 'clean'
      && typeof state.startedAt === 'string'
      && typeof state.pid === 'number'
      && Array.isArray(state.args)
      && state.bridge && state.bridge.enabled === true && Array.isArray(state.bridge.allow)
      && state.tools && state.tools.total === 3 && state.tools.visible === 3,
    JSON.stringify(state),
  )
  check(
    'mcp.state.json adds switching / pendingCalls / restarts / lastSwitchAt / lastRestartReason',
    Boolean(state)
      && state.switching === false
      && state.pendingCalls === 0
      && state.restarts === 0
      && state.lastSwitchAt === null
      && state.lastRestartReason === null
      && state.bridgePid === initialPid,
    JSON.stringify({
      switching: state && state.switching,
      pendingCalls: state && state.pendingCalls,
      restarts: state && state.restarts,
      lastSwitchAt: state && state.lastSwitchAt,
      lastRestartReason: state && state.lastRestartReason,
      bridgePid: state && state.bridgePid,
    }),
  )

  // ---- (a) in-flight call across a mode change ---------------------------------------------
  const inFlight = bridge.request('tools/call', { name: 'core_alpha', arguments: { _delayMs: 1500 } })
  await sleep(200)
  bridge.writeMode('deep')

  let draining = null
  try {
    draining = await waitFor('drain window', () => {
      const current = bridge.state()
      return current && current.switching === true && current.pendingCalls === 1 ? current : null
    }, { timeout: 3000, interval: 30 })
  } catch { /* recorded below */ }
  check(
    'while draining, state shows switching=true and pendingCalls=1',
    Boolean(draining),
    draining ? JSON.stringify({ switching: draining.switching, pendingCalls: draining.pendingCalls }) : 'not observed',
  )

  // A request that arrives *during* the switch must be queued (not failed, not error-answered).
  const duringSwitch = bridge.request('tools/call', { name: 'core_beta', arguments: {} }, 20000)

  const inFlightResult = await inFlight
  const inFlightPayload = JSON.parse(inFlightResult.content[0].text)
  check(
    'in-flight tools/call still returns its result across the mode change',
    inFlightPayload.mode === 'clean',
    JSON.stringify(inFlightPayload),
  )
  check('bridge process never exited (same pid)', bridge.alive() && bridge.proc.pid === initialPid, `alive=${bridge.alive()} pid=${bridge.proc.pid}`)

  const duringPayload = JSON.parse((await duringSwitch).content[0].text)
  check(
    'a request arriving during the switch is queued and replayed, not failed',
    duringPayload.mode === 'deep',
    JSON.stringify(duringPayload),
  )

  await waitFor('switch to deep', () => {
    const current = bridge.state()
    return current && current.mode === 'deep' && current.switching === false ? current : null
  }, { timeout: 8000 })
  await sleep(150)
  state = bridge.state()
  check('the new child was started with --deep', count(bridge.stderr, '[fake] start mode=deep') >= 1, `deepStarts=${count(bridge.stderr, '[fake] start mode=deep')}`)
  check(
    'state reports mode=deep with reason "mode" and a lastSwitchAt timestamp',
    state.mode === 'deep' && state.lastRestartReason === 'mode' && typeof state.lastSwitchAt === 'string',
    JSON.stringify({ mode: state.mode, lastRestartReason: state.lastRestartReason, lastSwitchAt: state.lastSwitchAt }),
  )

  const afterSwitch = await bridge.request('tools/call', { name: 'core_alpha', arguments: {} })
  check(
    'calls after the switch are served by the new child',
    JSON.parse(afterSwitch.content[0].text).mode === 'deep',
    afterSwitch.content[0].text,
  )

  // ---- (c) back to --clean-room, (e) fast when nothing is in flight ------------------------
  const cleanStartsBefore = count(bridge.stderr, '[fake] start mode=clean')
  const switchStartedAt = Date.now()
  bridge.writeMode('clean')
  await waitFor('switch back to clean', () => {
    const current = bridge.state()
    return current && current.mode === 'clean' && current.switching === false ? current : null
  }, { timeout: 8000 })
  const switchElapsed = Date.now() - switchStartedAt
  console.log(`     (mode.json -> new child serving again: ${switchElapsed}ms)`)
  check('mode switch with no in-flight calls is fast (<2s)', switchElapsed < 2000, `${switchElapsed}ms`)
  await sleep(150)
  check(
    'the new child was started with --clean-room',
    count(bridge.stderr, '[fake] start mode=clean') > cleanStartsBefore,
    `cleanStarts ${cleanStartsBefore} -> ${count(bridge.stderr, '[fake] start mode=clean')}`,
  )
  check('bridge pid unchanged after two mode switches', bridge.proc.pid === initialPid && bridge.alive())

  // ---- (d) bridge.json allowlist / enabled -------------------------------------------------
  bridge.writeBridge({ enabled: true, allow: ['core_*'] })
  await bridge.waitNotification('notifications/tools/list_changed', 8000)
  const filteredList = await bridge.request('tools/list', {})
  const filteredNames = filteredList.tools.map((tool) => tool.name).sort()
  check(
    'bridge.json allow filters tools/list',
    JSON.stringify(filteredNames) === JSON.stringify(['core_alpha', 'core_beta']),
    JSON.stringify(filteredNames),
  )
  state = bridge.state()
  check('state.tools reflects the allow filter (total 3, visible 2)', state.tools && state.tools.total === 3 && state.tools.visible === 2, JSON.stringify(state.tools))

  // Requirement 6: the *internal* tools/list of the new child must be filtered as well. Switch mode
  // while the allowlist is active and read the counters the bridge's own handshake wrote.
  bridge.writeMode('deep')
  await waitFor('deep with the allowlist active', () => {
    const current = bridge.state()
    return current && current.mode === 'deep' && current.switching === false ? current : null
  }, { timeout: 8000 })
  state = bridge.state()
  check(
    'the internal tools/list after a switch is filtered too (visible 2 of 3)',
    state.tools && state.tools.total === 3 && state.tools.visible === 2,
    JSON.stringify(state.tools),
  )
  bridge.writeMode('clean')
  await waitFor('clean with the allowlist active', () => {
    const current = bridge.state()
    return current && current.mode === 'clean' && current.switching === false ? current : null
  }, { timeout: 8000 })

  let denied = null
  try {
    await bridge.request('tools/call', { name: 'other_gamma', arguments: {} })
  } catch (error) {
    denied = error
  }
  check(
    'tools/call for a filtered-out tool is denied with -32601',
    Boolean(denied && denied.rpcError && denied.rpcError.code === -32601),
    denied ? JSON.stringify(denied.rpcError) : 'no error',
  )

  bridge.writeBridge({ enabled: false })
  await bridge.waitNotification('notifications/tools/list_changed', 8000)
  const emptyList = await bridge.request('tools/list', {})
  check('bridge.json enabled=false empties tools/list', Array.isArray(emptyList.tools) && emptyList.tools.length === 0, String(emptyList.tools && emptyList.tools.length))

  let deniedDisabled = null
  try {
    await bridge.request('tools/call', { name: 'core_alpha', arguments: {} })
  } catch (error) {
    deniedDisabled = error
  }
  check(
    'bridge.json enabled=false denies tools/call',
    Boolean(deniedDisabled && deniedDisabled.rpcError && deniedDisabled.rpcError.code === -32601),
    deniedDisabled ? JSON.stringify(deniedDisabled.rpcError) : 'no error',
  )

  bridge.writeBridge({ enabled: true, allow: [] })
  await bridge.waitNotification('notifications/tools/list_changed', 8000)
  const restoredList = await bridge.request('tools/list', {})
  check('bridge.json restored to all 3 tools', restoredList.tools.length === 3, String(restoredList.tools.length))

  // ---- (f) mcp.restart restarts the child with the same mode --------------------------------
  const restartsBefore = bridge.state().restarts
  const cleanStartsBeforeRestart = count(bridge.stderr, '[fake] start mode=clean')
  bridge.touchRestart()
  await waitFor('mcp.restart to be handled', () => {
    const current = bridge.state()
    return current && current.restarts > restartsBefore ? current : null
  }, { timeout: 10000 })
  await sleep(150)
  state = bridge.state()
  check('mcp.restart restarts the child (restarts counter grows)', state.restarts > restartsBefore, `restarts ${restartsBefore} -> ${state.restarts}`)
  check('mcp.restart is recorded as reason "cli"', state.lastRestartReason === 'cli', String(state.lastRestartReason))
  check('mcp.restart keeps the same mode', state.mode === 'clean', String(state.mode))
  check(
    'the restarted child was started with the same mode flag',
    count(bridge.stderr, '[fake] start mode=clean') > cleanStartsBeforeRestart,
    `cleanStarts ${cleanStartsBeforeRestart} -> ${count(bridge.stderr, '[fake] start mode=clean')}`,
  )
  check('bridge pid unchanged across a CLI restart', bridge.proc.pid === initialPid && bridge.alive())

  // ---- (g) DSH never sees bridge-internal traffic ------------------------------------------
  const stringIds = bridge.messages.filter((message) => message && typeof message === 'object' && typeof message.id === 'string')
  check('DSH side never received a bridge-internal id', stringIds.length === 0, JSON.stringify(stringIds.map((message) => message.id)))
  const initializeResponses = bridge.messages.filter((message) => message && message.result && typeof message.result.protocolVersion === 'string')
  check('DSH side received exactly one initialize response', initializeResponses.length === 1, `count=${initializeResponses.length}`)
  const listChangedCount = bridge.notifications.filter((message) => message.method === 'notifications/tools/list_changed').length
  check('list_changed was emitted for mode switches and bridge.json changes', listChangedCount >= 5, `count=${listChangedCount}`)
  const numericIds = bridge.messages.filter((message) => message && typeof message.id === 'number').map((message) => message.id)
  const duplicateIds = numericIds.filter((id, index) => numericIds.indexOf(id) !== index)
  check('no JSON-RPC id was answered twice', duplicateIds.length === 0, JSON.stringify(duplicateIds))
  check('the bridge wrote only JSON lines to stdout (no protocol junk)', bridge.stdoutJunk.length === 0, JSON.stringify(bridge.stdoutJunk.slice(0, 3)))

  const firstExit = await bridge.stop()
  check('bridge exits 0 on stdin EOF (the only stop reason)', firstExit === 0, `code=${firstExit}`)

  // ---- (h) drain timeout: an unanswered call is replayed with the same id -------------------
  const timedRoot = path.join(ROOT, 'drain-timeout')
  const timed = new Bridge(timedRoot, { CRAFT_ANYTHING_DRAIN_MS: '1000' })
  bridges.push(timed)
  await timed.request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bridge-test-harness', version: '1.0.0' } })
  timed.notify('notifications/initialized')
  await timed.request('tools/list', {})

  const slow = timed.request('tools/call', { name: 'core_alpha', arguments: { _delayMs: 1500 } }, 25000)
  const slowId = slow.id
  await sleep(100)
  timed.writeMode('deep')
  const slowPayload = JSON.parse((await slow).content[0].text)
  check(
    'a call slower than CRAFT_ANYTHING_DRAIN_MS is replayed and answered by the new child',
    slowPayload.mode === 'deep',
    JSON.stringify(slowPayload),
  )
  const slowAnswers = timed.messages.filter((message) => message && message.id === slowId)
  check('the replayed call is answered exactly once', slowAnswers.length === 1, `count=${slowAnswers.length}`)
  const timedState = timed.state()
  check('the drain-timeout bridge stayed alive with the same pid', timed.alive() && timedState && timedState.bridgePid === timed.proc.pid)
  check('the drain-timeout bridge recorded the switch', Boolean(timedState && timedState.mode === 'deep' && timedState.lastRestartReason === 'mode'), JSON.stringify(timedState && { mode: timedState.mode, lastRestartReason: timedState.lastRestartReason }))
  const timedExit = await timed.stop()
  check('the drain-timeout bridge exits 0 on stdin EOF', timedExit === 0, `code=${timedExit}`)

  // ---- no startable child: -32603 instead of hanging forever --------------------------------
  // Every spawn attempt fails (node starts for a missing script and exits at once, and the initial
  // child dies right after the spawn event), so the bridge walks its 8 attempts with backoff.
  const brokenRoot = path.join(ROOT, 'no-child')
  const broken = new Bridge(brokenRoot, {}, { argv: [path.join(__dirname, 'missing-fake.cjs'), '--clean-room'] })
  bridges.push(broken)
  const brokenStartedAt = Date.now()
  let unavailableError = null
  try {
    await broken.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'bridge-test-harness', version: '1.0.0' },
    }, 60000)
  } catch (error) {
    unavailableError = error
  }
  const brokenElapsed = Date.now() - brokenStartedAt
  check(
    'with no startable child, a request gets a -32603 error instead of hanging forever',
    Boolean(unavailableError && unavailableError.rpcError && unavailableError.rpcError.code === -32603),
    unavailableError ? `${unavailableError.message} after ${brokenElapsed}ms` : 'no error',
  )
  check('the bridge retried the spawn with backoff before giving up (>=5s)', brokenElapsed >= 5000, `${brokenElapsed}ms`)
  const brokenState = broken.state()
  check(
    'the bridge process stays alive with no child (stdin EOF is the only stop reason)',
    broken.alive() && Boolean(brokenState) && brokenState.pid === null,
    JSON.stringify(brokenState && { pid: brokenState.pid, switching: brokenState.switching }),
  )
  const fastFailStartedAt = Date.now()
  let secondError = null
  try {
    await broken.request('tools/call', { name: 'core_alpha', arguments: {} }, 5000)
  } catch (error) {
    secondError = error
  }
  const fastFailElapsed = Date.now() - fastFailStartedAt
  check(
    'a later request while no child is alive fails fast with -32603',
    Boolean(secondError && secondError.rpcError && secondError.rpcError.code === -32603) && fastFailElapsed < 3000,
    `${fastFailElapsed}ms ${secondError ? secondError.message : 'no error'}`,
  )
  const brokenExit = await broken.stop()
  check('the no-child bridge exits 0 on stdin EOF', brokenExit === 0, `code=${brokenExit}`)
}

main().then(async () => {
  for (const bridge of bridges) {
    try { await bridge.stop() } catch { /* ignore */ }
  }
  console.log('')
  console.log(`Summary: ${passed} passed, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log(`Failed: ${failures.join(', ')}`)
    process.exitCode = 1
  }
}).catch(async (error) => {
  console.log(`FAIL suite crashed — ${error && error.message ? error.message : String(error)}`)
  failures.push('suite crashed')
  for (const bridge of bridges) {
    try { await bridge.stop() } catch { /* ignore */ }
  }
  console.log('')
  console.log(`Summary: ${passed} passed, ${failures.length} failed`)
  process.exitCode = 1
})
