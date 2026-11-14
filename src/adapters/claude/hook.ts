import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import type { ToolCall, ToolKind } from '../../core/events'
import { classifyTool } from '../../core/events'
import { workflowOfPrompt, workflowOfSkill } from '../../core/flow/catalog'
import type { SpoolEntry } from '../../core/memory/spool'
import { checkBash } from '../../core/policy/bash-guard'
import { checkWrite } from '../../core/policy/write-guard'
import { validateReviewJson } from '../../core/policy/review'
import { mcpUnavailable, routeTool } from '../../core/policy/routing'
import { checkQuestion, questionAnswered } from '../../core/policy/questions'
import type { PromptSignals } from '../../core/policy/intents'
import { isUserText } from '../../core/policy/intents'
import { laneStateDenial } from '../../core/policy/lane-guard'
import { consentVerdict, type ConsentState } from '../../core/policy/consent'
import { REVIEWER_AGENT_ENV, companionAgent, companionToolDenial } from '../../core/policy/companion-fence'
import { reviewerShellDenial } from '../../core/policy/readonly-shell'
import { PROMPT_CONTEXT_MAX_CHARS } from '../../core/policy/skill-router'
import { ledgerCall, skillOf, type ReminderContext } from '../../core/policy/usage'
import { validatePlan } from '../../core/plan/format'
import type { SessionState } from '../../core/plan/state'
import { answerReceipt, stopGuardVerdict } from '../../core/plan/state'
import { reviewNotesNotice } from '../shared/review-notes'
import { handoffNote, restoreContext } from '../../core/compact'
import { contextThresholds, contextWatch, type ContextBand } from '../../core/status/context'
import type { WorkspaceInfo } from '../../core/workspace'
import { workspaceContext } from '../../core/workspace'
import { atomicWriteSync, readJsonSafeSync } from '../../engine/fsx'
import { currentBranch, projectSlug } from '../../engine/git'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import { run as runProcess } from '../../engine/proc'
import { loadLedger, updateLedger } from '../../workflow/ledger'
import { shownPath } from '../../workflow/plan-capture'
import { captureSessionPlan } from '../../workflow/plan-native'
import { loadState, readTelemetry, sessionMaint, updateState } from '../../workflow/session-store'
import { canonicalDir, refreshWorkspaceInfo } from '../../workflow/workspace'
import type { AdapterContext } from '../registry'
import { consentFile, readConsentState } from '../shared/consent-store'
import { sessionOnce } from '../shared/file-checks'
import { noticesOff, runtimeVersion, startupNotices } from '../shared/notices'
import type { AssetsSpawner } from '../shared/project-assets'
import {
  latestHandoffId, postTool, preTool, prompt as promptEvent, recordMcpResult, sessionStart as sessionStartEvent,
  type PipelineDeps, type PipelinePoint, type PreToolDecision, type PreToolInput,
} from '../shared/pipeline/index'
import { realWriteTarget } from '../shared/realpath'
import { buracleRepoFor } from '../shared/repo'
import { selfPaths } from '../shared/self-paths'
import { earlyEdit, readOnlyStart } from '../shared/plan-mode'
import { SHELL_TOOLS } from './constants'
import { postCompact, preCompact, recentCompact, REVIEW_AGENT, sessionEnd, stop, subagentStop } from './hook-end'
import { HANDBACK_TOOL, subagentHandback } from './hook-handback'
import { pipelineDeps } from './hook-pipeline'
import { WRITE_GUARD_FAILED, writeGuardContext, writeTargets } from './hook-write'
import {
  GUARD_FAILED, H, QUIET, clipBytes, contextOut, isObj, isSubagent, out, step, str, type HookOutcome,
} from './hook-io'
import {
  availableServers, capabilityCardText, memoryOnlyRouting, permissionNotice, pluginRoot, pluginServers, projectDeps, promptRouting,
  readHealth, readWorkspace, rootCheck, routerData, routingPolicy, sessionHealth, workspaceFacts, type PromptRouting,
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
    case 'PreCompact': return preCompact(p, sid, ctx, d, now)
    case 'PostCompact': return postCompact(p, sid, d, now)
    case 'Stop': return stop(p, sid, ctx, d, now)
    case 'SubagentStop': return subagentStop(p, sid, d)
    case 'SessionEnd': return sessionEnd(sid, ctx, d, now)
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

function setupWarning(profile: string | undefined): string {
  return profile !== undefined ? `Buracle setup warning. Tell the user at the start of your next reply, in one short line, then carry on with their request:\n- ${profile}` : ''
}

async function sessionStart(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  const source = str(p['source']) ?? 'startup'
  const cwd = str(p['cwd']) ?? process.cwd()
  const model = str(p['model'])
  const pd = pipelineDeps(sid, ctx, d)
  // Claude Code prints a SessionStart systemMessage as "SessionStart:startup says: …" at the top of every session, so
  // nothing goes there: the profile warning and the notices reach the user through the model's first reply.
  const { parts } = await sessionStartEvent({ harness: H, sessionId: sid, cwd, source, subagent: isSubagent(p), now, ...(model !== undefined ? { model } : {}) }, {
    ...pd,
    sessionStartOrder: ['ledger', 'record', 'ui', 'restore', 'card', 'workspace', 'assets', 'notices', 'profile', 'memory', 'maint'],
    capabilityCard: () => capabilityCardText(ctx, sessionHealth(sid, now, ctx, { project: cwd, pluginRoot: pluginRoot(ctx.repoRoot, d.env) })),
    restore: () => restoreText(p, sid, d, pd, now),
    noticesOff: () => noticesOff(),
    startupNotices: () => startupNotices(ctx.canonical.notices, { version: runtimeVersion(ctx.repoRoot), nowMs: now, harness: H }),
    runtimeConfigFile: () => paths.runtimeConfigFile(),
    profileEnv: () => process.env,
    sessionMaint: (nowMs, keep) => { d.sessionMaint(nowMs, keep) },
    fixedContext: fixed => [setupWarning(fixed.profile)],
  })
  const memory = parts.memory.trim() === '' ? '' : clipBytes(parts.memory.trim(), parts.room)
  return contextOut('SessionStart', [setupWarning(parts.profile), parts.restore, parts.notice?.model ?? '', memory, parts.workspace, parts.assets, parts.card])
}

async function restoreText(p: Record<string, unknown>, sid: string, d: HookDeps, pd: PipelineDeps, now: number): Promise<string> {
  const cwd = str(p['cwd'])
  const own = recentCompact(sid, now)
  const handoff = own !== undefined ? own.handoff : cwd !== undefined ? await latestHandoffId(pd, sid, cwd, now) : undefined
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

async function promptRoute(prompt: string, signals: PromptSignals, sid: string, ctx: AdapterContext, d: HookDeps, now: number, cwd?: string): Promise<PromptRouting> {
  const root = pluginRoot(ctx.repoRoot, d.env)
  const available = availableServers(root, sessionHealth(sid, now, ctx, { project: cwd ?? process.cwd(), pluginRoot: root }), ctx)
  let data: RouterData | undefined
  try { data = routerData(ctx) } catch (e) { log('warn', 'claude hook: the prompt router has no canonical data; routing memory signals only', { error: e }) }
  if (data === undefined) return memoryOnlyRouting(signals, available, ctx.config.routing.strictness)
  const o: Parameters<typeof promptRouting>[2] = { ledger: loadLedger(H, sid), available, skills: ctx.config.routing.skills, pluginRoot: root }
  const deps = projectDeps(readWorkspace(sid)?.root)
  if (deps !== undefined) o.deps = deps
  return promptRouting(prompt, data, o)
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
  const text = typeof p['prompt'] === 'string' ? p['prompt'] : ''
  const typed = workflowOfPrompt(text)
  let system: string | undefined
  const at = async (point: PipelinePoint): Promise<void> => {
    if (point === 'prompt.granted' && typed !== undefined) await flowStart(sid, typed.workflow, typed.args, 'prompt', now)
    else if (point === 'prompt.routed') system = await step('permission mode', undefined as string | undefined, () => permissionNotice(sid, p['permission_mode'], ctx.config, now))
  }
  const { parts } = await promptEvent({ harness: H, sessionId: sid, cwd: str(p['cwd']) ?? process.cwd(), text, userText: isUserText(text), now }, {
    ...pipelineDeps(sid, ctx, d, at),
    reviewNotes() {
      const ws = readWorkspace(sid)
      return reviewNotesNotice(H, sid, { plan: loadState(H, sid).plan?.path, roots: [ws?.root, ws?.cwd, typeof p['cwd'] === 'string' ? p['cwd'] : undefined], now })
    },
    routePrompt: signals => promptRoute(text, signals, sid, ctx, d, now, str(p['cwd'])),
    readOnlyStart: invoked => readOnlyStart(H, p['permission_mode'] === 'plan', [typed?.workflow, ...invoked]),
    contextWarning: () => contextWarning(ctx, sid, now),
  })
  const fitted = fitPrompt([
    { text: parts.guidance, order: 0 }, { text: parts.planMode, order: 0 }, { text: parts.notes, order: 0 }, { text: parts.warning, order: 3 }, { text: parts.route, order: 1 }, { text: parts.workspace, order: 2 },
  ], PROMPT_CONTEXT_MAX_CHARS)
  return contextOut('UserPromptSubmit', fitted, system)
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

/** A pipeline denial in Claude Code's words; a guard that itself failed is logged and denies (fail closed). */
function denyText(r: Extract<PreToolDecision, { action: 'deny' }>, sid: string, tool: string): string {
  switch (r.source) {
    case 'bash':
      if (r.error === undefined) return r.reason
      log('error', 'claude hook PreToolUse: H01 bash guard failed; denying (fail closed)', { sid, tool, error: r.error })
      return GUARD_FAILED
    case 'write':
    case 'mcpWrite':
      if (r.error === undefined) return r.source === 'write' ? r.reason : `Buracle H02 (guard.write): ${r.reason}`
      log('error', `claude hook PreToolUse: H02 write guard failed${r.source === 'mcpWrite' ? ' for an MCP call' : ''}; denying (fail closed)`, { sid, tool, error: r.error })
      return WRITE_GUARD_FAILED
    case 'consent': return `Buracle H20 (consent.gate): ${r.reason}`
    case 'route': return SHELL_TOOLS.includes(tool) ? r.reason : `Buracle ${r.hook} (route.tools): ${r.reason}`
    case 'root':
    case 'usage': return `Buracle H03 (route.tools): ${r.reason}`
    default: return r.reason
  }
}

async function preToolDecision(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number, guardsOnly = false): Promise<HookOutcome> {
  const tool = str(p['tool_name']) ?? ''
  const input = isObj(p['tool_input']) ? p['tool_input'] : {}
  const cwd = str(p['cwd']) ?? ''
  const fenced = companionFence(d, tool, input)
  if (fenced !== undefined) return deny(fenced)
  const write = WRITE_TOOLS.includes(tool)
  const shell = SHELL_TOOLS.includes(tool)
  const mcp = tool.startsWith('mcp__')
  if (!write && !shell) {
    if (guardsOnly && !mcp) return QUIET
    if (tool === HANDBACK_TOOL) return subagentHandback(p, sid, REVIEW_AGENT, d, now)
  }
  const callOf = (cls: ReturnType<typeof classifyTool>): ToolCall => ({ harness: H, sessionId: sid, cwd, tool, input, ...cls })
  let call: ToolCall
  let checks: PreToolInput['checks']
  if (write) {
    try {
      call = callOf(classifyTool(H, tool, input, cwd))
    } catch (e) {
      log('error', 'claude hook PreToolUse: H02 write guard failed; denying (fail closed)', { sid, tool, error: e })
      return deny(WRITE_GUARD_FAILED)
    }
    checks = { write: true, usage: tool !== 'NotebookEdit' }
  } else if (shell) {
    const cls = classifyTool(H, tool, input, cwd)
    const command = cls.command ?? str(input['command'])
    if (command === undefined) return QUIET
    call = { ...callOf(cls), kind: 'bash', command }
    checks = { bash: true, route: true, usage: true }
  } else if (tool === 'AskUserQuestion') {
    call = callOf(classifyTool(H, tool, input, cwd))
    checks = { question: true }
  } else if (WEB_TOOLS.includes(tool)) {
    call = callOf(classifyTool(H, tool, input, cwd))
    checks = { route: true }
  } else if (USAGE_TOOLS.includes(tool) || mcp) {
    call = callOf(classifyTool(H, tool, input, cwd, pluginServers(pluginRoot(ctx.repoRoot, d.env)) ?? []))
    checks = { mcpWrite: true, usage: USAGE_TOOLS.includes(tool) || tool.startsWith(PLUGIN_MCP_PREFIX) }
  } else {
    return QUIET
  }
  const web = call.kind === 'web_search' || call.kind === 'web_fetch'
  const r = await preTool({ call, now, subagent: isSubagent(p), guardsOnly, checks }, {
    ...pipelineDeps(sid, ctx, d),
    bashOptions: dir => ({
      ...ctx.config.guards.bash, home: paths.home(), selfPaths: selfPaths(ctx.config.repo), cwd: dir,
      vault: paths.oldVaultRoot(), protect: ctx.config.guards.write.protect, realpath: (q: string): string | undefined => d.realpath(q),
    }),
    shellDenial: command => step('reviewer shell', undefined as string | undefined, () => reviewerShellDenial(str(p['agent_type']), command)),
    laneDenial: command => laneStateDenial(command),
    writeTargets: c => writeTargets(c, d),
    writeGuardContext: dir => writeGuardContext(dir, ctx, d),
    routingPolicy: () => routingPolicy(ctx),
    mcpHealth: () => (shell ? () => readHealth() : () => sessionHealth(sid, now, ctx, web ? { project: cwd, pluginRoot: pluginRoot(ctx.repoRoot, d.env) } : undefined)),
    rootCheck: c => rootCheck(c, readWorkspace(sid), ctx.config),
    usage: c => ({ call: c, ledgerId: sid, context: reminderContext(sid, ctx, d, c) }),
    ...(write && tool !== 'NotebookEdit' ? { earlyEdit: () => earlyEdit(H, sid, call.paths, cwd, ctx.config.plan.planApproval) } : {}),
  })
  if (r.action === 'deny') return deny(denyText(r, sid, tool))
  return preContext([r.parts.early, r.parts.question, ...r.parts.route, r.parts.usage].filter((s): s is string => s !== undefined))
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

/** What the usage reminders (H24) judge a call against: the plugin's servers that are up, and the session's workspace. */
function reminderContext(sid: string, ctx: AdapterContext, d: HookDeps, call: ToolCall): ReminderContext {
  const cfg = ctx.config
  const servers = pluginServers(pluginRoot(ctx.repoRoot, d.env)) ?? []
  const health = sessionHealth(sid, d.now(), ctx)
  const rctx: ReminderContext = {
    strictness: cfg.routing.strictness, reminders: cfg.routing.reminders, available: servers.filter(id => !mcpUnavailable(health[id])),
    policy: routingPolicy(ctx), facts: workspaceFacts(readWorkspace(sid), cfg),
  }
  const edits = call.kind === 'edit' || call.kind === 'write' ? writeEdits(call) : undefined
  if (edits !== undefined) rctx.edits = edits
  return rctx
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
  const write = WRITE_TOOLS.includes(tool)
  // What only Claude Code's tools do, after the memory UI's heartbeat: plan capture, open work, skill loads and the spool entry.
  const at = async (point: PipelinePoint): Promise<void> => {
    if (point !== 'postTool.tool' || write || tool === 'AskUserQuestion') return
    if (tool === 'ExitPlanMode') {
      const plan = (isObj(response) ? str(response['plan']) : undefined) ?? str(input['plan'])
      const awaiting = isObj(response) && response['awaitingLeaderApproval'] === true
      if (!sub && plan !== undefined && !awaiting && !failed(response)) {
        const saved = await step('H12 plan capture', undefined as Awaited<ReturnType<typeof captureSessionPlan>>, () => captureSessionPlan({ plan, cwd, now, harness: H, sid }))
        if (saved !== undefined) {
          entries.push({ ts: now, ev: 'note', paths: [saved.path] })
          parts.push(saved.note ?? `Buracle: the approved plan was saved to ${shownPath(saved.path, cwd)} (H12).`)
        }
      }
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
  }
  const cls = write ? await step('classify', { kind: 'other', paths: [] } as ReturnType<typeof classifyTool>, () => classifyTool(H, tool, input, cwd)) : undefined
  if (cls !== undefined && !sub) entries.push({ ts: now, ev: 'tool', tool, kind: tool === 'Write' ? 'write' : 'edit', paths: cls.paths })
  const pd = pipelineDeps(sid, ctx, d, at)
  const r = await postTool({
    harness: H, sessionId: sid, cwd, now, subagent: sub, entries,
    answered: tool === 'AskUserQuestion' && !sub && !failed(response) && questionAnswered(response),
    ...(cls !== undefined ? { edit: { ok: !failed(response), paths: cls.paths, added: addedText(tool, input, cls.paths), removed: () => removedText(tool, input, cls.paths) } } : {}),
    ...(tool.startsWith(PLUGIN_MCP_PREFIX) ? { mcp: { server: () => mcpServer(tool, input, cwd, ctx, d), ok: true, first: true } } : {}),
  }, {
    ...pd,
    fileCheckDeps: () => ({ now: d.now, run: d.run, once: sessionOnce(H, sid) }),
    answerReceipt: () => { updateState(H, sid, (s: SessionState) => answerReceipt(s, now)) },
    editBudgetMs: POST_EDIT_BUDGET_MS,
  })
  if (r.fileNotes.length > 0) parts.push(`Buracle file checks:\n\n${r.fileNotes.join('\n\n')}`)
  if (r.assets !== undefined) parts.push(r.assets)
  return contextOut('PostToolUse', parts)
}

function mcpServer(tool: string, input: Record<string, unknown>, cwd: string, ctx: AdapterContext, d: HookDeps): string | undefined {
  const cls = classifyTool(H, tool, input, cwd, pluginServers(pluginRoot(ctx.repoRoot, d.env)) ?? [])
  return cls.kind === 'mcp' ? cls.mcp?.server : undefined
}

async function postToolUseFailure(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps): Promise<HookOutcome> {
  const tool = str(p['tool_name']) ?? ''
  if (!tool.startsWith(PLUGIN_MCP_PREFIX) || p['is_interrupt'] === true) return QUIET
  const input = isObj(p['tool_input']) ? p['tool_input'] : {}
  await step('H24 MCP result', undefined, () => { recordMcpResult(pipelineDeps(sid, ctx, d), sid, mcpServer(tool, input, str(p['cwd']) ?? '', ctx, d), false) })
  return QUIET
}
