// dsh-craft-anything — management HTTP authentication.
//
// The plugin registers exact routes on DSH's host Web server. That carrier performs no
// authentication of its own ("route owners such as dsh-client-connection enforce their own
// request policy"), so every `/craft-anything/api/*` route is guarded here, in four layers:
//
//   1. Host fence — the Host header must be loopback, unless the row config widens it
//      (`allowNonLoopback` + `trustedHosts`). Blocks DNS rebinding.
//   2. Origin fence — a browser Origin must equal the request authority and stay local;
//      cross-site requests are refused before any work happens (CSRF). Non-browser clients
//      send no Origin and fall through to the Bearer check.
//   3. DSH session admission — two mechanisms, chosen by what the running DSH offers:
//        * Route auth (`auth` on the route, `craftRouteAuth` / `TOKEN_ROUTE_AUTH` below).
//          Current DSH decides browser sessions in the `webserver/authorize` waterfall
//          (connection.authentication). This is the only supported way there: handlers
//          must NOT call into the connection service — DSH master made
//          `connection.authentication` inject-only and removed `requestRejection()`, so a
//          handler-side call throws "cannot get property connection.authentication without
//          inject". `craftRouteAuth` marks browser requests `required` and local CLI
//          requests `anonymous`; the Bearer token below still gates the latter.
//        * `connection.requestRejection()` — DSH <= 0.2.1-rc.5 have no route-level auth,
//          so the browser session gate runs inside the handler when that hook exists.
//          `connectionRejection` probes for it and treats "missing or throws" as "route
//          auth owns this", which lets one build serve both DSH lines.
//   4. Bearer token — this plugin's own random per-process token, required on every
//      management request (the token route itself needs only the DSH session).
//
// The token route is always `required` for DSH session admission: it hands out the Bearer
// token, so it must never be reachable anonymously where route auth is enforced.

import { timingSafeEqual } from 'node:crypto'

/** DSH session admission for the token route: browsers only, never anonymous. */
export const TOKEN_ROUTE_AUTH = 'required'

/** One header value, normalized to a string (arrays are joined, names are case-insensitive). */
export function headerOf(headers, name) {
  if (!headers) return undefined
  const wanted = name.toLowerCase()
  let value = headers[name]
  if (value === undefined) value = headers[wanted]
  if (value === undefined) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === wanted) { value = headers[key]; break }
    }
  }
  if (Array.isArray(value)) return value.join(', ')
  return typeof value === 'string' ? value : undefined
}

/**
 * DSH route-auth rule: browser sessions are admitted by the `webserver/authorize`
 * waterfall, local CLI clients are anonymous and stay gated by the Bearer token.
 * @param request - `{ headers }` of the incoming request (DSH passes a WebAuthRequest).
 * @returns `'required'` for browser-originated requests, `'anonymous'` otherwise.
 */
export function craftRouteAuth(request) {
  const headers = request?.headers
  const site = headerOf(headers, 'sec-fetch-site')
  if (site !== undefined) return site === 'none' ? 'anonymous' : 'required'
  if (headerOf(headers, 'origin') !== undefined || headerOf(headers, 'referer') !== undefined) return 'required'
  return 'anonymous'
}

/**
 * Browser-originated request? A fetch from the Web page carries Sec-Fetch-* headers; a
 * top-level navigation is `sec-fetch-site: none`; non-browser clients carry none of these.
 */
export function isBrowserRequest(req) {
  const site = headerOf(req.headers, 'sec-fetch-site')
  if (site !== undefined) return site !== 'none'
  return headerOf(req.headers, 'origin') !== undefined || headerOf(req.headers, 'referer') !== undefined
}

/**
 * Ask the DSH connection service to admit a browser request, when that hook exists.
 * DSH <= 0.2.1-rc.5 expose `requestRejection()`; current DSH removed it and enforces the
 * same decision through route auth before the handler runs, so a missing method (or an
 * inject error from an incompatible build) means "nothing to reject here".
 * @param connection - the resolved `connection` service, if any.
 * @param headers - incoming request headers.
 * @returns 401/403 when the DSH session rejects the request, otherwise undefined.
 */
export function connectionRejection(connection, headers) {
  if (!connection || typeof connection.requestRejection !== 'function') return undefined
  try {
    const rejection = connection.requestRejection({ headers })
    return rejection === 401 || rejection === 403 ? rejection : undefined
  } catch {
    return undefined
  }
}

export function authorityOf(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  try { return new URL(`http://${value}`) } catch { return undefined }
}

export function isLoopbackHostname(hostname) {
  const normal = String(hostname || '').toLowerCase()
  if (normal === 'localhost' || normal === '::1' || normal === '[::1]') return true
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(normal)
  if (!match) return false
  const octets = match.slice(1).map(Number)
  return octets.every((part) => part >= 0 && part <= 255) && octets[0] === 127
}

/** Host header fence: loopback only unless the profile explicitly widens it. */
export function hostAllowed(req, auth) {
  const authority = authorityOf(headerOf(req.headers, 'host'))
  if (!authority) return false
  if (isLoopbackHostname(authority.hostname)) return true
  if (!auth.allowNonLoopback) return false
  const normalized = authority.host.toLowerCase()
  return (auth.trustedHosts || []).some((entry) => {
    const trusted = authorityOf(entry)
    return trusted !== undefined && trusted.host.toLowerCase() === normalized
  })
}

/** Origin fence: a browser Origin must equal the request authority and stay local. */
export function originAllowed(req, auth) {
  const origin = headerOf(req.headers, 'origin')
  if (origin === undefined) return true // non-browser client: gated by the Bearer token
  let parsed
  try { parsed = new URL(origin) } catch { return false }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const trusted = auth.trustedHosts || []
  if (!isLoopbackHostname(parsed.hostname) && !(auth.allowNonLoopback && trusted.length > 0)) return false
  const authority = authorityOf(headerOf(req.headers, 'host'))
  if (!authority) return false
  return parsed.host.toLowerCase() === authority.host.toLowerCase()
}

export function bearerOf(req) {
  const value = headerOf(req.headers, 'authorization')
  if (typeof value !== 'string') return undefined
  const match = /^Bearer[ \t]+([A-Za-z0-9._~+/=-]{8,4096})$/i.exec(value.trim())
  return match ? match[1] : undefined
}

export function constantEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

export function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('vary', 'Origin')
  res.end(JSON.stringify(payload))
}

/** undefined: authorized; 401/403: answer that status and stop before any side effect. */
export async function rejectRequest(req, auth, options = {}) {
  const requireToken = options.requireToken !== false
  const requireConnection = options.requireConnection === 'always'
  if (!hostAllowed(req, auth)) return 403
  if (!originAllowed(req, auth)) return 403
  // Layer 3. Route auth already decided browser sessions on current DSH; the connection
  // hook is the fallback for DSH lines that still enforce admission in the handler.
  if (requireConnection || isBrowserRequest(req)) {
    const rejection = connectionRejection(auth.connection?.(), req.headers)
    if (rejection !== undefined) return rejection
  }
  if (requireToken && !constantEquals(bearerOf(req), auth.token)) return 401
  return undefined
}

export function guarded(handler, auth, options = {}) {
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

/**
 * `GET /craft-anything/api/token` — hands the Bearer token to the Web page after the DSH
 * session admitted it (route auth on current DSH, the connection hook on older lines).
 */
export function tokenRouteHandler(auth) {
  return guarded(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, error: 'GET only' })
      return
    }
    sendJson(res, 200, { ok: true, token: auth.token })
  }, auth, { requireToken: false, requireConnection: 'always' })
}
