import { join } from 'node:path'
import * as core from '../../core/index'
import type { StopInput, ToolCall } from '../../core/events'
import { classifyTool } from '../../core/events'
import { backgroundWait } from '../../core/plan/background'
import { catalogMcp } from '../../core/catalog'
import { isUserText } from '../../core/policy/intents'
import { mcpUnavailable } from '../../core/policy/routing'
import { indexSettings } from '../../core/workspace'
import { log } from '../../engine/log'
import { isValidSessionId } from '../../engine/paths'
import { loadLedger } from '../../workflow/ledger'
import { refreshWorkspaceInfo } from '../../workflow/workspace'
import type { AdapterContext } from '../registry'
import { blockOut, contextOut, denyOut, isObj, parsePayload, QUIET, str, type HookOutcome } from '../shared/claude-dialect'
import { projectDeps } from '../shared/project-deps'
import { guardedContents, claudeChanges } from '../shared/write-content'
import { uiSessionHooks } from '../shared/ui-session'
import {
  mcpHealth, postTool, preCompact, preTool, prompt as promptEvent, readWorkspace, recordMcpResult, sessionEnd, sessionStart, spool, stop as stopEvent, workspaceStart,
  type MemoryFns, type PipelineDeps,
} from '../shared/pipeline/index'
import { availableServers, capabilityCardText, promptRouting } from '../shared/routing'

const H = 'qwen' as const
const EDIT_BUDGET_MS = 28_000

async function step<T>(what: string, fallback: T, fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) { log('warn', `qwen hook: ${what} failed`, { error: e }); return fallback }
}

const MEMORY: Readonly<Record<keyof MemoryFns, () => Promise<unknown>>> = {
  appendSpool: () => import('../../memory/spool'), spawnFinalizer: () => import('../../memory/finalize'), sessionStart: () => import('../../memory/finalize'),
  promptSeen: () => import('../../memory/finalize'), contextText: () => import('../../memory/context'), writeHandoff: () => import('../../memory/handoff'),
  latestHandoff: () => import('../../memory/handoff'),
}

/** What the shared pipeline needs from Qwen Code: the step log, the lazily imported memory modules and the workspace lookups. */
function deps(ctx: AdapterContext): PipelineDeps {
  return {
    harness: H, ctx, core, ui: uiSessionHooks, step, env: process.env, hostEnv: process.env,
    workspace: {
      async prepareWorkspace(cwd, c, nowMs) { return (await import('../shared/workspace-start')).prepareWorkspace(cwd, indexSettings(c.config), nowMs) },
      async workspaceInfo(cwd, c, nowMs) { return (await import('../../workflow/workspace')).workspaceInfo(cwd, indexSettings(c.config), nowMs) },
      refreshWorkspace: (info, c, nowMs) => refreshWorkspaceInfo(info, indexSettings(c.config), nowMs),
    },
    async memory(name) {
      try {
        const fn = ((await MEMORY[name]()) as Record<string, unknown>)[name]
        return (typeof fn === 'function' ? fn : undefined) as MemoryFns[typeof name] | undefined
      } catch (e) {
        log('debug', `qwen hook: optional module for memory ${name} is not available`, { error: e })
        return undefined
      }
    },
  }
}

const isSubagent = (p: Record<string, unknown>): boolean => str(p['agent_id']) !== undefined

