import * as core from '../../../core/index'
import type { CanonicalBundle } from '../../../core/catalog'
import * as paths from '../../../engine/paths'
import type { AdapterContext } from '../../registry'
import type { MemoryFns, PipelineCore } from '../../shared/pipeline/index'
import type { UiSessionHooks } from '../../shared/ui-session'
import type { LiveConfig } from './config'
import type { ExtensionDeps } from './deps'
import type { MemoryBridge } from './memory'
import type { OmpGenerated } from './types'
import { withDeadline } from './util'

// What the omp extension hands the shared pipeline (src/adapters/shared/pipeline): the adapter context it cannot
// load from `canonical/`, the pure functions behind its injected dependencies, and the memory layer behind its bridge.

const MEMORY_CONTEXT_WAIT_MS = 4_000
const HANDOFF_WAIT_MS = 9_000

/** The adapter context of the bundled extension: the canonical data baked into it and the live runtime config. */
export function adapterContext(data: Pick<OmpGenerated, 'routing' | 'notices'>, lc: LiveConfig, home: () => string): AdapterContext {
  const canonical = { routing: data.routing, notices: data.notices ?? [] } as unknown as CanonicalBundle
  return { repoRoot: lc.repoRoot ?? '', config: lc.config, canonical, paths: { ...paths, home, oldVaultRoot: () => lc.vault }, buracleBin: lc.shim }
}

/**
 * The pipeline's pure functions, with the ones the extension takes as dependencies in their place. A switched-off
 * stop guard and switched-off routing never reach the injected function.
 */
export function pipelineCore(deps: Pick<ExtensionDeps, 'policy' | 'plan' | 'compact'>): PipelineCore {
  return {
    ...core,
    checkBash: (command, opts) => deps.policy.checkBash(command, opts),
    checkWrite: (files, ctx) => deps.policy.checkWrite(files, ctx),
    checkQuestion: (state, call, now) => deps.policy.checkQuestion(state, call, now),
    isGuardContinuation: text => deps.policy.isGuardContinuation(text),
    detectSignals: text => {
      const intent = deps.policy.detectIntent(text)
      return { control: intent === 'pause' || intent === 'resume' || intent === 'stop' ? intent : null, recall: false, write: false }
    },
    routeTool: (call, policy, health) => (policy.strictness === 'off' ? { action: 'allow' } : deps.policy.routeTool(call, policy, health)),
    promptInteraction: (state, control, text, opts) => deps.plan.promptInteraction(state, control, text, opts),
    answerReceipt: (state, now) => deps.plan.answerReceipt(state, now),
    validatePlan: text => deps.plan.validatePlan(text),
    stopGuardVerdict: (state, input, cfg, doc) => (cfg.stopGuard ? deps.plan.stopGuardVerdict(state, input, cfg, doc) : { decision: { action: 'allow' }, next: state, why: 'disabled' }),
    handoffNote: input => deps.compact.handoffNote(input),
    restoreContext: (state, handoff, todo) => deps.compact.restoreContext(state, handoff, todo),
  }
}

/** The pipeline's memory entry points on the extension's bridge; the bridge names the harness itself. */
export function memoryFns(bridge: MemoryBridge): MemoryFns {
  return {
    appendSpool: (_h, sid, entries) => bridge.appendSpool(sid, entries),
    sessionStart: (_h, sid, cwd) => bridge.sessionStart(sid, cwd),
    promptSeen: (_h, sid) => bridge.promptSeen?.(sid),
    spawnFinalizer: (_h, sid) => bridge.spawnFinalizer(sid),
    // `buracle mem context` is a child process: the session's first turn does not wait for a slow one.
    contextText: async o => (await withDeadline(bridge.contextText(o.cwd), MEMORY_CONTEXT_WAIT_MS, undefined)) ?? '',
    writeHandoff: async i => {
      const id = await withDeadline(bridge.writeHandoff(i.sessionId, i.cwd, { slug: i.slug, markdown: i.markdown, ...(i.branch !== undefined ? { branch: i.branch } : {}) }), HANDOFF_WAIT_MS, undefined)
      return id !== undefined ? { id, path: id, rel: id } : undefined
    },
  }
}

export function uiHooks(bridge: MemoryBridge): UiSessionHooks {
  return {
    started: async (_h, sid) => { bridge.ui?.started(sid) },
    seen: async (_h, sid) => { bridge.ui?.seen(sid) },
    ended: async (_h, sid) => { bridge.ui?.ended(sid) },
  }
}
