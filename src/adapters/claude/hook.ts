import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import * as core from '../../core/index'
import type { ToolCall, ToolKind } from '../../core/events'
import { classifyTool } from '../../core/events'
import { workflowOfPrompt, workflowOfSkill } from '../../core/flow/catalog'
import type { SpoolEntry } from '../../core/memory/spool'
import { mcpUnavailable } from '../../core/policy/routing'
import { questionAnswered } from '../../core/policy/questions'
import type { PromptSignals } from '../../core/policy/intents'
import { isUserText } from '../../core/policy/intents'
import type { ConsentState } from '../../core/policy/consent'
import { REVIEWER_AGENT_ENV, companionAgent, companionToolDenial } from '../../core/policy/companion-fence'
import { reviewerShellDenial } from '../../core/policy/readonly-shell'
import { ledgerCall, skillOf } from '../../core/policy/usage'
import { contextThresholds, contextWatch, type ContextBand } from '../../core/status/context'
import type { WorkspaceInfo } from '../../core/workspace'
import { atomicWriteSync, readJsonSafeSync } from '../../engine/fsx'
import { currentBranch, projectSlug } from '../../engine/git'
import { log } from '../../engine/log'
import * as paths from '../../engine/paths'
import { run as runProcess } from '../../engine/proc'
import { loadLedger, updateLedger } from '../../workflow/ledger'
import { shownPath } from '../../workflow/plan-capture'
import { captureSessionPlan } from '../../workflow/plan-native'
import { readTelemetry, sessionMaint } from '../../workflow/session-store'
import { refreshWorkspaceInfo } from '../../workflow/workspace'
import type { AdapterContext } from '../registry'
import { consentFile, readConsentState } from '../shared/consent-store'
import { claudeOffServers } from '../shared/native-off'
import type { AssetsSpawner } from '../shared/project-assets'
import {
  guardFailed, mcpHealth, postTool, preTool, prompt as promptEvent, recordMcpResult, sessionStart as sessionStartEvent, workspaceStart,
} from '../shared/pipeline/index'
import { realWriteTarget } from '../shared/realpath'
import { buracleRepoFor } from '../shared/repo'
import { SHELL_TOOLS } from './constants'
import { compactStore, postCompact, preCompact, REVIEW_AGENT, sessionEnd, stop, subagentStop } from './hook-end'
import { HANDBACK_TOOL, subagentHandback } from './hook-handback'
import { GUARD_FAILED, H, QUIET, contextOut, isObj, isSubagent, out, pipelineDeps, step, str, type HookOutcome } from './hook-io'
import {
  availableServers, capabilityCardText, memoryOnlyRouting, permissionNotice, pluginRoot, pluginServers, projectDeps, promptRouting, readWorkspace,
  routerData, type PromptRouting, type RouterData,
} from './hook-route'
import { addedText, exitCodeOf, failed, noteWork, removedText } from './hook-work'
import { uiSessionHooks, type UiSessionHooks } from '../shared/ui-session'
import { writeContents } from './write-content'

export type { HookOutcome } from './hook-io'
export { CONTEXT_BUDGET_BYTES, clipBytes } from '../shared/pipeline/index'
export { FALLBACK_SPOOL_SUFFIX, GUARD_FAILED } from './hook-io'
export { REVIEW_AGENT, handoffRecordPath, reviewNote, runawayNotice } from './hook-end'
export { capabilityCardText, readHealth } from './hook-route'

export type HookCore = Pick<typeof core, 'checkBash' | 'checkWrite' | 'routeTool' | 'validatePlan' | 'stopGuardVerdict' | 'handoffNote' | 'restoreContext' | 'validateReviewJson' | 'checkQuestion' | 'consentVerdict'>

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
const OTHER_TOOLS: readonly string[] = ['AskUserQuestion', 'WebSearch', 'WebFetch', ...USAGE_TOOLS]
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
  core,
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
    case 'PostCompact': return postCompact(p, sid, ctx, d, now)
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

