import type { BuracleConfig } from '../../../core/config'
import type { HookId, ToolCall, ToolKind } from '../../../core/events'
import { classifyTool } from '../../../core/events'
import { flowDef } from '../../../core/flow/catalog'
import { FOLD_AFTER_SEC } from '../../../core/flow/state'
import * as corePolicy from '../../../core/policy/index'
import type { PromptRoute } from '../../../core/policy/skill-router'
import { PROMPT_CONTEXT_MAX_CHARS, routeText } from '../../../core/policy/skill-router'
import { offServersFor, withOffServers } from '../../../core/policy/mcp-off'
import { ompOffServers } from '../../shared/native-off'
import type { McpHealth } from '../../../core/policy/routing'
import { mcpUnavailable } from '../../../core/policy/routing'
import { ledgerPrompt, skillOf } from '../../../core/policy/usage'
import type { ContextBand } from '../../../core/status/context'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'
import type { AdapterContext } from '../../registry'
import {
  bashOptions, denyReason, fitParts, guardFailed, postTool, preTool, prompt as promptEvent, readWorkspace, saveWorkspace, sessionEnd, sessionStart, spool,
  workspaceStart, writeGuardContext, type PipelineDeps, type UsagePlan,
} from '../../shared/pipeline/index'
import { addedTextOf, OMP_H04_BUDGET_MS, removedTextOf } from './checks'
import { registerUtilityCommands } from './commands'
import { registerCompaction } from './compaction'
import { fenceActiveTools, fenceToolCall } from './companion-fence'
import { judgeWithConsent, type ConsentNeed } from '../../shared/pi-family/consent-ask'
import { heldConsentNeed } from '../../shared/pi-family/consent-held'
import type { LiveConfig } from '../../shared/pi-family/config'
import { CODE_EXECUTION_TOOLS, defaultDeps, emptyGenerated, type ExtensionDeps } from './deps'
import { editTargets, type EditTargets } from './edits'
import { FlowWidget, flowWidgetLines } from './flow-widget'
import { adapterContext, memoryFns, pipelineCore, uiHooks } from '../../shared/pi-family/host'
import { StatusPane } from './pane'
import { createTurnReceipts } from './receipt'
import { workflowOfExpanded, workflowOfInput } from './flow-track'
import type { SpoolEntry } from './memory'
import { GENERATED } from './generated-data'
import { deviceCall, ompWriteContents } from './write-check'
import { isModelPrompt, PROMPT_MESSAGE_TYPE } from './prompt'
import { approvingResult, capturePlans, planFileOf, planSavedNote, type PlanSignal, type SavedPlan } from './plan-capture'
import { contextCheck, NOTICE_MESSAGE_TYPE } from './session-notes'
import { reviewAgentOf, reviewProblems, reviewYieldReason, yieldReport } from './review'
import { availableServers, isDeviceWrite, mergeRoutes, promptRouting, routerData, sessionHealth, type PromptRouting, type RouterData } from './routing'
import { resumedSession, telemetryOf } from './session-facts'
import { createStatusTexts } from './status'
import { planModeOn, registerStopGuard } from './stop'
import { maskResult, openTodosOf } from './tool-output'
import type {
  OmpBeforeAgentStartEvent, OmpBeforeAgentStartResult, OmpContext, OmpExtensionAPI, OmpGenerated, OmpInputEvent,
  OmpToolCallEvent, OmpToolCallResult, OmpToolResultEvent, OmpToolResultResult, OmpTurnEndEvent,
} from './types'
import { clip, hasTui, isMain, messageText, numAt, sessionOf, strAt, withDeadline } from '../../shared/pi-family/util'

export { CODE_EXECUTION_TOOLS, defaultDeps, emptyGenerated, STATUS_INTERVAL_MS, TOOL_CALL_DEADLINE_MS, TOOL_RESULT_DEADLINE_MS } from './deps'
export type { EvalGuard, ExtensionDeps } from './deps'
export { STATUS_KEYS, WIDGET_KEY } from './status'
export { runawayNotice, stopReason } from './stop'

const H = 'omp' as const
const WORKSPACE_WAIT_MS = 3_000
const PROJECT_WAIT_MS = 2_000
const START_WAIT_MS = 1_000
const FENCE_TOOLS_WAIT_MS = 2_000
const MAX_QUEUED_PROMPTS = 16
const WRITE_KINDS: ReadonlySet<ToolKind> = new Set(['edit', 'write', 'patch'])

interface SessionMemo {
  capture?: boolean
  /** The session start in flight or done. */
  starting?: Promise<void>
  /** Settles once the start has reset the usage ledger (or failed): tool calls and prompts wait for it. */
  ready?: Promise<void>
  /** What the session start returned: the block of the system prompt. */
  startContext?: string[]
  /** A subagent's block. */
  block?: Promise<string>
  slug?: Promise<string | undefined>
  slugValue?: string
  queued?: QueuedPrompt[]
  delivered?: { prompt: string, text: string | undefined }
  inputSeen?: boolean
  lastPrompt?: string
  ctxWarned?: ContextBand
  contextWarning?: string
  noticed?: boolean
  band?: string
  flow?: FlowWidget
  reviewBlocked?: boolean
  todos?: string[]
}

