import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../../core/index'
import type { Harness, ToolCall } from '../../core/events'
import { isAbsPath } from '../../core/events'
import type { SessionState, StopGuardResult } from '../../core/plan/state'
import type { McpHealth } from '../../core/policy/routing'
import type { HookHealth } from '../../core/status/model'
import type { WorkspaceInfo } from '../../core/workspace'
import type { AdapterContext } from '../registry'
import { currentBranch, projectIdentity } from '../../engine/git'
import { log } from '../../engine/log'
import { run as runProcess, type RunOptions, type RunResult } from '../../engine/proc'
import { loadState, reviewSubjects, sessionMaint, updateState, writeTelemetry } from '../../workflow/session-store'
import { recordFlowStart } from '../../workflow/flow'
import { loadLedger } from '../../workflow/ledger'
import { refreshWorkspaceInfo } from '../../workflow/workspace'
import type { SpoolEntry } from '../../core/memory/spool'
import { noticesOff, runtimeVersion, startupNotices } from '../shared/notices'
import { reviewNotesNotice } from '../shared/review-notes'
import type { AssetsSpawner } from '../shared/project-assets'
import {
  latestHandoffId, postTool, preCompact, preTool, prompt as promptEvent, sessionEnd, sessionStart, stop, workspaceStart,
  type MemoryFns, type PipelineDeps, type PipelinePoint, type PreToolDecision, type UsagePlan,
} from '../shared/pipeline/index'
import { earlyEdit, readOnlyStart, startedWorkflow } from '../shared/plan-mode'
import { projectDeps as readProjectDeps } from '../shared/project-deps'
import { reviewAgentIds } from './agents'
import { removedByFile } from '../shared/checker-scan'
import { sessionOnce } from '../shared/file-checks'
import { captureApprovedPlan, noteProposedPlan } from './plan-capture'
import { canPromptConsent, consentPromptInput, onPermissionRequest, settleConsentAsks, type PromptEnv } from './consent-prompt'
import { unaskedConsent } from '../shared/consent-asks'
import { bashOptions, GUARDED_TOOLS, guardFailed, SHELL_TOOL, shellPatchOf, writeContext, writeTargets } from './guards'
import {
  blockOutput, clipBytes, CONTEXT_BUDGET_BYTES, contextOutput, denyOutput, denyReason, json, loadAdapterState, NOTHING, rec,
  saveAdapterState, step, str, type CodexSessionState, type HookOutcome, type Payload,
} from './hook-io'
import { reviewErrors } from './review'
import {
  availableServers, codexPathRules, fitParts, harnessHealth, knownServers, loadWorkspaceInfo, recordWorkflowStart, resumeNotice,
  routeUserPrompt, routingPolicy, saveWorkspaceInfo, sessionHealth, workflowStart, workspaceFacts,
} from './route'
import { POST_MASK_HANDLER } from './hooks-config'
import { maskOutcome } from './mask'
import { fallbackWindowLabel, openPlanSteps, readCollaborationMode, readCompactionSummary, readExecCwd, readLatestPlan, readRolloutTelemetry, type RolloutTelemetry } from './rollout'
import { shellPatchTargets } from './shell-patch'
import { patchReceiptChanges } from '../shared/turn-receipt'
import { commandRan, filesChanged, flowNotice, hooksNotice, joinNotices, turnEnded, turnStarted, withSystemMessage } from './turn-notices'
import { isSubagentPayload, recordSubagentAlias, subagentLedgerId, subagentWorkspace } from './subagents'
import { uiSessionHooks, type UiSessionHooks } from '../shared/ui-session'

export { fileCheckNotes } from '../shared/file-checks'
export { clipBytes, CONTEXT_BUDGET_BYTES, type HookOutcome } from './hook-io'
export { extractJsonObject, reviewReportErrors } from './review'
export { fitParts, readMcpHealth } from './route'
export { isSubagentPayload, MAX_SUBAGENT_ALIASES, recordSubagentAlias, subagentAliasesFile } from './subagents'

const H: Harness = 'codex'
const EXCERPT_MAX = 2_000
const COMPACT_EXCERPT_MAX = 8_000

export type { SpoolEntry }

export type { MemoryFns }

export type CoreFns = typeof core

export interface CodexHookDeps {
  core: CoreFns
  memory: () => Promise<MemoryFns>
  now: () => number
  run: (argv: string[], opts?: RunOptions) => Promise<RunResult>
  resolveChecker?: (argv: readonly string[]) => string[]
  env?: () => Record<string, string | undefined>
  newId?: () => string
  prepareWorkspace?: (cwd: string, ctx: AdapterContext, nowMs: number) => Promise<WorkspaceInfo | undefined>
  workspaceInfo?: (cwd: string, ctx: AdapterContext, nowMs: number) => Promise<WorkspaceInfo | undefined>
  refreshWorkspace?: (info: WorkspaceInfo, ctx: AdapterContext, nowMs: number) => WorkspaceInfo
  projectDeps?: (root: string) => string[]
  assetsSpawn?: AssetsSpawner
  lspEdits?: (files: readonly string[], opts: { cwd: string, deadlineMs: number, now: () => number }) => Promise<string[]>
  hookHealth?: (nowMs: number) => Promise<HookHealth>
  /** The memory web UI's session record and start (memory.ui.autostart); the shared implementation by default. */
  ui?: UiSessionHooks
}

