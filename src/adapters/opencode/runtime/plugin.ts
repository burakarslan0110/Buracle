import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { BuracleConfig } from '../../../core/config'
import { MEMORY_INJECT } from '../../../core/memory/budgets'
import { spoolPromptExcerpt } from '../../../core/memory/spool'
import type { HookId, PreDecision, ToolCall, ToolKind } from '../../../core/events'
import { classifyTool } from '../../../core/events'
import { bandSummary } from '../../../core/flow/band'
import { flowDef } from '../../../core/flow/catalog'
import type { FlowSource } from '../../../core/flow/record'
import { capabilityCard, checkBash, checkQuestion, checkWrite, isGuardContinuation, laneStateDenial, reviewerShellDenial, routeTool, skillOf } from '../../../core/policy/index'
import type { BashGuardOptions } from '../../../core/policy/bash-guard'
import { mcpWritePaths } from '../../../core/policy/mcp-paths'
import type { McpHealth } from '../../../core/policy/routing'
import type { ReminderContext } from '../../../core/policy/usage'
import { ledgerOnce } from '../../../core/policy/usage'
import type { WriteGuardContext } from '../../../core/policy/write-guard'
import type { SessionState } from '../../../core/plan/index'
import { compactInstructions, handoffNote, restoreContext } from '../../../core/compact'
import type { WorkspaceInfo } from '../../../core/workspace'
import { workspaceContext, workspaceNotice } from '../../../core/workspace'
import { contextWarning, contextWatch, type ContextBand } from '../../../core/status/context'
import type { RateWindow } from '../../../core/status/model'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../../engine/fsx'
import { currentBranch } from '../../../engine/git'
import { log } from '../../../engine/log'
import { editDiagnostics } from '../../../engine/toolchain/lsp-edits'
import * as paths from '../../../engine/paths'
import { run } from '../../../engine/proc'
import { isMemoryRunnerDir } from '../../../memory/spawn'
import { flowViewFor, recordFlowStart } from '../../../workflow/flow'
import { shownPath } from '../../../workflow/plan-capture'
import { captureSessionPlan } from '../../../workflow/plan-native'
import { loadState, reviewSubjects, sessionMaint, writeTelemetry } from '../../../workflow/session-store'
import { refreshWorkspaceInfo, workspaceInfo } from '../../../workflow/workspace'
import { consentGate, recordPromptGrants } from '../../shared/consent-store'
import { pathRuleSource } from '../../shared/path-rules'
import { realWriteTarget } from '../../shared/realpath'
import { reviewNotesNotice } from '../../shared/review-notes'
import { selfPaths } from '../../shared/self-paths'
import { maskNotice } from '../../shared/tool-output-mask'
import { prepareWorkspace } from '../../shared/workspace-start'
import { assetsAfterEdit, assetsContextCached, assetsOptions, startLinkRun, type AssetsSpawner } from '../../shared/project-assets'
import { CONFIG_PARSERS, guardedContents, opencodeChanges } from '../../shared/write-content'
import { buracleRepoFor } from './adapter-rules'
import { backgroundEnd, backgroundStart, type BackgroundJob } from './background'
import type { BakedData } from './baked'
import { hookFailure } from './baked'
import type { CheckerRunner, LspEditAsk } from './checks'
import { fileChecks, lspEditNotes } from './checks'
import { registerWorkflowCommands } from './commands'
import type { PendingPrompt } from './delivery'
import { addPending, deliveredPrompts, inboxUpdate, takeDelivered } from './delivery'
import { projectDeps } from './deps'
import { registerEffort } from './effort'
import type { ResolvedEnv } from './env'
import { applyEnv, healthCache, resolveEnv, runtimeConfigCache } from './env'
import { answerHeld, type ConsentAskHost, type HeldCall } from './consent-ask'
import { questionGrant } from './consent-question'
import { earlyEditNote } from './early-edit'
import type { StopSnapshot } from './guard'
import { CONTINUE_MARK, denyMessage, promptPlanInteraction, recordAnswer, registry, resetChain, shimNotify, StopGuard } from './guard'
import { maskedError, maskedResult, masksOpencodeTool } from './mask'
import { postNotice } from './notice-board'
import { registerRateWindows } from './rate-windows'
import { TurnReceipts } from './receipt'
import type { MemoryBridge, SpoolEntry } from './memory-bridge'
import { draftNote, draftOnSwitch, notePlanText, type PlanDraftState } from './plan-draft'
import { reviewNote, reviewProblems, subagentReport } from './review'
import type { CallVerdict, LedgerStore, PromptRouteResult } from './routing'
import {
  attachedSkills, availableServers, commandOfPrompt, compiledTriggers, evaluateCall, fileLedgerStore, ledgerUserPrompt, loadedSkills,
  promptSignalEntries, recordCall, recordMcpResult, routeInputText, routeUserPrompt, runTitle, sessionHealth, withinBudget,
} from './routing'
import type {
  ModelRef, OpenCodeEvent, PermissionEvaluation, ServerContext, ServerPluginDefinition, SessionCompactionEvent,
  SessionContextEvent, SessionPromptEvent, ShellCreateBefore, ToolExecuteAfter, ToolExecuteBefore, ToolResultShape,
} from './types'
import { ModelFacts } from './models'
import { openingNotice } from './notices'
import { actionMatchesTool, asRecord, errText, num, skillIdsOf, str, stringifyOutput, tokenTotal, within } from './util'
import type { WorkspaceFn } from './workspace'
import { prepareOnce, profileWarning, workspaceFacts } from './workspace'

export { CONTINUE_MARK, continuationText, REGISTRY_KEY, runawayNotice } from './guard'

export const PLUGIN_ID = 'buracle'
const HARNESS = 'opencode' as const

