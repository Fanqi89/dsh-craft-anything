// End-to-end proof of the one-click update: run host/update.mjs against a *simulated older copy*
// of the plugin (package.json says 0.3.1), let it install the real published v0.4.0 tag into a
// throwaway Harness profile through the real DSH CLI + pnpm, and require the profile dependency and
// the installed package to point at that tag.
//
// Run it with the Harness binary in Node mode (so process.execPath is the Harness and the same
// `<exe> --expose-internals <app.asar>/.../cli.js` invocation the desktop uses is exercised):
//
//   set ELECTRON_RUN_AS_NODE=1
//   "C:\Users\fanqi\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" tests\update\install-probe.mjs
//
// It touches only <HOME>/.dsh/profiles/craft-update-probe (removed again) and a temp copy of this
// repository. The live desktop profile is never modified.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createUpdateService } from '../../host/update.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const home = process.env.USERPROFILE || process.env.HOME || os.homedir()
const profilesDir = path.join(home, '.dsh', 'profiles')
const probeName = 'craft-update-probe'
const probeDir = path.join(profilesDir, probeName)
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-update-probe-'))
const fakePlugin = path.join(work, 'dsh-craft-anything-0.3.1')
const TARGET_TAG = 'v0.4.0'

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`PASS ${name}${detail ? ` — ${detail}` : ''}`)
  else { failures += 1; console.log(`FAIL ${name}${detail ? ` — ${detail}` : ''}`) }
}

function makeOlderCopy() {
  fs.cpSync(repo, fakePlugin, {
    recursive: true,
    filter: (source) => !/[\\/](\.git|node_modules|reports|tests)$/.test(source),
  })
  const manifestPath = path.join(fakePlugin, 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  manifest.version = '0.3.1'
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

function makeProbeProfile() {
  fs.rmSync(probeDir, { recursive: true, force: true })
  fs.mkdirSync(probeDir, { recursive: true })
  fs.writeFileSync(path.join(probeDir, 'package.json'), `${JSON.stringify({
    name: probeName,
    private: true,
    version: '0.0.0',
    dependencies: { 'dsh-craft-anything': `link:${fakePlugin}` },
  }, null, 2)}\n`)
}

function run(command, args, options = {}) {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(command, args, { env: options.env || process.env, windowsHide: true, shell: options.shell === true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, stdout, stderr: String(error.message) })
      return
    }
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ code: null, stdout, stderr: String(error.message) }))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
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

const existsFile = (candidate) => { try { return fs.statSync(candidate).isFile() } catch { return false } }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The Harness CLI entry that the desktop's dsh.cmd uses; this test is launched by the Harness
// binary, so process.execPath is the app and needs ELECTRON_RUN_AS_NODE to run it.
const resources = path.dirname(process.execPath)
const cliJs = path.join(resources, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')

try {
  check('running under the Harness executable', /DeepSeek Harness(\.exe)?$/i.test(process.execPath), process.execPath)
  check('Harness CLI entry exists', existsFile(cliJs), cliJs)
  process.env.CRAFT_ANYTHING_DSH_CLI = cliJs
  process.env.DSH_PROFILE = probeName

  makeOlderCopy()
  makeProbeProfile()

  const service = createUpdateService({
    PACKAGE_DIR: fakePlugin,
    IS_WINDOWS: process.platform === 'win32',
    run,
    which,
    existsFile,
    installRoot: () => path.join(work, 'root'),
    readEnvFile: () => ({}),
    envForChild: () => ({ ...process.env }),
    proxyUrl: () => '',
    invalidateProbes: () => {},
  })

  const report = await service.updateReport({ force: true })
  check('current version is the simulated 0.3.1', report.current.version === '0.3.1', report.current.version)
  check('latest release is newer', report.hasUpdate === true, `${report.current.version} -> ${report.latest && report.latest.tag}`)
  check('the probe profile is the install target', report.install.profile === probeName, String(report.install.profile))
  check('install is offered', report.install.available === true, JSON.stringify(report.install.command))

  console.log(`installing ${report.latest.tag} into ${probeName} …`)
  service.startInstall({})
  let job = service.jobSnapshot()
  for (let attempt = 0; attempt < 300 && job.status === 'running'; attempt += 1) {
    await sleep(1000)
    job = service.jobSnapshot()
  }
  console.log(job.log || '(no job log)')
  check('update job finished', job.status === 'done', `${job.status}: ${job.error || job.detail}`)
  check('job installed the release tag', Boolean(job.result && job.result.installed && job.result.tag === TARGET_TAG), JSON.stringify(job.result))

  const profile = JSON.parse(fs.readFileSync(path.join(probeDir, 'package.json'), 'utf8'))
  const spec = profile.dependencies && profile.dependencies['dsh-craft-anything']
  check('profile dependency now points at the release tag', typeof spec === 'string' && spec.includes('#') && spec.endsWith(TARGET_TAG), String(spec))

  const installedManifest = path.join(probeDir, 'node_modules', 'dsh-craft-anything', 'package.json')
  let installedVersion = null
  try { installedVersion = JSON.parse(fs.readFileSync(installedManifest, 'utf8')).version } catch { /* not installed */ }
  check('the installed package is the release version', installedVersion === TARGET_TAG.replace(/^v/, ''), String(installedVersion))
  check('the update state file records the version', Boolean(service.stateFile() && fs.existsSync(service.stateFile())), service.stateFile())
} catch (error) {
  failures += 1
  console.log(`FAIL unexpected error — ${error && error.stack ? error.stack : error}`)
} finally {
  try { fs.rmSync(probeDir, { recursive: true, force: true }) } catch { /* best effort */ }
  try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
}

console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
