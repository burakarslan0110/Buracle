import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RESTORE_RECORD_MAX_MS, RESTORE_TODOS_MAX } from '../../core/compact'
import type { StopInput } from '../../core/events'
import { backgroundWait } from '../../core/plan/background'
import type { PlanDoc, SessionState, StopGuardResult, StopWhy } from '../../core/plan/state'
import { routeAuditAllowed } from '../../core/plan/state'
import { atomicWriteSync, readJsonSafeSync, readTextSync } from '../../engine/fsx'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import { loadState, updateState } from '../../workflow/session-store'
import type { AdapterContext } from '../registry'
import type { HookDeps } from './hook'
import { H, QUIET, captureOff, isObj, isSubagent, out, spool, step, str, type HookOutcome } from './hook-io'
import { auditTurn, readWorkspace } from './hook-route'
import { assetsOptions, startLinkRun } from '../shared/project-assets'
import { openWork } from './hook-work'
import { boundSubject, handedBack } from './hook-handback'

export const HANDOFF_MAX_AGE_MS = RESTORE_RECORD_MAX_MS
export const REVIEW_AGENT = /^(?:buracle:)?(?:plan-build|changes|goal-build)-review$|^buracle:[a-z0-9-]+-review$/

export function runawayNotice(why: StopGuardResult['why'], cfg: AdapterContext['config']['plan']): string | undefined {
  if (why === 'runaway-plan') {
    return `Buracle: the stop guard reached its limit for this plan (${cfg.runaway.perPlan} blocks) and let the session stop. The plan is not VERIFIED yet: check it with \`buracle plan status\`.`
  }
  if (why === 'runaway-chain') {
    return `Buracle: the stop guard blocked ${cfg.runaway.perChain} times in a row, so it let the session stop to break the loop. Send a new message to continue.`
  }
  return undefined
}

export const READ_ONLY_NOTICE = 'Buracle: the session is in plan mode (read-only), so the stop guard lets the turn end. Leave plan mode (shift+tab) to continue the plan.'

function planCheckOf(s: SessionState, cwd: string, d: HookDeps): PlanDoc | undefined {
  const plan = s.plan
  if (plan === undefined) return undefined
  const text = readTextSync(resolve(cwd === '' ? '/' : cwd, plan.path))
  if (!text.ok) return { exists: false, findings: [] }
  return { exists: true, findings: plan.phase === 'plan' ? d.core.validatePlan(text.value) : [], text: text.value }
}

export function stopFeedback(reason: string): HookOutcome {
  return out({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason } })
}

function stopGuard(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): { block?: string, notice?: string, why?: StopWhy } {
  const cfg = ctx.config.plan
  if (!cfg.stopGuard) return { why: 'disabled' }
  const cwd = str(p['cwd']) ?? ''
  const last = str(p['last_assistant_message'])
  try {
    const state = loadState(H, sid)
    if (state.plan === undefined) return { why: 'no-plan' }
    const input: StopInput = { harness: H, sessionId: sid, cwd, now, hookActive: p['stop_hook_active'] === true }
    if (last !== undefined) input.lastMessage = last
    if (p['permission_mode'] === 'plan') input.readOnly = true
    if (backgroundWait(last, p['background_tasks'], p['session_crons'])) input.backgroundWait = true
    const verdict = (s: SessionState): StopGuardResult => d.core.stopGuardVerdict(s, input, cfg, planCheckOf(s, cwd, d))
    let result = verdict(state)
    let before = state
    if (JSON.stringify(result.next) !== JSON.stringify(state)) {
      updateState(H, sid, (s: SessionState) => {
        before = s
        result = verdict(s)
        return result.next
      })
    }
    if (result.decision.action === 'block') return { block: result.decision.reason }
    if (result.readOnlyNotice === true) return { notice: READ_ONLY_NOTICE, why: result.why }
    const notice = before.guard.blocksInChain > 0 ? runawayNotice(result.why, cfg) : undefined
    return notice !== undefined ? { notice, why: result.why } : { why: result.why }
  } catch (e) {
    log('warn', 'claude hook Stop: stop guard failed; allowing the stop', { sid, error: e })
    return {}
  }
}

export async function stop(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  const last = str(p['last_assistant_message'])
  if (last !== undefined && !isSubagent(p)) await spool(d, sid, [{ ts: now, ev: 'turn', excerpt: last }])
  if (!isSubagent(p)) await step('H28 project assets', false, () => startLinkRun(readWorkspace(sid)?.root, assetsOptions(now, d.assetsSpawn)))
  const guard = stopGuard(p, sid, ctx, d, now)
  if (guard.block !== undefined) return stopFeedback(guard.block)
  if (routeAuditAllowed(guard.why, ctx.config.routing.strictness) && !isSubagent(p)) {
    const reason = await step('H23 route.audit', undefined as string | undefined, () => auditTurn(sid))
    if (reason !== undefined) return stopFeedback(reason)
  }
  return guard.notice !== undefined ? out({ systemMessage: guard.notice }) : QUIET
}

export function handoffRecordPath(sid: string): string {
  return join(paths.sessionDir(H, sid), 'handoff.json')
}

export interface CompactRecord { handoff?: string, todo?: string[] }

