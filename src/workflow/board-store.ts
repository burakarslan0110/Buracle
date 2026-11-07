// The task board on disk: one JSON file per plan under the repository's git common dir, read and written under a file
// lock. This module stays light on purpose: the hook helpers of every harness import it, so it pulls in no worktree,
// plan or git code. src/workflow/board.ts holds the commands that touch worktrees.
import { randomUUID } from 'node:crypto'
import { readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { Harness } from '../core/events'
import type { Board, BoardSummary } from '../core/board/model'
import { TASK_STATUSES, boardSummary, sweep } from '../core/board/model'
import type { BoardBinding } from '../core/plan/state'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync, realPath } from '../engine/fsx'
import { log } from '../engine/log'
import { isValidSessionId, sessionDir } from '../engine/paths'
import { isValidSlug } from './plan-file'
import { loadState, updateState, withFileLock } from './session-store'

export const BOARD_LOCK_TIMEOUT_MS = 5000
export const BOARD_LOCK_STALE_MS = 15_000

export function boardDir(commonDir: string): string { return join(commonDir, 'buracle', 'board') }

/** `<commonDir>/buracle/board/<slug>.json`; the slug must be a valid plan slug (callers validate first and report `usage`). */
export function boardPath(commonDir: string, slug: string): string {
  if (!isValidSlug(slug)) throw new Error(`invalid board slug '${slug}'`)
  return join(boardDir(commonDir), `${slug}.json`)
}

export function boardLockPath(path: string): string { return `${path}.lock` }

function realish(p: string): string {
  try { return realPath(p) } catch { return p }
}

/**
 * The git common dir of the repository that holds `cwd`, without a git subprocess: the nearest `.git` folder, or the
 * `gitdir:` file of a linked worktree, then its `commondir` file. The hooks run this on every prompt and tool call.
 */