async function loadMemoryFns(): Promise<MemoryFns> {
  const out: MemoryFns = {}
  const load = async (what: string, fn: () => Promise<void>) => {
    try { await fn() } catch (e) { log('warn', `codex hook: memory module ${what} unavailable`, { error: e }) }
  }
  await load('spool', async () => { out.appendSpool = (await import('../../memory/spool')).appendSpool })
  await load('finalize', async () => {
    const m = await import('../../memory/finalize')
    out.spawnFinalizer = m.spawnFinalizer
    out.sessionStart = m.sessionStart
    out.promptSeen = m.promptSeen
  })
  await load('context', async () => { out.contextText = (await import('../../memory/context')).contextText })
  await load('handoff', async () => {
    const m = await import('../../memory/handoff')
    out.writeHandoff = m.writeHandoff
    out.latestHandoff = m.latestHandoff
  })
  return out
}

export function defaultDeps(): CodexHookDeps {
  let memo: Promise<MemoryFns> | undefined
  return {
    core, memory: () => (memo ??= loadMemoryFns()), now: () => Date.now(), run: runProcess, env: () => process.env,
    async prepareWorkspace(cwd, ctx, nowMs) {
      return (await import('../shared/workspace-start')).prepareWorkspace(cwd, ctx.config, nowMs)
    },
    async workspaceInfo(cwd, ctx, nowMs) {
      return (await import('../../workflow/workspace')).workspaceInfo(cwd, ctx.config, nowMs)
    },
    refreshWorkspace(info, ctx, nowMs) {
      return refreshWorkspaceInfo(info, ctx.config, nowMs)
    },
    projectDeps: readProjectDeps,
    async lspEdits(files, opts) {
      return (await import('../../engine/toolchain/lsp-edits')).editDiagnostics(files, opts)
    },
  }
}

function uiOf(deps: CodexHookDeps): UiSessionHooks {
  return deps.ui ?? uiSessionHooks
}

async function hookHealthOf(deps: CodexHookDeps, now: number): Promise<HookHealth> {
  return deps.hookHealth !== undefined ? deps.hookHealth(now) : (await import('../../engine/hook-health')).statusHealth(now)
}

function envOf(deps: CodexHookDeps): Record<string, string | undefined> {
  return deps.env?.() ?? process.env
}

function memoryOff(deps: CodexHookDeps): boolean {
  return envOf(deps)['BURACLE_NO_MEMORY'] === '1'
}

function captureOff(deps: CodexHookDeps): boolean {
  return envOf(deps)['BURACLE_NO_CAPTURE'] === '1' || memoryOff(deps)
}

async function spool(deps: CodexHookDeps, event: string, sid: string, entries: SpoolEntry[]): Promise<void> {
  if (entries.length === 0 || captureOff(deps)) return
  await step(event, 'H14 spool', undefined, async () => {
    const m = await deps.memory()
    if (m.appendSpool) await m.appendSpool(H, sid, entries)
  })
}

function labelFn(deps: CodexHookDeps): (minutes: number) => string {
  return (minutes: number) => {
    try { return deps.core.windowLabel(minutes) } catch { return fallbackWindowLabel(minutes) }
  }
}

async function updateTelemetry(deps: CodexHookDeps, event: string, p: Payload, sid: string): Promise<RolloutTelemetry | undefined> {
  return step(event, 'H18 telemetry', undefined as RolloutTelemetry | undefined, () => {
    const now = deps.now()
    const path = str(p['transcript_path'])
    const usage = path !== undefined ? readRolloutTelemetry(path, { nowMs: now, label: labelFn(deps) }) : undefined
    const model = str(p['model']) ?? usage?.model
    if (model === undefined && usage?.ctx === undefined && (usage?.windows.length ?? 0) === 0) return usage
    const t: Parameters<typeof writeTelemetry>[2] = { at: now }
    if (model !== undefined) { t.model = model; t.modelId = model }
    if (usage?.effort !== undefined) t.effort = usage.effort
    const cwd = str(p['cwd'])
    if (cwd !== undefined) t.cwd = cwd
    if (usage?.ctx) t.ctx = { pct: usage.ctx.pct, tokens: usage.ctx.tokens, window: usage.ctx.window }
    if (usage && usage.windows.length > 0) t.windows = usage.windows
    writeTelemetry(H, sid, t)
    return usage
  })
}

async function contextWarning(ctx: AdapterContext, event: string, sid: string, usage: RolloutTelemetry | undefined): Promise<string | undefined> {
  return step(event, 'H05 warning', undefined, () => {
    const pct = usage?.ctx?.pct
    if (pct === undefined) return undefined
    const t = core.contextThresholds(ctx.config.context)
    const s = loadAdapterState(ctx, sid)
    const before = s.ctxWarned ?? 0
    const prev: core.ContextBand = before >= t.criticalPct ? 'critical' : before >= t.warnPct ? 'warn' : 'ok'
    const r = core.contextWatch(prev, pct, t)
    const level = r.warned === 'critical' ? t.criticalPct : r.warned === 'warn' ? t.warnPct : 0
    if (level !== before) saveAdapterState(ctx, sid, { ...s, ctxWarned: level })
    if (r.warn === undefined) return undefined
    return r.band === 'critical'
      ? `Buracle: the context window is ${pct}% full and Codex will compact soon. Finish the current atomic step and keep the plan file and todo list current; Buracle saves the plan state before compaction and restores it afterwards. Do not skip verification.`
      : `Buracle: the context window is ${pct}% full. Keep the plan file and todo list current so work survives compaction; read narrow line ranges instead of whole files.`
  })
}

function readIfFile(path: string): string | undefined {
  try { return statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined } catch { return undefined }
}

