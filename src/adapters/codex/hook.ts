import { harnessProfile } from '../../core/harness/index'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../../core/index'
import type { Harness, ToolCall } from '../../core/events'
import type { SessionState, StopGuardResult } from '../../core/plan/state'
import type { McpHealth } from '../../core/policy/routing'
import type { HookHealth } from '../../core/status/model'
import type { WorkspaceInfo } from '../../core/workspace'
import type { AdapterContext } from '../registry'
import { log } from '../../engine/log'
import { run as runProcess, type RunOptions, type RunResult } from '../../engine/proc'
import { reviewSubjects, writeTelemetry } from '../../workflow/session-store'
import { recordFlowStart } from '../../workflow/flow'
import { loadLedger } from '../../workflow/ledger'
import type { SpoolEntry } from '../../core/memory/spool'
import type { AssetsSpawner } from '../shared/project-assets'
import {
  captureOff as pipelineCaptureOff, denyReason, guardFailed, mcpHealth, postTool, preCompact, preTool, prompt as promptEvent, routingPolicy, sessionEnd,
  sessionStart, spool, stop, workspaceStart, type MemoryFns, type PipelineDeps, type UsagePlan,
} from '../shared/pipeline/index'
import { projectDeps as readProjectDeps } from '../shared/project-deps'
import { reviewAgentIds } from './agents'
import { removedByFile } from '../shared/checker-scan'
import { captureApprovedPlan, noteProposedPlan } from './plan-capture'
import { canPromptConsent, consentPromptInput, onPermissionRequest, settleConsentAsks, type PromptEnv } from './consent-prompt'
import { unaskedConsent } from '../shared/consent-asks'
import { GUARDED_TOOLS, SHELL_TOOL, shellPatchOf, writeTargets } from './guards'
import {
  blockOutput, contextOutput, denyOutput, json, loadAdapterState, NOTHING, rec, saveAdapterState, step, str, type CodexSessionState,
  type HookOutcome, type Payload,
} from './hook-io'
import { reviewErrors } from './review'
import {
  availableServers, codexPathRules, knownServers, loadWorkspaceInfo, recordWorkflowStart, resumeNotice, routeUserPrompt, workflowStart,
} from './route'
import { codexOffServers } from '../shared/native-off'
import { POST_MASK_HANDLER } from './hooks-config'
import { maskOutcome } from './mask'
import { fallbackWindowLabel, openPlanSteps, readCollaborationMode, readCompactionSummary, readExecCwd, readLatestPlan, readRolloutTelemetry, type RolloutTelemetry } from './rollout'
import { shellPatchTargets } from './shell-patch'
import { patchReceiptChanges } from '../shared/turn-receipt'
import { commandRan, filesChanged, flowNotice, hooksNotice, joinNotices, turnEnded, turnStarted, withSystemMessage } from './turn-notices'
import { isSubagentPayload, recordSubagentAlias, subagentLedgerId } from './subagents'
import { uiSessionHooks, type UiSessionHooks } from '../shared/ui-session'
import { workspaceReaders } from '../shared/command-host/index'
import { CONTEXT_BUDGET_BYTES, clipBytes } from '../shared/pipeline/index'

export { fileCheckNotes } from '../shared/file-checks'
export { clipBytes, CONTEXT_BUDGET_BYTES } from '../shared/pipeline/index'
export type { HookOutcome } from './hook-io'
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
    ...workspaceReaders,
    projectDeps: readProjectDeps,
    async lspEdits(files, opts) {
      return (await import('../../engine/toolchain/lsp-edits')).editDiagnostics(files, opts)
    },
  }
}

async function hookHealthOf(deps: CodexHookDeps, now: number): Promise<HookHealth> {
  return deps.hookHealth !== undefined ? deps.hookHealth(now) : (await import('../../engine/hook-health')).statusHealth(now)
}

function envOf(deps: CodexHookDeps): Record<string, string | undefined> {
  return deps.env?.() ?? process.env
}

