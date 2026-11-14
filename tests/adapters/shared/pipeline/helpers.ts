import * as core from '../../../../src/core/index'
import { defaultConfig, type BuracleConfig } from '../../../../src/core/config'
import type { Harness, ToolCall } from '../../../../src/core/events'
import type { SpoolEntry } from '../../../../src/core/memory/spool'
import type { SessionState } from '../../../../src/core/plan/state'
import type { MemoryFns, PipelineCore, PipelineDeps, PipelinePoint } from '../../../../src/adapters/shared/pipeline/index'

export const H: Harness = 'codex'
export const SID = '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b'
export const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)

export interface Recorder {
  spool: SpoolEntry[]
  /** The steps that threw and returned their fallback. */
  failed: string[]
  ui: string[]
  memory: string[]
  points: PipelinePoint[]
  handoffs: Array<Record<string, unknown>>
}

export interface FakeOptions { core?: Partial<PipelineCore>, config?: BuracleConfig, memory?: MemoryFns, memoryOff?: boolean, captureOff?: boolean }

/** A dependency object no harness owns: the real core unless a test replaces a function, and recorders for every side effect. */
export function fakeDeps(o: FakeOptions = {}): PipelineDeps & { rec: Recorder } {
  const rec: Recorder = { spool: [], failed: [], ui: [], memory: [], points: [], handoffs: [] }
  const memory: MemoryFns = {
    sessionStart: (_h, sid) => { rec.memory.push(`start:${sid}`) },
    promptSeen: (_h, sid) => { rec.memory.push(`seen:${sid}`) },
    spawnFinalizer: (_h, sid) => { rec.memory.push(`finalize:${sid}`) },
    writeHandoff: async input => { rec.handoffs.push(input); return { id: 'handoff-app', path: 'handoff-app', rel: 'handoff-app' } },
    ...o.memory,
  }
  return {
    harness: H, ctx: { config: o.config ?? defaultConfig() }, core: { ...core, ...o.core },
    memoryOff: o.memoryOff === true, captureOff: o.captureOff === true,
    async step(name, fallback, fn) {
      try { return await fn() } catch { rec.failed.push(name); return fallback }
    },
    at: point => { rec.points.push(point) },
    memory: async name => memory[name],
    spool: async (_sid, entries) => { rec.spool.push(...entries) },
    project: async () => ({ project: 'app', branch: 'main' }),
    ui: {
      started: async () => { rec.ui.push('started') },
      seen: async () => { rec.ui.push('seen') },
      ended: async () => { rec.ui.push('ended') },
    },
    workspace: { read: () => undefined, save: () => {}, prepare: async () => undefined, subagent: async () => undefined },
    rec,
  }
}

export function call(over: Partial<ToolCall> = {}): ToolCall {
  return { harness: H, sessionId: SID, cwd: '/work/app', tool: 'Bash', kind: 'bash', input: {}, command: 'ls', paths: [], ...over }
}

export const plan = { path: 'docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS' as const, type: 'Feature' as const, phase: 'implement' as const, registeredAt: 1 }
export const planState = (): SessionState => ({ v: 1, guard: { blocksForPlan: 0, blocksInChain: 0 }, plan })
