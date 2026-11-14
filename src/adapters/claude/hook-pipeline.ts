import * as core from '../../core/index'
import { log } from '../../engine/log'
import type { AdapterContext } from '../registry'
import type { MemoryFns, PipelineDeps, PipelinePoint } from '../shared/pipeline/index'
import type { HookDeps, MemoryModule } from './hook'
import { H, captureOff, spool, step } from './hook-io'
import { readWorkspace, saveWorkspace } from './hook-route'

const MEMORY_MODULE: Readonly<Record<keyof MemoryFns, MemoryModule>> = {
  appendSpool: 'spool', spawnFinalizer: 'finalize', sessionStart: 'finalize', promptSeen: 'finalize', contextText: 'context', writeHandoff: 'handoff', latestHandoff: 'handoff',
}

// The two pipeline steps whose failure Claude Code's hook logs in words of its own.
const FAILURES: Readonly<Record<string, string>> = {
  'stop guard': 'claude hook Stop: stop guard failed; allowing the stop',
  'H14 finalizer': 'claude hook SessionEnd: could not start the memory finalizer',
}

/** What the shared pipeline needs from Claude Code: its step log, the lazily imported memory modules and the session's workspace file. */
export function pipelineDeps(sid: string, ctx: AdapterContext, d: HookDeps, at?: (point: PipelinePoint) => Promise<void>): PipelineDeps {
  return {
    harness: H, ctx, core: { ...core, ...d.core }, memoryOff: d.env('BURACLE_NO_MEMORY') === '1', captureOff: captureOff(d), ui: d.ui,
    async step(name, fallback, fn) {
      const failure = FAILURES[name]
      if (failure === undefined) return step(name, fallback, fn)
      try { return await fn() } catch (e) { log('warn', failure, { sid, error: e }); return fallback }
    },
    async memory(name) {
      const fn = (await d.importModule(MEMORY_MODULE[name]))?.[name]
      return (typeof fn === 'function' ? fn : undefined) as MemoryFns[typeof name] | undefined
    },
    spool: (s, entries) => spool(d, s, entries),
    async project(cwd) {
      const [project, branch] = await Promise.all([d.project(cwd), d.branch(cwd)])
      return { project, ...(branch !== undefined ? { branch } : {}) }
    },
    workspace: {
      read: readWorkspace, save: saveWorkspace,
      prepare: (cwd, now) => d.prepareWorkspace(cwd, ctx, now),
      subagent: (_sid, cwd, now) => d.workspaceInfo(cwd, ctx, now),
      refresh: (info, now) => d.refreshWorkspace(info, ctx, now),
    },
    ...(d.assetsSpawn !== undefined ? { assetsSpawn: d.assetsSpawn } : {}),
    ...(at !== undefined ? { at } : {}),
  }
}
