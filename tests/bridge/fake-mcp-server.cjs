'use strict'
// Minimal stdio MCP server for tests/bridge/run.cjs.
//
// It echoes the mode flag it was started with (`--deep` / `--clean-room`) in every tools/call
// result, so the runner can prove *which* child answered a request, and it can delay a tools/call
// by CRAFT_TEST_DELAY_MS (or per call via arguments._delayMs) so a call can still be in flight
// while the bridge swaps the child.

const MODE = process.argv.includes('--deep')
  ? 'deep'
  : process.argv.includes('--clean-room')
    ? 'clean'
    : 'none'

const STARTED_AT = Date.now()
// The runner parses these lines out of the bridge's stderr to see every child the bridge spawned.
process.stderr.write(`[fake] start mode=${MODE} pid=${process.pid}\n`)

const TOOLS = [
  { name: 'core_alpha', description: 'alpha tool', inputSchema: { type: 'object' } },
  { name: 'core_beta', description: 'beta tool', inputSchema: { type: 'object' } },
  { name: 'other_gamma', description: 'gamma tool', inputSchema: { type: 'object' } },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function handle(message) {
  if (!message || typeof message !== 'object') return
  if (message.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fake-mcp', version: '1.0.0' },
      },
    })
    return
  }
  if (message.method === 'notifications/initialized') return
  if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools: TOOLS } })
    return
  }
  if (message.method === 'tools/call') {
    const params = message.params || {}
    const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {}
    const requested = Number(args._delayMs)
    const fromEnv = Number(process.env.CRAFT_TEST_DELAY_MS)
    const delay = Number.isFinite(requested) ? requested : (Number.isFinite(fromEnv) ? fromEnv : 0)
    process.stderr.write(`[fake] call name=${params.name} id=${String(message.id)} delay=${delay} mode=${MODE}\n`)
    setTimeout(() => {
      send({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          content: [{
            type: 'text',
            text: JSON.stringify({ mode: MODE, tool: params.name, pid: process.pid, startedAt: STARTED_AT }),
          }],
        },
      })
    }, Math.max(0, delay))
    return
  }
  if (message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `fake-mcp: unsupported method ${String(message.method)}` } })
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
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
      continue
    }
    handle(message)
  }
})
process.stdin.on('end', () => process.exit(0))