export function capabilityCardText(ctx: AdapterContext, deps: CodexHookDeps, sid?: string): string {
  const health = sid !== undefined ? sessionHealth(ctx, deps.core, sid, deps.now(), true) : harnessHealth(ctx, deps.core, deps.now(), true)
  const mcp = deps.core.catalogMcp(ctx.canonical.mcp, H).filter(m => !deps.core.mcpUnavailable(health[m.id]))
  return deps.core.capabilityCard({ policy: routingPolicy(ctx), mcp, skills: deps.core.catalogSkills(ctx.canonical.skills), plugins: [], harness: H })
}

// The pipeline's step names that Codex logs under a name of its own.
const STEP_NAMES: Readonly<Record<string, string>> = {
  'H24 ledger reset': 'H24 resetLedger', 'H14 session record': 'memory sessionStart', 'H17 profile guard': 'H17 profileGuard',
  'H16 session maintenance': 'H16 sessionMaint', 'H10 intents': 'H10 interaction', 'H22 route.prompt': 'H22 router',
  'H24 ledger prompt': 'H24 ledgerPrompt', 'H21 workspace notice': 'H21 notice', 'H05 context warning': 'H05 warning',
  'H03 routing': 'H03 routeTool', 'H24 usage': 'H24 reminders', 'H04 file checks': 'H04', 'H23 route.audit': 'H23 turnAudit',
  'stop guard': 'H08/H11 stopGuardVerdict', 'H14 finalizer': 'H14 spawnFinalizer',
}

/** What the shared pipeline needs from Codex: its step log, memory, spool and the session's workspace file. */
function pipelineDeps(ev: string, ctx: AdapterContext, deps: CodexHookDeps, at?: (point: PipelinePoint) => Promise<void>): PipelineDeps {
  const refresh = deps.refreshWorkspace
  return {
    harness: H, ctx, core: deps.core, memoryOff: memoryOff(deps), captureOff: captureOff(deps), ui: uiOf(deps),
    step: (name, fallback, fn) => step(ev, STEP_NAMES[name] ?? name, fallback, fn),
    memory: async name => (await deps.memory())[name],
    spool: (sid, entries) => spool(deps, ev, sid, entries),
    async project(cwd) {
      const id = await projectIdentity(cwd)
      const branch = await currentBranch(cwd)
      return { project: id.slug, ...(branch !== undefined ? { branch } : {}) }
    },
    workspace: {
      read: sid => loadWorkspaceInfo(ctx, sid),
      save: (sid, info) => { saveWorkspaceInfo(ctx, sid, info) },
      prepare: async (cwd, now) => deps.prepareWorkspace?.(cwd, ctx, now),
      subagent: (sid, cwd, now) => subagentWorkspace(sid, cwd, ctx, deps, now),
      ...(refresh !== undefined ? { refresh: (info: WorkspaceInfo, now: number) => refresh(info, ctx, now) } : {}),
    },
    ...(deps.assetsSpawn !== undefined ? { assetsSpawn: deps.assetsSpawn } : {}),
    ...(at !== undefined ? { at } : {}),
  }
}

async function restoreText(ctx: AdapterContext, deps: CodexHookDeps, d: PipelineDeps, sid: string, cwd: string, now: number): Promise<string> {
  const own = loadAdapterState(ctx, sid)
  let handoff = own.lastHandoff
  const todos = handoff === undefined && (own.lastTodos?.length ?? 0) > 0 ? own.lastTodos : undefined
  const recorded = own.lastCompactAt !== undefined && now - own.lastCompactAt <= core.RESTORE_RECORD_MAX_MS
  if (handoff === undefined && todos === undefined && !recorded && !d.memoryOff) handoff = await latestHandoffId(d, sid, cwd, now)
  return deps.core.restoreContext(loadState(H, sid), handoff, todos) ?? ''
}

async function onSessionStart(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'SessionStart'
  const source = str(p['source']) ?? 'startup'
  const now = deps.now()
  const sub = isSubagentPayload(p)
  const model = str(p['model'])
  const d = pipelineDeps(ev, ctx, deps)
  let resumed: ReturnType<typeof resumeNotice>
  let health: string | undefined
  const { parts } = await sessionStart({ harness: H, sessionId: sid, cwd, source, subagent: sub, now, ...(model !== undefined ? { model } : {}) }, {
    ...d,
    sessionStartOrder: [
      'record',
      async () => { await updateTelemetry(deps, ev, p, sid) },
      'ledger', 'ui', 'workspace', 'assets', 'card', 'restore',
      async () => { if (source === 'resume' && !sub) resumed = await step(ev, 'H25 resume notice', undefined as ReturnType<typeof resumeNotice>, () => resumeNotice(sid, now, ctx.config, deps.core)) },
      'notices', 'memory', 'profile', 'maint',
      async () => {
        if (!sub && (source === 'startup' || source === 'resume') && ctx.config.workflow.codexNotices) health = await step(ev, 'hooks notice', undefined as string | undefined, async () => hooksNotice(ctx, await hookHealthOf(deps, now)))
      },
    ],
    capabilityCard: () => capabilityCardText(ctx, deps, sid),
    restore: () => restoreText(ctx, deps, d, sid, cwd, now),
    noticesOff: () => noticesOff(envOf(deps)),
    startupNotices: () => startupNotices(ctx.canonical.notices, { version: runtimeVersion(ctx.repoRoot), nowMs: now, harness: H }),
    runtimeConfigFile: () => ctx.paths.runtimeConfigFile(),
    profileEnv: () => envOf(deps),
    sessionMaint: (nowMs, keep) => { sessionMaint(H, nowMs, { keep }) },
    fixedContext: () => [resumed?.model ?? ''],
  })
  const user = [parts.profile, parts.notice?.user, resumed?.user, health].filter((s): s is string => s !== undefined).join('\n')
  const index = parts.memory !== '' ? clipBytes(parts.memory, parts.room) : ''
  return contextOutput('SessionStart', [parts.restore, parts.notice?.model ?? '', parts.workspace, parts.assets, resumed?.model ?? '', index, parts.card], user !== '' ? user : undefined)
}

