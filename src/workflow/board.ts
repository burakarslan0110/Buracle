// The task board commands: `buracle work …`. The lead publishes a plan's open tasks, workers join from any harness
// session of the same repository, and the lead merges in dependency order. The pure transitions live in
// src/core/board/model.ts, the file in src/workflow/board-store.ts.
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { Board, BoardEvent, BoardNote, BoardRole, BoardSession, BoardTask, BoardWorktree, NoteKind } from '../core/board/model'
import {
  NOTE_KINDS, activeWorkers, addNote, ask, boardFromPlan, boardSummary, claim, claimable, eventsAfter, heartbeat, markDelivered, markDone, markMerged, mergeBoard, nextMergeable, notesFor, release, reopen, resume, setWorktree, unclaim,
} from '../core/board/model'
import { parsePlan, planOutline } from '../core/plan/format'
import { loadConfigSync } from '../engine/config'
import { latestWindows } from '../usage/telemetry'
import { boardPath, commonDirOf, listBoards, markAsked, newToken, patchSessionBoard, publishBoard, removeBoard, sessionBoard, setSessionBoard, updateBoard, writeTerminalSequence } from './board-store'
import { git, gitError, porcelain, repoFacts, realish, type RepoFacts } from './gitx'
import { notify } from './notify'
import { isValidSlug, readPlanFile, slugFromPlanPath, tickTask } from './plan-file'
import { fail, ok, partial, type CmdResult, type WorkflowCtx } from './result'
import { loadState, type ResolvedSession } from './session-store'
import { notifyTerminal } from './terminal-notify'
import { listMeta, worktreeCleanup, worktreeCreate, worktreeSync } from './worktree'

export const WAIT_DEFAULT_SEC = 90
const WAIT_POLL_MS = 1000

export const MAX_SLUG = 64
/** From the fourth worker on, a rate window this full refuses the join (`usage_low`). */
export const USAGE_LOW_PCT = 90
const USAGE_CHECK_FROM = 3

function sessionOf(s: ResolvedSession): BoardSession { return { harness: s.harness, session: s.sessionId } }

async function needRepo(cwd: string): Promise<RepoFacts | CmdResult> {
  const facts = await repoFacts(cwd)
  return facts ?? fail('no_repo', `${cwd} is not inside a git repository; the board lives in the repository's git common dir`)
}

function isFacts(x: RepoFacts | CmdResult): x is RepoFacts { return 'commonDir' in x }

/** The lines of one `## Section` of the plan, without the heading. */
function sectionLines(text: string, name: string): string[] {
  const o = planOutline(text)
  const sec = o.sections.find(s => s.text.trim().toLowerCase() === name)
  if (sec === undefined) return []
  return o.lines.slice(sec.line + 1, sec.end).map(l => l.replace(/\s+$/, ''))
}

function boardConfig(): { mode: string, maxWorkers: number, leaseSec: number } {
  try { return loadConfigSync().config.plan.board } catch { return { mode: 'ask', maxWorkers: 6, leaseSec: 300 } }
}

function laneSlugFor(slug: string, n: number): string { return `${slug}-t${n}` }

export interface PublishOptions { planPath?: string, maxWorkers?: number, leaseSec?: number }

export async function workPublish(o: PublishOptions, ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  const state = loadState(s.harness, s.sessionId)
  const bound = state.plan
  const planPath = o.planPath !== undefined ? resolve(ctx.cwd, o.planPath) : bound?.path
  if (planPath === undefined) return fail('usage', 'no plan is registered in this session; pass the plan path: buracle work publish <plan path>')
  const read = readPlanFile(planPath)
  if (!read.ok) return fail(read.code === 'missing' ? 'not_found' : 'io', read.error, { path: planPath })
  const plan = parsePlan(read.text)
  if (plan.header.approved !== true) return fail('not_approved', `the plan ${planPath} is not approved yet (approved: false); the board distributes only approved plans`, { path: planPath })
  const slug = bound !== undefined && bound.path === planPath ? bound.slug : slugFromPlanPath(planPath)
  if (!isValidSlug(slug)) return fail('usage', `the plan slug '${slug}' is not a valid board slug`)
  const fr = await needRepo(ctx.cwd)
  if (!isFacts(fr)) return fr
  const facts = fr
  if (facts.branch === undefined) return fail('detached_head', 'HEAD is detached; check out the branch the workers should merge into first')
  const cfg = boardConfig()
  const maxWorkers = o.maxWorkers ?? cfg.maxWorkers
  const leaseSec = o.leaseSec ?? cfg.leaseSec
  if (!Number.isInteger(maxWorkers) || maxWorkers < 1) return fail('usage', `--max-workers must be a whole number of 1 or more (got ${String(o.maxWorkers)})`)
  if (!Number.isInteger(leaseSec) || leaseSec < 1) return fail('usage', `--lease-sec must be a whole number of 1 or more (got ${String(o.leaseSec)}); the config key plan.board.leaseSec needs at least 10`)
  const open = plan.tasks.filter(t => !t.done)
  const widest = Math.max(0, ...plan.tasks.map(t => t.n))
  if (laneSlugFor(slug, widest).length > MAX_SLUG) return fail('usage', `the lane worktree name ${laneSlugFor(slug, widest)} exceeds ${MAX_SLUG} characters; rename the plan file to a shorter slug`)
  const inside = facts.linked ? listMeta(facts.commonDir).find(x => realish(x.path) === facts.top) : undefined
  const fresh = boardFromPlan(plan.tasks, {
    slug, plan: planPath, planType: plan.header.type, base: facts.branch, ...(inside !== undefined ? { parent: inside.slug } : {}),
    lead: sessionOf(s), maxWorkers, leaseSec, constraints: sectionLines(read.text, 'constraints').filter(l => l.trim() !== ''), context: sectionLines(read.text, 'context').join('\n').trim(), now: ctx.now,
  })
  if (!fresh.ok) return fail(fresh.code, fresh.message, { path: planPath })
  const path = boardPath(facts.commonDir, slug)
  const r = publishBoard(path, fresh.board, mergeBoard)
  if (!r.ok) return fail(r.code, r.message, { path })
  // The event cursor survives a re-publish of the same board file only: another repository's board starts its sequence afresh.
  const cursor = state.board?.path === path ? state.board.cursor ?? 0 : 0
  setSessionBoard(s.harness, s.sessionId, { slug, path, role: 'lead', cursor })
  const board = r.board
  const changedTasks = r.changedTasks ?? []
  const data = {
    ok: true, slug, path, plan: planPath, lead: board.lead, base: board.base, ...(board.parent !== undefined ? { parent: board.parent } : {}), maxWorkers: board.maxWorkers, leaseSec: board.leaseSec,
    tasks: board.tasks.map(taskView), summary: boardSummary(board), changed: changedTasks, open: open.length,
  }
  const lines = [
    `Published ${board.tasks.length} task(s) of ${slug} to the board (${path}).`,
    `Workers join from any Buracle session in this repository with: /buracle-join ${slug} ($buracle-join ${slug} in Codex; CLI: buracle work join ${slug} --json)`,
    `Lead loop: buracle work wait --json → buracle work merge --json → run the checks; base branch ${board.base}, at most ${board.maxWorkers} workers, lease ${board.leaseSec} s.`,
  ]
  if (changedTasks.length > 0) {
    const msg = `plan_changed_while_active: the plan changed the files or dependencies of active task(s) ${changedTasks.map(n => `Task ${n}`).join(', ')}; the board keeps its values until you reopen them (buracle work reopen <n>)`
    return partial(data, lines, [msg])
  }
  return ok(data, lines)
}

