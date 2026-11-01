import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { ToolCall, ToolKind } from '../../core/events'
import { classifyTool } from '../../core/events'
import { workflowOfPrompt, workflowOfSkill } from '../../core/flow/catalog'
import { spoolPromptExcerpt, type SpoolEntry } from '../../core/memory/spool'
import { promptSignals } from '../../core/memory/signals'
import { checkBash, type BashGuardOptions } from '../../core/policy/bash-guard'
import { checkWrite } from '../../core/policy/write-guard'
import { validateReviewJson } from '../../core/policy/review'
import { routeTool } from '../../core/policy/routing'
import { checkQuestion, questionAnswered } from '../../core/policy/questions'
import type { PromptSignals } from '../../core/policy/intents'
import { detectSignals, isGuardContinuation, isUserText } from '../../core/policy/intents'
import { laneStateDenial } from '../../core/policy/lane-guard'
import { consentVerdict, type ConsentState } from '../../core/policy/consent'
import { REVIEWER_AGENT_ENV, companionAgent, companionToolDenial } from '../../core/policy/companion-fence'
import { reviewerShellDenial } from '../../core/policy/readonly-shell'
import { PROMPT_CONTEXT_MAX_CHARS } from '../../core/policy/skill-router'
import { ledgerCall, ledgerMcpResult, ledgerPrompt, skillOf } from '../../core/policy/usage'
import { validatePlan } from '../../core/plan/format'
import type { SessionState } from '../../core/plan/state'
import { answerReceipt, stopGuardVerdict } from '../../core/plan/state'
import { promptInteraction } from '../../core/plan/interaction'
import { reviewNotesNotice } from '../shared/review-notes'
import { handoffNote, restoreContext } from '../../core/compact'
import type { NoticeTexts } from '../../core/notices'
import { contextThresholds, contextWatch, type ContextBand } from '../../core/status/context'
import type { WorkspaceInfo } from '../../core/workspace'
import { workspaceContext, workspaceNotice } from '../../core/workspace'
import { atomicWriteSync, readJsonSafeSync } from '../../engine/fsx'
import { currentBranch, projectSlug } from '../../engine/git'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import { run as runProcess } from '../../engine/proc'
import { loadLedger, resetLedger, updateLedger } from '../../workflow/ledger'
import { shownPath } from '../../workflow/plan-capture'
import { captureSessionPlan } from '../../workflow/plan-native'
import { loadState, profileGuard, readTelemetry, sessionMaint, updateState } from '../../workflow/session-store'
import { canonicalDir, refreshWorkspaceInfo } from '../../workflow/workspace'
import type { AdapterContext } from '../registry'
import { consentFile, consentGate, readConsentState, recordPromptGrants } from '../shared/consent-store'
import { fileCheckNotes, sessionOnce } from '../shared/file-checks'
import { noticesOff, runtimeVersion, startupNotices } from '../shared/notices'
import { assetsAfterEdit, assetsOptions, assetsSessionStart, type AssetsSpawner } from '../shared/project-assets'
import { realWriteTarget } from '../shared/realpath'
import { buracleRepoFor } from '../shared/repo'
import { selfPaths } from '../shared/self-paths'
import { earlyEdit, readOnlyStart } from '../shared/plan-mode'
import { SHELL_TOOLS } from './constants'
import { postCompact, preCompact, projectHandoff, recentCompact, REVIEW_AGENT, sessionEnd, stop, subagentStop } from './hook-end'
import { HANDBACK_TOOL, subagentHandback } from './hook-handback'
import { preMcpWrite, preWrite } from './hook-write'
import {
  CONTEXT_BUDGET_BYTES, GUARD_FAILED, H, QUIET, byteLength, captureOff, clipBytes, contextOut, isObj, isSubagent, out, spool, step, str, type HookOutcome,
} from './hook-io'
import {
  availableServers, capabilityCardText, memoryOnlyRouting, permissionNotice, pluginRoot, pluginServers, projectDeps, promptRouting,
  readHealth, readWorkspace, rootCheck, routerData, routingPolicy, saveWorkspace, sessionHealth, usageReminders, workspaceFacts, type PromptRouting,
  type RouterData,
} from './hook-route'
import { addedText, exitCodeOf, failed, noteWork, removedText } from './hook-work'
import { uiSessionHooks, type UiSessionHooks } from '../shared/ui-session'

export type { HookOutcome } from './hook-io'
export { CONTEXT_BUDGET_BYTES, FALLBACK_SPOOL_SUFFIX, GUARD_FAILED, clipBytes } from './hook-io'
export { REVIEW_AGENT, handoffRecordPath, reviewNote, runawayNotice } from './hook-end'
export { WRITE_GUARD_FAILED } from './hook-write'
export { capabilityCardText, readHealth, routingPolicy, sessionHealth } from './hook-route'

export interface HookCore {
  checkBash: typeof checkBash
  checkWrite: typeof checkWrite
  routeTool: typeof routeTool
  validatePlan: typeof validatePlan
  stopGuardVerdict: typeof stopGuardVerdict
  handoffNote: typeof handoffNote
  restoreContext: typeof restoreContext
  validateReviewJson: typeof validateReviewJson
  checkQuestion: typeof checkQuestion
  consentVerdict: typeof consentVerdict
}