async function onUserPromptSubmit(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'UserPromptSubmit'
  if (isSubagentPayload(p)) return NOTHING
  const text = typeof p['prompt'] === 'string' ? p['prompt'] : ''
  const now = deps.now()
  const rollout = str(p['transcript_path'])
  await step(ev, 'H20 answered holds', 0, () => settleConsentAsks(sid, undefined, true))
  const flow = await step(ev, 'workflow notice', undefined as string | undefined, () => flowNotice(ctx, sid, now))
  let saved: string | undefined
  const at = async (point: PipelinePoint): Promise<void> => {
    if (point === 'prompt.user') await step(ev, 'turn receipt start', undefined, () => { turnStarted(ctx, sid, now) })
    else if (point === 'prompt.granted') saved = await step(ev, 'H12 plan capture', undefined as string | undefined, () => captureApprovedPlan(ctx, sid, text, cwd, rollout, now))
    else if (point === 'prompt.record') await step(ev, 'workflow notice seen', undefined, () => { flowNotice(ctx, sid, now, true) })
  }
  const { parts } = await promptEvent({ harness: H, sessionId: sid, cwd, text, now }, {
    ...pipelineDeps(ev, ctx, deps, at),
    reviewNotes: () => reviewNotesNotice(H, sid, { plan: loadState(H, sid).plan?.path, roots: [loadWorkspaceInfo(ctx, sid)?.root, cwd], now }),
    routePrompt() {
      const policy = routingPolicy(ctx)
      const info = loadWorkspaceInfo(ctx, sid)
      const depsOf = deps.projectDeps ?? readProjectDeps
      return step(ev, 'H22 route', undefined, () => routeUserPrompt(text, {
        ctx, core: deps.core, policy, ledger: loadLedger(H, sid), available: availableServers(ctx, deps.core, sessionHealth(ctx, deps.core, sid, now, true)), deps: depsOf(info?.root ?? cwd),
      }))
    },
    async promptRouted(route) {
      const start = workflowStart(route, text, deps.core)
      if (start !== undefined) await step(ev, 'H25 flow start', undefined, () => { recordWorkflowStart(sid, start, now) })
    },
    readOnlyStart: invoked => (startedWorkflow(invoked) !== undefined && rollout !== undefined ? readOnlyStart(H, readCollaborationMode(rollout) === 'plan', invoked) : undefined),
    contextWarning: async () => contextWarning(ctx, ev, sid, await updateTelemetry(deps, ev, p, sid)),
  })
  const context = [parts.guidance, parts.notes, saved, parts.planMode, parts.route, parts.workspace, parts.warning].filter((s): s is string => s !== undefined && s !== '')
  return contextOutput('UserPromptSubmit', fitParts(context, core.PROMPT_CONTEXT_MAX_CHARS), flow)
}

function toolCall(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): ToolCall {
  const tool = str(p['tool_name']) ?? ''
  const input = rec(p['tool_input'])
  const cls = deps.core.classifyTool(H, tool, input, cwd, knownServers(ctx))
  return { harness: H, sessionId: sid, cwd, tool, input, ...cls }
}

async function execCwdOf(p: Payload, cwd: string): Promise<string> {
  const path = str(p['transcript_path'])
  const id = str(p['tool_use_id'])
  if (str(p['tool_name']) !== SHELL_TOOL || path === undefined || id === undefined) return cwd
  return step('PreToolUse', 'G11 exec workdir', cwd, () => readExecCwd(path, id, cwd) ?? cwd)
}

/** A pipeline denial in Codex's words; a guard that itself failed is logged and denies (fail closed). */
function denyText(d: Extract<PreToolDecision, { action: 'deny' }>, call: ToolCall): string {
  if (d.error !== undefined) {
    if (d.source === 'bash') log('error', 'codex hook PreToolUse: H01 bash guard failed; denying (fail closed)', { error: d.error })
    else if (d.source === 'mcpWrite') log('error', 'codex hook PreToolUse: H02 write guard failed for an MCP call; denying (fail closed)', { tool: call.tool, error: d.error })
    else log('error', 'codex hook PreToolUse: H02 write guard failed; denying (fail closed)', { harness: H, error: d.error })
    return guardFailed(d.source === 'bash' ? 'H01' : 'H02', d.error)
  }
  return d.source === 'lane' ? d.reason : denyReason(d.hook, d.reason)
}

