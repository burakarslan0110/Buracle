import type { BuracleConfig } from '../../../core/config'
import { CM_SERVER_ID } from '../../../core/context-mode'
import type { HookId, ToolCall, ToolKind } from '../../../core/events'
import { classifyTool } from '../../../core/events'
import { flowDef } from '../../../core/flow/catalog'
import { profileSignalsFromPrompt, profileUsageSignal } from '../../../core/memory/profile'
import { spoolPromptExcerpt } from '../../../core/memory/spool'
import * as corePolicy from '../../../core/policy/index'
import type { BashGuardOptions } from '../../../core/policy/bash-guard'
import type { PromptRoute } from '../../../core/policy/skill-router'
import { PROMPT_CONTEXT_MAX_CHARS, routeText } from '../../../core/policy/skill-router'
import { withDisabledServers, type McpHealth } from '../../../core/policy/routing'
import type { ReminderContext, ReminderResult } from '../../../core/policy/usage'
import { ledgerCall, ledgerPrompt, reminders, skillOf } from '../../../core/policy/usage'
import type { WriteGuardContext } from '../../../core/policy/write-guard'
import type { ContextBand } from '../../../core/status/context'
import type { WorkspaceInfo } from '../../../core/workspace'
import { indexExclusion, workspaceContext, workspaceNotice } from '../../../core/workspace'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'
import { canonicalDir, caseInsensitivePaths, exclusionContext } from '../../../workflow/workspace'
import { selfPaths } from '../../shared/self-paths'
import { CONFIG_PARSERS } from '../../shared/write-content'
import { addedTextOf, checkFiles, ledgerOnceFn, removedTextOf } from './checks'
import { registerUtilityCommands } from './commands'
import { registerCompaction } from './compaction'
import { fenceActiveTools, fenceToolCall } from './companion-fence'
import { judgeWithConsent, type ConsentNeed } from './consent-ask'
import { heldConsentNeed } from './consent-held'
import type { LiveConfig } from './config'
import { CM_RESTORE_MESSAGE_TYPE, cmGuard, createCmBridge, isCmToolName } from './context-mode'
import { CODE_EXECUTION_TOOLS, defaultDeps, emptyGenerated, type ExtensionDeps } from './deps'
import { editTargets, type EditTargets } from './edits'
import { FlowWidget, flowWidgetLines } from './flow-widget'
import { hideTools } from './hidden-tools'
import { StatusPane } from './pane'
import { createTurnReceipts } from './receipt'
import { workflowOfExpanded, workflowOfInput } from './flow-track'
import type { SpoolEntry } from './memory'
import { GENERATED } from './generated-data'
import { ompMcpWritePaths, ompWriteContents } from './write-check'
import { fitPrompt, isModelPrompt, PROMPT_MESSAGE_TYPE } from './prompt'
import { approvingResult, capturePlans, planFileOf, planSavedNote, type PlanSignal, type SavedPlan } from './plan-capture'
import { earlyEditNote, readOnlyStart } from './plan-mode'
import { contextCheck, startupNotice } from './session-notes'
import { reviewAgentOf, reviewProblems, reviewYieldReason, yieldReport } from './review'
import { availableServers, isDeviceWrite, mergeRoutes, promptRouting, recordMcpResult, rootCheck, routerData, sessionHealth, workspaceFacts, type RouterData, type RootEnv } from './routing'
import { resumedSession, telemetryOf } from './session-facts'
import { createStatusTexts } from './status'
import { promptGuidance, registerStopGuard } from './stop'
import { maskResult, openTodosOf } from './tool-output'
import type {
  OmpBeforeAgentStartEvent, OmpBeforeAgentStartResult, OmpContext, OmpExtensionAPI, OmpGenerated, OmpInputEvent,
  OmpToolCallEvent, OmpToolCallResult, OmpToolResultEvent, OmpToolResultResult, OmpTurnEndEvent,
} from './types'
import { clip, hasTui, isMain, messageText, numAt, sessionOf, strAt, withDeadline } from './util'

export { CODE_EXECUTION_TOOLS, defaultDeps, emptyGenerated, STATUS_INTERVAL_MS, TOOL_CALL_DEADLINE_MS, TOOL_RESULT_DEADLINE_MS } from './deps'
export type { EvalGuard, ExtensionDeps } from './deps'
export { STATUS_KEYS, WIDGET_KEY } from './status'
export { runawayNotice, stopReason } from './stop'

const WORKSPACE_WAIT_MS = 3_000
const HIDE_TOOLS_WAIT_MS = 2_000
const MAX_QUEUED_PROMPTS = 16
const WRITE_KINDS: ReadonlySet<ToolKind> = new Set(['edit', 'write', 'patch'])
const SPOOL_KINDS: ReadonlySet<ToolKind> = new Set(['bash', 'edit', 'write', 'patch', 'mcp', 'web_search', 'web_fetch'])