export interface TaskView { n: number, title: string, status: BoardTask['status'], deps: number[], files: string[], worker?: { harness: string, session: string, leaseAgeSec?: number }, worktree?: string, question?: string, report?: BoardTask['report'] }

function taskView(t: BoardTask, now?: number): TaskView {
  const v: TaskView = { n: t.n, title: t.title, status: t.status, deps: t.deps, files: t.files.map(f => f.path) }
  if (t.worker !== undefined) {
    v.worker = { harness: t.worker.harness, session: t.worker.session }
    if (now !== undefined && t.heartbeatAt !== undefined) v.worker.leaseAgeSec = Math.max(0, Math.round((now - t.heartbeatAt) / 1000))
  }
  if (t.worktree !== undefined) v.worktree = t.worktree.path
  if (t.question !== undefined) v.question = t.question
  if (t.report !== undefined) v.report = t.report
  return v
}

function short(session: string): string { return session.length > 12 ? `${session.slice(0, 12)}…` : session }

export function taskLine(t: BoardTask, now: number): string {
  const who = t.worker !== undefined ? `${t.worker.harness} ${short(t.worker.session)}` : undefined
  const lease = t.leaseUntil !== undefined ? ` (lease ${Math.max(0, Math.round((t.leaseUntil - now) / 1000))} s)` : ''
  switch (t.status) {
    case 'open': return `Task ${t.n} open: ${t.title}`
    case 'claimed': return `Task ${t.n} claimed by ${who ?? '?'}${lease}: ${t.title}`
    case 'waiting': return `Task ${t.n} waiting by ${who ?? '?'} (question: ${t.question ?? ''}): ${t.title}`
    case 'done': return `Task ${t.n} done${t.report !== undefined ? ` on ${t.report.branch}` : ''}: ${t.title}`
    case 'merged': return `Task ${t.n} merged: ${t.title}`
    default: return `Task ${t.n} stale${t.lastWorker !== undefined ? ` (was ${t.lastWorker.harness} ${short(t.lastWorker.session)})` : ''}: ${t.title}`
  }
}

/** Which board a command means: the slug given, else the session's board, else its plan's board, else the repository's only board. */
export function resolveBoardPath(slugArg: string | undefined, facts: RepoFacts, s: ResolvedSession | undefined): { slug: string, path: string } | CmdResult {
  if (slugArg !== undefined) {
    if (!isValidSlug(slugArg)) return fail('usage', `'${slugArg}' is not a board slug: kebab-case ASCII (a-z, 0-9, '-'), at most ${MAX_SLUG} characters`)
    return { slug: slugArg, path: boardPath(facts.commonDir, slugArg) }
  }
  if (s !== undefined) {
    const bound = sessionBoard(s.harness, s.sessionId)
    if (bound !== undefined) return { slug: bound.slug, path: bound.path }
    const plan = loadState(s.harness, s.sessionId).plan
    if (plan !== undefined && isValidSlug(plan.slug)) return { slug: plan.slug, path: boardPath(facts.commonDir, plan.slug) }
  }
  const all = listBoards(facts.commonDir)
  if (all.length === 1 && all[0] !== undefined) return { slug: all[0].slug, path: all[0].path }
  if (all.length === 0) return fail('no_board', 'this repository has no task board; the lead publishes one with buracle work publish')
  return fail('usage', `this repository has ${all.length} boards (${all.map(b => b.slug).join(', ')}); pass the slug: buracle work status <slug>`)
}

export function statusView(board: Board, now: number): Record<string, unknown> {
  const pending = board.notes.filter(n => n.deliveredTo.length === 0).length
  return {
    ok: true, slug: board.slug, path: board.plan, lead: board.lead, base: board.base, ...(board.parent !== undefined ? { parent: board.parent } : {}),
    maxWorkers: board.maxWorkers, leaseSec: board.leaseSec, summary: boardSummary(board), tasks: board.tasks.map(t => taskView(t, now)), notes: { pending, total: board.notes.length }, seq: board.seq,
  }
}