async function onPreToolUse(p: Payload, sid: string, sessionCwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'PreToolUse'
  const now = deps.now()
  await step(ev, 'H20 answered holds', 0, () => settleConsentAsks(sid, str(p['transcript_path']), false))
  const cwd = await execCwdOf(p, sessionCwd)
  let call: ToolCall
  try {
    call = toolCall(p, sid, cwd, ctx, deps)
  } catch (e) {
    const tool = str(p['tool_name']) ?? ''
    log('error', 'codex hook PreToolUse: cannot classify the call', { tool, error: e })
    if (GUARDED_TOOLS.has(tool)) return denyOutput(guardFailed(tool === 'Bash' ? 'H01' : 'H02', e))
    return NOTHING
  }
  const env: PromptEnv = { shell: envOf(deps)['SHELL'] }
  const edits = call.kind === 'patch' || call.kind === 'edit' || call.kind === 'write'
  const decision = await preTool({
    call, now, subagent: isSubagentPayload(p),
    checks: { bash: call.kind === 'bash', write: call.tool === SHELL_TOOL || edits, mcpWrite: call.kind === 'mcp', question: call.kind === 'ask_user', route: true, usage: true },
    asyncQuestion: call.tool === 'request_user_input_async',
  }, {
    ...pipelineDeps(ev, ctx, deps),
    bashOptions: dir => bashOptions(ctx, dir),
    laneDenial: command => deps.core.laneStateDenial(command),
    holdConsent: command => step(ev, 'H20 consent prompt', false, () => canPromptConsent(p, ctx, command, env) && !unaskedConsent(sid, command, now)),
    writeTargets: c => writeTargets(p, c, cwd, deps.core),
    writeGuardContext: dir => writeContext(ev, dir, ctx),
    routingPolicy: () => routingPolicy(ctx),
    mcpHealth(c) {
      const health = sessionHealth(ctx, deps.core, sid, now, c.kind === 'web_search' || c.kind === 'web_fetch')
      return () => health
    },
    usage: (c, health) => usagePlan(p, c, sid, ctx, deps, health()),
    usageDone: plan => (plan.ledgerId === sid ? step(ev, 'H25/H26 skill load', undefined, () => skillLoad(plan.call, sid, deps, now)) : undefined),
    earlyEdit: () => earlyEdit(H, sid, editedPaths(p, call, deps), cwd, ctx.config.plan.planApproval),
  })
  if (decision.action === 'deny') return denyOutput(denyText(decision, call))
  const { parts, held } = decision
  const context = [...parts.route, parts.question, parts.usage, parts.early].filter((s): s is string => s !== undefined)
  if (held === undefined) return contextOutput('PreToolUse', context)
  const prompted = await step(ev, 'H20 consent prompt', undefined as Record<string, unknown> | undefined, () => consentPromptInput(p, sid, held.command, ctx, now, newConsentId(deps), env))
  return prompted !== undefined ? promptOutput(prompted, context) : denyOutput(denyReason('H20', held.reason))
}

function newConsentId(deps: CodexHookDeps): string {
  return deps.newId?.() ?? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
}

function promptOutput(updatedInput: Record<string, unknown>, context: readonly string[]): HookOutcome {
  const text = context.map(c => c.trim()).filter(c => c !== '').join('\n\n')
  return json({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput, ...(text !== '' ? { additionalContext: clipBytes(text, CONTEXT_BUDGET_BYTES) } : {}) } })
}

function editedPaths(p: Payload, call: ToolCall, deps: CodexHookDeps): string[] {
  if (call.kind === 'patch' || call.kind === 'edit' || call.kind === 'write') return call.paths
  const sp = shellPatchOf(p)
  return sp.kind === 'patch' ? deps.core.patchEdits(sp.body).map(e => e.path) : []
}

/** What the usage reminders judge: a shell apply_patch counts as a patch, and a subagent has a ledger of its own. */
function usagePlan(p: Payload, call: ToolCall, sid: string, ctx: AdapterContext, deps: CodexHookDeps, health: McpHealth): UsagePlan | undefined {
  const ledgerId = isSubagentPayload(p) ? subagentLedgerId(p, sid, ctx) : sid
  if (ledgerId === undefined) return undefined
  const facts = workspaceFacts(ctx, loadWorkspaceInfo(ctx, sid))
  const sp = shellPatchOf(p)
  const judged: ToolCall = sp.kind === 'patch' ? { ...call, kind: 'patch' } : call
  const edits = sp.kind === 'patch' ? deps.core.patchEdits(sp.body).map(e => ({ file: e.path, removed: e.removed, added: e.added })) : undefined
  const isEdit = judged.kind === 'patch' || judged.kind === 'edit' || judged.kind === 'write'
  const pathRules = isEdit || judged.kind === 'bash' ? codexPathRules(ctx, deps.core) : undefined
  return {
    call: judged, ledgerId,
    context: {
      strictness: ctx.config.routing.strictness, reminders: ctx.config.routing.reminders, available: availableServers(ctx, deps.core, health),
      policy: routingPolicy(ctx), facts, ...(edits !== undefined ? { edits } : {}), ...(pathRules !== undefined ? { pathRules } : {}),
    },
  }
}

function skillLoad(call: ToolCall, sid: string, deps: CodexHookDeps, now: number): void {
  const id = deps.core.skillOf(call, H)
  // Buracle installs its skills in $CODEX_HOME/skills; .agents covers a link an older install left.
  const command = call.command ?? ''
  const codexHome = envOf(deps)['CODEX_HOME']
  const installed = id !== undefined && (new RegExp(`(?:\\.agents|\\.codex\\}?|CODEX_HOME\\}?)[/\\\\]skills[/\\\\]${id}[/\\\\]SKILL\\.md`).test(command)
    || (codexHome !== undefined && codexHome !== '' && command.includes(join(codexHome, 'skills', id, 'SKILL.md'))))
  const workflow = installed ? deps.core.workflowOfSkill(`buracle:${id}`) : undefined
  if (workflow !== undefined) recordFlowStart(H, sid, { workflow, source: 'skill' }, now)
}

function exitCodeOf(response: unknown): number | undefined {
  const text = typeof response === 'string' ? response : typeof rec(response)['output'] === 'string' ? rec(response)['output'] as string : undefined
  if (text === undefined) {
    const code = rec(response)['exit_code']
    return typeof code === 'number' ? code : undefined
  }
  const m = /(?:Process exited with code|Exit code:?)\s*(-?\d+)/i.exec(text)
  return m ? Number(m[1]) : undefined
}

const POST_PATCH_BUDGET_MS = 40_000

