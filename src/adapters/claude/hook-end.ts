import { join } from 'node:path'
import { RESTORE_RECORD_MAX_MS, RESTORE_TODOS_MAX } from '../../core/compact'
import type { StopInput } from '../../core/events'
import { backgroundWait } from '../../core/plan/background'
import type { StopGuardResult } from '../../core/plan/state'
import { atomicWriteSync, readJsonSafeSync } from '../../engine/fsx'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import type { AdapterContext } from '../registry'
import { preCompact as preCompactEvent, sessionEnd as sessionEndEvent, spool, stop as stopEvent, type CompactStore } from '../shared/pipeline/index'
import type { HookDeps } from './hook'
import { H, QUIET, isObj, isSubagent, out, pipelineDeps, str, type HookOutcome } from './hook-io'
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
  const pd = pipelineDeps(ctx, d)
  if (last !== undefined && !sub) await spool(pd, sid, [{ ts: now, ev: 'turn', excerpt: last }])
  const input: StopInput = { harness: H, sessionId: sid, cwd: str(p['cwd']) ?? '', now, hookActive: p['stop_hook_active'] === true, subagent: sub }
  if (last !== undefined) input.lastMessage = last
  // Claude Code names the session's background work in the payload, so a stop that waits for it goes through.
  if (backgroundWait(last, p['background_tasks'], p['session_crons'])) input.backgroundWait = true
  const r = await stopEvent(input, {
    ...pd,
    readOnly: () => p['permission_mode'] === 'plan',
    stopNotice: (result, before) => (result.readOnlyNotice === true ? READ_ONLY_NOTICE : before.guard.blocksInChain > 0 ? runawayNotice(result.why, ctx.config.plan) : undefined),
  })
  if (r.decision.action === 'block') return stopFeedback(r.decision.reason)
  return r.notice !== undefined ? out({ systemMessage: r.notice }) : QUIET
}

export function handoffRecordPath(sid: string): string {
  return join(paths.sessionDir(H, sid), 'handoff.json')
}

/** The session's compaction record in handoff.json, for the restore after it; a record older than the limit is ignored. */
export function compactStore(sid: string, at: number): CompactStore {
  const file = handoffRecordPath(sid)
  return {
    read(now) {
      const r = readJsonSafeSync<unknown>(file)
      const v = r.ok && isObj(r.value) ? r.value : {}
      if (typeof v['at'] !== 'number' || now - v['at'] > HANDOFF_MAX_AGE_MS) return { recent: false }
      const { path, todo } = v
      if (typeof path === 'string') return { recent: true, ...(/^handoff-[a-z0-9-]+$/.test(path) ? { handoff: path } : {}) }
      return { recent: true, todo: Array.isArray(todo) ? todo.filter((t): t is string => typeof t === 'string' && t.trim() !== '').slice(0, RESTORE_TODOS_MAX) : [] }
    },
    save(path, todo) { atomicWriteSync(file, JSON.stringify({ ...(path !== undefined ? { path } : todo.length > 0 ? { todo } : {}), at }) + '\n') },
  }
}

export async function preCompact(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  if (isSubagent(p)) return QUIET
  const trigger = str(p['trigger'])
  await preCompactEvent({ harness: H, sessionId: sid, cwd: str(p['cwd']) ?? process.cwd(), now, ...(trigger !== undefined ? { trigger } : {}) }, {
    ...pipelineDeps(ctx, d), openTodos: () => openWork(sid), compact: compactStore(sid, now),
  })
  return QUIET
}

export async function postCompact(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  const summary = str(p['compact_summary'])
  if (isSubagent(p) || summary === undefined || summary.trim() === '') return QUIET
  await spool(pipelineDeps(ctx, d), sid, [{ ts: now, ev: 'compact', excerpt: summary }])
  return QUIET
}

export function reviewNote(agent: string, problems: readonly string[]): string {
  return `Buracle H19: your final message as ${agent} is not valid review JSON (${problems.slice(0, 6).join('; ')}). ` +
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
  await sessionEndEvent({ harness: H, sessionId: sid, now }, pipelineDeps(ctx, d))
  try {
    d.sessionMaint(now, [sid])
  } catch (e) {
    log('warn', 'claude hook SessionEnd: session maintenance failed', { sid, error: e })
  }
  return QUIET
}
