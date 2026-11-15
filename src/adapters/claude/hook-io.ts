import { harnessProfile } from '../../core/harness/index'
import * as core from '../../core/index'
import type { AdapterContext } from '../registry'
import { type MemoryFns, type PipelineDeps } from '../shared/pipeline/index'
import { contextOut, isObj, out, parsePayload, QUIET, str, type HookOutcome } from '../shared/claude-dialect'
import { hookStep } from '../shared/command-host/index'
import type { HookDeps, MemoryModule } from './hook'

export { contextOut, isObj, out, parsePayload, QUIET, str, type HookOutcome }
export const H = 'claude' as const
export const FALLBACK_SPOOL_SUFFIX = harnessProfile('claude').spoolSuffix as string

export function isSubagent(p: Record<string, unknown>): boolean {
  return str(p['agent_id']) !== undefined
}

export const step = hookStep('claude')

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
