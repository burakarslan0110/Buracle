import { rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { RESTORE_RECORD_MAX_MS, RESTORE_TODOS_MAX } from '../../core/compact'
import type { StopInput } from '../../core/events'
import { backgroundWait } from '../../core/plan/background'
import type { StopGuardResult } from '../../core/plan/state'
import { atomicWriteSync, readJsonSafeSync, readTextSync } from '../../engine/fsx'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import { loadState } from '../../workflow/session-store'
import type { AdapterContext } from '../registry'
import { preCompact as preCompactEvent, sessionEnd as sessionEndEvent, stop as stopEvent } from '../shared/pipeline/index'
import type { HookDeps } from './hook'
import { H, QUIET, captureOff, isObj, isSubagent, out, spool, step, str, type HookOutcome } from './hook-io'
import { pipelineDeps } from './hook-pipeline'
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

export function stopFeedback(reason: string): HookOutcome {
  return out({ hookSpecificOutput: { hookEventName: 'Stop', additionalContext: reason } })
}

export async function stop(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  const last = str(p['last_assistant_message'])
  const sub = isSubagent(p)
  if (last !== undefined && !sub) await spool(d, sid, [{ ts: now, ev: 'turn', excerpt: last }])
  const stopping: StopInput = { harness: H, sessionId: sid, cwd: str(p['cwd']) ?? '', now, hookActive: p['stop_hook_active'] === true, subagent: sub }
  if (last !== undefined) stopping.lastMessage = last
  const r = await stopEvent(stopping, {
    ...pipelineDeps(sid, ctx, d),
    readPlan(path, cwd) {
      const text = readTextSync(resolve(cwd === '' ? '/' : cwd, path))
      return text.ok ? text.value : undefined
    },
    stopInput(input) {
      if (p['permission_mode'] === 'plan') input.readOnly = true
      if (backgroundWait(last, p['background_tasks'], p['session_crons'])) input.backgroundWait = true
    },
    stopNotice: (result, before) => (result.readOnlyNotice === true ? READ_ONLY_NOTICE : before.guard.blocksInChain > 0 ? runawayNotice(result.why, ctx.config.plan) : undefined),
    stopGuard: { gate: true, write: 'changed', auditOnFailure: true },
  })
  if (r.decision.action === 'block') return stopFeedback(r.decision.reason)
  return r.notice !== undefined ? out({ systemMessage: r.notice }) : QUIET
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

export async function preCompact(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  if (isSubagent(p)) return QUIET
  const record = handoffRecordPath(sid)
  if (d.env('BURACLE_NO_MEMORY') === '1') {
    await step('H06 compaction record', undefined, () => { rmSync(record, { force: true }) })
    return QUIET
  }
  const trigger = str(p['trigger'])
  await preCompactEvent({ harness: H, sessionId: sid, cwd: str(p['cwd']) ?? process.cwd(), now, ...(trigger !== undefined ? { trigger } : {}) }, {
    ...pipelineDeps(sid, ctx, d),
    openTodos: () => openWork(sid),
    saveCompactRecord(path, todo) {
      const kept = path !== undefined ? { path } : todo.length > 0 ? { todo } : {}
      atomicWriteSync(record, JSON.stringify({ ...kept, at: now }) + '\n')
    },
    handoffNote: ({ project, branch, todo }) => d.core.handoffNote({ state: loadState(H, sid), project, harness: H, sessionId: sid, branch, now, ...(todo.length > 0 ? { todo } : {}) }),
  })
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

export async function sessionEnd(sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  await sessionEndEvent({ harness: H, sessionId: sid, now }, {
    ...pipelineDeps(sid, ctx, d),
    noFinalizer() { log('debug', 'claude hook SessionEnd: memory finalizer not available', { sid }) },
  })
  try {
    d.sessionMaint(now, [sid])
  } catch (e) {
    log('warn', 'claude hook SessionEnd: session maintenance failed', { sid, error: e })
  }
  return QUIET
}
