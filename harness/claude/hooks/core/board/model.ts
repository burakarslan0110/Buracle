// The task board: a plan's open tasks, shared by every session of one repository. This module holds the
// pure state transitions; src/workflow/board-store.ts reads and writes the file under a lock, and
// src/workflow/board.ts runs the commands that touch worktrees. Time and tokens come in as parameters.
import type { Harness } from '../events'
import type { PlanTask, PlanType } from '../plan/format'

export type TaskStatus = 'open' | 'claimed' | 'waiting' | 'done' | 'merged' | 'stale'
export const TASK_STATUSES: readonly TaskStatus[] = ['open', 'claimed', 'waiting', 'done', 'merged', 'stale']
export type BoardRole = 'lead' | 'worker'
export const BOARD_VERSION = 1

export interface BoardSession { harness: Harness; session: string }
export type BoardFile = PlanTask['files'][number]
export interface BoardWorktree { slug: string; path: string; branch: string; base: string }
export interface BoardReport { branch: string; commits: string[]; verify: string; at?: number }

export interface BoardTask {
  n: number
  title: string
  objective: string
  files: BoardFile[]
  dod: string
  deps: number[]
  /** The plan's `**Harness:**` line: only workers of this harness may claim the task. */
  harness?: Harness
  status: TaskStatus
  worker?: BoardSession
  token?: string
  claimedAt?: number
  heartbeatAt?: number
  leaseUntil?: number
  worktree?: BoardWorktree
  question?: string
  report?: BoardReport
  lastWorker?: BoardSession
}

export type NoteKind = 'report' | 'question' | 'nudge'
export const NOTE_KINDS: readonly NoteKind[] = ['report', 'question', 'nudge']
export interface BoardNote { seq: number; from: BoardSession; role: BoardRole; to: 'lead' | 'all' | string; kind: NoteKind; text: string; at: number; deliveredTo: string[] }

export type BoardEventKind = 'published' | 'claimed' | 'waiting' | 'resumed' | 'done' | 'merged' | 'stale' | 'released' | 'reopened' | 'note'
export interface BoardEvent { seq: number; kind: BoardEventKind; at: number; task?: number; session?: string; harness?: Harness; text?: string; note?: number }

export interface Board {
  v: 1
  slug: string
  plan: string
  planType: PlanType
  base: string
  parent?: string
  lead: BoardSession
  maxWorkers: number
  leaseSec: number
  constraints: string[]
  context: string
  tasks: BoardTask[]
  notes: BoardNote[]
  events: BoardEvent[]
  seq: number
  createdAt: number
  updatedAt: number
}

export interface BoardSummary { open: number; claimed: number; waiting: number; done: number; merged: number; stale: number; workers: number; total: number }

export type BoardErrorCode = 'usage' | 'task_not_open' | 'deps_unmerged' | 'wrong_harness' | 'not_claimed_by_you' | 'reassigned' | 'not_found'
export type BoardResult = { ok: true; board: Board } | { ok: false; code: BoardErrorCode; message: string }

export interface BoardFromPlanOptions {
  slug: string
  plan: string
  planType: PlanType
  base: string
  parent?: string
  lead: BoardSession
  maxWorkers: number
  leaseSec: number
  constraints: string[]
  context: string
  now: number
}

function fail(code: BoardErrorCode, message: string): BoardResult { return { ok: false, code, message } }
function okBoard(board: Board): BoardResult { return { ok: true, board } }