interface SessionMemo {
  capture?: boolean
  block?: Promise<string>
  context?: Promise<string | undefined>
  slug?: Promise<string | undefined>
  slugValue?: string
  workspace?: Promise<WorkspaceInfo | undefined>
  workspaceInfo?: WorkspaceInfo
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

interface QueuedPrompt {
  parts: Array<{ text: string | undefined, order: number }>
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
    let profileWarned = false
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
    const spool = (sid: string | undefined, entries: SpoolEntry[]) => {
      if (sid === undefined || entries.length === 0 || !captureOn(sid)) return
      deps.memory.appendSpool(sid, entries).catch(e => report('spool', e))
    }
    const usageSignal = (_lc: LiveConfig, what: 'workflow' | 'skill', id: string, now: number): SpoolEntry[] => {
      const signal = profileUsageSignal(what, id)
      return signal !== undefined ? [{ ts: now, ev: 'signal', signal }] : []
    }
    const routerFor = (strictness: BuracleConfig['routing']['strictness']): RouterData => {
      if (router === undefined || router.strictness !== strictness) router = { strictness, data: routerData(data.skills, data.routing, strictness) }
      return router.data
    }
    const healthFor = (lsid: string | undefined): McpHealth => {
      const raw = guarded('health', () => deps.health()) ?? {}
      const health = guarded('contextMode.enabled', () => liveOrDefaults().config.contextMode.enabled) !== false ? raw : withDisabledServers(raw, [CM_SERVER_ID])
      return guarded('H24 session health', () => sessionHealth(health, deps.ledger, lsid)) ?? health
    }
    const availableNow = (lsid: string | undefined): string[] => availableServers(data.mcp, healthFor(lsid))

    const workspaceOf = (sid: string, ctx: OmpContext): Promise<WorkspaceInfo | undefined> => {
      const m = memo(sid)
      m.workspace ??= deps.workspaceInfo(ctx.cwd, liveOrDefaults().config, deps.now()).then(i => { m.workspaceInfo = i; return i }, e => { report('H21 workspace', e); return undefined })
      return m.workspace
    }
    const rootEnv = (lc: LiveConfig): RootEnv => ({
      home: deps.home(),
      caseInsensitive: caseInsensitivePaths(),
      canonical: canonicalDir,
      excluded: dir => indexExclusion(dir, exclusionContext(lc.vault, lc.config.index.exclude)),
    })

    const status = createStatusTexts({
      data, deps, live, guarded,
      slug: sid => memo(sid).slugValue,
      band: { get: sid => memo(sid).band, set: (sid, text) => { memo(sid).band = text } },
    })

    const cm = createCmBridge({
      deps: deps.cm,
      config: () => liveOrDefaults().config,
      report: (what, e) => report(what, e),
      send: text => pi.sendMessage({ customType: CM_RESTORE_MESSAGE_TYPE, content: text, display: false }, { deliverAs: 'nextTurn' }),
    })
    const consentHolds = new Map<string, ConsentNeed>()
    const deniedCalls = new Set<string>()
    const denied = (id: unknown): void => {
      if (typeof id !== 'string' || id === '') return
      deniedCalls.add(id)
      if (deniedCalls.size > 256) deniedCalls.delete(deniedCalls.values().next().value as string)
    }

    pi.setLabel?.('Buracle')
    const receipts = createTurnReceipts({ now: () => deps.now(), view: sid => guarded('flow view', () => deps.flow.view(sid, deps.now(), liveOrDefaults().config.workflow.foldAfterSec)), desktop: (title, message) => deps.notifyDesktop(title, message), log: (msg, data) => log('debug', `omp: ${msg}`, data) })
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
      const view = deps.flow.view(sid, now, lc.config.workflow.foldAfterSec)
      widget.draw(ctx.ui, flowWidgetLines(view, deps.columns(), { emoji: lc.config.statusline.emoji, ansi: true }))
      const due = widget.foldDue(view, lc.config.workflow.foldAfterSec)
      if (due !== undefined && typeof ctx.setTimeout === 'function') ctx.setTimeout(() => refreshFlowSafe(ctx), Math.max(0, due - now) + 250)
    }
    const refreshFlowSafe = (ctx: OmpContext): void => { guarded('workflow band', () => refreshFlow(ctx)) }

    const closedGuard = (hook: 'H01' | 'H02', fn: () => { deny?: string }): { deny?: string } => {
      try { return fn() } catch (e) {
        report(`${hook} guard`, e, 'blocked')
        const msg = e instanceof Error ? e.message : String(e)
        return { deny: `the guard could not evaluate this call (${msg}), so it was blocked to stay safe. Run \`buracle doctor omp\`.` }
      }
    }

    const editsFor = (call: ToolCall, targets: EditTargets | undefined): ReminderContext['edits'] => {
      if (targets !== undefined) return targets.changes
      if (call.kind === 'write' && typeof call.input['content'] === 'string' && call.paths[0] !== undefined) {
        const file = call.paths[0]
        return [{ file, removed: deps.readText(file) ?? '', added: call.input['content'] }]
      }
      return undefined
    }

    const usageCheck = (lsid: string, call: ToolCall, ctx: OmpContext, lc: LiveConfig, targets: EditTargets | undefined): { deny?: string, context?: string } => {
      const strictness = lc.config.routing.strictness
      const info = memo(sessionOf(ctx) ?? lsid).workspaceInfo
      const rc = rootCheck(call, info, strictness, rootEnv(lc))
      if (rc.deny !== undefined) return { deny: rc.deny }
      if (rc.context !== undefined) {
        deps.ledger.update(lsid, l => ledgerCall(l, call))
        return { context: rc.context }
      }
      const rctx: ReminderContext = {
        strictness, reminders: lc.config.routing.reminders, available: availableNow(lsid), policy: routerFor(strictness).policy,
        facts: workspaceFacts(info, lc.config, { home: deps.home(), excluded: [lc.vault, paths.buracleHome()], caseInsensitive: caseInsensitivePaths(), codegraphIndexed: root => deps.codegraphIndexed(root) }),
      }
      if (WRITE_KINDS.has(call.kind)) {
        const edits = editsFor(call, targets)
        if (edits !== undefined) rctx.edits = edits
        const pd = deps.projectDeps(info?.root)
        if (pd !== undefined) rctx.deps = pd
      }
      let result: ReminderResult | undefined
      deps.ledger.update(lsid, l => { result = reminders(l, call, rctx); return result.next })
      const out: { deny?: string, context?: string } = {}
      if (result?.deny !== undefined) out.deny = result.deny.reason
      if (result?.context !== undefined) out.context = result.context
      return out
    }

