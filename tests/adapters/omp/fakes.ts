import type { ExtensionDeps } from '../../../src/adapters/omp/runtime/extension'
import { defaultDeps } from '../../../src/adapters/omp/runtime/extension'
import type { OmpContext, OmpCustomMessage, OmpExtensionAPI, OmpGenerated } from '../../../src/adapters/omp/runtime/types'
import { defaultConfig } from '../../../src/core/config'
import type { SessionState } from '../../../src/core/plan/state'
import { answerReceipt } from '../../../src/core/plan/state'
import { promptInteraction } from '../../../src/core/plan/interaction'
import type { MemoryBridge, SpoolEntry } from '../../../src/adapters/omp/runtime/memory'

export type Handler = (event: unknown, ctx: OmpContext) => unknown

export interface FakePi {
  pi: OmpExtensionAPI
  handlers: Map<string, Handler[]>
  commands: Map<string, { description?: string, handler: (args: string, ctx: OmpContext) => Promise<void> }>
  sent: Array<{ message: OmpCustomMessage, options?: unknown }>
  labels: string[]
  emit(event: string, payload: unknown, ctx: OmpContext): Promise<unknown>
}

export function fakePi(opts: { thinking?: string } = {}): FakePi {
  const handlers = new Map<string, Handler[]>()
  const commands = new Map<string, { description?: string, handler: (args: string, ctx: OmpContext) => Promise<void> }>()
  const sent: Array<{ message: OmpCustomMessage, options?: unknown }> = []
  const labels: string[] = []
  const pi: OmpExtensionAPI = {
    on(event, handler) {
      const list = handlers.get(event) ?? []
      list.push(handler as Handler)
      handlers.set(event, list)
    },
    registerCommand(name, options) { commands.set(name, options) },
    sendMessage(message, options) { sent.push(options === undefined ? { message } : { message, options }) },
    getThinkingLevel: () => opts.thinking,
    setLabel(label) { labels.push(label) },
  }
  return {
    pi, handlers, commands, sent, labels,
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

export interface UiCall { method: 'notify' | 'setStatus' | 'setWidget'; args: unknown[] }

export interface FakeCtx extends OmpContext {
  uiCalls: UiCall[]
  intervals: Array<{ ms?: number, fn: (...a: unknown[]) => void }>
  timeouts: Array<{ ms?: number, fn: (...a: unknown[]) => void }>
}

export function fakeCtx(opts: { sid?: string, cwd: string, mode?: OmpContext['mode'], kind?: 'main' | 'sub', name?: string, pct?: number, model?: string, provider?: string, artifacts?: string }): FakeCtx {
  const uiCalls: UiCall[] = []
  const intervals: FakeCtx['intervals'] = []
  const timeouts: FakeCtx['timeouts'] = []
  const sid = opts.sid ?? '01a118a8-8d01-740c-9360-f4f796699f4b'
  const ctx: FakeCtx = {
    uiCalls, intervals, timeouts,
    ui: {
      notify: (...args: unknown[]) => { uiCalls.push({ method: 'notify', args }) },
      setStatus: (...args: unknown[]) => { uiCalls.push({ method: 'setStatus', args }) },
      setWidget: (...args: unknown[]) => { uiCalls.push({ method: 'setWidget', args }) },
    },
    mode: opts.mode ?? 'tui',
    hasUI: (opts.mode ?? 'tui') !== 'print',
    cwd: opts.cwd,
    sessionManager: { getSessionId: () => sid, ...(opts.artifacts !== undefined ? { getArtifactsDir: () => opts.artifacts } : {}) },
    agent: { kind: opts.kind ?? 'main', id: opts.kind === 'sub' ? '0-Review' : 'Main', name: opts.name ?? (opts.kind === 'sub' ? 'changes-review' : 'main'), depth: opts.kind === 'sub' ? 1 : 0 },
    getContextUsage: () => (opts.pct === undefined ? undefined : { tokens: Math.round(opts.pct * 2000), contextWindow: 200_000, percent: opts.pct }),
    setInterval: (fn, ms) => { intervals.push({ ms, fn }); return { id: intervals.length } },
    setTimeout: (fn, ms) => { timeouts.push({ ms, fn }); return { id: timeouts.length } },
    clearTimer: () => undefined,
  }
  if (opts.model !== undefined) ctx.model = { id: opts.model, ...(opts.provider !== undefined ? { provider: opts.provider } : {}) }
  return ctx
}

export interface MemoryCalls {
  spool: Array<{ sid: string, entries: SpoolEntry[] }>, started: Array<{ sid: string, cwd: string }>, finalized: string[], contexts: string[]
  handoffs: Array<{ sid: string, cwd: string, slug: string, markdown: string, branch?: string }>
  prompts: string[]
}

export function fakeMemory(context?: string): { bridge: MemoryBridge, calls: MemoryCalls } {
  const calls: MemoryCalls = { spool: [], started: [], finalized: [], contexts: [], handoffs: [], prompts: [] }
  return {
    calls,
    bridge: {
      async appendSpool(sid, entries) { calls.spool.push({ sid, entries }) },
      async sessionStart(sid, cwd) { calls.started.push({ sid, cwd }) },
      async spawnFinalizer(sid) { calls.finalized.push(sid) },
      async contextText(cwd) { calls.contexts.push(cwd); return context },
      async writeHandoff(sid, cwd, note) { calls.handoffs.push({ sid, cwd, ...note }); return `handoff-${note.slug}` },
      promptSeen(sid) { calls.prompts.push(sid) },
    },
  }
}

export function fakeStatusRenderer(): Pick<typeof import('../../../src/core/status/render'), 'rows' | 'renderPlain'> {
  return {
    rows: (bar, layout) => layout.rows.map(ids => ids.flatMap(id => {
      const v = id === 'month' ? bar.month && `${bar.month.tokens}${bar.month.usd !== undefined ? `/$${bar.month.usd}` : ''}${bar.month.pct !== undefined ? ` ${bar.month.pct}%` : ''}`
        : id === 'mem' ? bar.mem && `${bar.mem.health}`
        : id === 'plan' ? bar.plan && `${bar.plan.title}[${bar.plan.phase}]${bar.plan.done}/${bar.plan.total}`
        : id === 'git' ? bar.git && `${bar.git.branch ?? '?'}`
        : id === 'upd' ? bar.updates !== undefined && `${bar.updates}`
        : undefined
      return v ? [{ id, text: `${id}=${v}` }] : []
    })).filter(r => r.length > 0),
    renderPlain: rows => rows.map(r => r.map(s => s.text).join(' | ')).join('\n'),
  }
}

function notImplemented(name: string): never {
  throw new Error(`not implemented: ${name}`)
}

export function testDeps(overrides: Partial<ExtensionDeps> = {}): { deps: Partial<ExtensionDeps>, memory: MemoryCalls, runs: string[][], env: Record<string, string>, usageRefreshes: { count: number } } {
  const base = defaultDeps()
  const memory = fakeMemory()
  const runs: string[][] = []
  const env: Record<string, string> = {}
  const usageRefreshes = { count: 0 }
  const deps: Partial<ExtensionDeps> = {
    now: () => 1_791_400_000_000,
    policy: {
      checkBash: () => notImplemented('checkBash'),
      checkWrite: () => notImplemented('checkWrite'),
      routeTool: () => notImplemented('routeTool'),
      capabilityCard: () => notImplemented('capabilityCard'),
      checkQuestion: () => notImplemented('checkQuestion'),
      detectIntent: () => notImplemented('detectIntent'),
      isGuardContinuation: () => notImplemented('isGuardContinuation'),
    },
    plan: {
      stopGuardVerdict: () => notImplemented('stopGuardVerdict'),
      applyIntent: () => notImplemented('applyIntent'),
      validatePlan: () => notImplemented('validatePlan'),
      parsePlan: () => notImplemented('parsePlan'),
      promptInteraction,
      answerReceipt,
    },
    compact: {
      compactInstructions: () => notImplemented('compactInstructions'),
      handoffNote: () => notImplemented('handoffNote'),
      restoreContext: () => notImplemented('restoreContext'),
    },
    checkers: {
      checkersFor: () => notImplemented('checkersFor'),
      findingsOf: () => notImplemented('findingsOf'),
      tddHint: () => notImplemented('tddHint'),
      charsetFindings: () => notImplemented('charsetFindings'),
      lengthNote: () => notImplemented('lengthNote'),
    },
    evalGuard: () => notImplemented('checkEval'),
    realpath: undefined,
    memSegment: () => ({ id: 'mem', text: 'mem 3·i1' }),
    status: fakeStatusRenderer(),
    bar: undefined,
    memory: memory.bridge,
    captureEnabled: () => true,
    buracleRepo: () => undefined,
    updates: () => undefined,
    cli: () => ['buracle'],
    notifyDesktop: () => undefined,
    projectSlug: async () => 'demo',
    branch: async () => 'main',
    gitState: async () => undefined,
    run: async argv => { runs.push(argv); return { code: 0, stdout: '', stderr: '', timedOut: false } },
    resolveChecker: argv => [...argv],
    usage: () => undefined,
    refreshUsage: () => { usageRefreshes.count++ },
    setEnv: (k, v) => { env[k] = v },
    state: base.state,
    prepareWorkspace: async () => notImplemented('prepareWorkspace'),
    workspaceInfo: async () => notImplemented('workspaceInfo'),
    refreshWorkspace: info => info,
    profileGuard: () => undefined,
    memoryUi: () => undefined,
    codegraphIndexed: () => false,
    columns: () => 120,
    ...overrides,
  }
  return { deps, memory: memory.calls, runs, env, usageRefreshes }
}

export function planState(over: Partial<NonNullable<SessionState['plan']>> = {}, extra: Partial<SessionState> = {}): SessionState {
  return {
    v: 1,
    plan: { path: 'docs/plans/2026-10-08-demo.md', slug: 'demo', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1, ...over },
    guard: { blocksForPlan: 0, blocksInChain: 0 },
    ...extra,
  }
}

export function testGenerated(over: Partial<OmpGenerated> = {}): OmpGenerated {
  return {
    v: 1, buracleVersion: '0.1.0', testedWith: '18.8.3', minOmp: '18.8.0', config: defaultConfig(),
    routing: { strictness: 'enforce', categories: [{ id: 'web-search', intent: 'web search', prefer: ['web-search'], fallback: [], deny_builtin: ['web_search'] }] },
    mcp: [
      { id: 'buracle-memory', description: 'Memory', transport: 'stdio', critical: true, routing: ['memory'], harnesses: ['omp'] },
      { id: 'context7', description: 'Library docs', transport: 'stdio', critical: true, routing: ['library-docs'], harnesses: ['omp'] },
      { id: 'web-search', description: 'Web search', transport: 'stdio', critical: true, routing: ['web-search'], harnesses: ['omp'] },
    ],
    mcpIds: ['buracle-memory', 'codegraph', 'context7', 'semble', 'web-search'],
    skills: [{ id: 'plan-build', description: 'Spec workflow', userInvocable: true }],
    plugins: [],
    commands: ['plan-build', 'goal-build'],
    status: { layout: { rows: [['month', 'mem', 'git', 'plan']], thresholds: { ctxWarn: 75, ctxCrit: 90 }, emoji: false }, setStatus: { 'buracle.budget': ['month'], 'buracle.mem': ['mem'] } },
    ...over,
  }
}