function isLead(board: Board, s: ResolvedSession): boolean {
  return board.lead.harness === s.harness && board.lead.session === s.sessionId
}

function cardView(t: BoardTask): Record<string, unknown> {
  return { n: t.n, title: t.title, objective: t.objective, files: t.files, deps: t.deps, dod: t.dod }
}

export interface JoinOptions { task?: number }

/**
 * A worker takes a task: the claim runs under the board lock, the lane worktree is created without it (git takes its
 * own lock), and a failed worktree gives the claim back. The session's binding records the task, its token and the worktree.
 */
export async function workJoin(slugArg: string | undefined, o: JoinOptions, ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  const fr = await needRepo(ctx.cwd)
  if (!isFacts(fr)) return fr
  const target = resolveBoardPath(slugArg, fr, s)
  if ('code' in target) return target
  const binding = sessionBoard(s.harness, s.sessionId)
  const me = sessionOf(s)
  const token = newToken()
  let picked: BoardTask | undefined
  let previous: BoardTask | undefined
  const claimed = updateBoard(target.path, ctx.now, b => {
    if (isLead(b, s)) return { ok: false, code: 'lead_cannot_join', message: `this session is the lead of the board ${b.slug}: the lead waits (buracle work wait) and merges (buracle work merge); it never takes a task` }
    if (binding?.role === 'worker' && binding.task !== undefined && binding.slug === b.slug) {
      const held = b.tasks.find(t => t.n === binding.task)
      if (held !== undefined && held.token === binding.token && (held.status === 'claimed' || held.status === 'waiting')) {
        return { ok: false, code: 'already_claimed', message: `this session already holds Task ${held.n} (${held.status}): finish it with 'buracle work done --verify "<evidence>"', or give it back with 'buracle work release'` }
      }
    }
    const workers = activeWorkers(b)
    const mine = workers.some(w => w.harness === me.harness && w.session === me.session)
    if (!mine && workers.length >= b.maxWorkers) return { ok: false, code: 'max_workers', message: `the board ${b.slug} already has ${workers.length} worker(s), its limit (plan.board.maxWorkers, or --max-workers at publish)` }
    if (!mine && workers.length >= USAGE_CHECK_FROM) {
      const hot = latestWindows(s.harness, ctx.now).find(w => w.pct >= USAGE_LOW_PCT)
      if (hot !== undefined) return { ok: false, code: 'usage_low', message: `${s.harness}'s ${hot.label} rate window is at ${hot.pct}% (limit ${USAGE_LOW_PCT}% from the ${USAGE_CHECK_FROM + 1}th worker on); wait for it to reset before joining` }
    }
    let n = o.task
    if (n === undefined) {
      const view = claimable(b)
      n = view.ready[0]
      if (n === undefined) {
        const open = b.tasks.filter(t => t.status === 'open' || t.status === 'stale').length
        const why = view.blocked.length > 0 ? view.blocked.map(x => `Task ${x.n} ${x.detail}`).join('; ') : open === 0 ? 'no task is open' : 'no open task is ready'
        return { ok: false, code: 'nothing_to_claim', message: `nothing to claim on the board ${b.slug}: ${why}` }
      }
    }
    previous = b.tasks.find(t => t.n === n)
    const c = claim(b, n, me, ctx.now, token)
    if (!c.ok) return c
    picked = c.board.tasks.find(t => t.n === n)
    return c
  })
  if (!claimed.ok) return fail(claimed.code, claimed.message, { slug: target.slug })
  if (picked === undefined || previous === undefined) return fail('internal', 'the claim left no task behind')
  const board = claimed.board
  const n = picked.n
  const laneSlug = laneSlugFor(board.slug, n)
  const prefix = board.planType === 'Build' ? 'goal-build' : 'plan-build'
  const wt = await worktreeCreate(laneSlug, { base: board.base, prefix, lane: true, ...(board.parent !== undefined ? { parent: board.parent } : {}) }, ctx, s)
  if (wt.code !== 0) {
    const reason = `worktree failed: ${String(wt.data['error'] ?? 'error')}`
    const prev = previous
    updateBoard(target.path, ctx.now, b => unclaim(b, n, token, prev, ctx.now, reason))
    return { ...wt, data: { ...wt.data, task: n, released: true }, errors: [...wt.errors, `Task ${n} was given back to the board: ${reason}`] }
  }
  const worktree: BoardWorktree = { slug: laneSlug, path: String(wt.data['path']), branch: String(wt.data['branch']), base: String(wt.data['base']) }
  const fin = updateBoard(target.path, ctx.now, b => setWorktree(b, n, token, worktree))
  if (!fin.ok) return fail(fin.code, fin.message, { slug: target.slug, task: n })
  setSessionBoard(s.harness, s.sessionId, { slug: board.slug, path: target.path, role: 'worker', task: n, token, worktree: worktree.path, heartbeatAt: ctx.now })
  const task = fin.board.tasks.find(t => t.n === n) ?? picked
  const created = wt.data['created'] === true
  const lines = [
    `Claimed Task ${n} of ${board.slug}: ${task.title}`,
    `Worktree: ${worktree.path} (branch ${worktree.branch} from ${worktree.base}${created ? '' : ', resumed from the previous worker'}). Do all the work there; the main checkout belongs to the lead.`,
    `Lease ${board.leaseSec} s, renewed by the hooks on every prompt and tool call. Finish with: buracle work done --verify "<command → result>"; a question: buracle work ask "<question>"; giving it back: buracle work release.`,
    ...(task.objective !== '' ? [`Objective: ${task.objective}`] : []),
    ...(task.files.length > 0 ? [`Files: ${task.files.map(f => `${f.verb}: ${f.path}`).join(', ')}`] : []),
  ]
  return ok({
    ok: true, slug: board.slug, task: cardView(task), worktree: { ...worktree, created }, lease: { until: task.leaseUntil ?? null, sec: board.leaseSec },
    plan: board.plan, base: board.base, constraints: board.constraints, context: board.context, lead: board.lead,
  }, lines, wt.errors.map(e => e.replace(/^warning: /, '')))
}

