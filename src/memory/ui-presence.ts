import { closeSync, mkdirSync, openSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../core/events'
import { isHarness } from '../core/events'
import { loadConfigSync } from '../engine/config'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { spawnCli } from './spawn'
import { processAlive, readUiRecord } from './ui-record'

// The memory web UI lives as long as a harness session is open (memory.ui.autostart). Each harness marks its open
// sessions here, apart from the memory's own session records: those depend on the capture being on, and OpenCode
// ends a session after 10 idle minutes while its window is still open. The hooks call this on every session start,
// prompt, tool call and session end, so all of it is a few file operations and never waits for the UI.

/** A session with no start, prompt or tool call for this long counts as ended (a killed harness). */
export const UI_SESSION_STALE_MS = 2 * 3600_000
/** A prompt or tool call refreshes the record at most this often. */
export const UI_SESSION_REFRESH_MS = 10 * 60_000
/** A start marker older than this belongs to a start that died. */
export const UI_SPAWN_MARKER_MS = 15_000

type Env = Readonly<Record<string, string | undefined>>

/** No UI and no record for the memory's own model-call children, and nothing at all under BURACLE_NO_AUTOSTART=1. */
function quiet(env: Env): boolean {
  return env['BURACLE_NO_AUTOSTART'] === '1' || env['BURACLE_MEMORY_RUNNER'] === '1'
}

function recordFile(h: Harness, sid: string): string | undefined {
  return isHarness(h) && paths.isValidSessionId(sid) ? join(paths.uiSessionsDir(), `${h}-${sid}`) : undefined
}

function touch(file: string, nowMs: number): void {
  mkdirSync(paths.uiSessionsDir(), { recursive: true })
  try { closeSync(openSync(file, 'a')) } catch {  }
  const t = new Date(nowMs)
  utimesSync(file, t, t)
}

export function sessionOpened(h: Harness, sid: string, nowMs: number = Date.now(), env: Env = process.env): void {
  if (quiet(env)) return
  const file = recordFile(h, sid)
  if (file === undefined) return
  try { touch(file, nowMs) } catch (e) { log('warn', 'memory ui: cannot mark the session open', { h, error: e }) }
}

/**
 * A prompt or a tool call: refreshes the record when it is older than UI_SESSION_REFRESH_MS. 'revived' when the session
 * had no record or a stale one (it had counted as ended, so the UI may have stopped and the caller starts it again).
 */
export function sessionSeen(h: Harness, sid: string, nowMs: number = Date.now(), env: Env = process.env): 'fresh' | 'revived' {
  if (quiet(env)) return 'fresh'
  const file = recordFile(h, sid)
  if (file === undefined) return 'fresh'
  let mtime: number | undefined
  try { mtime = statSync(file).mtimeMs } catch { mtime = undefined }
  if (mtime !== undefined && nowMs - mtime < UI_SESSION_REFRESH_MS) return 'fresh'
  try { touch(file, nowMs) } catch (e) { log('warn', 'memory ui: cannot refresh the session', { h, error: e }) }
  return mtime === undefined || nowMs - mtime >= UI_SESSION_STALE_MS ? 'revived' : 'fresh'
}

export function sessionClosed(h: Harness, sid: string): void {
  const file = recordFile(h, sid)
  if (file === undefined) return
  try { rmSync(file, { force: true }) } catch {  }
}

/** The sessions still open. A stale record belongs to a harness that was killed, so it is removed instead of counted. */
export function openSessionCount(nowMs: number = Date.now()): number {
  let names: string[]
  try { names = readdirSync(paths.uiSessionsDir()) } catch { return 0 }
  let n = 0
  for (const name of names) {
    const file = join(paths.uiSessionsDir(), name)
    try {
      if (nowMs - statSync(file).mtimeMs < UI_SESSION_STALE_MS) n++
      else rmSync(file, { force: true })
    } catch {  }
  }
  return n
}

export type UiStart = 'running' | 'started' | 'busy' | 'off' | 'failed'

export interface UiStartOptions {
  /** memory.ui.autostart; read from the configuration when not given. */
  autostart?: boolean
  /** The UI build of this checkout (a session start passes it): a running UI of another build is replaced. */
  build?: string
  spawn?: (args: readonly string[]) => number | undefined
  env?: Env
  nowMs?: number
}

/** How startUiSoon starts the detached UI when its caller passes no `spawn` (tests replace it to count the starts). */
export const uiPresenceDeps: { spawn: (args: readonly string[]) => number | undefined } = { spawn: args => spawnCli(args) }

function autostartOn(): boolean {
  try { return loadConfigSync({ repoRoot: paths.repoRoot() }).config.memory.ui.autostart } catch { return true }
}

/**
 * Starts the memory UI when it is not running, without waiting for it: a detached `buracle mem ui --serve` (which itself
 * refuses to run twice and stops a UI of another build). Never throws; costs a file read and a signal-0 when the UI runs.
 */
export function startUiSoon(opts: UiStartOptions = {}): UiStart {
  const env = opts.env ?? process.env
  if (quiet(env)) return 'off'
  try {
    const rec = readUiRecord()
    if (rec !== undefined && processAlive(rec.pid) && (opts.build === undefined || rec.build === undefined || rec.build === opts.build)) return 'running'
    if (!(opts.autostart ?? autostartOn())) return 'off'
    const marker = paths.memoryUiSpawnMarker()
    mkdirSync(paths.stateDir(), { recursive: true })
    const now = opts.nowMs ?? Date.now()
    let fd: number
    try {
      fd = openSync(marker, 'wx')
    } catch {
      let stale = false
      try { stale = now - statSync(marker).mtimeMs >= UI_SPAWN_MARKER_MS } catch { stale = true }
      if (!stale) return 'busy'
      rmSync(marker, { force: true })
      try { fd = openSync(marker, 'wx') } catch { return 'busy' }
    }
    closeSync(fd)
    let pid: number | undefined
    try { pid = (opts.spawn ?? uiPresenceDeps.spawn)(['mem', 'ui', '--serve']) } catch (e) { log('warn', 'memory ui: cannot start it', { error: e }) }
    if (pid === undefined) {
      rmSync(marker, { force: true })
      return 'failed'
    }
    return 'started'
  } catch (e) {
    log('warn', 'memory ui: the start check failed', { error: e })
    return 'failed'
  }
}
