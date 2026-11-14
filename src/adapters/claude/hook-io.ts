import * as core from '../../core/index'
import { log } from '../../engine/log'
import type { AdapterContext } from '../registry'
import { contextJson, type MemoryFns, type PipelineDeps } from '../shared/pipeline/index'
import type { HookDeps, MemoryModule } from './hook'

export interface HookOutcome { stdout: string; exitCode: number }

export const QUIET: HookOutcome = { stdout: '', exitCode: 0 }
export const H = 'claude' as const
export const FALLBACK_SPOOL_SUFFIX = 'classic'

export function out(obj: unknown): HookOutcome {
  return { stdout: JSON.stringify(obj) + '\n', exitCode: 0 }
}

export function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

export function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function isSubagent(p: Record<string, unknown>): boolean {
  return str(p['agent_id']) !== undefined
}

export async function step<T>(what: string, fallback: T, fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) { log('warn', `claude hook: ${what} failed`, { error: e }); return fallback }
}

export function contextOut(event: string, parts: readonly string[], systemMessage?: string): HookOutcome {
  const o = contextJson(event, parts, systemMessage)
  return o === undefined ? QUIET : out(o)
}

const MEMORY_MODULE: Readonly<Record<keyof MemoryFns, MemoryModule>> = {
  appendSpool: 'spool', spawnFinalizer: 'finalize', sessionStart: 'finalize', promptSeen: 'finalize', contextText: 'context', writeHandoff: 'handoff', latestHandoff: 'handoff',
}

/** What the shared pipeline needs from Claude Code: its step log, the lazily imported memory modules and the injected lookups. */
export function pipelineDeps(ctx: AdapterContext, d: HookDeps): PipelineDeps {
  return {
    harness: H, ctx, core: { ...core, ...d.core }, ui: d.ui, workspace: d, step,
    env: new Proxy({} as Record<string, string | undefined>, { get: (_t, name) => d.env(String(name)) }), hostEnv: process.env,
    async memory(name) {
      const fn = (await d.importModule(MEMORY_MODULE[name]))?.[name]
      return (typeof fn === 'function' ? fn : undefined) as MemoryFns[typeof name] | undefined
    },
    async project(cwd) {
      const [project, branch] = await Promise.all([d.project(cwd), d.branch(cwd)])
      return { project, ...(branch !== undefined ? { branch } : {}) }
    },
    // The mod writes the session's plain spool file; the command hooks write one of their own.
    spoolSuffix: FALLBACK_SPOOL_SUFFIX, realpath: p => d.realpath(p), buracleRepo: (cwd, c) => d.buracleRepo(cwd, c),
    ...(d.assetsSpawn !== undefined ? { assetsSpawn: d.assetsSpawn } : {}),
  }
}