export type MemoryModule = 'finalize' | 'handoff' | 'spool' | 'context'

export interface HookDeps {
  now(): number
  importModule(name: MemoryModule): Promise<Record<string, unknown> | undefined>
  branch(cwd: string): Promise<string | undefined>
  project(cwd: string): Promise<string>
  sessionMaint(nowMs: number, keep: string[]): void
  env(name: string): string | undefined
  buracleRepo(cwd: string, ctx: AdapterContext): Promise<string | undefined>
  realpath(p: string): string | undefined
  run(argv: string[], opts?: { cwd?: string, timeoutMs?: number }): Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>
  prepareWorkspace(cwd: string, ctx: AdapterContext, nowMs: number): Promise<WorkspaceInfo | undefined>
  workspaceInfo(cwd: string, ctx: AdapterContext, nowMs: number): Promise<WorkspaceInfo | undefined>
  refreshWorkspace(info: WorkspaceInfo, ctx: AdapterContext, nowMs: number): WorkspaceInfo
  assetsSpawn?: AssetsSpawner
  /** The memory web UI's session record and start (memory.ui.autostart). */
  ui: UiSessionHooks
  core: HookCore
}

const TELEMETRY_FRESH_MS = 5 * 60_000
const PLUGIN_MCP_PREFIX = 'mcp__plugin_buracle_'
const USAGE_TOOLS: readonly string[] = ['Skill', 'Grep', 'Glob']
const WRITE_GATE_MAX_BYTES = 2_000_000

const MODULES: Record<MemoryModule, () => Promise<unknown>> = {
  finalize: () => { const spec = '../../memory/finalize'; return import(spec) as Promise<unknown> },
  handoff: () => { const spec = '../../memory/handoff'; return import(spec) as Promise<unknown> },
  spool: () => { const spec = '../../memory/spool'; return import(spec) as Promise<unknown> },
  context: () => { const spec = '../../memory/context'; return import(spec) as Promise<unknown> },
}

export const defaultHookDeps: HookDeps = {
  now: () => Date.now(),
  async importModule(name) {
    if (process.env['BURACLE_NO_MEMORY'] === '1') return undefined
    try {
      const m = await MODULES[name]()
      return m !== null && typeof m === 'object' ? m as Record<string, unknown> : undefined
    } catch (e) {
      log('debug', `claude hook: optional module memory/${name} is not available`, { error: e })
      return undefined
    }
  },
  branch: cwd => currentBranch(cwd),
  project: cwd => projectSlug(cwd),
  sessionMaint: (nowMs, keep) => { sessionMaint(H, nowMs, { keep }) },
  ui: uiSessionHooks,
  env: name => process.env[name],
  buracleRepo: (cwd, ctx) => buracleRepoFor(cwd, { known: [ctx.repoRoot, ctx.config.repo], home: paths.home() }),
  realpath: p => realWriteTarget(p),
  run: (argv, opts) => runProcess(argv, opts ?? {}),
  async prepareWorkspace(cwd, ctx, nowMs) {
    return (await import('../shared/workspace-start')).prepareWorkspace(cwd, ctx.config, nowMs)
  },
  async workspaceInfo(cwd, ctx, nowMs) {
    return (await import('../../workflow/workspace')).workspaceInfo(cwd, ctx.config, nowMs)
  },
  refreshWorkspace: (info, ctx, nowMs) => refreshWorkspaceInfo(info, ctx.config, nowMs),
  core: { checkBash, checkWrite, routeTool, validatePlan, stopGuardVerdict, handoffNote, restoreContext, validateReviewJson, checkQuestion, consentVerdict },
}

export function parsePayload(stdin: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(stdin) as unknown
    return isObj(v) ? v : undefined
  } catch {
    return undefined
  }
}

export async function claudeHook(event: string, stdin: string, ctx: AdapterContext, deps: Partial<HookDeps> = {}): Promise<HookOutcome> {
  const d: HookDeps = { ...defaultHookDeps, ...deps, core: { ...defaultHookDeps.core, ...(deps.core ?? {}) } }
  const p = parsePayload(stdin)
  if (p === undefined) { log('warn', 'claude hook: stdin is not a JSON object', { event }); return QUIET }
  const sid = p['session_id']
  if (!paths.isValidSessionId(sid)) return noSession(event, p, sid, ctx, d)
  const now = d.now()
  if (d.env('BURACLE_MEMORY_RUNNER') === '1' && (event === 'SessionStart' || event === 'UserPromptSubmit')) return QUIET
  switch (event) {
    case 'SessionStart': return sessionStart(p, sid, ctx, d, now)
    case 'SubagentStart': return subagentStart(p, sid, ctx, d, now)
    case 'UserPromptExpansion': return userPromptExpansion(p, sid, now)
    case 'UserPromptSubmit': return userPromptSubmit(p, sid, ctx, d, now)
    case 'PreToolUse': return preToolUse(p, sid, ctx, d, now)
    case 'PostToolUse': return postToolUse(p, sid, ctx, d, now)
    case 'PostToolUseFailure': return postToolUseFailure(p, sid, ctx, d)
    case 'PreCompact': return preCompact(p, sid, d, now)
    case 'PostCompact': return postCompact(p, sid, d, now)
    case 'Stop': return stop(p, sid, ctx, d, now)
    case 'SubagentStop': return subagentStop(p, sid, d)
    case 'SessionEnd': return sessionEnd(sid, d, now)
    default: return QUIET
  }
}

