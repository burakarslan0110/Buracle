import type { SpoolEntry } from '../../core/memory/spool'
import { log } from '../../engine/log'
import type { HookDeps } from './hook'

export interface HookOutcome { stdout: string; exitCode: number }

export const QUIET: HookOutcome = { stdout: '', exitCode: 0 }
export const H = 'claude' as const
export const CONTEXT_BUDGET_BYTES = 9_600
export const FALLBACK_SPOOL_SUFFIX = 'classic'
export const GUARD_FAILED = 'buracle: the command guard (H01) failed, so the command was not run. Retry it; if this repeats, run `buracle doctor claude` and check ~/.buracle/logs/buracle.log.'

export function out(obj: unknown): HookOutcome {
  return { stdout: JSON.stringify(obj) + '\n', exitCode: 0 }
}

export function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

export function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function captureOff(d: Pick<HookDeps, 'env'>): boolean {
  return d.env('BURACLE_NO_CAPTURE') === '1' || d.env('BURACLE_NO_MEMORY') === '1'
}

export function isSubagent(p: Record<string, unknown>): boolean {
  return str(p['agent_id']) !== undefined
}

export async function step<T>(what: string, fallback: T, fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) { log('warn', `claude hook: ${what} failed`, { error: e }); return fallback }
}

export function byteLength(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

export function clipBytes(text: string, max: number, note = '\n... (truncated; use memory_search)'): string {
  if (byteLength(text) <= max) return text
  const lines = text.split('\n')
  const kept: string[] = []
  let n = byteLength(note)
  for (const l of lines) {
    const b = byteLength(l) + 1
    if (n + b > max) break
    kept.push(l)
    n += b
  }
  return kept.join('\n') + note
}

export function contextOut(event: string, parts: readonly string[], systemMessage?: string): HookOutcome {
  const text = parts.filter(p => p.trim() !== '').join('\n\n')
  if (text === '' && systemMessage === undefined) return QUIET
  const o: Record<string, unknown> = {}
  if (text !== '') o['hookSpecificOutput'] = { hookEventName: event, additionalContext: clipBytes(text, CONTEXT_BUDGET_BYTES) }
  if (systemMessage !== undefined) o['systemMessage'] = systemMessage
  return out(o)
}

export async function spool(d: Pick<HookDeps, 'env' | 'importModule'>, sid: string, entries: SpoolEntry[]): Promise<void> {
  if (entries.length === 0 || captureOff(d)) return
  await step('H14 spool', undefined, async () => {
    const mem = await d.importModule('spool')
    const append = mem?.['appendSpool']
    if (typeof append === 'function') (append as (h: string, s: string, e: SpoolEntry[], o: { suffix: string }) => unknown)(H, sid, entries, { suffix: FALLBACK_SPOOL_SUFFIX })
  })
}
