// Management HTTP auth regression tests.
//
// Two DSH lines exist and both must keep working:
//   * DSH <= 0.2.1-rc.5 — the carrier has no route-level auth; handlers call
//     connection.requestRejection() for the browser session and a browser without the DSH
//     cookie must be refused (401) even when it knows the Bearer token.
//   * current DSH (master) — `connection.authentication` became inject-only and
//     `requestRejection()` was removed; the browser session is decided by the
//     `webserver/authorize` waterfall from the route's `auth`. Handlers must not call the
//     connection service, and the token route must never be anonymous.
//
// These tests pin the classifier, the fences, the fallback probe and the route registration
// (with a fake Context / webServer, no Harness needed).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  TOKEN_ROUTE_AUTH,
  bearerOf,
  connectionRejection,
  constantEquals,
  craftRouteAuth,
  guarded,
  headerOf,
  hostAllowed,
  isBrowserRequest,
  isLoopbackHostname,
  originAllowed,
  rejectRequest,
  sendJson,
  tokenRouteHandler,
} from '../../host/http-auth.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')

let passed = 0
const failures = []
const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

const TOKEN = 'a'.repeat(64)
function authWith(connection) {
  return { token: TOKEN, trustedHosts: [], allowNonLoopback: false, connection: () => connection }
}
function req(headers = {}, method = 'GET') {
  return { method, url: '/craft-anything/api/status', headers }
}
function browserHeaders(extra = {}) {
  return { host: '127.0.0.1:51404', origin: 'http://127.0.0.1:51404', 'sec-fetch-site': 'same-origin', ...extra }
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

// --- classifier ------------------------------------------------------------------------------------

const routeAuthTests = [
  ['no browser headers -> anonymous (local CLI)', {}, 'anonymous'],
  ['Origin present -> required', { origin: 'http://127.0.0.1:51404' }, 'required'],
  ['Referer present -> required', { referer: 'http://127.0.0.1:51404/' }, 'required'],
  ['Sec-Fetch-Site same-origin -> required', { 'sec-fetch-site': 'same-origin' }, 'required'],
  ['Sec-Fetch-Site cross-site -> required', { 'sec-fetch-site': 'cross-site' }, 'required'],
  ['Sec-Fetch-Site none (navigation) -> anonymous', { 'sec-fetch-site': 'none' }, 'anonymous'],
]
for (const [name, headers, expected] of routeAuthTests) {
  test(`craftRouteAuth: ${name}`, () => {
    assert.equal(craftRouteAuth({ headers }), expected)
  })
}

test('craftRouteAuth tolerates a missing request', () => {
  assert.equal(craftRouteAuth(undefined), 'anonymous')
  assert.equal(craftRouteAuth({}), 'anonymous')
})

test('token route policy is required, never anonymous', () => {
  assert.equal(TOKEN_ROUTE_AUTH, 'required')
})

// --- fences and token parsing ----------------------------------------------------------------------

test('host fence: loopback only unless configured wider', () => {
  assert.equal(hostAllowed(req({ host: '127.0.0.1:51404' }), authWith()), true)
  assert.equal(hostAllowed(req({ host: 'localhost:51404' }), authWith()), true)
  assert.equal(hostAllowed(req({ host: '[::1]:51404' }), authWith()), true)
  assert.equal(hostAllowed(req({ host: 'evil.example:51404' }), authWith()), false)
  assert.equal(hostAllowed(req({}), authWith()), false)
  const widened = { ...authWith(), allowNonLoopback: true, trustedHosts: ['myhost:51404'] }
  assert.equal(hostAllowed(req({ host: 'myhost:51404' }), widened), true)
  assert.equal(hostAllowed(req({ host: 'myhost:51405' }), widened), false)
  assert.equal(isLoopbackHostname('127.0.0.2'), true)
  assert.equal(isLoopbackHostname('10.0.0.1'), false)
})

test('origin fence: cross-site and non-matching origins are refused', () => {
  assert.equal(originAllowed(req({ host: '127.0.0.1:51404' }), authWith()), true) // no Origin
  assert.equal(originAllowed(req(browserHeaders()), authWith()), true)
  assert.equal(originAllowed(req({ host: '127.0.0.1:51404', origin: 'https://evil.example' }), authWith()), false)
  assert.equal(originAllowed(req({ host: '127.0.0.1:51404', origin: 'http://127.0.0.1:51405' }), authWith()), false)
  assert.equal(originAllowed(req({ host: '127.0.0.1:51404', origin: 'file:///etc/passwd' }), authWith()), false)
})

test('bearer parsing and constant-time compare', () => {
  assert.equal(bearerOf(req({ authorization: `Bearer ${TOKEN}` })), TOKEN)
  assert.equal(bearerOf(req({ authorization: `bearer ${TOKEN}` })), TOKEN)
  assert.equal(bearerOf(req({ authorization: 'Basic abc' })), undefined)
  assert.equal(bearerOf(req({ authorization: 'Bearer short' })), undefined)
  assert.equal(bearerOf(req({})), undefined)
  assert.equal(constantEquals(TOKEN, TOKEN), true)
  assert.equal(constantEquals(TOKEN, 'b'.repeat(64)), false)
  assert.equal(constantEquals(TOKEN, undefined), false)
  assert.equal(headerOf({ 'Sec-Fetch-Site': 'same-origin' }, 'sec-fetch-site'), 'same-origin')
  assert.equal(headerOf({ a: ['x', 'y'] }, 'a'), 'x, y')
})

test('isBrowserRequest distinguishes browsers from local clients', () => {
  assert.equal(isBrowserRequest(req(browserHeaders())), true)
  assert.equal(isBrowserRequest(req({ origin: 'http://127.0.0.1:51404' })), true)
  assert.equal(isBrowserRequest(req({ referer: 'http://127.0.0.1:51404/' })), true)
  assert.equal(isBrowserRequest(req({ 'sec-fetch-site': 'none' })), false)
  assert.equal(isBrowserRequest(req({})), false)
})

// --- DSH session probe -----------------------------------------------------------------------------

test('connectionRejection: old DSH hook is honoured, missing/absent/throwing means route auth owns it', () => {
  assert.equal(connectionRejection(undefined, {}), undefined)
  assert.equal(connectionRejection({}, {}), undefined)
  assert.equal(connectionRejection({ requestRejection: () => 401 }, {}), 401)
  assert.equal(connectionRejection({ requestRejection: () => 403 }, {}), 403)
  assert.equal(connectionRejection({ requestRejection: () => undefined }, {}), undefined)
  // DSH master: requestRejection removed; calling into the connection service throws the
  // inject error. The probe must swallow it instead of failing the request.
  const throwing = { requestRejection: () => { throw new Error('cannot get property "connection.authentication" without inject') } }
  assert.equal(connectionRejection(throwing, {}), undefined)
})

// --- request gate ----------------------------------------------------------------------------------

const REJECTIONS = [
  ['host fence wins before anything else', req({ host: 'evil.example:51404' }), authWith(), 403],
  ['cross-site Origin -> 403', req({ host: '127.0.0.1:51404', origin: 'https://evil.example' }), authWith(), 403],
  ['browser without DSH session (old DSH) -> 401', req(browserHeaders()), authWith({ requestRejection: () => 401 }), 401],
  ['browser without token on current DSH -> 401', req(browserHeaders()), authWith(undefined), 401],
  ['missing token -> 401', req({ host: '127.0.0.1:51404' }), authWith(undefined), 401],
  ['wrong token -> 401', req({ host: '127.0.0.1:51404', authorization: `Bearer ${'b'.repeat(64)}` }), authWith(undefined), 401],
]
for (const [name, request, auth, expected] of REJECTIONS) {
  test(`rejectRequest: ${name}`, async () => {
    assert.equal(await rejectRequest(request, auth), expected)
  })
}

test('rejectRequest: old DSH session gate applies even with a valid token', async () => {
  const request = req(browserHeaders({ authorization: `Bearer ${TOKEN}` }))
  assert.equal(await rejectRequest(request, authWith({ requestRejection: () => 401 })), 401)
})

test('rejectRequest: current DSH passes browsers to route auth and keeps the Bearer gate', async () => {
  const request = req(browserHeaders({ authorization: `Bearer ${TOKEN}` }))
  // No connection service / no requestRejection: the route auth already admitted the browser.
  assert.equal(await rejectRequest(request, authWith(undefined)), undefined)
  assert.equal(await rejectRequest(request, authWith({})), undefined)
})

test('rejectRequest: throwing connection hook does not break the request', async () => {
  const throwing = { requestRejection: () => { throw new Error('inject') } }
  const request = req(browserHeaders({ authorization: `Bearer ${TOKEN}` }))
  assert.equal(await rejectRequest(request, authWith(throwing)), undefined)
})

test('rejectRequest: local CLI keeps Bearer access', async () => {
  assert.equal(await rejectRequest(req({ host: '127.0.0.1:51404', authorization: `Bearer ${TOKEN}` }), authWith(undefined)), undefined)
  // requireConnection/requireToken: false is the token route; a missing connection hook (current
  // DSH) must not 401 there, because route auth already decided the browser session.
  assert.equal(await rejectRequest(req({ host: '127.0.0.1:51404' }), authWith(undefined), { requireConnection: 'always', requireToken: false }), undefined)
  // On old DSH the token route still requires the browser session.
  assert.equal(await rejectRequest(req({ host: '127.0.0.1:51404' }), authWith({ requestRejection: () => 401 }), { requireConnection: 'always', requireToken: false }), 401)
})

test('guarded: refused requests never reach the handler', async () => {
  let ran = 0
  const handler = guarded(async (request, res) => { ran += 1; sendJson(res, 200, { ok: true }) }, authWith(undefined))
  const res = fakeRes()
  await handler(req({ host: '127.0.0.1:51404' }), res)
  assert.equal(ran, 0)
  assert.equal(res.statusCode, 401)
  const okRes = fakeRes()
  await handler(req({ host: '127.0.0.1:51404', authorization: `Bearer ${TOKEN}` }), okRes)
  assert.equal(ran, 1)
  assert.equal(okRes.statusCode, 200)
})

test('token route: browser bootstrap works, old DSH refuses it without the session', async () => {
  const token = tokenRouteHandler(authWith(undefined))
  const res = fakeRes()
  await token(req(browserHeaders(), 'GET'), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(JSON.parse(res.body), { ok: true, token: TOKEN })

  const oldDsh = tokenRouteHandler(authWith({ requestRejection: () => 401 }))
  const refused = fakeRes()
  await oldDsh(req(browserHeaders(), 'GET'), refused)
  assert.equal(refused.statusCode, 401)

  const post = fakeRes()
  await token(req({ host: '127.0.0.1:51404' }, 'POST'), post)
  assert.equal(post.statusCode, 405)
})

// --- route registration (fake Context + webServer) --------------------------------------------------

async function loadHost() {
  const module = await import('../../host/index.js')
  return module
}

function makeHarness({ connection, register } = {}) {
  const routes = []
  const webServer = {
    register(spec) {
      if (typeof register === 'function') return register(spec, routes)
      routes.push(spec)
      return () => {}
    },
  }
  const ctx = {
    tools: { register: () => () => {} },
    effect: (callback) => {
      const dispose = callback()
      return typeof dispose === 'function' ? dispose : () => {}
    },
    inject: (dependencies, callback) => {
      if (Array.isArray(dependencies) && dependencies.includes('webServer') && callback) {
        return callback({ webServer, effect: (fn) => fn?.() })
      }
      return undefined
    },
    get: (name) => (name === 'connection' ? connection : undefined),
  }
  return { ctx, routes }
}

async function registrationTests() {
  const host = await loadHost()
  const installDir = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-auth-'))
  delete process.env.CRAFT_ANYTHING_HTTP_TOKEN
  try {
    const { ctx, routes } = makeHarness()
    host.apply(ctx, { installDir, cliPath: process.execPath })
    const byPath = new Map(routes.map((route) => [route.path, route]))
    assert.equal(byPath.size, routes.length, 'route paths must be unique')
    const expectedPaths = [
      '/craft-anything/api/token',
      '/craft-anything/api/status',
      '/craft-anything/api/mode',
      '/craft-anything/api/env',
      '/craft-anything/api/bridge',
      '/craft-anything/api/ui',
      '/craft-anything/api/update',
      '/craft-anything/api/restart',
    ]
    for (const p of expectedPaths) {
      const route = byPath.get(p)
      assert.ok(route, `route ${p} registered`)
      assert.equal(route.kind, 'exact')
      assert.equal(typeof route.handler, 'function')
    }
    assert.equal(byPath.get('/craft-anything/api/token').auth, 'required')
    for (const p of expectedPaths.filter((entry) => !entry.endsWith('/token'))) {
      assert.equal(typeof byPath.get(p).auth, 'function', `${p} carries the browser/CLI classifier`)
      assert.equal(byPath.get(p).auth({ headers: browserHeaders() }), 'required')
      assert.equal(byPath.get(p).auth({ headers: {} }), 'anonymous')
    }
    // The token file is written into the configured install root.
    const tokenFile = path.join(installDir, 'http.token')
    assert.equal(fs.existsSync(tokenFile), true)
    assert.match(fs.readFileSync(tokenFile, 'utf8').trim(), /^[0-9a-f]{64}$/)
  } finally {
    fs.rmSync(installDir, { recursive: true, force: true })
  }

  // Very old carriers that reject unknown route keys: registration retries without `auth` and
  // leans on the handler-side connection fallback instead of failing the plugin.
  const installDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-auth2-'))
  try {
    const { ctx, routes } = makeHarness({
      register(spec, recorded) {
        if (spec.auth !== undefined) throw new TypeError('webserver: unsupported route option "auth"')
        recorded.push(spec)
        return () => {}
      },
    })
    host.apply(ctx, { installDir: installDir2, cliPath: process.execPath })
    assert.equal(routes.length, 8)
    for (const route of routes) assert.equal(route.auth, undefined)
  } finally {
    fs.rmSync(installDir2, { recursive: true, force: true })
  }
}

async function main() {
  for (const { name, fn } of tests) {
    try {
      await fn()
      passed += 1
    } catch (error) {
      failures.push({ name, error })
    }
  }
  try {
    await registrationTests()
    passed += 1
  } catch (error) {
    failures.push({ name: 'route registration (fake Context + webServer)', error })
  }
  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL ${failure.name}\n  ${failure.error && failure.error.stack ? failure.error.stack : failure.error}`)
    console.error(`auth: ${passed} passed, ${failures.length} failed`)
    process.exitCode = 1
    return
  }
  console.log(`auth: ${passed}/${passed} passed`)
}

await main()
