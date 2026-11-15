import { join } from 'node:path'
import type { ToolCall } from '../../core/events'
import { classifyTool } from '../../core/events'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import type { AdapterContext } from '../registry'
import {
  afterTool, commandDeps, guardTool, knownServers, promptContext, runFrame, startContext, stopReason, type FrameSpec,
} from '../shared/command-host/index'
import { isObj, QUIET, str, out, type HookOutcome } from '../shared/claude-dialect'
import { claudeChanges, type FileChange } from '../shared/write-content'
import { clipBytes, CONTEXT_BUDGET_BYTES, fitParts, type PipelineDeps } from '../shared/pipeline/index'

const H = 'agy' as const
/** What a PostToolUse or PreToolUse note may keep waiting for the next model call. */
const PENDING_MAX = 6

// ---- The AGY dialect: camelCase payloads, and answers that are not Claude Code's -------------------------------------

/** Context for the model: AGY takes it as a system message step (SessionStart and PreInvocation only). */
function injectOut(parts: readonly string[]): HookOutcome {
  const text = fitParts(parts, CONTEXT_BUDGET_BYTES).join('\n\n')
  return text === '' ? out({}) : out({ injectSteps: [{ systemMessage: { systemMessage: clipBytes(text, CONTEXT_BUDGET_BYTES) } }] })
}

/** The answer of PreToolUse that stops the call; an allowing call stays silent (`{}`), so AGY's own permission rules decide. */
const denyOut = (reason: string): HookOutcome => out({ decision: 'deny', reason })
const blockOut = (reason: string): HookOutcome => out({ decision: 'continue', reason })

/** A tool argument may arrive JSON-quoted (`"\"npm test\""`). */
function unquote(v: unknown): unknown {
  if (typeof v !== 'string' || v.length < 2 || !v.startsWith('"') || !v.endsWith('"')) return v
  try { return JSON.parse(v) as unknown } catch { return v }
}

/**
 * The call as the shared classifier reads it: AGY's argument names (`CommandLine`, `TargetFile`, ...) renamed to the
 * names it knows. An edit tool the profile does not list but that names a `TargetFile` counts as an edit, and an
 * unclassifiable `mcp…` name is an MCP call of an unknown server, so the MCP write guard looks at its arguments.
 */
function decodeCall(p: Record<string, unknown>, sid: string, ctx: AdapterContext): ToolCall {
  const tc = isObj(p['toolCall']) ? p['toolCall'] : {}
  const tool = str(tc['name']) ?? ''
  const args = isObj(tc['args']) ? tc['args'] : {}
  const arg = (k: string): string | undefined => str(unquote(args[k]))
  const target = arg('TargetFile') ?? arg('AbsolutePath') ?? arg('Path')
  const input: Record<string, unknown> = { ...args }
  const command = arg('CommandLine')
  if (command !== undefined) input['command'] = command
  if (target !== undefined) input['file_path'] = target
  const cwd = (tool === 'run_command' ? arg('Cwd') : undefined) ?? str(p['cwd']) ?? str((p['workspacePaths'] as unknown[] | undefined)?.[0]) ?? ''
  const servers = knownServers(ctx, H)
  let cls = classifyTool(H, tool, input, cwd, servers)
  if (cls.kind === 'other' && target !== undefined && arg('CodeContent') !== undefined) cls = classifyTool(H, 'write_to_file', input, cwd, servers)
  else if (cls.kind === 'other' && target !== undefined && (arg('TargetContent') !== undefined || args['ReplacementChunks'] !== undefined)) cls = classifyTool(H, 'replace_file_content', input, cwd, servers)
  else if (cls.kind === 'other' && /^mcp/i.test(tool)) cls = { kind: 'mcp', paths: [], mcp: { server: arg('ServerName') ?? arg('serverName') ?? 'unclassified', tool: arg('ToolName') ?? tool } }
  return { harness: H, sessionId: sid, cwd, tool, input, ...cls }
}

/** The text each file gets, as far as the call shows it, in the shape the write guard reads. */
function changesOf(c: ToolCall): FileChange[] {
  const a = (k: string): unknown => unquote(c.input[k])
  if (c.tool === 'write_to_file') return claudeChanges('Write', { content: a('CodeContent') }, c.paths)
  if (c.tool === 'multi_replace_file_content' && Array.isArray(a('ReplacementChunks'))) {
    const edits = (a('ReplacementChunks') as unknown[]).map(e => { const o = isObj(e) ? e : {}; return { old_string: o['TargetContent'], new_string: o['ReplacementContent'] } })
    return claudeChanges('MultiEdit', { edits }, c.paths)
  }
  if (c.tool === 'replace_file_content') return claudeChanges('Edit', { old_string: a('TargetContent'), new_string: a('ReplacementContent') }, c.paths)
  return []
}

// ---- State that outlives one hook call: the last user message, and notes that wait for the next model call ------------

interface TurnState { prompt?: string, pending: string[] }

const stateFile = (ctx: AdapterContext, sid: string): string => join(ctx.paths.sessionDir(H, sid), 'agy-turn.json')

function readTurn(ctx: AdapterContext, sid: string): TurnState {
  const r = readJsonSafeSync<unknown>(stateFile(ctx, sid))
  const v = r.ok && isObj(r.value) ? r.value : {}
  return { ...(typeof v['prompt'] === 'string' ? { prompt: v['prompt'] } : {}), pending: Array.isArray(v['pending']) ? v['pending'].filter((x): x is string => typeof x === 'string') : [] }
}