async function onPostToolUse(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'PostToolUse'
  const start = deps.now()
  const call = toolCall(p, sid, cwd, ctx, deps)
  const sub = isSubagentPayload(p)
  const entries: SpoolEntry[] = []
  let alarm: string | undefined
  let lsp: string[] = []
  let edit: { ok: boolean, paths: string[], added: Record<string, string>, removed: () => Record<string, string> } | undefined
  let text = ''
  const shellPatch = await step(ev, 'shell apply_patch', undefined as { paths: string[], added: Record<string, string> } | undefined, () => {
    const sp = shellPatchOf(p)
    if (sp.kind !== 'patch') return undefined
    const t = shellPatchTargets(sp, deps.core.parseApplyPatch)
    return 'undetermined' in t ? undefined : t
  })
  if ((call.kind === 'patch' && call.tool !== SHELL_TOOL) || shellPatch !== undefined) {
    const input = rec(p['tool_input'])
    const patch = typeof input['command'] === 'string' ? input['command'] : Array.isArray(input['command']) ? (input['command'] as unknown[]).filter(x => typeof x === 'string').join('\n') : ''
    text = patch
    const parsed = shellPatch ?? await step(ev, 'parseApplyPatch', { paths: call.paths, added: {} as Record<string, string> }, () => deps.core.parseApplyPatch(patch, cwd))
    const response = p['tool_response']
    edit = {
      ok: !(typeof response === 'string' && /^\s*(?:Failed|Error)\b/i.test(response)), paths: parsed.paths, added: parsed.added,
      removed() {
        const sp = shellPatchOf(p)
        return removedByFile(deps.core.patchEdits(sp.kind === 'patch' ? sp.body : patch), parsed.paths)
      },
    }
    entries.push({ ts: start, ev: 'tool', tool: call.tool, kind: 'patch', paths: parsed.paths })
  } else if (call.kind === 'bash') {
    const e: SpoolEntry = { ts: start, ev: 'tool', tool: call.tool, kind: 'bash' }
    if (call.command !== undefined) e.cmd = call.command.slice(0, 500)
    const exit = exitCodeOf(p['tool_response'])
    if (exit !== undefined) e.exit = exit
    entries.push(e)
  } else {
    entries.push({ ts: start, ev: 'tool', tool: call.tool, kind: call.kind })
  }
  const paths = edit?.paths ?? []
  const at = async (point: PipelinePoint): Promise<void> => {
    if (point === 'postTool.checked') {
      const ask = ctx.config.checkers.enabled ? deps.lspEdits : undefined
      if (ask !== undefined) lsp = await step(ev, 'H04 language server', [] as string[], () => ask(paths, { cwd, deadlineMs: start + POST_PATCH_BUDGET_MS, now: deps.now }))
    } else if (point === 'postTool.edited' && !sub && call.tool !== SHELL_TOOL) {
      alarm = await step(ev, 'turn receipt', undefined as string | undefined, () => filesChanged(ctx, sid, patchReceiptChanges(text, cwd)))
    }
  }
  const server = call.kind === 'mcp' ? call.mcp?.server : undefined
  const r = await postTool({
    harness: H, sessionId: sid, cwd, now: start, subagent: sub, entries,
    answered: !sub && call.tool === 'request_user_input' && deps.core.questionAnswered(p['tool_response']),
    ...(edit !== undefined ? { edit } : {}),
    ...(server !== undefined && server !== '' ? { mcp: { server: () => server, ok: rec(p['tool_response'])['isError'] !== true } } : {}),
  }, {
    ...pipelineDeps(ev, ctx, deps, at),
    fileCheckDeps: () => ({ core: deps.core, now: deps.now, run: deps.run, once: sessionOnce(H, sid), ...(deps.resolveChecker !== undefined ? { resolve: deps.resolveChecker } : {}) }),
    answerReceipt: () => { updateState(H, sid, s => deps.core.answerReceipt(s, start)) },
    editBudgetMs: POST_PATCH_BUDGET_MS,
  })
  const context: string[] = []
  if (r.fileNotes.length > 0) context.push(`Buracle file checks after apply_patch:\n\n${r.fileNotes.join('\n\n')}`)
  if (lsp.length > 0) context.push(`Buracle language server diagnostics after apply_patch:\n\n${lsp.join('\n\n')}`)
  if (r.assets !== undefined) context.push(r.assets)
  if (!sub) {
    const usage = await updateTelemetry(deps, ev, p, sid)
    const warning = await contextWarning(ctx, ev, sid, usage)
    if (warning) context.push(warning)
  }
  return contextOutput('PostToolUse', context, alarm !== undefined ? `Buracle: ${alarm}` : undefined)
}

async function onPostToolUseMask(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const out = maskOutcome(p, ctx)
  if (isSubagentPayload(p) || str(p['tool_name']) !== SHELL_TOOL) return out
  const alarm = await step('PostToolUse', 'turn receipt', undefined as string | undefined, () => {
    const command = toolCall(p, sid, cwd, ctx, deps).command
    if (command === undefined || command.trim() === '') return undefined
    const exit = exitCodeOf(p['tool_response'])
    const failed = exit !== undefined && exit !== 0
    const ran = commandRan(ctx, sid, command, failed)
    const sp = shellPatchOf(p)
    const edited = sp.kind === 'patch' && !failed ? filesChanged(ctx, sid, patchReceiptChanges(sp.body, cwd)) : undefined
    return edited ?? ran
  })
  return withSystemMessage(out, alarm !== undefined ? `Buracle: ${alarm}` : undefined)
}