function needTask(s: ResolvedSession): { slug: string, path: string, task: number, token: string } | CmdResult {
  const b = sessionBoard(s.harness, s.sessionId)
  if (b === undefined || b.role !== 'worker') return fail('usage', 'this session is not a board worker; take a task with buracle work join <slug>')
  if (b.task === undefined || b.token === undefined) return fail('usage', `this session holds no board task on ${b.slug}; take one with buracle work join ${b.slug}`)
  return { slug: b.slug, path: b.path, task: b.task, token: b.token }
}

function dropClaim(s: ResolvedSession): void {
  patchSessionBoard(s.harness, s.sessionId, { task: undefined, token: undefined, worktree: undefined, heartbeatAt: undefined })
}

/** Renews the lease; a token that no longer matches means the task went stale and another worker took it. */
export function workHeartbeat(ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  const t = needTask(s)
  if ('code' in t) return t
  const r = updateBoard(t.path, ctx.now, b => heartbeat(b, t.task, t.token, ctx.now))
  if (!r.ok) {
    if (r.code === 'reassigned') {
      dropClaim(s)
      return fail('reassigned', `${r.message}. Stop working on it: run 'buracle work join ${t.slug}' for a new task`, { slug: t.slug, task: t.task })
    }
    return fail(r.code, r.message, { slug: t.slug, task: t.task })
  }
  patchSessionBoard(s.harness, s.sessionId, { heartbeatAt: ctx.now })
  const task = r.board.tasks.find(x => x.n === t.task)
  return ok({ ok: true, slug: t.slug, task: t.task, leaseUntil: task?.leaseUntil ?? null, leaseSec: r.board.leaseSec }, [`Task ${t.task}: lease renewed until ${new Date(task?.leaseUntil ?? ctx.now).toISOString()}`])
}

/** Gives the task back. A worker without a task leaves the board instead: the session edits the repository again. */
export function workRelease(o: { reason?: string }, ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  const b = sessionBoard(s.harness, s.sessionId)
  if (b !== undefined && b.role === 'worker' && b.task === undefined) {
    setSessionBoard(s.harness, s.sessionId, undefined)
    return ok({ ok: true, slug: b.slug, left: true }, [`Left the board ${b.slug}: this session is no longer a worker.`])
  }
  const t = needTask(s)
  if ('code' in t) return t
  const r = updateBoard(t.path, ctx.now, board => {
    const rel = release(board, t.task, t.token, ctx.now, o.reason)
    if (!rel.ok) return rel
    return { ok: true, board: addNote(rel.board, { from: sessionOf(s), role: 'worker', to: 'lead', kind: 'nudge', text: `released Task ${t.task}${o.reason !== undefined ? `: ${o.reason}` : ''}` }, ctx.now).board }
  })
  if (!r.ok) {
    if (r.code === 'not_claimed_by_you' || r.code === 'task_not_open') dropClaim(s)
    return fail(r.code, r.message, { slug: t.slug, task: t.task })
  }
  dropClaim(s)
  return ok({ ok: true, slug: t.slug, task: t.task, status: 'open' }, [`Task ${t.task} is open again on ${t.slug}; its worktree stays for the next worker. Take another with 'buracle work join ${t.slug}', or run 'buracle work release' again to leave the board.`])
}

/** The worker reports the task done: the branch and the commits come from its worktree, the evidence from --verify. */
export async function workDone(o: { verify?: string }, ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  const t = needTask(s)
  if ('code' in t) return t
  const verify = o.verify?.trim() ?? ''
  if (verify === '') return fail('usage', 'missing --verify "<command → result>": say what proved the task')
  const binding = sessionBoard(s.harness, s.sessionId)
  const before = updateBoard(t.path, ctx.now, b => ({ ok: true, board: b }))
  if (!before.ok) return fail(before.code, before.message, { slug: t.slug, task: t.task })
  const task = before.board.tasks.find(x => x.n === t.task)
  if (task === undefined || task.token !== t.token || (task.status !== 'claimed' && task.status !== 'waiting')) {
    dropClaim(s)
    return fail('reassigned', `Task ${t.task} is no longer this session's: it is ${task?.status ?? 'gone'}${task?.worker !== undefined ? ` by ${task.worker.harness} ${task.worker.session}` : ''}`, { slug: t.slug, task: t.task })
  }
  const wt = task.worktree?.path ?? binding?.worktree
  if (wt === undefined) return fail('usage', `Task ${t.task} has no lane worktree on record; join it again`)
  const st = await porcelain(wt)
  if (st === undefined) return fail('git_failed', `cannot read the status of ${wt}`)
  const dirty = [...st.tracked, ...st.untracked]
  if (dirty.length > 0) return fail('worktree_dirty', `commit first: ${dirty.length} uncommitted change(s) in ${wt} (${dirty.slice(0, 5).join(', ')}${dirty.length > 5 ? ', …' : ''})`, { path: wt })
  const branch = (await git(wt, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { readOnly: true })).out || task.worktree?.branch || 'HEAD'
  const base = task.worktree?.base ?? before.board.base
  const log = await git(wt, ['log', '--format=%h %s', `${base}..HEAD`], { readOnly: true })
  const commits = log.ok && log.out !== '' ? log.out.split('\n') : []
  const r = updateBoard(t.path, ctx.now, b => {
    const d = markDone(b, t.task, t.token, { branch, commits, verify }, ctx.now)
    if (!d.ok) return d
    const text = `Task ${t.task} done on ${branch} (${commits.length} commit${commits.length === 1 ? '' : 's'}): ${verify}`
    return { ok: true, board: addNote(d.board, { from: sessionOf(s), role: 'worker', to: 'lead', kind: 'report', text }, ctx.now).board }
  })
  if (!r.ok) return fail(r.code, r.message, { slug: t.slug, task: t.task })
  dropClaim(s)
  return ok({ ok: true, slug: t.slug, task: t.task, status: 'done', branch, commits, verify, base }, [
    `Task ${t.task} is done on ${branch} (${commits.length} commit${commits.length === 1 ? '' : 's'} beyond ${base}); the lead merges it.`,
    `Next: 'buracle work join ${t.slug}' for another task, or 'buracle work release' to leave the board.`,
  ])
}

