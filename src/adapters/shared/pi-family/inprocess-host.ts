import { readFileSync } from 'node:fs'
import type { CatalogMcp, CatalogSkill } from '../../../core/catalog'
import type { BuracleConfig } from '../../../core/config'
import * as coreCheckers from '../../../core/checkers'
import * as coreCompact from '../../../core/compact'
import type { Harness } from '../../../core/events'
import type { Notice } from '../../../core/notices'
import type { ConsentKind } from '../../../core/policy/consent'
import * as corePolicy from '../../../core/policy/index'
import { offServersFor, withOffServers } from '../../../core/policy/mcp-off'
import type { McpHealth, RoutingPolicy } from '../../../core/policy/routing'
import type { PromptRoute } from '../../../core/policy/skill-router'
import { PROMPT_CONTEXT_MAX_CHARS, routeText } from '../../../core/policy/skill-router'
import type { UsageLedger } from '../../../core/policy/usage'
import { ledgerPrompt } from '../../../core/policy/usage'
import type { WriteGuardContext } from '../../../core/policy/write-guard'
import * as corePlan from '../../../core/plan/index'
import type { SessionState } from '../../../core/plan/index'
import type { ContextBand } from '../../../core/status/context'
import { indexSettings, type WorkspaceInfo } from '../../../core/workspace'
import { currentBranch, projectSlug } from '../../../engine/git'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'
import { run } from '../../../engine/proc'
import { loadLedger, updateLedger } from '../../../workflow/ledger'
import { loadState, reviewSubjects, sessionMaint, updateState } from '../../../workflow/session-store'
import { refreshWorkspaceInfo, workspaceInfo } from '../../../workflow/workspace'
import type { AdapterContext } from '../../registry'
import { nodeCheckFs, type CheckFs } from '../checker-scan'
import { recordDialogGrant } from '../consent-dialog'
import { fitParts, readWorkspace, saveWorkspace, sessionEnd, sessionStart, postTool, spool, type PipelineDeps } from '../pipeline/index'
import type { AssetsSpawner } from '../project-assets'
import { realWriteTarget } from '../realpath'
import { buracleRepoFor } from '../repo-cache'
import { prepareWorkspace } from '../workspace-start'
import { liveConfig, mcpHealth, type LiveConfig } from './config'
import { adapterContext, memoryFns, pipelineCore, uiHooks } from './host'
import { buracleCli, type MemoryBridge, type SpoolEntry } from './memory'
import { availableServers, createDepsReader, mergeRoutes, promptRouting, routerData, sessionHealth, type PromptRouting, type RouterData } from './routing'
import { hasTui, withDeadline, type FamilyContext } from './util'

// The in-process host of a Pi-family extension (Oh My Pi, Pi): what the two extensions did the same way. It builds the
// pipeline's dependencies for a session, keeps the per-session memo and the prompt queue, and runs the session-start
// sequence. An extension keeps its event names, its native result shapes and its own steps.

export const TOOL_CALL_DEADLINE_MS = 3_000
export const TOOL_RESULT_DEADLINE_MS = 25_000
const WORKSPACE_WAIT_MS = 3_000
const PROJECT_WAIT_MS = 2_000
const START_WAIT_MS = 1_000
const MAX_QUEUED_PROMPTS = 16

export type EvalGuard = (code: string, language: string, ctx: WriteGuardContext, opts?: { extraDeny?: string[] }) => { deny?: string, hook?: 'H01' | 'H02' }

function coreEvalGuard(): EvalGuard | undefined {
  const fn = (corePolicy as unknown as Record<string, unknown>)['checkEval']
  return typeof fn === 'function' ? fn as EvalGuard : undefined
}