/** The repository-relative paths a Files line names: a Rename line names both sides. */
export function pathsOf(file: BoardFile): string[] {
  const raw = file.path.trim().replace(/`/g, '')
  const parts = file.verb === 'Rename' ? raw.split(/\s*->\s*/) : [raw]
  return parts.map(normalizePlanPath).filter(p => p !== '')
}

export function normalizePlanPath(p: string): string {
  let s = p.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/')
  while (s.startsWith('./')) s = s.slice(2)
  return s
}

function pathsOverlap(a: string, b: string): boolean {
  if (a === b) return true
  if (a.endsWith('/') && b.startsWith(a)) return true
  if (b.endsWith('/') && a.startsWith(b)) return true
  return false
}

export function filesOverlap(a: readonly BoardFile[], b: readonly BoardFile[]): boolean {
  const left = a.flatMap(pathsOf)
  const right = b.flatMap(pathsOf)
  return left.some(p => right.some(q => pathsOverlap(p, q)))
}

function sharedPath(a: readonly BoardFile[], b: readonly BoardFile[]): string | undefined {
  const right = b.flatMap(pathsOf)
  for (const p of a.flatMap(pathsOf)) {
    const hit = right.find(q => pathsOverlap(p, q))
    if (hit !== undefined) return p.length <= hit.length ? p : hit
  }
  return undefined
}

function taskOf(t: PlanTask, deps: number[]): BoardTask {
  return {
    n: t.n, title: t.title, objective: t.objective ?? '', files: t.files.map(f => ({ verb: f.verb, path: f.path })), dod: t.dod ?? '', deps,
    ...(t.harness !== undefined ? { harness: t.harness } : {}), status: t.done ? 'merged' : 'open',
  }
}

function event(board: Board, kind: BoardEventKind, at: number, extra: Omit<BoardEvent, 'seq' | 'kind' | 'at'> = {}): Board {
  const seq = board.seq + 1
  return { ...board, seq, updatedAt: at, events: [...board.events, { seq, kind, at, ...extra }] }
}

function sessionFields(s: BoardSession | undefined): Pick<BoardEvent, 'session' | 'harness'> {
  return s === undefined ? {} : { session: s.session, harness: s.harness }
}

export function boardFromPlan(tasks: readonly PlanTask[], o: BoardFromPlanOptions): BoardResult {
  const known = new Set(tasks.map(t => t.n))
  const out: BoardTask[] = []
  for (const t of tasks) {
    const deps = new Set<number>()
    for (const earlier of tasks) {
      if (earlier.n >= t.n) continue
      if (filesOverlap(earlier.files, t.files)) deps.add(earlier.n)
    }
    for (const d of t.dependsOn ?? []) {
      if (!known.has(d)) return fail('usage', `Task ${t.n} depends on Task ${d}, which the plan does not have`)
      if (d === t.n) return fail('usage', `Task ${t.n} depends on itself`)
      if (d > t.n) return fail('usage', `Task ${t.n} depends on Task ${d}, a later task: order the tasks by dependency`)
      deps.add(d)
    }
    out.push(taskOf(t, [...deps].sort((a, b) => a - b)))
  }
  const base: Board = {
    v: 1, slug: o.slug, plan: o.plan, planType: o.planType, base: o.base, ...(o.parent !== undefined ? { parent: o.parent } : {}),
    lead: o.lead, maxWorkers: o.maxWorkers, leaseSec: o.leaseSec, constraints: [...o.constraints], context: o.context,
    tasks: out, notes: [], events: [], seq: 0, createdAt: o.now, updatedAt: o.now,
  }
  return okBoard(event(base, 'published', o.now, sessionFields(o.lead)))
}

function sameFiles(a: readonly BoardFile[], b: readonly BoardFile[]): boolean {
  if (a.length !== b.length) return false
  return a.every((f, i) => f.verb === b[i]?.verb && f.path === b[i]?.path)
}

function sameDeps(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i])
}

/**
 * A second publish: the old board keeps every state and worker; open and stale tasks take the plan's current files, deps
 * and harness; an active task whose files, deps or harness changed keeps the board's values and is reported in `changed`;
 * a task the plan unticked while the board says merged reopens (its worktree and report stay). New tasks are added.
 */
export function mergeBoard(old: Board, fresh: Board): { board: Board, changed: number[] } {
  const changed: number[] = []
  let events: BoardEvent[] = [...old.events]
  let seq = old.seq
  const tasks: BoardTask[] = []
  for (const f of fresh.tasks) {
    const prev = old.tasks.find(t => t.n === f.n)
    if (prev === undefined) { tasks.push(f); continue }
    const { status: _s, deps: _d, files: _f, title: _t, objective: _o, dod: _dod, harness: _hz, ...keep } = prev
    const text = { title: f.title, objective: f.objective, dod: f.dod }
    const reserved = f.harness !== undefined ? { harness: f.harness } : {}
    if (prev.status === 'open' || prev.status === 'stale') {
      tasks.push({ ...keep, ...text, files: f.files, deps: f.deps, ...reserved, status: prev.status })
      continue
    }
    if (prev.status === 'merged' && f.status !== 'merged') {
      const { worker: _w, token: _k, leaseUntil: _l, claimedAt: _c, heartbeatAt: _h, question: _q, ...rest } = keep
      tasks.push({ ...rest, ...text, files: f.files, deps: f.deps, ...reserved, status: 'open' })
      seq++
      events.push({ seq, kind: 'reopened', at: fresh.updatedAt, task: f.n, text: 'the plan unticked the task' })
      changed.push(f.n)
      continue
    }
    const drift = !sameFiles(prev.files, f.files) || !sameDeps(prev.deps, f.deps) || prev.harness !== f.harness
    if (drift) changed.push(f.n)
    tasks.push({ ...prev, ...text })
  }
  for (const t of old.tasks) if (!fresh.tasks.some(f => f.n === t.n)) tasks.push(t)
  tasks.sort((a, b) => a.n - b.n)
  seq++
  events = [...events, { seq, kind: 'published', at: fresh.updatedAt, ...sessionFields(fresh.lead) }]
  const board: Board = {
    ...old, lead: fresh.lead, base: fresh.base, maxWorkers: fresh.maxWorkers, leaseSec: fresh.leaseSec, constraints: fresh.constraints, context: fresh.context,
    plan: fresh.plan, planType: fresh.planType, tasks, events, seq, updatedAt: fresh.updatedAt,
  }
  if (fresh.parent !== undefined) board.parent = fresh.parent
  else delete board.parent
  return { board, changed: changed.sort((a, b) => a - b) }
}

/** Expired leases: the task turns stale and keeps its worktree, so the next worker resumes from it. Waiting tasks keep no lease. */
export function sweep(board: Board, now: number): Board {
  let out = board
  for (const t of board.tasks) {
    if (t.status !== 'claimed' || t.leaseUntil === undefined || t.leaseUntil >= now) continue
    const { worker, token: _token, leaseUntil: _lease, claimedAt: _c, heartbeatAt: _h, ...rest } = t
    const stale: BoardTask = { ...rest, status: 'stale', ...(worker !== undefined ? { lastWorker: worker } : {}) }
    out = event({ ...out, tasks: out.tasks.map(x => (x.n === t.n ? stale : x)) }, 'stale', now, { task: t.n, ...sessionFields(worker) })
  }
  return out
}

const ACTIVE: readonly TaskStatus[] = ['claimed', 'waiting', 'done']

export interface ClaimableView { ready: number[]; blocked: Array<{ n: number, reason: 'deps' | 'files' | 'harness', detail: string }> }

/** `harness` is the asking worker's; without it (the lead's overview) a reservation blocks nothing. */
function blocker(board: Board, t: BoardTask, harness?: Harness): ClaimableView['blocked'][number] | undefined {
  if (harness !== undefined && t.harness !== undefined && t.harness !== harness) return { n: t.n, reason: 'harness', detail: `is reserved for ${t.harness}` }
  const unmerged = t.deps.filter(d => board.tasks.find(x => x.n === d)?.status !== 'merged')
  if (unmerged.length > 0) return { n: t.n, reason: 'deps', detail: `waits for ${unmerged.map(d => `Task ${d}`).join(', ')}` }
  for (const other of board.tasks) {
    if (other.n === t.n || !ACTIVE.includes(other.status)) continue
    const shared = sharedPath(t.files, other.files)
    if (shared !== undefined) return { n: t.n, reason: 'files', detail: `shares ${shared} with Task ${other.n}` }
  }
  return undefined
}

/**
 * The tasks a worker may claim now, in number order, and why the other open ones wait. Run `sweep` first. With `harness`,
 * a task reserved for another harness is blocked (`reason: 'harness'`); without it every reserved task counts as ready.
 */
export function claimable(board: Board, harness?: Harness): ClaimableView {
  const view: ClaimableView = { ready: [], blocked: [] }
  for (const t of [...board.tasks].sort((a, b) => a.n - b.n)) {
    if (t.status !== 'open' && t.status !== 'stale') continue
    const b = blocker(board, t, harness)
    if (b === undefined) view.ready.push(t.n)
    else view.blocked.push(b)
  }
  return view
}

export function activeWorkers(board: Board): BoardSession[] {
  const out: BoardSession[] = []
  for (const t of board.tasks) {
    if ((t.status !== 'claimed' && t.status !== 'waiting') || t.worker === undefined) continue
    if (!out.some(w => w.harness === t.worker?.harness && w.session === t.worker.session)) out.push(t.worker)
  }
  return out
}

function find(board: Board, n: number): BoardTask | undefined {
  return board.tasks.find(t => t.n === n)
}

function replace(board: Board, next: BoardTask): Board {
  return { ...board, tasks: board.tasks.map(t => (t.n === next.n ? next : t)) }
}

function owned(board: Board, n: number, token: string, statuses: readonly TaskStatus[]): BoardTask | BoardResult {
  const t = find(board, n)
  if (t === undefined) return fail('not_found', `the board has no Task ${n}`)
  if (!statuses.includes(t.status)) return fail('task_not_open', `Task ${n} is ${t.status}, not ${statuses.join(' or ')}`)
  if (t.token !== token) return fail('not_claimed_by_you', `Task ${n} is claimed by ${t.worker !== undefined ? `${t.worker.harness} ${t.worker.session}` : 'another session'}, not by this session`)
  return t
}

function isTask(x: BoardTask | BoardResult): x is BoardTask { return 'n' in x }

/** Claims an open or stale task for a worker. The token comes from the IO layer; the lease runs leaseSec from now. */
export function claim(board: Board, n: number, worker: BoardSession, now: number, token: string): BoardResult {
  const t = find(board, n)
  if (t === undefined) return fail('not_found', `the board has no Task ${n}`)
  if (t.status !== 'open' && t.status !== 'stale') return fail('task_not_open', `Task ${n} is ${t.status}${t.worker !== undefined ? ` by ${t.worker.harness} ${t.worker.session}` : ''}`)
  const b = blocker(board, t, worker.harness)
  if (b !== undefined) {
    if (b.reason === 'harness') return fail('wrong_harness', `Task ${n} is reserved for ${t.harness ?? '?'} workers`)
    return fail(b.reason === 'deps' ? 'deps_unmerged' : 'task_not_open', `Task ${n} ${b.detail}`)
  }
  const { lastWorker: _lw, ...rest } = t
  const next: BoardTask = { ...rest, status: 'claimed', worker, token, claimedAt: now, heartbeatAt: now, leaseUntil: now + board.leaseSec * 1000 }
  return okBoard(event(replace(board, next), 'claimed', now, { task: n, ...sessionFields(worker) }))
}

/** Undoes a claim whose worktree could not be created: the task returns to the snapshot taken before the claim. */
export function unclaim(board: Board, n: number, token: string, previous: BoardTask, now: number, reason: string): BoardResult {
  const t = find(board, n)
  if (t === undefined) return fail('not_found', `the board has no Task ${n}`)
  if (t.status !== 'claimed' || t.token !== token) return fail('reassigned', `Task ${n} is no longer claimed by this session`)
  return okBoard(event(replace(board, { ...previous, n }), 'released', now, { task: n, ...sessionFields(t.worker), text: reason }))
}

/** Records the lane worktree a claimed task works in; it stays on the task through stale and reopen. */
export function setWorktree(board: Board, n: number, token: string, worktree: BoardWorktree): BoardResult {
  const t = owned(board, n, token, ['claimed'])
  if (!isTask(t)) return t
  return okBoard(replace(board, { ...t, worktree }))
}

export function heartbeat(board: Board, n: number, token: string, now: number): BoardResult {
  const t = find(board, n)
  if (t === undefined) return fail('not_found', `the board has no Task ${n}`)
  if (t.status !== 'claimed' || t.token !== token) return fail('reassigned', `Task ${n} is ${t.status === 'claimed' ? `claimed by ${t.worker?.harness ?? '?'} ${t.worker?.session ?? '?'}` : t.status}; this session's claim is over`)
  return okBoard({ ...replace(board, { ...t, heartbeatAt: now, leaseUntil: now + board.leaseSec * 1000 }), updatedAt: now })
}

/** The worker needs the user: the task waits without a lease. Asking again while waiting replaces the question. */
export function ask(board: Board, n: number, token: string, question: string, now: number): BoardResult {
  const t = owned(board, n, token, ['claimed', 'waiting'])
  if (!isTask(t)) return t
  const { leaseUntil: _l, ...rest } = t
  return okBoard(event(replace(board, { ...rest, status: 'waiting', question }), 'waiting', now, { task: n, ...sessionFields(t.worker), text: question }))
}

export function resume(board: Board, n: number, token: string, now: number): BoardResult {
  const t = owned(board, n, token, ['waiting'])
  if (!isTask(t)) return t
  const { question: _q, ...rest } = t
  return okBoard(event(replace(board, { ...rest, status: 'claimed', heartbeatAt: now, leaseUntil: now + board.leaseSec * 1000 }), 'resumed', now, { task: n, ...sessionFields(t.worker) }))
}

export function markDone(board: Board, n: number, token: string, report: BoardReport, now: number): BoardResult {
  const t = owned(board, n, token, ['claimed', 'waiting'])
  if (!isTask(t)) return t
  const { worker, token: _k, leaseUntil: _l, claimedAt: _c, heartbeatAt: _h, question: _q, ...rest } = t
  const next: BoardTask = { ...rest, status: 'done', report: { ...report, at: now }, ...(worker !== undefined ? { lastWorker: worker } : {}) }
  return okBoard(event(replace(board, next), 'done', now, { task: n, ...sessionFields(worker), text: report.verify }))
}

export function release(board: Board, n: number, token: string, now: number, reason?: string): BoardResult {
  const t = owned(board, n, token, ['claimed', 'waiting'])
  if (!isTask(t)) return t
  const { worker, token: _k, leaseUntil: _l, claimedAt: _c, heartbeatAt: _h, question: _q, ...rest } = t
  const next: BoardTask = { ...rest, status: 'open', ...(worker !== undefined ? { lastWorker: worker } : {}) }
  return okBoard(event(replace(board, next), 'released', now, { task: n, ...sessionFields(worker), ...(reason !== undefined ? { text: reason } : {}) }))
}

/** The lead reopens a done, merged, waiting or claimed task; its worktree and report stay. */
export function reopen(board: Board, n: number, now: number, reason?: string): BoardResult {
  const t = find(board, n)
  if (t === undefined) return fail('not_found', `the board has no Task ${n}`)
  if (t.status === 'open' || t.status === 'stale') return fail('task_not_open', `Task ${n} is already ${t.status}`)
  const { worker, token: _k, leaseUntil: _l, claimedAt: _c, heartbeatAt: _h, question: _q, ...rest } = t
  const next: BoardTask = { ...rest, status: 'open', ...(worker !== undefined ? { lastWorker: worker } : {}) }
  return okBoard(event(replace(board, next), 'reopened', now, { task: n, ...sessionFields(worker), ...(reason !== undefined ? { text: reason } : {}) }))
}

export function markMerged(board: Board, n: number, now: number, commit?: string): BoardResult {
  const t = find(board, n)
  if (t === undefined) return fail('not_found', `the board has no Task ${n}`)
  if (t.status !== 'done') return fail('task_not_open', `Task ${n} is ${t.status}, not done`)
  const unmerged = t.deps.filter(d => find(board, d)?.status !== 'merged')
  if (unmerged.length > 0) return fail('deps_unmerged', `Task ${n} waits for ${unmerged.map(d => `Task ${d}`).join(', ')} to be merged first`)
  return okBoard(event(replace(board, { ...t, status: 'merged' }), 'merged', now, { task: n, ...(commit !== undefined ? { text: commit } : {}) }))
}

/** The lowest done task whose dependencies are all merged. */
export function nextMergeable(board: Board): number | undefined {
  for (const t of [...board.tasks].sort((a, b) => a.n - b.n)) {
    if (t.status !== 'done') continue
    if (t.deps.every(d => find(board, d)?.status === 'merged')) return t.n
  }
  return undefined
}

export interface NewNote { from: BoardSession; role: BoardRole; to: 'lead' | 'all' | string; kind: NoteKind; text: string }

export function addNote(board: Board, n: NewNote, now: number): { board: Board, note: BoardNote } {
  const seq = board.seq + 1
  const note: BoardNote = { seq, from: n.from, role: n.role, to: n.to, kind: n.kind, text: n.text, at: now, deliveredTo: [] }
  const next: Board = { ...board, seq, updatedAt: now, notes: [...board.notes, note], events: [...board.events, { seq, kind: 'note', at: now, ...sessionFields(n.from), note: seq, text: n.text }] }
  return { board: next, note }
}

/** The notes a session has not seen yet: addressed to its role (`lead`), to everyone, or to the session itself. */
export function notesFor(board: Board, session: string, role: BoardRole): BoardNote[] {
  return board.notes.filter(n => !n.deliveredTo.includes(session) && n.from.session !== session && (n.to === 'all' || n.to === session || (n.to === 'lead' && role === 'lead')))
}

export function markDelivered(board: Board, seqs: readonly number[], session: string): Board {
  if (seqs.length === 0) return board
  return { ...board, notes: board.notes.map(n => (seqs.includes(n.seq) && !n.deliveredTo.includes(session) ? { ...n, deliveredTo: [...n.deliveredTo, session] } : n)) }
}

export function eventsAfter(board: Board, cursor: number): BoardEvent[] {
  return board.events.filter(e => e.seq > cursor)
}

export function boardSummary(board: Board): BoardSummary {
  const s: BoardSummary = { open: 0, claimed: 0, waiting: 0, done: 0, merged: 0, stale: 0, workers: activeWorkers(board).length, total: board.tasks.length }
  for (const t of board.tasks) s[t.status]++
  return s
}

export type BoardGuardView =
  | { role: 'lead', repoRoot: string, board: Board }
  | { role: 'worker', repoRoot: string, task?: number, worktree?: string }

function lower(s: string): string { return s.toLowerCase() }

function within(p: string, dir: string): boolean {
  const a = lower(p)
  const b = lower(dir.replace(/\/+$/, ''))
  return b !== '' && (a === b || a.startsWith(b + '/'))
}

function joinPath(root: string, rel: string): string {
  return `${root.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`
}

/**
 * The board's write rule for the tools that edit files. `absPath` is the normalized real path of the file. The lead may not
 * touch a file of a claimed or waiting task (a worker owns it); a worker writes only inside its lane worktree. Paths outside
 * the repository are never the board's business.
 */
export function boardWriteDenial(view: BoardGuardView, absPath: string): string | undefined {
  if (typeof absPath !== 'string' || absPath === '' || !within(absPath, view.repoRoot)) return undefined
  if (view.role === 'worker') {
    if (view.task === undefined || view.worktree === undefined) {
      return 'Buracle board guard: this session is a board worker without a claimed task, so it does not edit the repository. Run `buracle work join <slug>` to take a task, then work inside the worktree it prints.'
    }
    if (within(absPath, view.worktree)) return undefined
    return `Buracle board guard: a board worker edits only inside its own lane worktree (${view.worktree}, Task ${view.task}). ${absPath} is outside it: the main checkout and the other worktrees belong to the lead and the other workers.`
  }
  for (const t of view.board.tasks) {
    if (t.status !== 'claimed' && t.status !== 'waiting') continue
    for (const rel of t.files.flatMap(pathsOf)) {
      const target = joinPath(view.repoRoot, rel)
      const hit = rel.endsWith('/') ? within(absPath, target) : lower(absPath) === lower(target)
      if (!hit) continue
      const who = t.worker !== undefined ? `${t.worker.harness} ${t.worker.session}` : 'a worker'
      return `Buracle board guard: ${absPath} belongs to Task ${t.n} (${t.status} by ${who}) on the board. The lead does not implement a claimed task: wait with \`buracle work wait --json\`, merge done tasks with \`buracle work merge --json\`, or take the task back with \`buracle work reopen ${t.n}\` first.`
    }
  }
  return undefined
}

export interface BoardStopInput { slug: string; role: BoardRole; task?: { n: number, status: TaskStatus }; summary: BoardSummary }

/** The parts of a board's count line, as the status line and the band show them: `2 claimed · 1 waiting · 3/8 merged`. */
export function boardParts(b: { claimed: number, waiting: number, done: number, stale: number, merged: number, total: number }): string[] {
  return [`${b.claimed} claimed`, ...(b.waiting > 0 ? [`${b.waiting} waiting`] : []), ...(b.done > 0 ? [`${b.done} done`] : []), ...(b.stale > 0 ? [`${b.stale} stale`] : []), `${b.merged}/${b.total} merged`]
}

/** The lead's next step while the board still holds unmerged tasks; undefined when the board is done or absent. */
export function boardLeadStep(b: BoardStopInput | undefined): string | undefined {
  if (b === undefined || b.role !== 'lead') return undefined
  const s = b.summary
  if (s.total - s.merged <= 0) return undefined
  if (s.claimed + s.waiting > 0) {
    return `wait on the board with \`buracle work wait --json\` (${s.claimed} claimed, ${s.waiting} waiting${s.done > 0 ? `, ${s.done} done` : ''}): merge each done task with \`buracle work merge --json\`, run the checks after every merge, and do not implement a claimed task yourself`
  }
  if (s.done > 0) return `merge the done tasks with \`buracle work merge --json\` in dependency order (${s.done} done) and run the checks after every merge`
  return `the remaining ${s.open + s.stale} task(s) are open for workers on the board ${b.slug}: do not implement them yourself; wait with \`buracle work wait --json\`, or ask the user to open more terminals and run \`/buracle-join ${b.slug}\``
}

export function boardWorkerBlockReason(b: BoardStopInput): string {
  const n = b.task?.n ?? 0
  return `this session holds Task ${n} of the board ${b.slug} (claimed), so the turn cannot end with the task idle. Finish it: commit on the lane branch and run \`buracle work done --verify "<command → result>"\`; or ask the user with \`buracle work ask "<question>"\` and then the question tool; or give it back with \`buracle work release --reason "<why>"\`. The lease expires without heartbeats and the task would be reassigned.`
}