export const NO_SESSION_ID = 'buracle-no-session'

async function noSession(event: string, p: Record<string, unknown>, sid: unknown, ctx: AdapterContext, d: HookDeps): Promise<HookOutcome> {
  const tool = str(p['tool_name'])
  log('warn', 'claude hook: the payload has no valid session_id; only the PreToolUse guards run', {
    event, ...(tool !== undefined ? { tool } : {}), sessionId: typeof sid === 'string' ? sid.slice(0, 80) : typeof sid,
  })
  if (event !== 'PreToolUse') return QUIET
  return preToolUse(p, NO_SESSION_ID, ctx, d, d.now(), true)
}

async function sessionStart(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  const source = str(p['source']) ?? 'startup'
  const cwd = str(p['cwd']) ?? process.cwd()
  const sub = isSubagent(p)
  if (!sub && (source === 'startup' || source === 'clear')) await step('H24 ledger reset', undefined, () => { resetLedger(H, sid) })
  if (source !== 'compact' && !captureOff(d)) {
    await step('H14 session record', undefined, async () => {
      const mem = await d.importModule('finalize')
      const start = mem?.['sessionStart']
      const model = str(p['model'])
      if (typeof start === 'function') await (start as (h: string, s: string, c: string, o: unknown) => Promise<unknown>)(H, sid, cwd, model !== undefined ? { nowMs: now, model } : { nowMs: now })
    })
  }
  if (!sub) await step('H14 memory UI', undefined, () => (source === 'compact' ? d.ui.seen(H, sid, now) : d.ui.started(H, sid, now)))
  const restore = source === 'compact' ? await step('H07 restore', '', () => restoreText(p, sid, d, now)) : ''
  const card = await step('H15 capability card', '', () => capabilityCardText(ctx, sessionHealth(sid, now)))
  const workspace = await step('H21 workspace', '', () => workspaceStart(cwd, sid, sub, ctx, d, now))
  const assets = sub ? '' : await step('H28 project assets', '', () => assetsSessionStart(readWorkspace(sid)?.root, H, assetsOptions(now, d.assetsSpawn)))
  const notice = source === 'startup' && !sub && !noticesOff()
    ? await step('H17 notices', undefined as NoticeTexts | undefined, () => startupNotices(ctx.canonical.notices, { version: runtimeVersion(ctx.repoRoot), nowMs: now, harness: H }))
    : undefined
  const fixed = [restore, notice?.model ?? '', workspace, assets, card].filter(s => s.trim() !== '')
  const room = CONTEXT_BUDGET_BYTES - byteLength(fixed.join('\n\n')) - 64
  let memory = ''
  if (room > 400 && d.env('BURACLE_NO_MEMORY') !== '1') {
    memory = await step('H13 memory context', '', async () => {
      const mod = await d.importModule('context')
      const fn = mod?.['contextText']
      if (typeof fn !== 'function') return ''
      const text = await (fn as (o: unknown) => Promise<string>)({ cwd, harness: H, nowMs: now, maxBytes: room })
      return text.trim() === '' ? '' : clipBytes(text.trim(), room)
    })
  }
  let warning: string | undefined
  if (source === 'startup') {
    warning = await step('H17 profile guard', undefined as string | undefined, () => {
      const r = readJsonSafeSync<unknown>(paths.runtimeConfigFile())
      return profileGuard(H, r.ok ? r.value : undefined, process.env)
    })
    await step('H16 session maintenance', undefined, () => { d.sessionMaint(now, [sid]) })
  }
  const user = [warning, notice?.user].filter((s): s is string => s !== undefined).join('\n')
  return contextOut('SessionStart', [restore, notice?.model ?? '', memory, workspace, assets, card], user !== '' ? user : undefined)
}

async function workspaceStart(cwd: string, sid: string, sub: boolean, ctx: AdapterContext, d: HookDeps, now: number): Promise<string> {
  const info = sub ? await d.workspaceInfo(cwd, ctx, now) : await d.prepareWorkspace(cwd, ctx, now)
  if (info === undefined) return ''
  if (!sub) saveWorkspace(sid, info)
  return workspaceContext(info, H)
}

async function restoreText(p: Record<string, unknown>, sid: string, d: HookDeps, now: number): Promise<string> {
  const cwd = str(p['cwd'])
  const own = recentCompact(sid, now)
  const handoff = own !== undefined ? own.handoff : cwd !== undefined ? await projectHandoff(cwd, sid, d, now) : undefined
  return d.core.restoreContext(loadState(H, sid), handoff, handoff === undefined ? own?.todo : undefined) ?? ''
}

