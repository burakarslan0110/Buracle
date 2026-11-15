import { join } from 'node:path'
import * as core from '../../../core/index'
import type { Harness, StopInput, ToolCall } from '../../../core/events'
import { catalogMcp } from '../../../core/catalog'
import { mcpUnavailable } from '../../../core/policy/routing'
import { indexSettings } from '../../../core/workspace'
import { log } from '../../../engine/log'
import { isValidSessionId } from '../../../engine/paths'
import { loadLedger } from '../../../workflow/ledger'
import { refreshWorkspaceInfo } from '../../../workflow/workspace'
import type { AdapterContext } from '../../registry'
import { parsePayload, QUIET, type HookOutcome } from '../claude-dialect'
import {
  mcpHealth, postTool, preTool, prompt as promptEvent, readWorkspace, sessionStart, spool, stop as stopEvent,
  type MemoryFns, type PipelineDeps, type WorkspaceReaders,
} from '../pipeline/index'
import { projectDeps } from '../project-deps'
import { availableServers, capabilityCardText, promptRouting } from '../routing'
import { uiSessionHooks } from '../ui-session'
import { claudeChanges, guardedContents, type FileChange } from '../write-content'

// The host layer of the command-hook harnesses: the dependency object the shared pipeline wants, and the event frames
// Qwen Code and AGY CLI both run (decode the payload, call the pipeline, hand the result back to the adapter's codec).

/** The edit budget a PostToolUse file check may use before the host gives up on it. */
export const EDIT_BUDGET_MS = 28_000

/** How the session's workspace is read, with the index settings of the config; one copy for every command hook. */
export const workspaceReaders: Required<WorkspaceReaders> = {
  async prepareWorkspace(cwd, ctx, nowMs) { return (await import('../workspace-start')).prepareWorkspace(cwd, indexSettings(ctx.config), nowMs) },
  async workspaceInfo(cwd, ctx, nowMs) { return (await import('../../../workflow/workspace')).workspaceInfo(cwd, indexSettings(ctx.config), nowMs) },
  refreshWorkspace: (info, ctx, nowMs) => refreshWorkspaceInfo(info, indexSettings(ctx.config), nowMs),
}

/** What the model hears, once, at the start of its next reply, when the profile check found something wrong. */
export const profileNote = (finding: string): string =>
  `Buracle setup warning. Tell the user at the start of your next reply, in one short line, then carry on with their request:\n- ${finding}`

const MEMORY: Readonly<Record<keyof MemoryFns, () => Promise<unknown>>> = {
  appendSpool: () => import('../../../memory/spool'), spawnFinalizer: () => import('../../../memory/finalize'), sessionStart: () => import('../../../memory/finalize'),
  promptSeen: () => import('../../../memory/finalize'), contextText: () => import('../../../memory/context'), writeHandoff: () => import('../../../memory/handoff'),
  latestHandoff: () => import('../../../memory/handoff'),
}

/** The memory layer's entry points, imported on first use; one that cannot load is logged at debug level and left out. */
export function lazyMemory(label: string): PipelineDeps['memory'] {
  return async name => {
    try {
      const fn = ((await MEMORY[name]()) as Record<string, unknown>)[name]
      return (typeof fn === 'function' ? fn : undefined) as MemoryFns[typeof name] | undefined
    } catch (e) {
      log('debug', `${label} hook: optional module for memory ${name} is not available`, { error: e })
      return undefined
    }
  }
}

/** The step runner of a command hook: a failed step is logged under the host's label and answers its fallback. */
export function hookStep(label: string): PipelineDeps['step'] {
  return async (what, fallback, fn) => {
    try { return await fn() } catch (e) { log('warn', `${label} hook: ${what} failed`, { error: e }); return fallback }
  }
}

/** The default dependency object of a command hook that reads the process environment. */
export function commandDeps(harness: Harness, label: string, ctx: AdapterContext): PipelineDeps {
  return { harness, ctx, core, ui: uiSessionHooks, step: hookStep(label), env: process.env, hostEnv: process.env, workspace: workspaceReaders, memory: lazyMemory(label) }
}

export const knownServers = (ctx: AdapterContext, h: Harness): string[] => catalogMcp(ctx.canonical.mcp, h).map(m => m.id)

// ---- The frame: one payload in, one outcome out ------------------------------------------------------------------------