export async function handleQwenHook(event: string, stdin: string, ctx: AdapterContext): Promise<HookOutcome> {
  const p = parsePayload(stdin)
  if (p === undefined) { log('warn', 'qwen hook: stdin is not a JSON object', { event }); return QUIET }
  const sid = p['session_id']
  const now = Date.now()
  // A session id the engine cannot use as a folder name: only the guards run, on a fixed id of their own.
  if (!isValidSessionId(sid)) return event === 'PreToolUse' ? preToolUse(p, 'buracle-no-session', ctx, now, true) : QUIET
  // The memory runner's own `qwen -p` child must neither load context nor be recorded.
  if (process.env['BURACLE_MEMORY_RUNNER'] === '1' && (event === 'SessionStart' || event === 'UserPromptSubmit')) return QUIET
  const cwd = str(p['cwd']) ?? process.cwd()
  switch (event) {
    case 'SessionStart': return sessionStartHook(p, sid, cwd, ctx, now)
    case 'SubagentStart': return contextOut('SubagentStart', [await step('H21 workspace (subagent)', '', () => workspaceStart({ sessionId: sid, cwd, subagent: true, now }, deps(ctx)))])
    case 'UserPromptSubmit': return userPromptSubmit(p, sid, cwd, ctx, now)
    case 'PreToolUse': return preToolUse(p, sid, ctx, now, false)
    case 'PostToolUse': return postToolUse(p, sid, cwd, ctx, now)
    case 'PostToolUseFailure': return postToolUseFailure(p, sid, cwd, ctx)
    case 'PreCompact': return step('PreCompact', QUIET, async () => { await preCompact({ harness: H, sessionId: sid, cwd, now, ...(str(p['trigger']) !== undefined ? { trigger: str(p['trigger']) as string } : {}) }, { ...deps(ctx), openTodos: () => [] }); return QUIET })
    case 'PostCompact': {
      const summary = str(p['compact_summary'])
      if (summary !== undefined) await spool(deps(ctx), sid, [{ ts: now, ev: 'compact', excerpt: summary }])
      return QUIET
    }
    case 'Stop': return stopHook(p, sid, cwd, ctx, now)
    case 'SessionEnd': await sessionEnd({ harness: H, sessionId: sid, now }, deps(ctx)); return QUIET
    default: return QUIET
  }
}

async function sessionStartHook(p: Record<string, unknown>, sid: string, cwd: string, ctx: AdapterContext, now: number): Promise<HookOutcome> {
  const source = str(p['source']) ?? 'startup'
  const model = str(p['model'])
  const r = await sessionStart({ harness: H, sessionId: sid, cwd, source, subagent: false, now, ...(model !== undefined ? { model } : {}) }, {
    ...deps(ctx),
    capabilityCard: () => capabilityCardText(ctx, H, mcpHealth(ctx, H, now, { sid })),
    profileNote: finding => `Buracle setup warning. Tell the user at the start of your next reply, in one short line, then carry on with their request:\n- ${finding}`,
  })
  return contextOut('SessionStart', r.context)
}

async function userPromptSubmit(p: Record<string, unknown>, sid: string, cwd: string, ctx: AdapterContext, now: number): Promise<HookOutcome> {
  // Qwen Code also runs this event for the tool results it sends back; `submitted_prompt` marks what the user typed.
  const submitted = str(p['submitted_prompt'])
  const text = submitted ?? str(p['prompt']) ?? ''
  const r = await promptEvent({ harness: H, sessionId: sid, cwd, text, userText: submitted !== undefined || isUserText(text), now }, {
    ...deps(ctx),
    routePrompt: async () => {
      const health = mcpHealth(ctx, H, now, { sid })
      const root = readWorkspace(ctx, H, sid)?.root
      const found = root !== undefined ? projectDeps(root) : []
      return promptRouting(ctx, H, text, { ledger: loadLedger(H, sid), available: availableServers(ctx, H, health), ...(found.length > 0 ? { deps: found } : {}), skillsDir: join(ctx.paths.agentsDir(), 'skills') })
    },
    readOnly: () => p['permission_mode'] === 'plan',
    contextWarning: () => undefined,
  })
  return contextOut('UserPromptSubmit', r.context)
}

const knownServers = (ctx: AdapterContext): string[] => catalogMcp(ctx.canonical.mcp, H).map(m => m.id)

