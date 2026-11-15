import { join } from 'node:path'
import type { Harness } from '../../core/events'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import { log } from '../../engine/log'
import type { AdapterContext } from '../registry'
import { isObj, str } from '../shared/claude-dialect'
import { contextJson } from '../shared/pipeline/types'

const H: Harness = 'codex'

export type Payload = Record<string, unknown>
export interface HookOutcome { stdout: string, exitCode: number }
export const NOTHING: HookOutcome = { stdout: '', exitCode: 0 }

export { str }

export function rec(x: unknown): Record<string, unknown> {
  return isObj(x) ? x : {}
}

export function json(x: unknown): HookOutcome {
  return { stdout: JSON.stringify(x), exitCode: 0 }
}

export async function step<T>(event: string, name: string, fallback: T, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    log('warn', 'codex hook step failed', { event, step: name, error: e })
    return fallback
  }
}

type ContextEvent = 'SessionStart' | 'SubagentStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'

export function contextOutput(event: ContextEvent, parts: string[], systemMessage?: string): HookOutcome {
  const out = contextJson(event, parts, systemMessage)
  return out === undefined ? NOTHING : json(out)
}

export function denyOutput(reason: string): HookOutcome {
  return json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}

export function blockOutput(reason: string): HookOutcome {
  return json({ decision: 'block', reason })
}

export interface CodexSessionState {
  v: 1
  ctxWarned?: number
  runawayPlan?: string
  flowNotified?: string
}

function adapterStatePath(ctx: AdapterContext, sid: string): string {
  return join(ctx.paths.sessionDir(H, sid), 'codex.json')
}

export function loadAdapterState(ctx: AdapterContext, sid: string): CodexSessionState {
  const r = readJsonSafeSync<CodexSessionState>(adapterStatePath(ctx, sid))
  return r.ok && r.value && r.value.v === 1 ? r.value : { v: 1 }
}

export function saveAdapterState(ctx: AdapterContext, sid: string, s: CodexSessionState): void {
  ensureDirSync(ctx.paths.sessionDir(H, sid))
  atomicWriteSync(adapterStatePath(ctx, sid), JSON.stringify(s) + '\n')
}
