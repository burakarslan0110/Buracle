// The task board in the hooks of every harness: the join offer at session start, note delivery and the waiting→claimed
// resume at the next prompt or at the tool result that follows the question tool, the heartbeat, the write rule (a worker edits only its lane worktree, the
// lead never a claimed task's file), the stop guard's board input, the terminal sequence and the session end. Every
// helper fails open: a board it cannot read changes nothing, except the worker's write rule, which needs no board.
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Harness } from '../../core/events'
import type { BoardNote, BoardStopInput, BoardTask } from '../../core/board/model'
import { boardSummary, boardWriteDenial as coreWriteDenial, claimable, heartbeat, markDelivered, notesFor, release, resume, sweep } from '../../core/board/model'
import type { BoardBinding } from '../../core/plan/state'
import { atomicWriteSync } from '../../engine/fsx'
import { log } from '../../engine/log'
import { isValidSessionId, sessionDir } from '../../engine/paths'
import { boardCountsFor, checkoutRootOf, commonDirOf, listBoards, patchSessionBoard, readBoard, sessionBoard, setSessionBoard, takeAsked, takeTerminalSequence, updateBoard, type BoardCountsView } from '../../workflow/board-store'

/** A prompt or tool call renews the lease at most this often. */
export const HEARTBEAT_EVERY_MS = 30_000

function offerFile(h: Harness, sid: string): string | undefined {
  return isValidSessionId(sid) ? join(sessionDir(h, sid), 'board-offer.json') : undefined
}

function repoRootOf(commonDir: string): string {
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir
}

/**
 * Once per session: the boards of the repository that have a task ready for a worker, for a session that is neither
 * their lead nor a worker. The text asks the model to offer `/buracle-join <slug>` to the user, never to join on its own.
 * `joinCommand` is what the user types in this harness: `/buracle-join`, or `$buracle-join` in Codex.
 */
export function boardJoinOffer(h: Harness, sid: string, cwd: string, now: number, joinCommand = '/buracle-join'): string | undefined {
  try {
    if (sessionBoard(h, sid) !== undefined) return undefined
    const mark = offerFile(h, sid)
    if (mark === undefined || existsSync(mark)) return undefined
    const common = commonDirOf(cwd)
    if (common === undefined) return undefined
    const ready: string[] = []
    for (const b of listBoards(common)) {
      if (b.board === undefined) continue
      const board = sweep(b.board, now)
      if (board.lead.harness === h && board.lead.session === sid) continue
      const n = claimable(board).ready.length
      if (n > 0) ready.push(`\`${board.slug}\` (${n} task(s) ready, ${boardSummary(board).workers} worker(s) on it, lead ${board.lead.harness} ${board.lead.session})`)
    }
    if (ready.length === 0) return undefined
    atomicWriteSync(mark, JSON.stringify({ at: now }) + '\n')
    const slug = ready.length === 1 ? listBoards(common).find(b => b.board !== undefined && claimable(sweep(b.board, now)).ready.length > 0)?.slug ?? '<slug>' : '<slug>'
    return `Buracle task board: this repository has a board with tasks waiting for a worker: ${ready.join('; ')}. Tell the user in one line and offer to join: \`${joinCommand} ${slug}\` takes one task and works on it in its own worktree while the lead merges. Join only when the user says yes.`
  } catch (e) {
    log('warn', 'board: the join offer failed', { error: e })
    return undefined
  }
}

function sessionPath(sid: string): string { return sid.length > 12 ? `${sid.slice(0, 12)}…` : sid }

export function noteText(n: BoardNote): string {
  return `- [${n.kind}] from the ${n.role} (${n.from.harness} ${sessionPath(n.from.session)}): ${n.text}`
}

function notesBlock(notes: readonly BoardNote[], slug: string): string {
  return `Buracle task board ${slug}: ${notes.length} new note(s):\n${notes.map(noteText).join('\n')}`
}

function dropClaim(h: Harness, sid: string): void {
  patchSessionBoard(h, sid, { task: undefined, token: undefined, worktree: undefined, heartbeatAt: undefined })
}

interface Seen { context: string[]; deny?: string }

