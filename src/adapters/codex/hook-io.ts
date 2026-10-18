import { join } from 'node:path'
import type { Harness, HookId } from '../../core/events'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import { log } from '../../engine/log'
import type { AdapterContext } from '../registry'

const H: Harness = 'codex'
export const CONTEXT_BUDGET_BYTES = 9_600

export type Payload = Record<string, unknown>
export interface HookOutcome { stdout: string, exitCode: number }
export const NOTHING: HookOutcome = { stdout: '', exitCode: 0 }

export function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

export function rec(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}
}

export function json(x: unknown): HookOutcome {
  return { stdout: JSON.stringify(x), exitCode: 0 }
}

export function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0]?.slice(0, 200) ?? 'unknown error'
}

export async function step<T>(event: string, name: string, fallback: T, fn: () => T | Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    log('warn', 'codex hook step failed', { event, step: name, error: e })
    return fallback
  }
}

export function clipBytes(text: string, max: number, note = '\n… (truncated)'): string {
  const enc = new TextEncoder()
  if (enc.encode(text).length <= max) return text
  const room = Math.max(0, max - enc.encode(note).length)
  let cut = text
  while (cut.length > 0 && enc.encode(cut).length > room) cut = cut.slice(0, Math.floor(cut.length * 0.9))
  const nl = cut.lastIndexOf('\n')
  return (nl > cut.length * 0.5 ? cut.slice(0, nl) : cut) + note
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

type ContextEvent = 'SessionStart' | 'SubagentStart' | 'UserPromptSubmit' | 'PreToolUse' | 'PostToolUse'

export function contextOutput(event: ContextEvent, parts: string[], systemMessage?: string): HookOutcome {
  const text = parts.map(p => p.trim()).filter(p => p !== '').join('\n\n')
  const out: Record<string, unknown> = {}
  if (systemMessage !== undefined && systemMessage.trim() !== '') out['systemMessage'] = systemMessage.trim()
  if (text !== '') out['hookSpecificOutput'] = { hookEventName: event, additionalContext: clipBytes(text, CONTEXT_BUDGET_BYTES) }
  return Object.keys(out).length === 0 ? NOTHING : json(out)
}

export function denyOutput(reason: string): HookOutcome {
  return json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}

export function denyReason(hook: HookId, reason: string): string {
  return `Buracle ${hook}: ${reason}`
}

export function blockOutput(reason: string): HookOutcome {
  return json({ decision: 'block', reason })
}

export interface CodexSessionState {
  v: 1
  ctxWarned?: number
  lastHandoff?: string
  lastTodos?: string[]
  lastCompactAt?: number
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