async function sessionStart(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  const source = str(p['source']) ?? 'startup'
  const cwd = str(p['cwd']) ?? process.cwd()
  const model = str(p['model'])
  // Claude Code prints a SessionStart systemMessage as "SessionStart:startup says: …" at the top of every session, so
  // nothing goes there: the profile warning and the notices reach the user through the model's first reply.
  const r = await sessionStartEvent({ harness: H, sessionId: sid, cwd, source, subagent: isSubagent(p), now, ...(model !== undefined ? { model } : {}) }, {
    ...pipelineDeps(ctx, d),
    capabilityCard: () => capabilityCardText(ctx, mcpHealth(ctx, H, now, { sid, nativeOff: claudeOffServers(cwd, pluginRoot(ctx.repoRoot, d.env)) })),
    compact: compactStore(sid, now),
    profileNote: finding => `Buracle setup warning. Tell the user at the start of your next reply, in one short line, then carry on with their request:\n- ${finding}`,
    sessionMaint: (nowMs, keep) => { d.sessionMaint(nowMs, keep) },
  })
  return contextOut('SessionStart', r.context)
}

async function subagentStart(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  const cwd = str(p['cwd']) ?? process.cwd()
  return contextOut('SubagentStart', [await step('H21 workspace (subagent)', '', () => workspaceStart({ sessionId: sid, cwd, subagent: true, now }, pipelineDeps(ctx, d)))])
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
  const available = availableServers(root, mcpHealth(ctx, H, now, { sid, nativeOff: claudeOffServers(cwd ?? process.cwd(), root) }), ctx)
  let data: RouterData | undefined
  try { data = routerData(ctx) } catch (e) { log('warn', 'claude hook: the prompt router has no canonical data; routing memory signals only', { error: e }) }
  if (data === undefined) return memoryOnlyRouting(signals, available, ctx.config.routing.strictness)
  const o: Parameters<typeof promptRouting>[2] = { ledger: loadLedger(H, sid), available, skills: ctx.config.routing.skills, pluginRoot: root }
  const deps = projectDeps(readWorkspace(sid)?.root)
  if (deps !== undefined) o.deps = deps
  return promptRouting(prompt, data, o)
}

async function userPromptSubmit(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number): Promise<HookOutcome> {
  if (isSubagent(p)) return QUIET
  const text = typeof p['prompt'] === 'string' ? p['prompt'] : ''
  const typed = workflowOfPrompt(text)
  // Claude Code sends its own notices (task notifications, command output) through this event: isUserText keeps them out of the user's steps.
  const r = await promptEvent({ harness: H, sessionId: sid, cwd: str(p['cwd']) ?? process.cwd(), text, userText: isUserText(text), now }, {
    ...pipelineDeps(ctx, d),
    granted: async () => { if (typed !== undefined) await flowStart(sid, typed.workflow, typed.args, 'prompt', now) },
    routePrompt: signals => promptRoute(text, signals, sid, ctx, d, now, str(p['cwd'])),
    ...(typed !== undefined ? { typedWorkflow: typed.workflow } : {}),
    readOnly: () => p['permission_mode'] === 'plan',
    contextWarning: () => contextWarning(ctx, sid, now),
  })
  const system = r.user ? await step('permission mode', undefined as string | undefined, () => permissionNotice(sid, p['permission_mode'], ctx.config, now)) : undefined
  return contextOut('UserPromptSubmit', r.context, system)
}

function deny(reason: string): HookOutcome {
  return out({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })
}

export const WRITE_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

async function preToolUse(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number, guardsOnly = false): Promise<HookOutcome> {
  const decided = await preToolDecision(p, sid, ctx, d, now, guardsOnly)
  if (!Array.isArray(decided)) return decided
  // Claude Code runs no hook between the tool calls of a turn but this one, so the context warning rides on it.
  const warning = guardsOnly || isSubagent(p) ? undefined : await step('H05 context warning', undefined as string | undefined, () => contextWarning(ctx, sid, now))
  // Claude Code's PreToolUse context is one block, a line per note.
  const text = (warning !== undefined ? [...decided, warning] : decided).filter(l => l.trim() !== '').join('\n')
  return text === '' ? QUIET : out({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: text } })
}