export interface FrameSpec {
  harness: Harness
  /** The host's name in the log. */
  label: string
  /** The answer that adds and changes nothing. */
  quiet: HookOutcome
  /** The payload's session id, whatever its type. */
  sessionIdOf(p: Record<string, unknown>): unknown
  /** The payload's working folder; the process's own when it names none. */
  cwdOf(p: Record<string, unknown>): string
  /** The events the memory runner's own child must neither load context for nor be recorded by. */
  runnerSkips: readonly string[]
  /** The PreToolUse guards alone, on a fixed session id (the payload's id cannot name a folder). */
  guards(p: Record<string, unknown>, sid: string, now: number): Promise<HookOutcome>
  /** One event with a usable session. */
  event(event: string, p: Record<string, unknown>, sid: string, cwd: string, now: number): Promise<HookOutcome>
}

/** Fixed session id of the guard-only path, shared by every host. */
export const NO_SESSION_ID = 'buracle-no-session'

export async function runFrame(spec: FrameSpec, event: string, stdin: string): Promise<HookOutcome> {
  const p = parsePayload(stdin)
  if (p === undefined) { log('warn', `${spec.label} hook: stdin is not a JSON object`, { event }); return QUIET }
  const sid = spec.sessionIdOf(p)
  const now = Date.now()
  // A session id the engine cannot use as a folder name: only the guards run, on a fixed id of their own.
  if (!isValidSessionId(sid)) return event === 'PreToolUse' ? spec.guards(p, NO_SESSION_ID, now) : QUIET
  if (process.env['BURACLE_MEMORY_RUNNER'] === '1' && spec.runnerSkips.includes(event)) return spec.quiet
  return spec.event(event, p, sid, spec.cwdOf(p), now)
}

// ---- The events both hosts run the same way ----------------------------------------------------------------------------

export async function startContext(d: PipelineDeps, a: { sid: string, cwd: string, source: string, model?: string, now: number }): Promise<string[]> {
  const { harness: h, ctx } = d
  const r = await sessionStart({ harness: h, sessionId: a.sid, cwd: a.cwd, source: a.source, subagent: false, now: a.now, ...(a.model !== undefined ? { model: a.model } : {}) }, {
    ...d,
    capabilityCard: () => capabilityCardText(ctx, h, mcpHealth(ctx, h, a.now, { sid: a.sid })),
    profileNote,
  })
  return r.context
}

export async function promptContext(
  d: PipelineDeps, a: { sid: string, cwd: string, text: string, userText: boolean, now: number, skillsDir: string, readOnly: boolean },
): Promise<string[]> {
  const { harness: h, ctx } = d
  const r = await promptEvent({ harness: h, sessionId: a.sid, cwd: a.cwd, text: a.text, userText: a.userText, now: a.now }, {
    ...d,
    routePrompt: async () => {
      const health = mcpHealth(ctx, h, a.now, { sid: a.sid })
      const root = readWorkspace(ctx, h, a.sid)?.root
      const found = root !== undefined ? projectDeps(root) : []
      return promptRouting(ctx, h, a.text, { ledger: loadLedger(h, a.sid), available: availableServers(ctx, h, health), ...(found.length > 0 ? { deps: found } : {}), skillsDir: a.skillsDir })
    },
    readOnly: () => a.readOnly,
    contextWarning: () => undefined,
  })
  return r.context
}

/** The shared PreToolUse step: the guards, and for an allowed call the context lines the host adds. */
export async function guardTool(
  d: PipelineDeps, a: { call: ToolCall, now: number, subagent: boolean, guardsOnly: boolean, changes(c: ToolCall): FileChange[] },
): Promise<{ action: 'deny', reason: string } | { action: 'allow', context: string[] }> {
  const { call } = a
  const write = call.kind === 'edit' || call.kind === 'write'
  const known = knownServers(d.ctx, d.harness)
  const r = await preTool({ call, now: a.now, subagent: a.subagent, guardsOnly: a.guardsOnly, usage: true, ...(write ? { edits: call.paths } : {}) }, {
    ...d,
    writeTargets: c => (write ? { paths: c.paths, contents: guard => guardedContents(a.changes(c), c.paths, guard.home, guard.realpath !== undefined ? { realpath: guard.realpath } : {}) } : undefined),
    nativeOff: () => [],
    usage: (c, health) => ({ call: c, ledgerId: call.sessionId, available: known.filter(id => !mcpUnavailable(health[id])) }),
  })
  return r.action === 'deny' ? { action: 'deny', reason: r.reason } : { action: 'allow', context: r.context }
}

