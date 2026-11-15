import type { ToolCall } from '../../core/events'
import { classifyTool } from '../../core/events'
import { backgroundWait } from '../../core/plan/background'
import { isUserText } from '../../core/policy/intents'
import type { AdapterContext } from '../registry'
import {
  afterTool, claudeShapedChanges, commandDeps, guardTool, knownServers, promptContext, runFrame, sharedSkillsDir, startContext, stopReason,
  type FrameSpec,
} from '../shared/command-host/index'
import { blockOut, contextOut, denyOut, isObj, QUIET, str, type HookOutcome } from '../shared/claude-dialect'
import {
  preCompact, recordMcpResult, sessionEnd, spool, workspaceStart, type PipelineDeps,
} from '../shared/pipeline/index'

const H = 'qwen' as const

const isSubagent = (p: Record<string, unknown>): boolean => str(p['agent_id']) !== undefined

export async function handleQwenHook(event: string, stdin: string, ctx: AdapterContext): Promise<HookOutcome> {
  const d = commandDeps(H, H, ctx)
  const spec: FrameSpec = {
    harness: H, label: H, quiet: QUIET, sessionIdOf: p => p['session_id'], cwdOf: p => str(p['cwd']) ?? process.cwd(),
    // The memory runner's own `qwen -p` child must neither load context nor be recorded.
    runnerSkips: ['SessionStart', 'UserPromptSubmit'],
    guards: (p, sid, now) => preToolUse(d, p, sid, now, true),
    event: (ev, p, sid, cwd, now) => run(d, ev, p, sid, cwd, now),
  }
  return runFrame(spec, event, stdin)
}

async function run(d: PipelineDeps, event: string, p: Record<string, unknown>, sid: string, cwd: string, now: number): Promise<HookOutcome> {
  switch (event) {
    case 'SessionStart': {
      const model = str(p['model'])
      return contextOut('SessionStart', await startContext(d, { sid, cwd, source: str(p['source']) ?? 'startup', now, ...(model !== undefined ? { model } : {}) }))
    }
    case 'SubagentStart': return contextOut('SubagentStart', [await d.step('H21 workspace (subagent)', '', () => workspaceStart({ sessionId: sid, cwd, subagent: true, now }, d))])
    case 'UserPromptSubmit': {
      // Qwen Code also runs this event for the tool results it sends back; `submitted_prompt` marks what the user typed.
      const submitted = str(p['submitted_prompt'])
      const text = submitted ?? str(p['prompt']) ?? ''
      return contextOut('UserPromptSubmit', await promptContext(d, { sid, cwd, text, userText: submitted !== undefined || isUserText(text), now, skillsDir: sharedSkillsDir(d.ctx), readOnly: p['permission_mode'] === 'plan' }))
    }
    case 'PreToolUse': return preToolUse(d, p, sid, now, false)
    case 'PostToolUse': return postToolUse(d, p, sid, cwd, now)
    case 'PostToolUseFailure': return postToolUseFailure(d, p, sid, cwd)
    case 'PreCompact': return d.step('PreCompact', QUIET, async () => { await preCompact({ harness: H, sessionId: sid, cwd, now, ...(str(p['trigger']) !== undefined ? { trigger: str(p['trigger']) as string } : {}) }, { ...d, openTodos: () => [] }); return QUIET })
    case 'PostCompact': {
      const summary = str(p['compact_summary'])
      if (summary !== undefined) await spool(d, sid, [{ ts: now, ev: 'compact', excerpt: summary }])
      return QUIET
    }
    case 'Stop': {
      const last = str(p['last_assistant_message'])
      const reason = await stopReason(d, { sid, cwd, now, hookActive: p['stop_hook_active'] === true, backgroundWait: backgroundWait(last, p['background_tasks'], p['crons']), readOnly: p['permission_mode'] === 'plan', spoolTurn: last !== undefined, ...(last !== undefined ? { lastMessage: last } : {}) })
      return reason !== undefined ? blockOut(reason) : QUIET
    }
    case 'SessionEnd': await sessionEnd({ harness: H, sessionId: sid, now }, d); return QUIET
    default: return QUIET
  }
}

async function preToolUse(d: PipelineDeps, p: Record<string, unknown>, sid: string, now: number, guardsOnly: boolean): Promise<HookOutcome> {
  const tool = str(p['tool_name']) ?? ''
  const input = isObj(p['tool_input']) ? p['tool_input'] : {}
  const cwd = str(p['cwd']) ?? ''
  const cls = classifyTool(H, tool, input, cwd, knownServers(d.ctx, H))
  if (guardsOnly && cls.kind === 'other') return QUIET
  const call: ToolCall = { harness: H, sessionId: sid, cwd, tool, input, ...cls }
  if (call.kind === 'bash' && call.command === undefined) return QUIET
  const r = await guardTool(d, { call, now, subagent: isSubagent(p), guardsOnly, changes: claudeShapedChanges })
  if (r.action === 'deny') return denyOut(r.reason)
  const text = r.context.filter(l => l.trim() !== '').join('\n')
  // Qwen Code asks for a decision with the context: `allow` leaves its own permission checks as they are.
  return text === '' ? QUIET : { stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: 'Buracle', additionalContext: text } }) + '\n', exitCode: 0 }
}

async function postToolUse(d: PipelineDeps, p: Record<string, unknown>, sid: string, cwd: string, now: number): Promise<HookOutcome> {
  const tool = str(p['tool_name']) ?? ''
  const cls = classifyTool(H, tool, isObj(p['tool_input']) ? p['tool_input'] : {}, cwd, knownServers(d.ctx, H))
  const call: ToolCall = { harness: H, sessionId: sid, cwd, tool, input: {}, ...cls }
  // The tool ran, so the event is a success: Qwen Code sends a failed call to PostToolUseFailure.
  return contextOut('PostToolUse', await afterTool(d, { sid, cwd, now, subagent: isSubagent(p), call, ok: true, ...(cls.kind === 'mcp' && cls.mcp?.server !== undefined ? { mcpServer: cls.mcp.server } : {}) }))
}

async function postToolUseFailure(d: PipelineDeps, p: Record<string, unknown>, sid: string, cwd: string): Promise<HookOutcome> {
  if (p['is_interrupt'] === true) return QUIET
  const tool = str(p['tool_name']) ?? ''
  const cls = classifyTool(H, tool, isObj(p['tool_input']) ? p['tool_input'] : {}, cwd, knownServers(d.ctx, H))
  if (cls.kind === 'mcp') await d.step('H24 MCP result', undefined, () => { recordMcpResult(d, sid, cls.mcp?.server, false) })
  return QUIET
}
