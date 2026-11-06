import { readFileSync } from 'node:fs'

/** How often a per-session MCP process checks that its harness still runs: at most this long plus the stop passes after a SIGKILL of the harness. */
export const PARENT_POLL_MS = 2_000

/** BURACLE_MCP_PARENT_POLL_MS (milliseconds) sets the poll interval; a value that is not a positive number is ignored. */
export function parentPollMs(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const raw = env['BURACLE_MCP_PARENT_POLL_MS']
  if (raw === undefined || raw.trim() === '') return PARENT_POLL_MS
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : PARENT_POLL_MS
}

export interface ParentWatch { stop(): void }

/** Linux init processes that adopt orphans as pid 1 (`init` is also WSL 2's). A harness that is pid 1 itself, in a container without an init, is none of them. */
const INIT_NAMES = new Set(['systemd', 'init', 'tini', 'docker-init', 'dumb-init', 'catatonit', 's6-svscan', 'runit', 'openrc-init'])

/** Whether pid 1 is an init that adopts orphans: always launchd on macOS; on Linux the name in /proc/1/comm decides. */
function pid1IsInit(): boolean {
  if (process.platform === 'darwin') return true
  try { return INIT_NAMES.has(readFileSync('/proc/1/comm', 'utf8').trim()) } catch { return false }
}

/**
 * Calls `onGone` once when the parent process is gone: a harness killed by SIGKILL never closes the pipes
 * a grandchild may still hold, so stdin EOF alone does not stop a per-session server. The parent pid is
 * read at the start and polled; a new value means the process was reparented (to pid 1 or a subreaper).
 * A parent that is already pid 1 at the start counts as gone too when pid 1 is an init: a harness always
 * starts these servers itself, so the harness died while the server was still starting. A harness that is
 * pid 1 itself (a container) keeps its servers. The timer does not keep the process alive.
 */
export function watchParent(opts: { onGone: () => void, intervalMs?: number, ppid?: () => number, pid1IsInit?: () => boolean }): ParentWatch {
  const read = opts.ppid ?? (() => process.ppid)
  const start = read()
  const goneAtStart = start === 1 && (opts.pid1IsInit ?? pid1IsInit)()
  let done = false
  const timer = setInterval(() => {
    if (done) return
    if (!goneAtStart && read() === start) return
    done = true
    clearInterval(timer)
    opts.onGone()
  }, opts.intervalMs ?? parentPollMs())
  timer.unref?.()
  return { stop: () => { done = true; clearInterval(timer) } }
}
