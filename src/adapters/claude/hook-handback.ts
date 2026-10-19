import { join } from 'node:path'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import { reviewSubjects, withFileLock } from '../../workflow/session-store'
import type { HookDeps } from './hook'
import { H, QUIET, isObj, out, str, type HookOutcome } from './hook-io'

export const HANDBACK_TOOL = 'SubagentHandback'
export const MAX_HANDBACK_AGENTS = 64

interface HandbackRecord { tries: number, delivered: boolean, at: number }
interface Handbacks { agents: Record<string, HandbackRecord> }

export function handbackFile(sid: string): string {
  return join(paths.sessionDir(H, sid), 'handback.json')
}

function readHandbacks(sid: string): Handbacks {
  const r = readJsonSafeSync<Partial<Handbacks>>(handbackFile(sid))
  const agents = r.ok && isObj(r.value) && isObj(r.value.agents) ? r.value.agents : {}
  const out: Handbacks = { agents: {} }
  for (const [id, v] of Object.entries(agents)) {
    if (isObj(v) && typeof v['tries'] === 'number' && typeof v['at'] === 'number') out.agents[id] = { tries: v['tries'], delivered: v['delivered'] === true, at: v['at'] }
  }
  return out
}

function writeHandbacks(sid: string, h: Handbacks): void {
  const kept = Object.entries(h.agents).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_HANDBACK_AGENTS)
  atomicWriteSync(handbackFile(sid), JSON.stringify({ agents: Object.fromEntries(kept) }) + '\n')
}

export function boundSubject(sid: string): { subject?: string[] } {
  const subject = reviewSubjects(H, sid)
  return subject.length > 0 ? { subject } : {}
}

export function handedBack(sid: string, agentId: string | undefined): boolean {
  if (agentId === undefined || !paths.isValidSessionId(sid)) return false
  try { return readHandbacks(sid).agents[agentId]?.delivered === true } catch { return false }
}

export function handbackNote(agent: string, problems: readonly string[]): string {
  return `Buracle H19 (review.gate): your report as ${agent} is not valid review JSON (${problems.slice(0, 6).join('; ')}), so it was not delivered. ` +
    `Call ${HANDBACK_TOOL} again with a message that is exactly one JSON object following the output schema in your instructions, with no text or code fence around it.`
}

export function subagentHandback(p: Record<string, unknown>, sid: string, reviewer: RegExp, d: Pick<HookDeps, 'core'>, now: number): HookOutcome {
  const agent = str(p['agent_type']) ?? ''
  if (!reviewer.test(agent) || !paths.isValidSessionId(sid)) return QUIET
  const id = str(p['agent_id']) ?? agent
  const input = isObj(p['tool_input']) ? p['tool_input'] : {}
  const message = typeof input['message'] === 'string' ? input['message'] : ''
  try {
    const checked = d.core.validateReviewJson(message, { agent, ...boundSubject(sid) })
    ensureDirSync(paths.sessionDir(H, sid))
    const bounce = withFileLock(handbackFile(sid), () => {
      const record = readHandbacks(sid)
      const tries = (record.agents[id]?.tries ?? 0) + 1
      const first = !checked.ok && tries === 1
      record.agents[id] = { tries, delivered: !first, at: now }
      writeHandbacks(sid, record)
      return first
    })
    if (checked.ok) return QUIET
    const problems = checked.errors.length > 0 ? checked.errors : ['the message is not one valid review JSON object']
    if (bounce) return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: handbackNote(agent, problems) } })
    return out({ systemMessage: `Buracle H19: ${agent} handed back an invalid review report again (${problems.slice(0, 3).join('; ')}); check its findings yourself before relying on them.` })
  } catch (e) {
    log('warn', 'claude hook PreToolUse: H19 hand-back check failed; allowing', { sid, agent, error: e })
    return QUIET
  }
}
