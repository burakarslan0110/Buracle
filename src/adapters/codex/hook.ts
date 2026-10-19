import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../../core/index'
import type { Harness, StopInput, ToolCall } from '../../core/events'
import { isAbsPath } from '../../core/events'
import type { SessionState, StopGuardResult, StopWhy } from '../../core/plan/state'
import type { McpHealth } from '../../core/policy/routing'
import type { HookHealth } from '../../core/status/model'
import type { WorkspaceInfo } from '../../core/workspace'
import type { AdapterContext } from '../registry'
import { readJsonSafeSync } from '../../engine/fsx'
import { currentBranch, projectIdentity } from '../../engine/git'
import { log } from '../../engine/log'
import { run as runProcess, type RunOptions, type RunResult } from '../../engine/proc'
import { loadState, profileGuard, reviewSubjects, sessionMaint, updateState, writeTelemetry } from '../../workflow/session-store'
import { recordFlowStart } from '../../workflow/flow'
import { loadLedger, resetLedger } from '../../workflow/ledger'
import { refreshWorkspaceInfo } from '../../workflow/workspace'
import type { SpoolEntry } from '../../core/memory/spool'
import type { NoticeTexts } from '../../core/notices'
import { consentGate, recordPromptGrants } from '../shared/consent-store'
import { reviewNotesNotice } from '../shared/review-notes'
import { noticesOff, runtimeVersion, startupNotices } from '../shared/notices'
import { assetsAfterEdit, assetsOptions, assetsSessionStart, startLinkRun, type AssetsSpawner } from '../shared/project-assets'
import { earlyEdit, readOnlyStart, startedWorkflow } from '../shared/plan-mode'
import { projectDeps as readProjectDeps } from '../shared/project-deps'
import { reviewAgentIds } from './agents'
import {
  bridgePostPayload, cmClassifyFailed, contextModeDenial, contextModeForward, contextModePrune, loadContextModeFns, type ContextModeFns,
} from './context-mode'
import { removedByFile } from '../shared/checker-scan'
import { fileCheckNotes, sessionOnce } from '../shared/file-checks'
import { captureApprovedPlan, noteProposedPlan } from './plan-capture'
import { canPromptConsent, consentPromptInput, onPermissionRequest, settleConsentAsks, type PromptEnv } from './consent-prompt'
import { unaskedConsent } from '../shared/consent-asks'
import { bashOptions, GUARDED_TOOLS, guardFailed, mcpWriteDenial, SHELL_TOOL, shellPatchOf, writeContext, writeDenial } from './guards'
import {
  blockOutput, byteLength, clipBytes, CONTEXT_BUDGET_BYTES, contextOutput, denyOutput, denyReason, json, loadAdapterState, NOTHING, rec,
  saveAdapterState, step, str, type CodexSessionState, type HookOutcome, type Payload,
} from './hook-io'
import { reviewErrors } from './review'
import {
  availableServers, codexPathRules, fitParts, knownServers, liveHealth, loadWorkspaceInfo, promptSignals, readMcpHealth, recordMcpResult, recordPrompt, recordWorkflowStart, resumeNotice,
  routeUserPrompt, routingPolicy, saveWorkspaceInfo, sessionHealth, stopAudit, usageReminders, workflowStart, workspaceFacts, workspaceNoticeFor,
} from './route'
import { POST_MASK_HANDLER } from './hooks-config'
import { maskOutcome } from './mask'
import { fallbackWindowLabel, openPlanSteps, readCollaborationMode, readCompactionSummary, readExecCwd, readLatestPlan, readRolloutTelemetry, type RolloutTelemetry } from './rollout'
import { shellPatchTargets } from './shell-patch'
import { patchReceiptChanges, spawnNotify } from '../shared/turn-receipt'
import { commandRan, filesChanged, flowNotice, hooksNotice, joinNotices, turnEnded, turnStarted, withSystemMessage } from './turn-notices'
import { isSubagentPayload, recordSubagentAlias, subagentLedgerId, subagentWorkspace } from './subagents'

export { fileCheckNotes } from '../shared/file-checks'
export { clipBytes, CONTEXT_BUDGET_BYTES, type HookOutcome } from './hook-io'
export { extractJsonObject, reviewReportErrors } from './review'
export { fitParts, readMcpHealth } from './route'
export { isSubagentPayload, MAX_SUBAGENT_ALIASES, recordSubagentAlias, subagentAliasesFile } from './subagents'

const H: Harness = 'codex'
const EXCERPT_MAX = 2_000
const COMPACT_EXCERPT_MAX = 8_000

export type { SpoolEntry }