export const MAINT_INTERVAL_MS = 6 * 60 * 60_000
const WORKSPACE_WAIT_MS = 1500
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
  notify?: (title: string, message: string) => void
  workspace?: WorkspaceFn
  workspaceRead?: WorkspaceFn
  ledger?: LedgerStore
  assetsSpawn?: AssetsSpawner
  consentAsk?: Partial<ConsentAskHost>
}

interface PendingCall { tool: string; input: unknown; sessionID: string; at: number; denied?: boolean }

interface Denial { reason: string; hook: HookId }

const RESUME_AFTER_MS = 60_000

interface SessionRuntime {
  sid: string
  cwd?: string
  parentID?: string | null
  createdAt?: number
  capture: boolean
  started: boolean
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
  memoryIndex?: string | null
  memoryIndexLoading?: Promise<void>
  workspace?: WorkspaceInfo
  workspaceLoading?: Promise<WorkspaceInfo | undefined>
  workspaceSeen?: WorkspaceInfo
  compacted: boolean
  handoffPath?: string
  noticesChecked?: boolean
  pendingContext: string[]
  pending: PendingPrompt[]
  persistedLoaded: boolean
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

export class BuracleRuntime {
  readonly env: ResolvedEnv
  private readonly baked: BakedData
  private readonly memory: MemoryBridge
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
  private readonly notifyFn: NonNullable<PluginDeps['notify']>
  private readonly ledger: LedgerStore
  private readonly stopGuard: StopGuard
  private readonly receipts: TurnReceipts
  private readonly config: ReturnType<typeof runtimeConfigCache>
  private readonly health = healthCache(() => this.now())
  private readonly sessions = new Map<string, SessionRuntime>()
  private readonly calls = new Map<string, PendingCall>()
  private readonly nudges = new Map<string, string[]>()
  private readonly verdicts = new Map<string, CallVerdict>()
  private readonly consentHeld = new WeakMap<PermissionEvaluation, HeldCall>()
  private readonly consentHost: ConsentAskHost
  private readonly skillLists = new Map<string, { at: number, ids: Promise<ReadonlySet<string> | undefined> }>()
  private readonly reviewed = new Set<string>()
  private readonly tasks = new Set<Promise<unknown>>()
  private readonly abort = new AbortController()
  private card: { key: string, text: string | undefined } | undefined
  private readonly models: ModelFacts
  private readonly startedAt: number
  private disposed = false

