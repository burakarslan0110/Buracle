import { join } from 'node:path'
import * as core from '../../../src/core/index'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { defaultConfig, type BuracleConfig } from '../../../src/core/config'
import type { SessionState } from '../../../src/core/plan/state'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import type { AdapterContext } from '../../../src/adapters/registry'
import type { CodexHookDeps, CoreFns, MemoryFns, SpoolEntry } from '../../../src/adapters/codex/hook'

export const REPO = join(import.meta.dir, '..', '..', '..')
export const canonical: CanonicalBundle = loadCanonicalSync(join(REPO, 'canonical'))
export const NOW = Date.UTC(2026, 9, 8, 12, 0, 0)
export const SID = '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b'
export const DAY = 86_400_000

export function ctx(config: BuracleConfig = defaultConfig(), repoRoot = REPO): AdapterContext {
  return { repoRoot, config, canonical, paths, buracleBin: paths.shimPath() }
}

export function withPlan(cfg: Partial<BuracleConfig['plan']>): BuracleConfig {
  const c = defaultConfig()
  return { ...c, plan: { ...c.plan, ...cfg } }
}

export interface Recorder { spool: SpoolEntry[], finalizer: string[], started: string[], touched: string[], runs: string[][], handoffs: Array<Record<string, unknown>> }

export function deps(over: Partial<CoreFns> = {}, extra: MemoryFns = {}, env: Record<string, string | undefined> = {}): CodexHookDeps & { rec: Recorder } {
  const rec: Recorder = { spool: [], finalizer: [], started: [], touched: [], runs: [], handoffs: [] }
  const memory: MemoryFns = {
    appendSpool: (_h, _sid, entries) => { rec.spool.push(...entries) },
    spawnFinalizer: (h, sid) => { rec.finalizer.push(`${h}:${sid}`) },
    sessionStart: (h, sid, cwd, opts) => { rec.started.push(`${h}:${sid}:${cwd}:${opts?.model ?? ''}`) },
    promptSeen: (h, sid) => { rec.touched.push(`${h}:${sid}`) },
    writeHandoff: async input => { rec.handoffs.push(input); return { id: `handoff-${input.project}`, path: `handoff-${input.project}`, rel: `handoff-${input.project}` } },
    ...extra,
  }
  return {
    core: { ...core, ...over } as CoreFns,
    memory: async () => memory,
    now: () => NOW,
    run: async argv => { rec.runs.push(argv); return { code: 1, stdout: 'x.py:1:1: F401 unused import', stderr: '', timedOut: false } },
    resolveChecker: argv => [...argv],
    env: () => ({ HOME: paths.home(), ...env }),
    rec,
  }
}

export const payload = (event: string, extra: Record<string, unknown> = {}) => JSON.stringify({
  session_id: SID, turn_id: 't1', transcript_path: null, cwd: '/work/app', hook_event_name: event, model: 'gpt-6.1-sol', permission_mode: 'default', ...extra,
})

export const allow = (): ReturnType<CoreFns['routeTool']> => ({ action: 'allow' })
export const quiet: Partial<CoreFns> = {
  checkBash: () => ({}), checkWrite: () => ({}), checkQuestion: () => ({}), routeTool: allow,
  capabilityCard: () => 'Capability card', restoreContext: () => undefined, detectIntent: () => null,
}

export function keys(x: unknown): string[] {
  return Object.keys(x as object).sort()
}

export const statePath = () => join(paths.sessionDir('codex', SID), 'state.json')
export const plan = { path: 'docs/plans/p.md', slug: 'p', status: 'IN_PROGRESS' as const, type: 'Feature' as const, phase: 'implement' as const, registeredAt: 1 }
export const planState = (over: Partial<SessionState> = {}): SessionState => ({ v: 1, guard: { blocksForPlan: 0, blocksInChain: 0 }, plan, ...over })