function captureOff(deps: CodexHookDeps): boolean {
  return pipelineCaptureOff({ env: envOf(deps) })
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
    const t = core.contextThresholds()
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

export function capabilityCardText(ctx: AdapterContext, deps: CodexHookDeps, sid?: string): string {
  const health = mcpHealth(ctx, H, deps.now(), { nativeOff: codexOffServers(), ...(sid !== undefined ? { sid } : {}) })
  const mcp = deps.core.catalogMcp(ctx.canonical.mcp, H).filter(m => !deps.core.mcpUnavailable(health[m.id]))
  return deps.core.capabilityCard({ policy: routingPolicy(ctx), mcp, plugins: [], harness: H })
}

/** What the shared pipeline needs from Codex: its step log, memory and workspace readers. */
function pipelineDeps(ev: string, ctx: AdapterContext, deps: CodexHookDeps): PipelineDeps {
  return {
    harness: H, ctx, core: deps.core, env: envOf(deps), ui: deps.ui ?? uiSessionHooks, workspace: deps,
    step: (name, fallback, fn) => step(ev, name, fallback, fn),
    memory: async name => (await deps.memory())[name],
    ...(deps.assetsSpawn !== undefined ? { assetsSpawn: deps.assetsSpawn } : {}),
  }
}

async function onSessionStart(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'SessionStart'
  const source = str(p['source']) ?? 'startup'
  const now = deps.now()
  const sub = isSubagentPayload(p)
  const model = str(p['model'])
  await updateTelemetry(deps, ev, p, sid)
  const resumed = source === 'resume' && !sub ? await step(ev, 'H25 resume notice', undefined as ReturnType<typeof resumeNotice>, () => resumeNotice(sid, now, ctx.config, deps.core)) : undefined
  const r = await sessionStart({ harness: H, sessionId: sid, cwd, source, subagent: sub, now, ...(model !== undefined ? { model } : {}) }, {
    ...pipelineDeps(ev, ctx, deps),
    capabilityCard: () => capabilityCardText(ctx, deps, sid),
    extraContext: [resumed?.model ?? ''],
  })
  const health = !sub && (source === 'startup' || source === 'resume') && ctx.config.workflow.codexNotices
    ? await step(ev, 'hooks notice', undefined as string | undefined, async () => hooksNotice(ctx, await hookHealthOf(deps, now)))
    : undefined
  // Codex shows a systemMessage to the user, so the profile warning and the notices go there, not through the model.
  const user = [r.profile, r.notice?.user, resumed?.user, health].filter((s): s is string => s !== undefined).join('\n')
  return contextOutput('SessionStart', r.context, user !== '' ? user : undefined)
}

async function onUserPromptSubmit(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'UserPromptSubmit'
  if (isSubagentPayload(p)) return NOTHING
  const text = typeof p['prompt'] === 'string' ? p['prompt'] : ''
  const now = deps.now()
  const rollout = str(p['transcript_path'])
  await step(ev, 'H20 answered holds', 0, () => settleConsentAsks(sid, undefined, true))
  const flow = await step(ev, 'workflow notice', undefined as string | undefined, () => flowNotice(ctx, sid, now))
  const r = await promptEvent({ harness: H, sessionId: sid, cwd, text, now }, {
    ...pipelineDeps(ev, ctx, deps),
    granted: () => step(ev, 'H12 plan capture', undefined as string | undefined, () => captureApprovedPlan(ctx, sid, text, cwd, rollout, now)),
    routePrompt() {
      const depsOf = deps.projectDeps ?? readProjectDeps
      return step(ev, 'H22 route', undefined, () => routeUserPrompt(text, {
        ctx, core: deps.core, policy: routingPolicy(ctx), ledger: loadLedger(H, sid),
        available: availableServers(ctx, deps.core, mcpHealth(ctx, H, now, { sid, nativeOff: codexOffServers() })), deps: depsOf(loadWorkspaceInfo(ctx, sid)?.root ?? cwd),
      }))
    },
    async promptRouted(route) {
      const start = workflowStart(route, text, deps.core)
      if (start !== undefined) await step(ev, 'H25 flow start', undefined, () => { recordWorkflowStart(sid, start, now) })
    },
    // Codex has no mode field in the payload: the collaboration mode is read from the rollout.
    readOnly: () => rollout !== undefined && readCollaborationMode(rollout) === 'plan',
    contextWarning: async () => contextWarning(ctx, ev, sid, await updateTelemetry(deps, ev, p, sid)),
  })
  if (r.user) await step(ev, 'turn receipt start', undefined, () => { turnStarted(ctx, sid, now) })
  if (!r.continuation) await step(ev, 'workflow notice seen', undefined, () => { flowNotice(ctx, sid, now, true) })
  return contextOutput('UserPromptSubmit', r.context, flow)
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
  const decision = await preTool({ call, now, subagent: isSubagentPayload(p), usage: true, edits: editedPaths(p, call, deps), asyncQuestion: call.tool === 'request_user_input_async' }, {
    ...pipelineDeps(ev, ctx, deps),
    holdConsent: command => step(ev, 'H20 consent prompt', false, () => canPromptConsent(p, ctx, command, env) && !unaskedConsent(sid, command, now)),
    writeTargets: c => writeTargets(p, c, cwd, deps.core),
    nativeOff: codexOffServers,
    usage: (c, health) => usagePlan(p, c, sid, ctx, deps, health),
    usageDone: plan => (plan.ledgerId === sid ? step(ev, 'H25 skill load', undefined, () => skillLoad(plan.call, sid, deps, now)) : undefined),
  })
  if (decision.action === 'deny') return denyOutput(decision.reason)
  const { context, held } = decision
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
  const sp = shellPatchOf(p)
  const judged: ToolCall = sp.kind === 'patch' ? { ...call, kind: 'patch' } : call
  const edits = sp.kind === 'patch' ? deps.core.patchEdits(sp.body).map(e => ({ file: e.path, removed: e.removed, added: e.added })) : undefined
  const isEdit = judged.kind === 'patch' || judged.kind === 'edit' || judged.kind === 'write'
  const pathRules = isEdit || judged.kind === 'bash' ? codexPathRules(ctx, deps.core) : undefined
  return { call: judged, ledgerId, available: availableServers(ctx, deps.core, health), ...(edits !== undefined ? { edits } : {}), ...(pathRules !== undefined ? { pathRules } : {}) }
}

function skillLoad(call: ToolCall, sid: string, deps: CodexHookDeps, now: number): void {
  const id = deps.core.skillOf(call, H)
  // Buracle installs its skills in ~/.agents/skills; $CODEX_HOME/skills covers a link an older install left.
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

const POST_PATCH_BUDGET_MS = harnessProfile('codex').editBudgetMs

async function onPostToolUse(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'PostToolUse'
  const start = deps.now()
  const call = toolCall(p, sid, cwd, ctx, deps)
  const sub = isSubagentPayload(p)
  const entries: SpoolEntry[] = []
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
  }
  const server = call.kind === 'mcp' ? call.mcp?.server : undefined
  const r = await postTool({
    sessionId: sid, cwd, now: start, subagent: sub, entries,
    answered: !sub && call.tool === 'request_user_input' && deps.core.questionAnswered(p['tool_response']),
    ...(edit !== undefined ? { edit } : {}),
    ...(server !== undefined && server !== '' ? { mcp: { server: () => server, ok: rec(p['tool_response'])['isError'] !== true } } : {}),
  }, {
    ...pipelineDeps(ev, ctx, deps),
    fileChecks: { core: deps.core, now: deps.now, run: deps.run, ...(deps.resolveChecker !== undefined ? { resolve: deps.resolveChecker } : {}) },
    editBudgetMs: POST_PATCH_BUDGET_MS,
  })
  const edited = edit !== undefined && edit.ok && edit.paths.length > 0 ? edit.paths : undefined
  const ask = edited !== undefined && ctx.config.checkers.enabled ? deps.lspEdits : undefined
  const lsp = ask !== undefined && edited !== undefined ? await step(ev, 'H04 language server', [] as string[], () => ask(edited, { cwd, deadlineMs: start + POST_PATCH_BUDGET_MS, now: deps.now })) : []
  const alarm = edited !== undefined && !sub && call.tool !== SHELL_TOOL ? await step(ev, 'turn receipt', undefined as string | undefined, () => filesChanged(ctx, sid, patchReceiptChanges(text, cwd))) : undefined
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
  const d = pipelineDeps(ev, ctx, deps)
  await preCompact({ harness: H, sessionId: sid, cwd, trigger, now }, {
    ...d,
    openTodos() {
      const plan = rollout !== undefined ? readLatestPlan(rollout) : undefined
      return plan !== undefined ? openPlanSteps(plan) : []
    },
  })
  await spool(d, sid, [{ ts: now, ev: 'compact', excerpt: `PreCompact (${trigger})` }])
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
    await spool(pipelineDeps(ev, ctx, deps), sid, [{ ts: now, ev: 'compact', excerpt: summary !== undefined ? summary.slice(0, COMPACT_EXCERPT_MAX) : `PostCompact (${trigger})` }])
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
  if (result.why === 'runaway-chain') {
    return `Buracle stop guard: ${core.RUNAWAY_PER_CHAIN} continuations in a row did not finish the plan, so this stop goes through. Check the plan file and the last messages before going on.`
  }
  if (result.why !== 'runaway-plan' || state.plan === undefined) return undefined
  const key = `${state.plan.path}#${state.plan.registeredAt}`
  const s = loadAdapterState(ctx, sid)
  if (s.runawayPlan === key) return undefined
  saveAdapterState(ctx, sid, { ...s, runawayPlan: key })
  return `Buracle stop guard: this plan used up its ${core.RUNAWAY_PER_PLAN} stop-guard continuations, so stops are no longer held for it. Check the plan; after a pause, \`buracle plan resume\` starts a new budget.`
}

async function onStop(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'Stop'
  const now = deps.now()
  const last = typeof p['last_assistant_message'] === 'string' ? p['last_assistant_message'] : undefined
  const entry: SpoolEntry = { ts: now, ev: 'stop' }
  if (last !== undefined && last.trim() !== '') entry.excerpt = last.slice(0, EXCERPT_MAX)
  const model = str(p['model'])
  if (model !== undefined) entry.model = model
  if (entry.excerpt !== undefined || entry.model !== undefined) await spool(pipelineDeps(ev, ctx, deps), sid, [entry])
  await updateTelemetry(deps, ev, p, sid)
  const sub = isSubagentPayload(p)
  const active = p['stop_hook_active'] === true
  if (!sub) await step(ev, 'H20 answered holds', 0, () => settleConsentAsks(sid, undefined, true))
  const rollout = str(p['transcript_path'])
  if (!sub) await step(ev, 'H12 proposed plan', false, () => noteProposedPlan(ctx, sid, last, now, active))
  const r = await stop({ harness: H, sessionId: sid, cwd, hookActive: active, subagent: sub, now, ...(last !== undefined ? { lastMessage: last } : {}) }, {
    ...pipelineDeps(ev, ctx, deps),
    readOnly: () => rollout !== undefined && readCollaborationMode(rollout) === 'plan',
    stopNotice: (result, before) => (result.readOnlyNotice === true ? READ_ONLY_NOTICE : step(ev, 'runaway notice', undefined as string | undefined, () => runawayNotice(ctx, sid, result, before))),
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
  await spool(pipelineDeps(ev, ctx, deps), sid, [{ ts: deps.now(), ev: 'note', tool: agent, excerpt: errors.length === 0 ? `${agent}: valid review report` : `${agent}: invalid review report: ${errors.slice(0, 5).join('; ')}` }])
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