function writeTurn(ctx: AdapterContext, sid: string, s: TurnState): void {
  ensureDirSync(ctx.paths.sessionDir(H, sid))
  atomicWriteSync(stateFile(ctx, sid), JSON.stringify(s) + '\n')
}

/** AGY cannot add context at PreToolUse or PostToolUse: the notes wait, once, for the next PreInvocation (which follows every tool result). */
function later(ctx: AdapterContext, sid: string, notes: readonly string[]): void {
  const keep = notes.map(n => n.trim()).filter(n => n !== '')
  if (keep.length === 0) return
  const s = readTurn(ctx, sid)
  writeTurn(ctx, sid, { ...s, pending: [...s.pending, ...keep].slice(-PENDING_MAX) })
}

// ---- The events -------------------------------------------------------------------------------------------------------

const wsPath = (p: Record<string, unknown>): string | undefined => str((p['workspacePaths'] as unknown[] | undefined)?.[0])

export async function handleAgyHook(event: string, stdin: string, ctx: AdapterContext): Promise<HookOutcome> {
  const d = commandDeps(H, H, ctx)
  const spec: FrameSpec = {
    harness: H, label: H, quiet: out({}), sessionIdOf: p => p['conversationId'], cwdOf: p => str(p['cwd']) ?? wsPath(p) ?? process.cwd(),
    // The memory runner's own child gets an empty answer at the two events that load context.
    runnerSkips: ['SessionStart', 'PreInvocation'],
    guards: (p, sid) => preToolUse(d, p, sid, true),
    event: (ev, p, sid, cwd, now) => run(d, ev, p, sid, cwd, now),
  }
  return runFrame(spec, event, stdin)
}

async function run(d: PipelineDeps, event: string, p: Record<string, unknown>, sid: string, cwd: string, now: number): Promise<HookOutcome> {
  switch (event) {
    case 'SessionStart': {
      const model = str(p['modelName'])
      return injectOut(await startContext(d, { sid, cwd, source: 'startup', now, ...(model !== undefined ? { model } : {}) }))
    }
    case 'PreInvocation': return preInvocation(d, p, sid, cwd, now)
    case 'PreToolUse': return preToolUse(d, p, sid, false)
    case 'PostToolUse': return postToolUse(d, p, sid, cwd, now)
    case 'Stop': return stopHook(d, p, sid, cwd, now)
    default: return QUIET
  }
}

/**
 * PreInvocation fires before every model call, and AGY's payload does not say whether the call answers the user or a
 * tool result: `lastUserInput` is the user's latest message in both. The prompt step runs when that message differs
 * from the one this conversation last saw, so a message sent twice in a row is the one case it misses. Notes left by
 * the tool events go out once, with the first model call after them.
 */
async function preInvocation(d: PipelineDeps, p: Record<string, unknown>, sid: string, cwd: string, now: number): Promise<HookOutcome> {
  const text = str(p['lastUserInput']) ?? ''
  const state = readTurn(d.ctx, sid)
  const parts: string[] = []
  if (text !== '' && text !== state.prompt) {
    parts.push(...await promptContext(d, { sid, cwd, text, userText: true, now, skillsDir: join(d.ctx.paths.harnessConfigDir(H), 'skills'), readOnly: false }))
  }
  parts.push(...state.pending)
  if (text !== state.prompt || state.pending.length > 0) writeTurn(d.ctx, sid, { ...(text !== '' ? { prompt: text } : {}), pending: [] })
  return injectOut(parts)
}

async function preToolUse(d: PipelineDeps, p: Record<string, unknown>, sid: string, guardsOnly: boolean): Promise<HookOutcome> {
  const call = decodeCall(p, sid, d.ctx)
  if (guardsOnly && call.kind === 'other') return out({})
  if (call.kind === 'bash' && call.command === undefined) return out({})
  const r = await guardTool(d, { call, now: Date.now(), subagent: false, guardsOnly, changes: changesOf })
  if (r.action === 'deny') return denyOut(r.reason)
  later(d.ctx, sid, r.context)
  return out({})
}

async function postToolUse(d: PipelineDeps, p: Record<string, unknown>, sid: string, cwd: string, now: number): Promise<HookOutcome> {
  const call = decodeCall(p, sid, d.ctx)
  const server = call.kind === 'mcp' ? call.mcp?.server : undefined
  const context = await afterTool(d, { sid, cwd, now, subagent: false, call, ok: str(p['error']) === undefined, ...(server !== undefined && server !== 'unclassified' ? { mcpServer: server } : {}) })
  later(d.ctx, sid, context)
  return out({})
}

/**
 * Stop fires at the end of every turn. The guard runs for a normal end (`NO_TOOL_CALL`) only: a cancelled or failed
 * turn is not one the model may be pushed to continue. AGY sends no assistant text, so the turn is recorded without it.
 */
async function stopHook(d: PipelineDeps, p: Record<string, unknown>, sid: string, cwd: string, now: number): Promise<HookOutcome> {
  const reason = str(p['terminationReason'])
  if (reason !== undefined && reason !== 'NO_TOOL_CALL') return out({})
  const why = await stopReason(d, { sid, cwd, now, hookActive: p['continuationActive'] === true, backgroundWait: p['fullyIdle'] === false, readOnly: false, spoolTurn: true })
  return why !== undefined ? blockOut(why) : out({})
}