/** A prompt's context from the pipeline, split at its routing note: the notes of a batch are merged into one. */
interface QueuedPrompt {
  before: string[]
  after: string[]
  route?: PromptRoute
}

function toolPaths(core: readonly string[], targets: EditTargets | undefined): string[] {
  return [...new Set([...core, ...(targets?.paths ?? [])])]
}

export function createBuracleExtension(data: OmpGenerated = emptyGenerated(), overrides: Partial<ExtensionDeps> = {}): (pi: OmpExtensionAPI) => void {
  return function buracle(pi: OmpExtensionAPI): void {
    const deps: ExtensionDeps = { ...defaultDeps(), ...overrides }
    const memos = new Map<string, SessionMemo>()
    const reported = new Set<string>()
    let currentSid: string | undefined
    let statusTimerStarted = false
    let maintScheduled = false
    let router: { strictness: string, data: RouterData } | undefined

    const report = (what: string, e: unknown, outcome: 'allowed' | 'blocked' = 'allowed') => {
      const message = e instanceof Error ? e.message : String(e)
      const key = `${what}:${message}`
      if (reported.has(key)) return
      reported.add(key)
      log(/^not implemented: /.test(message) ? 'debug' : 'warn', `omp extension: ${what} failed (${outcome})`, { error: message })
    }
    const guarded = <T>(what: string, fn: () => T): T | undefined => {
      try { return fn() } catch (e) { report(what, e); return undefined }
    }
    const live = () => deps.config(data.config)
    const liveOrDefaults = (): LiveConfig => guarded('config', () => live()) ?? { config: data.config, vault: paths.oldVaultRoot(), shim: paths.shimPath(), source: 'defaults' }
    const memo = (sid: string): SessionMemo => {
      let m = memos.get(sid)
      if (m === undefined) { m = {}; memos.set(sid, m) }
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
    const spoolSid = (ctx: OmpContext): string | undefined => {
      if (isMain(ctx)) return sessionOf(ctx)
      const sid = process.env['BURACLE_SESSION_ID']
      return process.env['BURACLE_HARNESS'] === 'omp' && paths.isValidSessionId(sid) ? sid : undefined
    }
    const routerFor = (strictness: BuracleConfig['routing']['strictness']): RouterData => {
      if (router === undefined || router.strictness !== strictness) router = { strictness, data: routerData(data.skills, data.routing, strictness) }
      return router.data
    }
    const healthFor = (lsid: string | undefined, cwd?: string): McpHealth => {
      const health = guarded('health', () => deps.health()) ?? {}
      const merged = guarded('H24 session health', () => sessionHealth(health, deps.ledger, lsid)) ?? health
      // The servers that are off in Oh My Pi (mcp.off.omp, or its own `disabledServers`, read through an
      // mtime cache): routing treats them as unavailable for good.
      const native = guarded('omp disabledServers', () => ompOffServers(cwd ?? process.cwd())) ?? []
      return withOffServers(merged, [...new Set([...offServersFor(liveOrDefaults().config, 'omp'), ...native])])
    }
    const availableNow = (lsid: string | undefined): string[] => availableServers(data.mcp, healthFor(lsid))

    const step = async <T>(name: string, fallback: T, fn: () => T | Promise<T>): Promise<T> => {
      try { return await fn() } catch (e) { report(name, e); return fallback }
    }
    const coreFns = pipelineCore(deps)
    const memFns = memoryFns(deps.memory)
    const ui = uiHooks(deps.memory)
    const actx = (lc: LiveConfig): AdapterContext => adapterContext(data, lc, () => deps.home())

    /** What the shared pipeline needs from omp for one session. */
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
      buracleRepo: async cwd => deps.buracleRepo(cwd, lc.repoRoot),
      ...(deps.assetsSpawn !== undefined ? { assetsSpawn: deps.assetsSpawn } : {}),
    })

    /**
     * The session start resets the usage ledger, so an event that counts in it waits for that step, briefly: a
     * start that hangs must not hold a guard back.
     */
    const started = (sid: string | undefined): Promise<void> => {
      const ready = sid !== undefined ? memo(sid).ready : undefined
      return ready === undefined ? Promise.resolve() : withDeadline(ready, START_WAIT_MS, undefined)
    }

    /** Append to a session's memory spool (H14), through the pipeline. */
    const spoolTo = async (sid: string | undefined, entries: SpoolEntry[]): Promise<void> => {
      if (sid !== undefined) await spool(pipe(sid), sid, entries)
    }

    const status = createStatusTexts({
      data, deps, live, guarded,
      slug: sid => memo(sid).slugValue,
      band: { get: sid => memo(sid).band, set: (sid, text) => { memo(sid).band = text } },
    })

    const consentHolds = new Map<string, ConsentNeed>()
    const deniedCalls = new Set<string>()
    const denied = (id: unknown): void => {
      if (typeof id !== 'string' || id === '') return
      deniedCalls.add(id)
      if (deniedCalls.size > 256) deniedCalls.delete(deniedCalls.values().next().value as string)
    }

    pi.setLabel?.('Buracle')
    const receipts = createTurnReceipts({ now: () => deps.now(), view: sid => guarded('flow view', () => deps.flow.view(sid, deps.now(), FOLD_AFTER_SEC)), log: (msg, data) => log('debug', `omp: ${msg}`, data) })
    const pane = new StatusPane({ lines: (view, ctx) => status.lines(view, ctx) })

    const refreshFlow = (ctx: OmpContext): void => {
      if (!hasTui(ctx) || !isMain(ctx)) return
      const sid = sessionOf(ctx)
      if (sid === undefined) return
      const lc = live()
      const m = memo(sid)
      const widget = m.flow ??= new FlowWidget()
      if (!lc.config.workflow.band) { widget.draw(ctx.ui, []); return }
      const now = deps.now()
      const view = deps.flow.view(sid, now, FOLD_AFTER_SEC)
      widget.draw(ctx.ui, flowWidgetLines(view, deps.columns(), { emoji: lc.config.statusline.emoji, ansi: true }))
      const due = widget.foldDue(view, FOLD_AFTER_SEC)
      if (due !== undefined && typeof ctx.setTimeout === 'function') ctx.setTimeout(() => refreshFlowSafe(ctx), Math.max(0, due - now) + 250)
    }
    const refreshFlowSafe = (ctx: OmpContext): void => { guarded('workflow band', () => refreshFlow(ctx)) }

    const editsFor = (call: ToolCall, targets: EditTargets | undefined): UsagePlan['edits'] => {
      if (targets !== undefined) return targets.changes
      if (call.kind === 'write' && typeof call.input['content'] === 'string' && call.paths[0] !== undefined) {
        const file = call.paths[0]
        return [{ file, removed: deps.readText(file) ?? '', added: call.input['content'] }]
      }
      return undefined
    }

    /** The checks only omp has, before the pipeline's: an `eval` cell (SEC-04) and a reviewer's report (H19). */
    const ownDenial = async (event: OmpToolCallEvent, ctx: OmpContext, input: Record<string, unknown>, d: PipelineDeps): Promise<{ reason: string, hook: HookId } | undefined> => {
      if (CODE_EXECUTION_TOOLS.has(event.toolName)) {
        const code = typeof input['code'] === 'string' ? input['code'] : ''
        const language = typeof input['language'] === 'string' ? input['language'] : 'js'
        try {
          const guard = deps.evalGuard
          if (guard === undefined) throw new Error('core checkEval is unavailable')
          const extraDeny = bashOptions(d.ctx, ctx.cwd, d.realpath).extraDeny
          const verdict = guard(code, language, await writeGuardContext(d, ctx.cwd), extraDeny !== undefined ? { extraDeny } : {})
          const hook = verdict.hook === 'H02' ? 'H02' : 'H01'
          if (verdict.deny) return { reason: denyReason(hook, verdict.deny), hook }
          const lane = isMain(ctx) ? undefined : corePolicy.subagentCodeDenial(code, language)
          if (lane !== undefined) return { reason: lane, hook: 'H01' }
        } catch (e) {
          report('H01 guard', e, 'blocked')
          return { reason: guardFailed('H01', e), hook: 'H01' }
        }
      }
      if (event.toolName === 'yield' && !isMain(ctx)) {
        const agent = reviewAgentOf(ctx.agent?.name)
        const sent = agent !== undefined ? yieldReport(input) : undefined
        if (agent !== undefined && sent !== undefined) {
          const problems = guarded('H19 validateReviewJson', () => reviewProblems(agent, sent, deps.state.subjects?.(spoolSid(ctx)) ?? [])) ?? []
          const m = memo(sessionOf(ctx) ?? `sub:${ctx.agent?.id ?? agent}`)
          if (problems.length > 0 && !m.reviewBlocked) {
            m.reviewBlocked = true
            return { reason: denyReason('H19', reviewYieldReason(agent, problems)), hook: 'H19' }
          }
          if (problems.length > 0) log('warn', 'omp: a review report is still not valid review JSON; let through', { agent, problems: problems.slice(0, 6) })
        }
      }
      return undefined
    }

    /** tool_call is omp's preTool: a denial becomes `block` with the pipeline's reason, the context one deduplicated note. */
    const toolCall = async (event: OmpToolCallEvent, ctx: OmpContext): Promise<OmpToolCallResult | undefined> => {
      const sid = sessionOf(ctx)
      const lc = liveOrDefaults()
      const cwd = ctx.cwd
      const input = event.input !== null && typeof event.input === 'object' ? event.input : {}
      const home = guarded('home', () => deps.home())
      const cls = classifyTool(H, event.toolName, input, cwd, data.mcpIds, { homeTilde: home })
      const targets = cls.kind === 'edit' || cls.kind === 'patch' ? guarded('edit targets', () => editTargets(input, cwd, deps.readText, home)) : undefined
      const callPaths = toolPaths(cls.paths, targets)
      const device = isDeviceWrite(event.toolName, input)
      const plain: ToolCall = { harness: H, sessionId: sid ?? '', cwd, tool: event.toolName, input, ...cls, paths: callPaths }
      const call = device ? deviceCall(plain) : plain
      const lsid = spoolSid(ctx)
      const d = pipe(sid ?? '', lc)
      const deny = (reason: string, hook: HookId): OmpToolCallResult => {
        log('info', 'omp: tool call blocked', { hook, tool: event.toolName, sid })
        denied(event.toolCallId)
        return { block: true, reason }
      }
      await started(sid)
      const own = await ownDenial(event, ctx, input, d)
      if (own !== undefined) return deny(own.reason, own.hook)
      const edit = WRITE_KINDS.has(call.kind)
      const decision = await preTool({
        call, now: deps.now(), subagent: !isMain(ctx), guardsOnly: sid === undefined,
        usage: lsid !== undefined && !device,
        ...(edit && !device ? { edits: callPaths } : {}),
      }, {
        ...d,
        // A reviewer's shell is read-only; a check that cannot run denies, like the guard before it.
        shellDenial: async command => {
          if (isMain(ctx)) return undefined
          try { return corePolicy.reviewerShellDenial(ctx.agent?.name, command) } catch (e) {
            report('H01 guard', e, 'blocked')
            return guardFailed('H01', e)
          }
        },
        writeTargets: c => (edit && c.paths.length > 0
          ? { paths: c.paths, contents: guard => ompWriteContents(c.tool, c.input, c.paths, c.cwd, guard.home, guard.realpath) }
          : undefined),
        nativeOff: () => ompOffServers(cwd),
        usage: (c, health) => {
          if (lsid === undefined) return undefined
          const plan: UsagePlan = { call: c, ledgerId: lsid, available: availableServers(data.mcp, health) }
          const edits = edit ? editsFor(c, targets) : undefined
          if (edits !== undefined) plan.edits = edits
          return plan
        },
      })
      if (decision.action === 'deny') {
        // omp asks the user itself (consent-ask.ts): the held command's need waits for the dialog.
        if (decision.hook === 'H20' && sid !== undefined && call.command !== undefined && typeof event.toolCallId === 'string') {
          const command = call.command
          const need = guarded('H20 need', () => heldConsentNeed(H, sid, command))
          if (need !== undefined) {
            consentHolds.set(event.toolCallId, need)
            if (consentHolds.size > 64) consentHolds.delete(consentHolds.keys().next().value as string)
          }
        }
        return deny(decision.reason, decision.hook)
      }
      const lines = [...new Set(decision.context.map(c => c.trim()).filter(c => c !== ''))]
      return lines.length > 0 ? { additionalContext: lines.join('\n') } : undefined
    }

    pi.on('tool_call', async (event: OmpToolCallEvent, ctx: OmpContext): Promise<OmpToolCallResult | undefined> => {
      const fenced = fenceToolCall(deps.reviewerFence?.(), event)
      if (fenced !== undefined) return fenced
      try {
        return await judgeWithConsent(ctx, {
          judge: () => withDeadline(toolCall(event, ctx), deps.timings.toolCallMs, undefined),
          take: () => { const need = consentHolds.get(event.toolCallId); consentHolds.delete(event.toolCallId); return need },
          record: (need, answer) => {
            const sid = sessionOf(ctx)
            return sid !== undefined && guarded('H20 grant', () => { deps.recordAskGrant(sid, need.kind, answer, deps.now()); return true }) === true
          },
          cleared: () => { deniedCalls.delete(event.toolCallId) },
        })
      } catch (e) {
        report('tool_call', e)
        return undefined
      }
    })

    const skillLoaded = (id: string, ctx: OmpContext): void => {
      const now = deps.now()
      const sid = sessionOf(ctx)
      if (isMain(ctx) && sid !== undefined && flowDef(id) !== undefined) {
        guarded('H25 flow start', () => deps.flow.start(sid, { workflow: id, source: 'skill' }, now))
        refreshFlowSafe(ctx)
      }
    }

    const savedPlans = async (ctx: OmpContext, signal: PlanSignal): Promise<string | undefined> => {
      const files = await capturePlans(deps.plans, ctx.cwd, deps.now(), signal, sessionOf(ctx)).catch((e: unknown) => { report('H12 plan capture', e); return [] as SavedPlan[] })
      if (files.length === 0) return undefined
      await spoolTo(spoolSid(ctx), [{ ts: deps.now(), ev: 'note', paths: files.map(f => f.path) }])
      const note = planSavedNote(files, ctx.cwd)
      if (hasTui(ctx)) guarded('H12 notify', () => ctx.ui.notify(note, 'info'))
      return note
    }

    /** tool_result is omp's postTool; the receipt, the todo list, the workflow band and plan capture are omp's own. */
    const toolResult = async (event: OmpToolResultEvent, ctx: OmpContext): Promise<OmpToolResultResult | undefined> => {
      const input = event.input !== null && typeof event.input === 'object' ? event.input : {}
      const home = guarded('home', () => deps.home())
      const now = deps.now()
      const cls = classifyTool(H, event.toolName, input, ctx.cwd, data.mcpIds, { homeTilde: home })
      const device = isDeviceWrite(event.toolName, input)
      const targets = cls.kind === 'edit' || cls.kind === 'patch' ? guarded('edit targets', () => editTargets(input, ctx.cwd, deps.readText, home)) : undefined
      const files = toolPaths(cls.paths, targets)
      const main = isMain(ctx)
      const sid = sessionOf(ctx)
      const lsid = spoolSid(ctx)
      const server = cls.kind === 'mcp' && !device && lsid !== undefined ? cls.mcp?.server : undefined
      const wasDenied = deniedCalls.delete(event.toolCallId)
      if (!wasDenied && main && sid !== undefined && !device) {
        guarded('turn receipt', () => receipts.tool(sid, ctx, event, { kind: cls.kind, files, targets, ...(cls.command !== undefined ? { command: cls.command } : {}) }))
      }
      if (main && sid !== undefined) {
        const todos = guarded('H06 todos', () => openTodosOf(event))
        if (todos !== undefined) memo(sid).todos = todos
      }
      if (!event.isError) {
        const skill = guarded('H24 skillOf', () => skillOf({ tool: event.toolName, input, kind: cls.kind, ...(cls.command !== undefined ? { command: cls.command } : {}) }, H))
        if (skill !== undefined) guarded('skill load', () => skillLoaded(skill, ctx))
        else if ((cls.kind === 'bash' && (cls.command ?? '').includes('buracle')) || WRITE_KINDS.has(cls.kind)) refreshFlowSafe(ctx)
      }
      let planNote: string | undefined
      if (main && approvingResult(event)) {
        const file = guarded('H12 plan file', () => planFileOf(event.details, ctx.sessionManager.getArtifactsDir?.(), ctx.cwd))
        const plan = file !== undefined ? deps.readText(file) : undefined
        planNote = await savedPlans(ctx, { approved: true, ...(plan !== undefined ? { plan } : {}) })
      }
      // A subagent's calls belong to the main session's spool, ledger and workspace.
      const owner = lsid ?? sid
      if (owner === undefined) return planNote !== undefined ? { additionalContext: planNote } : undefined
      await started(sid)
      const edited = !event.isError && WRITE_KINDS.has(cls.kind) && files.length > 0
      const r = await postTool({
        sessionId: owner, cwd: ctx.cwd, now, subagent: !main, entries: [],
        answered: main && event.toolName === 'ask' && !wasDenied && event.isError !== true && corePolicy.questionAnswered(event.content),
        ...(edited ? { edit: { ok: true, paths: files, added: addedTextOf(cls.kind, input, files, ctx.cwd, targets, home), removed: () => removedTextOf(cls.kind, input, files, targets) } } : {}),
        ...(server !== undefined ? { mcp: { server: () => server, ok: !event.isError } } : {}),
      }, {
        ...pipe(owner),
        fileChecks: {
          now: () => deps.now(),
          run: async (argv, opts) => {
            const res = await deps.run(argv, { ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}), ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}), ...(opts?.env !== undefined ? { env: opts.env as Record<string, string> } : {}) })
            return { code: res.code, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut }
          },
          core: deps.checkers,
          ...(deps.checkFs !== undefined ? { fs: deps.checkFs } : {}),
          ...(deps.resolveChecker !== undefined ? { resolve: deps.resolveChecker } : {}),
        },
        editBudgetMs: OMP_H04_BUDGET_MS,
      })
      if (planNote !== undefined) return { additionalContext: planNote }
      return r.context.length > 0 ? { additionalContext: r.context.join('\n\n') } : undefined
    }

    pi.on('tool_result', async (event: OmpToolResultEvent, ctx: OmpContext): Promise<OmpToolResultResult | undefined> => {
      const masked = guarded('mask', () => maskResult(event, ctx, { redact: liveOrDefaults().config.guards.redact, mcpIds: data.mcpIds, home: deps.home() }))
      const withMasked = (r: OmpToolResultResult | undefined): OmpToolResultResult | undefined => (masked === undefined ? r : { ...(r ?? {}), content: masked })
      try {
        return withMasked(await withDeadline(toolResult(event, ctx), deps.timings.toolResultMs, undefined))
      } catch (e) {
        report('tool_result', e)
        return withMasked(undefined)
      }
    })

    const route = (sid: string, text: string, lc: LiveConfig): PromptRouting => {
      const strictness = lc.config.routing.strictness
      const ledger = deps.ledger.load(sid)
      const o: Parameters<typeof promptRouting>[2] = { loaded: Object.keys(ledger.skills), available: availableNow(sid), strictness }
      const pd = deps.projectDeps(readWorkspace(actx(lc), H, sid)?.root)
      if (pd !== undefined) o.deps = pd
      return promptRouting(text, routerFor(strictness), o)
    }

    const literalSkillAsk = (text: string): string => text.replace(/^\/skill:/, '/buracle:')

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
      const router = routerFor(liveOrDefaults().config.routing.strictness)
      const routes = batch.flatMap(p => (p.route !== undefined ? [p.route] : []))
      let routed: string | undefined
      if (routes.length > 0) {
        const merged = mergeRoutes(routes, router.compiled)
        guarded('H24 ledger turn', () => deps.ledger.update(sid, l => ledgerPrompt(l, merged, now)))
        routed = guarded('H22 routeText', () => routeText(merged, H, router.policy, { triggers: router.compiled }))
      }
      const parts = [...new Set([...batch.flatMap(p => p.before), ...(routed !== undefined ? [routed] : []), ...batch.flatMap(p => p.after)])]
      const lines = fitParts(parts, PROMPT_CONTEXT_MAX_CHARS)
      const text = lines.length > 0 ? lines.join('\n\n') : undefined
      m.delivered = { prompt, text }
      return text
    }

    const agentIdle = (ctx: OmpContext): boolean =>
      guarded('isIdle', () => ctx.isIdle?.()) === true && guarded('hasPendingMessages', () => ctx.hasPendingMessages?.()) !== true

    /**
     * The pipeline's prompt event for one input. Shell input and commands that start no turn are no user text; the
     * context of the others waits in the queue for `before_agent_start`. Returns false for the stop guard's own text.
     */
    const onPrompt = async (sid: string, raw: string, ctx: OmpContext, expanded: boolean): Promise<boolean> => {
      const now = deps.now()
      const lc = liveOrDefaults()
      const m = memo(sid)
      const idle = agentIdle(ctx)
      const wfExpanded = expanded ? workflowOfExpanded(raw) : undefined
      const text = wfExpanded !== undefined ? wfExpanded.args : raw.trim()
      const model = wfExpanded !== undefined || isModelPrompt(text)
      const literalSkill = expanded && wfExpanded === undefined && /^\/skill:[a-z0-9]/.test(text)
      const wf = !model ? undefined : wfExpanded !== undefined ? { ...wfExpanded, via: 'command' as const } : literalSkill ? undefined : guarded('H25 workflow', () => workflowOfInput(text, data.commands))
      let routed: PromptRouting | undefined
      let warning: string | undefined
      const r = await promptEvent({ harness: H, sessionId: sid, cwd: ctx.cwd, text, now, ...(model ? {} : { userText: false }) }, {
        ...pipe(sid, lc),
        routePrompt: async () => {
          if (text === '') return undefined
          routed = route(sid, literalSkill ? literalSkillAsk(text) : text, lc)
          return { route: routed.route, deferred: true, ...(routed.text !== undefined ? { text: routed.text } : {}) }
        },
        ...(wf !== undefined ? { typedWorkflow: wf.workflow } : {}),
        readOnly: () => planModeOn(ctx),
        // The warning of the turn before (H05), for a prompt that reaches the model.
        contextWarning: () => {
          if (!model) return undefined
          warning = m.contextWarning
          m.contextWarning = undefined
          return warning
        },
      })
      if (r.continuation) {
        // The guard's own text reaches no queue: the warning waits for the user's next prompt.
        if (warning !== undefined) m.contextWarning = warning
        return false
      }
      m.noticed = false
      if (!expanded) {
        m.inputSeen = true
        if (idle) m.queued = undefined
      }
      if (!model) return true
      if (idle) receipts.prompt(sid)
      if (wf !== undefined) {
        const start = wf.args !== '' ? { workflow: wf.workflow, title: wf.args, source: 'command' as const } : { workflow: wf.workflow, source: 'command' as const }
        guarded('H25 flow start', () => deps.flow.start(sid, start, now))
      }
      const found = routed as PromptRouting | undefined
      const at = found?.text !== undefined ? r.context.indexOf(found.text.trim()) : -1
      const queued = m.queued ??= []
      queued.push({ before: at >= 0 ? r.context.slice(0, at) : r.context, after: at >= 0 ? r.context.slice(at + 1) : [], ...(found !== undefined ? { route: found.route } : {}) })
      if (queued.length > MAX_QUEUED_PROMPTS) queued.splice(0, queued.length - MAX_QUEUED_PROMPTS)
      refreshFlowSafe(ctx)
      return true
    }

    pi.on('input', async (event: OmpInputEvent, ctx: OmpContext): Promise<undefined> => {
      try {
        if (!isMain(ctx) || event.source === 'extension') return undefined
        const sid = sessionOf(ctx)
        if (sid === undefined) return undefined
        await started(sid)
        await onPrompt(sid, typeof event.text === 'string' ? event.text : '', ctx, false)
      } catch (e) {
        report('input', e)
      }
      return undefined
    })

    const block = (parts: readonly string[]): string => (parts.length > 0 ? ['<buracle-context>', ...parts, '</buracle-context>'].join('\n\n') : '')

    const subagentBlock = async (sid: string, ctx: OmpContext): Promise<string> => {
      const d = pipe(sid)
      const text = await d.step('H21 workspace', '', () => workspaceStart({ sessionId: sid, cwd: ctx.cwd, subagent: true, now: deps.now() }, d))
      return block(text.trim() !== '' ? [text.trim()] : [])
    }

    /** The capability card (H15) with the servers that are up for this session. */
    const card = (ctx: OmpContext): string => {
      const health = healthFor(spoolSid(ctx), ctx.cwd)
      const policy = { ...data.routing, strictness: liveOrDefaults().config.routing.strictness }
      return deps.policy.capabilityCard({ policy, mcp: data.mcp.filter(s => !mcpUnavailable(health[s.id])), plugins: data.plugins, harness: H })
    }

    const scheduleMaint = (ctx: OmpContext): void => {
      if (maintScheduled || typeof ctx.setTimeout !== 'function') return
      maintScheduled = true
      ctx.setTimeout(() => {
        const keep = new Set<string>([...memos.keys(), ...(currentSid !== undefined ? [currentSid] : [])])
        const removed = guarded('H16 session maintenance', () => deps.prune(keep, deps.now())) ?? []
        if (removed.length > 0) log('info', 'omp: pruned idle session state', { count: removed.length })
      }, deps.timings.maintDelayMs)
    }

    const endSession = async (sid: string): Promise<void> => {
      await sessionEnd({ harness: H, sessionId: sid, now: deps.now() }, pipe(sid))
    }

    /**
     * The pipeline's sessionStart for a main session, after the end of the one it replaces. Its context is the block
     * `before_agent_start` adds to the system prompt; the release notice goes out as omp's own message and toast, the
     * profile warning as a toast.
     */
    const openSession = (sid: string, ctx: OmpContext, source: string, previous?: string): Promise<void> => {
      const m = memo(sid)
      let ready!: () => void
      m.ready = new Promise<void>(res => { ready = res })
      m.starting = (async () => {
        if (previous !== undefined) await endSession(previous)
        const d = pipe(sid)
        const then = <A extends unknown[]>(fn: (...a: A) => Promise<void>) => (...a: A): Promise<void> => { ready(); return fn(...a) }
        const r = await sessionStart({ harness: H, sessionId: sid, cwd: ctx.cwd, source, now: deps.now() }, {
          ...d,
          // The usage ledger is reset before the memory UI hears of the session: from there on a tool call may be counted.
          ui: { ...d.ui, started: then(d.ui.started), seen: then(d.ui.seen) },
          capabilityCard: () => card(ctx),
          // The extension is a built copy, so the version that runs is the one baked into it.
          version: () => data.buracleVersion,
          sessionMaint: () => { scheduleMaint(ctx) },
        })
        const notice = r.notice
        m.startContext = r.context.filter(part => part !== notice?.model)
        // The profile warning (H17) is a toast for the user; it never enters the model's context.
        const warning = r.profile
        if (warning !== undefined) {
          log('warn', 'omp: H17 profile guard', { sid, warning })
          if (hasTui(ctx)) guarded('H17 notify', () => ctx.ui.notify(warning, 'warning'))
        }
        if (notice === undefined) return
        guarded('H17 notice', () => pi.sendMessage({ customType: NOTICE_MESSAGE_TYPE, content: notice.model, display: false }, { deliverAs: 'nextTurn' }))
        if (hasTui(ctx)) guarded('H17 notice notify', () => ctx.ui.notify(notice.user, 'info'))
      })().catch((e: unknown) => { report('session start', e) }).finally(ready)
      return m.ready
    }

    pi.on('before_agent_start', async (event: OmpBeforeAgentStartEvent, ctx: OmpContext): Promise<OmpBeforeAgentStartResult | undefined> => {
      await withDeadline(fenceActiveTools(pi, deps.reviewerFence?.()).catch(e => { report('second-opinion tools', e); return [] }), FENCE_TOOLS_WAIT_MS, [])
      if (process.env['BURACLE_MEMORY_RUNNER'] === '1') return undefined
      try {
        const sid = sessionOf(ctx)
        if (sid === undefined) return undefined
        const m = memo(sid)
        const base = Array.isArray(event.systemPrompt) ? event.systemPrompt : []
        if (!isMain(ctx)) {
          m.block ??= subagentBlock(sid, ctx).catch(e => { report('subagent block', e); return '' })
          const text = await m.block
          return text !== '' && !base.includes(text) ? { systemPrompt: [...base, text] } : undefined
        }
        // A session omp announced no start for begins here, without the steps of a fresh one.
        if (m.starting === undefined) void openSession(sid, ctx, 'resume')
        await started(sid)
        const prompt = typeof event.prompt === 'string' ? event.prompt : ''
        if (m.inputSeen !== true && ctx.mode !== 'tui' && ctx.mode !== 'rpc' && prompt !== m.lastPrompt && corePolicy.isUserText(prompt)
          && await onPrompt(sid, prompt, ctx, true).catch((e: unknown) => { report('prompt', e); return false })) m.lastPrompt = prompt
        m.inputSeen = false
        const routed = guarded('H22 delivery', () => deliver(sid, prompt))
        const saved = await savedPlans(ctx, { prompt })
        const message = [routed, saved].filter((t): t is string => t !== undefined).join('\n\n')
        await m.starting
        const text = block(m.startContext ?? [])
        const result: OmpBeforeAgentStartResult = {}
        if (text !== '' && !base.includes(text)) result.systemPrompt = [...base, text]
        if (message !== '') result.message = { customType: PROMPT_MESSAGE_TYPE, content: message, display: false }
        return result.systemPrompt !== undefined || result.message !== undefined ? result : undefined
      } catch (e) {
        report('before_agent_start', e)
        return undefined
      }
    })

    const writeTelemetryFor = (sid: string, ctx: OmpContext) => { guarded('telemetry', () => deps.state.telemetry(sid, telemetryOf(pi, ctx, deps.now(), guarded))) }

    const refreshSoon = (ctx: OmpContext) => {
      status.refresh(ctx).catch(e => report('status', e))
      pane.refresh(ctx).catch(e => report('status pane', e))
      refreshFlowSafe(ctx)
    }

    pi.on('turn_end', async (event: OmpTurnEndEvent, ctx: OmpContext): Promise<undefined> => {
      try {
        if (!isMain(ctx)) return undefined
        const sid = sessionOf(ctx)
        if (sid === undefined) return undefined
        writeTelemetryFor(sid, ctx)
        guarded('H05 context watch', () => contextCheck({ pi, guarded }, memo(sid), ctx, event))
        const text = messageText(event.message)
        const entry: SpoolEntry = { ts: deps.now(), ev: 'turn' }
        const model = strAt(event.message, 'model') ?? ctx.model?.id
        if (model) entry.model = model
        const tokens = numAt(event.message, 'usage', 'totalTokens')
        if (tokens !== undefined) entry.tokens = tokens
        if (text.trim() !== '') entry.excerpt = clip(text, 2000)
        await spoolTo(sid, [entry])
        refreshSoon(ctx)
      } catch (e) {
        report('turn_end', e)
      }
      return undefined
    })

    registerStopGuard(pi, {
      deps, pipe, guarded, report: (what, e) => report(what, e), spool: spoolTo,
      released: (sid, ctx) => receipts.end(sid, ctx),
      noticed: { get: sid => memo(sid).noticed === true, set: sid => { memo(sid).noticed = true } },
    })

    registerCompaction(pi, { deps, pipe, guarded, report: (what, e) => report(what, e), spool: spoolTo, todos: sid => memo(sid).todos ?? [] })

    /** The session events of omp: the pipeline's sessionEnd for the session left behind, then its sessionStart. */
    const startSession = (ctx: OmpContext, ev: string, event: unknown): Promise<void> | undefined => {
      const sid = sessionOf(ctx)
      if (sid === undefined) return undefined
      const previous = currentSid !== undefined && currentSid !== sid ? currentSid : undefined
      currentSid = sid
      deps.setEnv('BURACLE_SESSION_ID', sid)
      deps.setEnv('BURACLE_HARNESS', H)
      const resumed = guarded('resumed session', () => resumedSession(ev, event, ctx, f => deps.isFile(f))) === true
      if (resumed) guarded('resume hint', () => receipts.resumed(sid, ctx, live().config))
      const m = memo(sid)
      void slugOf(sid, ctx.cwd)
      guarded('telemetry', () => writeTelemetryFor(sid, ctx))
      if (hasTui(ctx)) {
        m.flow?.reset()
        refreshSoon(ctx)
        if (!statusTimerStarted && typeof ctx.setInterval === 'function') {
          statusTimerStarted = true
          ctx.setInterval(() => refreshSoon(ctx), deps.timings.statusIntervalMs)
        }
      }
      if (previous === undefined && m.starting !== undefined) return m.ready
      // A fresh session is a startup, a new one in the same process a clear; a resumed or branched one keeps its ledger.
      const source = ev === 'session_start' ? (resumed ? 'resume' : 'startup') : ev === 'session_switch' && !resumed ? 'clear' : 'resume'
      return openSession(sid, ctx, source, previous)
    }

    for (const ev of ['session_start', 'session_switch', 'session_branch']) {
      pi.on(ev, async (event: unknown, ctx: OmpContext): Promise<undefined> => {
        try { if (isMain(ctx)) await startSession(ctx, ev, event) } catch (e) { report(ev, e) }
        return undefined
      })
    }

    pi.on('session_shutdown', async (_event: unknown, ctx: OmpContext): Promise<undefined> => {
      try {
        if (!isMain(ctx)) return undefined
        const sid = sessionOf(ctx) ?? currentSid
        if (sid !== undefined) await endSession(sid)
      } catch (e) {
        report('session_shutdown', e)
      }
      return undefined
    })

    registerUtilityCommands(pi, {
      cli: () => deps.cli(),
      run: (argv, opts) => deps.run(argv, opts),
      status: (view, ctx) => status.lines(view, ctx),
      pane: (view, ctx) => pane.toggle(view, ctx),
      report: (what, e) => report(what, e),
    })
  }
}

export default createBuracleExtension(GENERATED ?? emptyGenerated())
