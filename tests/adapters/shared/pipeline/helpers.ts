import { join } from 'node:path'
import * as core from '../../../../src/core/index'
import { defaultConfig, type BuracleConfig } from '../../../../src/core/config'
import type { Harness, ToolCall } from '../../../../src/core/events'
import type { SpoolEntry } from '../../../../src/core/memory/spool'
import type { SessionState } from '../../../../src/core/plan/state'
import * as paths from '../../../../src/engine/paths'
import type { AdapterContext } from '../../../../src/adapters/registry'
import type { MemoryFns, PipelineCore, PipelineDeps, WorkspaceReaders } from '../../../../src/adapters/shared/pipeline/index'

export const H: Harness = 'codex'
export const SID = '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b'
export const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)

export interface Recorder {
  spool: SpoolEntry[]
  /** The steps that threw and returned their fallback. */
  failed: string[]
  ui: string[]
  memory: string[]
  handoffs: Array<Record<string, unknown>>
}

export interface FakeOptions {
  core?: Partial<PipelineCore>
  config?: BuracleConfig
  memory?: MemoryFns
  env?: Record<string, string | undefined>
  workspace?: WorkspaceReaders
  canonical?: Partial<AdapterContext['canonical']>
}

/** A dependency object no harness owns: the real core unless a test replaces a function, and recorders for every side effect. */
export function fakeDeps(o: FakeOptions = {}): PipelineDeps & { rec: Recorder } {
  const rec: Recorder = { spool: [], failed: [], ui: [], memory: [], handoffs: [] }
  const memory: MemoryFns = {
    appendSpool: (_h, _sid, entries) => { rec.spool.push(...entries) },
    sessionStart: (_h, sid) => { rec.memory.push(`start:${sid}`) },
    promptSeen: (_h, sid) => { rec.memory.push(`seen:${sid}`) },
    spawnFinalizer: (_h, sid) => { rec.memory.push(`finalize:${sid}`) },
    writeHandoff: async input => { rec.handoffs.push(input); return { id: 'handoff-app', path: 'handoff-app', rel: 'handoff-app' } },
    ...o.memory,
  }
  const canonical = { routing: { categories: [] }, notices: [], ...o.canonical } as unknown as AdapterContext['canonical']
  return {
    harness: H, core: { ...core, ...o.core }, env: o.env ?? {}, workspace: o.workspace ?? {},
    ctx: { repoRoot: join(import.meta.dir, '..', '..', '..', '..'), config: o.config ?? defaultConfig(), canonical, paths, buracleBin: '/nonexistent/buracle/bin' },
    async step(name, fallback, fn) {
      try { return await fn() } catch { rec.failed.push(name); return fallback }
    },
    memory: async name => memory[name],
    project: async () => ({ project: 'app', branch: 'main' }),
    ui: {
      started: async () => { rec.ui.push('started') },
      seen: async () => { rec.ui.push('seen') },
      ended: async () => { rec.ui.push('ended') },
    },
    rec,
  }
}

export function call(over: Partial<ToolCall> = {}): ToolCall {
  return { harness: H, sessionId: SID, cwd: '/work/app', tool: 'Bash', kind: 'bash', input: {}, command: 'ls', paths: [], ...over }
}

export const plan = { path: 'docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS' as const, type: 'Feature' as const, phase: 'implement' as const, registeredAt: 1 }
export const planState = (): SessionState => ({ v: 1, guard: { blocksForPlan: 0, blocksInChain: 0 }, plan })