  constructor(private readonly ctx: ServerContext, deps: PluginDeps) {
    this.baked = deps.baked
    this.consentHost = { now: () => this.now(), sleep: ms => new Promise(r => setTimeout(r, ms)), newId: () => crypto.randomUUID(), ...deps.consentAsk }
    this.memory = deps.memory
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
    this.notifyFn = deps.notify ?? shimNotify
    this.ledger = deps.ledger ?? fileLedgerStore()
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
      spool: (sid, entries) => this.spool(sid, entries),
      notify: (title, message) => this.notifyFn(title, message),
      log: (level, msg, data) => this.logFn(level, msg, data),
      ledger: this.ledger,
    }, deps.settleMs ?? 1500)
    this.receipts = new TurnReceipts({
      now: () => this.now(),
      post: (sid, text, variant) => { try { postNotice(sid, text, variant, this.now()) } catch (e) { this.logFn('warn', 'notice not posted', { sid, error: errText(e) }) } },
      notify: (title, message) => this.notifyFn(title, message),
      run: sid => bandSummary(flowViewFor(HARNESS, sid, this.now(), this.cfg().workflow.foldAfterSec)),
      log: (msg, data) => this.logFn('debug', msg, data),
    })
  }

  private cfg(): BuracleConfig {
    return this.config.get().config
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
      s = { sid, capture: this.captureNow() && !isMemoryRunnerDir(this.ctx.location.directory), started: false, activity: false, gen: 0, running: false, handledGen: -1, interrupts: 0, failures: 0, userPrompts: 0, compacted: false, pendingContext: [], pending: [], persistedLoaded: false }
      this.sessions.set(sid, s)
    }
    if (!s.persistedLoaded) {
      s.persistedLoaded = true
      const saved = this.readPersisted(sid)
      if (saved !== undefined) {
        s.compacted = saved.compacted === true
        if (typeof saved.handoffPath === 'string') s.handoffPath = saved.handoffPath
        if (saved.ctxWarned === 'ok' || saved.ctxWarned === 'warn' || saved.ctxWarned === 'critical') s.ctxWarned = saved.ctxWarned
      }
    }
    return s
  }

  private persistFile(sid: string): string {
    return join(paths.sessionDir(HARNESS, sid), 'opencode.json')
  }

  private readPersisted(sid: string): { compacted?: boolean, handoffPath?: string, ctxWarned?: unknown } | undefined {
    try {
      const r = readJsonSafeSync<{ compacted?: boolean, handoffPath?: string, ctxWarned?: unknown }>(this.persistFile(sid))
      return r.ok ? r.value : undefined
    } catch { return undefined }
  }

  private persist(s: SessionRuntime): void {
    try {
      const data: Record<string, unknown> = { v: 1, compacted: s.compacted }
      if (s.handoffPath !== undefined) data['handoffPath'] = s.handoffPath
      if (s.ctxWarned !== undefined) data['ctxWarned'] = s.ctxWarned
      ensureDirSync(paths.sessionDir(HARNESS, s.sid))
      atomicWriteSync(this.persistFile(s.sid), JSON.stringify(data) + '\n')
    } catch (e) { this.logFn('warn', 'could not persist session data', { sid: s.sid, error: errText(e) }) }
  }

  private cwdOf(s: SessionRuntime): string {
    return s.cwd ?? this.ctx.location.directory
  }

  private isSubagent(s: SessionRuntime): boolean {
    return typeof s.parentID === 'string'
  }

  private async subagentSession(sid: string): Promise<boolean> {
    const s = this.session(sid)
    if (s.parentID === undefined) await this.resolveParent(s)
    return this.isSubagent(s)
  }

  private spool(sid: string, entries: SpoolEntry[]): void {
    if (entries.length === 0 || !paths.isValidSessionId(sid)) return
    if (!this.session(sid).capture) return
    try {
      const r = this.memory.append(sid, entries)
      if (r instanceof Promise) this.track(r.catch(e => this.logFn('warn', 'spool append failed', { sid, error: errText(e) })))
    } catch (e) { this.logFn('warn', 'spool append failed', { sid, error: errText(e) }) }
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
    if (s.parentID === undefined) await this.resolveParent(s)
    if (!this.isSubagent(s)) this.spool(s.sid, entries)
  }

  private scheduleIdleFinalize(s: SessionRuntime): void {
    if (this.idleFinalizeMs <= 0 || this.disposed || !paths.isValidSessionId(s.sid)) return
    if (s.idleTimer !== undefined) clearTimeout(s.idleTimer)
    const gen = s.gen
    s.idleTimer = setTimeout(() => {
      s.idleTimer = undefined
      if (this.disposed || s.running || s.gen !== gen || this.sessions.get(s.sid) !== s) return
      this.track((async () => {
        if (s.parentID === undefined) await this.resolveParent(s)
        if (this.isSubagent(s) || !s.activity) return
        await this.finalize(s.sid, s)
      })().catch(e => this.logFn('warn', 'idle finalize failed', { sid: s.sid, error: errText(e) })))
    }, this.idleFinalizeMs)
    s.idleTimer.unref?.()
  }

  private cancelIdleFinalize(s: SessionRuntime | undefined): void {
    if (s?.idleTimer === undefined) return
    clearTimeout(s.idleTimer)
    s.idleTimer = undefined
  }

  private async finalize(sid: string, s: SessionRuntime | undefined): Promise<void> {
    if (!paths.isValidSessionId(sid)) return
    if (!(s?.capture ?? this.captureNow())) return
    try { await this.memory.finalize(sid) } catch (e) { this.logFn('warn', 'finalizer spawn failed', { sid, error: errText(e) }) }
  }

  private touch(s: SessionRuntime): void {
    s.activity = true
    if (s.started || typeof s.parentID === 'string' || !paths.isValidSessionId(s.sid)) return
    s.started = true
    if (isMemoryRunnerDir(this.cwdOf(s))) s.capture = false
    if (!s.capture) return
    this.track((async () => {
      try {
        if (s.parentID === undefined) await this.resolveParent(s)
        if (s.parentID !== null) return
        await this.memory.start(s.sid, this.cwdOf(s))
      } catch (e) { this.logFn('warn', 'memory session start failed', { sid: s.sid, error: errText(e) }) }
    })())
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

  private async turnEnded(s: SessionRuntime, outcome: 'succeeded' | 'failed' | 'interrupted' = 'succeeded'): Promise<void> {
    if (s.parentID === undefined) await this.resolveParent(s)
    if (s.parentID === null) this.receipts.end(s.sid, outcome === 'succeeded' ? s.lastAssistantText ?? '' : '', this.cfg(), outcome !== 'interrupted')
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
    try {
      const ok = await registerEffort(this.ctx, () => this.cfg(), (level, touched) => {
        this.models.effortApplied(level, touched)
        this.logFn('debug', 'default effort applied', { level, models: touched.length })
      }, e => this.logFn('warn', 'effort transform failed', { error: errText(e) }))
      if (!ok) this.logFn('info', 'this OpenCode has no model transform; effort.opencode is not applied')
    } catch (e) { this.logFn('warn', 'effort transform not registered', { error: errText(e) }) }
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
      if (!s.activity || typeof s.parentID === 'string') continue
      await this.finalize(s.sid, s)
    }
    this.sessions.clear()
    this.calls.clear()
    this.nudges.clear()
    this.verdicts.clear()
  }

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

  scheduleMaintenance(): void {
    this.track(new Promise<void>(res => { setTimeout(res, 0) }).then(() => this.runMaintenance()))
  }

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

  checkProfile(): void {
    try {
      const warning = profileWarning(this.pluginDir, this.config.get(), this.env.home)
      if (warning === undefined) return
      const reg = registry() as ReturnType<typeof registry> & { profileWarned?: boolean }
      if (reg.profileWarned === true) return
      reg.profileWarned = true
      this.logFn('warn', warning)
      this.notifyFn('Buracle', warning)
    } catch (e) {
      this.logFn('debug', 'profile guard failed', { error: errText(e) })
    }
  }

  private ensureWorkspace(s: SessionRuntime): Promise<WorkspaceInfo | undefined> {
    if (s.workspaceLoading !== undefined) return s.workspaceLoading
    const cwd = this.cwdOf(s)
    const cfg = this.cfg()
    const now = this.now()
    const p = (this.isSubagent(s) ? this.workspaceRead(cwd, cfg, now) : prepareOnce(cwd, cfg, now, this.workspaceFn))
      .then(info => {
        s.workspace ??= info
        s.workspaceSeen ??= info
        return s.workspace
      }, (e: unknown) => {
        this.logFn('warn', 'workspace facts unavailable', { sid: s.sid, error: errText(e) })
        return undefined
      })
    s.workspaceLoading = p
    this.track(p)
    return p
  }

  private workspaceOf(s: SessionRuntime): Promise<WorkspaceInfo | undefined> {
    if (s.workspace !== undefined) return Promise.resolve(s.workspace)
    return within(this.ensureWorkspace(s), WORKSPACE_WAIT_MS, undefined)
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

  private sessionHealth(sid: string | undefined): McpHealth {
    const health = this.health.get()
    return sid !== undefined && paths.isValidSessionId(sid) ? sessionHealth(this.ledger, sid, health) : health
  }

  private reminderContext(s: SessionRuntime, call: ToolCall, cfg: BuracleConfig): ReminderContext {
    const info = s.workspace
    const ctx: ReminderContext = {
      strictness: cfg.routing.strictness,
      reminders: cfg.routing.reminders,
      available: availableServers(this.baked, this.sessionHealth(s.sid)),
      policy: { ...this.baked.routing, strictness: cfg.routing.strictness },
      facts: workspaceFacts(info, cfg, this.env.home),
    }
    const deps = projectDeps(info?.root)
    if (deps.length > 0) ctx.deps = deps
    const read = call.kind === 'read' && call.paths.length > 0 && call.paths.every(p => existsSync(p))
    const rules = pathRuleSource(this.baked.pathRules, join(this.env.buracleHome, 'rules', 'paths'), { onRead: read, home: this.env.home })
    if (rules !== undefined) ctx.pathRules = rules
    if (call.kind === 'write') {
      const edit = this.wholeFileEdit(call)
      if (edit !== undefined) ctx.edits = [edit]
    }
    return ctx
  }

  private async skillLoaded(s: SessionRuntime, id: string, now: number): Promise<void> {
    if (!paths.isValidSessionId(s.sid)) return
    if (s.parentID === undefined) await this.resolveParent(s)
    if (this.isSubagent(s)) return
    if (flowDef(id) !== undefined) recordFlowStart(HARNESS, s.sid, { workflow: id, source: 'skill' }, now)
  }

  onToolBefore(e: ToolExecuteBefore): void {
    this.prunePending()
    const pending: PendingCall = { tool: e.tool, input: e.input, sessionID: e.sessionID, at: this.now() }
    this.calls.set(e.id, pending)
    const s = this.session(e.sessionID)
    this.touch(s)
    if (typeof e.agent === 'string' && e.agent !== '') s.agent = e.agent
    if (!paths.isValidSessionId(e.sessionID)) return
    if (s.workspace === undefined) void this.ensureWorkspace(s)
    const call = this.callOf(e.tool, e.input, e.sessionID)
    const verdict = evaluateCall(this.ledger, e.sessionID, call, this.reminderContext(s, call, this.cfg()))
    if (verdict.deny !== undefined || verdict.context !== undefined) this.verdicts.set(e.id, verdict)
    const skill = skillOf(call, HARNESS)
    if (skill !== undefined && verdict.deny === undefined) this.track(this.skillLoaded(s, skill, this.now()))
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

  writeContext(cwd: string, cfg: BuracleConfig): WriteGuardContext {
    const ctx: WriteGuardContext & { realpath?: (p: string) => string | undefined } = {
      cwd, home: this.env.home, vault: paths.oldVaultRoot(), protect: cfg.guards.write.protect, realpath: realWriteTarget, selfPaths: selfPaths(cfg.repo),
      parsers: CONFIG_PARSERS,
    }
    const repo = buracleRepoFor(cwd, this.configuredRepos(), this.now())
    if (repo !== undefined) ctx.buracleRepo = repo
    return ctx
  }

  bashOptions(cwd: string, cfg: BuracleConfig): BashGuardOptions {
    const o: BashGuardOptions = {
      ...cfg.guards.bash, home: this.env.home, selfPaths: selfPaths(cfg.repo), cwd,
      vault: paths.oldVaultRoot(), protect: cfg.guards.write.protect, realpath: realWriteTarget,
    }
    const repo = buracleRepoFor(cwd, this.configuredRepos(), this.now())
    if (repo !== undefined) o.buracleRepo = repo
    return o
  }

  private writeVerdict(call: ToolCall, cfg: BuracleConfig): { deny?: string } {
    const wctx = this.writeContext(call.cwd, cfg)
    const changes = opencodeChanges(call.tool, call.input, call.paths, call.cwd, this.env.home)
    const contents = guardedContents(changes, call.paths, wctx.home, { realpath: realWriteTarget })
    return checkWrite(call.paths, Object.keys(contents).length > 0 ? { ...wctx, contents } : wctx)
  }

  private mcpWriteVerdict(call: ToolCall, cfg: BuracleConfig): { deny?: string } {
    if (call.kind !== 'mcp') return {}
    const targets = mcpWritePaths(call.tool, call.input, call.mcp)
    return targets.length > 0 ? checkWrite(targets, this.writeContext(call.cwd, cfg)) : {}
  }

  private guard(id: HookId, fn: () => { deny?: string } | undefined): { reason: string, hook: HookId } | undefined {
    try {
      const r = fn()
      return r?.deny !== undefined && r.deny !== '' ? { reason: r.deny, hook: id } : undefined
    } catch (e) {
      const msg = errText(e)
      this.logFn('error', `${id} guard failed`, { error: msg })
      if (hookFailure(this.baked, id) === 'closed') {
        return { reason: `the guard could not evaluate this call (${msg}), so it was blocked to stay safe. Run \`buracle doctor opencode\`.`, hook: id }
      }
      return undefined
    }
  }

  private denyCall(e: PermissionEvaluation, denied: Denial, sid: string, tool: string): void {
    e.effect = 'deny'
    e.message = denyMessage(denied.hook, denied.reason)
    const pending = e.source?.type === 'tool' ? this.calls.get(e.source.id) : undefined
    if (pending !== undefined) pending.denied = true
    this.logFn('info', 'denied tool call', { sid, hook: denied.hook, tool })
  }

  async evaluate(e: PermissionEvaluation): Promise<void> {
    this.onEvaluate(e)
    const held = this.consentHeld.get(e)
    this.consentHeld.delete(e)
    if (held === undefined || !await answerHeld(e, held, { host: this.consentHost, isSubagent: sid => this.subagentSession(sid) })) return
    const pending = e.source?.type === 'tool' ? this.calls.get(e.source.id) : undefined
    if (pending !== undefined) pending.denied = false
    this.onEvaluate(e)
  }

  onEvaluate(e: PermissionEvaluation): void {
    if (e.effect === 'deny') return
    const before = e.effect
    const call = this.buildCall(e)
    if (call === undefined) return
    const cfg = this.cfg()
    let denied: Denial | undefined
    if (call.kind === 'bash') {
      const command = call.command ?? ''
      if (command !== '') denied = this.guard('H01', () => checkBash(command, this.bashOptions(call.cwd, cfg)))
      if (denied === undefined && command !== '' && typeof this.sessions.get(call.sessionId)?.parentID === 'string') {
        denied = this.guard('H01', () => { const lane = laneStateDenial(command); return lane !== undefined ? { deny: lane } : undefined })
      }
      if (denied === undefined && command !== '') denied = this.guard('H01', () => ({ deny: reviewerShellDenial(e.agent, command) }))
      if (denied === undefined && command !== '' && paths.isValidSessionId(call.sessionId)) {
        denied = this.guard('H20', () => {
          const reason = consentGate(HARNESS, call.sessionId, command, this.now())
          return reason !== undefined ? { deny: reason } : undefined
        })
        if (denied?.hook === 'H20') this.consentHeld.set(e, { sid: call.sessionId, command, effect: before })
      }
    }
    if (denied === undefined && (call.kind === 'edit' || call.kind === 'write' || call.kind === 'patch') && call.paths.length > 0) {
      denied = this.guard('H02', () => this.writeVerdict(call, cfg))
    }
    if (denied === undefined && call.kind === 'mcp') denied = this.guard('H02', () => this.mcpWriteVerdict(call, cfg))
    if (denied === undefined && call.kind === 'ask_user') {
      let question: { deny?: string, context?: string } | undefined
      denied = this.guard('H09', () => (question = checkQuestion(loadState(HARNESS, call.sessionId), call, this.now())))
      const note = (question as { context?: string } | undefined)?.context
      if (denied === undefined && note !== undefined && e.source?.type === 'tool' && typeof this.sessions.get(call.sessionId)?.parentID !== 'string') {
        this.nudges.set(e.source.id, [...(this.nudges.get(e.source.id) ?? []), note])
      }
    }
    if (denied === undefined && cfg.routing.strictness !== 'off') {
      let decision: PreDecision | undefined
      denied = this.guard('H03', () => {
        decision = routeTool(call, { ...this.baked.routing, strictness: cfg.routing.strictness }, this.sessionHealth(call.sessionId))
        return decision.action === 'deny' ? { deny: decision.reason } : undefined
      })
      const d = decision as PreDecision | undefined
      if (denied === undefined && d !== undefined && d.action === 'allow' && d.context !== undefined && d.context.length > 0 && e.source?.type === 'tool') {
        this.nudges.set(e.source.id, [...(this.nudges.get(e.source.id) ?? []), ...d.context])
      }
    }
    if (denied === undefined && e.source?.type === 'tool') {
      const gate = this.verdicts.get(e.source.id)?.deny
      if (gate !== undefined) denied = { reason: gate, hook: 'H03' }
    }
    if (denied === undefined && (call.kind === 'edit' || call.kind === 'write' || call.kind === 'patch') && e.source?.type === 'tool') {
      const id = e.source.id
      earlyEditNote(call, cfg.plan.planApproval, note => this.nudges.set(id, [...(this.nudges.get(id) ?? []), note]), err => this.logFn('warn', 'early edit note failed', { error: errText(err) }))
    }
    if (denied !== undefined) this.denyCall(e, denied, call.sessionId, call.tool)
  }

  async onToolAfter(e: ToolExecuteAfter): Promise<void> {
    const pending = this.calls.get(e.id)
    this.calls.delete(e.id)
    const nudges = this.nudges.get(e.id) ?? []
    this.nudges.delete(e.id)
    const verdict = this.verdicts.get(e.id)
    this.verdicts.delete(e.id)
    const s = this.session(e.sessionID)
    this.touch(s)
    const cwd = this.ctx.location.directory
    const input = asRecord(e.input)
    const cls = classifyTool(HARNESS, e.tool, input, cwd, this.baked.mcpIds, { homeTilde: this.env.home })
    const ms = pending !== undefined ? Math.max(0, this.now() - pending.at) : undefined

    let entry: SpoolEntry | undefined
    if (cls.kind === 'edit' || cls.kind === 'write' || cls.kind === 'patch' || cls.kind === 'bash') {
      entry = { ts: this.now(), ev: 'tool', tool: e.tool, kind: cls.kind }
      if (cls.paths.length > 0) entry.paths = cls.paths
      if (cls.command !== undefined) entry.cmd = cls.command
      if (ms !== undefined) entry.ms = ms
      if (e.status === 'completed') {
        const exit = num(asRecord(e.result.output)['exit'])
        if (exit !== undefined) entry.exit = exit
      } else entry.exit = -1
    } else if (cls.kind === 'mcp' || cls.kind === 'web_search' || cls.kind === 'web_fetch' || e.tool === 'skill') {
      entry = { ts: this.now(), ev: 'tool', tool: e.tool, kind: cls.kind }
      if (ms !== undefined) entry.ms = ms
      if (e.status !== 'completed') entry.exit = -1
    }
    if (entry !== undefined) {
      const root = await this.rootOf(s)
      if (root !== undefined) {
        if (root !== s) this.touch(root)
        this.spool(root.sid, [entry])
      }
    }
    const denied = verdict?.deny !== undefined || pending?.denied === true
    if (!denied && s.parentID === null) this.receipts.tool(s.sid, e, { kind: cls.kind, paths: cls.paths, cwd, home: this.env.home, ...(cls.command !== undefined ? { command: cls.command } : {}) })
    const server = cls.kind === 'mcp' ? cls.mcp?.server : undefined
    if (server !== undefined && !denied && paths.isValidSessionId(e.sessionID)) recordMcpResult(this.ledger, e.sessionID, server, e.status === 'completed')
    if (e.status === 'completed') this.maskResult(e, cls.kind)
    else this.maskError(e, cls.kind)
    if (!denied && e.tool === 'question' && e.status === 'completed') await this.answerReceipt(s, e.input, e.result)

    if (e.status !== 'completed') return
    const job = denied ? undefined : backgroundStart(e.tool, input, e.result, this.now())
    if (job !== undefined) (s.background ??= new Map()).set(job[0], job[1])
    const notes: string[] = []
    const lsp: string[] = []
    if (cls.kind === 'edit' || cls.kind === 'write' || cls.kind === 'patch') {
      notes.push(...await fileChecks(cls.kind, cls.paths, input, this.cfg().checkers, {
        root: this.ctx.location.project.directory, cwd, home: this.env.home, run: this.runChecker, log: (level, msg, data) => this.logFn(level, msg, data),
        now: this.now, ...(paths.isValidSessionId(e.sessionID) ? { once: (key: string) => this.onceInSession(e.sessionID, key) } : {}),
      }))
      lsp.push(...await lspEditNotes(cls.paths, this.cfg().checkers, { cwd, ask: this.lspEdits, log: (level, msg, data) => this.logFn(level, msg, data) }))
    }
    const extra = [...new Set([...nudges, ...(verdict?.context !== undefined ? [verdict.context] : [])].map(n => n.trim()).filter(n => n !== ''))]
    if (notes.length > 0) extra.push(['Buracle checks (H04):', ...notes.map(n => `- ${n}`)].join('\n'))
    if (lsp.length > 0) extra.push(['Buracle language server diagnostics (H04):', ...lsp].join('\n\n'))
    if (cls.kind === 'edit' || cls.kind === 'write' || cls.kind === 'patch') {
      const assets = assetsAfterEdit((await this.workspaceOf(s))?.root, cls.paths, assetsOptions(this.now(), this.assetsSpawn))
      if (assets !== undefined) extra.push(assets)
    }
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

  private onceInSession(sid: string, key: string): boolean {
    let fresh = false
    try { this.ledger.update(sid, l => { const r = ledgerOnce(l, key); fresh = r.fresh; return r.next }) } catch { return true }
    return fresh
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

  private async answerReceipt(s: SessionRuntime, input: unknown, result: ToolResultShape): Promise<void> {
    try {
      if (s.parentID === undefined && paths.isValidSessionId(s.sid)) await this.resolveParent(s)
      if (this.isSubagent(s)) return
      recordAnswer(s.sid, result, this.now())
      if (paths.isValidSessionId(s.sid)) questionGrant(s.sid, input, result, this.now())
    } catch (err) { this.logFn('warn', 'H08 answer receipt failed', { sid: s.sid, error: errText(err) }) }
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

  private capabilityText(sid: string): string | undefined {
    const cfg = this.cfg()
    const health = this.sessionHealth(sid)
    const key = JSON.stringify([cfg.routing.strictness, Object.entries(health).sort()])
    if (this.card?.key === key) return this.card.text
    let text: string | undefined
    try {
      const mcp = this.baked.mcp.filter(m => health[m.id] !== 'down')
      text = capabilityCard({ policy: { ...this.baked.routing, strictness: cfg.routing.strictness }, mcp, skills: this.baked.skills, plugins: this.baked.plugins, harness: HARNESS })
    } catch (e) {
      this.logFn('warn', 'capability card failed', { error: errText(e) })
      return undefined
    }
    this.card = { key, text: text.trim() === '' ? undefined : text }
    return this.card.text
  }

  async memoryIndex(s: SessionRuntime): Promise<string | undefined> {
    if (s.memoryIndex !== undefined) return s.memoryIndex ?? undefined
    if (s.memoryIndexLoading === undefined) {
      s.memoryIndexLoading = (async () => {
        try {
          s.memoryIndex = (await this.memory.context(this.cwdOf(s), MEMORY_INJECT.maxBytes)) ?? null
        } catch (e) {
          this.logFn('warn', 'memory context failed', { error: errText(e) })
          s.memoryIndex = null
        }
      })()
    }
    await s.memoryIndexLoading
    return s.memoryIndex ?? undefined
  }

  async onContext(e: SessionContextEvent): Promise<void> {
    const s = this.session(e.sessionID)
    if (isMemoryRunnerDir(this.cwdOf(s))) return
    this.touch(s)
    if (typeof e.agent === 'string' && e.agent !== '') s.agent = e.agent
    const parts: string[] = []
    const draft = draftOnSwitch(s.draft ??= {}, e.agent)
    if (draft !== undefined) {
      const note = await this.saveDraft(s, draft)
      if (note !== undefined) parts.push(note)
    }
    const card = this.capabilityText(s.sid)
    if (card !== undefined) parts.push(card)
    if (paths.isValidSessionId(s.sid)) {
      const info = await this.workspaceOf(s)
      if (info !== undefined) {
        try { parts.push(workspaceContext(info, HARNESS)) } catch (err) { this.logFn('warn', 'workspace context failed', { error: errText(err) }) }
        const assets = assetsContextCached(info.root, HARNESS, this.now())
        if (assets !== '') parts.push(assets)
      }
    }
    if (s.parentID === null || s.parentID === undefined) {
      const index = await this.memoryIndex(s)
      if (index !== undefined) parts.push(index)
    }
    const cfg = this.cfg()
    if (s.compacted) {
      try {
        const text = restoreContext(loadState(HARNESS, s.sid), s.handoffPath)
        if (text !== undefined && text.trim() !== '') parts.push(text)
      } catch (err) { this.logFn('warn', 'restoreContext failed', { error: errText(err) }) }
    }
    const notice = await this.sessionNotice(s)
    if (notice !== undefined) parts.push(notice)
    const watch = contextWatch(s.ctxWarned, s.ctx?.pct, cfg.context)
    if (watch.warned !== s.ctxWarned) {
      s.ctxWarned = watch.warned
      this.persist(s)
    }
    if (watch.warn !== undefined) parts.push(watch.warn)
    this.deliverPrompts(s, e.messages, cfg, e.agent === 'plan')
    parts.push(...s.pendingContext)
    for (const text of parts) e.system.push({ type: 'text', text })
  }

  private async saveDraft(s: SessionRuntime, plan: string): Promise<string | undefined> {
    try {
      const cwd = this.cwdOf(s)
      const saved = await captureSessionPlan({ plan, cwd, now: this.now(), harness: HARNESS, approved: false, sid: s.sid })
      if (saved === undefined) return undefined
      this.spool(s.sid, [{ ts: this.now(), ev: 'note', paths: [saved.path] }])
      return saved.note ?? draftNote(shownPath(saved.path, cwd))
    } catch (err) {
      this.logFn('warn', 'H12 plan draft failed', { sid: s.sid, error: errText(err) })
      return undefined
    }
  }

  private async sessionNotice(s: SessionRuntime): Promise<string | undefined> {
    if (s.noticesChecked === true || !paths.isValidSessionId(s.sid)) return undefined
    if (s.parentID === undefined) await this.resolveParent(s)
    s.noticesChecked = true
    return this.isSubagent(s) || this.resumed(s) ? undefined : openingNotice(this.baked, this.now(), this.notifyFn, this.logFn)
  }

  private resumed(s: SessionRuntime): boolean {
    return s.createdAt !== undefined && s.createdAt <= this.startedAt - RESUME_AFTER_MS
  }

  private deliverPrompts(s: SessionRuntime, messages: unknown, cfg: BuracleConfig, readOnly: boolean): void {
    try {
      const taken = takeDelivered(s.pending, messages)
      if (taken.length === 0) return
      const delivered = deliveredPrompts(taken, compiledTriggers(this.baked), { ...this.baked.routing, strictness: cfg.routing.strictness }, readOnly)
      if (delivered.route !== undefined) ledgerUserPrompt(this.ledger, s.sid, delivered.route, this.now())
      s.pendingContext = withinBudget(delivered.parts)
    } catch (err) { this.logFn('warn', 'prompt delivery failed', { error: errText(err) }) }
  }

  async onCompaction(e: SessionCompactionEvent): Promise<void> {
    const s = this.session(e.sessionID)
    this.touch(s)
    const state = loadState(HARNESS, s.sid)
    try {
      const text = compactInstructions(undefined, state)
      if (text.trim() !== '') e.system.push({ type: 'text', text })
    } catch (err) { this.logFn('warn', 'compactInstructions failed', { error: errText(err) }) }
    if (s.parentID === undefined) await this.resolveParent(s)
    if (!this.isSubagent(s)) await this.writeHandoff(s, state)
  }

  private async writeHandoff(s: SessionRuntime, state: SessionState): Promise<void> {
    try {
      if (s.handoffPath !== undefined) { delete s.handoffPath; this.persist(s) }
      const cwd = this.cwdOf(s)
      const now = this.now()
      const input: Parameters<typeof handoffNote>[0] = { state, project: basename(cwd), harness: HARNESS, sessionId: s.sid, now }
      const branch = await currentBranch(cwd)
      if (branch !== undefined) input.branch = branch
      const note = handoffNote(input)
      const req: Parameters<MemoryBridge['handoff']>[0] = { sessionId: s.sid, cwd, slug: note.slug, markdown: note.markdown, now }
      if (branch !== undefined) req.branch = branch
      const id = await this.memory.handoff(req)
      if (id === undefined) return
      s.handoffPath = id
      this.persist(s)
    } catch (err) { this.logFn('warn', 'handoff memory failed', { sid: s.sid, error: errText(err) }) }
  }

  async onPrompt(e: SessionPromptEvent): Promise<void> {
    const s = this.session(e.sessionID)
    this.touch(s)
    const meta = asRecord(e.metadata)
    const text = typeof e.prompt?.text === 'string' ? e.prompt.text : ''
    if (meta[CONTINUE_MARK] === true || isGuardContinuation(text)) return
    s.userPrompts++
    resetChain(s.sid)
    if (!paths.isValidSessionId(s.sid)) return
    if (s.parentID === undefined) await this.resolveParent(s)
    if (this.isSubagent(s)) return
    const at = this.now()
    if (!s.running) this.receipts.prompt(s.sid)
    const excerpt = spoolPromptExcerpt(text)
    this.spool(s.sid, [{ ts: at, ev: 'prompt', ...(excerpt !== undefined ? { excerpt } : {}) }])
    try { this.memory.prompt?.(s.sid) } catch (e) { this.logFn('warn', 'session record not touched', { error: errText(e) }) }
    const cfg = this.cfg()
    const cmd = commandOfPrompt(meta, text)
    const words = cmd !== undefined ? cmd.args : text
    try { recordPromptGrants(HARNESS, s.sid, words, at) } catch (err) { this.logFn('warn', 'consent grants failed', { error: errText(err) }) }
    let guidance = promptPlanInteraction(s.sid, words, { autoPause: cfg.plan.autoPause, now: at }, this.logFn)
    try { guidance = [guidance, reviewNotesNotice(HARNESS, s.sid, { plan: loadState(HARNESS, s.sid).plan?.path, roots: [(await this.workspaceOf(s))?.root, this.cwdOf(s)], now: at })].filter(x => x !== undefined).join('\n\n') || undefined } catch (err) { this.logFn('warn', 'review notes notice failed', { error: errText(err) }) }
    let routed: PromptRouteResult | undefined
    try {
      routed = await this.routeWords(s, e, words, cmd?.command, cfg, at)
    } catch (err) { this.logFn('warn', 'prompt routing failed', { error: errText(err) }) }
    const notice = this.indexNotice(s, cfg, at)
    const id = typeof e.messageID === 'string' && e.messageID !== '' ? e.messageID : undefined
    const pending: PendingPrompt = { id: id ?? `prompt-${s.userPrompts}`, delivery: id !== undefined && e.delivery === 'queue' ? 'queue' : 'steer', attach: routed?.attach ?? [] }
    if (routed !== undefined) pending.route = routed.route
    if (routed !== undefined && routed.workflows.length > 0) pending.workflows = [...routed.workflows]
    if (guidance !== undefined) pending.guidance = guidance
    if (routed?.text !== undefined) pending.text = routed.text
    if (notice !== undefined) pending.notice = notice
    addPending(s.pending, pending)
  }

  private async routeWords(s: SessionRuntime, e: SessionPromptEvent, words: string, command: string | undefined, cfg: BuracleConfig, at: number): Promise<PromptRouteResult> {
    const info = await this.workspaceOf(s)
    const attached = attachedSkills(e.prompt.skills)
    const deps = projectDeps(info?.root)
    const route = routeUserPrompt({
      text: words,
      ...(command !== undefined ? { command } : {}),
      attached,
      loaded: loadedSkills(this.ledger, s.sid),
      available: availableServers(this.baked, this.sessionHealth(s.sid)),
      ...(deps.length > 0 ? { deps } : {}),
      known: await this.knownSkills(this.cwdOf(s)),
    }, this.baked, cfg)
    if (route.attach.length > 0) e.prompt.skills = [...(Array.isArray(e.prompt.skills) ? e.prompt.skills : []), ...route.attach.map(id => ({ id }))]
    const title = runTitle(words)
    for (const workflow of route.workflows) {
      const source: FlowSource = workflow === command ? 'command' : 'prompt'
      recordFlowStart(HARNESS, s.sid, title !== undefined ? { workflow, title, source } : { workflow, source }, at)
    }
    this.spool(s.sid, promptSignalEntries(routeInputText(words, command), at))
    return route
  }

  private indexNotice(s: SessionRuntime, cfg: BuracleConfig, at: number): string | undefined {
    const prev = s.workspaceSeen
    if (prev === undefined) return undefined
    try {
      const next = refreshWorkspaceInfo(prev, cfg, at)
      s.workspaceSeen = next
      return workspaceNotice(prev, next)
    } catch (err) {
      this.logFn('debug', 'workspace notice failed', { error: errText(err) })
      return undefined
    }
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
        if (s.parentID === null) this.touch(s)
        if (paths.isValidSessionId(sid)) void this.ensureWorkspace(s)
        return
      }
      case 'session.skill.activated': {
        const id = str(data['id'])
        if (id === undefined || !paths.isValidSessionId(sid)) return
        const s = this.session(sid)
        recordCall(this.ledger, sid, { harness: HARNESS, sessionId: sid, cwd: this.cwdOf(s), tool: 'skill', kind: 'other', input: { id }, paths: [] })
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
      case 'session.execution.succeeded':
      case 'session.idle': {
        const s = this.session(sid)
        s.running = false
        if (typeof s.parentID === 'string') this.sessions.get(s.parentID)?.background?.delete(`subagent:${sid}`)
        if (s.handledGen === s.gen) return
        s.handledGen = s.gen
        if (s.parentID === null) startLinkRun(s.workspace?.root, assetsOptions(this.now(), this.assetsSpawn))
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
        this.track(this.turnEnded(s, 'interrupted'))
        return
      }
      case 'session.execution.failed': {
        const s = this.session(sid)
        s.running = false
        s.failures++
        this.track(this.turnEnded(s, 'failed'))
        return
      }
      case 'session.compaction.ended': {
        const s = this.session(sid)
        const text = str(data['text'])
        if (text !== undefined && text.trim() !== '') this.track(this.spoolOwn(s, [{ ts: this.now(), ev: 'compact', excerpt: text.slice(0, 8000) }]))
        s.compacted = true
        s.memoryIndex = undefined
        s.memoryIndexLoading = undefined
        this.persist(s)
        return
      }
      case 'session.deleted': {
        const s = this.sessions.get(sid)
        this.cancelIdleFinalize(s)
        this.sessions.delete(sid)
        this.receipts.forget(sid)
        registry().chains.delete(sid)
        if (s !== undefined && s.parentID !== null && s.parentID !== undefined) return
        await this.finalize(sid, s)
        return
      }
      default:
        return
    }
  }

  private turnSpool(s: SessionRuntime): void {
    const entry: SpoolEntry = { ts: this.now(), ev: 'turn' }
    if (s.lastAssistantText !== undefined) entry.excerpt = s.lastAssistantText.slice(0, 2000)
    if (s.model !== undefined) entry.model = `${s.model.providerID}/${s.model.id}`
    if (s.lastTokens !== undefined) entry.tokens = s.lastTokens
    this.track(this.spoolOwn(s, [entry]))
  }

  private async telemetry(s: SessionRuntime): Promise<void> {
    if (!paths.isValidSessionId(s.sid)) return
    if (s.parentID === undefined) await this.resolveParent(s)
    if (this.isSubagent(s)) return
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
