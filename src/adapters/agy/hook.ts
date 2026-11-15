import { join } from 'node:path'
import * as core from '../../core/index'
import type { StopInput, ToolCall } from '../../core/events'
import { classifyTool } from '../../core/events'
import { catalogMcp } from '../../core/catalog'
import { mcpUnavailable } from '../../core/policy/routing'
import { indexSettings } from '../../core/workspace'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../engine/fsx'
import { log } from '../../engine/log'
import { isValidSessionId } from '../../engine/paths'
import { loadLedger } from '../../workflow/ledger'
import { refreshWorkspaceInfo } from '../../workflow/workspace'
import type { AdapterContext } from '../registry'
import { isObj, parsePayload, QUIET, str, out, type HookOutcome } from '../shared/claude-dialect'
import { projectDeps } from '../shared/project-deps'
import { guardedContents, claudeChanges, type FileChange } from '../shared/write-content'
import { uiSessionHooks } from '../shared/ui-session'
import {
  clipBytes, CONTEXT_BUDGET_BYTES, fitParts, mcpHealth, postTool, preTool, prompt as promptEvent, readWorkspace, sessionStart, spool, stop as stopEvent,
  type MemoryFns, type PipelineDeps,
} from '../shared/pipeline/index'
import { availableServers, capabilityCardText, promptRouting } from '../shared/routing'

const H = 'agy' as const
const EDIT_BUDGET_MS = 28_000
/** What a PostToolUse or PreToolUse note may keep waiting for the next model call. */
const PENDING_MAX = 6

async function step<T>(what: string, fallback: T, fn: () => T | Promise<T>): Promise<T> {
  try { return await fn() } catch (e) { log('warn', `agy hook: ${what} failed`, { error: e }); return fallback }
}

const MEMORY: Readonly<Record<keyof MemoryFns, () => Promise<unknown>>> = {
  appendSpool: () => import('../../memory/spool'), spawnFinalizer: () => import('../../memory/finalize'), sessionStart: () => import('../../memory/finalize'),
  promptSeen: () => import('../../memory/finalize'), contextText: () => import('../../memory/context'), writeHandoff: () => import('../../memory/handoff'),
  latestHandoff: () => import('../../memory/handoff'),
}

/** What the shared pipeline needs from AGY CLI: the step log, the lazily imported memory modules and the workspace lookups. */
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
        log('debug', `agy hook: optional module for memory ${name} is not available`, { error: e })
        return undefined
      }
    },
  }
}

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
  const servers = catalogMcp(ctx.canonical.mcp, H).map(m => m.id)
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

export async function handleAgyHook(event: string, stdin: string, ctx: AdapterContext): Promise<HookOutcome> {
  const p = parsePayload(stdin)
  if (p === undefined) { log('warn', 'agy hook: stdin is not a JSON object', { event }); return QUIET }
  const sid = p['conversationId']
  const now = Date.now()
  // A conversation id the engine cannot use as a folder name: only the guards run, on a fixed id of their own.
  if (!isValidSessionId(sid)) return event === 'PreToolUse' ? preToolUse(p, 'buracle-no-session', ctx, now, true) : QUIET
  if (process.env['BURACLE_MEMORY_RUNNER'] === '1' && (event === 'SessionStart' || event === 'PreInvocation')) return out({})
  const cwd = str(p['cwd']) ?? str((p['workspacePaths'] as unknown[] | undefined)?.[0]) ?? process.cwd()
  switch (event) {
    case 'SessionStart': return sessionStartHook(p, sid, cwd, ctx, now)
    case 'PreInvocation': return preInvocation(p, sid, cwd, ctx, now)
    case 'PreToolUse': return preToolUse(p, sid, ctx, now, false)
    case 'PostToolUse': return postToolUse(p, sid, cwd, ctx, now)
    case 'Stop': return stopHook(p, sid, cwd, ctx, now)
    default: return QUIET
  }
}

async function sessionStartHook(p: Record<string, unknown>, sid: string, cwd: string, ctx: AdapterContext, now: number): Promise<HookOutcome> {
  const model = str(p['modelName'])
  const r = await sessionStart({ harness: H, sessionId: sid, cwd, source: 'startup', subagent: false, now, ...(model !== undefined ? { model } : {}) }, {
    ...deps(ctx),
    capabilityCard: () => capabilityCardText(ctx, H, mcpHealth(ctx, H, now, { sid })),
    profileNote: finding => `Buracle setup warning. Tell the user at the start of your next reply, in one short line, then carry on with their request:\n- ${finding}`,
  })
  return injectOut(r.context)
}