    const toolCall = async (event: OmpToolCallEvent, ctx: OmpContext): Promise<OmpToolCallResult | undefined> => {
      const sid = sessionOf(ctx)
      const lc = liveOrDefaults()
      const cwd = ctx.cwd
      const input = event.input !== null && typeof event.input === 'object' ? event.input : {}
      const home = guarded('home', () => deps.home())
      const cls = classifyTool('omp', event.toolName, input, cwd, data.mcpIds, { homeTilde: home })
      const targets = cls.kind === 'edit' || cls.kind === 'patch' ? guarded('edit targets', () => editTargets(input, cwd, deps.readText, home)) : undefined
      const callPaths = toolPaths(cls.paths, targets)
      const call: ToolCall = { harness: 'omp', sessionId: sid ?? '', cwd, tool: event.toolName, input, ...cls, paths: callPaths }
      const deny = (reason: string, hook: HookId): OmpToolCallResult => {
        log('info', 'omp: tool call blocked', { hook, tool: event.toolName, sid })
        denied(event.toolCallId)
        return { block: true, reason: `Buracle ${hook}: ${reason.replace(/^Buracle:\s*/, '')}` }
      }
      const writeContext = (): WriteGuardContext => {
        const wctx: WriteGuardContext & { realpath?: (p: string) => string | undefined } = { cwd, home: deps.home(), vault: lc.vault, protect: lc.config.guards.write.protect, selfPaths: selfPaths(lc.config.repo), parsers: CONFIG_PARSERS }
        const repo = guarded('H02 buracleRepo', () => deps.buracleRepo(cwd, lc.repoRoot))
        if (repo !== undefined) wctx.buracleRepo = repo
        if (deps.realpath !== undefined) wctx.realpath = deps.realpath
        return wctx
      }
      const bashOptions = (): BashGuardOptions => {
        const w = writeContext()
        return {
          ...lc.config.guards.bash, selfPaths: selfPaths(lc.config.repo), cwd, ...(home !== undefined ? { home } : {}),
          vault: w.vault, protect: w.protect, ...(w.buracleRepo !== undefined ? { buracleRepo: w.buracleRepo } : {}), ...(w.realpath !== undefined ? { realpath: w.realpath } : {}),
        }
      }
      const device = isDeviceWrite(event.toolName, input)

      const cmv = cmGuard(call, {
        bash: bashOptions, write: writeContext, serverDir: () => deps.cm.projectDir(), cwd, agent: ctx.agent?.name, device, closed: closedGuard, lane: !isMain(ctx),
        consent: commands => (sid !== undefined && paths.isValidSessionId(sid) ? guarded('H20 consent', () => deps.consentGateAll(sid, commands, deps.now())) : undefined),
      })
      if (cmv?.deny !== undefined) return deny(cmv.deny, cmv.hook ?? 'H01')

      if (call.kind === 'bash' && call.command !== undefined) {
        const command = call.command
        const r = closedGuard('H01', () => deps.policy.checkBash(command, bashOptions()))
        if (r.deny) return deny(r.deny, 'H01')
        const lane = isMain(ctx) ? undefined : guarded('H01 lane guard', () => corePolicy.laneStateDenial(command))
        if (lane !== undefined) return deny(lane, 'H01')
        const reviewer = isMain(ctx) ? {} : closedGuard('H01', () => ({ deny: corePolicy.reviewerShellDenial(ctx.agent?.name, command) }))
        if (reviewer.deny) return deny(reviewer.deny, 'H01')
        if (sid !== undefined && paths.isValidSessionId(sid)) {
          const reason = guarded('H20 consent', () => deps.consentGate(sid, command, deps.now()))
          if (reason !== undefined) {
            const need = guarded('H20 need', () => heldConsentNeed(sid, command))
            if (need !== undefined && typeof event.toolCallId === 'string') {
              consentHolds.set(event.toolCallId, need)
              if (consentHolds.size > 64) consentHolds.delete(consentHolds.keys().next().value as string)
            }
            return deny(reason, 'H20')
          }
        }
      }
      if (WRITE_KINDS.has(call.kind) && call.paths.length > 0) {
        const r = closedGuard('H02', () => {
          const wctx = writeContext()
          const contents = ompWriteContents(event.toolName, input, call.paths, cwd, wctx.home, wctx.realpath)
          return deps.policy.checkWrite(call.paths, Object.keys(contents).length > 0 ? { ...wctx, contents } : wctx)
        })
        if (r.deny) return deny(r.deny, 'H02')
      }
      if (cmv === undefined && (call.kind === 'mcp' || device || event.toolName.startsWith('mcp__'))) {
        const r = closedGuard('H02', () => {
          const targets = ompMcpWritePaths(event.toolName, input, call.mcp, device)
          return targets.length > 0 ? deps.policy.checkWrite(targets, writeContext()) : {}
        })
        if (r.deny) return deny(r.deny, 'H02')
      }
      if (CODE_EXECUTION_TOOLS.has(event.toolName)) {
        const code = typeof input['code'] === 'string' ? input['code'] : ''
        const language = typeof input['language'] === 'string' ? input['language'] : 'js'
        let hook: 'H01' | 'H02' = 'H01'
        const r = closedGuard('H01', () => {
          const guard = deps.evalGuard
          if (guard === undefined) throw new Error('core checkEval is unavailable')
          const verdict = guard(code, language, writeContext(), { extraDeny: bashOptions().extraDeny })
          if (verdict.hook === 'H02') hook = 'H02'
          const lane = verdict.deny === undefined && !isMain(ctx) ? corePolicy.laneCodeDenial(code, language) : undefined
          return lane !== undefined ? { deny: lane } : verdict
        })
        if (r.deny) return deny(r.deny, hook)
      }
      const questionContext: string[] = []
      if (call.kind === 'ask_user' && sid !== undefined && isMain(ctx)) {
        const state = guarded('H09 state', () => deps.state.load(sid))
        if (state !== undefined) {
          const r = guarded('H09 checkQuestion', () => deps.policy.checkQuestion(state, call, deps.now()))
          if (r?.deny) return deny(r.deny, 'H09')
          if (r?.context !== undefined) questionContext.push(r.context)
        }
      }
      if (event.toolName === 'yield' && !isMain(ctx)) {
        const agent = reviewAgentOf(ctx.agent?.name)
        const report = agent !== undefined ? yieldReport(input) : undefined
        if (agent !== undefined && report !== undefined) {
          const problems = guarded('H19 validateReviewJson', () => reviewProblems(agent, report, deps.state.subjects?.(spoolSid(ctx)) ?? [])) ?? []
          const m = memo(sid ?? `sub:${ctx.agent?.id ?? agent}`)
          if (problems.length > 0 && !m.reviewBlocked) {
            m.reviewBlocked = true
            return deny(reviewYieldReason(agent, problems), 'H19')
          }
          if (problems.length > 0) log('warn', 'omp: a review report is still not valid review JSON; let through', { agent, problems: problems.slice(0, 6) })
        }
      }
      const context: string[] = [...questionContext]
      if (lc.config.routing.strictness !== 'off') {
        const policy = { ...data.routing, strictness: lc.config.routing.strictness }
        const d = guarded('H03 routeTool', () => deps.policy.routeTool(call, policy, healthFor(spoolSid(ctx))))
        if (d?.action === 'deny') return deny(d.reason, d.hook)
        if (d?.action === 'allow' && d.context) context.push(...d.context.filter(c => c.trim() !== ''))
      }
      const lsid = spoolSid(ctx)
      if (lsid !== undefined && !device) {
        const u = guarded('H24 usage', () => usageCheck(lsid, call, ctx, lc, targets))
        if (u?.deny !== undefined) return deny(u.deny, 'H03')
        if (u?.context !== undefined) context.push(u.context)
      }
      const early = WRITE_KINDS.has(call.kind) && sid !== undefined && !device ? guarded('H03 early edit', () => earlyEditNote(deps, sid, callPaths, cwd, lc.config.plan.planApproval)) : undefined
      if (early !== undefined) context.push(early)
      const lines = [...new Set(context.map(c => c.trim()))]
      const result: OmpToolCallResult = {}
      if (lines.length > 0) result.additionalContext = lines.join('\n')
      if (cmv?.input !== undefined) result.input = cmv.input
      return result.additionalContext !== undefined || result.input !== undefined ? result : undefined
    }

