// Regression for issue #3: the composer holds two Craft Anything chips (mode + bridge) and on a
// narrow window they crowd the tool row. Both can now be hidden from Settings → Craft Anything;
// the Host persists the choice in <root>/ui.json and the ui route serves it to the browser half.
//
// These tests cover the file/env/config precedence, the JSON file itself, and the guarded route's
// GET/POST contract (the route is exercised with a fake req/res, no Harness needed).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_UI_PREFS,
  UI_PREFS_FILE,
  createUiRouteHandler,
  normalizeUiPatch,
  parseEnvBool,
  readUiFile,
  resolveUiPrefs,
  writeUiFile,
} from '../../host/ui-prefs.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-ui-prefs-'))
const file = path.join(work, 'root', UI_PREFS_FILE)

let passed = 0
const failures = []
function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}

function writeRaw(value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value))
}

function fakeRes() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) { res.headers[String(name).toLowerCase()] = value },
    end(text) { res.body = text || '' },
  }
  return res
}

function fakeReq(method, body) {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
  req.method = method
  return req
}

async function call(method, body) {
  const handler = createUiRouteHandler(() => ({ root: path.join(work, 'root'), env: {}, config: {} }))
  const res = fakeRes()
  await handler(fakeReq(method, body), res)
  return { status: res.statusCode, json: res.body ? JSON.parse(res.body) : null, headers: res.headers }
}

// --- pure helpers ---------------------------------------------------------------------------------

test('defaults show both chips', () => {
  const prefs = resolveUiPrefs({ file, env: {}, config: {} })
  assert.equal(prefs.composerMode, true)
  assert.equal(prefs.composerBridge, true)
  assert.equal(prefs.source.composerMode, 'default')
  assert.deepEqual(DEFAULT_UI_PREFS, { composerMode: true, composerBridge: true })
})

test('env booleans parse the scripted spellings only', () => {
  assert.equal(parseEnvBool('0'), false)
  assert.equal(parseEnvBool('OFF'), false)
  assert.equal(parseEnvBool(' true '), true)
  assert.equal(parseEnvBool('yes'), true)
  assert.equal(parseEnvBool('2'), undefined)
  assert.equal(parseEnvBool(''), undefined)
  assert.equal(parseEnvBool(undefined), undefined)
  assert.equal(parseEnvBool(false), false)
})

test('row config supplies a default, env overrides it', () => {
  const fromConfig = resolveUiPrefs({ file, env: {}, config: { composerMode: false } })
  assert.equal(fromConfig.composerMode, false)
  assert.equal(fromConfig.source.composerMode, 'config')
  assert.equal(fromConfig.composerBridge, true)

  const fromEnv = resolveUiPrefs({ file, env: { CRAFT_ANYTHING_COMPOSER_MODE: '1' }, config: { composerMode: false } })
  assert.equal(fromEnv.composerMode, true)
  assert.equal(fromEnv.source.composerMode, 'env')
})

test('unknown keys are dropped, not persisted', () => {
  assert.deepEqual(normalizeUiPatch({ composerMode: false, something: 'x', composerBridge: 'yes' }), { composerMode: false })
  writeUiFile(file, { composerMode: false })
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(raw.composerMode, false)
  assert.equal(raw.something, undefined)
  assert.equal(typeof raw.updatedAt, 'string')
})

test('a later write merges instead of replacing the other switch', () => {
  writeUiFile(file, { composerMode: false, composerBridge: true })
  const after = writeUiFile(file, { composerBridge: false })
  assert.deepEqual(after.explicit, { composerMode: false, composerBridge: false })
  const prefs = resolveUiPrefs({ file, env: {}, config: {} })
  assert.equal(prefs.composerMode, false)
  assert.equal(prefs.composerBridge, false)
  assert.equal(prefs.source.composerMode, 'settings')
})

test('the Settings file wins over env and config', () => {
  fs.rmSync(file, { force: true })
  writeUiFile(file, { composerMode: true })
  const prefs = resolveUiPrefs({ file, env: { CRAFT_ANYTHING_COMPOSER_MODE: '0' }, config: { composerMode: false } })
  assert.equal(prefs.composerMode, true)
  assert.equal(prefs.source.composerMode, 'settings')
  assert.equal(prefs.composerBridge, true)
  assert.equal(prefs.source.composerBridge, 'default')
})

test('a malformed or hostile file contributes nothing', () => {
  writeRaw('not json at all')
  assert.deepEqual(readUiFile(file), { explicit: {}, updatedAt: null })
  writeRaw({ composerMode: 'yes', composerBridge: 1, updatedAt: 5 })
  assert.deepEqual(readUiFile(file), { explicit: {}, updatedAt: null })
  writeRaw('["composerMode"]')
  assert.deepEqual(readUiFile(file).explicit, {})
  const prefs = resolveUiPrefs({ file, env: {}, config: {} })
  assert.equal(prefs.composerMode, true)
  assert.equal(prefs.composerBridge, true)
})

test('an empty patch writes nothing', () => {
  writeRaw({ composerMode: false })
  const before = fs.readFileSync(file, 'utf8')
  writeUiFile(file, {})
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

// --- the guarded ui route -------------------------------------------------------------------------

const routeTests = [
  ['GET reports the effective preference and its file', async () => {
    writeUiFile(file, { composerMode: false })
    const { status, json } = await call('GET')
    assert.equal(status, 200)
    assert.equal(json.ok, true)
    assert.equal(json.ui.composerMode, false)
    assert.equal(json.ui.source.composerMode, 'settings')
    assert.equal(json.ui.composerBridge, true)
    assert.equal(json.uiFile, file)
  }],
  ['POST hides one chip and keeps the other', async () => {
    writeUiFile(file, { composerMode: true, composerBridge: true })
    const { status, json } = await call('POST', { composerBridge: false })
    assert.equal(status, 200)
    assert.equal(json.ui.composerMode, true)
    assert.equal(json.ui.composerBridge, false)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).composerBridge, false)
  }],
  ['POST can hide both at once', async () => {
    const { status, json } = await call('POST', { composerMode: false, composerBridge: false })
    assert.equal(status, 200)
    assert.equal(json.ui.composerMode, false)
    assert.equal(json.ui.composerBridge, false)
  }],
  ['POST rejects a body without booleans', async () => {
    const { status, json } = await call('POST', { composerMode: 'no' })
    assert.equal(status, 400)
    assert.equal(json.ok, false)
  }],
  ['POST rejects an empty body and other methods', async () => {
    assert.equal((await call('POST', {})).status, 400)
    assert.equal((await call('DELETE')).status, 405)
  }],
  ['HEAD answers like GET', async () => {
    assert.equal((await call('HEAD')).status, 200)
  }],
]

async function main() {
  for (const [name, fn] of routeTests) {
    try {
      await fn()
      passed += 1
    } catch (error) {
      failures.push({ name, error })
    }
  }
  fs.rmSync(work, { recursive: true, force: true })
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure.name}\n  ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
    console.error(`ui-prefs: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
    return
  }
  console.log(`ui-prefs: ${passed}/${passed} passed`)
}

await main()