async function onPreCompact(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'PreCompact'
  if (isSubagentPayload(p)) return NOTHING
  const now = deps.now()
  const trigger = str(p['trigger']) ?? 'unknown'
  const rollout = str(p['transcript_path'])
  await preCompact({ harness: H, sessionId: sid, cwd, trigger, now }, {
    ...pipelineDeps(ev, ctx, deps),
    openTodos() {
      const plan = rollout !== undefined ? readLatestPlan(rollout) : undefined
      return plan !== undefined ? openPlanSteps(plan) : []
    },
    saveCompactRecord(handoff, todo) {
      const next: CodexSessionState = { ...loadAdapterState(ctx, sid), lastCompactAt: now }
      delete next.lastHandoff
      delete next.lastTodos
      if (handoff !== undefined) next.lastHandoff = handoff
      else if (todo.length > 0) next.lastTodos = todo
      saveAdapterState(ctx, sid, next)
    },
    handoffNote({ project, branch, todo }) {
      const input: Parameters<CoreFns['handoffNote']>[0] = { state: loadState(H, sid), project, harness: H, sessionId: sid, now }
      if (branch !== undefined) input.branch = branch
      if (todo.length > 0) input.todo = todo
      return deps.core.handoffNote(input)
    },
  })
  await spool(deps, ev, sid, [{ ts: now, ev: 'compact', excerpt: `PreCompact (${trigger})` }])
  return NOTHING
}

async function onPostCompact(p: Payload, sid: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'PostCompact'
  if (isSubagentPayload(p)) return NOTHING
  const now = deps.now()
  const trigger = str(p['trigger']) ?? 'unknown'
  if (!captureOff(deps)) {
    const path = str(p['transcript_path'])
    const summary = path !== undefined ? await step(ev, 'H14 compaction summary', undefined as string | undefined, () => readCompactionSummary(path)) : undefined
    await spool(deps, ev, sid, [{ ts: now, ev: 'compact', excerpt: summary !== undefined ? summary.slice(0, COMPACT_EXCERPT_MAX) : `PostCompact (${trigger})` }])
  }
  await updateTelemetry(deps, ev, p, sid)
  await step(ev, 'reset warning', undefined, () => {
    const s = loadAdapterState(ctx, sid)
    if (s.ctxWarned) saveAdapterState(ctx, sid, { ...s, ctxWarned: 0 })
  })
  return NOTHING
}

function stopReason(reason: string): string {
  const tail = /plan pause/.test(reason) ? '' : '\nIf you truly need the user (a real decision or a manual step), run `buracle plan pause --kind decision --reason "<question>"` first, then ask.'
  return `${reason}${tail}`
}

export const READ_ONLY_NOTICE = 'Buracle stop guard: the session is in Plan mode (read-only), so this stop goes through. Leave Plan mode to continue the plan.'

function runawayNotice(ctx: AdapterContext, sid: string, result: StopGuardResult, state: SessionState): string | undefined {
  const caps = ctx.config.plan.runaway
  if (result.why === 'runaway-chain') {
    return `Buracle stop guard: ${caps.perChain} continuations in a row did not finish the plan, so this stop goes through (plan.runaway.perChain). Check the plan file and the last messages before going on.`
  }
  if (result.why !== 'runaway-plan' || state.plan === undefined) return undefined
  const key = `${state.plan.path}#${state.plan.registeredAt}`
  const s = loadAdapterState(ctx, sid)
  if (s.runawayPlan === key) return undefined
  saveAdapterState(ctx, sid, { ...s, runawayPlan: key })
  return `Buracle stop guard: this plan used up its ${caps.perPlan} stop-guard continuations (plan.runaway.perPlan), so stops are no longer held for it. Check the plan; after a pause, \`buracle plan resume\` starts a new budget.`
}

async function onStop(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'Stop'
  const now = deps.now()
  const last = typeof p['last_assistant_message'] === 'string' ? p['last_assistant_message'] : undefined
  const entry: SpoolEntry = { ts: now, ev: 'stop' }
  if (last !== undefined && last.trim() !== '') entry.excerpt = last.slice(0, EXCERPT_MAX)
  const model = str(p['model'])
  if (model !== undefined) entry.model = model
  if (entry.excerpt !== undefined || entry.model !== undefined) await spool(deps, ev, sid, [entry])
  await updateTelemetry(deps, ev, p, sid)
  const sub = isSubagentPayload(p)
  const active = p['stop_hook_active'] === true
  if (!sub) await step(ev, 'H20 answered holds', 0, () => settleConsentAsks(sid, undefined, true))
  const rollout = str(p['transcript_path'])
  const at = async (point: PipelinePoint): Promise<void> => {
    if (point === 'stop.guard' && !sub) await step(ev, 'H12 proposed plan', false, () => noteProposedPlan(ctx, sid, last, now, active))
  }
  const r = await stop({ harness: H, sessionId: sid, cwd, hookActive: active, subagent: sub, now, ...(last !== undefined ? { lastMessage: last } : {}) }, {
    ...pipelineDeps(ev, ctx, deps, at),
    readPlan: (path, dir) => (path === '' ? undefined : readIfFile(isAbsPath(path) ? path : join(dir, path))),
    async stopInput(input) {
      if (rollout !== undefined && await step(ev, 'read-only mode', false, () => readCollaborationMode(rollout) === 'plan')) input.readOnly = true
    },
    stopNotice: (result, before) => (result.readOnlyNotice === true ? READ_ONLY_NOTICE : step(ev, 'runaway notice', undefined as string | undefined, () => runawayNotice(ctx, sid, result, before))),
    stopGuard: { gate: false, write: 'always', auditOnFailure: false },
  })
  if (r.failed === true) return NOTHING
  if (r.decision.action === 'block' && r.blockedBy === 'guard') {
    await step(ev, 'runaway notice reset', undefined, () => {
      const s = loadAdapterState(ctx, sid)
      if (s.runawayPlan === undefined) return
      const next: CodexSessionState = { ...s }
      delete next.runawayPlan
      saveAdapterState(ctx, sid, next)
    })
    return blockOutput(stopReason(r.decision.reason))
  }
  const reason = r.decision.action === 'block' ? r.decision.reason : undefined
  const ended = reason === undefined && !sub
  const end = deps.now()
  const receipt = ended ? await step(ev, 'turn receipt', undefined as string | undefined, () => turnEnded(ctx, sid, { now: end })) : undefined
  const flow = ended ? await step(ev, 'workflow notice', undefined as string | undefined, () => flowNotice(ctx, sid, end)) : undefined
  const message = joinNotices(r.notice, receipt, flow)
  const out: Record<string, unknown> = {}
  if (reason !== undefined) { out['decision'] = 'block'; out['reason'] = reason }
  if (message !== undefined) out['systemMessage'] = message
  return Object.keys(out).length > 0 ? json(out) : NOTHING
}

