import './bun-shim'
import type { BuracleConfig } from '../../../core/config'
import type { HookId, StopInput, ToolCall, ToolKind } from '../../../core/events'
import { classifyTool } from '../../../core/events'
import type { PromptRoute } from '../../../core/policy/skill-router'
import { PROMPT_CONTEXT_MAX_CHARS, routeText } from '../../../core/policy/skill-router'
import { offServersFor, withOffServers } from '../../../core/policy/mcp-off'
import type { McpHealth } from '../../../core/policy/routing'
import { mcpUnavailable } from '../../../core/policy/routing'
import { ledgerPrompt } from '../../../core/policy/usage'
import { contextWatch, type ContextBand } from '../../../core/status/context'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'
import type { AdapterContext } from '../../registry'
import {
  bashOptions, compactRestore, denyReason, fitParts, guardFailed, postTool, preCompact, preTool, prompt as promptEvent, readWorkspace, saveWorkspace,
  sessionEnd, sessionStart, spool, stop, writeGuardContext, type PipelineDeps, type UsagePlan,
} from '../../shared/pipeline/index'
import { judgeWithConsent, type ConsentNeed } from '../../shared/pi-family/consent-ask'
import { heldConsentNeed } from '../../shared/pi-family/consent-held'
import type { LiveConfig } from '../../shared/pi-family/config'
import { adapterContext, memoryFns, pipelineCore, uiHooks } from '../../shared/pi-family/host'
import type { SpoolEntry } from '../../shared/pi-family/memory'
import { availableServers, mergeRoutes, promptRouting, routerData, sessionHealth, type PromptRouting, type RouterData } from '../../shared/pi-family/routing'
import { runawayNotice, stopReason } from '../../shared/pi-family/stop'
import { clip, hasTui, messageText, numAt, sessionOf, withDeadline } from '../../shared/pi-family/util'
import { guardedContents, piChanges } from '../../shared/write-content'
import { CODE_EXECUTION_TOOLS, defaultDeps, emptyGenerated, type PiDeps } from './deps'
import { piEdit, textsOf } from './edits'
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
const WORKSPACE_WAIT_MS = 3_000
const PROJECT_WAIT_MS = 2_000
const START_WAIT_MS = 1_000
const MAX_QUEUED_PROMPTS = 16
const MAX_HELD = 256
const WRITE_KINDS: ReadonlySet<ToolKind> = new Set(['edit', 'write', 'patch'])

interface QueuedPrompt { before: string[], after: string[], route?: PromptRoute }

interface SessionMemo {
  capture?: boolean
  starting?: Promise<void>
  ready?: Promise<void>
  startContext?: string[]
  slug?: Promise<string | undefined>
  queued?: QueuedPrompt[]
  delivered?: { prompt: string, text: string | undefined }
  inputSeen?: boolean
  ctxWarned?: ContextBand
  contextWarning?: string
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
    const memos = new Map<string, SessionMemo>()
    const reported = new Set<string>()
    /** Context the pre-tool step has for a call, which Pi can only take back with the call's result. */
    const notes = new Map<string, string[]>()
    const denied = new Set<string>()
    const consentHolds = new Map<string, ConsentNeed>()
    let currentSid: string | undefined
    let maintScheduled = false
    let router: { strictness: string, data: RouterData } | undefined

    const report = (what: string, e: unknown) => {
      const message = e instanceof Error ? e.message : String(e)
      const key = `${what}:${message}`
      if (reported.has(key)) return
      reported.add(key)
      log(/^not implemented: /.test(message) ? 'debug' : 'warn', `pi extension: ${what} failed`, { error: message })
    }
    const guarded = <T>(what: string, fn: () => T): T | undefined => {
      try { return fn() } catch (e) { report(what, e); return undefined }
    }
    const step = async <T>(name: string, fallback: T, fn: () => T | Promise<T>): Promise<T> => {
      try { return await fn() } catch (e) { report(name, e); return fallback }
    }
    const liveOrDefaults = (): LiveConfig => guarded('config', () => deps.config(data.config)) ?? { config: data.config, vault: paths.oldVaultRoot(), shim: paths.shimPath(), source: 'defaults' }
    const memo = (sid: string): SessionMemo => {
      let m = memos.get(sid)
      if (m === undefined) { m = {}; memos.set(sid, m) }
      return m
    }
    const captureOn = (sid: string): boolean => (memo(sid).capture ??= guarded('BURACLE_NO_CAPTURE', () => deps.captureEnabled()) ?? true)
    const slugOf = (sid: string, cwd: string): Promise<string | undefined> => (memo(sid).slug ??= deps.projectSlug(cwd).catch(e => { report('projectSlug', e); return undefined }))
    const routerFor = (strictness: BuracleConfig['routing']['strictness']): RouterData => {
      if (router === undefined || router.strictness !== strictness) router = { strictness, data: routerData(data.skills, data.routing, strictness) }
      return router.data
    }
    const healthFor = (sid: string | undefined, cwd?: string): McpHealth => {
      const health = guarded('health', () => deps.health()) ?? {}
      const merged = guarded('H24 session health', () => sessionHealth(health, deps.ledger, sid)) ?? health
      const native = guarded('pi disabled servers', () => piOffServers(cwd ?? process.cwd())) ?? []
      return withOffServers(merged, [...new Set([...offServersFor(liveOrDefaults().config, H), ...native])])
    }