export function commonDirOf(cwd: string): string | undefined {
  let dir = resolve(cwd)
  for (;;) {
    const dotGit = join(dir, '.git')
    let st: ReturnType<typeof statSync> | undefined
    try { st = statSync(dotGit) } catch { st = undefined }
    if (st !== undefined) {
      let gitDir: string
      if (st.isDirectory()) gitDir = dotGit
      else {
        let text = ''
        try { text = readFileSync(dotGit, 'utf8') } catch { return undefined }
        const m = /^gitdir:\s*(.+?)\s*$/m.exec(text)
        if (m === null || m[1] === undefined) return undefined
        gitDir = resolve(dir, m[1])
      }
      let common = gitDir
      try {
        const c = readFileSync(join(gitDir, 'commondir'), 'utf8').trim()
        if (c !== '') common = resolve(gitDir, c)
      } catch {  }
      return realish(common)
    }
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** The root of the checkout that holds `cwd`: the directory with its `.git` (a worktree has a `.git` file); undefined outside git. */
export function checkoutRootOf(cwd: string): string | undefined {
  let dir = resolve(cwd)
  for (;;) {
    let found = false
    try { statSync(join(dir, '.git')); found = true } catch { found = false }
    if (found) return realish(dir)
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

function isSession(x: unknown): boolean {
  return x !== null && typeof x === 'object' && typeof (x as { harness?: unknown }).harness === 'string' && typeof (x as { session?: unknown }).session === 'string'
}

export function isBoard(x: unknown): x is Board {
  if (x === null || typeof x !== 'object') return false
  const b = x as Record<string, unknown>
  if (b['v'] !== 1 || typeof b['slug'] !== 'string' || typeof b['plan'] !== 'string' || typeof b['base'] !== 'string') return false
  if (!isSession(b['lead']) || typeof b['maxWorkers'] !== 'number' || typeof b['leaseSec'] !== 'number' || typeof b['seq'] !== 'number') return false
  if (!Array.isArray(b['tasks']) || !Array.isArray(b['notes']) || !Array.isArray(b['events']) || !Array.isArray(b['constraints']) || typeof b['context'] !== 'string') return false
  return (b['tasks'] as unknown[]).every(t => t !== null && typeof t === 'object' && typeof (t as { n?: unknown }).n === 'number' && (TASK_STATUSES as readonly string[]).includes(String((t as { status?: unknown }).status)))
}

export type BoardRead = { ok: true, board: Board } | { ok: false, code: 'missing' | 'invalid', error: string }

export function readBoardFile(path: string): BoardRead {
  const r = readJsonSafeSync<unknown>(path)
  if (!r.ok) {
    if (r.code === 'missing') return { ok: false, code: 'missing', error: `no board at ${path}` }
    log('warn', 'board: the board file is unreadable', { path, error: r.error })
    return { ok: false, code: 'invalid', error: `the board file ${path} is unreadable: ${String(r.error)}` }
  }
  if (!isBoard(r.value)) {
    log('warn', 'board: the board file has an unexpected shape', { path })
    return { ok: false, code: 'invalid', error: `the board file ${path} has an unexpected shape (not a v1 board)` }
  }
  return { ok: true, board: r.value }
}

/** The board, or undefined when the file is missing or unreadable (a warning is logged). */
export function readBoard(path: string): Board | undefined {
  const r = readBoardFile(path)
  return r.ok ? r.board : undefined
}

export function writeBoard(path: string, board: Board): void {
  ensureDirSync(dirname(path))
  atomicWriteSync(path, JSON.stringify(board, null, 2) + '\n')
}

export function removeBoard(path: string): void {
  for (const p of [path, boardLockPath(path)]) {
    try { unlinkSync(p) } catch {  }
  }
}

export type StoreResult = { ok: true, board: Board, changed: boolean } | { ok: false, code: string, message: string }
export type BoardChange = { ok: true, board: Board } | { ok: false, code: string, message: string }

/** BURACLE_LOCK_TIMEOUT_MS shortens the wait in tests, as it does for the repository lock. */
function lockTimeoutMs(): number {
  const raw = process.env['BURACLE_LOCK_TIMEOUT_MS']
  const n = raw !== undefined ? Number(raw) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : BOARD_LOCK_TIMEOUT_MS
}

function locked<T>(path: string, fn: () => T): T | { ok: false, code: 'locked', message: string } {
  try {
    return withFileLock(path, fn, lockTimeoutMs(), BOARD_LOCK_STALE_MS)
  } catch (e) {
    return { ok: false, code: 'locked', message: `the board ${path} is busy: ${e instanceof Error ? e.message : String(e)}; try again` }
  }
}

/**
 * Read-modify-write under the board's lock. The board is swept first (expired leases turn stale), then `fn` runs; the
 * file is written when the board changed. A missing board is `no_board`, an unreadable one is left alone (`unreadable`).
 */
export function updateBoard(path: string, now: number, fn: (board: Board) => BoardChange): StoreResult {
  return locked(path, (): StoreResult => {
    const r = readBoardFile(path)
    if (!r.ok) return { ok: false, code: r.code === 'missing' ? 'no_board' : 'unreadable', message: r.error }
    const swept = sweep(r.board, now)
    const res = fn(swept)
    if (!res.ok) {
      if (swept !== r.board) writeBoard(path, swept)
      return res
    }
    const changed = res.board !== r.board
    if (changed) writeBoard(path, res.board)
    return { ok: true, board: res.board, changed }
  })
}

/** Creates the board, or merges a fresh publish into the existing one. An unreadable file is never overwritten. */
export function publishBoard(path: string, fresh: Board, merge: (old: Board, fresh: Board) => { board: Board, changed: number[] }): StoreResult & { changedTasks?: number[] } {
  return locked(path, (): StoreResult & { changedTasks?: number[] } => {
    const r = readBoardFile(path)
    if (!r.ok && r.code === 'invalid') return { ok: false, code: 'unreadable', message: `${r.error}; it was not overwritten` }
    if (!r.ok) {
      writeBoard(path, fresh)
      return { ok: true, board: fresh, changed: true, changedTasks: [] }
    }
    const merged = merge(sweep(r.board, fresh.updatedAt), fresh)
    writeBoard(path, merged.board)
    return { ok: true, board: merged.board, changed: true, changedTasks: merged.changed }
  })
}

export interface BoardListing { slug: string, path: string, board?: Board }

export function listBoards(commonDir: string): BoardListing[] {
  let names: string[] = []
  try { names = readdirSync(boardDir(commonDir)).filter(n => n.endsWith('.json')).sort() } catch { return [] }
  return names.map(n => {
    const slug = n.slice(0, -5)
    const path = join(boardDir(commonDir), n)
    const board = readBoard(path)
    return board !== undefined ? { slug, path, board } : { slug, path }
  })
}

export function summaryOf(board: Board): BoardSummary { return boardSummary(board) }

export interface BoardCountsView { slug: string; role: BoardBinding['role']; summary: BoardSummary }

/** The counts a status line or band shows for the session's board, or undefined without one. */
export function boardCountsFor(h: Harness, sid: string | undefined, now: number): BoardCountsView | undefined {
  if (sid === undefined || !isValidSessionId(sid)) return undefined
  const binding = sessionBoard(h, sid)
  if (binding === undefined) return undefined
  const board = readBoard(binding.path)
  if (board === undefined) return undefined
  return { slug: board.slug, role: binding.role, summary: boardSummary(sweep(board, now)) }
}

export function newToken(): string { return randomUUID() }

export function sessionBoard(h: Harness, sid: string): BoardBinding | undefined {
  return loadState(h, sid).board
}

/** Writes or clears the session's place on a board; `undefined` removes it. */
export function setSessionBoard(h: Harness, sid: string, binding: BoardBinding | undefined): void {
  updateState(h, sid, st => {
    const { board: _b, ...rest } = st
    return binding === undefined ? rest : { ...rest, board: binding }
  })
}

function terminalFile(h: Harness, sid: string): string | undefined {
  return isValidSessionId(sid) ? join(sessionDir(h, sid), 'board-terminal.json') : undefined
}

/** `work ask` leaves the terminal sequence here; a hook that owns the terminal (Claude's terminalSequence, the omp and OpenCode runtimes) emits it once. */
export function writeTerminalSequence(h: Harness, sid: string, sequence: string, now: number): void {
  const file = terminalFile(h, sid)
  if (file === undefined) return
  try {
    ensureDirSync(dirname(file))
    atomicWriteSync(file, JSON.stringify({ sequence, at: now }) + '\n')
  } catch (e) {
    log('warn', 'board: the terminal sequence was not saved', { error: e })
  }
}

export function takeTerminalSequence(h: Harness, sid: string): string | undefined {
  const file = terminalFile(h, sid)
  if (file === undefined) return undefined
  const r = readJsonSafeSync<{ sequence?: unknown }>(file)
  try { unlinkSync(file) } catch {  }
  return r.ok && typeof r.value?.sequence === 'string' && r.value.sequence !== '' ? r.value.sequence : undefined
}

/** An ask mark older than this is ignored: the tool result of the command that asked arrives within seconds. */
const ASKED_MAX_MS = 60_000

function askedFile(h: Harness, sid: string): string | undefined {
  return isValidSessionId(sid) ? join(sessionDir(h, sid), 'board-asked.json') : undefined
}

/**
 * `work ask` leaves this mark: the tool result of the command that asked is not the user's answer, so the first
 * tool result after the ask resumes nothing (the one after the question tool does).
 */
export function markAsked(h: Harness, sid: string, now: number): void {
  const file = askedFile(h, sid)
  if (file === undefined) return
  try {
    ensureDirSync(dirname(file))
    atomicWriteSync(file, JSON.stringify({ at: now }) + '\n')
  } catch (e) {
    log('warn', 'board: the ask mark was not saved', { error: e })
  }
}

/** Takes the ask mark: true when `work ask` ran within the last minute, so this tool result is the ask's own. */
export function takeAsked(h: Harness, sid: string, now: number): boolean {
  const file = askedFile(h, sid)
  if (file === undefined) return false
  const r = readJsonSafeSync<{ at?: unknown }>(file)
  try { unlinkSync(file) } catch {  }
  return r.ok && typeof r.value?.at === 'number' && now - r.value.at <= ASKED_MAX_MS
}

export function patchSessionBoard(h: Harness, sid: string, patch: Partial<BoardBinding>): BoardBinding | undefined {
  let out: BoardBinding | undefined
  updateState(h, sid, st => {
    if (st.board === undefined) return st
    out = { ...st.board, ...patch }
    for (const k of Object.keys(patch) as Array<keyof BoardBinding>) if (patch[k] === undefined) delete out[k]
    return { ...st, board: out }
  })
  return out
}