/** The context lines of an allowed call, or the finished output of a denied or handed-back one. */
async function preToolDecision(p: Record<string, unknown>, sid: string, ctx: AdapterContext, d: HookDeps, now: number, guardsOnly: boolean): Promise<HookOutcome | string[]> {
  const tool = str(p['tool_name']) ?? ''
  const input = isObj(p['tool_input']) ? p['tool_input'] : {}
  const cwd = str(p['cwd']) ?? ''
  const fenced = companionFence(d, tool, input)
  if (fenced !== undefined) return deny(fenced)
  const write = WRITE_TOOLS.includes(tool)
  const shell = SHELL_TOOLS.includes(tool)
  const mcp = tool.startsWith('mcp__')
  if (!write && !shell) {
    if (guardsOnly && !mcp) return []
    if (tool === HANDBACK_TOOL) return subagentHandback(p, sid, REVIEW_AGENT, d, now)
    if (!mcp && !OTHER_TOOLS.includes(tool)) return []
  }
  const root = pluginRoot(ctx.repoRoot, d.env)
  let call: ToolCall
  try {
    call = { harness: H, sessionId: sid, cwd, tool, input, ...classifyTool(H, tool, input, cwd, mcp ? pluginServers(root) ?? [] : undefined) }
  } catch (e) {
    if (!write) throw e
    log('error', 'claude hook PreToolUse: H02 write guard failed; denying (fail closed)', { sid, tool, error: e })
    return deny(guardFailed('H02', e))
  }
  if (shell) {
    const command = call.command ?? str(input['command'])
    if (command === undefined) return []
    call = { ...call, kind: 'bash', command }
  }
  const edits = write && tool !== 'NotebookEdit'
  const r = await preTool({
    call, now, subagent: isSubagent(p), guardsOnly, ...(edits ? { edits: call.paths } : {}),
    // The reminders count the tools Buracle routes: the shell, file edits, searches, skills and its own plugin's MCP servers.
    usage: shell || edits || USAGE_TOOLS.includes(tool) || tool.startsWith(PLUGIN_MCP_PREFIX),
  }, {
    ...pipelineDeps(ctx, d),
    shellDenial: command => step('reviewer shell', undefined as string | undefined, () => reviewerShellDenial(str(p['agent_type']), command)),
    writeTargets: c => (write ? { paths: c.paths, contents: guard => writeContents(c.tool, c.input, c.paths, guard.home, q => d.realpath(q)) } : undefined),
    nativeOff: () => claudeOffServers(cwd, root),
    usage(c, health) {
      // The reminders judge a whole-file write against the text it replaces.
      const replaced = c.kind === 'edit' || c.kind === 'write' ? writeEdits(c) : undefined
      return { call: c, ledgerId: sid, available: (pluginServers(root) ?? []).filter(id => !mcpUnavailable(health[id])), ...(replaced !== undefined ? { edits: replaced } : {}) }
    },
  })
  return r.action === 'deny' ? deny(r.reason) : r.context
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
  const cls = write ? await step('classify', { kind: 'other', paths: [] } as ReturnType<typeof classifyTool>, () => classifyTool(H, tool, input, cwd)) : undefined
  // What only Claude Code's tools do: plan capture, open work, skill loads and the spool entry.
  if (write) {
    if (!sub) entries.push({ ts: now, ev: 'tool', tool, kind: tool === 'Write' ? 'write' : 'edit', paths: cls?.paths ?? [] })
  } else if (tool !== 'AskUserQuestion') {
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
  const r = await postTool({
    sessionId: sid, cwd, now, subagent: sub, entries,
    answered: tool === 'AskUserQuestion' && !sub && !failed(response) && questionAnswered(response),
    ...(cls !== undefined ? { edit: { ok: !failed(response), paths: cls.paths, added: addedText(tool, input, cls.paths), removed: () => removedText(tool, input, cls.paths) } } : {}),
    ...(tool.startsWith(PLUGIN_MCP_PREFIX) ? { mcp: { server: () => mcpServer(tool, input, cwd, ctx, d), ok: true } } : {}),
  }, { ...pipelineDeps(ctx, d), fileChecks: { now: d.now, run: d.run }, editBudgetMs: POST_EDIT_BUDGET_MS })
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
  await step('H24 MCP result', undefined, () => { recordMcpResult(pipelineDeps(ctx, d), sid, mcpServer(tool, input, str(p['cwd']) ?? '', ctx, d), false) })
  return QUIET
}