export function recentCompact(sid: string, now: number): CompactRecord | undefined {
  const r = readJsonSafeSync<unknown>(handoffRecordPath(sid))
  if (!r.ok || !isObj(r.value)) return undefined
  const { path, at, todo } = r.value
  if (typeof at !== 'number' || now - at > HANDOFF_MAX_AGE_MS) return undefined
  if (typeof path === 'string') return /^handoff-[a-z0-9-]+$/.test(path) ? { handoff: path } : {}
  const open = Array.isArray(todo) ? todo.filter((t): t is string => typeof t === 'string' && t.trim() !== '').slice(0, RESTORE_TODOS_MAX) : []
  return open.length > 0 ? { todo: open } : {}
}

export async function projectHandoff(cwd: string, sid: string, d: HookDeps, now: number): Promise<string | undefined> {
  const mem = await d.importModule('handoff')
  const latest = mem?.['latestHandoff']
  if (typeof latest !== 'function') return undefined
  const [project, branch] = await Promise.all([d.project(cwd), d.branch(cwd)])
  const r = await (latest as (o: unknown) => Promise<unknown>)({ project, branch, nowMs: now, session: sid })
  return isObj(r) && typeof r['id'] === 'string' ? r['id'] : undefined
}

export async function preCompact(p: Record<string, unknown>, sid: string, d: HookDeps, now: number): Promise<HookOutcome> {
  if (isSubagent(p)) return QUIET
  const record = handoffRecordPath(sid)
  if (d.env('BURACLE_NO_MEMORY') === '1') {
    await step('H06 compaction record', undefined, () => { rmSync(record, { force: true }) })
    return QUIET
  }
  const todo = await step('H06 todos', [] as string[], () => openWork(sid))
  const mark = (path?: string) => step('H06 compaction record', undefined, () => {
    const kept = path !== undefined ? { path } : todo.length > 0 ? { todo: todo.slice(0, RESTORE_TODOS_MAX) } : {}
    atomicWriteSync(record, JSON.stringify({ ...kept, at: now }) + '\n')
  })
  await mark()
  const id = await step('H06 handoff', undefined as string | undefined, async () => {
    const cwd = str(p['cwd']) ?? process.cwd()
    const state = loadState(H, sid)
    const [project, branch] = await Promise.all([d.project(cwd), d.branch(cwd)])
    const note = d.core.handoffNote({ state, project, harness: H, sessionId: sid, branch, now, ...(todo.length > 0 ? { todo } : {}) })
    const write = (await d.importModule('handoff'))?.['writeHandoff']
    if (typeof write !== 'function') return undefined
    const r = await (write as (input: unknown) => Promise<unknown>)({
      harness: H, sessionId: sid, cwd, project, branch, slug: note.slug, markdown: note.markdown, trigger: str(p['trigger']), now,
    })
    return isObj(r) && typeof r['id'] === 'string' ? r['id'] : undefined
  })
  if (id !== undefined) await mark(id)
  return QUIET
}

export async function postCompact(p: Record<string, unknown>, sid: string, d: HookDeps, now: number): Promise<HookOutcome> {
  if (captureOff(d) || isSubagent(p)) return QUIET
  const summary = str(p['compact_summary'])
  if (summary === undefined || summary.trim() === '') return QUIET
  await spool(d, sid, [{ ts: now, ev: 'compact', excerpt: summary }])
  return QUIET
}

export function reviewNote(agent: string, problems: readonly string[]): string {
  return `Buracle H19 (review.gate): your final message as ${agent} is not valid review JSON (${problems.slice(0, 6).join('; ')}). ` +
    'Answer again with exactly one JSON object that follows the output schema in your instructions, with no text or code fence around it.'
}

export function subagentStop(p: Record<string, unknown>, sid: string, d: HookDeps): HookOutcome {
  const agent = str(p['agent_type']) ?? ''
  if (!REVIEW_AGENT.test(agent) || p['stop_hook_active'] === true || handedBack(sid, str(p['agent_id']))) return QUIET
  try {
    const checked = d.core.validateReviewJson(typeof p['last_assistant_message'] === 'string' ? p['last_assistant_message'] : '', { agent, ...boundSubject(sid) })
    if (checked.ok) return QUIET
    const problems = checked.errors.length > 0 ? checked.errors : ['the message is not one valid review JSON object']
    return out({ hookSpecificOutput: { hookEventName: 'SubagentStop', additionalContext: reviewNote(agent, problems) } })
  } catch (e) {
    log('warn', 'claude hook SubagentStop: review gate failed; allowing', { sid, agent, error: e })
    return QUIET
  }
}

export async function sessionEnd(sid: string, d: HookDeps, now: number): Promise<HookOutcome> {
  await step('H14 memory UI', undefined, () => d.ui.ended(H, sid))
  if (!captureOff(d)) {
    try {
      const mem = await d.importModule('finalize')
      const spawn = mem?.['spawnFinalizer']
      if (typeof spawn === 'function') await (spawn as (h: string, s: string) => unknown)(H, sid)
      else log('debug', 'claude hook SessionEnd: memory finalizer not available', { sid })
    } catch (e) {
      log('warn', 'claude hook SessionEnd: could not start the memory finalizer', { sid, error: e })
    }
  }
  try {
    d.sessionMaint(now, [sid])
  } catch (e) {
    log('warn', 'claude hook SessionEnd: session maintenance failed', { sid, error: e })
  }
  return QUIET
}
