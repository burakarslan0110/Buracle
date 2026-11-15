import './bun-shim'
import { join } from 'node:path'
import type { HookId, StopInput, ToolCall, ToolKind } from '../../../core/events'
import { classifyTool } from '../../../core/events'
import { mcpUnavailable } from '../../../core/policy/routing'
import { skillOf } from '../../../core/policy/usage'
import { contextWatch } from '../../../core/status/context'
import { log } from '../../../engine/log'
import {
  bashOptions, compactRestore, denyReason, guardFailed, postTool, preCompact, preTool, prompt as promptEvent, stop, writeGuardContext, type PipelineDeps, type UsagePlan,
} from '../../shared/pipeline/index'
import { judgeWithConsent, type ConsentNeed } from '../../shared/pi-family/consent-ask'
import { heldConsentNeed } from '../../shared/pi-family/consent-held'
import { contextBlock, createInProcessHost, type BaseMemo } from '../../shared/pi-family/inprocess-host'
import type { SpoolEntry } from '../../shared/pi-family/memory'
import { availableServers, type PromptRouting } from '../../shared/pi-family/routing'
import { runawayNotice, stopReason } from '../../shared/pi-family/stop'
import { clip, hasTui, messageText, numAt, sessionOf, withDeadline } from '../../shared/pi-family/util'
import { pathRuleSource } from '../../shared/path-rules'
import { guardedContents, piChanges } from '../../shared/write-content'
import { CODE_EXECUTION_TOOLS, defaultDeps, emptyGenerated, type PiDeps } from './deps'
import { registerPiCommands } from './commands'
import { piEdit, textsOf } from './edits'
import { createPiExtras } from './extras'
import { GENERATED } from './generated-data'
import { piOffServers } from './native-off'
import type {
  PiBeforeAgentStartEvent, PiBeforeAgentStartResult, PiCompactEvent, PiContext, PiExtensionAPI, PiGenerated, PiInputEvent, PiSettleEvent, PiSettleResult,
  PiToolCallEvent, PiToolCallResult, PiToolResultEvent, PiToolResultPatch, PiTurnEndEvent,
} from './types'

export { CODE_EXECUTION_TOOLS, defaultDeps, emptyGenerated, TOOL_CALL_DEADLINE_MS, TOOL_RESULT_DEADLINE_MS } from './deps'
export type { EvalGuard, PiDeps } from './deps'

const H = 'pi' as const
export const PROMPT_MESSAGE_TYPE = 'buracle.prompt'
export const NOTICE_MESSAGE_TYPE = 'buracle.notice'
export const COMPACT_RESTORE_TYPE = 'buracle.compact-restore'
export const STOP_MESSAGE_TYPE = 'buracle.stop'
const MAX_HELD = 256
const WRITE_KINDS: ReadonlySet<ToolKind> = new Set(['edit', 'write', 'patch'])

interface SessionMemo extends BaseMemo {
  lastText?: string
  stopBlocked?: boolean
}

function capped<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.set(key, value)
  if (map.size > MAX_HELD) map.delete(map.keys().next().value as K)
}

/**
 * Buracle's extension for Pi (`pi.on(event, handler)`, docs/extensions.md of pi-coding-agent). Every handler feeds the
 * shared pipeline (src/adapters/shared/pipeline) and turns its decision into Pi's answer; a handler that fails lets
 * the call through and logs, except the H01 and H02 guards, which fail closed.
 */