/** What both extensions take from outside, so a test can replace any of it. */
export interface HostDeps {
  now(): number
  config(defaults: BuracleConfig): LiveConfig
  health(): McpHealth
  policy: Pick<typeof corePolicy, 'checkBash' | 'checkWrite' | 'routeTool' | 'capabilityCard' | 'checkQuestion' | 'detectIntent' | 'isGuardContinuation'>
  evalGuard?: EvalGuard | undefined
  realpath?: (p: string) => string | undefined
  plan: Pick<typeof corePlan, 'stopGuardVerdict' | 'promptInteraction' | 'answerReceipt' | 'validatePlan'>
  compact: Pick<typeof coreCompact, 'handoffNote' | 'restoreContext'>
  checkers: Pick<typeof coreCheckers, 'checkersFor' | 'findingsOf'>
  checkFs?: CheckFs
  resolveChecker?: (argv: readonly string[]) => string[]
  state: { load(sid: string): SessionState, update(sid: string, fn: (s: SessionState) => SessionState): SessionState, subjects?(sid: string | undefined): string[] }
  ledger: { load(sid: string): UsageLedger, update(sid: string, fn: (l: UsageLedger) => UsageLedger): UsageLedger }
  memory: MemoryBridge
  captureEnabled(): boolean
  buracleRepo(cwd: string, configured: string | undefined): string | undefined
  cli(): string[] | undefined
  projectSlug(cwd: string): Promise<string>
  branch(cwd: string): Promise<string | undefined>
  run(argv: string[], opts: { cwd?: string, timeoutMs?: number, env?: Record<string, string> }): Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>
  readText(path: string): string | undefined
  prune(keep: ReadonlySet<string>, nowMs: number): string[]
  recordAskGrant(sid: string, kind: ConsentKind, answer: 'once' | 'session', nowMs: number): void
  prepareWorkspace(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<WorkspaceInfo>
  workspaceInfo(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<WorkspaceInfo>
  refreshWorkspace(info: WorkspaceInfo, cfg: BuracleConfig, nowMs: number): WorkspaceInfo
  projectDeps(root: string | undefined): string[] | undefined
  /** Starts the project's link run (H28); the pipeline's own spawner by default. */
  assetsSpawn?: AssetsSpawner
  setEnv(name: string, value: string): void
  home(): string
  timings: { toolCallMs: number, toolResultMs: number, maintDelayMs: number }
}

/** The dependencies the real extension of `harness` starts from, without its memory bridge. */
export function hostDeps(harness: Harness): Omit<HostDeps, 'memory'> {
  return {
    now: () => Date.now(),
    config: liveConfig,
    health: mcpHealth,
    policy: corePolicy,
    evalGuard: coreEvalGuard(),
    realpath: realWriteTarget,
    plan: corePlan,
    compact: coreCompact,
    checkers: coreCheckers,
    checkFs: nodeCheckFs,
    state: {
      load: sid => loadState(harness, sid),
      update: (sid, fn) => updateState(harness, sid, fn),
      subjects: sid => reviewSubjects(harness, sid),
    },
    ledger: { load: sid => loadLedger(harness, sid), update: (sid, fn) => updateLedger(harness, sid, fn) },
    captureEnabled: () => process.env['BURACLE_NO_CAPTURE'] !== '1',
    buracleRepo: (cwd, configured) => buracleRepoFor(cwd, [configured !== undefined ? paths.expandHome(configured) : undefined]),
    cli: hostCli,
    projectSlug,
    branch: currentBranch,
    run: (argv, opts) => run(argv, opts),
    readText: path => { try { return readFileSync(path, 'utf8') } catch { return undefined } },
    prune: (keep, nowMs) => sessionMaint(harness, nowMs, { keep }).removed,
    recordAskGrant: (sid, kind, answer, nowMs) => { recordDialogGrant(harness, sid, kind, answer, nowMs) },
    prepareWorkspace: (cwd, cfg, nowMs) => prepareWorkspace(cwd, indexSettings(cfg), nowMs),
    workspaceInfo: (cwd, cfg, nowMs) => workspaceInfo(cwd, indexSettings(cfg), nowMs),
    refreshWorkspace: (info, cfg, nowMs) => refreshWorkspaceInfo(info, indexSettings(cfg), nowMs),
    projectDeps: createDepsReader(),
    setEnv: (name, value) => { process.env[name] = value },
    home: () => paths.home(),
    timings: { toolCallMs: TOOL_CALL_DEADLINE_MS, toolResultMs: TOOL_RESULT_DEADLINE_MS, maintDelayMs: 15_000 },
  }
}

/** The command that runs Buracle Stack's CLI, for the memory bridge. */
export function hostCli(): string[] | undefined {
  return buracleCli(paths.shimPath(), paths.repoRoot())
}

/** What an extension's generated data holds for the host. */
export interface HostData {
  buracleVersion: string
  config: BuracleConfig
  routing: RoutingPolicy
  mcp: CatalogMcp[]
  mcpIds: string[]
  skills: CatalogSkill[]
  notices?: Notice[]
}

/** A prompt's context from the pipeline, split at its routing note: the notes of a batch are merged into one. */
export interface QueuedPrompt { before: string[], after: string[], route?: PromptRoute }

/** The memo fields every session has; an extension adds its own. */
export interface BaseMemo {
  capture?: boolean
  /** The session start in flight or done. */
  starting?: Promise<void>
  /** Settles once the start has reset the usage ledger (or failed): tool calls and prompts wait for it. */
  ready?: Promise<void>
  /** What the session start returned: the block of the system prompt. */
  startContext?: string[]
  slug?: Promise<string | undefined>
  slugValue?: string
  queued?: QueuedPrompt[]
  delivered?: { prompt: string, text: string | undefined }
  inputSeen?: boolean
  ctxWarned?: ContextBand
  contextWarning?: string
}

export interface HostContext extends FamilyContext {
  cwd: string
  ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void }
}

export interface InProcessHostOptions {
  harness: Harness
  data: HostData
  deps: HostDeps
  /** The extension's API, for the notice message of a session start. */
  pi: { sendMessage(message: { customType: string, content: string, display: boolean }, options: { deliverAs: 'nextTurn' }): void }
  noticeType: string
  /** The repository the extension was configured with, from the live config of the call. */
  configuredRepo(lc: LiveConfig, config: BuracleConfig): string | undefined
  /** The servers the host's own settings switch off (read through the host's cache), and the log label of reading them. */
  nativeOff: { label: string, read(cwd: string): string[] }
}

export interface OpenSessionOptions {
  /** The session this one replaces: its end runs first. */
  previous?: string
  card(): string
  scheduleMaint(): void
}

export function createInProcessHost<M extends BaseMemo>(o: InProcessHostOptions) {
  const { harness: H, data, deps } = o
  const memos = new Map<string, M>()
  const reported = new Set<string>()
  let currentSid: string | undefined
  let maintScheduled = false
  let router: { strictness: string, data: RouterData } | undefined

  /** Logs a failure once; the outcome is named in the line only where the extension says it. */
  const report = (what: string, e: unknown, outcome?: 'allowed' | 'blocked'): void => {
    const message = e instanceof Error ? e.message : String(e)
    const key = `${what}:${message}`
    if (reported.has(key)) return
    reported.add(key)
    log(/^not implemented: /.test(message) ? 'debug' : 'warn', `${H} extension: ${what} failed${outcome !== undefined ? ` (${outcome})` : ''}`, { error: message })
  }
  const guarded = <T>(what: string, fn: () => T): T | undefined => {
    try { return fn() } catch (e) { report(what, e); return undefined }
  }
  const step = async <T>(name: string, fallback: T, fn: () => T | Promise<T>): Promise<T> => {
    try { return await fn() } catch (e) { report(name, e); return fallback }
  }
  const live = (): LiveConfig => deps.config(data.config)
  const liveOrDefaults = (): LiveConfig => guarded('config', live) ?? { config: data.config, vault: paths.oldVaultRoot(), shim: paths.shimPath(), source: 'defaults' }
  const memo = (sid: string): M => {
    let m = memos.get(sid)
    if (m === undefined) { m = {} as M; memos.set(sid, m) }
    return m
  }
  const captureOn = (sid: string): boolean => {
    const m = memo(sid)
    m.capture ??= guarded('BURACLE_NO_CAPTURE', () => deps.captureEnabled()) ?? true
    return m.capture
  }
  const slugOf = (sid: string, cwd: string): Promise<string | undefined> => {
    const m = memo(sid)
    m.slug ??= deps.projectSlug(cwd).then(s => { m.slugValue = s; return s }, e => { report('projectSlug', e); return undefined })
    return m.slug
  }
  const routerFor = (strictness: BuracleConfig['routing']['strictness']): RouterData => {
    if (router === undefined || router.strictness !== strictness) router = { strictness, data: routerData(data.skills, data.routing, strictness) }
    return router.data
  }
  /** The MCP health of a session: the shared record, the session's own ledger, and the servers that are off. */
  const healthFor = (sid: string | undefined, cwd?: string): McpHealth => {
    const health = guarded('health', () => deps.health()) ?? {}
    const merged = guarded('H24 session health', () => sessionHealth(health, deps.ledger, sid)) ?? health
    const native = guarded(o.nativeOff.label, () => o.nativeOff.read(cwd ?? process.cwd())) ?? []
    return withOffServers(merged, [...new Set([...offServersFor(liveOrDefaults().config, H), ...native])])
  }

  const coreFns = pipelineCore(deps)
  const memFns = memoryFns(deps.memory)
  const ui = uiHooks(deps.memory)
  const actx = (lc: LiveConfig): AdapterContext => adapterContext(data, lc, () => deps.home())

  /** What the shared pipeline needs from the host for one session. */
  const pipe = (sid: string, lc: LiveConfig = liveOrDefaults()): PipelineDeps => ({
    harness: H, ctx: actx(lc), core: coreFns, step, ui,
    // The session's capture decision (an injected one in tests) is what the pipeline reads as BURACLE_NO_CAPTURE.
    env: { ...process.env, BURACLE_NO_CAPTURE: sid === '' || captureOn(sid) ? undefined : '1' },
    memory: async name => memFns[name],
    workspace: {
      // The first turn does not wait for a slow preparation; its result is saved when it arrives.
      prepareWorkspace: async (cwd, c, now) => {
        const work = deps.prepareWorkspace(cwd, c.config, now)
        let late = false
        work.then(info => { if (late) guarded('H21 workspace', () => saveWorkspace(c, H, sid, info)) }, () => undefined)
        const info = await withDeadline(work, WORKSPACE_WAIT_MS, undefined)
        late = info === undefined
        return info
      },
      workspaceInfo: (cwd, c, now) => withDeadline(deps.workspaceInfo(cwd, c.config, now), WORKSPACE_WAIT_MS, undefined),
      refreshWorkspace: (info, c, now) => deps.refreshWorkspace(info, c.config, now),
    },
    project: async cwd => {
      const project = await withDeadline(slugOf(sid, cwd), PROJECT_WAIT_MS, undefined)
      if (project === undefined) throw new Error('the project of this folder is not known')
      const branch = await withDeadline(deps.branch(cwd).catch(() => undefined), PROJECT_WAIT_MS, undefined)
      return { project, ...(branch !== undefined ? { branch } : {}) }
    },
    ...(deps.realpath !== undefined ? { realpath: deps.realpath } : {}),
    buracleRepo: async (cwd, c) => deps.buracleRepo(cwd, o.configuredRepo(lc, c.config)),
    ...(deps.assetsSpawn !== undefined ? { assetsSpawn: deps.assetsSpawn } : {}),
  })

  /**
   * The session start resets the usage ledger, so an event that counts in it waits for that step, briefly: a start
   * that hangs must not hold a guard back.
   */
  const started = (sid: string | undefined): Promise<void> => {
    const ready = sid !== undefined ? memo(sid).ready : undefined
    return ready === undefined ? Promise.resolve() : withDeadline(ready, START_WAIT_MS, undefined)
  }

  /** Append to a session's memory spool (H14), through the pipeline. */
  const spoolTo = async (sid: string | undefined, entries: SpoolEntry[]): Promise<void> => {
    if (sid !== undefined) await spool(pipe(sid), sid, entries)
  }

  /** The file checks of the post-tool step (H04) on the host's process runner and checkers. */
  const fileChecks = (): Parameters<typeof postTool>[1]['fileChecks'] => ({
    now: () => deps.now(),
    run: async (argv, opts) => {
      const res = await deps.run(argv, { ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}), ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ...(opts?.env !== undefined ? { env: opts.env as Record<string, string> } : {}) })
      return { code: res.code, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut }
    },
    core: deps.checkers,
    ...(deps.checkFs !== undefined ? { fs: deps.checkFs } : {}),
    ...(deps.resolveChecker !== undefined ? { resolve: deps.resolveChecker } : {}),
  })

  /** The routing of one prompt: the skills the session loaded and the servers that are up decide what is offered. */
  const route = (sid: string, text: string, lc: LiveConfig): PromptRouting => {
    const strictness = lc.config.routing.strictness
    const o2: Parameters<typeof promptRouting>[2] = { harness: H, loaded: Object.keys(deps.ledger.load(sid).skills), available: availableServers(data.mcp, healthFor(sid)), strictness }
    const pd = deps.projectDeps(readWorkspace(actx(lc), H, sid)?.root)
    if (pd !== undefined) o2.deps = pd
    return promptRouting(text, routerFor(strictness), o2)
  }

  /**
   * A prompt reaches the model at the next `before_agent_start`, and several can arrive together: their routes are
   * merged and recorded in the ledger (H24) here, when they are delivered.
   */
  const deliver = (sid: string, prompt: string): string | undefined => {
    const m = memo(sid)
    const batch = m.queued ?? []
    if (batch.length === 0) {
      if (m.delivered?.prompt === prompt) return m.delivered.text
      m.delivered = undefined
      return undefined
    }
    if (guarded('H10 isGuardContinuation', () => coreFns.isGuardContinuation(prompt)) === true) return undefined
    m.queued = undefined
    const now = deps.now()
    const rd = routerFor(liveOrDefaults().config.routing.strictness)
    const routes = batch.flatMap(p => (p.route !== undefined ? [p.route] : []))
    let routed: string | undefined
    if (routes.length > 0) {
      const merged = mergeRoutes(routes, rd.compiled)
      guarded('H24 ledger turn', () => deps.ledger.update(sid, l => ledgerPrompt(l, merged, now)))
      routed = guarded('H22 routeText', () => routeText(merged, H, rd.policy, { triggers: rd.compiled }))
    }
    const parts = [...new Set([...batch.flatMap(p => p.before), ...(routed !== undefined ? [routed] : []), ...batch.flatMap(p => p.after)])]
    const lines = fitParts(parts, PROMPT_CONTEXT_MAX_CHARS)
    const text = lines.length > 0 ? lines.join('\n\n') : undefined
    m.delivered = { prompt, text }
    return text
  }

  /** Queue a prompt's context (the pipeline's lines, split around its routing note) for the next delivery. */
  const enqueue = (m: M, context: readonly string[], routed: PromptRouting | undefined): void => {
    const at = routed?.text !== undefined ? context.indexOf(routed.text.trim()) : -1
    const queued = m.queued ??= []
    queued.push({ before: at >= 0 ? context.slice(0, at) : [...context], after: at >= 0 ? context.slice(at + 1) : [], ...(routed !== undefined ? { route: routed.route } : {}) })
    if (queued.length > MAX_QUEUED_PROMPTS) queued.splice(0, queued.length - MAX_QUEUED_PROMPTS)
  }

  /** The prune of idle session state (H16), once, after the host's delay; `later` is the host's timer. */
  const scheduleMaint = (later: (fn: () => void, ms: number) => void): void => {
    if (maintScheduled) return
    maintScheduled = true
    later(() => {
      const keep = new Set<string>([...memos.keys(), ...(currentSid !== undefined ? [currentSid] : [])])
      const removed = guarded('H16 session maintenance', () => deps.prune(keep, deps.now())) ?? []
      if (removed.length > 0) log('info', `${H}: pruned idle session state`, { count: removed.length })
    }, deps.timings.maintDelayMs)
  }

  const endSession = async (sid: string): Promise<void> => {
    await sessionEnd({ harness: H, sessionId: sid, now: deps.now() }, pipe(sid))
  }

  /**
   * The pipeline's sessionStart for a main session, after the end of the one it replaces. Its context is the block
   * `before_agent_start` adds to the system prompt; the release notice goes out as the host's own message and toast,
   * the profile warning as a toast. The returned promise settles once the usage ledger has been reset.
   */
  const openSession = (sid: string, ctx: HostContext, source: string, os: OpenSessionOptions): Promise<void> => {
    const m = memo(sid)
    let ready!: () => void
    m.ready = new Promise<void>(res => { ready = res })
    m.starting = (async () => {
      if (os.previous !== undefined) await endSession(os.previous)
      const d = pipe(sid)
      const then = <A extends unknown[]>(fn: (...a: A) => Promise<void>) => (...a: A): Promise<void> => { ready(); return fn(...a) }
      const r = await sessionStart({ harness: H, sessionId: sid, cwd: ctx.cwd, source, now: deps.now() }, {
        ...d,
        // The usage ledger is reset before the memory UI hears of the session: from there on a tool call may be counted.
        ui: { ...d.ui, started: then(d.ui.started), seen: then(d.ui.seen) },
        capabilityCard: os.card,
        // The extension is a built copy, so the version that runs is the one baked into it.
        version: () => data.buracleVersion,
        sessionMaint: os.scheduleMaint,
      })
      const notice = r.notice
      m.startContext = r.context.filter(part => part !== notice?.model)
      // The profile warning (H17) is a toast for the user; it never enters the model's context.
      const warning = r.profile
      if (warning !== undefined) {
        log('warn', `${H}: H17 profile guard`, { sid, warning })
        if (hasTui(ctx)) guarded('H17 notify', () => ctx.ui.notify(warning, 'warning'))
      }
      if (notice === undefined) return
      guarded('H17 notice', () => o.pi.sendMessage({ customType: o.noticeType, content: notice.model, display: false }, { deliverAs: 'nextTurn' }))
      if (hasTui(ctx)) guarded('H17 notice notify', () => ctx.ui.notify(notice.user, 'info'))
    })().catch((e: unknown) => { report('session start', e) }).finally(ready)
    return m.ready
  }

  /** Remember the session the extension is in, and tell the processes it starts which one it is. */
  const enter = (sid: string): string | undefined => {
    const previous = currentSid !== undefined && currentSid !== sid ? currentSid : undefined
    currentSid = sid
    deps.setEnv('BURACLE_SESSION_ID', sid)
    deps.setEnv('BURACLE_HARNESS', H)
    return previous
  }

  return {
    memos, memo, report, guarded, step, live, liveOrDefaults, captureOn, slugOf, routerFor, healthFor, coreFns, actx, pipe, started, spoolTo,
    fileChecks, route, deliver, enqueue, scheduleMaint, endSession, openSession, enter,
    current: (): string | undefined => currentSid,
  }
}

export type InProcessHost<M extends BaseMemo> = ReturnType<typeof createInProcessHost<M>>

/** The context block a host adds to the system prompt. */
export function contextBlock(parts: readonly string[]): string {
  return parts.length > 0 ? ['<buracle-context>', ...parts, '</buracle-context>'].join('\n\n') : ''
}