/** The worker needs the user: the task waits (no lease), the lead gets a note, the terminal a notification. */
export async function workAsk(question: string | undefined, ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  const q = question?.trim() ?? ''
  if (q === '') return fail('usage', 'missing "<question>": buracle work ask "<question>"')
  const t = needTask(s)
  if ('code' in t) return t
  const r = updateBoard(t.path, ctx.now, b => {
    const a = ask(b, t.task, t.token, q, ctx.now)
    if (!a.ok) return a
    return { ok: true, board: addNote(a.board, { from: sessionOf(s), role: 'worker', to: 'lead', kind: 'question', text: `Task ${t.task} waits for the user: ${q}` }, ctx.now).board }
  })
  if (!r.ok) {
    if (r.code === 'not_claimed_by_you' || r.code === 'task_not_open') dropClaim(s)
    return fail(r.code, r.message, { slug: t.slug, task: t.task })
  }
  const title = `Task ${t.task} of ${t.slug} needs you`
  const terminal = await notifyTerminal({ title, body: q, agent: s.harness }, ctx.env)
  writeTerminalSequence(s.harness, s.sessionId, terminal.sequence, ctx.now)
  markAsked(s.harness, s.sessionId, ctx.now)
  const desk = await notify('attention_needed', title, q, {}, ctx, s)
  return ok({ ok: true, slug: t.slug, task: t.task, status: 'waiting', question: q, notified: terminal.sent, terminalSequence: terminal.sequence, cmux: terminal.cmux, herdr: terminal.herdr, desktop: desk.code === 0 }, [
    `Task ${t.task} is waiting for the user${terminal.sent ? ' (terminal notified)' : ''}. Ask the question with the question tool now; after the answer run 'buracle work resume' (the hooks do it on the next prompt, or at the tool result that follows the question tool).`,
  ])
}

/** Claimed again after the answer. The hooks resume first in most runs, so a task that is already claimed by this session is fine. */
export function workResume(ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  const t = needTask(s)
  if ('code' in t) return t
  let already = false
  const r = updateBoard(t.path, ctx.now, b => {
    const cur = b.tasks.find(x => x.n === t.task)
    if (cur?.status === 'claimed' && cur.token === t.token) { already = true; return { ok: true, board: b } }
    return resume(b, t.task, t.token, ctx.now)
  })
  if (!r.ok) {
    if (r.code === 'not_claimed_by_you') dropClaim(s)
    return fail(r.code, r.message, { slug: t.slug, task: t.task })
  }
  if (!already) patchSessionBoard(s.harness, s.sessionId, { heartbeatAt: ctx.now })
  const task = r.board.tasks.find(x => x.n === t.task)
  return ok({ ok: true, slug: t.slug, task: t.task, status: 'claimed', already, leaseUntil: task?.leaseUntil ?? null }, [already ? `Task ${t.task} is already claimed by this session (a hook resumed it).` : `Task ${t.task} is claimed again with a fresh lease.`])
}

function roleOf(board: Board, s: ResolvedSession): BoardRole {
  if (isLead(board, s)) return 'lead'
  const b = sessionBoard(s.harness, s.sessionId)
  return b?.role === 'lead' && b.slug === board.slug ? 'lead' : 'worker'
}

function boardOfSession(s: ResolvedSession, cwd: string): { slug: string, path: string } | CmdResult {
  const b = sessionBoard(s.harness, s.sessionId)
  if (b !== undefined) return { slug: b.slug, path: b.path }
  // The session's binding can be lost (a reset session file); the board itself still names its lead, so it is rebound
  // (the cursor restarts, so the next wait replays the board's events once). With several boards led by this session,
  // the registered plan's slug decides.
  const common = commonDirOf(cwd)
  const led = common !== undefined ? listBoards(common).filter(x => x.board !== undefined && isLead(x.board, s)) : []
  const planSlug = loadState(s.harness, s.sessionId).plan?.slug
  const pick = led.length === 1 ? led[0] : led.find(x => x.slug === planSlug)
  if (pick !== undefined) {
    setSessionBoard(s.harness, s.sessionId, { slug: pick.slug, path: pick.path, role: 'lead', cursor: 0 })
    return { slug: pick.slug, path: pick.path }
  }
  if (led.length > 1) return fail('usage', `this session leads ${led.length} boards (${led.map(x => x.slug).join(', ')}) and its binding is gone: register the plan of the one you mean (buracle plan register <path>) and try again`)
  return fail('usage', 'this session is on no board: the lead publishes with buracle work publish, a worker joins with buracle work join <slug>')
}

