// Issue #3 regression: the composer chips must be *registered only while their preference says so*,
// never rendered as an empty box. client.js is a browser module, so this harness loads it against a
// fake module loader, a fake slots service and a fake ui route, then inspects which slots ended up
// registered. It does not render React; it checks the apply() contract the report depends on.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const source = fs.readFileSync(path.join(repo, 'client.js'), 'utf8')

const PrefsKey = 'dsh-craft-anything:composer'

function makeReact() {
  const passthrough = (value) => value
  return {
    createElement: (type, props, ...children) => ({ type, props, children }),
    Fragment: 'Fragment',
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, passthrough],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (initial) => ({ current: initial }),
    useId: () => 'id',
  }
}

/** Evaluate client.js the way the page does and return its module exports. */
function loadClient({ storage, uiPrefs, failUi = false }) {
  let exported = null
  const requests = []

  const requireStub = (name) => {
    if (name === 'react') return makeReact()
    throw new Error(`unexpected externals import in client.js: ${name}`)
  }
  const fetchStub = async (url, options = {}) => {
    requests.push({ url: String(url), method: options.method || 'GET' })
    if (String(url).includes('/craft-anything/api/token')) {
      return { ok: true, status: 200, json: async () => ({ ok: true, token: 'x'.repeat(32) }) }
    }
    if (String(url).includes('/craft-anything/api/ui')) {
      if (failUi) return { ok: false, status: 500, json: async () => ({ ok: false }) }
      if (options.method === 'POST') {
        const patch = JSON.parse(options.body || '{}')
        return { ok: true, status: 200, json: async () => ({ ok: true, ui: { composerMode: patch.composerMode ?? true, composerBridge: patch.composerBridge ?? true } }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, ui: uiPrefs, uiFile: '/tmp/ui.json' }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }

  const window = {
    __ModuleLoader__: {
      load({ factory }) {
        exported = factory(requireStub)
      },
    },
  }
  const localStorage = {
    getItem: (key) => (Object.prototype.hasOwnProperty.call(storage, key) ? storage[key] : null),
    setItem: (key, value) => { storage[key] = String(value) },
  }

  // The globals must stay installed for the whole test: apply() starts async fetches that resolve
  // after load, and those call global `fetch` again.
  const globals = { window, localStorage, fetch: fetchStub, navigator: { language: 'en-US' }, document: undefined }
  const previous = {}
  for (const key of Object.keys(globals)) {
    previous[key] = Object.getOwnPropertyDescriptor(globalThis, key)
    Object.defineProperty(globalThis, key, { value: globals[key], configurable: true, writable: true })
  }
  try {
    // eslint-disable-next-line no-new-func
    new Function(source)()
  } catch (error) {
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else delete globalThis[key]
    }
    throw error
  }
  assert.ok(exported && typeof exported.apply === 'function', 'client.js did not export apply()')
  const restore = () => {
    for (const key of Object.keys(globals)) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key])
      else delete globalThis[key]
    }
  }
  return { module: exported, requests, restore }
}

/** A slots service that records injections and lets the test read what is live right now. */
function makeSlots() {
  const live = new Map()
  let nextId = 0
  const slots = {
    register(options) {
      const id = `${options.name}:${nextId++}`
      live.set(id, options)
      return () => { live.delete(id) }
    },
    inject(name, callback) {
      const dispose = callback()
      return () => { if (typeof dispose === 'function') dispose() }
    },
    live() { return [...live.values()].filter((options) => options.name === 'conversation.input.left') },
    all() { return [...live.values()] },
  }
  return slots
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 30))

const tests = []
function test(name, fn) { tests.push({ name, fn }) }

test('host preference decides the first registration (bridge only)', async () => {
  const storage = {}
  const client = loadClient({ storage, uiPrefs: { composerMode: false, composerBridge: true } })
  try {
    const slots = makeSlots()
    client.module.apply({ slots })
    await tick()
    const ids = slots.live().map((options) => options.id)
    assert.deepEqual(ids, ['craft-anything/bridge'])
    assert.equal(storage[PrefsKey], JSON.stringify({ composerMode: false, composerBridge: true }))
  } finally {
    client.restore()
  }
})

test('cached preference paints first, then the host reconciles', async () => {
  const storage = { [PrefsKey]: JSON.stringify({ composerMode: true, composerBridge: false }) }
  const client = loadClient({ storage, uiPrefs: { composerMode: true, composerBridge: true } })
  try {
    const slots = makeSlots()
    client.module.apply({ slots })
    assert.deepEqual(slots.live().map((options) => options.id), ['craft-anything/mode'], 'cache should be used before any network answer')
    await tick()
    assert.deepEqual(slots.live().map((options) => options.id).sort(), ['craft-anything/bridge', 'craft-anything/mode'])
  } finally {
    client.restore()
  }
})

test('hiding both unregisters both chips and keeps the page + settings slots', async () => {
  const storage = {}
  const client = loadClient({ storage, uiPrefs: { composerMode: false, composerBridge: false } })
  try {
    const slots = makeSlots()
    client.module.apply({ slots })
    await tick()
    assert.deepEqual(slots.live(), [])
    const names = slots.all().map((options) => options.name)
    assert.ok(names.includes('sidebar.panellist'))
    assert.ok(names.includes('main'))
    assert.ok(names.includes('settings.section'), 'the settings page must stay reachable when both chips are hidden')
  } finally {
    client.restore()
  }
})

test('a failed ui read falls back to showing both, as before the option existed', async () => {
  const storage = {}
  const client = loadClient({ storage, uiPrefs: null, failUi: true })
  try {
    const slots = makeSlots()
    client.module.apply({ slots })
    await tick()
    assert.deepEqual(slots.live().map((options) => options.id).sort(), ['craft-anything/bridge', 'craft-anything/mode'])
  } finally {
    client.restore()
  }
})

let passed = 0
const failures = []
for (const { name, fn } of tests) {
  try {
    await fn()
    passed += 1
  } catch (error) {
    failures.push({ name, error })
  }
}
if (failures.length > 0) {
  for (const failure of failures) console.error(`FAIL ${failure.name}\n  ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
  console.error(`client registration: ${passed} passed, ${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`client registration: ${passed}/${passed} passed`)
}
