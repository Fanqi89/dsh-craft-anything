// Regression for issue #2: dsh-craft-anything issue 2 reports that llama.cpp-style grammar backends
// reject the whole request when a tool inputSchema contains a boolean subschema
// (core_evidence_browse -> properties.evidence: true). The bridge must normalize those to {} while
// leaving legitimate booleans like additionalProperties: false untouched.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const bridge = path.join(repo, 'scripts', 'mcp-bridge.cjs')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-bool-schema-'))
const root = path.join(work, 'root')
fs.mkdirSync(root, { recursive: true })
fs.writeFileSync(path.join(root, 'mode.json'), JSON.stringify({ mode: 'clean' }))

const fake = path.join(work, 'fake-server.cjs')
fs.writeFileSync(fake, `
'use strict'
const readline = require('node:readline')
const send = (message) => process.stdout.write(JSON.stringify(message) + '\\n')
const tools = [
  {
    name: 'bool_schema',
    description: 'mimics core_evidence_browse: a boolean subschema inside a properties map',
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          oneOf: [
            { type: 'object', properties: { evidence_id: { type: 'string' }, kind: { const: 'saved' } }, required: ['kind', 'evidence_id'] },
            { type: 'object', properties: { evidence: true, kind: { const: 'inline' } }, required: ['kind', 'evidence'] },
          ],
        },
      },
    },
  },
  {
    name: 'ap_bool',
    description: 'additionalProperties: false must survive as a boolean',
    inputSchema: { type: 'object', additionalProperties: false, properties: { a: { type: 'string' } } },
  },
  { name: 'plain', description: 'a normal tool', inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] } },
]
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
  } else if (message.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: message.id, result: { tools } })
  } else if (message.method === 'tools/call') {
    send({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'ok' }] } })
  }
})
`)

const child = spawn(process.execPath, ['-e',
  `require(${JSON.stringify(bridge)}).start({ cli: process.execPath, root: ${JSON.stringify(root)}, mode: 'clean', argv: [${JSON.stringify(fake)}] })`,
], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
let buffer = ''
const pending = new Map()
child.stdout.setEncoding('utf8')
child.stdout.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch { continue }
    if (message && message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id); pending.delete(message.id); resolve(message)
    }
  }
})
const request = (id, method, params) => new Promise((resolve, reject) => {
  pending.set(id, resolve)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, 15000)
})

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`PASS ${name}`)
  else { failures += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
const booleanSubschemas = (node, trail, hits) => {
  if (node === true || node === false) { hits.push(trail.join('.')); return }
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach((item, index) => booleanSubschemas(item, trail.concat(index), hits)); return }
  for (const key of Object.keys(node)) {
    if ((key === 'properties' || key === 'patternProperties') && node[key] && typeof node[key] === 'object' && !Array.isArray(node[key])) {
      for (const name of Object.keys(node[key])) booleanSubschemas(node[key][name], trail.concat(key, name), hits)
      continue
    }
    if (key === 'additionalProperties') continue
    booleanSubschemas(node[key], trail.concat(key), hits)
  }
}

try {
  const init = await request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
  check('initialize answered', Boolean(init && init.result), JSON.stringify(init && init.error))
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const listed = await request(2, 'tools/list', {})
  const tools = (listed && listed.result && listed.result.tools) || []
  check('three tools listed', tools.length === 3, String(tools.length))

  const boolTool = tools.find((tool) => tool.name === 'bool_schema')
  const evidence = boolTool && boolTool.inputSchema
    && boolTool.inputSchema.properties && boolTool.inputSchema.properties.source
    && boolTool.inputSchema.properties.source.oneOf[1].properties.evidence
  check('boolean property became an object', evidence !== null && typeof evidence === 'object' && !Array.isArray(evidence) && Object.keys(evidence).length === 0,
    JSON.stringify(evidence))

  const ap = tools.find((tool) => tool.name === 'ap_bool')
  check('additionalProperties: false is preserved', ap && ap.inputSchema && ap.inputSchema.additionalProperties === false,
    JSON.stringify(ap && ap.inputSchema && ap.inputSchema.additionalProperties))

  const plain = tools.find((tool) => tool.name === 'plain')
  check('normal schemas untouched', plain && plain.inputSchema.properties.q.type === 'string')

  const hits = []
  for (const tool of tools) booleanSubschemas(tool.inputSchema, [tool.name], hits)
  check('no boolean subschemas left in any property map', hits.length === 0, hits.join(', '))

  check('bridge process is still alive', child.exitCode === null)
} catch (error) {
  failures += 1
  console.log('FAIL unexpected error — ' + String((error && error.stack) || error))
} finally {
  try { child.stdin.end() } catch { /* gone */ }
  await new Promise((resolve) => setTimeout(resolve, 300))
  try { child.kill('SIGKILL') } catch { /* gone */ }
  try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
}
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