export interface MemoryFns {
  appendSpool?: (h: Harness, sid: string, entries: SpoolEntry[]) => unknown
  spawnFinalizer?: (h: Harness, sid: string) => unknown
  sessionStart?: (h: Harness, sid: string, cwd: string, opts?: { nowMs?: number, model?: string }) => unknown
  promptSeen?: (h: Harness, sid: string, opts?: { nowMs?: number }) => unknown
  compactSeen?: (h: Harness, sid: string, opts?: { nowMs?: number }) => unknown
  contextText?: (opts: { cwd: string, harness?: string, branch?: string, nowMs?: number, maxBytes?: number }) => Promise<string>
  writeHandoff?: (input: { harness: Harness, sessionId: string, cwd: string, project?: string, branch?: string, slug: string, markdown: string, trigger?: string, now?: number }) => Promise<{ id: string, path: string, rel: string } | undefined>
  latestHandoff?: (opts: { project: string, branch?: string, nowMs?: number, session?: string }) => Promise<{ id: string, path: string, rel: string, title: string } | undefined>
}

export type CoreFns = typeof core

export interface CodexHookDeps {
  core: CoreFns
  memory: () => Promise<MemoryFns>
  now: () => number
  run: (argv: string[], opts?: RunOptions) => Promise<RunResult>
  resolveChecker?: (argv: readonly string[]) => string[]
  env?: () => Record<string, string | undefined>
  newId?: () => string
  platform?: string
  prepareWorkspace?: (cwd: string, ctx: AdapterContext, nowMs: number) => Promise<WorkspaceInfo | undefined>
  workspaceInfo?: (cwd: string, ctx: AdapterContext, nowMs: number) => Promise<WorkspaceInfo | undefined>
  refreshWorkspace?: (info: WorkspaceInfo, ctx: AdapterContext, nowMs: number) => WorkspaceInfo
  projectDeps?: (root: string) => string[]
  contextMode?: () => Promise<ContextModeFns>
  assetsSpawn?: AssetsSpawner
  lspEdits?: (files: readonly string[], opts: { cwd: string, deadlineMs: number, now: () => number }) => Promise<string[]>
  notify?: (title: string, message: string) => void
  hookHealth?: (nowMs: number) => Promise<HookHealth>
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
    out.compactSeen = m.compactSeen
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
  let cm: Promise<ContextModeFns> | undefined
  return {
    core, memory: () => (memo ??= loadMemoryFns()), now: () => Date.now(), run: runProcess, env: () => process.env,
    contextMode: () => (cm ??= loadContextModeFns()),
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

function notifier(ctx: AdapterContext, deps: CodexHookDeps): (title: string, message: string) => void {
  return deps.notify ?? ((title, message) => { spawnNotify(existsSync(ctx.buracleBin) ? [ctx.buracleBin] : undefined, title, message) })
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
  const health = sid !== undefined ? sessionHealth(ctx, deps.core, sid, deps.now()) : liveHealth(ctx, deps.core, readMcpHealth(ctx, deps.now()))
  const mcp = deps.core.catalogMcp(ctx.canonical.mcp, H).filter(m => health[m.id] !== 'down')
  return deps.core.capabilityCard({ policy: routingPolicy(ctx), mcp, skills: deps.core.catalogSkills(ctx.canonical.skills), plugins: [], harness: H })
}

async function memoryContext(deps: CodexHookDeps, cwd: string, now: number, room: number): Promise<string | undefined> {
  const m = await deps.memory()
  if (!m.contextText) return undefined
  const text = await m.contextText({ cwd, harness: H, nowMs: now, maxBytes: room })
  return text.trim() === '' ? undefined : text
}

async function restoreText(ctx: AdapterContext, deps: CodexHookDeps, sid: string, cwd: string, now: number): Promise<string> {
  const own = loadAdapterState(ctx, sid)
  let handoff = own.lastHandoff
  const todos = handoff === undefined && (own.lastTodos?.length ?? 0) > 0 ? own.lastTodos : undefined
  const recorded = own.lastCompactAt !== undefined && now - own.lastCompactAt <= core.RESTORE_RECORD_MAX_MS
  if (handoff === undefined && todos === undefined && !recorded && !memoryOff(deps)) {
    const m = await deps.memory()
    if (m.latestHandoff) {
      const id = await projectIdentity(cwd)
      const branch = await currentBranch(cwd)
      handoff = (await m.latestHandoff({ project: id.slug, ...(branch !== undefined ? { branch } : {}), nowMs: now, session: sid }))?.id
    }
  }
  return deps.core.restoreContext(loadState(H, sid), handoff, todos) ?? ''
}

function profileWarning(ctx: AdapterContext, deps: CodexHookDeps): string | undefined {
  const r = readJsonSafeSync<unknown>(ctx.paths.runtimeConfigFile())
  return profileGuard(H, r.ok ? r.value : undefined, envOf(deps))
}

async function onSessionStart(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'SessionStart'
  const source = str(p['source']) ?? 'startup'
  const now = deps.now()
  if (source !== 'compact' && !captureOff(deps)) {
    await step(ev, 'memory sessionStart', undefined, async () => {
      const m = await deps.memory()
      const model = str(p['model'])
      if (m.sessionStart) await m.sessionStart(H, sid, cwd, model !== undefined ? { nowMs: now, model } : { nowMs: now })
    })
  }
  await updateTelemetry(deps, ev, p, sid)
  const sub = isSubagentPayload(p)
  if (!sub && (source === 'startup' || source === 'clear')) await step(ev, 'H24 resetLedger', undefined, () => { resetLedger(H, sid) })
  const workspace = await step(ev, 'H21 workspace', '', () => workspaceStart(p, sid, cwd, ctx, deps, now))
  const assets = sub ? '' : await step(ev, 'H28 project assets', '', () => assetsSessionStart(loadWorkspaceInfo(ctx, sid)?.root, H, assetsOptions(now, deps.assetsSpawn)))
  const card = await step(ev, 'H15 capability card', '', () => capabilityCardText(ctx, deps, sid))
  const restore = source === 'compact' ? await step(ev, 'H07 restore', '', () => restoreText(ctx, deps, sid, cwd, now)) : ''
  const resumed = source === 'resume' && !sub ? await step(ev, 'H25 resume notice', undefined as ReturnType<typeof resumeNotice>, () => resumeNotice(sid, now, ctx.config, deps.core)) : undefined
  const notice = source === 'startup' && !sub && !noticesOff(envOf(deps))
    ? await step(ev, 'H17 notices', undefined as NoticeTexts | undefined, () => startupNotices(ctx.canonical.notices, { version: runtimeVersion(ctx.repoRoot), nowMs: now, harness: H }))
    : undefined
  const nonEmpty = (xs: string[]): string[] => xs.filter(s => s.trim() !== '')
  const cmRoom = CONTEXT_BUDGET_BYTES - byteLength(nonEmpty([restore, notice?.model ?? '', workspace, assets, resumed?.model ?? '', card]).join('\n\n')) - 64
  const cm = sub ? undefined : await contextModeForward(ev, p, { config: ctx.config, env: envOf(deps), load: deps.contextMode, maxBytes: Math.max(0, Math.min(core.CM_RESTORE_MAX_BYTES, cmRoom)) })
  const cmText = cm?.text ?? ''
  const fixed = nonEmpty([restore, cmText, notice?.model ?? '', workspace, assets, resumed?.model ?? '', card])
  const room = CONTEXT_BUDGET_BYTES - byteLength(fixed.join('\n\n')) - 64
  const index = room > 400 && !memoryOff(deps)
    ? await step(ev, 'H13 memory context', undefined as string | undefined, () => memoryContext(deps, cwd, now, room))
    : undefined
  let warning: string | undefined
  if (source === 'startup') {
    warning = await step(ev, 'H17 profileGuard', undefined as string | undefined, () => profileWarning(ctx, deps))
    await step(ev, 'H16 sessionMaint', undefined, () => { sessionMaint(H, now, { keep: [sid] }) })
    await contextModePrune(deps.contextMode, now)
  }
  const health = !sub && (source === 'startup' || source === 'resume') && ctx.config.workflow.codexNotices
    ? await step(ev, 'hooks notice', undefined as string | undefined, async () => hooksNotice(ctx, await hookHealthOf(deps, now)))
    : undefined
  const user = [warning, notice?.user, resumed?.user, health].filter((s): s is string => s !== undefined).join('\n')
  return contextOutput('SessionStart', [restore, cmText, notice?.model ?? '', workspace, assets, resumed?.model ?? '', index !== undefined ? clipBytes(index, room) : '', card], user !== '' ? user : undefined)
}

async function workspaceStart(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps, now: number): Promise<string> {
  const sub = isSubagentPayload(p)
  const info = sub ? await subagentWorkspace(sid, cwd, ctx, deps, now) : await deps.prepareWorkspace?.(cwd, ctx, now)
  if (info === undefined) return ''
  if (!sub) saveWorkspaceInfo(ctx, sid, info)
  return deps.core.workspaceContext(info, H)
}

const NO_SIGNALS: ReturnType<CoreFns['detectSignals']> = { control: null, recall: false, write: false }

async function routePromptStep(prompt: string, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps, now: number, invoked: string[] = []): Promise<string | undefined> {
  const ev = 'UserPromptSubmit'
  const policy = routingPolicy(ctx)
  const info = loadWorkspaceInfo(ctx, sid)
  const depsOf = deps.projectDeps ?? readProjectDeps
  const routed = await step(ev, 'H22 route', undefined, () => routeUserPrompt(prompt, {
    ctx, core: deps.core, policy, ledger: loadLedger(H, sid), available: availableServers(ctx, deps.core, sessionHealth(ctx, deps.core, sid, now)), deps: depsOf(info?.root ?? cwd),
  }))
  if (routed === undefined) return undefined
  invoked.push(...routed.route.invoked, ...routed.route.load)
  await step(ev, 'H24 ledgerPrompt', undefined, () => { recordPrompt(sid, routed.route, now, deps.core) })
  const start = workflowStart(routed.route, prompt, deps.core)
  if (start !== undefined) await step(ev, 'H25 flow start', undefined, () => { recordWorkflowStart(sid, start, now) })
  if (!captureOff(deps)) {
    const signals = await step(ev, 'H26 signals', [] as ReturnType<typeof promptSignals>, () => promptSignals(prompt, routed.route.invoked, deps.core))
    await spool(deps, ev, sid, signals.map(signal => ({ ts: now, ev: 'signal' as const, signal })))
  }
  return routed.text
}

async function onUserPromptSubmit(p: Payload, sid: string, cwd: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'UserPromptSubmit'
  if (isSubagentPayload(p)) return NOTHING
  const prompt = typeof p['prompt'] === 'string' ? p['prompt'] : ''
  const now = deps.now()
  await step(ev, 'H20 answered holds', 0, () => settleConsentAsks(sid, undefined, true))
  const parts: string[] = []
  const continuation = await step(ev, 'H10 isGuardContinuation', false, () => deps.core.isGuardContinuation(prompt))
  const flow = await step(ev, 'workflow notice', undefined as string | undefined, () => flowNotice(ctx, sid, now))
  if (!continuation) {
    await step(ev, 'turn receipt start', undefined, () => { turnStarted(ctx, sid, now) })
    const intent = (await step(ev, 'H10 detectSignals', NO_SIGNALS, () => deps.core.detectSignals(prompt))).control
    const guidance = await step(ev, 'H10 interaction', undefined as string | undefined, () => {
      const opts = { autoPause: ctx.config.plan.autoPause, now }
      const before = loadState(H, sid)
      if (before.plan === undefined) return deps.core.promptInteraction(before, intent, prompt, opts).guidance
      let text: string | undefined
      updateState(H, sid, s => {
        const r = deps.core.promptInteraction(s, intent, prompt, opts)
        text = r.guidance
        return r.next
      })
      return text
    })
    if (guidance !== undefined) parts.push(guidance)
    const notes = await step(ev, 'H10 review notes', undefined as string | undefined, () => reviewNotesNotice(H, sid, { plan: loadState(H, sid).plan?.path, roots: [loadWorkspaceInfo(ctx, sid)?.root, cwd], now }))
    if (notes !== undefined) parts.push(notes)
    await step(ev, 'H20 grants', undefined, () => { recordPromptGrants(H, sid, prompt, now) })
    const saved = await step(ev, 'H12 plan capture', undefined as string | undefined, () => captureApprovedPlan(ctx, sid, prompt, cwd, str(p['transcript_path']), now))
    if (saved !== undefined) parts.push(saved)
    const invoked: string[] = []
    const routeText = await step(ev, 'H22 router', undefined as string | undefined, () => routePromptStep(prompt, sid, cwd, ctx, deps, now, invoked))
    const rollout = str(p['transcript_path'])
    const planMode = startedWorkflow(invoked) !== undefined && rollout !== undefined
      ? await step(ev, 'H10 read-only start', undefined as string | undefined, () => readOnlyStart(H, readCollaborationMode(rollout) === 'plan', invoked))
      : undefined
    if (planMode !== undefined) parts.push(planMode)
    if (routeText !== undefined) parts.push(routeText)
    await contextModeForward(ev, p, { config: ctx.config, env: envOf(deps), load: deps.contextMode })
  }
  const refresh = deps.refreshWorkspace
  if (refresh !== undefined) {
    const notice = await step(ev, 'H21 notice', undefined as string | undefined, () => workspaceNoticeFor(ctx, sid, deps.core, info => refresh(info, ctx, now)))
    if (notice !== undefined) parts.push(notice)
  }
  const usage = await updateTelemetry(deps, ev, p, sid)
  const warning = await contextWarning(ctx, ev, sid, usage)
  if (warning) parts.push(warning)
  if (!continuation) {
    await step(ev, 'workflow notice seen', undefined, () => { flowNotice(ctx, sid, now, true) })
    const excerpt = core.spoolPromptExcerpt(prompt)
    await spool(deps, ev, sid, [{ ts: now, ev: 'prompt', ...(excerpt !== undefined ? { excerpt } : {}) }])
    if (!captureOff(deps)) await step(ev, 'memory tick', undefined, async () => { (await deps.memory()).promptSeen?.(H, sid, { nowMs: now }) })
  }
  return contextOutput('UserPromptSubmit', fitParts(parts, core.PROMPT_CONTEXT_MAX_CHARS), flow)
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
    const cm = cmClassifyFailed(tool, e)
    return cm !== undefined ? denyOutput(cm) : NOTHING
  }
  let held: { command: string, reason: string, env: PromptEnv } | undefined
  const cmDeny = await contextModeDenial({ payload: p, call, sid, cwd, core: deps.core, now, bash: () => bashOptions(ctx, cwd), write: () => writeContext(ev, cwd, ctx), lane: isSubagentPayload(p) })
  if (cmDeny !== undefined) return denyOutput(cmDeny)
  if (call.kind === 'bash' && call.command !== undefined) {
    let r: { deny?: string }
    try {
      r = deps.core.checkBash(call.command, bashOptions(ctx, cwd))
    } catch (e) {
      log('error', 'codex hook PreToolUse: H01 bash guard failed; denying (fail closed)', { error: e })
      return denyOutput(guardFailed('H01', e))
    }
    if (r.deny) return denyOutput(denyReason('H01', r.deny))
    const command = call.command
    const lane = isSubagentPayload(p) ? await step(ev, 'H01 lane guard', undefined as string | undefined, () => deps.core.laneStateDenial(command)) : undefined
    if (lane !== undefined) return denyOutput(lane)
    const consent = await step(ev, 'H20 consent', undefined as string | undefined, () => consentGate(H, sid, command, now, deps.core.consentVerdict))
    if (consent !== undefined) {
      const env = { platform: deps.platform ?? process.platform, shell: envOf(deps)['SHELL'] }
      if (!await step(ev, 'H20 consent prompt', false, () => canPromptConsent(p, ctx, command, env) && !unaskedConsent(sid, command, now))) return denyOutput(denyReason('H20', consent))
      held = { command, reason: consent, env }
    }
  }
  if (call.tool === SHELL_TOOL || call.kind === 'patch' || call.kind === 'edit' || call.kind === 'write') {
    const denied = await writeDenial(p, call, cwd, ctx, deps.core, ev)
    if (denied !== undefined) return denyOutput(denied)
  }
  const mcpDenied = await mcpWriteDenial(call, cwd, ctx, deps.core, ev)
  if (mcpDenied !== undefined) return denyOutput(mcpDenied)
  const questionContext: string[] = []
  if (call.kind === 'ask_user') {
    const r = await step(ev, 'H09 checkQuestion', {} as { deny?: string, context?: string }, () => deps.core.checkQuestion(loadState(H, sid), call, now))
    if (r.deny) return denyOutput(denyReason('H09', r.deny))
    if (!isSubagentPayload(p)) {
      const paused = call.tool === 'request_user_input_async' && r.context !== undefined
        ? await step(ev, 'H09 async question pause', false, () => {
          let changed = false
          updateState(H, sid, s => { const next = deps.core.questionPause(s, call, now); changed = next !== s; return next })
          return changed
        })
        : false
      if (paused) questionContext.push(deps.core.ASYNC_QUESTION_PAUSED)
      else if (r.context !== undefined) questionContext.push(r.context)
    }
  }
  const health = sessionHealth(ctx, deps.core, sid, now)
  const decision = await step(ev, 'H03 routeTool', undefined as ReturnType<CoreFns['routeTool']> | undefined, () => deps.core.routeTool(call, routingPolicy(ctx), health))
  if (decision?.action === 'deny') return denyOutput(denyReason(decision.hook, decision.reason))
  const context = decision?.action === 'allow' && decision.context ? [...decision.context, ...questionContext] : [...questionContext]
  const ledgerId = isSubagentPayload(p) ? subagentLedgerId(p, sid, ctx) : sid
  if (ledgerId !== undefined) {
    const usage = await step(ev, 'H24 reminders', undefined as UsageStep | undefined, () => usageStep(p, call, sid, ledgerId, ctx, deps, health, now))
    if (usage?.deny !== undefined) return denyOutput(denyReason('H03', usage.deny))
    if (usage?.context !== undefined) context.push(usage.context)
  }
  const early = await step(ev, 'H03 early edit', undefined as ReturnType<typeof earlyEdit>, () => earlyEdit(H, sid, editedPaths(p, call, deps), cwd, ctx.config.plan.planApproval))
  if (early !== undefined) {
    context.push(early.note)
    await step(ev, 'H03 early edit mark', undefined, () => { early.commit() })
  }
  if (held === undefined) return contextOutput('PreToolUse', context)
  const h = held
  const prompted = await step(ev, 'H20 consent prompt', undefined as Record<string, unknown> | undefined, () => consentPromptInput(p, sid, h.command, ctx, now, newConsentId(deps), h.env))
  return prompted !== undefined ? promptOutput(prompted, context) : denyOutput(denyReason('H20', h.reason))
}

interface UsageStep { deny?: string, context?: string }

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

async function usageStep(p: Payload, call: ToolCall, sid: string, ledgerId: string, ctx: AdapterContext, deps: CodexHookDeps, health: McpHealth, now: number): Promise<UsageStep> {
  const facts = workspaceFacts(ctx, loadWorkspaceInfo(ctx, sid))
  const sp = shellPatchOf(p)
  const judged: ToolCall = sp.kind === 'patch' ? { ...call, kind: 'patch' } : call
  const edits = sp.kind === 'patch' ? deps.core.patchEdits(sp.body).map(e => ({ file: e.path, removed: e.removed, added: e.added })) : undefined
  const isEdit = judged.kind === 'patch' || judged.kind === 'edit' || judged.kind === 'write'
  const projectDepsOf = deps.projectDeps ?? readProjectDeps
  const pathRules = isEdit || judged.kind === 'bash' ? codexPathRules(ctx, deps.core) : undefined
  const v = usageReminders(judged, ledgerId, {
    ctx, core: deps.core, policy: routingPolicy(ctx), available: availableServers(ctx, deps.core, health), facts,
    deps: isEdit && facts.root !== undefined ? projectDepsOf(facts.root) : [], ...(edits !== undefined ? { edits } : {}),
    ...(pathRules !== undefined ? { pathRules } : {}),
  })
  if (ledgerId === sid && v.deny === undefined) await step('PreToolUse', 'H25/H26 skill load', undefined, () => skillLoad(judged, v.loaded, sid, ctx, deps, now))
  const out: UsageStep = {}
  if (v.deny !== undefined) out.deny = v.deny.replace(/^Buracle:\s*/, '')
  if (v.context !== undefined) out.context = v.context
  return out
}

async function skillLoad(call: ToolCall, first: string | undefined, sid: string, _ctx: AdapterContext, deps: CodexHookDeps, now: number): Promise<void> {
  const id = deps.core.skillOf(call, H)
  const installed = id !== undefined && new RegExp(`\\.agents[/\\\\]skills[/\\\\]${id}[/\\\\]SKILL\\.md`).test(call.command ?? '')
  const workflow = installed ? deps.core.workflowOfSkill(`buracle:${id}`) : undefined
  const started = workflow !== undefined && recordFlowStart(H, sid, { workflow, source: 'skill' }, now)
  if (captureOff(deps)) return
  const signals = [first !== undefined ? deps.core.profileUsageSignal('skill', first) : undefined, started && workflow !== undefined ? deps.core.profileUsageSignal('workflow', workflow) : undefined]
  await spool(deps, 'PreToolUse', sid, signals.flatMap(signal => (signal !== undefined ? [{ ts: now, ev: 'signal' as const, signal }] : [])))
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
  const context: string[] = []
  const entries: SpoolEntry[] = []
  let alarm: string | undefined
  const shellPatch = await step(ev, 'shell apply_patch', undefined as { paths: string[], added: Record<string, string> } | undefined, () => {
    const sp = shellPatchOf(p)
    if (sp.kind !== 'patch') return undefined
    const t = shellPatchTargets(sp, deps.core.parseApplyPatch)
    return 'undetermined' in t ? undefined : t
  })
  if ((call.kind === 'patch' && call.tool !== SHELL_TOOL) || shellPatch !== undefined) {
    const input = rec(p['tool_input'])
    const text = typeof input['command'] === 'string' ? input['command'] : Array.isArray(input['command']) ? (input['command'] as unknown[]).filter(x => typeof x === 'string').join('\n') : ''
    const parsed = shellPatch ?? await step(ev, 'parseApplyPatch', { paths: call.paths, added: {} as Record<string, string> }, () => deps.core.parseApplyPatch(text, cwd))
    const response = p['tool_response']
    const failed = typeof response === 'string' && /^\s*(?:Failed|Error)\b/i.test(response)
    if (!failed && parsed.paths.length > 0) {
      const notes = await step(ev, 'H04', [] as string[], () => {
        const sp = shellPatchOf(p)
        const removed = removedByFile(deps.core.patchEdits(sp.kind === 'patch' ? sp.body : text), parsed.paths)
        return fileCheckNotes(parsed.paths, parsed.added, cwd, ctx.config.checkers, { core: deps.core, now: deps.now, run: deps.run, once: sessionOnce(H, sid), ...(deps.resolveChecker !== undefined ? { resolve: deps.resolveChecker } : {}) }, start + POST_PATCH_BUDGET_MS, removed)
      })
      if (notes.length > 0) context.push(`Buracle file checks after apply_patch:\n\n${notes.join('\n\n')}`)
      const ask = ctx.config.checkers.enabled ? deps.lspEdits : undefined
      const lsp = ask !== undefined ? await step(ev, 'H04 language server', [] as string[], () => ask(parsed.paths, { cwd, deadlineMs: start + POST_PATCH_BUDGET_MS, now: deps.now })) : []
      if (lsp.length > 0) context.push(`Buracle language server diagnostics after apply_patch:\n\n${lsp.join('\n\n')}`)
      const assets = await step(ev, 'H28 project assets', undefined as string | undefined, () => assetsAfterEdit(loadWorkspaceInfo(ctx, sid)?.root, parsed.paths, assetsOptions(start, deps.assetsSpawn)))
      if (assets !== undefined) context.push(assets)
      if (!sub && call.tool !== SHELL_TOOL) alarm = await step(ev, 'turn receipt', undefined as string | undefined, () => filesChanged(ctx, sid, patchReceiptChanges(text, cwd)))
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
  if (!sub && call.tool === 'request_user_input' && deps.core.questionAnswered(p['tool_response'])) {
    await step(ev, 'H08 answer receipt', undefined, () => { updateState(H, sid, s => deps.core.answerReceipt(s, start)) })
  }
  await spool(deps, ev, sid, entries)
  if (!sub && (call.kind === 'bash' || call.kind === 'patch')) {
    const forwarded = await step(ev, 'H27 payload', undefined as Payload | undefined, () => bridgePostPayload(p))
    if (forwarded !== undefined) await contextModeForward(ev, forwarded, { config: ctx.config, env: envOf(deps), load: deps.contextMode })
  }
  const server = call.kind === 'mcp' ? call.mcp?.server : undefined
  const mcpTool = call.mcp?.tool
  if (server !== undefined && server !== '') await step(ev, 'H24 MCP result', undefined, () => { recordMcpResult(deps.core, sid, server, rec(p['tool_response'])['isError'] !== true, mcpTool) })
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
  const state = loadState(H, sid)
  const rollout = str(p['transcript_path'])
  const plan = rollout !== undefined ? await step(ev, 'H06 todos', undefined as unknown[] | undefined, () => readLatestPlan(rollout)) : undefined
  const todo = plan !== undefined ? openPlanSteps(plan) : []
  const mark = (handoff?: string) => step(ev, 'H06 compaction record', undefined, () => {
    const next: CodexSessionState = { ...loadAdapterState(ctx, sid), lastCompactAt: now }
    delete next.lastHandoff
    delete next.lastTodos
    if (handoff !== undefined) next.lastHandoff = handoff
    else if (todo.length > 0) next.lastTodos = todo.slice(0, core.RESTORE_TODOS_MAX)
    saveAdapterState(ctx, sid, next)
  })
  await mark()
  const written = memoryOff(deps) ? undefined : await step(ev, 'H06 handoff', undefined as string | undefined, async () => {
    const m = await deps.memory()
    if (!m.writeHandoff) return undefined
    const id = await projectIdentity(cwd)
    const branch = await currentBranch(cwd)
    const input: Parameters<CoreFns['handoffNote']>[0] = { state, project: id.slug, harness: H, sessionId: sid, now }
    if (branch !== undefined) input.branch = branch
    if (todo.length > 0) input.todo = todo
    const note = deps.core.handoffNote(input)
    return (await m.writeHandoff({ harness: H, sessionId: sid, cwd, project: id.slug, ...(branch !== undefined ? { branch } : {}), slug: note.slug, markdown: note.markdown, trigger, now }))?.id
  })
  if (written !== undefined) await mark(written)
  if (plan !== undefined) {
    const planned: Payload = { ...p, hook_event_name: 'PostToolUse', tool_name: 'update_plan', tool_input: { plan } }
    await contextModeForward('PostToolUse', planned, { config: ctx.config, env: envOf(deps), load: deps.contextMode })
  }
  await contextModeForward(ev, p, { config: ctx.config, env: envOf(deps), load: deps.contextMode })
  await spool(deps, ev, sid, [{ ts: now, ev: 'compact', excerpt: `PreCompact (${trigger})` }])
  if (!captureOff(deps)) await step(ev, 'memory tick', undefined, async () => { (await deps.memory()).compactSeen?.(H, sid, { nowMs: now }) })
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

function resolvePlanPath(state: SessionState, cwd: string): string | undefined {
  const p = state.plan?.path
  if (p === undefined || p === '') return undefined
  return isAbsPath(p) ? p : join(cwd, p)
}

function planCheckOf(state: SessionState, cwd: string, deps: CodexHookDeps): core.PlanDoc {
  const path = resolvePlanPath(state, cwd)
  const text = path !== undefined ? readIfFile(path) : undefined
  if (text === undefined) return { exists: false, findings: [] }
  return { exists: true, findings: state.plan?.phase === 'plan' ? deps.core.validatePlan(text) : [], text }
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
  if (!isSubagentPayload(p)) {
    await step(ev, 'H20 answered holds', 0, () => settleConsentAsks(sid, undefined, true))
    await step(ev, 'H28 project assets', false, () => startLinkRun(loadWorkspaceInfo(ctx, sid)?.root, assetsOptions(now, deps.assetsSpawn)))
    await step(ev, 'H12 proposed plan', false, () => noteProposedPlan(ctx, sid, last, now, p['stop_hook_active'] === true))
  }

  const state = loadState(H, sid)
  if (state.plan === undefined) return auditOutcome(p, sid, ctx, deps, 'no-plan')
  const input: StopInput = { harness: H, sessionId: sid, cwd, hookActive: p['stop_hook_active'] === true, now }
  if (last !== undefined) input.lastMessage = last
  const rollout = str(p['transcript_path'])
  if (rollout !== undefined && await step(ev, 'read-only mode', false, () => readCollaborationMode(rollout) === 'plan')) input.readOnly = true
  const result = await step(ev, 'H08/H11 stopGuardVerdict', undefined as { result: StopGuardResult, state: SessionState } | undefined, () => {
    let out: { result: StopGuardResult, state: SessionState } | undefined
    updateState(H, sid, s => {
      const r = deps.core.stopGuardVerdict(s, input, ctx.config.plan, s.plan !== undefined ? planCheckOf(s, cwd, deps) : undefined)
      out = { result: r, state: s }
      return r.next
    })
    return out
  })
  if (result === undefined) return NOTHING
  const { decision } = result.result
  if (decision.action === 'block') {
    await step(ev, 'runaway notice reset', undefined, () => {
      const s = loadAdapterState(ctx, sid)
      if (s.runawayPlan === undefined) return
      const next: CodexSessionState = { ...s }
      delete next.runawayPlan
      saveAdapterState(ctx, sid, next)
    })
    return blockOutput(stopReason(decision.reason))
  }
  const notice = result.result.readOnlyNotice === true ? READ_ONLY_NOTICE : await step(ev, 'runaway notice', undefined as string | undefined, () => runawayNotice(ctx, sid, result.result, result.state))
  return auditOutcome(p, sid, ctx, deps, result.result.why, notice)
}

async function auditOutcome(p: Payload, sid: string, ctx: AdapterContext, deps: CodexHookDeps, why: StopWhy, notice?: string): Promise<HookOutcome> {
  const audit = !isSubagentPayload(p) && deps.core.routeAuditAllowed(why, ctx.config.routing.strictness)
  const reason = audit ? await step('Stop', 'H23 turnAudit', undefined as string | undefined, () => stopAudit(sid, deps.core)) : undefined
  const ended = reason === undefined && !isSubagentPayload(p)
  const now = deps.now()
  const answer = typeof p['last_assistant_message'] === 'string' ? p['last_assistant_message'] : ''
  const receipt = ended ? await step('Stop', 'turn receipt', undefined as string | undefined, () => turnEnded(ctx, sid, { answer, now, notify: notifier(ctx, deps) })) : undefined
  const flow = ended ? await step('Stop', 'workflow notice', undefined as string | undefined, () => flowNotice(ctx, sid, now)) : undefined
  const message = joinNotices(notice, receipt, flow)
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
  return contextOutput('SubagentStart', [await step('SubagentStart', 'H21 workspace', '', () => workspaceStart(p, sid, cwd, ctx, deps, deps.now()))])
}

async function onSessionEnd(sid: string, ctx: AdapterContext, deps: CodexHookDeps): Promise<HookOutcome> {
  const ev = 'SessionEnd'
  if (captureOff(deps)) return NOTHING
  await step(ev, 'H14 spawnFinalizer', undefined, async () => {
    const m = await deps.memory()
    if (m.spawnFinalizer) { await m.spawnFinalizer(H, sid); return }
    if (!existsSync(ctx.buracleBin)) return
    const child = Bun.spawn([ctx.buracleBin, 'mem', 'finalize', '--harness', H, '--session', sid, '--detach'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env } })
    child.unref()
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