/** The board work a prompt or a tool call does for the session: resume a waiting task, renew the lease, deliver notes. */
function touch(h: Harness, sid: string, binding: BoardBinding, now: number, o: { write: boolean, always: boolean, resume: boolean }): Seen {
  const seen: Seen = { context: [] }
  const peek = readBoard(binding.path)
  if (peek === undefined) {
    if (!existsSync(binding.path)) {
      setSessionBoard(h, sid, undefined)
      if (binding.role === 'worker') seen.context.push(`Buracle task board ${binding.slug}: the board was closed; this session is no longer a worker.`)
    }
    return seen
  }
  const task = binding.task !== undefined ? peek.tasks.find(t => t.n === binding.task) : undefined
  const mine = task !== undefined && task.token === binding.token
  const due = o.always || now - (binding.heartbeatAt ?? 0) >= HEARTBEAT_EVERY_MS
  const pending = notesFor(peek, sid, binding.role)
  const needsWrite = pending.length > 0 || (binding.role === 'worker' && task !== undefined && (!mine || (task.status === 'waiting' && o.resume) || (task.status === 'claimed' && due)))
  if (!needsWrite) return seen
  let delivered: BoardNote[] = []
  let renewed = false
  const r = updateBoard(binding.path, now, b => {
    let board = b
    const t = binding.task !== undefined ? board.tasks.find(x => x.n === binding.task) : undefined
    if (binding.role === 'worker' && t !== undefined && binding.token !== undefined) {
      if (t.token !== binding.token) {
        seen.deny = `Buracle board guard: your task ${t.n} of ${board.slug} was reassigned (it is ${t.status}${t.worker !== undefined ? ` by ${t.worker.harness} ${t.worker.session}` : ''}): stop, then run \`buracle work join ${board.slug}\` for a new task.`
      } else if (t.status === 'waiting' && o.resume) {
        const res = resume(board, t.n, binding.token, now)
        if (res.ok) { board = res.board; renewed = true; seen.context.push(`Buracle task board: Task ${t.n} is claimed again (resumed after the question).`) }
      } else if (t.status === 'claimed' && due) {
        const hb = heartbeat(board, t.n, binding.token, now)
        if (hb.ok) { board = hb.board; renewed = true }
      }
    }
    delivered = notesFor(board, sid, binding.role)
    return { ok: true, board: markDelivered(board, delivered.map(n => n.seq), sid) }
  })
  if (!r.ok) {
    log('debug', 'board: the touch did not write', { code: r.code })
    return seen
  }
  if (seen.deny !== undefined) dropClaim(h, sid)
  else if (renewed) patchSessionBoard(h, sid, { heartbeatAt: now })
  if (delivered.length > 0) seen.context.push(notesBlock(delivered, binding.slug))
  if (seen.deny !== undefined && !o.write) { seen.context.push(seen.deny); delete seen.deny }
  return seen
}

/** At a prompt: notes for the session, a waiting task resumed (the prompt is the user's answer), the lease renewed; a reassigned task is reported. */
export function boardPromptNotice(h: Harness, sid: string, cwd: string, now: number): string | undefined {
  try {
    const binding = sessionBoard(h, sid)
    if (binding === undefined) return undefined
    takeAsked(h, sid, now)
    const seen = touch(h, sid, binding, now, { write: false, always: true, resume: true })
    return seen.context.length > 0 ? seen.context.join('\n\n') : undefined
  } catch (e) {
    log('warn', 'board: the prompt notice failed', { cwd, error: e })
    return undefined
  }
}

/**
 * At a tool call: the heartbeat (at most every 30 s) and the notes as context. A write tool checks the token every
 * time and is denied once the task was reassigned. A waiting task resumes only at a tool result (`phase` `after`),
 * because the question tool's answer produces no prompt, and never at the result of the command that asked (the
 * mark `work ask` left): the result of the question tool itself is the first one after it.
 */
export function boardToolSeen(h: Harness, sid: string, cwd: string, now: number, write: boolean, phase: 'before' | 'after'): { context?: string, deny?: string } | undefined {
  try {
    const binding = sessionBoard(h, sid)
    if (binding === undefined) return undefined
    const resume = phase === 'after' && !takeAsked(h, sid, now)
    // A write tool checks the token every time (a read of the board) but renews the lease only when it is due.
    const seen = touch(h, sid, binding, now, { write, always: false, resume })
    const out: { context?: string, deny?: string } = {}
    if (seen.context.length > 0) out.context = seen.context.join('\n\n')
    if (seen.deny !== undefined) out.deny = seen.deny
    return out.context === undefined && out.deny === undefined ? undefined : out
  } catch (e) {
    log('warn', 'board: the tool-call heartbeat failed', { cwd, error: e })
    return undefined
  }
}

