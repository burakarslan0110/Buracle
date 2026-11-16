import type { HookId, ToolCall, ToolKind } from '../../../core/events'
import { classifyTool } from '../../../core/events'
import { flowDef } from '../../../core/flow/catalog'
import { FOLD_AFTER_SEC } from '../../../core/flow/state'
import * as corePolicy from '../../../core/policy/index'
import { ompOffServers } from '../../shared/native-off'
import { mcpUnavailable } from '../../../core/policy/routing'
import { skillOf } from '../../../core/policy/usage'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'
import {
  bashOptions, denyReason, guardFailed, postTool, preTool, prompt as promptEvent,
  workspaceStart, writeGuardContext, type PipelineDeps, type UsagePlan,
} from '../../shared/pipeline/index'
import { addedTextOf, OMP_H04_BUDGET_MS, removedTextOf } from './checks'
import { registerUtilityCommands } from './commands'
import { registerCompaction } from './compaction'
import { fenceActiveTools, fenceToolCall } from './companion-fence'
import { judgeWithConsent, type ConsentNeed } from '../../shared/pi-family/consent-ask'
import { heldConsentNeed } from '../../shared/pi-family/consent-held'
import { CODE_EXECUTION_TOOLS, defaultDeps, emptyGenerated, type ExtensionDeps } from './deps'
import { editTargets, type EditTargets } from './edits'
import { FlowWidget, flowWidgetLines } from './flow-widget'
import { contextBlock, createInProcessHost, type BaseMemo } from '../../shared/pi-family/inprocess-host'
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
import { availableServers, isDeviceWrite, type PromptRouting } from './routing'
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
const FENCE_TOOLS_WAIT_MS = 2_000
const WRITE_KINDS: ReadonlySet<ToolKind> = new Set(['edit', 'write', 'patch'])

interface SessionMemo extends BaseMemo {
  /** A subagent's block. */
  block?: Promise<string>
  lastPrompt?: string
  noticed?: boolean
  band?: string
  flow?: FlowWidget
  reviewBlocked?: boolean
  todos?: string[]
}

function toolPaths(core: readonly string[], targets: EditTargets | undefined): string[] {
  return [...new Set([...core, ...(targets?.paths ?? [])])]
}

export function createBuracleExtension(data: OmpGenerated = emptyGenerated(), overrides: Partial<ExtensionDeps> = {}): (pi: OmpExtensionAPI) => void {
  return function buracle(pi: OmpExtensionAPI): void {
    const deps: ExtensionDeps = { ...defaultDeps(), ...overrides }
    const host = createInProcessHost<SessionMemo>({
      harness: H, data, deps, pi, noticeType: NOTICE_MESSAGE_TYPE,
      configuredRepo: lc => lc.repoRoot,
      nativeOff: { label: 'omp disabledServers', read: ompOffServers },
    })
    const { memo, guarded, live, liveOrDefaults, slugOf, healthFor, pipe, started, spoolTo } = host
    const report = (what: string, e: unknown, outcome: 'allowed' | 'blocked' = 'allowed') => host.report(what, e, outcome)
    let statusTimerStarted = false
    const spoolSid = (ctx: OmpContext): string | undefined => {
      if (isMain(ctx)) return sessionOf(ctx)
      const sid = process.env['BURACLE_SESSION_ID']
      return process.env['BURACLE_HARNESS'] === 'omp' && paths.isValidSessionId(sid) ? sid : undefined
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

    pi.setLabel?.('Buracle Stack')
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

    const literalSkillAsk = (text: string): string => text.replace(/^\/skill:/, '/buracle:')

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
          routed = host.route(sid, literalSkill ? literalSkillAsk(text) : text, lc)
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
      host.enqueue(m, r.context, routed as PromptRouting | undefined)
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

    const subagentBlock = async (sid: string, ctx: OmpContext): Promise<string> => {
      const d = pipe(sid)
      const text = await d.step('H21 workspace', '', () => workspaceStart({ sessionId: sid, cwd: ctx.cwd, subagent: true, now: deps.now() }, d))
      return contextBlock(text.trim() !== '' ? [text.trim()] : [])
    }

    /** The capability card (H15) with the servers that are up for this session. */
    const card = (ctx: OmpContext): string => {
      const health = healthFor(spoolSid(ctx), ctx.cwd)
      const policy = { ...data.routing, strictness: liveOrDefaults().config.routing.strictness }
      return deps.policy.capabilityCard({ policy, mcp: data.mcp.filter(s => !mcpUnavailable(health[s.id])), plugins: data.plugins, harness: H })
    }

    const openSession = (sid: string, ctx: OmpContext, source: string, previous?: string): Promise<void> => host.openSession(sid, ctx, source, {
      ...(previous !== undefined ? { previous } : {}),
      card: () => card(ctx),
      scheduleMaint: () => { if (typeof ctx.setTimeout === 'function') host.scheduleMaint((fn, ms) => { ctx.setTimeout?.(fn, ms) }) },
    })

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
        const routed = guarded('H22 delivery', () => host.deliver(sid, prompt))
        const saved = await savedPlans(ctx, { prompt })
        const message = [routed, saved].filter((t): t is string => t !== undefined).join('\n\n')
        await m.starting
        const text = contextBlock(m.startContext ?? [])
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
      const previous = host.enter(sid)
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
        const sid = sessionOf(ctx) ?? host.current()
        if (sid !== undefined) await host.endSession(sid)
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