async function subagentStart(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  const cwd = str(p['cwd']) ?? process.cwd()
  const text = await step('H21 workspace (subagent)', '', async () => {
    const saved = readWorkspace(sid)
    const info = saved !== undefined && saved.cwd === canonicalDir(cwd) ? d.refreshWorkspace(saved, ctx, now) : await d.workspaceInfo(cwd, ctx, now)
    return info !== undefined ? workspaceContext(info, H) : ''
  })
  return contextOut('SubagentStart', [text])
}

async function flowStart(sid: string, workflow: string, args: string, source: 'command' | 'prompt' | 'skill', now: number): Promise<void> {
  await step('H25 flow start', false, async () => {
    const { recordFlowStart } = await import('../../workflow/flow')
    const title = args.replace(/\s+/g, ' ').trim()
    return recordFlowStart(H, sid, title !== '' ? { workflow, title, source } : { workflow, source }, now)
  })
}

async function userPromptExpansion(p: Record<string, unknown>, sid: string, now: number): Promise<HookOutcome> {
  if (isSubagent(p)) return QUIET
  const name = str(p['command_name']) ?? ''
  const workflow = /^buracle:[a-z0-9][a-z0-9-]*$/.test(name) ? workflowOfSkill(name) : undefined
  if (workflow !== undefined) await flowStart(sid, workflow, str(p['command_args']) ?? '', 'command', now)
  return QUIET
}

const NO_SIGNALS: PromptSignals = { control: null, recall: false, write: false }

export function consentPath(sid: string): string {
  return consentFile(H, sid)
}

export function readConsent(sid: string): ConsentState {
  return readConsentState(H, sid)
}

const WARNED_BANDS = ['warn', 'critical'] as const

function claimBand(dir: string, band: ContextBand): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    closeSync(openSync(join(dir, `context-warned-${band}.claim`), 'wx', 0o600))
    return true
  } catch {
    return false
  }
}

function contextWarning(ctx: AdapterContext, sid: string, now: number): string | undefined {
  const t = readTelemetry(H, sid)
  const pct = t?.ctx?.pct
  if (pct === undefined || t === undefined || now - t.at > TELEMETRY_FRESH_MS) return undefined
  const th = contextThresholds(ctx.config.context)
  const dir = paths.sessionDir(H, sid)
  const file = join(dir, 'context-warned.json')
  const r = readJsonSafeSync<{ band?: string }>(file)
  const prev = r.ok && (r.value?.band === 'warn' || r.value?.band === 'critical' || r.value?.band === 'ok') ? r.value.band as ContextBand : 'ok'
  const w = contextWatch(prev, pct, th)
  if (w.warned !== prev) { try { atomicWriteSync(file, JSON.stringify({ band: w.warned ?? 'ok' }) + '\n') } catch {  } }
  if (w.band === 'ok') for (const b of WARNED_BANDS) rmSync(join(dir, `context-warned-${b}.claim`), { force: true })
  if (w.warn === undefined || w.band === undefined || !claimBand(dir, w.band)) return undefined
  return w.band === 'critical'
    ? `Buracle: the context window is ${Math.round(pct)}% full and Claude Code will compact soon. Finish the current atomic step and keep the plan file and todo list current; Buracle saves the plan state before compaction and restores it afterwards. Do not skip verification.`
    : `Buracle: the context window is ${Math.round(pct)}% full. Keep the plan file and todo list current so work survives compaction; read narrow line ranges instead of whole files.`
}

function controlNotice(control: PromptSignals['control'], prompt: string, sid: string, ctx: AdapterContext, now: number): string | undefined {
  const opts = { autoPause: ctx.config.plan.autoPause, now }
  const before = loadState(H, sid)
  if (before.plan === undefined) return promptInteraction(before, control, prompt, opts).guidance
  let guidance: string | undefined
  updateState(H, sid, (s: SessionState) => {
    const r = promptInteraction(s, control, prompt, opts)
    guidance = r.guidance
    return r.next
  })
  return guidance
}

async function promptRoute(prompt: string, signals: PromptSignals, sid: string, ctx: AdapterContext, d: HookDeps, now: number, invoked: string[] = []): Promise<string | undefined> {
  const root = pluginRoot(ctx.repoRoot, d.env)
  const available = availableServers(root, sessionHealth(sid, now), ctx)
  let data: RouterData | undefined
  try { data = routerData(ctx) } catch (e) { log('warn', 'claude hook: the prompt router has no canonical data; routing memory signals only', { error: e }) }
  let routing: PromptRouting
  if (data !== undefined) {
    const o: Parameters<typeof promptRouting>[2] = { ledger: loadLedger(H, sid), available, skills: ctx.config.routing.skills, pluginRoot: root }
    const deps = projectDeps(readWorkspace(sid)?.root)
    if (deps !== undefined) o.deps = deps
    routing = promptRouting(prompt, data, o)
  } else {
    routing = memoryOnlyRouting(signals, available, ctx.config.routing.strictness)
  }
  invoked.push(...routing.route.invoked, ...routing.route.load)
  await step('H24 ledger prompt', undefined, () => { updateLedger(H, sid, l => ledgerPrompt(l, routing.route, now)) })
  return routing.text
}