export function createBuracleExtension(data: PiGenerated = emptyGenerated(), overrides: Partial<PiDeps> = {}): (pi: PiExtensionAPI) => void {
  return function buracle(pi: PiExtensionAPI): void {
    const deps: PiDeps = { ...defaultDeps(), ...overrides }
    const host = createInProcessHost<SessionMemo>({
      harness: H, data, deps, pi, noticeType: NOTICE_MESSAGE_TYPE,
      configuredRepo: (_lc, config) => config.repo,
      nativeOff: { label: 'pi disabled servers', read: piOffServers },
    })
    const { memo, report, guarded, liveOrDefaults, started, spoolTo, pipe } = host
    const extras = createPiExtras({ data, deps, live: () => liveOrDefaults(), guarded, slug: sid => memo(sid).slugValue })
    registerPiCommands(pi, { cli: () => deps.cli(), run: (argv, opts) => deps.run(argv, opts), report })
    /** Context the pre-tool step has for a call, which Pi can only take back with the call's result. */
    const notes = new Map<string, string[]>()
    const denied = new Set<string>()
    const consentHolds = new Map<string, ConsentNeed>()

    // ---- tool_call: the guards (H01, H02, H03, H09, H20) and the usage reminders (H24) ----

    const codeDenial = async (event: PiToolCallEvent, ctx: PiContext, input: Record<string, unknown>, d: PipelineDeps): Promise<{ reason: string, hook: HookId } | undefined> => {
      if (!CODE_EXECUTION_TOOLS.has(event.toolName)) return undefined
      try {
        if (deps.evalGuard === undefined) throw new Error('core checkEval is unavailable')
        const code = typeof input['code'] === 'string' ? input['code'] : ''
        const extraDeny = bashOptions(d.ctx, ctx.cwd, d.realpath).extraDeny
        const verdict = deps.evalGuard(code, 'js', await writeGuardContext(d, ctx.cwd), extraDeny !== undefined ? { extraDeny } : {})
        const hook = verdict.hook === 'H02' ? 'H02' : 'H01'
        return verdict.deny ? { reason: denyReason(hook, verdict.deny), hook } : undefined
      } catch (e) {
        report('H01 guard', e)
        return { reason: guardFailed('H01', e), hook: 'H01' }
      }
    }

    const toolCall = async (event: PiToolCallEvent, ctx: PiContext): Promise<PiToolCallResult | undefined> => {
      const sid = sessionOf(ctx)
      const lc = liveOrDefaults()
      const input = event.input !== null && typeof event.input === 'object' ? event.input : {}
      const home = guarded('home', () => deps.home())
      const call: ToolCall = {
        harness: H, sessionId: sid ?? '', cwd: ctx.cwd, tool: event.toolName, input,
        ...classifyTool(H, event.toolName, input, ctx.cwd, data.mcpIds, { homeTilde: home }),
      }
      const d = pipe(sid ?? '', lc)
      const deny = (reason: string, hook: HookId): PiToolCallResult => {
        log('info', 'pi: tool call blocked', { hook, tool: event.toolName, sid })
        denied.add(event.toolCallId)
        return { block: true, reason }
      }
      await started(sid)
      const own = await codeDenial(event, ctx, input, d)
      if (own !== undefined) return deny(own.reason, own.hook)
      const edit = WRITE_KINDS.has(call.kind)
      const change = edit ? piEdit(call.kind, input, call.paths[0], () => deps.readText(call.paths[0] ?? '')) : undefined
      const decision = await preTool({
        call, now: deps.now(), subagent: false, guardsOnly: sid === undefined, usage: sid !== undefined,
        ...(edit ? { edits: call.paths } : {}),
      }, {
        ...d,
        writeTargets: c => (edit && c.paths.length > 0
          ? { paths: c.paths, contents: guard => { try { return guardedContents(piChanges(c.tool, c.input, c.paths), c.paths, guard.home, guard.realpath !== undefined ? { realpath: guard.realpath } : {}) } catch { return {} } } }
          : undefined),
        nativeOff: () => piOffServers(ctx.cwd),
        usage: (c, health) => {
          if (sid === undefined) return undefined
          const plan: UsagePlan = { call: c, ledgerId: sid, available: availableServers(data.mcp, health) }
          if (change !== undefined) plan.edits = [change]
          const rules = guarded('path rules', () => pathRuleSource(data.pathRules, join(deps.buracleHome(), 'rules', 'paths'), { home: deps.home() }))
          if (rules !== undefined) plan.pathRules = rules
          return plan
        },
      })
      if (decision.action === 'deny') {
        if (decision.hook === 'H20' && sid !== undefined && call.command !== undefined) {
          const command = call.command
          const need = guarded('H20 need', () => heldConsentNeed(H, sid, command))
          if (need !== undefined) capped(consentHolds, event.toolCallId, need)
        }
        return deny(decision.reason, decision.hook)
      }
      const lines = [...new Set(decision.context.map(c => c.trim()).filter(c => c !== ''))]
      if (lines.length > 0) capped(notes, event.toolCallId, lines)
      return undefined
    }

    pi.on('tool_call', async (event: PiToolCallEvent, ctx: PiContext): Promise<PiToolCallResult | undefined> => {
      try {
        return await judgeWithConsent<PiToolCallResult>(ctx, {
          judge: () => withDeadline(toolCall(event, ctx), deps.timings.toolCallMs, undefined),
          take: () => { const need = consentHolds.get(event.toolCallId); consentHolds.delete(event.toolCallId); return need },
          record: (need, answer) => {
            const sid = sessionOf(ctx)
            return sid !== undefined && guarded('H20 grant', () => { deps.recordAskGrant(sid, need.kind, answer, deps.now()); return true }) === true
          },
          cleared: () => { denied.delete(event.toolCallId) },
        })
      } catch (e) {
        report('tool_call', e)
        return undefined
      }
    })

    // ---- tool_result: file checks (H04), the spool (H14), MCP health (H24) ----

    const toolResult = async (event: PiToolResultEvent, ctx: PiContext): Promise<string[]> => {
      const sid = sessionOf(ctx)
      const wasDenied = denied.delete(event.toolCallId)
      const held = notes.get(event.toolCallId) ?? []
      notes.delete(event.toolCallId)
      if (sid === undefined || wasDenied) return held
      const input = event.input !== null && typeof event.input === 'object' ? event.input : {}
      const cls = classifyTool(H, event.toolName, input, ctx.cwd, data.mcpIds, { homeTilde: guarded('home', () => deps.home()) })
      if (!event.isError && cls.kind === 'read') {
        const loaded = extras.flowStartLoaded(sid, skillOf({ tool: event.toolName, input, kind: cls.kind, command: undefined }, H))
        if (loaded !== undefined) guarded('workflow band', () => extras.refreshFlow(sid, ctx))
      }
      const edited = !event.isError && WRITE_KINDS.has(cls.kind) && cls.paths.length > 0
      const change = edited ? piEdit(cls.kind, input, cls.paths[0], () => undefined) : undefined
      const server = cls.kind === 'mcp' ? cls.mcp?.server : undefined
      await started(sid)
      const r = await postTool({
        sessionId: sid, cwd: ctx.cwd, now: deps.now(), subagent: false, entries: [],
        ...(edited ? { edit: { ok: true, paths: cls.paths, added: textsOf(change, 'added'), removed: () => textsOf(change, 'removed') } } : {}),
        ...(server !== undefined ? { mcp: { server: () => server, ok: !event.isError } } : {}),
      }, { ...pipe(sid), fileChecks: host.fileChecks(), editBudgetMs: 20_000 })
      return [...held, ...r.context]
    }

    pi.on('tool_result', async (event: PiToolResultEvent, ctx: PiContext): Promise<PiToolResultPatch | undefined> => {
      try {
        const lines = await withDeadline(toolResult(event, ctx), deps.timings.toolResultMs, notes.get(event.toolCallId) ?? [])
        // Pi has no way to add context to a call's start, so the notes of both steps ride on the result.
        return lines.length > 0 ? { content: [...(Array.isArray(event.content) ? event.content : []), { type: 'text', text: lines.join('\n\n') }] } : undefined
      } catch (e) {
        report('tool_result', e)
        return undefined
      }
    })

    // ---- input and before_agent_start: prompt routing (H10, H22) and the session's context (H13, H15, H21) ----

    pi.on('input', async (event: PiInputEvent, ctx: PiContext): Promise<undefined> => {
      try {
        const text = typeof event.text === 'string' ? event.text.trim() : ''
        const sid = sessionOf(ctx)
        if (sid === undefined || event.source === 'extension') return undefined
        await started(sid)
        const m = memo(sid)
        const lc = liveOrDefaults()
        let routed: PromptRouting | undefined
        let warning: string | undefined
        const r = await promptEvent({ harness: H, sessionId: sid, cwd: ctx.cwd, text, now: deps.now(), ...(text === '' || text.startsWith('!') ? { userText: false } : {}) }, {
          ...pipe(sid, lc),
          routePrompt: async () => {
            if (text === '') return undefined
            routed = host.route(sid, text, lc)
            return { route: routed.route, deferred: true, ...(routed.text !== undefined ? { text: routed.text } : {}) }
          },
          readOnly: () => false,
          contextWarning: () => { warning = m.contextWarning; m.contextWarning = undefined; return warning },
        })
        if (r.continuation) { if (warning !== undefined) m.contextWarning = warning; return undefined }
        m.inputSeen = true
        m.stopBlocked = false
        extras.flowStart(sid, text)
        guarded('workflow band', () => extras.refreshFlow(sid, ctx))
        host.enqueue(m, r.context, routed as PromptRouting | undefined)
      } catch (e) {
        report('input', e)
      }
      return undefined
    })

    pi.on('before_agent_start', async (event: PiBeforeAgentStartEvent, ctx: PiContext): Promise<PiBeforeAgentStartResult | undefined> => {
      if (process.env['BURACLE_MEMORY_RUNNER'] === '1') return undefined
      try {
        const sid = sessionOf(ctx)
        if (sid === undefined) return undefined
        const m = memo(sid)
        // A session Pi announced no start for begins here, without the steps of a fresh one.
        if (m.starting === undefined) void openSession(sid, ctx, 'resume')
        await started(sid)
        const prompt = typeof event.prompt === 'string' ? event.prompt : ''
        m.inputSeen = false
        const routed = event.messageType === 'custom' ? undefined : guarded('H22 delivery', () => host.deliver(sid, prompt))
        await m.starting
        const result: PiBeforeAgentStartResult = {}
        const text = contextBlock(m.startContext ?? [])
        if (text !== '' && !event.systemPrompt.includes(text)) result.systemPrompt = `${event.systemPrompt}\n\n${text}`
        if (routed !== undefined) result.message = { customType: PROMPT_MESSAGE_TYPE, content: routed, display: false }
        return result.systemPrompt !== undefined || result.message !== undefined ? result : undefined
      } catch (e) {
        report('before_agent_start', e)
        return undefined
      }
    })

    // ---- the session: start (H13, H15, H17, H21), end (H14), maintenance (H16) ----

    const card = (ctx: PiContext, sid: string): string => {
      const health = host.healthFor(sid, ctx.cwd)
      const policy = { ...data.routing, strictness: liveOrDefaults().config.routing.strictness }
      return deps.policy.capabilityCard({ policy, mcp: data.mcp.filter(s => !mcpUnavailable(health[s.id])), plugins: [], harness: H })
    }

    const openSession = (sid: string, ctx: PiContext, source: string): Promise<void> => host.openSession(sid, ctx, source, {
      card: () => card(ctx, sid),
      scheduleMaint: () => host.scheduleMaint((fn, ms) => { setTimeout(fn, ms).unref?.() }),
    })

    pi.on('session_start', async (event: { reason?: string }, ctx: PiContext): Promise<undefined> => {
      try {
        const sid = sessionOf(ctx)
        if (sid === undefined) return undefined
        host.enter(sid)
        void host.slugOf(sid, ctx.cwd)
        guarded('workflow band', () => extras.refreshFlow(sid, ctx))
        void extras.refreshStatus(sid, ctx).catch(e => report('status', e))
        if (memo(sid).starting === undefined) await openSession(sid, ctx, event.reason === 'startup' || event.reason === undefined ? 'startup' : event.reason === 'new' ? 'clear' : 'resume')
      } catch (e) {
        report('session_start', e)
      }
      return undefined
    })

    pi.on('session_shutdown', async (_event: unknown, ctx: PiContext): Promise<undefined> => {
      try {
        const sid = sessionOf(ctx) ?? host.current()
        if (sid !== undefined) await host.endSession(sid)
      } catch (e) {
        report('session_shutdown', e)
      }
      return undefined
    })

    // ---- turn_end: the context warning (H05) and the turn's spool entry (H14) ----

    pi.on('turn_end', async (event: PiTurnEndEvent, ctx: PiContext): Promise<undefined> => {
      try {
        const sid = sessionOf(ctx)
        if (sid === undefined) return undefined
        const m = memo(sid)
        const usage = guarded('context usage', () => ctx.getContextUsage?.())
        const w = contextWatch(m.ctxWarned, typeof usage?.percent === 'number' && Number.isFinite(usage.percent) ? usage.percent : undefined)
        m.ctxWarned = w.warned
        if (w.warn !== undefined) {
          const warn = w.warn
          m.contextWarning = warn
          if (hasTui(ctx)) guarded('H05 notify', () => ctx.ui.notify(warn, 'warning'))
        }
        const text = messageText(event.message)
        m.lastText = text
        const entry: SpoolEntry = { ts: deps.now(), ev: 'turn' }
        const model = ctx.model?.id
        if (model) entry.model = model
        const tokens = numAt(event.message, 'usage', 'totalTokens')
        if (tokens !== undefined) entry.tokens = tokens
        if (text.trim() !== '') entry.excerpt = clip(text, 2000)
        await spoolTo(sid, [entry])
        guarded('workflow band', () => extras.refreshFlow(sid, ctx))
        void extras.refreshStatus(sid, ctx).catch(e => report('status', e))
      } catch (e) {
        report('turn_end', e)
      }
      return undefined
    })

    // ---- agent_start and agent_end: a usage tip as the loader's text while the agent works ----

    pi.on('agent_start', (_event: unknown, ctx: PiContext): undefined => {
      guarded('tip', () => extras.tipStart(ctx))
      return undefined
    })

    pi.on('agent_end', (_event: unknown, ctx: PiContext): undefined => {
      guarded('tip', () => extras.tipEnd(ctx))
      return undefined
    })

    // ---- agent_before_settle: Pi's stop (H08, H11, H23); `continue: true` gives the model one more turn ----

    pi.on('agent_before_settle', async (event: PiSettleEvent & { outcome?: string }, ctx: PiContext): Promise<PiSettleResult | undefined> => {
      try {
        const sid = sessionOf(ctx)
        if (sid === undefined || event.outcome !== 'completed') return undefined
        const m = memo(sid)
        const now = deps.now()
        const last = m.lastText ?? ''
        if (last.trim() !== '') await spoolTo(sid, [{ ts: now, ev: 'stop', excerpt: clip(last, 2000) }])
        const input: StopInput = { harness: H, sessionId: sid, cwd: ctx.cwd, now, hookActive: m.stopBlocked === true }
        if (last !== '') input.lastMessage = last
        const r = await stop(input, {
          ...pipe(sid),
          readOnly: () => false,
          stopNotice: (result, before) => {
            if ((result.why === 'runaway-plan' || result.why === 'runaway-chain') && hasTui(ctx)) {
              log('warn', 'pi: the stop guard released the turn at a runaway cap', { sid, why: result.why })
              guarded('runaway notice', () => ctx.ui.notify(runawayNotice(result.why, before.plan?.path ?? 'the plan'), 'warning'))
            }
            return undefined
          },
        })
        const d = r.decision
        m.stopBlocked = d.action === 'block'
        if (d.action !== 'block') return undefined
        // The turn audit's reason goes out as it is; the stop guard's keeps its marker.
        const reason = r.blockedBy === 'audit' ? d.reason : stopReason(d.hook, d.reason)
        return { entries: [...(Array.isArray(event.entries) ? event.entries : []), { type: 'custom_message', customType: STOP_MESSAGE_TYPE, content: reason, display: false }], continue: true }
      } catch (e) {
        report('agent_before_settle', e)
        return undefined
      }
    })

    // ---- compaction (H06, H07) ----

    pi.on('session_before_compact', async (_event: unknown, ctx: PiContext): Promise<undefined> => {
      try {
        const sid = sessionOf(ctx)
        if (sid !== undefined) await preCompact({ harness: H, sessionId: sid, cwd: ctx.cwd, now: deps.now() }, { ...pipe(sid), openTodos: () => [] })
      } catch (e) {
        report('session_before_compact', e)
      }
      return undefined
    })

    pi.on('session_compact', async (event: PiCompactEvent, ctx: PiContext): Promise<undefined> => {
      try {
        const sid = sessionOf(ctx)
        if (sid === undefined) return undefined
        const now = deps.now()
        const summary = event.compactionEntry?.summary
        if (typeof summary === 'string' && summary.trim() !== '') await spoolTo(sid, [{ ts: now, ev: 'compact', excerpt: clip(summary, 8000) }])
        const d = pipe(sid)
        const note = await d.step('H07 restore', '', () => compactRestore({ sessionId: sid, cwd: ctx.cwd, now }, d))
        if (note.trim() !== '') pi.sendMessage({ customType: COMPACT_RESTORE_TYPE, content: note, display: false }, { deliverAs: 'nextTurn' })
      } catch (e) {
        report('session_compact', e)
      }
      return undefined
    })
  }
}

export default createBuracleExtension(GENERATED ?? emptyGenerated())