async function preToolUse(p: Record<string, unknown>, sid: string, ctx: AdapterContext, now: number, guardsOnly: boolean): Promise<HookOutcome> {
  const tool = str(p['tool_name']) ?? ''
  const input = isObj(p['tool_input']) ? p['tool_input'] : {}
  const cwd = str(p['cwd']) ?? ''
  const cls = classifyTool(H, tool, input, cwd, knownServers(ctx))
  if (guardsOnly && cls.kind === 'other') return QUIET
  const call: ToolCall = { harness: H, sessionId: sid, cwd, tool, input, ...cls }
  if (call.kind === 'bash' && call.command === undefined) return QUIET
  const write = call.kind === 'edit' || call.kind === 'write'
  const r = await preTool({ call, now, subagent: isSubagent(p), guardsOnly, usage: true, ...(write ? { edits: call.paths } : {}) }, {
    ...deps(ctx),
    writeTargets: c => (write ? { paths: c.paths, contents: guard => guardedContents(claudeChanges(c.kind === 'write' ? 'Write' : 'Edit', c.input, c.paths), c.paths, guard.home, guard.realpath !== undefined ? { realpath: guard.realpath } : {}) } : undefined),
    nativeOff: () => [],
    usage: (c, health) => ({ call: c, ledgerId: sid, available: knownServers(ctx).filter(id => !mcpUnavailable(health[id])) }),
  })
  if (r.action === 'deny') return denyOut(r.reason)
  const text = r.context.filter(l => l.trim() !== '').join('\n')
  // Qwen Code asks for a decision with the context: `allow` leaves its own permission checks as they are.
  return text === '' ? QUIET : { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Buracle', additionalContext: text } }) + '\n', exitCode: 0 }
}

async function postToolUse(p: Record<string, unknown>, sid: string, cwd: string, ctx: AdapterContext, now: number): Promise<HookOutcome> {
  const tool = str(p['tool_name']) ?? ''
  const input = isObj(p['tool_input']) ? p['tool_input'] : {}
  const cls = classifyTool(H, tool, input, cwd, knownServers(ctx))
  const edit = cls.kind === 'edit' || cls.kind === 'write'
  const server = cls.kind === 'mcp' ? cls.mcp?.server : undefined
  // The tool ran, so the event is a success: Qwen Code sends a failed call to PostToolUseFailure.
  const r = await postTool({
    sessionId: sid, cwd, now, subagent: isSubagent(p), entries: [], answered: cls.kind === 'ask_user',
    ...(edit ? { edit: { ok: true, paths: cls.paths, added: {}, removed: () => ({}) } } : {}),
    ...(server !== undefined ? { mcp: { server: () => server, ok: true } } : {}),
  }, { ...deps(ctx), fileChecks: { now: () => Date.now(), run: (await import('../../engine/proc')).run }, editBudgetMs: EDIT_BUDGET_MS })
  return contextOut('PostToolUse', r.context)
}

async function postToolUseFailure(p: Record<string, unknown>, sid: string, cwd: string, ctx: AdapterContext): Promise<HookOutcome> {
  if (p['is_interrupt'] === true) return QUIET
  const tool = str(p['tool_name']) ?? ''
  const cls = classifyTool(H, tool, isObj(p['tool_input']) ? p['tool_input'] : {}, cwd, knownServers(ctx))
  if (cls.kind === 'mcp') await step('H24 MCP result', undefined, () => { recordMcpResult(deps(ctx), sid, cls.mcp?.server, false) })
  return QUIET
}

async function stopHook(p: Record<string, unknown>, sid: string, cwd: string, ctx: AdapterContext, now: number): Promise<HookOutcome> {
  const last = str(p['last_assistant_message'])
  const d = deps(ctx)
  if (last !== undefined) await spool(d, sid, [{ ts: now, ev: 'turn', excerpt: last }])
  const input: StopInput = { harness: H, sessionId: sid, cwd, now, hookActive: p['stop_hook_active'] === true, subagent: false }
  if (last !== undefined) input.lastMessage = last
  if (backgroundWait(last, p['background_tasks'], p['crons'])) input.backgroundWait = true
  const r = await stopEvent(input, { ...d, readOnly: () => p['permission_mode'] === 'plan' })
  return r.decision.action === 'block' ? blockOut(r.decision.reason) : QUIET
}
