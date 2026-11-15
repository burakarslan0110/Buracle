import { defaultConfig } from '../../../src/core/config'
import { answerReceipt } from '../../../src/core/plan/state'
import { promptInteraction } from '../../../src/core/plan/interaction'
import type { PiDeps } from '../../../src/adapters/pi/runtime/extension'
import { defaultDeps } from '../../../src/adapters/pi/runtime/extension'
import type { PiContext, PiCustomMessage, PiExtensionAPI, PiGenerated } from '../../../src/adapters/pi/runtime/types'
import type { MemoryBridge, SpoolEntry } from '../../../src/adapters/shared/pi-family/memory'

export const SID = '0197a118-8d01-740c-9360-f4f796699f4b'

export type Handler = (event: unknown, ctx: PiContext) => unknown

export interface FakePi {
  pi: PiExtensionAPI
  handlers: Map<string, Handler[]>
  sent: Array<{ message: PiCustomMessage, options?: unknown }>
  emit(event: string, payload: unknown, ctx: PiContext): Promise<unknown>
}

export function fakePi(): FakePi {
  const handlers = new Map<string, Handler[]>()
  const sent: FakePi['sent'] = []
  const pi: PiExtensionAPI = {
    on(event, handler) { handlers.set(event, [...(handlers.get(event) ?? []), handler as Handler]) },
    sendMessage(message, options) { sent.push(options === undefined ? { message } : { message, options }) },
  }
  return {
    pi, handlers, sent,
    async emit(event, payload, ctx) {
      let last: unknown
      for (const h of handlers.get(event) ?? []) {
        const r = await h(payload, ctx)
        if (r !== undefined) last = r
      }
      return last
    },
  }
}

export interface FakeCtx extends PiContext { notices: Array<{ message: string, type?: string }>, asked: string[] }

export function fakeCtx(opts: { sid?: string, cwd: string, mode?: PiContext['mode'], pct?: number, answer?: string }): FakeCtx {
  const notices: FakeCtx['notices'] = []
  const asked: string[] = []
  const sid = opts.sid ?? SID
  return {
    notices, asked,
    ui: {
      notify: (message, type) => { notices.push(type === undefined ? { message } : { message, type }) },
      ...(opts.answer !== undefined ? { select: async (title: string) => { asked.push(title); return opts.answer } } : {}),
    },
    mode: opts.mode ?? 'tui',
    hasUI: (opts.mode ?? 'tui') !== 'print',
    cwd: opts.cwd,
    sessionManager: { getSessionId: () => sid },
    model: { id: 'test-model' },
    getContextUsage: () => (opts.pct === undefined ? undefined : { tokens: Math.round(opts.pct * 2000), percent: opts.pct }),
  }
}

export interface MemoryCalls { spool: Array<{ sid: string, entries: SpoolEntry[] }>, started: string[], finalized: string[], contexts: string[], ui: string[] }

export function fakeMemory(context?: string): { bridge: MemoryBridge, calls: MemoryCalls } {
  const calls: MemoryCalls = { spool: [], started: [], finalized: [], contexts: [], ui: [] }
  return {
    calls,
    bridge: {
      ui: { started(sid) { calls.ui.push(`started ${sid}`) }, seen(sid) { calls.ui.push(`seen ${sid}`) }, ended(sid) { calls.ui.push(`ended ${sid}`) } },
      async appendSpool(sid, entries) { calls.spool.push({ sid, entries }) },
      async sessionStart(sid) { calls.started.push(sid) },
      async spawnFinalizer(sid) { calls.finalized.push(sid) },
      async contextText(cwd) { calls.contexts.push(cwd); return context },
      async writeHandoff(_sid, _cwd, note) { return `handoff-${note.slug}` },
      promptSeen() { /* nothing */ },
    },
  }
}

function notImplemented(name: string): never { throw new Error(`not implemented: ${name}`) }

export function testDeps(overrides: Partial<PiDeps> = {}): { deps: Partial<PiDeps>, memory: MemoryCalls, env: Record<string, string> } {
  const base = defaultDeps()
  const memory = fakeMemory('MEMORY INDEX')
  const env: Record<string, string> = {}
  const deps: Partial<PiDeps> = {
    now: () => 1_791_400_000_000,
    policy: {
      checkBash: () => notImplemented('checkBash'), checkWrite: () => notImplemented('checkWrite'), routeTool: () => ({ action: 'allow' }),
      capabilityCard: () => 'CARD', checkQuestion: () => notImplemented('checkQuestion'), detectIntent: base.policy.detectIntent,
      isGuardContinuation: () => false,
    },
    plan: { stopGuardVerdict: base.plan.stopGuardVerdict, validatePlan: base.plan.validatePlan, promptInteraction, answerReceipt },
    compact: { handoffNote: () => notImplemented('handoffNote'), restoreContext: () => notImplemented('restoreContext') },
    checkers: base.checkers,
    evalGuard: () => notImplemented('checkEval'),
    realpath: undefined,
    memory: memory.bridge,
    captureEnabled: () => true,
    buracleRepo: () => undefined,
    cli: () => ['buracle'],
    projectSlug: async () => 'demo',
    branch: async () => 'main',
    run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    setEnv: (k, v) => { env[k] = v },
    prepareWorkspace: async () => notImplemented('prepareWorkspace'),
    workspaceInfo: async () => notImplemented('workspaceInfo'),
    refreshWorkspace: info => info,
    ...overrides,
  }
  return { deps, memory: memory.calls, env }
}

export function testGenerated(over: Partial<PiGenerated> = {}): PiGenerated {
  return { v: 1, buracleVersion: '9.9.9', config: defaultConfig(), routing: { strictness: 'enforce', categories: [] }, mcp: [], mcpIds: [], skills: [], ...over }
}
