import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import * as core from '../../../core/index'
import type { BuracleConfig } from '../../../core/config'
import type { SpoolEntry } from '../../../core/memory/spool'
import type { ToolCall, ToolKind } from '../../../core/events'
import { classifyTool } from '../../../core/events'
import { bandSummary } from '../../../core/flow/band'
import { flowDef } from '../../../core/flow/catalog'
import type { FlowSource } from '../../../core/flow/record'
import { capabilityCard, isGuardContinuation, questionAnswered, reviewerShellDenial, skillOf } from '../../../core/policy/index'
import { opencodeOffServers } from '../../shared/native-off'
import type { McpHealth } from '../../../core/policy/routing'
import { mcpUnavailable } from '../../../core/policy/routing'
import { ledgerCall, ledgerPrompt } from '../../../core/policy/usage'
import type { WriteGuardContext } from '../../../core/policy/write-guard'
import { compactInstructions } from '../../../core/compact'
import { contextWarning, contextWatch, type ContextBand } from '../../../core/status/context'
import type { RateWindow } from '../../../core/status/model'
import { log } from '../../../engine/log'
import { editDiagnostics } from '../../../engine/toolchain/lsp-edits'
import * as paths from '../../../engine/paths'
import { run } from '../../../engine/proc'
import { isMemoryRunnerDir } from '../../../memory/spawn'
import { flowViewFor, recordFlowStart } from '../../../workflow/flow'
import { loadLedger, updateLedger } from '../../../workflow/ledger'
import { shownPath } from '../../../workflow/plan-capture'
import { captureSessionPlan } from '../../../workflow/plan-native'
import { loadState, reviewSubjects, sessionMaint, writeTelemetry } from '../../../workflow/session-store'
import { refreshWorkspaceInfo, workspaceInfo } from '../../../workflow/workspace'
import type { AdapterContext } from '../../registry'
import { consentGate } from '../../shared/consent-store'
import { pathRuleSource } from '../../shared/path-rules'
import {
  mcpHealth, postTool, preCompact, preTool, prompt as promptEvent, readWorkspace, routingPolicy, saveWorkspace, sessionEnd, sessionStart, spool,
  usageVerdict, writeGuardContext, type PipelineDeps, type UsagePlan, type UsageVerdict, type WorkspaceReaders,
} from '../../shared/pipeline/index'
import { realWriteTarget } from '../../shared/realpath'
import { maskNotice } from '../../shared/tool-output-mask'
import type { UiSessionHooks } from '../../shared/ui-session'
import { prepareWorkspace } from '../../shared/workspace-start'
import { assetsOptions, startLinkRun, type AssetsSpawner } from '../../shared/project-assets'
import { guardedContents, opencodeChanges } from '../../shared/write-content'
import { buracleRepoFor } from './adapter-rules'
import { backgroundEnd, backgroundStart, type BackgroundJob } from './background'
import type { BakedData } from './baked'
import type { CheckerRunner, LspEditAsk } from './checks'
import { editTexts, lspEditNotes, OPENCODE_H04_BUDGET_MS } from './checks'
import { registerWorkflowCommands } from './commands'
import type { PendingPrompt } from './delivery'
import { addPending, deliveredPrompts, inboxUpdate, takeDelivered } from './delivery'
import { projectDeps } from './deps'
import type { ResolvedEnv } from './env'
import { applyEnv, resolveEnv, runtimeConfigCache } from './env'
import { answerHeld, type ConsentAskHost, type HeldAnswer } from './consent-ask'
import { questionGrant } from './consent-question'
import type { StopSnapshot } from './guard'
import { CONTINUE_MARK, registry, resetChain, StopGuard } from './guard'
import { adapterContext, compactStore, memoryFns, NO_UI, readPersisted, uiHooks, updatePersisted } from './host'
import { maskedError, maskedResult, masksOpencodeTool } from './mask'
import { postNotice } from './notice-board'
import { registerRateWindows } from './rate-windows'
import { TurnReceipts } from './receipt'
import type { MemoryBridge } from './memory-bridge'
import { draftNote, draftOnSwitch, notePlanText, OPENCODE_PLAN_AGENT, type PlanDraftState } from './plan-draft'
import { noteReviewMessages, reviewNote, reviewProblems, subagentReport } from './review'
import type { PromptRouteResult } from './routing'
import { attachedSkills, availableServers, commandOfPrompt, compiledTriggers, routeUserPrompt, runTitle, withinBudget } from './routing'
import type {
  ModelRef, OpenCodeEvent, PermissionEvaluation, ServerContext, ServerPluginDefinition, SessionCompactionEvent,
  SessionContextEvent, SessionPromptEvent, ShellCreateBefore, ToolExecuteAfter, ToolExecuteBefore, ToolResultShape, TuiToastVariant,
} from './types'
import { ModelFacts } from './models'
import { OPENCODE_TODO_TOOL, openTodosOf } from './todos'
import { actionMatchesTool, asRecord, errText, num, skillIdsOf, str, stringifyOutput, tokenTotal, within } from './util'
import type { WorkspaceFn } from './workspace'
import { prepareOnce, profileEnv, profileWarning } from './workspace'


export { CONTINUE_MARK, continuationText, REGISTRY_KEY, runawayNotice } from './guard'

export const PLUGIN_ID = 'buracle'
const HARNESS = 'opencode' as const

export const MAINT_INTERVAL_MS = 6 * 60 * 60_000
const SKILL_LIST_TTL_MS = 30_000
const SKILL_LIST_TIMEOUT_MS = 2000
const WRITE_COMPARE_MAX_BYTES = 512 * 1024

export interface PluginDeps {
  baked: BakedData
  memory: MemoryBridge
  pluginDir?: string
  now?: () => number
  settleMs?: number
  idleFinalizeMs?: number
  runChecker?: CheckerRunner
  lspEdits?: LspEditAsk
  logger?: (level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown) => void
  capture?: () => boolean
  maint?: (nowMs: number, keep: string[]) => { removed: string[] }
  workspace?: WorkspaceFn
  workspaceRead?: WorkspaceFn
  assetsSpawn?: AssetsSpawner
  consentAsk?: Partial<ConsentAskHost>
}

interface PendingCall { tool: string; input: unknown; sessionID: string; at: number; denied?: boolean }

const RESUME_AFTER_MS = 60_000

interface SessionRuntime {
  sid: string
  cwd?: string
  /** The open items of the session's last todowrite call, carried into the handoff note. */
  todos?: string[]
  parentID?: string | null
  /** How many invalid review reports the last context call noted (H19), so each is logged once. */
  reviewNotes?: number
  createdAt?: number
  capture: boolean
  activity: boolean
  gen: number
  running: boolean
  handledGen: number
  interrupts: number
  failures: number
  userPrompts: number
  lastAssistantText?: string
  agent?: string
  background?: Map<string, BackgroundJob>
  draft?: PlanDraftState
  model?: ModelRef
  ctx?: { pct: number, tokens: number, window: number }
  ctxWarned?: ContextBand
  lastTokens?: number
  costUsd?: number
  windows?: RateWindow[]
  windowsAt?: number
  /** The session start in flight or done; cleared when a compaction ends, so the next step starts again. */
  starting?: Promise<void>
  /** What the session start returned: OpenCode rebuilds the system text on every step, so each step repeats it. */
  startContext: string[]
  /** The capability card of the session start, which each step replaces with the current one. */
  card?: string
  /** The release notice for the model, shown on one step only. */
  noticeOnce?: string
  compacted: boolean
  pendingContext: string[]
  pending: PendingPrompt[]
  idleTimer?: ReturnType<typeof setTimeout>
}

export const IDLE_FINALIZE_MS = 10 * 60_000