function absolute(p: string, cwd: string, realpath: (q: string) => string | undefined): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd === '' ? '/' : cwd, p)
  const real = realpath(abs)
  return (real !== undefined && real !== '' ? real : abs).replace(/\\/g, '/')
}

/**
 * The board's write rule for the edit tools. A worker's rule needs only its binding; the lead's rule reads the board
 * and lets the write through when the board cannot be read.
 */
export function boardWriteDenial(h: Harness, sid: string, cwd: string, pathsToWrite: readonly string[], realpath: (q: string) => string | undefined = () => undefined): string | undefined {
  try {
    const binding = sessionBoard(h, sid)
    if (binding === undefined || pathsToWrite.length === 0) return undefined
    const common = commonDirOf(cwd) ?? commonDirOf(dirname(binding.path))
    if (common === undefined) return undefined
    const repoRoot = repoRootOf(common)
    if (binding.role === 'worker') {
      const wt = binding.worktree !== undefined ? absolute(binding.worktree, cwd, realpath) : undefined
      const view = { role: 'worker' as const, repoRoot, ...(binding.task !== undefined ? { task: binding.task } : {}), ...(wt !== undefined ? { worktree: wt } : {}) }
      for (const p of pathsToWrite) {
        const d = coreWriteDenial(view, absolute(p, cwd, realpath))
        if (d !== undefined) return d
      }
      return undefined
    }
    const board = readBoard(binding.path)
    if (board === undefined) return undefined
    // The lead edits in its own checkout: the main one, or the plan worktree of a worktree run. A task's files are
    // matched under both roots.
    const checkout = checkoutRootOf(cwd)
    const roots = checkout !== undefined && checkout !== repoRoot ? [checkout, repoRoot] : [repoRoot]
    for (const p of pathsToWrite) {
      const abs = absolute(p, cwd, realpath)
      for (const root of roots) {
        const d = coreWriteDenial({ role: 'lead', repoRoot: root, board }, abs)
        if (d !== undefined) return d
      }
    }
    return undefined
  } catch (e) {
    log('warn', 'board: the write rule failed; allowing', { cwd, error: e })
    return undefined
  }
}

/** The stop guard's view: the session's role, its task (only while claimed with the current token) and the counts. */
export function boardStopInput(h: Harness, sid: string, now: number): BoardStopInput | undefined {
  try {
    const binding = sessionBoard(h, sid)
    if (binding === undefined) return undefined
    const stored = readBoard(binding.path)
    if (stored === undefined) return undefined
    const board = sweep(stored, now)
    const out: BoardStopInput = { slug: board.slug, role: binding.role, summary: boardSummary(board) }
    const t: BoardTask | undefined = binding.task !== undefined ? board.tasks.find(x => x.n === binding.task) : undefined
    if (binding.role === 'worker' && t !== undefined && t.token === binding.token && (t.status === 'claimed' || t.status === 'waiting')) out.task = { n: t.n, status: t.status }
    return out
  } catch (e) {
    log('warn', 'board: the stop input failed', { error: e })
    return undefined
  }
}

/**
 * The session ends: a worker's claimed or waiting task goes back to open (its worktree stays) and its binding is
 * dropped. The lead keeps its binding: the board still names it as the lead, and the session may be resumed.
 */
export function boardSessionEnd(h: Harness, sid: string, now: number): void {
  try {
    const binding = sessionBoard(h, sid)
    if (binding === undefined || binding.role !== 'worker') return
    if (binding.task !== undefined && binding.token !== undefined) {
      const task = binding.task
      const token = binding.token
      updateBoard(binding.path, now, b => release(b, task, token, now, 'the worker session ended'))
    }
    setSessionBoard(h, sid, undefined)
  } catch (e) {
    log('warn', 'board: the session end failed', { error: e })
  }
}

/** The terminal sequence `work ask` left for a hook that owns the terminal; taken once. */
export function boardTerminalSequence(h: Harness, sid: string): string | undefined {
  try { return takeTerminalSequence(h, sid) } catch { return undefined }
}

/** The counts for a status line or band, or undefined without a board. */
export function boardCounts(h: Harness, sid: string, now: number): BoardCountsView | undefined {
  try { return boardCountsFor(h, sid, now) } catch { return undefined }
}