function workspaceUpdate(sid: string, ctx: AdapterContext, d: HookDeps, now: number): string | undefined {
  const prev = readWorkspace(sid)
  if (prev === undefined) return undefined
  const next = d.refreshWorkspace(prev, ctx, now)
  if (JSON.stringify(next) !== JSON.stringify(prev)) saveWorkspace(sid, next)
  return workspaceNotice(prev, next)
}

function fitPrompt(parts: ReadonlyArray<{ text: string | undefined, order: number }>, max: number): string[] {
  const kept: Array<{ text: string, order: number }> = []
  let size = 0
  for (const part of parts) {
    if (part.text === undefined || part.text.trim() === '') continue
    const n = part.text.length + 2
    if (kept.length > 0 && size + n > max) continue
    kept.push({ text: part.text, order: part.order })
    size += n
  }
  return kept.sort((a, b) => a.order - b.order).map(k => k.text)
}

async function userPromptSubmit(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  if (isSubagent(p)) return QUIET
  const prompt = typeof p['prompt'] === 'string' ? p['prompt'] : ''
  const continuation = await step('H10 isGuardContinuation', false, () => isGuardContinuation(prompt))
  const user = !continuation && isUserText(prompt)
  let control: string | undefined
  let routed: string | undefined
  let system: string | undefined
  let planMode: string | undefined
  let notes: string | undefined
  const entries: SpoolEntry[] = []
  if (user) {
    const signals = await step('H10 detectSignals', NO_SIGNALS, () => detectSignals(prompt))
    control = await step('H10 intents', undefined as string | undefined, () => controlNotice(signals.control, prompt, sid, ctx, now))
    notes = await step('H10 review notes', undefined as string | undefined, () => {
      const ws = readWorkspace(sid)
      return reviewNotesNotice(H, sid, { plan: loadState(H, sid).plan?.path, roots: [ws?.root, ws?.cwd, typeof p['cwd'] === 'string' ? p['cwd'] : undefined], now })
    })
    await step('H20 grants', undefined, () => { recordPromptGrants(H, sid, prompt, now) })
    const typed = workflowOfPrompt(prompt)
    if (typed !== undefined) await flowStart(sid, typed.workflow, typed.args, 'prompt', now)
    const invoked: string[] = []
    routed = await step('H22 route.prompt', undefined as string | undefined, () => promptRoute(prompt, signals, sid, ctx, d, now, invoked))
    planMode = await step('H10 read-only start', undefined as string | undefined, () => readOnlyStart(H, p['permission_mode'] === 'plan', [typed?.workflow, ...invoked]))
    system = await step('permission mode', undefined as string | undefined, () => permissionNotice(sid, p['permission_mode'], ctx.config, now))
    if (!captureOff(d)) {
      const signals26 = await step('H26 prompt signals', [] as ReturnType<typeof promptSignals>, () => promptSignals(prompt))
      for (const signal of signals26) entries.push({ ts: now, ev: 'prompt-signal', signal })
    }
  }
  const notice = await step('H21 workspace notice', undefined as string | undefined, () => workspaceUpdate(sid, ctx, d, now))
  const warning = await step('H05 context warning', undefined as string | undefined, () => contextWarning(ctx, sid, now))
  if (!continuation) {
    const excerpt = user ? spoolPromptExcerpt(prompt) : undefined
    await spool(d, sid, [{ ts: now, ev: 'prompt', ...(excerpt !== undefined ? { excerpt } : {}) }, ...entries])
    if (!captureOff(d)) await step('session record touch', undefined, async () => {
      const seen = (await d.importModule('finalize'))?.['promptSeen']
      if (typeof seen === 'function') (seen as (h: string, s: string, o: unknown) => unknown)(H, sid, { nowMs: now })
    })
  }
  await step('H14 memory UI', undefined, () => d.ui.seen(H, sid, now))
  const parts = fitPrompt([
    { text: control, order: 0 }, { text: planMode, order: 0 }, { text: notes, order: 0 }, { text: warning, order: 3 }, { text: routed, order: 1 }, { text: notice, order: 2 },
  ], PROMPT_CONTEXT_MAX_CHARS)
  return contextOut('UserPromptSubmit', parts, system)
}

function deny(reason: string): HookOutcome {
  return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}

function preContext(lines: readonly string[], updatedInput?: Record<string, unknown>): HookOutcome {
  const text = lines.filter(l => l.trim() !== '').join('\n')
  if (text === '' && updatedInput === undefined) return QUIET
  return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...(updatedInput !== undefined ? { updatedInput } : {}), ...(text !== '' ? { additionalContext: text } : {}) } })
}

export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']
const WEB_TOOLS: readonly string[] = ['WebSearch', 'WebFetch']

function denies(o: HookOutcome): boolean {
  const j = hookOutput(o)
  const hso = j !== undefined && isObj(j['hookSpecificOutput']) ? j['hookSpecificOutput'] : {}
  return hso['permissionDecision'] === 'deny'
}

