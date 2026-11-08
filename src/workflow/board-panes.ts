// The multiplexer panes of a task board. The lead opens them (`buracle work spawn`), lists them (`work status`) and
// closes them after the last merges and at `work close`; a worker binds its own pane at `work join`, marks it at
// `work ask` and clears the mark at `work resume`. The multiplexer CLIs sit behind src/workflow/mux.ts and the
// sidecar file behind src/workflow/mux-store.ts; the board file itself never changes for a pane.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Board, BoardSession, BoardTask } from '../core/board/model'
import { activeWorkers, claimable } from '../core/board/model'
import type { MuxOnAsk } from '../core/config'
import { HARNESSES, type Harness } from '../core/events'
import * as paths from '../engine/paths'
import { latestWindows } from '../usage/telemetry'
import { USAGE_CHECK_FROM, USAGE_LOW_PCT, checkoutRootOf, commonDirOf, listBoards, sessionBoard, updateBoard } from './board-store'
import { detectMux, muxAdapter, paneIdOf, workerCommand, type MuxAdapter, type MuxDeps, type MuxKind, type MuxPane } from './mux'
import { addPanes, bindPane, findPane, muxStorePath, readMuxStore, removeMuxStore, removePanes, updateMuxStore, type MuxRecord, type MuxStore } from './mux-store'
import { fail, ok, partial, type CmdResult, type WorkflowCtx } from './result'
import type { ResolvedSession } from './session-store'

type Env = Readonly<Record<string, string | undefined>>

/** How long a pane that has not joined the board yet counts as a worker on its way (a harness takes seconds to start). */
export const STARTING_MS = 120_000

/** Folders under the home folder where harness installers put programs that PATH often lacks (`bun add -g` puts omp in .bun/bin). */
const HARNESS_BIN_DIRS = ['.bun/bin', '.local/bin'] as const

/**
 * Where a worker harness is: on PATH (a pane finds it by name), or in a folder an installer uses that PATH may lack. The
 * second kind runs by its full path, because the pane's shell does not know that folder either.
 */
export function findHarnessBin(bin: string, env: Env): { path: string; onPath: boolean } | undefined {
  const onPath = Bun.which(bin, { PATH: env['PATH'] ?? process.env['PATH'] ?? '' })
  if (onPath !== null) return { path: onPath, onPath: true }
  for (const dir of HARNESS_BIN_DIRS) {
    const p = join(paths.home(), dir, bin)
    if (existsSync(p)) return { path: p, onPath: false }
  }
  return undefined
}

export interface SpawnOptions { mux?: string; workers?: number; harness?: string; dryRun?: boolean }
export interface PaneDeps extends MuxDeps { which?: (bin: string) => boolean }

/** The worker's name in its pane: `Worker 2 (codex)`. The record keeps this; the label the pane shows adds what the worker does. */
function workerName(harness: Harness, k: number): string { return `Worker ${k} (${harness})` }

/** What a worker pane is doing, as its label says it. */
export type PaneStage = { stage: 'waiting' } | { stage: 'working' | 'asking' | 'done'; n: number; title: string }
const WAITING: PaneStage = { stage: 'waiting' }
const TITLE_CLIP = 32