export function workNote(text: string | undefined, o: { to?: string, kind?: string }, ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  const body = text?.trim() ?? ''
  if (body === '') return fail('usage', 'missing "<text>": buracle work note "<text>" [--to lead|all|<session>] [--kind report|question|nudge]')
  if (o.kind !== undefined && !(NOTE_KINDS as readonly string[]).includes(o.kind)) return fail('usage', `--kind must be one of ${NOTE_KINDS.join(', ')} (got '${o.kind}')`)
  const target = boardOfSession(s, ctx.cwd)
  if ('code' in target) return target
  let seq = 0
  const r = updateBoard(target.path, ctx.now, b => {
    const role = roleOf(b, s)
    const to = o.to ?? (role === 'lead' ? 'all' : 'lead')
    const kind = (o.kind ?? (role === 'lead' ? 'nudge' : 'report')) as NoteKind
    const added = addNote(b, { from: sessionOf(s), role, to, kind, text: body }, ctx.now)
    seq = added.note.seq
    return { ok: true, board: added.board }
  })
  if (!r.ok) return fail(r.code, r.message, { slug: target.slug })
  return ok({ ok: true, slug: target.slug, seq }, [`Note ${seq} left on ${target.slug}.`])
}

function noteView(n: BoardNote): Record<string, unknown> {
  return { seq: n.seq, from: n.from, role: n.role, to: n.to, kind: n.kind, text: n.text, at: n.at }
}

export function noteLine(n: BoardNote): string {
  return `[${n.kind}] from ${n.role} ${n.from.harness} ${short(n.from.session)}: ${n.text}`
}

/** The notes for this session that nothing delivered yet; they are marked delivered. */
export function workInbox(ctx: WorkflowCtx, s: ResolvedSession): CmdResult {
  const target = boardOfSession(s, ctx.cwd)
  if ('code' in target) return target
  let notes: BoardNote[] = []
  const r = updateBoard(target.path, ctx.now, b => {
    notes = notesFor(b, s.sessionId, roleOf(b, s))
    return { ok: true, board: markDelivered(b, notes.map(n => n.seq), s.sessionId) }
  })
  if (!r.ok) return fail(r.code, r.message, { slug: target.slug })
  return ok({ ok: true, slug: target.slug, notes: notes.map(noteView) }, notes.length === 0 ? [`No new notes on ${target.slug}.`] : notes.map(noteLine))
}

const WAIT_KINDS: ReadonlyArray<BoardEvent['kind']> = ['claimed', 'done', 'waiting', 'resumed', 'stale', 'released', 'reopened', 'note']

function eventLine(e: BoardEvent): string {
  const who = e.session !== undefined ? ` by ${e.harness ?? '?'} ${short(e.session)}` : ''
  const task = e.task !== undefined ? `Task ${e.task} ` : ''
  return `${task}${e.kind}${who}${e.text !== undefined ? `: ${e.text}` : ''}`
}

/**
 * The lead waits for the board to change: a worker claimed, finished, asked, released, went stale, or left a note.
 * Every poll sweeps expired leases, so a stale task is reported even when every worker is silent.
 */
export async function workWait(o: { timeoutSec?: number }, ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  const target = boardOfSession(s, ctx.cwd)
  if ('code' in target) return target
  const timeoutMs = Math.max(0, (o.timeoutSec ?? WAIT_DEFAULT_SEC) * 1000)
  const start = Date.now()
  const offset = ctx.now - start
  let cursor = sessionBoard(s.harness, s.sessionId)?.cursor ?? 0
  for (;;) {
    const now = Date.now() + offset
    let events: BoardEvent[] = []
    let notes: BoardNote[] = []
    let board: Board | undefined
    const r = updateBoard(target.path, now, b => {
      if (!isLead(b, s)) return { ok: false, code: 'not_lead', message: `the board ${b.slug} belongs to the lead ${b.lead.harness} ${b.lead.session}; register the plan in this session to take it over` }
      events = eventsAfter(b, cursor).filter(e => WAIT_KINDS.includes(e.kind) && !(e.kind === 'note' && e.session === s.sessionId))
      if (events.length === 0) { board = b; return { ok: true, board: b } }
      notes = b.notes.filter(n => events.some(e => e.kind === 'note' && e.note === n.seq))
      board = markDelivered(b, notes.map(n => n.seq), s.sessionId)
      return { ok: true, board }
    })
    if (!r.ok) return fail(r.code, r.message, { slug: target.slug })
    const last = r.board.seq
    if (events.length > 0 || Date.now() - start >= timeoutMs) {
      cursor = Math.max(cursor, last)
      patchSessionBoard(s.harness, s.sessionId, { cursor })
      const summary = boardSummary(r.board)
      const view = events.map(e => ({ ...e, ...(e.kind === 'note' ? { note: noteView(notes.find(n => n.seq === e.note) ?? { seq: e.note ?? 0, from: { harness: e.harness ?? 'claude', session: e.session ?? '' }, role: 'worker', to: 'lead', kind: 'nudge', text: e.text ?? '', at: e.at, deliveredTo: [] }) } : {}) }))
      const timedOut = events.length === 0
      const lines = timedOut ? [`No board event within ${Math.round(timeoutMs / 1000)} s on ${target.slug} (${summary.claimed} claimed, ${summary.waiting} waiting, ${summary.done} done, ${summary.open + summary.stale} open).`] : events.map(eventLine)
      return ok({ ok: true, slug: target.slug, events: view, timedOut, cursor, summary }, lines)
    }
    await Bun.sleep(WAIT_POLL_MS)
  }
}

function remaining(board: Board): number {
  return board.tasks.filter(t => t.status !== 'merged').length
}