function hookOutput(o: HookOutcome): Record<string, unknown> | undefined {
  if (o.stdout.trim() === '') return {}
  try {
    const v = JSON.parse(o.stdout) as unknown
    return isObj(v) ? v : undefined
  } catch { return undefined }
}

async function preToolUse(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number, guardsOnly = false): Promise<HookOutcome> {
  const decided = await preToolDecision(p, sid, ctx, d, now, guardsOnly)
  if (guardsOnly || isSubagent(p)) return decided
  const j = hookOutput(decided)
  const hso = j !== undefined && isObj(j['hookSpecificOutput']) ? j['hookSpecificOutput'] : {}
  if (j === undefined || hso['permissionDecision'] !== undefined) return decided
  const warning = await step('H05 context warning', undefined as string | undefined, () => contextWarning(ctx, sid, now))
  if (warning === undefined) return decided
  const before = typeof hso['additionalContext'] === 'string' && hso['additionalContext'] !== '' ? `${hso['additionalContext']}\n` : ''
  return out({ ...j, hookSpecificOutput: { ...hso, hookEventName: 'PreToolUse', additionalContext: `${before}${warning}` } })
}

async function preToolDecision(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number, guardsOnly = false): Promise<HookOutcome> {
  const tool = str(p['tool_name']) ?? ''
  const input = isObj(p['tool_input']) ? p['tool_input'] : {}
  const cwd = str(p['cwd']) ?? ''
  const fenced = companionFence(d, tool, input)
  if (fenced !== undefined) return deny(fenced)
  if (WRITE_TOOLS.includes(tool)) {
    const denied = await preWrite(p, sid, ctx, d)
    if (denied !== undefined) return denied
    if (tool === 'NotebookEdit' || guardsOnly) return QUIET
    const call: ToolCall = { harness: H, sessionId: sid, cwd, tool, input, ...classifyTool(H, tool, input, cwd) }
    const early = await step('H03 early edit', undefined as ReturnType<typeof earlyEdit>, () => earlyEdit(H, sid, call.paths, cwd, ctx.config.plan.planApproval))
    const gated = await usageGate(sid, ctx, d, call, early !== undefined ? [early.note] : [], writeEdits(call))
    if (early !== undefined && !denies(gated)) await step('H03 early edit mark', undefined, () => { early.commit() })
    return gated
  }
  if (SHELL_TOOLS.includes(tool)) return preShell(p, sid, ctx, d, now, tool, input, cwd, guardsOnly)
  if (guardsOnly && !tool.startsWith('mcp__')) return QUIET
  if (tool === HANDBACK_TOOL) return subagentHandback(p, sid, REVIEW_AGENT, d, now)
  if (tool === 'AskUserQuestion') {
    return step('H09 checkQuestion', QUIET, () => {
      const call: ToolCall = { harness: H, sessionId: sid, cwd, tool, input, ...classifyTool(H, tool, input, cwd) }
      const v = d.core.checkQuestion(loadState(H, sid), call, now)
      if (v.deny !== undefined) return deny(`Buracle H09 (plan.question): ${v.deny}`)
      return isSubagent(p) || v.context === undefined ? QUIET : preContext([v.context])
    })
  }
  if (WEB_TOOLS.includes(tool)) {
    return step('H03 routing', QUIET, () => {
      const call: ToolCall = { harness: H, sessionId: sid, cwd, tool, input, ...classifyTool(H, tool, input, cwd) }
      const r = d.core.routeTool(call, routingPolicy(ctx), sessionHealth(sid, now))
      if (r.action === 'deny') return deny(`Buracle ${r.hook} (route.tools): ${r.reason}`)
      return preContext(r.context ?? [])
    })
  }
  if (USAGE_TOOLS.includes(tool) || tool.startsWith('mcp__')) {
    const servers = pluginServers(pluginRoot(ctx.repoRoot, d.env)) ?? []
    const call: ToolCall = { harness: H, sessionId: sid, cwd, tool, input, ...classifyTool(H, tool, input, cwd, servers) }
    const written = await preMcpWrite(sid, ctx, d, call)
    if (written !== undefined) return written
    if (guardsOnly || !(USAGE_TOOLS.includes(tool) || tool.startsWith(PLUGIN_MCP_PREFIX))) return QUIET
    return usageGate(sid, ctx, d, call, [])
  }
  return QUIET
}

function companionFence(d: HookDeps, tool: string, input: Record<string, unknown>): string | undefined {
  const agent = companionAgent(d.env(REVIEWER_AGENT_ENV))
  if (agent === undefined) return undefined
  try {
    return companionToolDenial(H, agent, tool, input)
  } catch (e) {
    log('error', 'claude hook PreToolUse: the second-opinion fence failed; denying (fail closed)', { tool, error: e })
    return GUARD_FAILED
  }
}

