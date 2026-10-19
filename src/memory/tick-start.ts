import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../core/events'
import { locksDir } from './layout'
import { lockHeld } from './lock'
import { spawnCli } from './spawn'

export type TickTrigger = 'prompt' | 'cli' | 'session-start' | 'session-end' | 'compact' | 'window-reset'

export const TICK_DEBOUNCE_MS = 60_000

export const TICK_LOCK_STALE_MS = 15 * 60_000

export function tickLockFile(): string { return join(locksDir(), 'tick.lock') }

export function tickMarkFile(): string { return join(locksDir(), 'tick.mark') }

export function tickAgainFile(): string { return join(locksDir(), 'tick.again') }

export function tickDue(nowMs: number): boolean {
  try {
    const f = tickMarkFile()
    return !existsSync(f) || nowMs - statSync(f).mtimeMs >= TICK_DEBOUNCE_MS
  } catch {
    return true
  }
}

export function markTickAgain(nowMs: number): void {
  try {
    mkdirSync(locksDir(), { recursive: true })
    writeFileSync(tickAgainFile(), new Date(nowMs).toISOString() + '\n', { mode: 0o600 })
  } catch {  }
}

export function takeTickAgain(): boolean {
  try { unlinkSync(tickAgainFile()); return true } catch { return false }
}

export const TICK_TIMER_MAX_MS = 6 * 3600_000
export const TICK_TIMER_SLACK_MS = 60_000
const TICK_TIMER_ARM_MS = 2 * 60_000

export interface TickTimer { v: 1, due: string, armedAt: string, pid?: number }

export function tickTimerFile(): string { return join(locksDir(), 'tick.timer') }

export function readTickTimer(): TickTimer | undefined {
  try {
    const v = JSON.parse(readFileSync(tickTimerFile(), 'utf8')) as TickTimer
    return v !== null && typeof v === 'object' && v.v === 1 && typeof v.due === 'string' ? v : undefined
  } catch {
    return undefined
  }
}

function pidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

export function tickTimerPending(t: TickTimer | undefined, nowMs: number): boolean {
  if (t === undefined) return false
  if (t.pid !== undefined) return pidAlive(t.pid)
  const armed = Date.parse(t.armedAt)
  return Number.isFinite(armed) && nowMs - armed < TICK_TIMER_ARM_MS
}

export function timerDelayMs(nowMs: number, dueMs: number): number {
  return Math.min(Math.max(0, dueMs - nowMs), TICK_TIMER_MAX_MS)
}

function writeTickTimer(t: TickTimer): void {
  mkdirSync(locksDir(), { recursive: true })
  writeFileSync(tickTimerFile(), JSON.stringify(t) + '\n', { mode: 0o600 })
}

export function claimTickTimer(dueMs: number, nowMs: number): void {
  try { writeTickTimer({ v: 1, due: new Date(dueMs).toISOString(), armedAt: new Date(nowMs).toISOString(), pid: process.pid }) } catch {  }
}

export function clearTickTimer(pid = process.pid): void {
  try {
    const t = readTickTimer()
    if (t !== undefined && t.pid !== undefined && t.pid !== pid) return
    unlinkSync(tickTimerFile())
  } catch {  }
}

export function armTickTimer(opts: { dueMs: number, nowMs?: number, spawn?: (args: string[]) => number | undefined }): boolean {
  if (process.env['BURACLE_NO_AUTOSTART'] === '1' || process.env['BURACLE_NO_CAPTURE'] === '1') return false
  const nowMs = opts.nowMs ?? Date.now()
  try {
    const cur = readTickTimer()
    if (tickTimerPending(cur, nowMs) && Date.parse(cur?.due ?? '') <= opts.dueMs) return false
    const due = new Date(nowMs + timerDelayMs(nowMs, opts.dueMs)).toISOString()
    writeTickTimer({ v: 1, due, armedAt: new Date(nowMs).toISOString() })
    const pid = (opts.spawn ?? spawnCli)(['mem', 'tick', '--quiet', '--trigger', 'window-reset', '--at', due])
    if (pid === undefined) { try { unlinkSync(tickTimerFile()) } catch {  } return false }
    return true
  } catch {
    return false
  }
}

function claimTickMark(nowMs: number): boolean {
  const f = tickMarkFile()
  mkdirSync(locksDir(), { recursive: true })
  const parked = existsSync(tickAgainFile())
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(f, 'wx', 0o600)
      try { writeSync(fd, new Date(nowMs).toISOString() + '\n') } finally { closeSync(fd) }
      if (parked) takeTickAgain()
      return true
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e
    }
    try { if (!parked && nowMs - statSync(f).mtimeMs < TICK_DEBOUNCE_MS) return false } catch { continue }
    try { unlinkSync(f) } catch {  }
  }
  return false
}

export interface StartTickOptions {
  harness?: Harness
  sid?: string
  trigger?: TickTrigger
  nowMs?: number
  spawn?: (args: string[]) => number | undefined
}

export function maybeStartTick(opts: StartTickOptions = {}): boolean {
  if (process.env['BURACLE_NO_AUTOSTART'] === '1' || process.env['BURACLE_NO_CAPTURE'] === '1') return false
  const nowMs = opts.nowMs ?? Date.now()
  try {
    if (lockHeld(tickLockFile(), TICK_LOCK_STALE_MS, nowMs)) { markTickAgain(nowMs); return false }
    if (!claimTickMark(nowMs)) return false
    const args = ['mem', 'tick', '--quiet', '--trigger', opts.trigger ?? 'prompt', ...(opts.harness !== undefined ? ['--harness', opts.harness] : []), ...(opts.sid !== undefined ? ['--session', opts.sid] : [])]
    return (opts.spawn ?? spawnCli)(args) !== undefined
  } catch {
    return false
  }
}