/**
 * The lead merges the next done task whose dependencies are merged (or --task <n>): a squash-merge of its lane
 * branch into the base, then the plan's checkbox. A conflict leaves the task done for the lead to resolve by hand
 * (`--manual` records that merge).
 */
export async function workMerge(o: { task?: number, manual?: boolean }, ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  const target = boardOfSession(s, ctx.cwd)
  if ('code' in target) return target
  const before = updateBoard(target.path, ctx.now, b => (isLead(b, s) ? { ok: true, board: b } : { ok: false, code: 'not_lead', message: `the board ${b.slug} belongs to the lead ${b.lead.harness} ${b.lead.session}; register the plan in this session to take it over` }))
  if (!before.ok) return fail(before.code, before.message, { slug: target.slug })
  const board = before.board
  let n = o.task
  if (n === undefined) {
    n = nextMergeable(board)
    if (n === undefined) {
      const done = board.tasks.filter(t => t.status === 'done').map(t => t.n)
      const reason = done.length > 0 ? `done task(s) ${done.map(d => `Task ${d}`).join(', ')} wait for a dependency to be merged first` : 'no task is done'
      return ok({ ok: true, merged: false, reason, summary: boardSummary(board), remaining: remaining(board) }, [`Nothing to merge on ${board.slug}: ${reason}.`])
    }
  }
  const task = board.tasks.find(t => t.n === n)
  if (task === undefined) return fail('not_found', `the board has no Task ${n}`, { slug: board.slug })
  if (task.status !== 'done') return fail('task_not_open', `Task ${n} is ${task.status}, not done`, { slug: board.slug, task: n })
  const unmerged = task.deps.filter(d => board.tasks.find(t => t.n === d)?.status !== 'merged')
  if (unmerged.length > 0) return fail('deps_unmerged', `Task ${n} waits for ${unmerged.map(d => `Task ${d}`).join(', ')} to be merged first`, { slug: board.slug, task: n })
  let commit: string | undefined
  const warnings: string[] = []
  if (o.manual !== true) {
    const lane = task.worktree?.slug ?? laneSlugFor(board.slug, n)
    const sync = await worktreeSync(lane, ctx, s)
    if (sync.code === 1) {
      const err = String(sync.data['error'] ?? '')
      const conflicts = Array.isArray(sync.data['conflicts']) ? (sync.data['conflicts'] as string[]) : []
      if ((err === 'merge_failed' && conflicts.length > 0) || err === 'conflicts') {
        return fail('merge_conflict', `Task ${n} did not merge: conflicts in ${conflicts.join(', ') || 'the base checkout'}. Resolve them by hand in the base checkout (git merge --squash ${task.report?.branch ?? `plan-build/${lane}`}, resolve, commit), then run 'buracle work merge --task ${n} --manual'`, { slug: board.slug, task: n, conflicts, branch: task.report?.branch ?? null })
      }
      return { ...sync, data: { ...sync.data, task: n, slug: board.slug } }
    }
    if (sync.code === 2) warnings.push(...sync.errors.map(e => e.replace(/^warning: /, '')))
    if (sync.data['noop'] === true) warnings.push(`Task ${n}: nothing to merge, its branch had no commits beyond ${board.base}; it is marked merged anyway`)
    const c = sync.data['commit']
    commit = typeof c === 'string' ? c : undefined
  }
  const ticked = tickTask(board.plan, n)
  if (!ticked) warnings.push(`the plan file ${board.plan} has no open checkbox for Task ${n}; tick it by hand if needed`)
  const after = updateBoard(target.path, ctx.now, b => markMerged(b, n, ctx.now, commit ?? (o.manual === true ? 'manual' : undefined)))
  if (!after.ok) return fail(after.code, after.message, { slug: board.slug, task: n })
  const sum = boardSummary(after.board)
  const left = remaining(after.board)
  return ok({ ok: true, slug: board.slug, task: n, merged: true, manual: o.manual === true, commit: commit ?? null, ticked, remaining: left, summary: sum }, [
    `Task ${n} merged into ${board.base}${commit !== undefined ? ` as ${commit.slice(0, 9)}` : o.manual === true ? ' (by hand)' : ''}; ${ticked ? 'ticked' : 'not ticked'} in the plan. ${left === 0 ? 'Every task is merged: run the checks, then buracle plan complete.' : `${left} task(s) left; run the checks now, then wait again.`}`,
  ], warnings)
}

/** The lead returns a task to open; a claimed worker gets a note. The worktree and the report stay. */
/**
 * After a squash merge the lane branch and the base hold the same changes as different commits, so a fix committed on
 * the lane would conflict at the next squash merge. Merging the base into the lane first makes the base its ancestor;
 * the next merge then carries only the fix. The lane must be clean; a conflict is undone and reported.
 */
async function catchUpLane(lane: string, base: string): Promise<string | undefined> {
  if (!existsSync(lane)) return `the lane worktree ${lane} is gone; the next join recreates it from ${base}`
  const st = await porcelain(lane)
  if (st === undefined) return `the lane worktree ${lane} could not be read, so ${base} was not merged into it; the worker runs 'git merge ${base}' there before the fix`
  if (st.tracked.length + st.untracked.length > 0) return `the lane worktree ${lane} has uncommitted changes, so ${base} was not merged into it; the worker runs 'git merge ${base}' there before the fix`
  const r = await git(lane, ['-c', 'merge.ff=true', 'merge', '--no-edit', base])
  if (r.ok) return undefined
  await git(lane, ['reset', '-q', '--merge'])
  return `${base} did not merge into the lane worktree ${lane} (${gitError(r)}); the worker merges it by hand there before the fix`
}