async function preShell(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number, tool: string, input: Record<string, unknown>, cwd: string, guardsOnly = false): Promise<HookOutcome> {
  const cls = classifyTool(H, tool, input, cwd)
  const command = cls.command ?? str(input['command'])
  if (command === undefined) return QUIET
  const shell = tool === 'PowerShell' ? { shell: 'powershell' as const } : {}
  try {
    const options: BashGuardOptions = {
      ...ctx.config.guards.bash, home: paths.home(), selfPaths: selfPaths(ctx.config.repo), cwd,
      vault: paths.oldVaultRoot(), protect: ctx.config.guards.write.protect, realpath: (q: string): string | undefined => d.realpath(q), ...shell,
    }
    const verdict = d.core.checkBash(command, options)
    if (verdict.deny !== undefined) return deny(verdict.deny)
  } catch (e) {
    log('error', 'claude hook PreToolUse: H01 bash guard failed; denying (fail closed)', { sid, tool, error: e })
    return deny(GUARD_FAILED)
  }
  const reviewer = await step('reviewer shell', undefined as string | undefined, () => reviewerShellDenial(str(p['agent_type']), command))
  if (reviewer !== undefined) return deny(reviewer)
  const lane = isSubagent(p) ? await step('H01 lane guard', undefined as string | undefined, () => laneStateDenial(command)) : undefined
  if (lane !== undefined) return deny(lane)
  const consent = await step('H20 consent', undefined as string | undefined, () => consentGate(H, sid, command, now, (c, s, t) => d.core.consentVerdict(c, s, t, shell)))
  if (consent !== undefined) return deny(`Buracle H20 (consent.gate): ${consent}`)
  if (guardsOnly) return QUIET
  const call: ToolCall = { harness: H, sessionId: sid, cwd, tool, input, ...cls, kind: 'bash', command }
  const routed = await step('H03 routing', { context: [] as string[] } as { deny?: string, context: string[] }, () => {
    const r = d.core.routeTool(call, routingPolicy(ctx), readHealth())
    return r.action === 'deny' ? { deny: r.reason, context: [] } : { context: r.context ?? [] }
  })
  if (routed.deny !== undefined) return deny(routed.deny)
  return usageGate(sid, ctx, d, call, routed.context)
}

function writeEdits(call: ToolCall): Array<{ file: string, removed: string, added: string }> | undefined {
  if (call.tool !== 'Write') return undefined
  const file = call.paths[0]
  const added = call.input['content']
  if (file === undefined || typeof added !== 'string') return undefined
  let removed = ''
  try {
    const st = statSync(file)
    if (st.isFile() && st.size <= WRITE_GATE_MAX_BYTES) removed = readFileSync(file, 'utf8')
  } catch {  }
  return [{ file, removed, added }]
}

async function usageGate(sid: string, ctx: AdapterContext, d: HookDeps, call: ToolCall, context: readonly string[], edits?: Array<{ file: string, removed: string, added: string }>, updatedInput?: Record<string, unknown>): Promise<HookOutcome> {
  return step('H24 usage', preContext(context, updatedInput), () => {
    const cfg = ctx.config
    const info = readWorkspace(sid)
    const root = rootCheck(call, info, cfg)
    if (root.deny !== undefined) return deny(`Buracle H03 (route.tools): ${root.deny}`)
    if (root.context !== undefined) {
      updateLedger(H, sid, l => ledgerCall(l, call))
      return preContext([...context, root.context], updatedInput)
    }
    const facts = workspaceFacts(info, cfg)
    const servers = pluginServers(pluginRoot(ctx.repoRoot, d.env)) ?? []
    const health = sessionHealth(sid, d.now())
    const rctx: Parameters<typeof usageReminders>[2] = {
      strictness: cfg.routing.strictness, reminders: cfg.routing.reminders, available: servers.filter(id => health[id] !== 'down'),
      policy: routingPolicy(ctx), facts,
    }
    if (call.kind === 'edit' || call.kind === 'write') {
      const deps = projectDeps(facts.root)
      if (deps !== undefined) rctx.deps = deps
      if (edits !== undefined) rctx.edits = edits
    }
    const r = usageReminders(sid, call, rctx)
    if (r.deny !== undefined) return deny(`Buracle H03 (route.tools): ${r.deny.reason.replace(/^Buracle:\s*/, '')}`)
    return preContext(r.context !== undefined ? [...context, r.context] : context, updatedInput)
  })
}

const POST_EDIT_BUDGET_MS = 28_000

function pluginSkillRead(file: string | undefined, root: string): string | undefined {
  if (file === undefined) return undefined
  const rel = relative(root, file).split(sep).join('/')
  return /^skills\/([a-z0-9][a-z0-9-]*)\/SKILL\.md$/.exec(rel)?.[1]
}

async function skillLoaded(sid: string, id: string, args: string, now: number): Promise<void> {
  const workflow = workflowOfSkill(`buracle:${id}`)
  if (workflow !== undefined) await flowStart(sid, workflow, args, 'skill', now)
}

