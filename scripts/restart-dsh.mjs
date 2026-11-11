#!/usr/bin/env node
// dsh-craft-anything — detached Harness restarter.
//
// Started by the Host half (host/update.mjs → POST /craft-anything/api/restart) as a
// detached, stdio-less process, so it survives the Harness it is about to stop:
//
//   node restart-dsh.mjs --pid <harness pid> --delay 900 \
//        --cmd '["C:\\…\\DeepSeek Harness.exe"]' --cwd <dir> --log <file>
//
//  1. wait --delay ms so the HTTP response has left the Host process;
//  2. ask the process to stop (process.kill SIGTERM; on Windows this is TerminateProcess
//     for the main process — Electron's renderer/utility children exit with it);
//  3. if it is still alive after ~6 s, force it (taskkill /PID <pid> /F, then SIGKILL);
//  4. launch --cmd again, detached, with the current environment.
//
// It never touches other processes: only the pid it was given is stopped, and the pending
// marker is removed after a successful relaunch so a stuck restart does not block the next
// one. Every step is appended to --log.

import fs from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'

const argv = process.argv.slice(2)
const option = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback
}

const PID = Number(option('--pid', '0'))
const DELAY_MS = Math.max(0, Number(option('--delay', '900')) || 0)
const LOG_FILE = option('--log', '')
const CWD = option('--cwd', process.cwd())
let CMD = []
try {
  CMD = JSON.parse(option('--cmd', '[]'))
} catch {
  CMD = []
}

function logLine(line) {
  const text = `[${new Date().toISOString()}] ${line}`
  try {
    if (LOG_FILE) fs.appendFileSync(LOG_FILE, `${text}\n`)
  } catch { /* logging is best effort */ }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(150)
  }
  return !alive(pid)
}

async function main() {
  logLine(`restarter start: pid=${PID} delay=${DELAY_MS}ms cmd=${JSON.stringify(CMD)} cwd=${CWD}`)
  if (!Array.isArray(CMD) || CMD.length === 0 || typeof CMD[0] !== 'string') {
    logLine('ERROR: --cmd is missing or not a JSON array; nothing to relaunch')
    process.exit(2)
  }
  await sleep(DELAY_MS)
  if (alive(PID)) {
    logLine('asking the Harness to stop (SIGTERM/TerminateProcess)')
    try {
      process.kill(PID, 'SIGTERM')
    } catch (error) {
      logLine(`stop signal failed: ${String((error && error.message) || error)}`)
    }
    if (!(await waitForExit(PID, 6_000))) {
      logLine('still alive after 6 s; forcing it')
      if (process.platform === 'win32') {
        try {
          // No /T: the restarter is a child of this process tree, and Electron's helper
          // processes exit when the main process goes away.
          execFileSync('taskkill', ['/PID', String(PID), '/F'], { stdio: 'ignore' })
        } catch (error) {
          logLine(`taskkill failed: ${String((error && error.message) || error)}`)
        }
      }
      try {
        process.kill(PID, 'SIGKILL')
      } catch { /* already gone */ }
      if (!(await waitForExit(PID, 6_000))) {
        logLine('ERROR: the Harness is still alive; not relaunching (a second window would fight it)')
        process.exit(1)
      }
    }
    logLine('the Harness stopped')
  } else {
    logLine('the Harness pid is already gone; only relaunching')
  }
  logLine(`relaunching: ${CMD.join(' ')}`)
  try {
    const child = spawn(CMD[0], CMD.slice(1), {
      cwd: CWD,
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      env: { ...process.env },
    })
    child.unref()
    logLine(`relaunched pid ${child.pid}`)
    try {
      const marker = process.env.CRAFT_ANYTHING_RESTART_MARKER
      if (marker) fs.rmSync(marker, { force: true })
    } catch { /* marker cleanup is best effort */ }
  } catch (error) {
    logLine(`ERROR: relaunch failed: ${String((error && error.message) || error)}`)
    process.exit(1)
  }
}

main().catch((error) => {
  logLine(`ERROR: ${String((error && error.stack) || error)}`)
  process.exit(1)
})