/**
 * PreInvocation fires before every model call, and AGY's payload does not say whether the call answers the user or a
 * tool result: `lastUserInput` is the user's latest message in both. The prompt step runs when that message differs
 * from the one this conversation last saw, so a message sent twice in a row is the one case it misses. Notes left by
 * the tool events go out once, with the first model call after them.
 */
async function preInvocation(p: Record<string, unknown>, sid: string, cwd: string, ctx: AdapterContext, now: number): Promise<HookOutcome> {
  const text = str(p['lastUserInput']) ?? ''
  const state = readTurn(ctx, sid)
  const parts: string[] = []
  if (text !== '' && text !== state.prompt) {
    const r = await promptEvent({ harness: H, sessionId: sid, cwd, text, userText: true, now }, {
      ...deps(ctx),
      routePrompt: async () => {
        const health = mcpHealth(ctx, H, now, { sid })
        const root = readWorkspace(ctx, H, sid)?.root
        const found = root !== undefined ? projectDeps(root) : []
        return promptRouting(ctx, H, text, { ledger: loadLedger(H, sid), available: availableServers(ctx, H, health), ...(found.length > 0 ? { deps: found } : {}), skillsDir: join(ctx.paths.harnessConfigDir(H), 'skills') })
      },
      readOnly: () => false,
      contextWarning: () => undefined,
    })
    parts.push(...r.context)
  }
  parts.push(...state.pending)
  if (text !== state.prompt || state.pending.length > 0) writeTurn(ctx, sid, { ...(text !== '' ? { prompt: text } : {}), pending: [] })
  return injectOut(parts)
}

async function preToolUse(p: Record<string, unknown>, sid: string, ctx: AdapterContext, now: number, guardsOnly: boolean): Promise<HookOutcome> {
  const call = decodeCall(p, sid, ctx)
  if (guardsOnly && call.kind === 'other') return out({})
  if (call.kind === 'bash' && call.command === undefined) return out({})
  const write = call.kind === 'edit' || call.kind === 'write'
  const known = catalogMcp(ctx.canonical.mcp, H).map(m => m.id)
  const r = await preTool({ call, now, subagent: false, guardsOnly, usage: true, ...(write ? { edits: call.paths } : {}) }, {
    ...deps(ctx),
    writeTargets: c => (write ? { paths: c.paths, contents: guard => guardedContents(changesOf(c), c.paths, guard.home, guard.realpath !== undefined ? { realpath: guard.realpath } : {}) } : undefined),
    nativeOff: () => [],
    usage: (c, health) => ({ call: c, ledgerId: sid, available: known.filter(id => !mcpUnavailable(health[id])) }),
  })
  if (r.action === 'deny') return denyOut(r.reason)
  later(ctx, sid, r.context)
  return out({})
}

async function postToolUse(p: Record<string, unknown>, sid: string, cwd: string, ctx: AdapterContext, now: number): Promise<HookOutcome> {
  const call = decodeCall(p, sid, ctx)
  const edit = call.kind === 'edit' || call.kind === 'write'
  const server = call.kind === 'mcp' ? call.mcp?.server : undefined
  const ok = str(p['error']) === undefined
  const r = await postTool({
    sessionId: sid, cwd, now, subagent: false, entries: [], answered: call.kind === 'ask_user' && ok,
    ...(edit ? { edit: { ok, paths: call.paths, added: {}, removed: () => ({}) } } : {}),
    ...(server !== undefined && server !== 'unclassified' ? { mcp: { server: () => server, ok } } : {}),
  }, { ...deps(ctx), fileChecks: { now: () => Date.now(), run: (await import('../../engine/proc')).run }, editBudgetMs: EDIT_BUDGET_MS })
  later(ctx, sid, r.context)
  return out({})
}

/**
 * Stop fires at the end of every turn. The guard runs for a normal end (`NO_TOOL_CALL`) only: a cancelled or failed
 * turn is not one the model may be pushed to continue. AGY sends no assistant text, so the turn is recorded without it.
 */
async function stopHook(p: Record<string, unknown>, sid: string, cwd: string, ctx: AdapterContext, now: number): Promise<HookOutcome> {
  const reason = str(p['terminationReason'])
  if (reason !== undefined && reason !== 'NO_TOOL_CALL') return out({})
  const d = deps(ctx)
  await spool(d, sid, [{ ts: now, ev: 'turn' }])
  const input: StopInput = { harness: H, sessionId: sid, cwd, now, hookActive: p['continuationActive'] === true, subagent: false }
  if (p['fullyIdle'] === false) input.backgroundWait = true
  const r = await stopEvent(input, { ...d, readOnly: () => false })
  return r.decision.action === 'block' ? blockOut(r.decision.reason) : out({})
}