    const cmUnjudged = (why: string): OmpToolCallResult => ({
      block: true,
      reason: `Buracle H01: the guard could not evaluate this context-mode call (${why}), so it was blocked to stay safe. Run \`buracle doctor omp\`.`,
    })

    pi.on('tool_call', async (event: OmpToolCallEvent, ctx: OmpContext): Promise<OmpToolCallResult | undefined> => {
      const fenced = fenceToolCall(deps.reviewerFence?.(), event)
      if (fenced !== undefined) return fenced
      let cmTool = false
      try {
        cmTool = isCmToolName(event.toolName)
        return await judgeWithConsent(ctx, {
          judge: () => withDeadline(toolCall(event, ctx), deps.timings.toolCallMs, cmTool ? cmUnjudged('no answer in time') : undefined),
          take: () => { const need = consentHolds.get(event.toolCallId); consentHolds.delete(event.toolCallId); return need },
          record: (need, answer) => {
            const sid = sessionOf(ctx)
            return sid !== undefined && guarded('H20 grant', () => { deps.recordAskGrant(sid, need.kind, answer, deps.now()); return true }) === true
          },
          cleared: () => { deniedCalls.delete(event.toolCallId) },
        })
      } catch (e) {
        report('tool_call', e, cmTool ? 'blocked' : 'allowed')
        return cmTool ? cmUnjudged(e instanceof Error ? e.message : String(e)) : undefined
      }
    })

    const skillLoaded = (id: string, ctx: OmpContext): void => {
      const lc = live()
      const now = deps.now()
      const entries = usageSignal(lc, 'skill', id, now)
      const sid = sessionOf(ctx)
      if (isMain(ctx) && sid !== undefined && flowDef(id) !== undefined) {
        if (guarded('H25 flow start', () => deps.flow.start(sid, { workflow: id, source: 'skill' }, now)) === true) entries.push(...usageSignal(lc, 'workflow', id, now))
        refreshFlowSafe(ctx)
      }
      spool(spoolSid(ctx), entries)
    }