async function onSubagentStop(p: Payload, sid: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'SubagentStop'
  const agent = str(p['agent_type'])
  if (agent === undefined) return NOTHING
  const reviewers = await step(ev, 'review agents', [] as string[], () => reviewAgentIds(ctx.canonical.agents))
  if (!reviewers.includes(agent)) return NOTHING
  const text = typeof p['last_assistant_message'] === 'string' ? p['last_assistant_message'] : ''
  const errors = await step(ev, 'H19 validate', [] as string[], () => reviewErrors(text, agent, deps.core.validateReviewJson, reviewSubjects(H, sid)))
  await spool(deps, ev, sid, [{ ts: deps.now(), ev: 'note', tool: agent, excerpt: errors.length === 0 ? `${agent}: valid review report` : `${agent}: invalid review report: ${errors.slice(0, 5).join('; ')}` }])
  if (errors.length === 0) return NOTHING
  const problems = `${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '; …' : ''}`
  if (p['stop_hook_active'] !== true) {
    return blockOutput(`Buracle H19: your final message is not a valid review report (${problems}). Answer again with only the corrected JSON report your instructions define, with nothing before or after it.`)
  }
  return json({ systemMessage: `Buracle H19: ${agent} returned an invalid review report again (${problems}); check its findings yourself before relying on them.` })
}

async function onSubagentStart(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  if (!isSubagentPayload(p)) return NOTHING
  return contextOutput('SubagentStart', [await step('SubagentStart', 'H21 workspace', '', () => workspaceStart({ sessionId: sid, cwd, subagent: true, now: deps.now() }, pipelineDeps('SubagentStart', ctx, deps)))])
}

async function onSessionEnd(sid: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  await sessionEnd({ harness: H, sessionId: sid, now: deps.now() }, {
    ...pipelineDeps('SessionEnd', ctx, deps),
    noFinalizer() {
      if (!existsSync(ctx.buracleBin)) return
      const child = Bun.spawn([ctx.buracleBin, 'mem', 'finalize', '--harness', H, '--session', sid, '--detach'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env } })
      child.unref()
    },
  })
  return NOTHING
}

export const HANDLED_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd', POST_MASK_HANDLER] as const

export async function handleCodexHook(event: string, stdin: string, ctx: AdapterContext, deps: CodexHookDeps = defaultDeps()): Promise<HookOutcome> {
  if (!(HANDLED_EVENTS as readonly string[]).includes(event)) return NOTHING
  let payload: Payload
  try {
    const v: unknown = JSON.parse(stdin)
    payload = rec(v)
  } catch {
    if (stdin.trim() !== '') log('warn', 'codex hook: payload is not JSON', { event })
    return NOTHING
  }
  const sid = payload['session_id']
  if (!ctx.paths.isValidSessionId(sid)) return NOTHING
  const cwd = str(payload['cwd']) ?? process.cwd()
  const agentId = str(payload['agent_id'])
  if (agentId !== undefined) await step(event, 'I7 subagent alias', undefined, () => recordSubagentAlias(ctx, agentId, sid))
  if (envOf(deps)['BURACLE_MEMORY_RUNNER'] === '1' && (event === 'SessionStart' || event === 'UserPromptSubmit')) return NOTHING
  switch (event) {
    case 'SessionStart': return onSessionStart(payload, sid, cwd, ctx, deps)
    case 'UserPromptSubmit': return onUserPromptSubmit(payload, sid, cwd, ctx, deps)
    case 'PreToolUse': return onPreToolUse(payload, sid, cwd, ctx, deps)
    case 'PermissionRequest': return step(event, 'H20 permission request', NOTHING, () => onPermissionRequest(payload, sid, ctx, deps.now()))
    case 'PostToolUse': return onPostToolUse(payload, sid, cwd, ctx, deps)
    case 'PreCompact': return onPreCompact(payload, sid, cwd, ctx, deps)
    case 'PostCompact': return onPostCompact(payload, sid, ctx, deps)
    case 'Stop': return onStop(payload, sid, cwd, ctx, deps)
    case 'SubagentStart': return onSubagentStart(payload, sid, cwd, ctx, deps)
    case 'SubagentStop': return onSubagentStop(payload, sid, ctx, deps)
    case 'SessionEnd': return onSessionEnd(sid, ctx, deps)
    case POST_MASK_HANDLER: return onPostToolUseMask(payload, sid, cwd, ctx, deps)
    default: return NOTHING
  }
}