    const coreFns = pipelineCore(deps)
    const memFns = memoryFns(deps.memory)
    const ui = uiHooks(deps.memory)

    /** What the shared pipeline needs from Pi for one session. */
    const pipe = (sid: string, lc: LiveConfig = liveOrDefaults()): PipelineDeps => ({
      harness: H, step, ui, core: coreFns,
      ctx: adapterContext(data, lc, () => deps.home()) as AdapterContext,
      env: { ...process.env, BURACLE_NO_CAPTURE: sid === '' || captureOn(sid) ? undefined : '1' },
      memory: async name => memFns[name],
      workspace: {
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
      buracleRepo: async (cwd, c) => deps.buracleRepo(cwd, c.config.repo),
      ...(deps.assetsSpawn !== undefined ? { assetsSpawn: deps.assetsSpawn } : {}),
    })

    /** The session start resets the usage ledger, so an event that counts in it waits for that step, briefly. */
    const started = (sid: string | undefined): Promise<void> => {
      const ready = sid !== undefined ? memo(sid).ready : undefined
      return ready === undefined ? Promise.resolve() : withDeadline(ready, START_WAIT_MS, undefined)
    }
    const spoolTo = async (sid: string, entries: SpoolEntry[]): Promise<void> => { await spool(pipe(sid), sid, entries) }

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
      const edited = !event.isError && WRITE_KINDS.has(cls.kind) && cls.paths.length > 0
      const change = edited ? piEdit(cls.kind, input, cls.paths[0], () => undefined) : undefined
      const server = cls.kind === 'mcp' ? cls.mcp?.server : undefined
      await started(sid)
      const r = await postTool({
        sessionId: sid, cwd: ctx.cwd, now: deps.now(), subagent: false, entries: [],
        ...(edited ? { edit: { ok: true, paths: cls.paths, added: textsOf(change, 'added'), removed: () => textsOf(change, 'removed') } } : {}),
        ...(server !== undefined ? { mcp: { server: () => server, ok: !event.isError } } : {}),
      }, {
        ...pipe(sid),
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
        editBudgetMs: 20_000,
      })
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

    const route = (sid: string, text: string, lc: LiveConfig): PromptRouting => {
      const strictness = lc.config.routing.strictness
      const available = availableServers(data.mcp, healthFor(sid))
      const o: Parameters<typeof promptRouting>[2] = { harness: H, loaded: Object.keys(deps.ledger.load(sid).skills), available, strictness }
      const pd = deps.projectDeps(readWorkspace(adapterContext(data, lc, () => deps.home()) as AdapterContext, H, sid)?.root)
      if (pd !== undefined) o.deps = pd
      return promptRouting(text, routerFor(strictness), o)
    }

    /** The queued prompts' routes, merged and recorded in the ledger (H24) when they reach the model. */
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
            routed = route(sid, text, lc)
            return { route: routed.route, deferred: true, ...(routed.text !== undefined ? { text: routed.text } : {}) }
          },
          readOnly: () => false,
          contextWarning: () => { warning = m.contextWarning; m.contextWarning = undefined; return warning },
        })
        if (r.continuation) { if (warning !== undefined) m.contextWarning = warning; return undefined }
        m.inputSeen = true
        m.stopBlocked = false
        const found = routed as PromptRouting | undefined
        const at = found?.text !== undefined ? r.context.indexOf(found.text.trim()) : -1
        const queued = m.queued ??= []
        queued.push({ before: at >= 0 ? r.context.slice(0, at) : r.context, after: at >= 0 ? r.context.slice(at + 1) : [], ...(found !== undefined ? { route: found.route } : {}) })
        if (queued.length > MAX_QUEUED_PROMPTS) queued.splice(0, queued.length - MAX_QUEUED_PROMPTS)
      } catch (e) {
        report('input', e)
      }
      return undefined
    })

    const block = (parts: readonly string[]): string => (parts.length > 0 ? ['<buracle-context>', ...parts, '</buracle-context>'].join('\n\n') : '')

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
        const routed = event.messageType === 'custom' ? undefined : guarded('H22 delivery', () => deliver(sid, prompt))
        await m.starting
        const result: PiBeforeAgentStartResult = {}
        const text = block(m.startContext ?? [])
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
      const health = healthFor(sid, ctx.cwd)
      const policy = { ...data.routing, strictness: liveOrDefaults().config.routing.strictness }
      return deps.policy.capabilityCard({ policy, mcp: data.mcp.filter(s => !mcpUnavailable(health[s.id])), plugins: [], harness: H })
    }

    const scheduleMaint = (): void => {
      if (maintScheduled) return
      maintScheduled = true
      const timer = setTimeout(() => {
        const keep = new Set<string>([...memos.keys(), ...(currentSid !== undefined ? [currentSid] : [])])
        const removed = guarded('H16 session maintenance', () => deps.prune(keep, deps.now())) ?? []
        if (removed.length > 0) log('info', 'pi: pruned idle session state', { count: removed.length })
      }, deps.timings.maintDelayMs)
      timer.unref?.()
    }

    const openSession = (sid: string, ctx: PiContext, source: string): Promise<void> => {
      const m = memo(sid)
      let ready!: () => void
      m.ready = new Promise<void>(res => { ready = res })
      m.starting = (async () => {
        const d = pipe(sid)
        const then = <A extends unknown[]>(fn: (...a: A) => Promise<void>) => (...a: A): Promise<void> => { ready(); return fn(...a) }
        const r = await sessionStart({ harness: H, sessionId: sid, cwd: ctx.cwd, source, now: deps.now() }, {
          ...d,
          // The usage ledger is reset before the memory UI hears of the session: from there on a tool call may be counted.
          ui: { ...d.ui, started: then(d.ui.started), seen: then(d.ui.seen) },
          capabilityCard: () => card(ctx, sid),
          version: () => data.buracleVersion,
          sessionMaint: () => { scheduleMaint() },
        })
        const notice = r.notice
        m.startContext = r.context.filter(part => part !== notice?.model)
        // The profile warning (H17) is a toast for the user; it never enters the model's context.
        if (r.profile !== undefined) {
          const warning = r.profile
          log('warn', 'pi: H17 profile guard', { sid, warning })
          if (hasTui(ctx)) guarded('H17 notify', () => ctx.ui.notify(warning, 'warning'))
        }
        if (notice === undefined) return
        guarded('H17 notice', () => pi.sendMessage({ customType: NOTICE_MESSAGE_TYPE, content: notice.model, display: false }, { deliverAs: 'nextTurn' }))
        if (hasTui(ctx)) guarded('H17 notice notify', () => ctx.ui.notify(notice.user, 'info'))
      })().catch((e: unknown) => { report('session start', e) }).finally(ready)
      return m.ready
    }

    pi.on('session_start', async (event: { reason?: string }, ctx: PiContext): Promise<undefined> => {
      try {
        const sid = sessionOf(ctx)
        if (sid === undefined) return undefined
        currentSid = sid
        deps.setEnv('BURACLE_SESSION_ID', sid)
        deps.setEnv('BURACLE_HARNESS', H)
        void slugOf(sid, ctx.cwd)
        if (memo(sid).starting === undefined) await openSession(sid, ctx, event.reason === 'startup' || event.reason === undefined ? 'startup' : event.reason === 'new' ? 'clear' : 'resume')
      } catch (e) {
        report('session_start', e)
      }
      return undefined
    })

    pi.on('session_shutdown', async (_event: unknown, ctx: PiContext): Promise<undefined> => {
      try {
        const sid = sessionOf(ctx) ?? currentSid
        if (sid !== undefined) await sessionEnd({ harness: H, sessionId: sid, now: deps.now() }, pipe(sid))
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
      } catch (e) {
        report('turn_end', e)
      }
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