/** The file changes of a Claude-shaped Write or Edit call. */
export function claudeShapedChanges(c: ToolCall): FileChange[] {
  return claudeChanges(c.kind === 'write' ? 'Write' : 'Edit', c.input, c.paths)
}

/** The shared PostToolUse step: the file checks run on the edits a finished call made, with the host's own success flag. */
export async function afterTool(
  d: PipelineDeps, a: { sid: string, cwd: string, now: number, subagent: boolean, call: ToolCall, ok: boolean, mcpServer?: string },
): Promise<string[]> {
  const { call } = a
  const edit = call.kind === 'edit' || call.kind === 'write'
  const r = await postTool({
    sessionId: a.sid, cwd: a.cwd, now: a.now, subagent: a.subagent, entries: [], answered: call.kind === 'ask_user' && a.ok,
    ...(edit ? { edit: { ok: a.ok, paths: call.paths, added: {}, removed: () => ({}) } } : {}),
    ...(a.mcpServer !== undefined ? { mcp: { server: () => a.mcpServer as string, ok: a.ok } } : {}),
  }, { ...d, fileChecks: { now: () => Date.now(), run: (await import('../../../engine/proc')).run }, editBudgetMs: EDIT_BUDGET_MS })
  return r.context
}

/** The shared Stop step: record the turn, run the stop guard; the block reason, when there is one. */
export async function stopReason(
  d: PipelineDeps, a: { sid: string, cwd: string, now: number, hookActive: boolean, lastMessage?: string, backgroundWait: boolean, readOnly: boolean, spoolTurn: boolean },
): Promise<string | undefined> {
  if (a.spoolTurn) await spool(d, a.sid, [{ ts: a.now, ev: 'turn', ...(a.lastMessage !== undefined ? { excerpt: a.lastMessage } : {}) }])
  const input: StopInput = { harness: d.harness, sessionId: a.sid, cwd: a.cwd, now: a.now, hookActive: a.hookActive, subagent: false }
  if (a.lastMessage !== undefined) input.lastMessage = a.lastMessage
  if (a.backgroundWait) input.backgroundWait = true
  const r = await stopEvent(input, { ...d, readOnly: () => a.readOnly })
  return r.decision.action === 'block' ? r.decision.reason : undefined
}

/** `<agents dir>/skills`, where the shared copy of the skills lives. */
export const sharedSkillsDir = (ctx: AdapterContext): string => join(ctx.paths.agentsDir(), 'skills')

// ---- H25 flow tracking: what starts a workflow's flow record on a command-hook host -----------------------------------

/** A user message that starts with `/<id>` and names a workflow: the id and the rest of its first line as the title. */
export function slashWorkflowOf(text: string, isWorkflow: (id: string) => boolean): { workflow: string, title?: string } | undefined {
  const m = /^\/([a-z][a-z0-9-]{0,39})(?=\s|$)([^\n]*)/.exec(typeof text === 'string' ? text.trim() : '')
  const id = m?.[1]
  if (id === undefined || !isWorkflow(id)) return undefined
  const title = (m?.[2] ?? '').trim().slice(0, 200)
  return title !== '' ? { workflow: id, title } : { workflow: id }
}

/** Starts the flow record of the workflow a user message names (`/<id> …`); true when it started one. */
export async function trackSlashWorkflow(d: PipelineDeps, a: { sid: string, text: string, now: number }): Promise<boolean> {
  const { flowDef } = await import('../../../core/flow/catalog')
  const start = slashWorkflowOf(a.text, id => flowDef(id) !== undefined)
  if (start === undefined) return false
  const { recordFlowStart } = await import('../../../workflow/flow')
  return d.step('H25 flow start', false, () => recordFlowStart(d.harness, a.sid, { ...start, source: 'prompt' }, a.now))
}

/** Starts the flow record of the workflow skill a tool call loads (`skillId` as the host spells it); true when it started one. */
export async function trackSkillLoad(d: PipelineDeps, a: { sid: string, skillId: string | undefined, now: number }): Promise<boolean> {
  if (a.skillId === undefined) return false
  const { workflowOfSkill } = await import('../../../core/flow/catalog')
  const workflow = workflowOfSkill(`buracle:${a.skillId.replace(/^buracle:/, '')}`)
  if (workflow === undefined) return false
  const { recordFlowStart } = await import('../../../workflow/flow')
  return d.step('H25 flow start', false, () => recordFlowStart(d.harness, a.sid, { workflow, source: 'skill' }, a.now))
}