async function postToolUse(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  const tool = str(p['tool_name']) ?? ''
  const input = isObj(p['tool_input']) ? p['tool_input'] : {}
  const response = p['tool_response']
  const cwd = str(p['cwd']) ?? process.cwd()
  const sub = isSubagent(p)
  const parts: string[] = []
  const entries: SpoolEntry[] = []
  if (!sub) await step('H14 memory UI', undefined, () => d.ui.seen(H, sid, now))
  if (tool.startsWith(PLUGIN_MCP_PREFIX)) await step('H24 MCP result', undefined, () => { mcpResult(sid, tool, input, cwd, ctx, d, true) })
  if (WRITE_TOOLS.includes(tool)) {
    const cls = await step('classify', { kind: 'other', paths: [] } as ReturnType<typeof classifyTool>, () => classifyTool(H, tool, input, cwd))
    if (!failed(response) && cls.paths.length > 0) {
      const notes = await step('H04 file checks', [] as string[], () => fileCheckNotes(cls.paths, addedText(tool, input, cls.paths), cwd, ctx.config.checkers, { now: d.now, run: d.run, once: sessionOnce(H, sid) }, now + POST_EDIT_BUDGET_MS, removedText(tool, input, cls.paths)))
      if (notes.length > 0) parts.push(`Buracle file checks:\n\n${notes.join('\n\n')}`)
      const assets = await step('H28 project assets', undefined as string | undefined, () => assetsAfterEdit(readWorkspace(sid)?.root, cls.paths, assetsOptions(now, d.assetsSpawn)))
      if (assets !== undefined) parts.push(assets)
    }
    if (!sub) entries.push({ ts: now, ev: 'tool', tool, kind: tool === 'Write' ? 'write' : 'edit', paths: cls.paths })
  } else if (tool === 'ExitPlanMode') {
    const plan = (isObj(response) ? str(response['plan']) : undefined) ?? str(input['plan'])
    const awaiting = isObj(response) && response['awaitingLeaderApproval'] === true
    if (!sub && plan !== undefined && !awaiting && !failed(response)) {
      const saved = await step('H12 plan capture', undefined as Awaited<ReturnType<typeof captureSessionPlan>>, () => captureSessionPlan({ plan, cwd, now, harness: H, sid }))
      if (saved !== undefined) {
        entries.push({ ts: now, ev: 'note', paths: [saved.path] })
        parts.push(saved.note ?? `Buracle: the approved plan was saved to ${shownPath(saved.path, cwd)} (H12).`)
      }
    }
  } else if (tool === 'AskUserQuestion') {
    if (!sub && !failed(response) && questionAnswered(response)) await step('H08 answer receipt', undefined, () => { updateState(H, sid, (s: SessionState) => answerReceipt(s, now)) })
    return QUIET
  } else if (tool === 'TodoWrite' || tool === 'TaskCreate' || tool === 'TaskUpdate') {
    if (!sub) await step('open work', undefined, () => noteWork(sid, tool, input, response))
  } else if (tool === 'Read') {
    const call: ToolCall = { harness: H, sessionId: sid, cwd, tool, input, ...classifyTool(H, tool, input, cwd) }
    await step('H24 ledger', undefined, () => { updateLedger(H, sid, l => ledgerCall(l, call)) })
    const id = pluginSkillRead(call.paths[0], pluginRoot(ctx.repoRoot, d.env))
    if (id !== undefined && !sub && !failed(response)) await skillLoaded(sid, id, '', now)
  } else if (tool === 'Skill') {
    const id = skillOf({ tool, input, kind: 'other' }, H)
    if (!sub && id !== undefined && !failed(response)) await skillLoaded(sid, id, str(input['args']) ?? '', now)
    if (!sub) entries.push({ ts: now, ev: 'tool', tool, kind: 'other' })
  } else if (SHELL_TOOLS.includes(tool)) {
    if (!sub) {
      const e: SpoolEntry = { ts: now, ev: 'tool', tool, kind: 'bash' }
      const command = str(input['command'])
      if (command !== undefined) e.cmd = command.slice(0, 500)
      const exit = exitCodeOf(response)
      if (exit !== undefined) e.exit = exit
      entries.push(e)
    }
  } else if (!sub) {
    const kind = await step('classify', 'other' as ToolKind, () => classifyTool(H, tool, input, cwd).kind)
    entries.push({ ts: now, ev: 'tool', tool, kind: kind === 'mcp' || kind === 'web_search' || kind === 'web_fetch' ? kind : 'other' })
  }
  await spool(d, sid, entries)
  return contextOut('PostToolUse', parts)
}

function mcpResult(sid: string, tool: string, input: Record<string, unknown>, cwd: string, ctx: AdapterContext, d: HookDeps, ok: boolean): void {
  const cls = classifyTool(H, tool, input, cwd, pluginServers(pluginRoot(ctx.repoRoot, d.env)) ?? [])
  const server = cls.kind === 'mcp' ? cls.mcp?.server : undefined
  if (server === undefined || server === '') return
  if (ok && loadLedger(H, sid).mcpErrors?.[server] === undefined) return
  updateLedger(H, sid, l => ledgerMcpResult(l, server, ok))
}

async function postToolUseFailure(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps): Promise<HookOutcome> {
  const tool = str(p['tool_name']) ?? ''
  if (!tool.startsWith(PLUGIN_MCP_PREFIX) || p['is_interrupt'] === true) return QUIET
  const input = isObj(p['tool_input']) ? p['tool_input'] : {}
  await step('H24 MCP result', undefined, () => { mcpResult(sid, tool, input, str(p['cwd']) ?? '', ctx, d, false) })
  return QUIET
}