    const savedPlans = async (ctx: OmpContext, signal: PlanSignal): Promise<string | undefined> => {
      const files = await capturePlans(deps.plans, ctx.cwd, deps.now(), signal, sessionOf(ctx)).catch((e: unknown) => { report('H12 plan capture', e); return [] as SavedPlan[] })
      if (files.length === 0) return undefined
      spool(spoolSid(ctx), [{ ts: deps.now(), ev: 'note', paths: files.map(f => f.path) }])
      const note = planSavedNote(files, ctx.cwd)
      if (hasTui(ctx)) guarded('H12 notify', () => ctx.ui.notify(note, 'info'))
      return note
    }

    const toolResult = async (event: OmpToolResultEvent, ctx: OmpContext): Promise<OmpToolResultResult | undefined> => {
      const input = event.input !== null && typeof event.input === 'object' ? event.input : {}
      const home = guarded('home', () => deps.home())
      const cls = classifyTool('omp', event.toolName, input, ctx.cwd, data.mcpIds, { homeTilde: home })
      const device = isDeviceWrite(event.toolName, input)
      const targets = cls.kind === 'edit' || cls.kind === 'patch' ? guarded('edit targets', () => editTargets(input, ctx.cwd, deps.readText, home)) : undefined
      const files = toolPaths(cls.paths, targets)
      if (SPOOL_KINDS.has(cls.kind) && !device) {
        const entry: SpoolEntry = { ts: deps.now(), ev: 'tool', tool: event.toolName, kind: cls.kind }
        if (files.length > 0) entry.paths = files
        if (cls.kind === 'bash') {
          if (cls.command !== undefined) entry.cmd = cls.command
          entry.exit = numAt(event.details, 'exitCode') ?? (event.isError ? 1 : 0)
          const ms = numAt(event.details, 'wallTimeMs')
          if (ms !== undefined) entry.ms = ms
        }
        spool(spoolSid(ctx), [entry])
      }
      const server = cls.kind === 'mcp' && !device ? cls.mcp?.server : undefined
      const lsid = spoolSid(ctx)
      if (server !== undefined && server !== '' && lsid !== undefined) guarded('H24 MCP result', () => { recordMcpResult(deps.ledger, lsid, server, !event.isError, cls.mcp?.tool) })
      const wasDenied = deniedCalls.delete(event.toolCallId)
      const sid = sessionOf(ctx)
      if (!wasDenied && isMain(ctx) && sid !== undefined && !device) {
        guarded('turn receipt', () => receipts.tool(sid, ctx, event, { kind: cls.kind, files, targets, ...(cls.command !== undefined ? { command: cls.command } : {}) }))
        cm.toolResult(sid, { toolName: event.toolName, input, content: event.content, isError: event.isError }, { cwd: ctx.cwd, ...(cls.kind === 'edit' || cls.kind === 'patch' ? { paths: files } : {}) })
      }
      if (isMain(ctx) && sid !== undefined) {
        const todos = guarded('H06 todos', () => openTodosOf(event))
        if (todos !== undefined) memo(sid).todos = todos
        if (event.toolName === 'ask' && !wasDenied && event.isError !== true && corePolicy.questionAnswered(event.content)) {
          guarded('H08 answer receipt', () => deps.state.update(sid, s => deps.plan.answerReceipt(s, deps.now())))
        }
      }
      if (!event.isError) {
        const skill = guarded('H24 skillOf', () => skillOf({ tool: event.toolName, input, kind: cls.kind, ...(cls.command !== undefined ? { command: cls.command } : {}) }, 'omp'))
        if (skill !== undefined) guarded('skill load', () => skillLoaded(skill, ctx))
        else if ((cls.kind === 'bash' && (cls.command ?? '').includes('buracle')) || WRITE_KINDS.has(cls.kind)) refreshFlowSafe(ctx)
      }
      if (isMain(ctx) && approvingResult(event)) {
        const file = guarded('H12 plan file', () => planFileOf(event.details, ctx.sessionManager.getArtifactsDir?.(), ctx.cwd))
        const plan = file !== undefined ? deps.readText(file) : undefined
        const note = await savedPlans(ctx, { approved: true, ...(plan !== undefined ? { plan } : {}) })
        if (note !== undefined) return { additionalContext: note }
      }
      const cfg = live().config.checkers
      if (event.isError || !WRITE_KINDS.has(cls.kind) || files.length === 0) return undefined
      const root = sid !== undefined ? memo(sid).workspaceInfo?.root : undefined
      const once = ledgerOnceFn(deps.ledger, lsid)
      const host = { deps, guarded, report, ...(once !== undefined ? { once } : {}) }
      const opts = { ...(root !== undefined ? { root } : {}), ...(home !== undefined ? { home } : {}), removed: removedTextOf(cls.kind, input, files, targets) }
      const notes = cfg.enabled ? await checkFiles(host, files, addedTextOf(cls.kind, input, files, ctx.cwd, targets, home), ctx.cwd, cfg, opts) : []
      const assets = guarded('H28 project assets', () => deps.projectAssets.afterEdit(root, files, deps.now()))
      if (assets !== undefined) notes.push(assets)
      return notes.length > 0 ? { additionalContext: notes.join('\n\n') } : undefined
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

    const route = (sid: string, text: string, lc: LiveConfig): PromptRoute => {
      const strictness = lc.config.routing.strictness
      const ledger = deps.ledger.load(sid)
      const o: Parameters<typeof promptRouting>[2] = { loaded: Object.keys(ledger.skills), available: availableNow(sid), skills: lc.config.routing.skills, strictness }
      const pd = deps.projectDeps(memo(sid).workspaceInfo?.root)
      if (pd !== undefined) o.deps = pd
      return promptRouting(text, routerFor(strictness), o).route
    }

    const literalSkillAsk = (text: string): string => text.replace(/^\/skill:/, '/buracle:')

    const deliver = (sid: string, prompt: string): string | undefined => {
      const m = memo(sid)
      const batch = m.queued ?? []
      if (batch.length === 0) {
        if (m.delivered?.prompt === prompt) return m.delivered.text
        m.delivered = undefined
        return undefined
      }
      if (guarded('H10 isGuardContinuation', () => deps.policy.isGuardContinuation(prompt)) === true) return undefined
      m.queued = undefined
      const now = deps.now()
      const router = routerFor(liveOrDefaults().config.routing.strictness)
      const routes = batch.flatMap(p => (p.route !== undefined ? [p.route] : []))
      const parts = batch.flatMap(p => p.parts)
      if (routes.length > 0) {
        const merged = mergeRoutes(routes, router.compiled)
        guarded('H24 ledger turn', () => deps.ledger.update(sid, l => ledgerPrompt(l, merged, now)))
        parts.push({ text: guarded('H22 routeText', () => routeText(merged, 'omp', router.policy, { triggers: router.compiled })), order: 1 })
      }
      const unique: QueuedPrompt['parts'] = []
      for (const p of [...parts].sort((a, b) => a.order - b.order)) if (p.text !== undefined && !unique.some(u => u.text === p.text)) unique.push(p)
      const lines = fitPrompt(unique, PROMPT_CONTEXT_MAX_CHARS)
      const text = lines.length > 0 ? lines.join('\n\n') : undefined
      m.delivered = { prompt, text }
      return text
    }

    const agentIdle = (ctx: OmpContext): boolean =>
      guarded('isIdle', () => ctx.isIdle?.()) === true && guarded('hasPendingMessages', () => ctx.hasPendingMessages?.()) !== true

    const workspaceUpdate = (sid: string, lc: LiveConfig, now: number): string | undefined => {
      const m = memo(sid)
      const prev = m.workspaceInfo
      if (prev === undefined) return undefined
      const next = deps.refreshWorkspace(prev, lc.config, now)
      m.workspaceInfo = next
      return workspaceNotice(prev, next)
    }

    const onPrompt = (sid: string, raw: string, ctx: OmpContext, expanded: boolean): void => {
      const now = deps.now()
      const lc = liveOrDefaults()
      const m = memo(sid)
      m.noticed = false
      const entries: SpoolEntry[] = [{ ts: now, ev: 'prompt' }]
      guarded('memory tick', () => { deps.memory.promptSeen?.(sid) })
      const wfExpanded = expanded ? workflowOfExpanded(raw) : undefined
      const text = wfExpanded !== undefined ? wfExpanded.args : raw.trim()
      if (wfExpanded === undefined && !isModelPrompt(text)) { spool(sid, entries); return }
      if (agentIdle(ctx)) receipts.prompt(sid)
      const excerpt = spoolPromptExcerpt(text)
      if (excerpt !== undefined && entries[0] !== undefined) entries[0].excerpt = excerpt
      cm.prompt(sid, text)
      const literalSkill = expanded && wfExpanded === undefined && /^\/skill:[a-z0-9]/.test(text)
      const parts: QueuedPrompt['parts'] = []
      const intent = text === '' ? null : guarded('H10 detectIntent', () => deps.policy.detectIntent(text))
      if (text !== '' && paths.isValidSessionId(sid)) guarded('H20 grants', () => deps.recordGrants(sid, text, now))
      const control = intent === 'pause' || intent === 'resume' || intent === 'stop' ? intent : null
      parts.push({ text: guarded('H10 interaction', () => promptGuidance(deps, sid, control, text, { autoPause: lc.config.plan.autoPause, now })), order: 0 })
      parts.push({ text: guarded('H10 review notes', () => deps.reviewNotes?.(sid, { plan: deps.state.load(sid).plan?.path, roots: [m.workspaceInfo?.root, ctx.cwd], now })), order: 0 })
      const routed = text === '' ? undefined : guarded('H22 route.prompt', () => route(sid, literalSkill ? literalSkillAsk(text) : text, lc))
      parts.push({ text: guarded('H21 workspace notice', () => workspaceUpdate(sid, lc, now)), order: 2 })
      if (m.contextWarning !== undefined) {
        parts.push({ text: m.contextWarning, order: 3 })
        m.contextWarning = undefined
      }
      const wf = wfExpanded !== undefined ? { ...wfExpanded, via: 'command' as const } : literalSkill ? undefined : guarded('H25 workflow', () => workflowOfInput(text, data.commands))
      parts.push({ text: guarded('H10 read-only start', () => readOnlyStart(ctx, [wf?.workflow, ...(routed?.invoked ?? []), ...(routed?.load ?? [])])), order: 0 })
      if (wf !== undefined) {
        const input = wf.args !== '' ? { workflow: wf.workflow, title: wf.args, source: 'command' as const } : { workflow: wf.workflow, source: 'command' as const }
        guarded('H25 flow start', () => deps.flow.start(sid, input, now))
        if (wf.via === 'skill' || wfExpanded !== undefined) entries.push(...usageSignal(lc, 'workflow', wf.workflow, now))
      }
      if (text !== '') {
        const signals = guarded('H26 profile signals', () => profileSignalsFromPrompt(text)) ?? []
        for (const signal of signals) entries.push({ ts: now, ev: 'signal', signal })
      }
      spool(sid, entries)
      const queued = m.queued ??= []
      queued.push(routed !== undefined ? { parts, route: routed } : { parts })
      if (queued.length > MAX_QUEUED_PROMPTS) queued.splice(0, queued.length - MAX_QUEUED_PROMPTS)
      refreshFlowSafe(ctx)
    }

    pi.on('input', (event: OmpInputEvent, ctx: OmpContext): undefined => {
      try {
        if (!isMain(ctx) || event.source === 'extension') return undefined
        const sid = sessionOf(ctx)
        if (sid === undefined) return undefined
        const raw = typeof event.text === 'string' ? event.text : ''
        if (guarded('H10 isGuardContinuation', () => deps.policy.isGuardContinuation(raw)) === true) return undefined
        const m = memo(sid)
        m.inputSeen = true
        if (agentIdle(ctx)) m.queued = undefined
        onPrompt(sid, raw, ctx, false)
      } catch (e) {
        report('input', e)
      }
      return undefined
    })

    const promptBlock = async (sid: string, ctx: OmpContext): Promise<string> => {
      const lc = live()
      const health = healthFor(spoolSid(ctx))
      const mcp = data.mcp.filter(s => health[s.id] !== 'down')
      const policy = { ...data.routing, strictness: lc.config.routing.strictness }
      const card = guarded('H15 capabilityCard', () => deps.policy.capabilityCard({ policy, mcp, skills: data.skills, plugins: data.plugins, harness: 'omp' })) ?? ''
      const m = memo(sid)
      m.context ??= deps.memory.contextText(ctx.cwd).catch(e => { report('H13 memory context', e); return undefined })
      const [info, memoryText] = await Promise.all([withDeadline(workspaceOf(sid, ctx), WORKSPACE_WAIT_MS, undefined), withDeadline(m.context, 4_000, undefined)])
      const workspace = info !== undefined ? guarded('H21 workspaceContext', () => workspaceContext(info, 'omp')) ?? '' : ''
      const assets = guarded('H28 project assets', () => deps.projectAssets.context(info?.root)) ?? ''
      const index = memoryText ?? ''
      const parts = [card.trim(), workspace.trim(), assets.trim(), index.trim()].filter(p => p !== '')
      return parts.length > 0 ? ['<buracle-context>', ...parts, '</buracle-context>'].join('\n\n') : ''
    }

    const subagentBlock = async (sid: string, ctx: OmpContext): Promise<string> => {
      const info = await withDeadline(workspaceOf(sid, ctx), WORKSPACE_WAIT_MS, undefined)
      const text = info !== undefined ? guarded('H21 workspaceContext', () => workspaceContext(info, 'omp')) ?? '' : ''
      return text.trim() !== '' ? ['<buracle-context>', text.trim(), '</buracle-context>'].join('\n\n') : ''
    }

    pi.on('before_agent_start', async (event: OmpBeforeAgentStartEvent, ctx: OmpContext): Promise<OmpBeforeAgentStartResult | undefined> => {
      await withDeadline(fenceActiveTools(pi, deps.reviewerFence?.()).catch(e => { report('second-opinion tools', e); return [] }), HIDE_TOOLS_WAIT_MS, [])
      if (process.env['BURACLE_MEMORY_RUNNER'] === '1') return undefined
      try {
        const sid = sessionOf(ctx)
        if (sid === undefined) return undefined
        const m = memo(sid)
        const base = Array.isArray(event.systemPrompt) ? event.systemPrompt : []
        if (isMain(ctx)) await withDeadline(hideTools(pi).catch(e => { report('hidden tools', e); return [] }), HIDE_TOOLS_WAIT_MS, [])
        if (!isMain(ctx)) {
          m.block ??= subagentBlock(sid, ctx).catch(e => { report('subagent block', e); return '' })
          const block = await m.block
          return block !== '' && !base.includes(block) ? { systemPrompt: [...base, block] } : undefined
        }
        const prompt = typeof event.prompt === 'string' ? event.prompt : ''
        if (m.inputSeen !== true && ctx.mode !== 'tui' && ctx.mode !== 'rpc' && prompt !== m.lastPrompt
          && guarded('H10 isGuardContinuation', () => deps.policy.isGuardContinuation(prompt)) !== true && corePolicy.isUserText(prompt)) {
          m.lastPrompt = prompt
          guarded('prompt', () => onPrompt(sid, prompt, ctx, true))
        }
        m.inputSeen = false
        const routed = guarded('H22 delivery', () => deliver(sid, prompt))
        const saved = await savedPlans(ctx, { prompt })
        const message = [routed, saved].filter((t): t is string => t !== undefined).join('\n\n')
        m.block ??= promptBlock(sid, ctx).catch(e => { report('before_agent_start block', e); return '' })
        const block = await m.block
        const result: OmpBeforeAgentStartResult = {}
        if (block !== '' && !base.includes(block)) result.systemPrompt = [...base, block]
        if (message !== '') result.message = { customType: PROMPT_MESSAGE_TYPE, content: message, display: false }
        return result.systemPrompt !== undefined || result.message !== undefined ? result : undefined
      } catch (e) {
        report('before_agent_start', e)
        return undefined
      }
    })

    const writeTelemetryFor = (sid: string, ctx: OmpContext) => { guarded('telemetry', () => deps.state.telemetry(sid, telemetryOf(pi, ctx, deps.now(), guarded))) }

    const notes = { pi, guarded }

    const refreshSoon = (ctx: OmpContext) => {
      status.refresh(ctx).catch(e => report('status', e))
      pane.refresh(ctx).catch(e => report('status pane', e))
      refreshFlowSafe(ctx)
    }

    pi.on('turn_end', (event: OmpTurnEndEvent, ctx: OmpContext): undefined => {
      try {
        if (!isMain(ctx)) return undefined
        const sid = sessionOf(ctx)
        if (sid === undefined) return undefined
        cm.flush(sid)
        writeTelemetryFor(sid, ctx)
        guarded('H05 context watch', () => contextCheck(notes, memo(sid), ctx, event, live().config.context))
        const text = messageText(event.message)
        const entry: SpoolEntry = { ts: deps.now(), ev: 'turn' }
        const model = strAt(event.message, 'model') ?? ctx.model?.id
        if (model) entry.model = model
        const tokens = numAt(event.message, 'usage', 'totalTokens')
        if (tokens !== undefined) entry.tokens = tokens
        if (text.trim() !== '') entry.excerpt = clip(text, 2000)
        spool(sid, [entry])
        refreshSoon(ctx)
      } catch (e) {
        report('turn_end', e)
      }
      return undefined
    })

    registerStopGuard(pi, {
      deps, live, guarded, report: (what, e) => report(what, e), spool,
      turnEnded: sid => { guarded('H28 project assets', () => deps.projectAssets.link(memo(sid).workspaceInfo?.root, deps.now())) },
      released: (sid, ctx, last) => receipts.end(sid, ctx, last, live().config),
      noticed: { get: sid => memo(sid).noticed === true, set: sid => { memo(sid).noticed = true } },
    })

    registerCompaction(pi, { deps, live, slugOf, guarded, report: (what, e) => report(what, e), spool, cm, todos: sid => memo(sid).todos ?? [], handoff: (sid, cwd, note) => deps.memory.writeHandoff(sid, cwd, note) })

    const finalize = (sid: string): Promise<void> => (captureOn(sid) ? deps.memory.spawnFinalizer(sid) : Promise.resolve())

    const startSession = (ctx: OmpContext, ev: string, event: unknown) => {
      const sid = sessionOf(ctx)
      if (sid === undefined) return
      if (currentSid !== undefined && currentSid !== sid) {
        const prev = currentSid
        cm.flush(prev)
        finalize(prev).catch(e => report('finalizer', e))
      }
      currentSid = sid
      deps.setEnv('BURACLE_SESSION_ID', sid)
      deps.setEnv('BURACLE_HARNESS', 'omp')
      if (captureOn(sid)) deps.memory.sessionStart(sid, ctx.cwd).catch(e => report('memory sessionStart', e))
      cm.startup(sid)
      const resumed = guarded('H27 resumed', () => resumedSession(ev, event, ctx, f => deps.isFile(f))) === true
      if (resumed) cm.resume(sid)
      if (resumed) guarded('resume hint', () => receipts.resumed(sid, ctx, live().config))
      const m = memo(sid)
      m.context ??= deps.memory.contextText(ctx.cwd).catch(e => { report('H13 memory context', e); return undefined })
      void slugOf(sid, ctx.cwd)
      guarded('telemetry', () => writeTelemetryFor(sid, ctx))
      const lc = guarded('config', () => live())
      const warning = lc !== undefined && !profileWarned ? guarded('H17 profileGuard', () => deps.profileGuard(lc)) : undefined
      if (warning !== undefined) {
        profileWarned = true
        log('warn', 'omp: H17 profile guard', { sid, warning })
        if (hasTui(ctx)) guarded('H17 notify', () => ctx.ui.notify(warning, 'warning'))
      }
      if (ev === 'session_start' && !resumed) startupNotice(notes, ctx, data, deps.now())
      if (hasTui(ctx)) {
        m.flow?.reset()
        refreshSoon(ctx)
        if (!statusTimerStarted && typeof ctx.setInterval === 'function') {
          statusTimerStarted = true
          ctx.setInterval(() => refreshSoon(ctx), deps.timings.statusIntervalMs)
        }
      }
      if (lc !== undefined && m.workspace === undefined) {
        m.workspace = deps.prepareWorkspace(ctx.cwd, lc.config, deps.now()).then(info => {
          m.workspaceInfo = info
          guarded('H28 project assets', () => deps.projectAssets.link(info.root, deps.now()))
          return info
        }, e => { report('H21 workspace', e); return undefined })
      }
      if (!maintScheduled && typeof ctx.setTimeout === 'function') {
        maintScheduled = true
        ctx.setTimeout(() => {
          const keep = new Set<string>([...memos.keys(), ...(currentSid !== undefined ? [currentSid] : [])])
          const removed = guarded('H16 session maintenance', () => deps.prune(keep, deps.now())) ?? []
          if (removed.length > 0) log('info', 'omp: pruned idle session state', { count: removed.length })
        }, deps.timings.maintDelayMs)
      }
    }

    for (const ev of ['session_start', 'session_switch', 'session_branch']) {
      pi.on(ev, (event: unknown, ctx: OmpContext): undefined => {
        try { if (isMain(ctx)) startSession(ctx, ev, event) } catch (e) { report(ev, e) }
        return undefined
      })
    }

    pi.on('session_shutdown', async (_event: unknown, ctx: OmpContext): Promise<undefined> => {
      try {
        if (!isMain(ctx)) return undefined
        const sid = sessionOf(ctx) ?? currentSid
        if (sid !== undefined) {
          cm.flush(sid)
          await finalize(sid)
        }
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
