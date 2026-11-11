// Proves scripts/restart-dsh.mjs on a stand-in process (never the Harness itself):
// start a long-lived node process, point the helper at it, and require that the helper
// stops it and launches the replacement command, writing every step to its log.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '..', '..')
const helper = path.join(repo, 'scripts', 'restart-dsh.mjs')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'craft-restart-'))
const logFile = path.join(work, 'restart.log')
const marker = path.join(work, 'relaunched.txt')
const markerFile = path.join(work, 'pending.json')

let failures = 0
const check = (name, ok, detail = '') => {
  if (ok) console.log(`PASS ${name}${detail ? ' — ' + detail : ''}`)
  else { failures += 1; console.log(`FAIL ${name}${detail ? ' — ' + detail : ''}`) }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }

const victimCode = "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"
const victim = spawn(process.execPath, ['-e', victimCode], { stdio: 'ignore', windowsHide: true })
fs.writeFileSync(markerFile, JSON.stringify({ at: Date.now(), pid: victim.pid }))
await sleep(300)
check('stand-in pid is running', alive(victim.pid), String(victim.pid))

// The replacement command runs detached; it writes a marker with its own pid so we can prove
// it was really launched after the victim was gone.
const relaunchCode = "require('node:fs').writeFileSync(process.argv[1],String(process.pid))"
const cmd = [process.execPath, '-e', relaunchCode, marker]
const helperProcess = spawn(process.execPath, [helper,
  '--pid', String(victim.pid),
  '--delay', '120',
  '--cmd', JSON.stringify(cmd),
  '--cwd', work,
  '--log', logFile,
], { stdio: 'ignore', windowsHide: true, env: { ...process.env, CRAFT_ANYTHING_RESTART_MARKER: markerFile } })

const exited = await new Promise((resolve) => {
  const timer = setTimeout(() => resolve('timeout'), 20000)
  helperProcess.on('exit', (code) => { clearTimeout(timer); resolve(code) })
})
check('helper exited', exited === 0, `code=${exited}`)
check('stand-in was stopped', !alive(victim.pid), String(victim.pid))

let relaunched = 0
for (let index = 0; index < 40 && !relaunched; index += 1) {
  await sleep(150)
  try { relaunched = Number(fs.readFileSync(marker, 'utf8')) } catch { /* not yet */ }
}
check('replacement was launched', Number.isFinite(relaunched) && relaunched > 0 && relaunched !== victim.pid, String(relaunched))
check('pending marker was removed', !fs.existsSync(markerFile))
const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : ''
check('log records stop + relaunch', /asking the Harness to stop/.test(log) && /relaunched pid/.test(log), log.replace(/\n/g, ' | ').slice(0, 400))

// Failure path: a pid that no longer exists must still relaunch (an app that crashed on quit).
const dead = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true })
const deadPid = dead.pid
dead.kill('SIGKILL')
await sleep(300)
const marker2 = path.join(work, 'relaunched2.txt')
const log2 = path.join(work, 'restart2.log')
const cmd2 = [process.execPath, '-e', relaunchCode, marker2]
const second = spawn(process.execPath, [helper, '--pid', String(deadPid), '--delay', '50',
  '--cmd', JSON.stringify(cmd2), '--cwd', work, '--log', log2],
  { stdio: 'ignore', windowsHide: true, env: { ...process.env } })
const secondExit = await new Promise((resolve) => { const t = setTimeout(() => resolve('timeout'), 15000); second.on('exit', (code) => { clearTimeout(t); resolve(code) }) })
check('helper handles an already-dead pid', secondExit === 0, `code=${secondExit}`)
let relaunched2 = 0
for (let index = 0; index < 30 && !relaunched2; index += 1) {
  await sleep(150)
  try { relaunched2 = Number(fs.readFileSync(marker2, 'utf8')) } catch { /* not yet */ }
}
check('dead-pid path still relaunches', relaunched2 > 0)
const log2Text = fs.existsSync(log2) ? fs.readFileSync(log2, 'utf8') : ''
check('dead-pid path logs already gone', /already gone/.test(log2Text), log2Text.slice(0, 200).replace(/\n/g, ' | '))

try { fs.rmSync(work, { recursive: true, force: true }) } catch { /* best effort */ }
console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
