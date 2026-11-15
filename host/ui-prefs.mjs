// dsh-craft-anything — composer visibility preferences.
//
// The plugin contributes two controls to the composer tool row: the clean-room/deep mode switch
// and the MCP bridge switch. They are useful, but on a narrow window they crowd the row that also
// holds DSH's own controls, so both can be hidden from the composer (issue #3). Hiding a control
// only removes that control: the mode and the bridge keep their state, the tools keep working, and
// the plugin page plus the craft_mode / craft_bridge tools can still change them.
//
// The choice has to reach the browser half, which cannot read the Loader row config directly, so
// the Host owns one small JSON file in the install root and the client reads it over the guarded
// ui route. Precedence, highest first:
//   1. <install root>/ui.json      — written by the Settings page (the visible "config page")
//   2. CRAFT_ANYTHING_COMPOSER_MODE / CRAFT_ANYTHING_COMPOSER_BRIDGE=0|1 — for scripted setups
//   3. the row config (composerMode: false in cordis.patch.yml)          — for profile patches
//   4. built-in default: both controls shown (older behaviour keeps working after an upgrade)

import fs from 'node:fs'
import path from 'node:path'

export const UI_PREFS_FILE = 'ui.json'
export const UI_PREF_KEYS = ['composerMode', 'composerBridge']
export const DEFAULT_UI_PREFS = Object.freeze({ composerMode: true, composerBridge: true })
export const UI_ENV_KEYS = Object.freeze({
  composerMode: 'CRAFT_ANYTHING_COMPOSER_MODE',
  composerBridge: 'CRAFT_ANYTHING_COMPOSER_BRIDGE',
})

/** '0'/'false'/'off'/'no' -> false, '1'/'true'/'on'/'yes' -> true, anything else -> undefined. */
export function parseEnvBool(value) {
  if (typeof value === 'boolean') return value
  if (typeof value !== 'string') return undefined
  const text = value.trim().toLowerCase()
  if (!text) return undefined
  if (text === '0' || text === 'false' || text === 'off' || text === 'no') return false
  if (text === '1' || text === 'true' || text === 'on' || text === 'yes') return true
  return undefined
}

/** Only the two known boolean keys survive, so a stray edit of ui.json cannot leak into a report. */
export function normalizeUiPatch(value) {
  const patch = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return patch
  for (const key of UI_PREF_KEYS) {
    if (typeof value[key] === 'boolean') patch[key] = value[key]
  }
  return patch
}

/**
 * Read the file the Settings page writes. A missing or malformed file is not an error: it just
 * contributes no explicit choice, so the env/config/default chain decides.
 */
export function readUiFile(file) {
  const state = { explicit: {}, updatedAt: null }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return state
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return state
  for (const key of UI_PREF_KEYS) {
    if (typeof parsed[key] === 'boolean') state.explicit[key] = parsed[key]
  }
  if (typeof parsed.updatedAt === 'string') state.updatedAt = parsed.updatedAt
  return state
}

/**
 * Merge one patch into the file and return the resulting explicit state. The file keeps only
 * explicit choices (plus a timestamp), so removing a key is a deliberate edit, never a side
 * effect of a write.
 */
export function writeUiFile(file, patch) {
  const current = readUiFile(file)
  const patchKeys = normalizeUiPatch(patch)
  if (Object.keys(patchKeys).length === 0) return current
  const explicit = { ...current.explicit, ...patchKeys }
  const next = { ...explicit, updatedAt: new Date().toISOString() }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  return { explicit, updatedAt: next.updatedAt }
}

/**
 * Effective preference: file > env > row config > default. `source` says which layer supplied
 * each value, which is what the Settings page shows under the switches.
 */
export function resolveUiPrefs(options = {}) {
  const file = options.file
  const env = options.env || {}
  const config = options.config || {}
  const fromFile = file ? readUiFile(file).explicit : {}
  const prefs = { ...DEFAULT_UI_PREFS }
  const source = {}
  for (const key of UI_PREF_KEYS) {
    if (typeof config[key] === 'boolean') {
      prefs[key] = config[key]
      source[key] = 'config'
    }
    const fromEnv = parseEnvBool(env[UI_ENV_KEYS[key]])
    if (fromEnv !== undefined) {
      prefs[key] = fromEnv
      source[key] = 'env'
    }
    if (typeof fromFile[key] === 'boolean') {
      prefs[key] = fromFile[key]
      source[key] = 'settings'
    }
    if (!source[key]) source[key] = 'default'
  }
  return { ...prefs, source }
}

/** One small JSON request body; anything that is not a JSON object resolves to null. */
function readJson(req, limit = 4096) {
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
      try { resolve(JSON.parse(text || '{}')) } catch { resolve(null) }
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * The guarded ui route. `getOptions()` returns `{ root, env, config }` so the Host half can pass
 * the install root it resolved from the row config while this module stays testable on its own.
 * GET reports the effective preference; POST {composerMode?, composerBridge?} writes <root>/ui.json.
 */
export function createUiRouteHandler(getOptions) {
  const options = () => {
    const value = (typeof getOptions === 'function' ? getOptions() : null) || {}
    const root = typeof value.root === 'string' && value.root ? value.root : '.'
    return { root, file: path.join(root, UI_PREFS_FILE), env: value.env || {}, config: value.config || {} }
  }
  const report = () => {
    const { file, env, config } = options()
    return { ok: true, ui: resolveUiPrefs({ file, env, config }), uiFile: file }
  }
  return async (req, res) => {
    const send = (code, payload) => {
      res.statusCode = code
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('cache-control', 'no-store')
      res.end(JSON.stringify(payload))
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      try { send(200, report()) } catch (error) { send(500, { ok: false, error: String((error && error.message) || error) }) }
      return
    }
    if (req.method !== 'POST') {
      send(405, { ok: false, error: 'GET or POST only' })
      return
    }
    const body = await readJson(req)
    const patch = normalizeUiPatch(body)
    if (Object.keys(patch).length === 0) {
      send(400, { ok: false, error: 'body must be {"composerMode":boolean} and/or {"composerBridge":boolean}' })
      return
    }
    try {
      writeUiFile(options().file, patch)
      send(200, report())
    } catch (error) {
      send(500, { ok: false, error: String((error && error.message) || error) })
    }
  }
}