export async function workReopen(nArg: string | number | undefined, o: { reason?: string }, ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  const n = typeof nArg === 'number' ? nArg : nArg !== undefined && /^\d+$/.test(nArg) ? Number(nArg) : undefined
  if (n === undefined) return fail('usage', 'missing <n>: buracle work reopen <task number> [--reason <text>]')
  const target = boardOfSession(s, ctx.cwd)
  if ('code' in target) return target
  let notified: string | undefined
  let merged: { plan: string, base: string, lane?: string } | undefined
  const r = updateBoard(target.path, ctx.now, b => {
    if (!isLead(b, s)) return { ok: false, code: 'not_lead', message: `the board ${b.slug} belongs to the lead ${b.lead.harness} ${b.lead.session}` }
    const task = b.tasks.find(t => t.n === n)
    const worker = task?.worker
    if (task?.status === 'merged') merged = { plan: b.plan, base: b.base, ...(task.worktree !== undefined ? { lane: task.worktree.path } : {}) }
    const re = reopen(b, n, ctx.now, o.reason)
    if (!re.ok) return re
    if (worker === undefined) return re
    notified = worker.session
    return { ok: true, board: addNote(re.board, { from: sessionOf(s), role: 'lead', to: worker.session, kind: 'nudge', text: `the lead reopened Task ${n}${o.reason !== undefined ? `: ${o.reason}` : ''}; stop working on it and run buracle work join ${b.slug}` }, ctx.now).board }
  })
  if (!r.ok) return fail(r.code, r.message, { slug: target.slug, task: n })
  // A merged task that is redone is not done: its box opens again until the next merge ticks it, and its lane catches up with the base.
  const boxOpened = merged !== undefined && tickTask(merged.plan, n, false)
  const warn = merged?.lane !== undefined ? await catchUpLane(merged.lane, merged.base) : undefined
  const lines = [`Task ${n} is open again on ${target.slug}${boxOpened ? ' (its box in the plan is open again)' : ''}${notified !== undefined ? ` (its worker ${notified} was told)` : ''}.`]
  if (merged?.lane !== undefined && warn === undefined) lines.push(`${merged.base} was merged into the lane worktree ${merged.lane}, so the next merge carries only the fix.`)
  const data = { ok: true, slug: target.slug, task: n, status: 'open', unticked: boxOpened, ...(merged?.lane !== undefined ? { laneCaughtUp: warn === undefined } : {}), ...(notified !== undefined ? { notified } : {}) }
  return warn !== undefined ? partial(data, lines, [warn]) : ok(data, lines)
}

/** Removes the merged tasks' lane worktrees and the board file; open or active tasks need --force and keep their worktrees. */
export async function workClose(o: { force?: boolean }, ctx: WorkflowCtx, s: ResolvedSession): Promise<CmdResult> {
  const target = boardOfSession(s, ctx.cwd)
  if ('code' in target) return target
  const r = updateBoard(target.path, ctx.now, b => (isLead(b, s) ? { ok: true, board: b } : { ok: false, code: 'not_lead', message: `the board ${b.slug} belongs to the lead ${b.lead.harness} ${b.lead.session}` }))
  if (!r.ok) return fail(r.code, r.message, { slug: target.slug })
  const board = r.board
  const open = board.tasks.filter(t => t.status !== 'merged')
  if (open.length > 0 && o.force !== true) return fail('tasks_open', `${open.length} task(s) are not merged (${open.map(t => `Task ${t.n} ${t.status}`).join(', ')}); merge them first, or pass --force to close the board anyway`, { slug: board.slug, open: open.map(t => t.n) })
  const removed: string[] = []
  const kept: string[] = []
  const warnings: string[] = []
  for (const t of board.tasks) {
    if (t.worktree === undefined || !existsSync(t.worktree.path)) continue
    if (t.status !== 'merged') { kept.push(t.worktree.slug); continue }
    const c = await worktreeCleanup(t.worktree.slug, { force: false, discard: false }, ctx, s)
    if (c.code === 0) removed.push(t.worktree.slug)
    else { kept.push(t.worktree.slug); warnings.push(`${t.worktree.slug}: ${String(c.data['message'] ?? 'cleanup refused')}`) }
  }
  if (kept.length > 0) warnings.push(`lane worktree(s) kept: ${kept.join(', ')}; remove them with buracle worktree cleanup <slug> (--discard drops unmerged work)`)
  removeBoard(target.path)
  setSessionBoard(s.harness, s.sessionId, undefined)
  return ok({ ok: true, slug: board.slug, closed: true, removedWorktrees: removed, keptWorktrees: kept }, [`Closed the board ${board.slug}: ${removed.length} lane worktree(s) removed${kept.length > 0 ? `, ${kept.length} kept` : ''}.`], warnings)
}

export async function workStatus(slugArg: string | undefined, ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<CmdResult> {
  const fr = await needRepo(ctx.cwd)
  if (!isFacts(fr)) return fr
  const target = resolveBoardPath(slugArg, fr, s)
  if ('code' in target) return target
  const r = updateBoard(target.path, ctx.now, b => ({ ok: true, board: b }))
  if (!r.ok) return fail(r.code, r.message, { slug: target.slug, path: target.path })
  const board = r.board
  const sum = boardSummary(board)
  const lines = [
    `Board ${board.slug}: ${sum.total} task(s) · ${sum.open} open · ${sum.claimed} claimed · ${sum.waiting} waiting · ${sum.done} done · ${sum.merged} merged · ${sum.stale} stale · ${sum.workers} worker(s)`,
    `Lead ${board.lead.harness} ${short(board.lead.session)} · base ${board.base} · lease ${board.leaseSec} s · max workers ${board.maxWorkers}`,
    ...board.tasks.map(t => taskLine(t, ctx.now)),
  ]
  return ok({ ...statusView(board, ctx.now), boardPath: target.path }, lines)
}
