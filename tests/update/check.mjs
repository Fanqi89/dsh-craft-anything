// Exercises host/update.mjs outside the Harness: release lookup, version compare, profile
// discovery. Read-only: it never calls startInstall / restart.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUpdateService, compareVersions, parseVersion } from '../../host/update.mjs'

const PACKAGE_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..')

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, args, { env: options.env || process.env, windowsHide: true, shell: options.shell === true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error.message), timedOut: false })
      return
    }
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error.message), timedOut: false }))
    child.on('close', (code) => resolve({ code, stdout, stderr, timedOut: false }))
  })
}

function which(name) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext)
      try { if (fs.statSync(candidate).isFile()) return candidate } catch { /* keep looking */ }
    }
  }
  return null
}

const existsFile = (candidate) => {
  try { return fs.statSync(candidate).isFile() } catch { return false }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-update-check-'))
const service = createUpdateService({
  PACKAGE_DIR,
  IS_WINDOWS: process.platform === 'win32',
  run,
  which,
  existsFile,
  installRoot: () => root,
  readEnvFile: () => ({}),
  envForChild: () => ({ ...process.env }),
  proxyUrl: () => '',
  invalidateProbes: () => {},
})

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

check('parseVersion 0.4.0', JSON.stringify(parseVersion('0.4.0')) === JSON.stringify({ major: 0, minor: 4, patch: 0, pre: [] }))
check('compare 0.5.0 > 0.4.0', compareVersions('0.5.0', '0.4.0') === 1)
check('compare v0.5.0 = 0.5.0', compareVersions('v0.5.0', '0.5.0') === 0)
check('compare rc.1 < 0.5.0', compareVersions('0.5.0-rc.1', '0.5.0') === -1)
check('compare rc.2 > rc.1', compareVersions('0.5.0-rc.2', '0.5.0-rc.1') === 1)

const report = await service.updateReport({ force: true })
console.log(`report current=${report.current.version} latest=${report.latest && report.latest.tag} hasUpdate=${report.hasUpdate} devCopy=${report.devCopy} profile=${report.install.profile} spec=${report.install.spec} error=${report.error}`)
check('report has current version', typeof report.current.version === 'string' && report.current.version.length > 0, report.current.version)
check('report found a release', Boolean(report.latest && report.latest.tag), report.latest ? report.latest.tag : 'none')
check('report found the profile', Boolean(report.install.profile), String(report.install.profile))
check('report reports the dependency spec', typeof report.install.spec === 'string', String(report.install.spec))
check('report does not claim an update before it exists', report.hasUpdate === false || Boolean(report.install.tag), `hasUpdate=${report.hasUpdate}`)
console.log(JSON.stringify({ install: report.install, state: report.state, error: report.error }, null, 2))
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
// Undici's connection pool needs a tick to close; exiting inside it trips a libuv assertion on
// Windows even though every check ran. The test is the only place that exits right after fetch.
await new Promise((resolve) => setTimeout(resolve, 300))
process.exit(failures === 0 ? 0 : 1)
