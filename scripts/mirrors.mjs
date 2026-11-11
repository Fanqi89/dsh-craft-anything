// dsh-craft-anything — download-source selection.
//
// GitHub release downloads are slow or unreachable on some networks (the reporter's Windows box
// failed inside Invoke-WebRequest on github.com). This module ranks a list of mirrors by latency,
// keeps the official URL as the permanent fallback, and lets both installers and the Host half use
// the fastest reachable source first and fall back on a failed/truncated download.
//
// Mirrors are plain prefixes in front of `https://github.com/...` (the well-known ghproxy family).
// They can be overridden with CRAFT_ANYTHING_GITHUB_MIRRORS / CRAFT_ANYTHING_NPM_REGISTRY_*
// (comma separated), and a mirror is only a *source*: the SHA256SUMS check still decides whether a
// downloaded archive is the official one.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

export const OFFICIAL_GITHUB = 'https://github.com'

export const DEFAULT_GITHUB_MIRRORS = [
  'https://ghfast.top/https://github.com',
  'https://gh-proxy.com/https://github.com',
  'https://ghproxy.net/https://github.com',
  'https://mirror.ghproxy.com/https://github.com',
]

export const NPM_REGISTRIES = [
  'https://registry.npmmirror.com',
  'https://registry.npmjs.org',
]

function splitEnv(name) {
  const value = process.env[name]
  return typeof value === 'string' && value.trim()
    ? value.split(',').map((part) => part.trim().replace(/\/+$/, '')).filter(Boolean)
    : []
}

export function githubMirrors() {
  const configured = splitEnv('CRAFT_ANYTHING_GITHUB_MIRRORS')
  return configured.length > 0 ? configured : DEFAULT_GITHUB_MIRRORS
}

export function npmRegistries() {
  const configured = splitEnv('CRAFT_ANYTHING_NPM_REGISTRY')
  return configured.length > 0 ? configured : NPM_REGISTRIES
}

/** Candidate URLs for one github.com URL: mirrors first (ranked later), official always last. */
export function githubCandidates(url) {
  const mirrors = githubMirrors().map((prefix) => url.replace(OFFICIAL_GITHUB, prefix))
  return [...mirrors.map((candidate) => ({ url: candidate, official: false })), { url, official: true }]
}

export function proxyArg() {
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy
  return proxy ? ['--proxy', proxy] : []
}

function hasCurl() {
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/** Seconds curl spent, or null when the URL is unreachable. Sync: installer scripts are CLI. */
export function probeMsSync(url, timeoutSeconds = 3) {
  if (!hasCurl()) return null
  const argv = ['-sS', '-o', process.platform === 'win32' ? 'NUL' : '/dev/null', '-w', '%{time_total}', '--max-time', String(timeoutSeconds), '-r', '0-0']
  if (process.platform === 'win32') argv.push('--ssl-no-revoke')
  argv.push(...proxyArg(), url)
  try {
    const started = Date.now()
    execFileSync('curl', argv, { encoding: 'utf8', timeout: (timeoutSeconds + 2) * 1000, stdio: ['ignore', 'pipe', 'pipe'] })
    return Date.now() - started
  } catch {
    return null
  }
}

/** Rank candidates by a real range request. Unreachable mirrors are dropped, official is appended. */
export function rankSync(candidates) {
  const timed = []
  for (const candidate of candidates) {
    const ms = probeMsSync(candidate.url)
    if (ms !== null) timed.push({ ...candidate, ms })
  }
  timed.sort((left, right) => left.ms - right.ms)
  const official = candidates.filter((candidate) => candidate.official)
  const ranked = timed.filter((candidate) => !candidate.official).map((candidate) => candidate.url)
  for (const candidate of official) ranked.push(candidate.url)
  return ranked
}

/** Download with curl from the first URL that produces bytes; returns the URL used. */
export function downloadSync(urls, outputFile, options = {}) {
  const timeoutSeconds = options.timeoutSeconds || 600
  const tried = []
  for (const url of urls) {
    try {
      if (fs.existsSync(outputFile)) fs.rmSync(outputFile, { force: true })
      const argv = ['-fsSL', '--retry', '2', '--retry-delay', '2', '--connect-timeout', '20', '--max-time', String(timeoutSeconds), '-o', outputFile]
      if (process.platform === 'win32') argv.push('--ssl-no-revoke')
      argv.push(...proxyArg(), url)
      execFileSync('curl', argv, { stdio: ['ignore', 'ignore', 'pipe'], timeout: (timeoutSeconds + 30) * 1000 })
      const size = fs.existsSync(outputFile) ? fs.statSync(outputFile).size : 0
      if (size > 0) return { url, size }
      tried.push(`${url}: empty file`)
    } catch (error) {
      tried.push(`${url}: ${String((error && error.message) || error).slice(0, 160)}`)
    }
  }
  return { url: null, size: 0, tried }
}

export async function probeMs(url, timeoutMs = 2_500) {
  try {
    const started = Date.now()
    const response = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) })
    return response.ok || response.status === 405 || response.status === 403 ? Date.now() - started : null
  } catch {
    return null
  }
}

/** Rank npm registries by a /-/ping; official stays last so a mirror failure falls back. */
export async function rankNpmRegistries() {
  const registries = npmRegistries()
  const timed = []
  for (const registry of registries) {
    const ms = await probeMs(`${registry}/-/ping`)
    if (ms !== null) timed.push({ registry, ms })
  }
  timed.sort((left, right) => left.ms - right.ms)
  const ranked = timed.map((entry) => entry.registry)
  const official = 'https://registry.npmjs.org'
  if (!ranked.includes(official)) ranked.push(official)
  return ranked
}
