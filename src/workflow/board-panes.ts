// The multiplexer panes of a task board. The lead opens them (`buracle work spawn`), lists them (`work status`) and
// closes them after the last merges and at `work close`; a worker binds its own pane at `work join`, marks it at
// `work ask` and clears the mark at `work resume`. The multiplexer CLIs sit behind src/workflow/mux.ts and the
// sidecar file behind src/workflow/mux-store.ts; the board file itself never changes for a pane.
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Board, BoardSession, BoardTask } from '../core/board/model'
import { activeWorkers, claimable, remainingFor, standbyWorkers } from '../core/board/model'
import { defaultConfig, type BuracleConfig, type MuxOnAsk } from '../core/config'
import { HARNESSES, type Harness } from '../core/events'
import { loadConfigSync } from '../engine/config'
import * as paths from '../engine/paths'
import { latestWindows } from '../usage/telemetry'
import { USAGE_CHECK_FROM, USAGE_LOW_PCT, checkoutRootOf, commonDirOf, listBoards, sessionBoard, updateBoard } from './board-store'
import { ancestorPids, detectMux, layoutCaps, muxAdapter, paneIdOf, workerCommand, type MuxAdapter, type MuxDeps, type MuxKind, type MuxPane, type Split } from './mux'
import { planLayout, type Layout, type PanePlan } from './mux-layout'
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

type SwarmConfig = Pick<BuracleConfig['plan']['board'], 'harnesses' | 'mux'>

/** `plan.board.harnesses` (which harnesses may run swarm workers) and `plan.board.mux` (whether the lead's multiplexer gets panes); the user sets them in the config or on the Console's settings page. */
function swarmConfig(): SwarmConfig {
  const pick = (b: BuracleConfig['plan']['board']): SwarmConfig => ({ harnesses: b.harnesses, mux: b.mux })
  try { return pick(loadConfigSync().config.plan.board) } catch { return pick(defaultConfig().plan.board) }
}

type HarnessBin = { path: string; onPath: boolean }

/** Where each harness is, looked up once: `deps.which` stands in for PATH in tests. */
function binLookup(env: Env, deps: PaneDeps): (h: Harness) => HarnessBin | undefined {
  const cache = new Map<Harness, HarnessBin | undefined>()
  return h => {
    if (!cache.has(h)) cache.set(h, deps.which !== undefined ? (deps.which(h) ? { path: h, onPath: true } : undefined) : findHarnessBin(h, env))
    return cache.get(h)
  }
}

/** Where the dealing list comes from: `--harness`, the board (the plan's `Swarm harnesses:` line), or every installed harness that is on. */
type HarnessSource = { kind: 'flag'; spec: string } | { kind: 'board'; list: readonly Harness[] } | { kind: 'installed' }

const HARNESS_HINT = "turn one on with 'buracle config set plan.board.harnesses.<h> true' or install it"

/**
 * The harness list the panes are dealt from. `--harness` names it (an unknown name is a usage error; a harness that
 * `plan.board.harnesses` switches off is dropped with a warning). The board's list drops a harness that is off or not
 * installed, with a warning. Without either it is every harness that is on and installed, in Buracle's order. Nothing
 * left is `harness_off`.
 */