const MAX_PENDING_CALLS = 500
const PENDING_TTL_MS = 30 * 60_000
const MAX_REVIEWED = 200
const MAX_SESSION_DEPTH = 8
const SESSION_ENV_VARS = ['CLAUDE_CODE_SESSION_ID', 'CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'OMP_SESSION_ID'] as const

export function contextNote(pct: number | undefined, cfg: BuracleConfig['context']): string | undefined {
  if (pct === undefined) return undefined
  const band = pct >= cfg.criticalPct ? 'critical' : pct >= cfg.warnPct ? 'warn' : 'ok'
  return contextWarning(band, cfg)
}

function isEdit(kind: ToolKind): boolean {
  return kind === 'edit' || kind === 'write' || kind === 'patch'
}

/**
 * The server plugin. It decodes OpenCode's hooks and events into the canonical events of the shared pipeline
 * (src/adapters/shared/pipeline), applies each decision in OpenCode's way, and keeps the steps only OpenCode has.
 */
export class BuracleRuntime {
  readonly env: ResolvedEnv
  private readonly baked: BakedData
  private readonly now: () => number
  private readonly pluginDir: string | undefined
  private readonly runChecker: CheckerRunner
  private readonly lspEdits: LspEditAsk
  private readonly idleFinalizeMs: number
  private readonly logFn: NonNullable<PluginDeps['logger']>
  private readonly captureOn: NonNullable<PluginDeps['capture']>
  private readonly maintFn: NonNullable<PluginDeps['maint']>
  private readonly workspaceFn: WorkspaceFn
  private readonly workspaceRead: WorkspaceFn
  private readonly assetsSpawn: AssetsSpawner | undefined
  private readonly stopGuard: StopGuard
  private readonly receipts: TurnReceipts
  private readonly config: ReturnType<typeof runtimeConfigCache>
  private readonly memoryFns: ReturnType<typeof memoryFns>
  private readonly uiFns: UiSessionHooks
  private readonly sessions = new Map<string, SessionRuntime>()
  private readonly calls = new Map<string, PendingCall>()
  private readonly nudges = new Map<string, string[]>()
  private readonly verdicts = new Map<string, UsageVerdict>()
  private readonly consentHost: ConsentAskHost
  private readonly skillLists = new Map<string, { at: number, ids: Promise<ReadonlySet<string> | undefined> }>()
  private readonly reviewed = new Set<string>()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly abort = new AbortController()
  private readonly models: ModelFacts
  private readonly startedAt: number
  private disposed = false

  constructor(private readonly ctx: ServerContext, deps: PluginDeps) {
    this.baked = deps.baked
    this.consentHost = { now: () => this.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), newId: () => crypto.randomUUID(), ...deps.consentAsk }
    this.memoryFns = memoryFns(deps.memory)
    this.uiFns = uiHooks(deps.memory)
    this.now = deps.now ?? Date.now
    this.pluginDir = deps.pluginDir
    this.logFn = deps.logger ?? ((level, msg, data) => log(level, `opencode: ${msg}`, data))
    this.idleFinalizeMs = deps.idleFinalizeMs ?? IDLE_FINALIZE_MS
    this.runChecker = deps.runChecker ?? (async (plan, timeoutMs) => {
      const r = await run(plan.argv, { cwd: plan.cwd, timeoutMs: timeoutMs ?? plan.timeoutMs, ...(plan.env !== undefined ? { env: plan.env } : {}) })
      return { code: r.code, stdout: r.stdout, stderr: r.stderr, timedOut: r.timedOut }
    })
    this.lspEdits = deps.lspEdits ?? editDiagnostics
    this.captureOn = deps.capture ?? (() => process.env['BURACLE_NO_CAPTURE'] !== '1')
    this.maintFn = deps.maint ?? ((nowMs, keep) => sessionMaint(HARNESS, nowMs, { keep }))
    this.workspaceFn = deps.workspace ?? prepareWorkspace
    this.workspaceRead = deps.workspaceRead ?? workspaceInfo
    this.assetsSpawn = deps.assetsSpawn
    this.env = resolveEnv(deps.pluginDir)
    applyEnv(this.env)
    this.config = runtimeConfigCache(this.baked.defaults)
    this.models = new ModelFacts(ctx, (msg, data) => this.logFn('debug', msg, data))
    this.startedAt = this.now()
    this.stopGuard = new StopGuard({
      disposed: () => this.disposed,
      now: () => this.now(),
      cfg: () => this.cfg(),
      session: sid => this.sessions.get(sid),
      isRoot: async sid => {
        const s = this.sessions.get(sid)
        if (s === undefined) return false
        await this.resolveParent(s)
        return s.parentID === null
      },
      cwd: sid => this.cwdOf(this.session(sid)),
      prompt: input => this.ctx.session.prompt(input),
      spool: (sid, entries) => this.spool(this.session(sid), entries),
      log: (level, msg, data) => this.logFn(level, msg, data),
      deps: sid => this.deps(this.session(sid)),
      notify: (sid, text, variant) => this.notify(sid, text, variant),
    }, deps.settleMs ?? 1500)
    this.receipts = new TurnReceipts({
      now: () => this.now(),
      post: (sid, text, variant) => this.notify(sid, text, variant),
      run: sid => bandSummary(flowViewFor(HARNESS, sid, this.now(), this.cfg().workflow.foldAfterSec)),
      log: (msg, data) => this.logFn('debug', msg, data),
    })
  }

  /**
   * Show the user a notice in the session. A server plugin has no UI of its own, so the text goes to the session's
   * notice board, which the TUI plugin shows as a toast (`ui.toast.show`); nothing of it reaches the model.
   */
  private notify(sid: string, text: string, variant: TuiToastVariant): void {
    try { postNotice(sid, text, variant, this.now()) } catch (e) { this.logFn('warn', 'notice not posted', { sid, error: errText(e) }) }
  }

  private cfg(): BuracleConfig {
    return this.config.get().config
  }

  /** The adapter context the pipeline reads: the baked canonical data with the current runtime config. */
  private actx(): AdapterContext {
    return adapterContext(this.baked, this.config.get())
  }

  private async step<T>(name: string, fallback: T, fn: () => T | Promise<T>): Promise<T> {
    try { return await fn() } catch (e) {
      this.logFn('warn', `${name} failed`, { error: errText(e) })
      return fallback
    }
  }

  /** What the shared pipeline needs from OpenCode for one session. */
  private deps(s: SessionRuntime, capture: boolean = s.capture): PipelineDeps {
    const runner = isMemoryRunnerDir(this.cwdOf(s))
    const profile = profileEnv(this.pluginDir, this.env.home)
    const workspace: WorkspaceReaders = {
      prepareWorkspace: (cwd, ctx, now) => prepareOnce(cwd, ctx.config, now, this.workspaceFn),
      // A subagent is a session of its own in OpenCode, so the workspace it reads is saved under its own id.
      workspaceInfo: async (cwd, ctx, now) => {
        const info = await this.workspaceRead(cwd, ctx.config, now)
        saveWorkspace(ctx, HARNESS, s.sid, info)
        return info
      },
      refreshWorkspace: (info, ctx, now) => refreshWorkspaceInfo(info, ctx.config, now),
    }
    return {
      harness: HARNESS, ctx: this.actx(), core, workspace,
      // The session's capture decision (an injected one in tests) is what the pipeline reads as BURACLE_NO_CAPTURE.
      env: { ...process.env, BURACLE_NO_CAPTURE: capture && !runner ? undefined : '1' },
      ...(profile !== undefined ? { hostEnv: { ...process.env, ...profile } } : {}),
      step: (name, fallback, fn) => this.step(name, fallback, fn),
      memory: async name => this.memoryFns[name],
      ui: runner ? NO_UI : this.uiFns,
      // The plugin lives as long as OpenCode: the repository lookup is cached and starts no git process per call.
      buracleRepo: async cwd => buracleRepoFor(cwd, this.configuredRepos(), this.now()),
      ...(this.assetsSpawn !== undefined ? { assetsSpawn: this.assetsSpawn } : {}),
    }
  }

  private configuredRepos(): string[] {
    const snap = this.config.get()
    const out: string[] = []
    const resolvedRoot = snap.resolved?.repoRoot
    if (typeof resolvedRoot === 'string' && resolvedRoot !== '') out.push(resolvedRoot)
    const repo = snap.config.repo
    if (typeof repo === 'string' && repo.trim() !== '') out.push(paths.expandHome(repo.trim()))
    return out
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.tasks.add(p)
    const done = () => { this.tasks.delete(p) }
    p.then(done, done)
    return p
  }

  async idle(): Promise<void> {
    while (this.tasks.size > 0) await Promise.allSettled([...this.tasks])
  }

  private safe<A extends unknown[]>(name: string, fn: (...args: A) => unknown): (...args: A) => Promise<void> {
    return async (...args: A) => {
      try { await fn(...args) } catch (e) { this.logFn('error', `${name} failed`, { error: errText(e) }) }
    }
  }

  private captureNow(): boolean {
    try { return this.captureOn() } catch { return true }
  }

  private session(sid: string): SessionRuntime {
    let s = this.sessions.get(sid)
    if (s === undefined) {
      s = { sid, capture: this.captureNow() && !isMemoryRunnerDir(this.ctx.location.directory), activity: false, gen: 0, running: false, handledGen: -1, interrupts: 0, failures: 0, userPrompts: 0, compacted: false, startContext: [], pendingContext: [], pending: [] }
      this.sessions.set(sid, s)
      if (paths.isValidSessionId(sid)) {
        try {
          const saved = readPersisted(sid)
          if (saved.ctxWarned !== undefined) s.ctxWarned = saved.ctxWarned
          if (saved.todos !== undefined) s.todos = saved.todos
        } catch {  }
      }
    }
    return s
  }

  private persist(s: SessionRuntime): void {
    try {
      updatePersisted(s.sid, p => {
        const { ctxWarned: _band, todos: _todos, ...rest } = p
        return { ...rest, ...(s.ctxWarned !== undefined ? { ctxWarned: s.ctxWarned } : {}), ...(s.todos !== undefined ? { todos: s.todos } : {}) }
      })
    } catch (e) { this.logFn('warn', 'could not persist session data', { sid: s.sid, error: errText(e) }) }
  }

  private cwdOf(s: SessionRuntime): string {
    return s.cwd ?? this.ctx.location.directory
  }

  private isSubagent(s: SessionRuntime): boolean {
    return typeof s.parentID === 'string'
  }

  private async subagentSession(s: SessionRuntime): Promise<boolean> {
    if (s.parentID === undefined) await this.resolveParent(s)
    return this.isSubagent(s)
  }

  /** Append to a session's memory spool (H14), through the pipeline. */
  private async spool(s: SessionRuntime, entries: SpoolEntry[]): Promise<void> {
    if (paths.isValidSessionId(s.sid)) await spool(this.deps(s), s.sid, entries)
  }

  private async rootOf(s: SessionRuntime): Promise<SessionRuntime | undefined> {
    let cur = s
    for (let depth = 0; depth < MAX_SESSION_DEPTH; depth++) {
      if (cur.parentID === undefined) await this.resolveParent(cur)
      if (typeof cur.parentID !== 'string') return cur
      cur = this.session(cur.parentID)
    }
    return undefined
  }

  private async spoolOwn(s: SessionRuntime, entries: SpoolEntry[]): Promise<void> {
    if (!await this.subagentSession(s)) await this.spool(s, entries)
  }

  private scheduleIdleFinalize(s: SessionRuntime): void {
    if (this.idleFinalizeMs <= 0 || this.disposed || !paths.isValidSessionId(s.sid)) return
    if (s.idleTimer !== undefined) clearTimeout(s.idleTimer)
    const gen = s.gen
    s.idleTimer = setTimeout(() => {
      s.idleTimer = undefined
      if (this.disposed || s.running || s.gen !== gen || this.sessions.get(s.sid) !== s) return
      this.track((async () => {
        if (await this.subagentSession(s) || !s.activity || !s.capture) return
        // The session has not ended, so only the memory finalizer starts (the pipeline's sessionEnd would close the UI record).
        await this.step('H14 idle finalizer', undefined, async () => { await this.memoryFns.spawnFinalizer?.(HARNESS, s.sid) })
      })())
    }, this.idleFinalizeMs)
    s.idleTimer.unref?.()
  }

  private cancelIdleFinalize(s: SessionRuntime | undefined): void {
    if (s?.idleTimer === undefined) return
    clearTimeout(s.idleTimer)
    s.idleTimer = undefined
  }

  /** sessionEnd for a root session; `capture` false closes the UI record without a finalizer. */
  private async end(s: SessionRuntime, capture: boolean): Promise<void> {
    if (!paths.isValidSessionId(s.sid)) return
    await sessionEnd({ harness: HARNESS, sessionId: s.sid, now: this.now() }, this.deps(s, capture))
  }

  /** Mark activity and start the session once: OpenCode has no session-start hook, so the first event of a session does it. */
  private touch(s: SessionRuntime): Promise<void> {
    s.activity = true
    return this.start(s)
  }

  private start(s: SessionRuntime): Promise<void> {
    return s.starting ??= this.track(this.startSession(s).catch((e: unknown) => { this.logFn('warn', 'session start failed', { sid: s.sid, error: errText(e) }) }))
  }

  private async startSession(s: SessionRuntime): Promise<void> {
    if (!paths.isValidSessionId(s.sid)) return
    await this.resolveParent(s)
    const cwd = this.cwdOf(s)
    if (isMemoryRunnerDir(cwd)) { s.capture = false; return }
    const sub = this.isSubagent(s)
    const source = s.compacted ? 'compact' : this.resumed(s) ? 'resume' : 'startup'
    s.compacted = false
    const now = this.now()
    const d = this.deps(s)
    const r = await sessionStart({ harness: HARNESS, sessionId: s.sid, cwd, source, subagent: sub, now, ...(s.model !== undefined ? { model: `${s.model.providerID}/${s.model.id}` } : {}) }, {
      ...d,
      // A subagent has no memory record of its own: its tool calls are spooled in the root session.
      ...(sub ? { env: { ...d.env, BURACLE_NO_MEMORY: '1' } } : {}),
      capabilityCard: () => (s.card = this.capabilityText(s.sid)),
      compact: compactStore(s.sid, now),
      // The plugin is a built copy, so the version that runs is the one baked into it.
      version: () => this.baked.version,
      sessionMaint: () => { this.runMaintenance() },
    })
    s.startContext = r.context.filter(part => part !== r.notice?.model)
    if (r.notice?.model !== undefined) s.noticeOnce = r.notice.model
    // The user's copy of a release notice: the model is asked to pass it on, and the TUI shows it right away.
    if (r.notice?.user !== undefined) this.notify(s.sid, r.notice.user, 'info')
  }

  private prunePending(): void {
    const cutoff = this.now() - PENDING_TTL_MS
    for (const [id, c] of this.calls) if (c.at < cutoff) { this.calls.delete(id); this.nudges.delete(id); this.verdicts.delete(id) }
    while (this.calls.size > MAX_PENDING_CALLS) {
      const first = this.calls.keys().next()
      if (first.done === true) break
      this.calls.delete(first.value)
      this.nudges.delete(first.value)
      this.verdicts.delete(first.value)
    }
  }

  async register(): Promise<void> {
    const c = this.ctx
    await c.tool.hook('execute.before', this.safe('tool.execute.before', (e: ToolExecuteBefore) => this.onToolBefore(e)))
    await c.permission.hook('evaluate', this.safe('permission.evaluate', (e: PermissionEvaluation) => this.evaluate(e)))
    await c.tool.hook('execute.after', this.safe('tool.execute.after', (e: ToolExecuteAfter) => this.onToolAfter(e)))
    await c.session.hook('context', this.safe('session.context', (e: SessionContextEvent) => this.onContext(e)))
    await c.session.hook('compaction', this.safe('session.compaction', (e: SessionCompactionEvent) => this.onCompaction(e)))
    await c.session.hook('prompt', this.safe('session.prompt', (e: SessionPromptEvent) => this.onPrompt(e)))
    await c.shell.hook('create.before', this.safe('shell.create.before', (e: ShellCreateBefore) => this.onShellCreate(e)))
    await registerRateWindows(c, (sid, windows) => { this.track(this.onWindows(sid, windows)) }, { now: () => this.now(), log: (msg, data) => this.logFn('debug', msg, data) })
  }

  private async onWindows(sid: string, windows: RateWindow[]): Promise<void> {
    const s = this.session(sid)
    const root = (await this.rootOf(s)) ?? s
    root.windows = windows
    root.windowsAt = this.now()
    await this.telemetry(root)
  }

  private async turnEnded(s: SessionRuntime): Promise<void> {
    if (!await this.subagentSession(s)) this.receipts.end(s.sid)
  }

  async registerTransforms(): Promise<void> {
    try {
      const ok = await registerWorkflowCommands(this.ctx, this.baked.skills, {
        knownSkills: sid => this.knownSkills(this.cwdOf(this.session(sid))),
        flowStart: (sid, workflow, title) => {
          if (!paths.isValidSessionId(sid)) return
          recordFlowStart(HARNESS, sid, title !== undefined ? { workflow, title, source: 'command' } : { workflow, source: 'command' }, this.now())
        },
        prompt: input => this.ctx.session.prompt(input),
      })
      if (!ok) this.logFn('warn', 'this OpenCode has no plugin commands (ctx.command); the /<workflow> commands are unavailable')
    } catch (e) { this.logFn('warn', 'workflow commands not registered', { error: errText(e) }) }
  }

  startEvents(): void {
    const signal = this.abort.signal
    this.track((async () => {
      try {
        for await (const e of this.ctx.event.subscribe({ signal })) {
          if (this.disposed) break
          try { await this.handleEvent(e) } catch (err) { this.logFn('error', 'event handler failed', { type: e?.type, error: errText(err) }) }
        }
      } catch (err) {
        if (!signal.aborted) this.logFn('warn', 'event stream ended', { error: errText(err) })
      }
    })())
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.abort.abort()
    for (const s of this.sessions.values()) {
      this.cancelIdleFinalize(s)
      if (typeof s.parentID !== 'string') await this.end(s, s.capture && s.activity)
    }
    this.sessions.clear()
    this.calls.clear()
    this.nudges.clear()
    this.verdicts.clear()
  }

  /** Session maintenance (H16). The plugin outlives its sessions, so it runs at most every few hours and keeps every session it knows. */
  runMaintenance(): void {
    if (this.disposed) return
    try {
      const reg = registry()
      const now = this.now()
      if (reg.maintAt !== undefined && now - reg.maintAt >= 0 && now - reg.maintAt < MAINT_INTERVAL_MS) return
      reg.maintAt = now
      const r = this.maintFn(now, [...this.sessions.keys()])
      if (r.removed.length > 0) this.logFn('info', 'session maintenance removed idle state', { removed: r.removed.length })
    } catch (e) {
      this.logFn('warn', 'session maintenance failed', { error: errText(e) })
    }
  }

  /** The service process may run for days without a new session, so maintenance also runs when the plugin loads. */
  scheduleMaintenance(): void {
    this.track(new Promise<void>(res => { setTimeout(res, 0) }).then(() => this.runMaintenance()))
  }

  /** Prepare the project's workspace when the plugin loads, before any session asks for it. */
  scheduleWorkspace(): void {
    if (this.disposed) return
    const cwd = this.ctx.location.project.directory || this.ctx.location.directory
    this.track(new Promise<void>(res => { setTimeout(res, 0) }).then(async () => {
      try {
        const info = await prepareOnce(cwd, this.cfg(), this.now(), this.workspaceFn)
        startLinkRun(info.root, assetsOptions(this.now(), this.assetsSpawn))
      } catch (e) { this.logFn('warn', 'workspace preparation failed', { error: errText(e) }) }
    }))
  }

  /** The profile guard (H17) at plugin load: the folder the plugin was loaded from names the profile, once per process. */
  checkProfile(): void {
    try {
      const warning = profileWarning(this.pluginDir, this.config.get(), this.env.home)
      if (warning === undefined) return
      const reg = registry()
      if (reg.profileWarned === true) return
      reg.profileWarned = true
      this.logFn('warn', warning)
    } catch (e) {
      this.logFn('debug', 'profile guard failed', { error: errText(e) })
    }
  }

  private knownSkills(dir: string): Promise<ReadonlySet<string> | undefined> {
    const now = this.now()
    const hit = this.skillLists.get(dir)
    if (hit !== undefined && now - hit.at >= 0 && now - hit.at < SKILL_LIST_TTL_MS) return hit.ids
    const domain = this.ctx.skill
    if (domain === undefined || typeof domain.list !== 'function') return Promise.resolve(undefined)
    let listed: Promise<unknown>
    try { listed = domain.list({ location: { directory: dir } }) } catch { return Promise.resolve(undefined) }
    const ids = within(listed.then(skillIdsOf), SKILL_LIST_TIMEOUT_MS, undefined)
    if (this.skillLists.size >= 64) this.skillLists.clear()
    this.skillLists.set(dir, { at: now, ids })
    return ids
  }

  private callOf(tool: string, input: unknown, sessionID: string): ToolCall {
    const cwd = this.ctx.location.directory
    const raw = asRecord(input)
    const cls = classifyTool(HARNESS, tool, raw, cwd, this.baked.mcpIds, { homeTilde: this.env.home })
    const call: ToolCall = { harness: HARNESS, sessionId: sessionID, cwd, tool, kind: cls.kind, input: raw, paths: cls.paths }
    if (cls.command !== undefined) call.command = cls.command
    if (cls.mcp !== undefined) call.mcp = cls.mcp
    return call
  }

  private wholeFileEdit(call: ToolCall): { file: string, removed: string, added: string } | undefined {
    const file = call.paths[0]
    const added = str(call.input['content'])
    if (file === undefined || added === undefined) return undefined
    let removed = ''
    try {
      if (statSync(file).size <= WRITE_COMPARE_MAX_BYTES) removed = readFileSync(file, 'utf8')
      else return undefined
    } catch { removed = '' }
    return { file, removed, added }
  }

  /** The MCP servers OpenCode's own config turns off (`disabled: true`), read through an mtime cache. */
  private nativeOff(): string[] {
    return opencodeOffServers(this.ctx.location.project.directory || this.ctx.location.directory)
  }

  private health(sid: string): McpHealth {
    return mcpHealth(this.actx(), HARNESS, this.now(), { nativeOff: this.nativeOff(), ...(paths.isValidSessionId(sid) ? { sid } : {}) })
  }

  /** What the usage reminders (H24) judge of a call. */
  private usagePlan(call: ToolCall, health: McpHealth): UsagePlan {
    const plan: UsagePlan = { call, ledgerId: call.sessionId, available: availableServers(this.baked, health) }
    const read = call.kind === 'read' && call.paths.length > 0 && call.paths.every(p => existsSync(p))
    const rules = pathRuleSource(this.baked.pathRules, join(this.env.buracleHome, 'rules', 'paths'), { onRead: read, home: this.env.home })
    if (rules !== undefined) plan.pathRules = rules
    if (call.kind === 'write') {
      const edit = this.wholeFileEdit(call)
      if (edit !== undefined) plan.edits = [edit]
    }
    return plan
  }

  private async skillLoaded(s: SessionRuntime, id: string, now: number): Promise<void> {
    if (!paths.isValidSessionId(s.sid) || await this.subagentSession(s)) return
    if (flowDef(id) !== undefined) recordFlowStart(HARNESS, s.sid, { workflow: id, source: 'skill' }, now)
  }

  /**
   * tool.execute.before fires for every call, permission.evaluate only for the ones OpenCode asks about: the usage
   * reminders (H24) count here, and the evaluation applies their verdict with the other steps of preTool.
   */
  async onToolBefore(e: ToolExecuteBefore): Promise<void> {
    this.prunePending()
    this.calls.set(e.id, { tool: e.tool, input: e.input, sessionID: e.sessionID, at: this.now() })
    const s = this.session(e.sessionID)
    if (typeof e.agent === 'string' && e.agent !== '') s.agent = e.agent
    // The session start resets the usage ledger, so it ends before the first call is counted.
    await this.touch(s)
    if (!paths.isValidSessionId(e.sessionID)) return
    const call = this.callOf(e.tool, e.input, e.sessionID)
    const d = this.deps(s)
    const verdict = await d.step('H24 usage', {} as UsageVerdict, () => usageVerdict({ call }, {
      ...d,
      usage: (c, health) => this.usagePlan(c, health),
      usageDone: async plan => {
        const skill = skillOf(plan.call, HARNESS)
        if (skill !== undefined) await this.skillLoaded(s, skill, this.now())
      },
    }, this.health(e.sessionID)))
    if (verdict.deny !== undefined || verdict.context !== undefined) this.verdicts.set(e.id, verdict)
  }

  buildCall(e: PermissionEvaluation): ToolCall | undefined {
    if (e.action === 'external_directory') return undefined
    const cwd = this.ctx.location.directory
    const pending = e.source?.type === 'tool' ? this.calls.get(e.source.id) : undefined
    const resources = [...e.resources]
    let tool: string
    let input: Record<string, unknown>
    if (pending !== undefined && actionMatchesTool(e.action, pending.tool)) {
      tool = pending.tool
      input = asRecord(pending.input)
    } else {
      tool = e.action
      switch (e.action) {
        case 'shell': input = { command: resources.join('\n') }; break
        case 'edit': input = { paths: resources }; break
        case 'read': input = { path: resources[0] ?? '' }; break
        case 'webfetch': input = { url: resources[0] ?? '' }; break
        case 'websearch': input = { query: resources[0] ?? '' }; break
        default: input = {}
      }
    }
    const cls = classifyTool(HARNESS, tool, input, cwd, this.baked.mcpIds, { homeTilde: this.env.home })
    let pathsOut = cls.paths
    if (e.action === 'edit') {
      const fromResources = resources.flatMap(r => (r === '' ? [] : [isAbsolute(r) ? resolve(r) : resolve(cwd, r)]))
      pathsOut = [...new Set([...pathsOut, ...fromResources])]
    }
    const call: ToolCall = { harness: HARNESS, sessionId: e.sessionID, cwd, tool, kind: cls.kind, input, paths: pathsOut }
    if (cls.command !== undefined) call.command = cls.command
    else if (cls.kind === 'bash' && e.action === 'shell') call.command = resources.join('\n')
    if (cls.mcp !== undefined) call.mcp = cls.mcp
    return call
  }

  /** The write guard's context (H02) for a folder, as the pipeline builds it. */
  writeContext(cwd: string): Promise<WriteGuardContext> {
    return writeGuardContext(this.deps(this.detached('')), cwd)
  }

  /** permission.evaluate is OpenCode's preTool: a denial becomes the `deny` effect with the pipeline's reason as the message. */
  async evaluate(e: PermissionEvaluation): Promise<void> {
    if (e.effect === 'deny') return
    const call = this.buildCall(e)
    if (call === undefined) return
    const sid = call.sessionId
    const valid = paths.isValidSessionId(sid)
    const s = this.session(sid)
    const id = e.source?.type === 'tool' ? e.source.id : undefined
    if (valid) await this.start(s)
    const sub = valid && await this.subagentSession(s)
    const edit = isEdit(call.kind)
    let held: HeldAnswer | undefined
    const decision = await preTool({
      call, now: this.now(), subagent: sub, guardsOnly: !valid,
      usage: (id !== undefined ? this.verdicts.get(id) : undefined) ?? false,
      // The early-edit note reaches the model in the call's result, so it needs a call to ride on.
      ...(edit && id !== undefined ? { edits: call.paths } : {}),
    }, {
      ...this.deps(s),
      guardRepoInShell: true,
      shellDenial: async command => reviewerShellDenial(e.agent, command),
      // OpenCode's own ask dialog cannot carry Buracle's consent options, so the TUI plugin asks; the call waits for the answer.
      holdConsent: async command => {
        held = await answerHeld(sid, command, { host: this.consentHost, isSubagent: async () => sub })
        // The answer is a grant like any other: the gate takes it, so a one-use grant is spent by this call.
        return held.allowed && consentGate(HARNESS, sid, command, this.now()) === undefined
      },
      writeTargets: c => (edit && c.paths.length > 0
        ? { paths: c.paths, contents: guard => guardedContents(opencodeChanges(c.tool, c.input, c.paths, c.cwd, guard.home), c.paths, guard.home, { realpath: realWriteTarget }) }
        : undefined),
      nativeOff: () => this.nativeOff(),
      usage: () => undefined,
    })
    if (decision.action === 'allow') {
      if (id !== undefined && decision.context.length > 0) this.nudges.set(id, decision.context)
      return
    }
    e.effect = 'deny'
    e.message = decision.hook !== 'H20' ? decision.reason : held?.refusal ?? (held?.hint !== undefined ? `${decision.reason} ${held.hint}` : decision.reason)
    const pending = id !== undefined ? this.calls.get(id) : undefined
    if (pending !== undefined) pending.denied = true
    this.logFn('info', 'denied tool call', { sid, hook: decision.hook, tool: call.tool })
  }

  async onToolAfter(e: ToolExecuteAfter): Promise<void> {
    const pending = this.calls.get(e.id)
    this.calls.delete(e.id)
    const nudges = this.nudges.get(e.id) ?? []
    this.nudges.delete(e.id)
    const verdict = this.verdicts.get(e.id)
    this.verdicts.delete(e.id)
    const s = this.session(e.sessionID)
    await this.touch(s)
    const valid = paths.isValidSessionId(e.sessionID)
    const sub = valid && await this.subagentSession(s)
    const now = this.now()
    const cwd = this.ctx.location.directory
    const input = asRecord(e.input)
    const cls = classifyTool(HARNESS, e.tool, input, cwd, this.baked.mcpIds, { homeTilde: this.env.home })
    const ms = pending !== undefined ? Math.max(0, now - pending.at) : undefined
    const edit = isEdit(cls.kind)
    const done = e.status === 'completed'

    let entry: SpoolEntry | undefined
    if (edit || cls.kind === 'bash') {
      entry = { ts: now, ev: 'tool', tool: e.tool, kind: cls.kind }
      if (cls.paths.length > 0) entry.paths = cls.paths
      if (cls.command !== undefined) entry.cmd = cls.command
      if (ms !== undefined) entry.ms = ms
      if (e.status === 'completed') {
        const exit = num(asRecord(e.result.output)['exit'])
        if (exit !== undefined) entry.exit = exit
      } else entry.exit = -1
    } else if (cls.kind === 'mcp' || cls.kind === 'web_search' || cls.kind === 'web_fetch' || e.tool === 'skill') {
      entry = { ts: now, ev: 'tool', tool: e.tool, kind: cls.kind }
      if (ms !== undefined) entry.ms = ms
      if (!done) entry.exit = -1
    }
    const denied = verdict?.deny !== undefined || pending?.denied === true
    if (!denied && s.parentID === null) this.receipts.tool(s.sid, e, { kind: cls.kind, paths: cls.paths, cwd, home: this.env.home, ...(cls.command !== undefined ? { command: cls.command } : {}) })
    if (e.status === 'completed') this.maskResult(e, cls.kind)
    else this.maskError(e, cls.kind)
    if (!denied && e.tool === OPENCODE_TODO_TOOL && done) {
      const open = openTodosOf(e.input)
      if (open !== undefined) { s.todos = open; this.persist(s) }
    }
    const answered = !denied && !sub && e.tool === 'question' && e.status === 'completed' && questionAnswered(e.result)
    const server = cls.kind === 'mcp' && !denied ? cls.mcp?.server : undefined
    const texts = edit && done ? editTexts(cls.kind, cls.paths, input, cwd, this.env.home) : undefined
    const r = !valid ? undefined : await postTool({
      sessionId: e.sessionID, cwd, now, subagent: sub, answered,
      entries: entry !== undefined && !sub ? [entry] : [],
      ...(texts !== undefined ? { edit: { ok: true, paths: cls.paths, added: texts.added, removed: () => texts.removed } } : {}),
      ...(server !== undefined ? { mcp: { server: () => server, ok: done } } : {}),
    }, {
      ...this.deps(s),
      fileChecks: {
        now: this.now,
        run: async (argv, opts) => {
          const res = await this.runChecker({ argv, cwd: opts?.cwd ?? cwd, timeoutMs: opts?.timeoutMs ?? OPENCODE_H04_BUDGET_MS, parser: 'generic', ...(opts?.env !== undefined ? { env: opts.env as Record<string, string> } : {}) }, opts?.timeoutMs)
          return { code: res?.code ?? 127, stdout: res?.stdout ?? '', stderr: res?.stderr ?? '', timedOut: res?.timedOut === true }
        },
      },
      editBudgetMs: OPENCODE_H04_BUDGET_MS,
    })
    // A subagent's tool calls belong to the root session's memory: the subagent has no record of its own.
    if (entry !== undefined && sub) {
      const root = await this.rootOf(s)
      if (root !== undefined) { await this.touch(root); await this.spool(root, [entry]) }
    }
    // The consent question asked through OpenCode's question tool (no TUI): the pick becomes the grant.
    if (valid && !denied && !sub && e.tool === 'question' && e.status === 'completed') await this.step('H20 question grant', undefined, () => { questionGrant(s.sid, e.input, e.result, now) })

    if (e.status !== 'completed') return
    const job = denied ? undefined : backgroundStart(e.tool, input, e.result, now)
    if (job !== undefined) (s.background ??= new Map()).set(job[0], job[1])
    const lsp = edit ? await lspEditNotes(cls.paths, this.cfg().checkers, { cwd, ask: this.lspEdits, log: (level, msg, data) => this.logFn(level, msg, data) }) : []
    const extra = [...new Set([...nudges, ...(verdict?.context !== undefined ? [verdict.context] : [])].map(n => n.trim()).filter(n => n !== ''))]
    if (r !== undefined && r.fileNotes.length > 0) extra.push(`Buracle checks (H04):\n\n${r.fileNotes.join('\n\n')}`)
    if (lsp.length > 0) extra.push(['Buracle language server diagnostics (H04):', ...lsp].join('\n\n'))
    if (r?.assets !== undefined) extra.push(r.assets)
    if (e.tool === 'subagent') {
      const note = this.reviewGate(input, e.result, reviewSubjects(HARNESS, s.sid))
      if (note !== undefined) extra.push(note)
    }
    if (extra.length === 0) return
    const add = extra.map(text => ({ type: 'text' as const, text }))
    const cur = e.result.content
    const base = typeof cur === 'string' ? [{ type: 'text' as const, text: cur }]
      : cur !== undefined && cur.length > 0 ? [...cur]
      : [{ type: 'text' as const, text: stringifyOutput(e.result.output) }]
    e.result = { ...e.result, content: [...base, ...add] }
  }

  private maskResult(e: Extract<ToolExecuteAfter, { status: 'completed' }>, kind: ToolKind): void {
    try {
      if (!this.cfg().guards.redact || !masksOpencodeTool(e.tool, kind)) return
      const r = maskedResult(e.result)
      if (r === undefined) return
      e.result = r.result
      this.logFn('info', maskNotice(r.count), { tool: e.tool })
    } catch (err) { this.logFn('warn', 'mask failed', { tool: e.tool, error: errText(err) }) }
  }

  private maskError(e: Extract<ToolExecuteAfter, { status: 'error' }>, kind: ToolKind): void {
    try {
      if (!this.cfg().guards.redact || !masksOpencodeTool(e.tool, kind)) return
      const count = maskedError(e.error)
      if (count > 0) this.logFn('info', maskNotice(count), { tool: e.tool, failed: true })
    } catch (err) { this.logFn('warn', 'mask failed', { tool: e.tool, error: errText(err) }) }
  }

  private noteReviews(s: SessionRuntime, messages: unknown): void {
    try {
      const noted = noteReviewMessages(messages, reviewSubjects(HARNESS, s.sid))
      if (noted.length > 0 && noted.length !== s.reviewNotes) this.logFn('info', 'H19: invalid review report', { agents: noted })
      s.reviewNotes = noted.length
    } catch (err) { this.logFn('warn', 'H19 review gate failed', { error: errText(err) }) }
  }

  private reviewGate(input: Record<string, unknown>, result: ToolResultShape, subject: readonly string[]): string | undefined {
    try {
      const report = subagentReport(input, result)
      if (report === undefined) return undefined
      const problems = reviewProblems(report, subject)
      if (problems.length === 0) return undefined
      const key = report.sessionID ?? report.agent
      const first = !this.reviewed.has(key)
      if (this.reviewed.size >= MAX_REVIEWED) this.reviewed.clear()
      this.reviewed.add(key)
      this.logFn('info', 'H19: invalid review report', { agent: report.agent, first })
      return reviewNote(report, problems, first)
    } catch (err) {
      this.logFn('warn', 'H19 review gate failed', { error: errText(err) })
      return undefined
    }
  }

  /** The capability card (H15) with the servers that are up for this session. */
  private capabilityText(sid: string): string {
    const health = this.health(sid)
    const mcp = this.baked.mcp.filter(m => !mcpUnavailable(health[m.id]))
    return capabilityCard({ policy: routingPolicy(this.actx()), mcp, skills: this.baked.skills, plugins: this.baked.plugins, harness: HARNESS })
  }

  /**
   * session.context runs before every model step and its system text does not persist, so each step gets the
   * session start's context again, then what only this step has: a saved plan draft, the context warning (H05) and
   * the context of the prompts this step delivers.
   */
  async onContext(e: SessionContextEvent): Promise<void> {
    const s = this.session(e.sessionID)
    if (isMemoryRunnerDir(this.cwdOf(s))) return
    s.activity = true
    if (typeof e.agent === 'string' && e.agent !== '') s.agent = e.agent
    const parts: string[] = []
    const draft = draftOnSwitch(s.draft ??= {}, e.agent)
    if (draft !== undefined) {
      const note = await this.saveDraft(s, draft)
      if (note !== undefined) parts.push(note)
    }
    await this.start(s)
    if (s.noticeOnce !== undefined) { parts.push(s.noticeOnce); delete s.noticeOnce }
    // The card follows the MCP servers' health from step to step, where the other harnesses show the one of the session start.
    const card = s.card === undefined ? undefined : await this.step('H15 capability card', s.card, () => this.capabilityText(s.sid))
    parts.push(...s.startContext.map(part => (part === s.card && card !== undefined ? card : part)).filter(part => part.trim() !== ''))
    const cfg = this.cfg()
    const watch = contextWatch(s.ctxWarned, s.ctx?.pct, cfg.context)
    if (watch.warned !== s.ctxWarned) {
      s.ctxWarned = watch.warned
      this.persist(s)
    }
    if (watch.warn !== undefined) parts.push(watch.warn)
    await this.deliverPrompts(s, e.messages, e.agent === OPENCODE_PLAN_AGENT)
    this.noteReviews(s, e.messages)
    parts.push(...s.pendingContext)
    for (const text of parts) e.system.push({ type: 'text', text })
  }

  private async saveDraft(s: SessionRuntime, plan: string): Promise<string | undefined> {
    try {
      const cwd = this.cwdOf(s)
      const saved = await captureSessionPlan({ plan, cwd, now: this.now(), harness: HARNESS, approved: false, sid: s.sid })
      if (saved === undefined) return undefined
      await this.spool(s, [{ ts: this.now(), ev: 'note', paths: [saved.path] }])
      return saved.note ?? draftNote(shownPath(saved.path, cwd))
    } catch (err) {
      this.logFn('warn', 'H12 plan draft failed', { sid: s.sid, error: errText(err) })
      return undefined
    }
  }

  private resumed(s: SessionRuntime): boolean {
    return s.createdAt !== undefined && s.createdAt <= this.startedAt - RESUME_AFTER_MS
  }

  /**
   * A prompt reaches the model on a later step (a queued one after the running turn), and several can arrive
   * together: their routes are merged and recorded in the ledger (H24) here, when they are delivered.
   */
  private async deliverPrompts(s: SessionRuntime, messages: unknown, readOnly: boolean): Promise<void> {
    await this.step('prompt delivery', undefined, () => {
      const taken = takeDelivered(s.pending, messages)
      if (taken.length === 0) return
      const delivered = deliveredPrompts(taken, compiledTriggers(this.baked), routingPolicy(this.actx()), readOnly)
      const route = delivered.route
      if (route !== undefined) updateLedger(HARNESS, s.sid, l => ledgerPrompt(l, route, this.now()))
      s.pendingContext = withinBudget(delivered.parts)
    })
  }

  async onCompaction(e: SessionCompactionEvent): Promise<void> {
    const s = this.session(e.sessionID)
    await this.touch(s)
    await this.step('compactInstructions', undefined, () => {
      const text = compactInstructions(undefined, loadState(HARNESS, s.sid))
      if (text.trim() !== '') e.system.push({ type: 'text', text })
    })
    if (!paths.isValidSessionId(s.sid) || await this.subagentSession(s)) return
    const now = this.now()
    await preCompact({ harness: HARNESS, sessionId: s.sid, cwd: this.cwdOf(s), now }, { ...this.deps(s), openTodos: () => s.todos ?? [], compact: compactStore(s.sid, now) })
  }

  async onPrompt(e: SessionPromptEvent): Promise<void> {
    const s = this.session(e.sessionID)
    await this.touch(s)
    const meta = asRecord(e.metadata)
    const text = typeof e.prompt?.text === 'string' ? e.prompt.text : ''
    // The stop guard's own continuation is not the user's prompt.
    if (meta[CONTINUE_MARK] === true || isGuardContinuation(text)) return
    s.userPrompts++
    resetChain(s.sid)
    if (!paths.isValidSessionId(s.sid) || await this.subagentSession(s)) return
    if (isMemoryRunnerDir(this.cwdOf(s))) return
    const at = this.now()
    if (!s.running) this.receipts.prompt(s.sid)
    const cmd = commandOfPrompt(meta, text)
    const words = cmd !== undefined ? cmd.args : text
    let routed: PromptRouteResult | undefined
    const r = await promptEvent({ harness: HARNESS, sessionId: s.sid, cwd: this.cwdOf(s), text: words, now: at }, {
      ...this.deps(s),
      routePrompt: async () => {
        routed = await this.routeWords(s, e, words, cmd?.command, at)
        return { route: routed.route, deferred: true, ...(routed.text !== undefined ? { text: routed.text } : {}) }
      },
      // The agent a prompt reaches and the step's context size are known when it is delivered: session.context adds both notes.
      readOnly: () => false,
      contextWarning: () => undefined,
    })
    const route = routed as PromptRouteResult | undefined
    const id = typeof e.messageID === 'string' && e.messageID !== '' ? e.messageID : undefined
    const at2 = route?.text !== undefined ? r.context.indexOf(route.text.trim()) : -1
    const pending: PendingPrompt = {
      id: id ?? `prompt-${s.userPrompts}`, delivery: id !== undefined && e.delivery === 'queue' ? 'queue' : 'steer', attach: route?.attach ?? [],
      before: at2 >= 0 ? r.context.slice(0, at2) : r.context, after: at2 >= 0 ? r.context.slice(at2 + 1) : [],
    }
    if (route !== undefined) pending.route = route.route
    if (route !== undefined && route.workflows.length > 0) pending.workflows = [...route.workflows]
    if (at2 >= 0) pending.text = r.context[at2] as string
    addPending(s.pending, pending)
  }

  private async routeWords(s: SessionRuntime, e: SessionPromptEvent, words: string, command: string | undefined, at: number): Promise<PromptRouteResult> {
    const attached = attachedSkills(e.prompt.skills)
    const deps = projectDeps(readWorkspace(this.actx(), HARNESS, s.sid)?.root)
    const route = routeUserPrompt({
      text: words,
      ...(command !== undefined ? { command } : {}),
      attached,
      loaded: Object.keys(loadLedger(HARNESS, s.sid).skills),
      available: availableServers(this.baked, this.health(s.sid)),
      ...(deps.length > 0 ? { deps } : {}),
      known: await this.knownSkills(this.cwdOf(s)),
    }, this.baked, this.cfg())
    if (route.attach.length > 0) e.prompt.skills = [...(Array.isArray(e.prompt.skills) ? e.prompt.skills : []), ...route.attach.map(id => ({ id }))]
    const title = runTitle(words)
    for (const workflow of route.workflows) {
      const source: FlowSource = workflow === command ? 'command' : 'prompt'
      recordFlowStart(HARNESS, s.sid, title !== undefined ? { workflow, title, source } : { workflow, source }, at)
    }
    return route
  }

  onShellCreate(e: ShellCreateBefore): void {
    e.env['BURACLE_HARNESS'] = HARNESS
    let sid: string | undefined
    let best = -1
    for (const c of this.calls.values()) {
      if ((c.tool === 'shell' || c.tool === 'bash') && str(asRecord(c.input)['command']) === e.command && c.at > best) { sid = c.sessionID; best = c.at }
    }
    if (sid !== undefined && paths.isValidSessionId(sid)) e.env['BURACLE_SESSION_ID'] = sid
    else e.env['BURACLE_SESSION_ID'] = undefined
    for (const k of SESSION_ENV_VARS) if (e.env[k] !== undefined) e.env[k] = undefined
    if ((e.env['BURACLE_HOME'] === undefined || e.env['BURACLE_HOME'] === '') && this.env.source !== 'default') e.env['BURACLE_HOME'] = this.env.buracleHome
  }

  async handleEvent(e: OpenCodeEvent): Promise<void> {
    const data = asRecord(e.data)
    const sid = str(data['sessionID'])
    if (e.type === 'model.updated') { this.models.invalidate(); return }
    if (sid === undefined) return
    switch (e.type) {
      case 'session.created': {
        const s = this.session(sid)
        const loc = asRecord(data['location'])
        const dir = str(loc['directory'])
        const sub = str(data['subpath'])
        if (dir !== undefined) s.cwd = sub !== undefined && sub !== '' ? join(dir, sub) : dir
        if (isMemoryRunnerDir(this.cwdOf(s))) s.capture = false
        const parent = str(data['parentID'])
        s.parentID = parent ?? null
        if (s.parentID === null) void this.touch(s)
        return
      }
      case 'session.skill.activated': {
        const id = str(data['id'])
        if (id === undefined || !paths.isValidSessionId(sid)) return
        const s = this.session(sid)
        await this.start(s)
        const call: ToolCall = { harness: HARNESS, sessionId: sid, cwd: this.cwdOf(s), tool: 'skill', kind: 'other', input: { id }, paths: [] }
        await this.step('H24 ledger', undefined, () => { updateLedger(HARNESS, sid, l => ledgerCall(l, call)) })
        await this.skillLoaded(s, id, this.now())
        return
      }
      case 'session.step.started': {
        const model = asRecord(data['model'])
        const id = str(model['id'])
        const providerID = str(model['providerID'])
        if (id !== undefined && providerID !== undefined) {
          const ref: ModelRef = { id, providerID }
          const variant = str(model['variant'])
          if (variant !== undefined) ref.variant = variant
          this.session(sid).model = ref
        }
        return
      }
      case 'session.step.ended': {
        const s = this.session(sid)
        const total = tokenTotal(data['tokens'])
        if (total === undefined || total <= 0) return
        s.lastTokens = total
        const window = s.model !== undefined ? await this.models.limit(s.model) : undefined
        if (window !== undefined && window > 0) s.ctx = { pct: Math.round((total / window) * 1000) / 10, tokens: total, window }
        await this.telemetry(s)
        return
      }
      case 'session.usage.updated': {
        const s = this.session(sid)
        const cost = num(data['cost'])
        if (cost !== undefined) s.costUsd = cost
        await this.telemetry(s)
        return
      }
      case 'session.text.ended': {
        const text = str(data['text'])
        if (text !== undefined && text.trim() !== '') {
          const s = this.session(sid)
          s.lastAssistantText = text
          notePlanText(s.draft ??= {}, text)
        }
        return
      }
      case 'session.synthetic': {
        const key = backgroundEnd(data['metadata'])
        if (key !== undefined) this.sessions.get(sid)?.background?.delete(key)
        return
      }
      case 'session.inbox.delivered':
      case 'session.inbox.cancelled':
      case 'session.inbox.delivery.changed': {
        const id = str(data['inboxID'])
        const s = this.sessions.get(sid)
        if (id !== undefined && s !== undefined) inboxUpdate(s.pending, e.type, id, data['delivery'])
        return
      }
      case 'session.execution.started': {
        const s = this.session(sid)
        s.gen++
        s.running = true
        this.cancelIdleFinalize(s)
        return
      }
      // OpenCode's stop: the turn's spool entry and receipt, then the stop guard (which runs the pipeline's stop).
      case 'session.execution.succeeded':
      case 'session.idle': {
        const s = this.session(sid)
        s.running = false
        if (typeof s.parentID === 'string') this.sessions.get(s.parentID)?.background?.delete(`subagent:${sid}`)
        if (s.handledGen === s.gen) return
        s.handledGen = s.gen
        this.turnSpool(s)
        this.track(this.turnEnded(s))
        this.scheduleIdleFinalize(s)
        const claim = e.id !== undefined && e.id !== '' ? `${s.sid}:${e.id}` : undefined
        this.track(this.checkContinuation(s.sid, { gen: s.gen, interrupts: s.interrupts, failures: s.failures, userPrompts: s.userPrompts }, claim))
        return
      }
      case 'session.execution.interrupted': {
        const s = this.session(sid)
        s.running = false
        s.interrupts++
        resetChain(sid)
        this.track(this.turnEnded(s))
        return
      }
      case 'session.execution.failed': {
        const s = this.session(sid)
        s.running = false
        s.failures++
        this.track(this.turnEnded(s))
        return
      }
      case 'session.compaction.ended': {
        const s = this.session(sid)
        const text = str(data['text'])
        if (text !== undefined && text.trim() !== '') await this.spoolOwn(s, [{ ts: this.now(), ev: 'compact', excerpt: text.slice(0, 8000) }])
        // The next step starts the session again with the source `compact`: the restore note and a fresh memory index.
        s.compacted = true
        s.starting = undefined
        return
      }
      case 'session.deleted': {
        const s = this.sessions.get(sid)
        this.cancelIdleFinalize(s)
        this.sessions.delete(sid)
        this.receipts.forget(sid)
        registry().chains.delete(sid)
        if (s !== undefined && s.parentID !== null && s.parentID !== undefined) return
        if (s !== undefined) await this.end(s, s.capture)
        else await this.end(this.detached(sid), this.captureNow())
        return
      }
      default:
        return
    }
  }

  /** A session this plugin never saw, for an event that only names it. */
  private detached(sid: string): SessionRuntime {
    const s = this.session(sid)
    this.sessions.delete(sid)
    return s
  }

  private turnSpool(s: SessionRuntime): void {
    const entry: SpoolEntry = { ts: this.now(), ev: 'turn' }
    if (s.lastAssistantText !== undefined) entry.excerpt = s.lastAssistantText.slice(0, 2000)
    if (s.model !== undefined) entry.model = `${s.model.providerID}/${s.model.id}`
    if (s.lastTokens !== undefined) entry.tokens = s.lastTokens
    this.track(this.spoolOwn(s, [entry]))
  }

  private async telemetry(s: SessionRuntime): Promise<void> {
    if (!paths.isValidSessionId(s.sid) || await this.subagentSession(s)) return
    try {
      const t: Parameters<typeof writeTelemetry>[2] = { at: this.now(), cwd: this.cwdOf(s) }
      if (s.model !== undefined) { t.model = `${s.model.providerID}/${s.model.id}`; t.modelId = t.model }
      const effort = this.models.effortOf(s.model)
      if (effort !== undefined) t.effort = effort
      if (s.ctx !== undefined) t.ctx = { pct: s.ctx.pct, tokens: s.ctx.tokens, window: s.ctx.window }
      if (s.costUsd !== undefined) t.costUsd = s.costUsd
      if (s.windows !== undefined) t.windows = s.windows
      if (s.windowsAt !== undefined) t.windowsAt = s.windowsAt
      writeTelemetry(HARNESS, s.sid, t)
    } catch (e) { this.logFn('warn', 'telemetry write failed', { sid: s.sid, error: errText(e) }) }
  }

  private async resolveParent(s: SessionRuntime): Promise<void> {
    if (s.parentID !== undefined) return
    try {
      const res = asRecord(await this.ctx.session.get({ sessionID: s.sid }))
      const info = res['data'] !== undefined ? asRecord(res['data']) : res
      s.parentID = str(info['parentID']) ?? null
      const loc = asRecord(info['location'])
      if (s.cwd === undefined && str(loc['directory']) !== undefined) s.cwd = str(loc['directory'])
      const created = num(asRecord(info['time'])['created'])
      if (created !== undefined) s.createdAt = created
    } catch {
      s.parentID = null
    }
  }

  checkContinuation(sid: string, at: StopSnapshot, claim?: string): Promise<void> {
    return this.stopGuard.check(sid, at, claim)
  }
}

export function createBuraclePlugin(deps: PluginDeps): ServerPluginDefinition {
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const rt = new BuracleRuntime(ctx, deps)
      await rt.register()
      await rt.registerTransforms()
      rt.startEvents()
      rt.scheduleMaintenance()
      rt.scheduleWorkspace()
      rt.checkProfile()
      return () => rt.dispose()
    },
  }
}