function clip(text: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- a task title must never carry a control character into a terminal title
  const t = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** The label of a worker pane in the multiplexer's pane list: who it is and what it is doing now. */
export function paneLabel(name: string, st: PaneStage): string {
  switch (st.stage) {
    case 'waiting': return `${name} · waiting for a task`
    case 'working': return `${name} · Task ${st.n}: ${clip(st.title, TITLE_CLIP)}`
    case 'asking': return `${name} · Task ${st.n} · NEEDS YOU`
    case 'done': return `${name} · Task ${st.n} · done`
    default: { const never: never = st; return never }
  }
}

function parseHarnesses(spec: string | undefined, fallback: Harness): Harness[] | CmdResult {
  if (spec === undefined) return [fallback]
  const names = spec.split(',').map(x => x.trim()).filter(x => x !== '')
  const bad = names.filter(n => !(HARNESSES as readonly string[]).includes(n))
  if (names.length === 0 || bad.length > 0) return fail('usage', `--harness takes one or more of ${HARNESSES.join(', ')}, comma-separated${bad.length > 0 ? ` (unknown: ${bad.join(', ')})` : ''}`)
  return names as Harness[]
}

function isLead(board: Board, s: ResolvedSession): boolean {
  return board.lead.harness === s.harness && board.lead.session === s.sessionId
}

/** The board of the session: its binding, else the repository's only board, else the one this session leads. */
function boardOf(common: string, s: ResolvedSession, now: number): { board: Board; path: string } | CmdResult | undefined {
  const bound = sessionBoard(s.harness, s.sessionId)
  let path = bound?.path
  if (path === undefined) {
    const all = listBoards(common)
    const pick = all.length === 1 ? all[0] : all.find(b => b.board !== undefined && isLead(b.board, s))
    if (pick === undefined) return undefined
    path = pick.path
  }
  const r = updateBoard(path, now, b => ({ ok: true, board: b }))
  if (!r.ok) return r.code === 'no_board' ? undefined : fail(r.code, r.message, { path })
  return { board: r.board, path }
}

function sameSession(a: BoardSession | undefined, b: BoardSession): boolean {
  return a !== undefined && a.harness === b.harness && a.session === b.session
}

/** The highest worker number a recorded title carries (`Worker 3 (codex)`, or the older `buracle <slug> <harness> 3`), so a later spawn keeps counting. */
function lastIndex(store: MuxStore | undefined): number {
  let n = 0
  for (const p of store?.panes ?? []) {
    const m = /^Worker (\d+)\b/.exec(p.title) ?? /(\d+)$/.exec(p.title)
    if (m !== null) n = Math.max(n, Number(m[1]))
  }
  return n
}

/** The task a pane's worker holds now: a claimed or waiting one, else the last one it reported done and the lead has not merged. */
function taskOfPane(board: Board | undefined, p: MuxRecord): BoardTask | undefined {
  const who = p.session
  if (board === undefined || who === undefined) return undefined
  return board.tasks.find(t => (t.status === 'claimed' || t.status === 'waiting') && sameSession(t.worker, who))
    ?? board.tasks.find(t => t.status === 'done' && (sameSession(t.worker, who) || sameSession(t.lastWorker, who)))
}

/** The pane a task's worker sits in, for the task lines of `work status`. */
export function paneOfTask(store: MuxStore | undefined, t: BoardTask): MuxRecord | undefined {
  if (store === undefined || (t.status !== 'claimed' && t.status !== 'waiting' && t.status !== 'done')) return undefined
  return store.panes.find(p => p.session !== undefined && (sameSession(t.worker, p.session) || (t.status === 'done' && sameSession(t.lastWorker, p.session))))
}

function paneView(p: MuxRecord, board: Board | undefined): Record<string, unknown> {
  const task = taskOfPane(board, p)
  return { id: p.id, harness: p.harness, title: p.title, ...(p.session !== undefined ? { session: p.session } : {}), ...(task !== undefined ? { task: task.n } : {}) }
}

/** What `work status` shows for the panes Buracle opened. */
export function panesView(store: MuxStore, board?: Board): { mux: MuxKind; list: Array<Record<string, unknown>> } {
  return { mux: store.mux, list: store.panes.map(p => paneView(p, board)) }
}

/** One line that maps every pane to its worker and task: `w2:p8 Worker 1 (claude): Task 2 waiting`. */
export function panesLine(store: MuxStore, board?: Board): string {
  const state = (p: MuxRecord): string => {
    if (p.session === undefined) return 'no worker yet'
    const t = taskOfPane(board, p)
    return t !== undefined ? `Task ${t.n} ${t.status}` : 'idle'
  }
  return `Panes (${store.mux}): ${store.panes.length === 0 ? 'none' : store.panes.map(p => `${p.id} ${p.title}: ${state(p)}`).join(', ')}`
}

/**
 * The lead opens worker panes in its multiplexer: one per ready task by default (never more than the free worker
 * slots), each running a harness whose first prompt is `/buracle-join <slug>`. The panes are recorded in the board's
 * sidecar, so that `work merge` and `work close` can close them later; nothing else is ever closed.
 */
export async function workSpawn(o: SpawnOptions, ctx: WorkflowCtx, s: ResolvedSession, deps: PaneDeps = {}): Promise<CmdResult> {
  const dry = o.dryRun === true
  const detect = detectMux(ctx.env, o.mux)
  if (!detect.ok && detect.code === 'usage') return fail('usage', detect.message)
  const harnesses = parseHarnesses(o.harness, s.harness)
  if (!Array.isArray(harnesses)) return harnesses
  if (o.workers !== undefined && (!Number.isInteger(o.workers) || o.workers < 0)) return fail('usage', `--workers must be a whole number (got ${String(o.workers)})`)
  const common = commonDirOf(ctx.cwd)
  if (common === undefined) return fail('no_repo', `${ctx.cwd} is not inside a git repository; the board lives in the repository's git common dir`)
  const found = boardOf(common, s, ctx.now)
  if (found !== undefined && 'code' in found) return found
  const muxName = detect.ok ? detect.kind : null
  if (found === undefined) {
    if (dry) return ok({ ok: true, dryRun: true, mux: muxName, board: null }, [`Dry run: ${detect.ok ? `${detect.kind} detected` : 'no multiplexer detected'}; this repository has no task board yet (buracle work publish creates one).`])
    return fail('no_board', 'this repository has no task board; the lead publishes one with buracle work publish')
  }
  const { board } = found
  const slug = board.slug
  const cwd = checkoutRootOf(ctx.cwd) ?? ctx.cwd
  if (!isLead(board, s)) {
    // A dry run only reports what it sees: the approval gate runs it before this session has a board of its own.
    if (dry) return ok({ ok: true, dryRun: true, mux: muxName, board: null, cwd }, [`Dry run: ${detect.ok ? `${detect.kind} detected` : 'no multiplexer detected'}; the board ${slug} belongs to the lead ${board.lead.harness} ${board.lead.session}, so this session would open nothing.`])
    return fail('not_lead', `the board ${slug} belongs to the lead ${board.lead.harness} ${board.lead.session}; register the plan in this session to take it over`, { slug })
  }
  if (!detect.ok) {
    if (dry) return ok({ ok: true, dryRun: true, mux: null, board: slug, cwd, panes: [] }, [`Dry run: ${detect.message}`])
    return fail(detect.code, detect.message, { slug })
  }
  const kind = detect.kind
  const storePath = muxStorePath(common, slug)
  const existing = readMuxStore(storePath)
  if (existing !== undefined && existing.mux !== kind && existing.panes.length > 0) {
    const message = `the panes of ${slug} were opened in ${existing.mux}; close them first before opening panes in ${kind} (buracle work close closes them together with the board; panes closed by hand leave the record on the next spawn, when it finds them gone)`
    if (dry) return ok({ ok: true, dryRun: true, mux: kind, board: slug, cwd, panes: [] }, [`Dry run: ${message}`])
    return fail('mux_mismatch', message, { slug, mux: existing.mux })
  }
  const warnings: string[] = []
  let adapter: MuxAdapter | undefined
  // Harnesses the pane's shell may not find by name: they run by their full path.
  const bins = new Map<Harness, string>()
  if (!dry) {
    const a = muxAdapter(kind, ctx.env, deps)
    if (!a.ok) return fail(a.code, a.message, { slug })
    adapter = a.adapter
    const missing: Harness[] = []
    for (const h of new Set(harnesses)) {
      const f = deps.which !== undefined ? (deps.which(h) ? { path: h, onPath: true } : undefined) : findHarnessBin(h, ctx.env)
      if (f === undefined) missing.push(h)
      else if (!f.onPath) bins.set(h, f.path)
    }
    if (missing.length > 0) return fail('harness_missing', `${missing.join(', ')} not found on PATH (nor in ${HARNESS_BIN_DIRS.map(d => `~/${d}`).join(', ')}); install it, or pick another harness with --harness`, { slug, missing })
  }
  // The panes of an earlier spawn: gone ones leave the record, the rest (present, or unknown because the multiplexer
  // did not answer) stay and count as workers already.
  let live: MuxRecord[] = existing?.panes ?? []
  if (adapter !== undefined && live.length > 0) {
    const checked = await Promise.all(live.map(async p => ({ p, state: await adapter.presence(p) })))
    const dead = checked.filter(c => c.state === 'stale').map(c => c.p.id)
    live = checked.filter(c => c.state !== 'stale').map(c => c.p)
    if (dead.length > 0) updateMuxStore(storePath, st => (st === undefined ? undefined : removePanes(st, dead)))
    const unknown = checked.filter(c => c.state === 'failed').length
    if (unknown > 0) warnings.push(`${unknown} recorded pane(s) could not be checked (${kind} did not answer); they keep their worker slots`)
  }
  const active = activeWorkers(board)
  const idle = live.filter(p => !active.some(w => sameSession(p.session, w))).length
  const ready = claimable(board).ready.length
  // A pane opened a moment ago that has not joined yet is a worker on its way: it will take one of the ready tasks.
  const starting = live.filter(p => p.session === undefined && ctx.now - p.openedAt < STARTING_MS).length
  const max = board.maxWorkers
  const cap = Math.max(0, max - active.length - idle)
  // An idle pane holds a worker slot but takes no new task on its own (a worker that found nothing stops and cannot be
  // woken), so it counts against the limit, not against the ready tasks. A starting pane counts against both.
  let n = o.workers ?? Math.max(0, Math.min(ready - starting, cap))
  if (o.workers !== undefined && o.workers > cap) {
    warnings.push(`max_workers: ${o.workers} worker(s) asked, ${cap} slot(s) free (plan.board.maxWorkers ${max}, ${active.length} active worker(s), ${idle} idle pane(s)); opening ${cap}`)
    n = cap
  }
  if (active.length + idle + n > USAGE_CHECK_FROM) {
    const hot = [...new Set(harnesses)].flatMap(h => latestWindows(h, ctx.now).filter(w => w.pct >= USAGE_LOW_PCT).map(w => ({ h, w })))[0]
    const room = Math.max(0, USAGE_CHECK_FROM - active.length - idle)
    if (hot !== undefined && n > room) {
      warnings.push(`usage_low: ${hot.h}'s ${hot.w.label} rate window is at ${hot.w.pct}% (limit ${USAGE_LOW_PCT}% from the ${USAGE_CHECK_FROM + 1}th worker on); opening ${room} instead of ${n}`)
      n = room
    }
  }
  const start = lastIndex(existing)
  const plans = Array.from({ length: n }, (_, i) => {
    const harness = harnesses[i % harnesses.length] as Harness
    const name = workerName(harness, start + i + 1)
    return { harness, command: workerCommand(harness, slug, cwd, kind, bins.get(harness)), name, title: paneLabel(name, WAITING) }
  })
  const workers = { requested: n, opened: 0, active: active.length, max }
  if (dry || adapter === undefined) {
    return ok({ ok: true, dryRun: true, mux: kind, board: slug, cwd, workers, panes: plans.map(p => ({ harness: p.harness, command: p.command, title: p.title })) }, [
      `Dry run: ${n} pane(s) would open in ${kind} for ${slug} (${ready} ready task(s), ${active.length} active worker(s), ${idle} idle pane(s), ${starting} pane(s) starting, limit ${max}).`,
      ...plans.map(p => `  ${p.title}: ${p.command}`),
    ], warnings)
  }
  if (n === 0) {
    return ok({ ok: true, slug, mux: kind, cwd, opened: [], failed: [], workers }, [`Nothing to open on ${slug}: ${ready} ready task(s), ${active.length} active worker(s), ${idle} idle pane(s), ${starting} pane(s) starting, limit ${max}.`], warnings)
  }
  const opened: MuxRecord[] = []
  const failed: Array<{ index: number; harness: Harness; error: string }> = []
  const unrecorded: string[] = []
  let recordError = ''
  let after: MuxPane | undefined = live.at(-1)
  let attach: string | undefined
  for (const [i, p] of plans.entries()) {
    const r = await adapter.open({ cwd, command: p.command, title: p.title, slug, ...(after !== undefined ? { after } : {}) })
    if (r === undefined) { failed.push({ index: i + 1, harness: p.harness, error: 'the multiplexer opened no pane' }); continue }
    const rec: MuxRecord = { id: r.id, harness: p.harness, title: p.name, server: r.server, openedAt: ctx.now }
    if (r.ids !== undefined) rec.ids = r.ids
    if (r.pid !== undefined) rec.pid = r.pid
    opened.push(rec)
    after = rec
    if (r.attach !== undefined) attach = r.attach
    // Recorded at once: a harness that joins quickly finds its pane in the sidecar, and a spawn that dies leaves no orphan.
    // A record without its server could never be matched or closed safely, so it is not written.
    if (rec.server === '') { unrecorded.push(rec.id); recordError = 'the multiplexer did not say which server the pane belongs to'; continue }
    const w = updateMuxStore(storePath, st => addPanes(st, { slug, mux: kind }, [rec]))
    if (!w.ok) { unrecorded.push(rec.id); recordError = w.message }
  }
  if (unrecorded.length > 0) {
    const how = kind === 'tmux' ? 'tmux kill-pane -t <id>' : kind === 'herdr' ? 'herdr pane close <id>' : 'cmux close-surface --surface <id>'
    warnings.push(`the panes ${unrecorded.join(', ')} opened but were not recorded (${recordError}); buracle work close will not close them, close them by hand with ${how}`)
  }
  workers.opened = opened.length
  const data = { slug, mux: kind, cwd, opened: opened.map(p => ({ id: p.id, harness: p.harness, title: paneLabel(p.title, WAITING) })), failed, workers, ...(attach !== undefined ? { attach } : {}) }
  if (opened.length === 0) return fail('mux_failed', `no pane opened in ${kind} (${failed.length} attempt(s) failed); check that ${kind} takes commands from this session`, data)
  const lines = [
    `Opened ${opened.length} pane(s) in ${kind} for ${slug}: ${opened.map(p => `${p.id} ${p.harness}`).join(', ')}. Each starts its harness with /buracle-join ${slug} ($buracle-join ${slug} in Codex) and takes a task.`,
    `Pane map (${kind}):`,
    ...opened.map(p => `  ${p.id}  ${paneLabel(p.title, WAITING)}`),
    'A pane label names its worker and, once it joined, its task (NEEDS YOU while it waits for the user). buracle work status maps every pane to its task.',
    ...(attach !== undefined ? [`Attach with: ${attach}`] : []),
    'Then: buracle work wait --json → buracle work merge --json → run the checks. buracle work close closes the panes Buracle opened.',
  ]
  if (failed.length > 0) warnings.push(`${failed.length} pane(s) did not open: ${failed.map(f => `#${f.index} ${f.harness}`).join(', ')}`)
  // A clamp or a pane that did not open is worth exit 2: the lead reads the warning before it waits for workers that are not there.
  return warnings.length > 0 ? partial({ ok: true, ...data }, lines, warnings) : ok({ ok: true, ...data }, lines)
}

/** The sidecar of the board a session is on, for the lead-side and worker-side hooks; undefined when there is none. */
export function paneStoreFor(commonDir: string, slug: string): { path: string; store: MuxStore | undefined } {
  const path = muxStorePath(commonDir, slug)
  return { path, store: readMuxStore(path) }
}

/** The git common dir a board file lives under (`<common dir>/buracle/board/<slug>.json`). */
export function commonDirOfBoard(boardPath: string): string {
  return resolve(boardPath, '..', '..', '..')
}

/**
 * A worker joined: when it runs in a pane Buracle opened (its id is in the environment and in the sidecar), the pane
 * is bound to the worker's session, so that the lead can close it once the worker has nothing left to take.
 */
export function bindPaneToSession(commonDir: string, slug: string, env: Env, session: BoardSession): { mux: MuxKind; id: string; bound: boolean } | undefined {
  const { path, store } = paneStoreFor(commonDir, slug)
  if (store === undefined) return undefined
  const id = paneIdOf(store.mux, env)
  if (id === undefined) return undefined
  if (findPane(store, id) === undefined) return { mux: store.mux, id, bound: false }
  let bound = false
  const r = updateMuxStore(path, st => {
    if (st === undefined) return undefined
    const b = bindPane(st, id, session)
    bound = b.bound
    return b.bound ? b.store : undefined
  })
  return { mux: store.mux, id, bound: r.ok && bound }
}

/** The pane a worker runs in: the recorded one, else (tmux only) the pane itself, so a hand-opened pane still shows the question. */
function workerPane(commonDir: string, slug: string, env: Env, harness: Harness): { kind: MuxKind; pane: MuxPane; recorded: boolean } | undefined {
  const { store } = paneStoreFor(commonDir, slug)
  if (store !== undefined) {
    const id = paneIdOf(store.mux, env)
    const rec = id !== undefined ? findPane(store, id) : undefined
    if (rec !== undefined) return { kind: store.mux, pane: rec, recorded: true }
  }
  const tmux = paneIdOf('tmux', env)
  if (tmux !== undefined) return { kind: 'tmux', pane: { id: tmux, harness, title: '', server: '' }, recorded: false }
  return undefined
}

/** The id of the pane a worker runs in, for the note the lead reads (undefined when the worker is not in a pane of the board). */
export function paneRefOf(commonDir: string, slug: string, env: Env, harness: Harness): string | undefined {
  return workerPane(commonDir, slug, env, harness)?.pane.id
}

/** Sets the label of the worker's own pane. Only a pane Buracle opened is renamed; a pane the user opened keeps its title. */
export async function labelWorkerPane(commonDir: string, slug: string, env: Env, harness: Harness, st: PaneStage, deps: MuxDeps = {}): Promise<{ labeled: boolean }> {
  if (env['BURACLE_NO_NOTIFY'] === '1') return { labeled: false }
  const found = workerPane(commonDir, slug, env, harness)
  if (found === undefined || !found.recorded) return { labeled: false }
  const a = muxAdapter(found.kind, env, deps)
  if (!a.ok) return { labeled: false }
  return { labeled: await a.adapter.title(found.pane, paneLabel(found.pane.title, st)) }
}

/**
 * `work ask`: the worker's pane gets the mark and, with `focus`, the focus. tmux marks with the title, the mark and a bell;
 * herdr and cmux are told by `notifyTerminal`, so their pane list only needs the new label.
 */
export async function markPaneOnAsk(commonDir: string, slug: string, env: Env, harness: Harness, task: { n: number; title: string }, onAsk: MuxOnAsk, deps: MuxDeps = {}): Promise<{ marked: boolean; focused: boolean }> {
  const none = { marked: false, focused: false }
  if (env['BURACLE_NO_NOTIFY'] === '1') return none
  const found = workerPane(commonDir, slug, env, harness)
  if (found === undefined) return none
  const a = muxAdapter(found.kind, env, deps)
  if (!a.ok) return none
  const text = found.recorded ? paneLabel(found.pane.title, { stage: 'asking', ...task }) : `Task ${task.n} needs you`
  const marked = await a.adapter.mark(found.pane, text)
  if (found.recorded && found.kind !== 'tmux') await a.adapter.title(found.pane, text)
  const focused = onAsk === 'focus' ? await a.adapter.focus(found.pane) : false
  return { marked, focused }
}

/** `kept`: still open (the multiplexer did not answer, or `--keep-panes`). `unreadable`: the sidecar could not be read and was removed. */
export interface ClosedPanes { closed: string[]; kept: string[]; stale: string[]; unreadable?: boolean }

const NO_PANES: ClosedPanes = { closed: [], kept: [], stale: [] }

async function closePanes(path: string, store: MuxStore, panes: readonly MuxRecord[], env: Env, deps: MuxDeps): Promise<ClosedPanes> {
  const out: ClosedPanes = { closed: [], kept: [], stale: [] }
  if (panes.length === 0) return out
  const a = muxAdapter(store.mux, env, deps)
  if (!a.ok) { out.kept.push(...panes.map(p => p.id)); return out }
  let down = false
  for (const p of panes) {
    // Once the multiplexer stopped answering, the rest would only wait out the same timeout each.
    const r = down ? { ok: false as const, reason: 'failed' as const } : await a.adapter.close(p)
    if (r.ok) out.closed.push(p.id)
    else if (r.reason === 'stale') out.stale.push(p.id)
    else { out.kept.push(p.id); down = true }
  }
  const gone = [...out.closed, ...out.stale]
  if (gone.length > 0) updateMuxStore(path, st => (st === undefined ? undefined : removePanes(st, gone)))
  return out
}

/**
 * After a merge: while a task is ready to be taken, every pane stays (a worker that just finished joins it). Once none is
 * ready, the panes of idle workers close: a worker is idle when it holds no task and every task it last worked on is
 * merged. A task that is open but blocked (it waits for another task to be merged, or shares a file with an active one)
 * keeps nobody's pane open: a worker that finds nothing to take stops, and the lead opens a new pane for it later
 * (`work spawn`). A pane nobody joined from yet may hold a worker that is still starting; it waits for `work close`.
 */
export async function closePanesAfterMerge(commonDir: string, board: Board, env: Env, deps: MuxDeps = {}): Promise<ClosedPanes> {
  const { path, store } = paneStoreFor(commonDir, board.slug)
  if (store === undefined) return NO_PANES
  if (claimable(board).ready.length > 0) return NO_PANES
  const active = activeWorkers(board)
  const idle = store.panes.filter(p => {
    const who = p.session
    // A pane nobody joined from yet may hold a worker that is still starting (or whose bind failed): it waits for `work close`.
    if (who === undefined) return false
    if (active.some(w => sameSession(who, w))) return false
    return board.tasks.every(t => !sameSession(t.lastWorker, who) || t.status === 'merged')
  })
  return closePanes(path, store, idle, env, deps)
}

/** `work close` and `plan verify`: every recorded pane closes (`keep` leaves them open); the sidecar goes either way. */
export async function closeAllPanes(commonDir: string, slug: string, env: Env, o: { keep?: boolean } = {}, deps: MuxDeps = {}): Promise<ClosedPanes> {
  const { path, store } = paneStoreFor(commonDir, slug)
  if (store === undefined) {
    // An unreadable sidecar would block the next spawn of the same slug from recording its panes; the caller warns.
    const unreadable = existsSync(path)
    removeMuxStore(path)
    return unreadable ? { ...NO_PANES, unreadable: true } : NO_PANES
  }
  const out = o.keep === true ? { closed: [], kept: store.panes.map(p => p.id), stale: [] } : await closePanes(path, store, store.panes, env, deps)
  removeMuxStore(path)
  return out
}

/** `work resume`: the mark goes away (tmux title back, herdr state working, cmux notifications cleared) and the label names the task again. */
export async function clearPaneMark(commonDir: string, slug: string, env: Env, harness: Harness, task: { n: number; title: string }, deps: MuxDeps = {}): Promise<{ cleared: boolean }> {
  if (env['BURACLE_NO_NOTIFY'] === '1') return { cleared: false }
  const found = workerPane(commonDir, slug, env, harness)
  if (found === undefined) return { cleared: false }
  const a = muxAdapter(found.kind, env, deps)
  if (!a.ok) return { cleared: false }
  if (!found.recorded) return { cleared: await a.adapter.clearMark(found.pane) }
  const label = paneLabel(found.pane.title, { stage: 'working', ...task })
  // tmux restores the title it is given when it drops the mark; herdr and cmux need the rename on top.
  const cleared = await a.adapter.clearMark({ ...found.pane, title: label })
  if (found.kind !== 'tmux') await a.adapter.title(found.pane, label)
  return { cleared }
}