function dealableHarnesses(source: HarnessSource, on: Record<Harness, boolean>, installed: (h: Harness) => boolean): { list: Harness[]; warnings: string[] } | CmdResult {
  const warnings: string[] = []
  const state = (h: Harness): string => (on[h] === false ? 'off (plan.board.harnesses)' : installed(h) ? 'on' : 'not installed')
  if (source.kind === 'installed') {
    const list = HARNESSES.filter(h => on[h] !== false && installed(h))
    if (list.length === 0) return fail('harness_off', `no harness can run swarm workers: ${HARNESSES.map(h => `${h} ${state(h)}`).join(', ')}; ${HARNESS_HINT}`)
    return { list, warnings }
  }
  if (source.kind === 'board') {
    const off = source.list.filter(h => on[h] === false)
    const missing = source.list.filter(h => on[h] !== false && !installed(h))
    if (off.length > 0) warnings.push(`${off.join(', ')} dropped from the plan's Swarm harnesses: switched off for swarm workers (${off.map(h => `plan.board.harnesses.${h}`).join(', ')})`)
    if (missing.length > 0) warnings.push(`${missing.join(', ')} dropped from the plan's Swarm harnesses: not installed (PATH, ${HARNESS_BIN_DIRS.map(d => `~/${d}`).join(', ')})`)
    const list = source.list.filter(h => on[h] !== false && installed(h))
    if (list.length === 0) return fail('harness_off', `none of the plan's Swarm harnesses can run workers here: ${source.list.map(h => `${h} ${state(h)}`).join(', ')}; ${HARNESS_HINT}, or pass --harness`)
    return { list, warnings }
  }
  const names = source.spec.split(',').map(x => x.trim()).filter(x => x !== '')
  const bad = names.filter(n => !(HARNESSES as readonly string[]).includes(n))
  if (names.length === 0 || bad.length > 0) return fail('usage', `--harness takes one or more of ${HARNESSES.join(', ')}, comma-separated${bad.length > 0 ? ` (unknown: ${bad.join(', ')})` : ''}`)
  const off = (names as Harness[]).filter(h => on[h] === false)
  if (off.length > 0) warnings.push(`${off.join(', ')} dropped from --harness: switched off for swarm workers (${off.map(h => `plan.board.harnesses.${h}`).join(', ')})`)
  const list = (names as Harness[]).filter(h => on[h] !== false)
  if (list.length === 0) return fail('harness_off', `every harness in --harness is switched off for swarm workers (${off.map(h => `plan.board.harnesses.${h}`).join(', ')}); turn one on with 'buracle config set plan.board.harnesses.<h> true'`)
  return { list, warnings }
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
  const active = board.tasks.find(t => (t.status === 'claimed' || t.status === 'waiting') && sameSession(t.worker, who))
  if (active !== undefined) return active
  // A worker may have finished several tasks that the lead has not merged yet: the pane holds the one it reported last.
  let last: BoardTask | undefined
  for (const t of board.tasks) {
    if (t.status !== 'done' || !(sameSession(t.worker, who) || sameSession(t.lastWorker, who))) continue
    if (last === undefined || (t.report?.at ?? 0) >= (last.report?.at ?? 0)) last = t
  }
  return last
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

/** One line that says where the panes went, so the lead (and the user) can read the screen. */
function layoutLine(kind: MuxKind, layout: Layout, lead: boolean, live: number): string {
  if (kind === 'herdr-app') return 'Layout: the Herdr app places the worker panes in the lead\'s tab.'
  if (live > 0) return 'Layout: the new pane(s) share the area of the last worker pane; the panes opened earlier stay as they are.'
  const grid = `${layout.rows} row(s) of up to ${layout.cols} worker pane(s)`
  return lead ? `Layout: the lead keeps the top of its area; the worker panes fill the rest below it in ${grid}.` : `Layout: the worker panes fill ${grid}.`
}

/**
 * The ready tasks a pane may be opened for: the unreserved ones, and those reserved (`**Harness:**` in the plan) for a
 * harness that is on and installed. `warnings` gets one line per task left out, so the lead knows why it has no pane.
 */
function dealableReady(board: Board, on: Record<Harness, boolean>, lookup: (h: Harness) => HarnessBin | undefined, warnings?: string[]): BoardTask[] {
  const out: BoardTask[] = []
  for (const n of claimable(board).ready) {
    const t = board.tasks.find(x => x.n === n)
    if (t === undefined) continue
    const h = t.harness
    if (h === undefined) { out.push(t); continue }
    if (on[h] === false) { warnings?.push(`Task ${t.n} is reserved for ${h}, which is switched off for swarm workers (plan.board.harnesses.${h}): no pane opened for it`); continue }
    if (lookup(h) === undefined) { warnings?.push(`Task ${t.n} is reserved for ${h}, which is not installed (PATH, ${HARNESS_BIN_DIRS.map(d => `~/${d}`).join(', ')}): no pane opened for it`); continue }
    out.push(t)
  }
  return out
}

/** The numbers of one tick of the scale formula: what is ready, who holds a slot, and what follows for the panes to open. */
export interface TickCounts { ready: number; active: number; standby: number; starting: number; idle: number; need: number; cap: number; max: number }

/**
 * The scale formula. `need` is the ready tasks that no standby worker (a `join --wait` on the board) and no starting
 * pane (opened less than STARTING_MS ago, nobody joined from it yet) covers. `cap` is the worker slots left once the
 * active workers, the standby workers, the starting panes and the idle panes hold theirs. An idle pane is a live
 * recorded pane whose worker is neither active nor standby (it stopped without waiting, or it never started): it holds
 * a slot but takes no task on its own.
 */
export function tickCounts(board: Board, live: readonly MuxRecord[], now: number, ready: number): TickCounts {
  const active = activeWorkers(board)
  const standby = standbyWorkers(board)
  const isStarting = (p: MuxRecord): boolean => p.session === undefined && now - p.openedAt < STARTING_MS
  const starting = live.filter(isStarting).length
  const idle = live.filter(p => !isStarting(p) && !active.some(w => sameSession(p.session, w)) && !standby.some(w => sameSession(p.session, w))).length
  const max = board.maxWorkers
  const need = Math.max(0, ready - standby.length - starting)
  const cap = Math.max(0, max - active.length - standby.length - starting - idle)
  return { ready, active: active.length, standby: standby.length, starting, idle, need, cap, max }
}

interface PaneSpec { harness: Harness; command: string; name: string; title: string }

interface TickInput {
  board: Board
  /** The checkout the panes start in. */
  cwd: string
  kind: MuxKind
  storePath: string
  existing: MuxStore | undefined
  /** Absent on a dry run: nothing is opened and the recorded panes are not checked. */
  adapter?: MuxAdapter
  /** The dealing list; empty when only reserved tasks may get a pane. */
  harnesses: readonly Harness[]
  on: Record<Harness, boolean>
  lookup: (h: Harness) => HarnessBin | undefined
  /** Harnesses the pane's shell may not find by name: they run by their full path. */
  bins: Map<Harness, string>
  /** `--workers`: never opens more than the formula says, only fewer. */
  workers?: number
}

interface TickResult {
  counts: TickCounts
  /** The panes the tick decided to open. */
  requested: number
  plans: PaneSpec[]
  /** The panes that opened, in grid order. */
  opened: MuxRecord[]
  failed: Array<{ index: number; harness: Harness; error: string }>
  layout: Layout
  layoutNote: string
  attach?: string
  warnings: string[]
}

/**
 * One tick of the swarm, shared by `work spawn`, `work publish` and `work merge`: the recorded panes are checked (gone
 * ones leave the record), the formula gives `open = min(need, cap, usage room)`, `workers` can only lower it, and that
 * many panes open and are recorded. The reserved tasks' harnesses are dealt first, so a reserved task gets its pane even
 * when fewer panes open than tasks are ready; the rest take the harness list in turn.
 */
async function runTick(input: TickInput, ctx: WorkflowCtx): Promise<TickResult> {
  const { board, cwd, kind, storePath, existing, adapter, harnesses, on, lookup, bins } = input
  const slug = board.slug
  const warnings: string[] = []
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
  const reservable = dealableReady(board, on, lookup, warnings)
  if (adapter !== undefined) {
    for (const t of reservable) {
      const h = t.harness
      if (h === undefined || bins.has(h)) continue
      const f = lookup(h)
      if (f !== undefined && !f.onPath) bins.set(h, f.path)
    }
  }
  const counts = tickCounts(board, live, ctx.now, reservable.length)
  let n = Math.min(counts.need, counts.cap)
  if (input.workers !== undefined) {
    if (input.workers > counts.cap) warnings.push(`max_workers: ${input.workers} worker(s) asked, ${counts.cap} slot(s) free (plan.board.maxWorkers ${counts.max}, ${counts.active} active worker(s), ${counts.standby} standby worker(s), ${counts.starting} pane(s) starting, ${counts.idle} idle pane(s)); opening ${Math.min(n, input.workers)}`)
    n = Math.min(n, input.workers)
  }
  const occupied = counts.active + counts.standby + counts.starting + counts.idle
  if (occupied + n > USAGE_CHECK_FROM) {
    const hot = [...new Set(harnesses)].flatMap(h => latestWindows(h, ctx.now).filter(w => w.pct >= USAGE_LOW_PCT).map(w => ({ h, w })))[0]
    const room = Math.max(0, USAGE_CHECK_FROM - occupied)
    if (hot !== undefined && n > room) {
      warnings.push(`usage_low: ${hot.h}'s ${hot.w.label} rate window is at ${hot.w.pct}% (limit ${USAGE_LOW_PCT}% from the ${USAGE_CHECK_FROM + 1}th worker on); opening ${room} instead of ${n}`)
      n = room
    }
  }
  const start = lastIndex(existing)
  const reservedSeq = reservable.flatMap(t => (t.harness !== undefined ? [t.harness] : []))
  if (harnesses.length === 0) n = Math.min(n, reservedSeq.length)
  // plans[rank]: the grid reads left to right and top to bottom, so Worker k sits where its number says.
  let turn = 0
  const plans: PaneSpec[] = Array.from({ length: n }, (_, rank) => {
    const harness = reservedSeq[rank] ?? (harnesses[turn++ % harnesses.length] as Harness)
    const name = workerName(harness, start + rank + 1)
    return { harness, command: workerCommand(harness, slug, cwd, kind, bins.get(harness)), name, title: paneLabel(name, WAITING) }
  })
  const caps = layoutCaps(kind, ctx.env)
  const layout = planLayout({ count: n, live: live.length, lead: caps.lead, exact: caps.exact })
  const result: TickResult = { counts, requested: n, plans, opened: [], failed: [], layout, layoutNote: layoutLine(kind, layout, caps.lead, live.length), warnings }
  if (adapter === undefined || n === 0) return result
  const opened: MuxRecord[] = []
  const rankOf = new Map<string, number>()
  const byRank = new Map<number, MuxRecord>()
  const unrecorded: string[] = []
  let recordError = ''
  let last: MuxPane | undefined = live.at(-1)
  // The pane a step splits. When that pane did not open, the one opened last (else the lead) is split in halves instead.
  const splitOf = (step: PanePlan): Split | undefined => {
    const a = step.anchor
    if (a.kind === 'none') return undefined
    if (a.kind === 'lead') return { target: 'lead', direction: step.direction, keep: step.keep }
    const target = a.kind === 'live' ? live.at(-1) : byRank.get(a.rank)
    if (target !== undefined) return { target, direction: step.direction, keep: step.keep }
    if (last !== undefined) return { target: last, direction: step.direction, keep: 0.5 }
    return caps.lead ? { target: 'lead', direction: step.direction, keep: 0.5 } : undefined
  }
  for (const step of layout.panes) {
    const p = plans[step.rank]
    if (p === undefined) continue
    const split = splitOf(step)
    const r = await adapter.open({ cwd, command: p.command, title: p.title, slug, ...(split !== undefined ? { split } : {}) })
    if (r === undefined) { result.failed.push({ index: step.rank + 1, harness: p.harness, error: 'the multiplexer opened no pane' }); continue }
    const rec: MuxRecord = { id: r.id, harness: p.harness, title: p.name, server: r.server, openedAt: ctx.now }
    if (r.ids !== undefined) rec.ids = r.ids
    if (r.pid !== undefined) rec.pid = r.pid
    opened.push(rec)
    rankOf.set(rec.id, step.rank)
    byRank.set(step.rank, rec)
    last = rec
    if (r.attach !== undefined) result.attach = r.attach
    // Recorded at once: a harness that joins quickly finds its pane in the sidecar, and a spawn that dies leaves no orphan.
    // A record without its server could never be matched or closed safely, so it is not written.
    if (rec.server === '') { unrecorded.push(rec.id); recordError = 'the multiplexer did not say which server the pane belongs to'; continue }
    const w = updateMuxStore(storePath, st => addPanes(st, { slug, mux: kind }, [rec]))
    if (!w.ok) { unrecorded.push(rec.id); recordError = w.message }
  }
  if (unrecorded.length > 0) {
    const how = kind === 'tmux' ? 'tmux kill-pane -t <id>' : kind === 'herdr' ? 'herdr pane close <id>' : kind === 'herdr-app' ? 'hc kill <id> && hc rm <id>' : 'cmux close-surface --surface <id> --force'
    warnings.push(`the panes ${unrecorded.join(', ')} opened but were not recorded (${recordError}); buracle work close will not close them, close them by hand with ${how}`)
  }
  // The pane map reads in grid order, the order the labels number the workers in.
  result.opened = [...opened].sort((a, b) => (rankOf.get(a.id) ?? 0) - (rankOf.get(b.id) ?? 0))
  return result
}

function countsLine(c: TickCounts): string {
  return `${c.ready} ready task(s), ${c.active} active worker(s), ${c.standby} standby worker(s), ${c.idle} idle pane(s), ${c.starting} pane(s) starting, limit ${c.max}`
}

/**
 * The lead opens worker panes in its multiplexer: one per ready task that no standby worker or starting pane covers
 * (never more than the free worker slots), each running a harness whose first prompt is `/buracle-join <slug>`. The
 * panes are recorded in the board's sidecar, so that `work merge` and `work close` can close them later; nothing else
 * is ever closed.
 */
export async function workSpawn(o: SpawnOptions, ctx: WorkflowCtx, s: ResolvedSession, deps: PaneDeps = {}): Promise<CmdResult> {
  const dry = o.dryRun === true
  const detect = detectMux(ctx.env, o.mux)
  if (!detect.ok && detect.code === 'usage') return fail('usage', detect.message)
  const on = swarmConfig().harnesses
  // A harness is installed when its program is on PATH or in a folder an installer uses (the pane then runs it by its path).
  const lookup = binLookup(ctx.env, deps)
  const installed = (h: Harness): boolean => lookup(h) !== undefined
  // The harnesses that may run workers now: on in the config and installed. The approval gate reads them from a dry run.
  const usable = HARNESSES.filter(h => on[h] !== false && installed(h))
  if (o.workers !== undefined && (!Number.isInteger(o.workers) || o.workers < 0)) return fail('usage', `--workers must be a whole number (got ${String(o.workers)})`)
  const common = commonDirOf(ctx.cwd)
  if (common === undefined) return fail('no_repo', `${ctx.cwd} is not inside a git repository; the board lives in the repository's git common dir`)
  const found = boardOf(common, s, ctx.now)
  if (found !== undefined && 'code' in found) return found
  // The dealing list: --harness, else the plan's Swarm harnesses the board stores, else every harness that is on and installed.
  const source: HarnessSource = o.harness !== undefined ? { kind: 'flag', spec: o.harness } : found?.board.harnesses !== undefined ? { kind: 'board', list: found.board.harnesses } : { kind: 'installed' }
  const parsed0 = dealableHarnesses(source, on, installed)
  // A dry run reports instead of failing: the gate asks its question with whatever is usable.
  if (!('list' in parsed0) && !dry) return parsed0
  const parsed = 'list' in parsed0 ? parsed0 : { list: usable, warnings: parsed0.errors }
  const harnesses = parsed.list
  const muxName = detect.ok ? detect.kind : null
  if (found === undefined) {
    if (dry) return ok({ ok: true, dryRun: true, mux: muxName, board: null, harnesses: usable }, [`Dry run: ${detect.ok ? `${detect.kind} detected` : 'no multiplexer detected'}; this repository has no task board yet (buracle work publish creates one).`])
    return fail('no_board', 'this repository has no task board; the lead publishes one with buracle work publish')
  }
  const { board } = found
  const slug = board.slug
  const cwd = checkoutRootOf(ctx.cwd) ?? ctx.cwd
  if (!isLead(board, s)) {
    // A dry run only reports what it sees: the approval gate runs it before this session has a board of its own.
    if (dry) return ok({ ok: true, dryRun: true, mux: muxName, board: null, cwd, harnesses: usable }, [`Dry run: ${detect.ok ? `${detect.kind} detected` : 'no multiplexer detected'}; the board ${slug} belongs to the lead ${board.lead.harness} ${board.lead.session}, so this session would open nothing.`])
    return fail('not_lead', `the board ${slug} belongs to the lead ${board.lead.harness} ${board.lead.session}; register the plan in this session to take it over`, { slug })
  }
  if (!detect.ok) {
    if (dry) return ok({ ok: true, dryRun: true, mux: null, board: slug, cwd, harnesses: usable, panes: [] }, [`Dry run: ${detect.message}`])
    return fail(detect.code, detect.message, { slug })
  }
  const kind = detect.kind
  const storePath = muxStorePath(common, slug)
  const existing = readMuxStore(storePath)
  if (existing !== undefined && existing.mux !== kind && existing.panes.length > 0) {
    const message = `the panes of ${slug} were opened in ${existing.mux}; close them first before opening panes in ${kind} (buracle work close closes them together with the board; panes closed by hand leave the record on the next spawn, when it finds them gone)`
    if (dry) return ok({ ok: true, dryRun: true, mux: kind, board: slug, cwd, harnesses: usable, panes: [] }, [`Dry run: ${message}`])
    return fail('mux_mismatch', message, { slug, mux: existing.mux })
  }
  const warnings: string[] = [...parsed.warnings]
  let adapter: MuxAdapter | undefined
  const bins = new Map<Harness, string>()
  if (!dry) {
    const a = muxAdapter(kind, ctx.env, deps)
    if (!a.ok) return fail(a.code, a.message, { slug })
    adapter = a.adapter
    const missing: Harness[] = []
    for (const h of new Set(harnesses)) {
      const f = lookup(h)
      if (f === undefined) missing.push(h)
      else if (!f.onPath) bins.set(h, f.path)
    }
    if (missing.length > 0) return fail('harness_missing', `${missing.join(', ')} not found on PATH (nor in ${HARNESS_BIN_DIRS.map(d => `~/${d}`).join(', ')}); install it, or pick another harness with --harness`, { slug, missing })
  }
  const tick = await runTick({ board, cwd, kind, storePath, existing, ...(adapter !== undefined ? { adapter } : {}), harnesses, on, lookup, bins, ...(o.workers !== undefined ? { workers: o.workers } : {}) }, ctx)
  warnings.push(...tick.warnings)
  const c = tick.counts
  const n = tick.requested
  const workers = { requested: n, opened: tick.opened.length, active: c.active, standby: c.standby, max: c.max }
  const layout = { rows: tick.layout.rows, cols: tick.layout.cols }
  if (dry || adapter === undefined) {
    return ok({ ok: true, dryRun: true, mux: kind, board: slug, cwd, harnesses: usable, workers, layout, panes: tick.plans.map(p => ({ harness: p.harness, command: p.command, title: p.title })) }, [
      `Dry run: ${n} pane(s) would open in ${kind} for ${slug} (${countsLine(c)}).`,
      ...(n > 0 ? [tick.layoutNote] : []),
      ...tick.plans.map(p => `  ${p.title}: ${p.command}`),
    ], warnings)
  }
  if (n === 0) {
    return ok({ ok: true, slug, mux: kind, cwd, opened: [], failed: [], workers }, [`Nothing to open on ${slug}: ${countsLine(c)}.`], warnings)
  }
  const shown = tick.opened
  const data = { slug, mux: kind, cwd, opened: shown.map(p => ({ id: p.id, harness: p.harness, title: paneLabel(p.title, WAITING) })), failed: tick.failed, workers, layout, ...(tick.attach !== undefined ? { attach: tick.attach } : {}) }
  if (shown.length === 0) return fail('mux_failed', `no pane opened in ${kind} (${tick.failed.length} attempt(s) failed); check that ${kind} takes commands from this session`, data)
  const lines = [
    `Opened ${shown.length} pane(s) in ${kind} for ${slug}: ${shown.map(p => `${p.id} ${p.harness}`).join(', ')}. Each starts its harness with /buracle-join ${slug} ($buracle-join ${slug} in Codex) and takes a task.`,
    `Pane map (${kind}):`,
    ...shown.map(p => `  ${p.id}  ${paneLabel(p.title, WAITING)}`),
    tick.layoutNote,
    'A pane label names its worker and, once it joined, its task (NEEDS YOU while it waits for the user). buracle work status maps every pane to its task.',
    ...(tick.attach !== undefined ? [`Attach with: ${tick.attach}`] : []),
    'Then: buracle work wait --json → buracle work merge --json → run the checks. buracle work close closes the panes Buracle opened.',
  ]
  if (tick.failed.length > 0) warnings.push(`${tick.failed.length} pane(s) did not open: ${tick.failed.map(f => `#${f.index} ${f.harness}`).join(', ')}`)
  // A clamp or a pane that did not open is worth exit 2: the lead reads the warning before it waits for workers that are not there.
  return warnings.length > 0 ? partial({ ok: true, ...data }, lines, warnings) : ok({ ok: true, ...data }, lines)
}

/** What `work publish` and `work merge` report about the tick: the panes it opened, the panes the merge closed, and the advice when there are no panes. */
export interface ScaleView { opened: Array<{ id: string; harness: Harness; title: string }>; closed: string[]; advice?: string }

/**
 * The tick after a publish or a merge. The board has panes when a pane store exists, or when the plan asked for them
 * (`Panes:` under `## Assumptions`, kept on the board) while the lead sits in a multiplexer and `plan.board.mux` is not
 * off: the ready tasks that no standby worker or starting pane covers get a pane each, dealt from the board's harnesses
 * (else the installed ones that are on). Without panes the lead is told how many terminals to open for them. `closed`
 * is what the caller closed before the tick, so the lead reads one object.
 */
export async function scaleAfter(commonDir: string, board: Board, closed: readonly string[], ctx: WorkflowCtx, deps: PaneDeps = {}): Promise<{ scale: ScaleView; lines: string[]; warnings: string[] }> {
  const warnings: string[] = []
  const scale: ScaleView = { opened: [], closed: [...closed] }
  const { path: storePath, store } = paneStoreFor(commonDir, board.slug)
  const cfg = swarmConfig()
  const lookup = binLookup(ctx.env, deps)
  const detect = store !== undefined ? detectMux(ctx.env, store.mux) : detectMux(ctx.env)
  const wantPanes = store !== undefined || (board.panes !== undefined && cfg.mux !== 'off')
  if (wantPanes && !detect.ok && store !== undefined) warnings.push(`the panes of ${board.slug} were opened in ${store.mux}, which this session cannot reach (${detect.message}); no pane opened`)
  if (wantPanes && detect.ok) {
    const kind = detect.kind
    const a = muxAdapter(kind, ctx.env, deps)
    if (!a.ok) warnings.push(a.message)
    else {
      const source: HarnessSource = board.harnesses !== undefined ? { kind: 'board', list: board.harnesses } : { kind: 'installed' }
      const parsed = dealableHarnesses(source, cfg.harnesses, h => lookup(h) !== undefined)
      const harnesses = 'list' in parsed ? parsed.list : []
      warnings.push(...('list' in parsed ? parsed.warnings : parsed.errors))
      const bins = new Map<Harness, string>()
      for (const h of new Set(harnesses)) {
        const f = lookup(h)
        if (f !== undefined && !f.onPath) bins.set(h, f.path)
      }
      const tick = await runTick({ board, cwd: checkoutRootOf(ctx.cwd) ?? ctx.cwd, kind, storePath, existing: store, adapter: a.adapter, harnesses, on: cfg.harnesses, lookup, bins }, ctx)
      warnings.push(...tick.warnings)
      scale.opened = tick.opened.map(p => ({ id: p.id, harness: p.harness, title: paneLabel(p.title, WAITING) }))
      if (tick.requested > 0 && tick.opened.length === 0) warnings.push(`mux_failed: no pane opened in ${kind} (${tick.failed.length} attempt(s) failed); check that ${kind} takes commands from this session, or run buracle work spawn --json`)
      const lines = scale.opened.length === 0 ? [] : [
        `Opened ${scale.opened.length} pane(s) in ${kind} for ${board.slug}: ${scale.opened.map(p => `${p.id} ${p.harness}`).join(', ')}. Each starts its harness with /buracle-join ${board.slug} and takes a task.`,
        ...(tick.attach !== undefined ? [`Attach with: ${tick.attach}`] : []),
      ]
      return { scale, lines, warnings }
    }
  }
  // Without panes: the ready tasks nobody covers need terminals the user opens.
  const counts = tickCounts(board, store?.panes ?? [], ctx.now, dealableReady(board, cfg.harnesses, lookup).length)
  const k = Math.min(counts.need, counts.cap)
  if (k === 0) return { scale, lines: [], warnings }
  scale.advice = `${counts.ready} task(s) ready, ${counts.standby} worker(s) waiting: open ${k} terminal(s) in this repository and run \`/buracle-join ${board.slug}\` in each (\`$buracle-join ${board.slug}\` in Codex).`
  return { scale, lines: [scale.advice], warnings }
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
export async function bindPaneToSession(commonDir: string, slug: string, env: Env, session: BoardSession, deps: MuxDeps = {}): Promise<{ mux: MuxKind; id: string; bound: boolean } | undefined> {
  const { path, store } = paneStoreFor(commonDir, slug)
  if (store === undefined) return undefined
  const envId = paneIdOf(store.mux, env)
  const a = muxAdapter(store.mux, env, deps)
  // The environment can lie: Codex replays a shell snapshot, so its pane id may belong to an earlier session, and herdr
  // reuses ids across sessions. When the multiplexer can name a pane's shell, the pane whose shell this process descends
  // from wins; the environment's id counts only when no shell matched and the pane it names is free or already ours.
  const byShell = a.ok ? await paneByShell(store, a.adapter, env, session, deps) : undefined
  let id: string | undefined = byShell?.id
  let handles: string[] = []
  if (id === undefined && envId !== undefined) {
    const free = (p: MuxRecord | undefined): boolean => p !== undefined && (p.session === undefined || sameSession(p.session, session))
    if (free(findPane(store, envId))) id = envId
    else if (findPane(store, envId) === undefined) {
      // cmux records a surface by the ref new-split printed, while the pane's CMUX_SURFACE_ID is the UUID: the multiplexer
      // says which other handles this pane has, and the record learns them.
      handles = (a.ok && a.adapter.handlesOf !== undefined ? await a.adapter.handlesOf(envId) : undefined) ?? []
      if (free(handles.map(h => findPane(store, h)).find(p => p !== undefined))) id = envId
    }
  }
  if (id === undefined) return envId === undefined ? undefined : { mux: store.mux, id: envId, bound: false }
  const paneId = id
  let bound = false
  const r = updateMuxStore(path, st => {
    if (st === undefined) return undefined
    const b = bindPane(st, paneId, session, handles)
    bound = b.bound
    return b.bound ? b.store : undefined
  })
  return { mux: store.mux, id: paneId, bound: r.ok && bound }
}

/**
 * The recorded pane whose shell is an ancestor of this process, among the panes nobody joined from yet and the one already
 * bound to `session` (a second join from the same pane); undefined when there is none or the multiplexer cannot say.
 */
async function paneByShell(store: MuxStore, adapter: MuxAdapter, env: Env, session: BoardSession, deps: MuxDeps): Promise<MuxRecord | undefined> {
  if (adapter.shellPid === undefined) return undefined
  const open = store.panes.filter(p => p.session === undefined || sameSession(p.session, session))
  if (open.length === 0) return undefined
  const ancestors = await ancestorPids(deps.pid ?? process.pid, env, deps.exec)
  for (const p of open) {
    const shell = await adapter.shellPid(p.id)
    if (shell !== undefined && ancestors.includes(shell)) return p
  }
  return undefined
}

/**
 * The pane a worker runs in: the one bound to its session, else the recorded one its environment names, else (tmux only)
 * the pane itself, so a hand-opened pane still shows the question.
 */
function workerPane(commonDir: string, slug: string, env: Env, me: BoardSession): { kind: MuxKind; pane: MuxPane; recorded: boolean } | undefined {
  const { store } = paneStoreFor(commonDir, slug)
  if (store !== undefined) {
    const mine = store.panes.find(p => sameSession(p.session, me))
    if (mine !== undefined) return { kind: store.mux, pane: mine, recorded: true }
    const id = paneIdOf(store.mux, env)
    const rec = id !== undefined ? findPane(store, id) : undefined
    if (rec !== undefined) return { kind: store.mux, pane: rec, recorded: true }
  }
  const tmux = paneIdOf('tmux', env)
  if (tmux !== undefined) return { kind: 'tmux', pane: { id: tmux, harness: me.harness, title: '', server: '' }, recorded: false }
  return undefined
}

/** The id of the pane a worker runs in, for the note the lead reads (undefined when the worker is not in a pane of the board). */
export function paneRefOf(commonDir: string, slug: string, env: Env, me: BoardSession): string | undefined {
  return workerPane(commonDir, slug, env, me)?.pane.id
}

/** Sets the label of the worker's own pane. Only a pane Buracle opened is renamed; a pane the user opened keeps its title. */
export async function labelWorkerPane(commonDir: string, slug: string, env: Env, me: BoardSession, st: PaneStage, deps: MuxDeps = {}): Promise<{ labeled: boolean }> {
  if (env['BURACLE_NO_NOTIFY'] === '1') return { labeled: false }
  const found = workerPane(commonDir, slug, env, me)
  if (found === undefined || !found.recorded) return { labeled: false }
  const a = muxAdapter(found.kind, env, deps)
  if (!a.ok) return { labeled: false }
  return { labeled: await a.adapter.title(found.pane, paneLabel(found.pane.title, st)) }
}

/**
 * `work ask`: the worker's pane gets the mark and, with `focus`, the focus. tmux marks with the title, the mark and a bell;
 * herdr and cmux are told by `notifyTerminal`, so their pane list only needs the new label.
 */
export async function markPaneOnAsk(commonDir: string, slug: string, env: Env, me: BoardSession, task: { n: number; title: string }, onAsk: MuxOnAsk, deps: MuxDeps = {}): Promise<{ marked: boolean; focused: boolean }> {
  const none = { marked: false, focused: false }
  if (env['BURACLE_NO_NOTIFY'] === '1') return none
  const found = workerPane(commonDir, slug, env, me)
  if (found === undefined) return none
  const a = muxAdapter(found.kind, env, deps)
  if (!a.ok) return none
  const text = found.recorded ? paneLabel(found.pane.title, { stage: 'asking', ...task }) : `Task ${task.n} needs you`
  const marked = await a.adapter.mark(found.pane, text)
  if (found.recorded && found.kind !== 'tmux') await a.adapter.title(found.pane, text)
  const focused = onAsk === 'focus' ? await a.adapter.focus(found.pane) : false
  return { marked, focused }
}

/**
 * `kept`: still open (the multiplexer did not answer or refused, its CLI is missing, or `--keep-panes`). `refused`: the
 * kept panes the multiplexer answered for, with what it said. `unreadable`: the sidecar could not be read and was removed.
 */
export interface ClosedPanes { closed: string[]; kept: string[]; stale: string[]; refused?: Array<{ id: string; message: string }>; mux?: MuxKind; unreadable?: boolean }

const NO_PANES: ClosedPanes = { closed: [], kept: [], stale: [] }

/** The warnings a lead command prints for panes that stayed open: a refusal with the multiplexer's words, else "did not answer". */
export function keptPanesWarnings(panes: ClosedPanes): string[] {
  const refused = panes.refused ?? []
  const unanswered = panes.kept.filter(id => !refused.some(r => r.id === id))
  const mux = panes.mux ?? 'the multiplexer'
  const out: string[] = []
  if (refused.length > 0) out.push(`${mux} refused to close pane(s) ${refused.map(r => `${r.id} (${r.message})`).join(', ')}; close them by hand`)
  if (unanswered.length > 0) out.push(`pane(s) ${unanswered.join(', ')} could not be checked or closed (${mux} did not answer); close them by hand`)
  return out
}

async function closePanes(path: string, store: MuxStore, panes: readonly MuxRecord[], env: Env, deps: MuxDeps): Promise<ClosedPanes> {
  const refused: Array<{ id: string; message: string }> = []
  const out: ClosedPanes = { closed: [], kept: [], stale: [], refused, mux: store.mux }
  if (panes.length === 0) return out
  const a = muxAdapter(store.mux, env, deps)
  // Without its CLI the multiplexer could not be asked at all: the panes are kept, not refused.
  if (!a.ok) { out.kept.push(...panes.map(p => p.id)); return out }
  let down = false
  for (const p of panes) {
    // Once the multiplexer stopped answering, the rest would only wait out the same timeout each. A refusal is an answer:
    // the next pane may well close.
    const r = down ? { ok: false as const, reason: 'failed' as const } : await a.adapter.close(p)
    if (r.ok) out.closed.push(p.id)
    else if (r.reason === 'stale') out.stale.push(p.id)
    else if (r.reason === 'refused') { out.kept.push(p.id); refused.push({ id: p.id, message: r.message }) }
    else { out.kept.push(p.id); down = true }
  }
  const gone = [...out.closed, ...out.stale]
  if (gone.length > 0) updateMuxStore(path, st => (st === undefined ? undefined : removePanes(st, gone)))
  return out
}

/**
 * After a merge: a recorded pane closes when its worker is bound and holds no task, nothing its harness could still take
 * remains on the board (`remainingFor`: the open and stale tasks not reserved for another harness, blocked ones
 * included) and every task the worker last held is merged. A blocked task keeps the pane: its worker waits for it
 * (`join --wait`). A Build board gets new tasks every round, so its panes stay until `work close`. A pane nobody joined
 * from yet may hold a worker that is still starting; it waits for `work close` too. `workers` names the sessions whose
 * panes closed, so the caller can drop their standby entries.
 */
export async function closePanesAfterMerge(commonDir: string, board: Board, env: Env, deps: MuxDeps = {}): Promise<ClosedPanes & { workers?: BoardSession[] }> {
  const { path, store } = paneStoreFor(commonDir, board.slug)
  if (store === undefined || board.planType === 'Build') return NO_PANES
  const active = activeWorkers(board)
  const idle = store.panes.filter(p => {
    const who = p.session
    if (who === undefined) return false
    if (active.some(w => sameSession(who, w))) return false
    if (remainingFor(board, p.harness) > 0) return false
    return board.tasks.every(t => !sameSession(t.lastWorker, who) || t.status === 'merged')
  })
  const out = await closePanes(path, store, idle, env, deps)
  const workers = idle.filter(p => out.closed.includes(p.id)).flatMap(p => (p.session !== undefined ? [p.session] : []))
  return workers.length > 0 ? { ...out, workers } : out
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
export async function clearPaneMark(commonDir: string, slug: string, env: Env, me: BoardSession, task: { n: number; title: string }, deps: MuxDeps = {}): Promise<{ cleared: boolean }> {
  if (env['BURACLE_NO_NOTIFY'] === '1') return { cleared: false }
  const found = workerPane(commonDir, slug, env, me)
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
