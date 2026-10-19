import type { Harness } from './events'
import { classifyTool, mcpServerToken, resolvePath } from './events'
import { memCaptureOff } from './memory/spool'
import { redactClip } from './memory/text'
import { cmIsUserPrompt } from './context-mode-restore'

export * from './context-mode-restore'

export const CM_SERVER_ID = 'context-mode'

export type CmTool = 'ctx_execute' | 'ctx_execute_file' | 'ctx_batch_execute' | 'ctx_index' | 'ctx_search' | 'ctx_fetch_and_index' | 'ctx_stats' | 'ctx_purge'

export const CM_TOOLS: readonly CmTool[] = ['ctx_execute', 'ctx_execute_file', 'ctx_batch_execute', 'ctx_index', 'ctx_search', 'ctx_fetch_and_index', 'ctx_stats', 'ctx_purge']

export type CmHiddenTool = 'ctx_upgrade' | 'ctx_insight' | 'ctx_doctor'

export const CM_HIDDEN_TOOLS: readonly CmHiddenTool[] = ['ctx_upgrade', 'ctx_insight', 'ctx_doctor']

export type CmExecTool = 'ctx_execute' | 'ctx_execute_file' | 'ctx_batch_execute'

export const CM_EXEC_TOOLS: readonly CmExecTool[] = ['ctx_execute', 'ctx_execute_file', 'ctx_batch_execute']

export const CM_EXEC_INPUT_KEYS: Readonly<Record<CmExecTool, readonly string[]>> = {
  ctx_execute: ['language', 'code', 'timeout', 'background', 'cwd', 'intent'],
  ctx_execute_file: ['path', 'language', 'code', 'timeout', 'intent'],
  ctx_batch_execute: ['commands', 'queries', 'timeout', 'concurrency', 'cwd', 'query_scope'],
}

export const CM_BATCH_COMMAND_KEYS: readonly string[] = ['label', 'command']

export function isCmTool(x: unknown): x is CmTool {
  return typeof x === 'string' && (CM_TOOLS as readonly string[]).includes(x)
}

export function isCmHiddenTool(x: unknown): x is CmHiddenTool {
  return typeof x === 'string' && (CM_HIDDEN_TOOLS as readonly string[]).includes(x)
}

export function isCmExecTool(x: unknown): x is CmExecTool {
  return typeof x === 'string' && (CM_EXEC_TOOLS as readonly string[]).includes(x)
}

export function cmToolName(h: Harness, tool: CmTool | CmHiddenTool): string {
  switch (h) {
    case 'claude': return `mcp__plugin_buracle_${mcpServerToken('claude', CM_SERVER_ID)}__${tool}`
    case 'codex': return `mcp__${mcpServerToken('codex', CM_SERVER_ID)}__${tool}`
    case 'opencode': return `${mcpServerToken('opencode', CM_SERVER_ID)}_${tool}`
    case 'omp': return `mcp__${mcpServerToken('omp', CM_SERVER_ID)}_${tool}`
  }
}

export const CM_CAPTURE_MAX_CHARS = 2000

export const CM_ROW_MAX_CHARS = 4000

export const CM_EVENTS_MAX = 500

export interface CmPromptEvent { kind: 'prompt'; text: string }

export interface CmToolEvent { kind: 'tool'; tool: string; input: Record<string, unknown>; response: string; status: CmToolStatus }
export type CmToolStatus = 'ok' | 'error' | 'unknown'

export type CmEvent = CmPromptEvent | CmToolEvent

export const CM_EXTRACT_TOOLS: readonly string[] = [
  'Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep', 'TodoWrite', 'TaskCreate', 'TaskUpdate',
  'EnterPlanMode', 'ExitPlanMode', 'Skill', 'Agent', 'AskUserQuestion', 'EnterWorktree', 'WebFetch', 'apply_patch',
]

export const CM_CLAUDE_TOOLS: readonly string[] = [
  'Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'TodoWrite', 'TaskCreate', 'TaskUpdate',
  'EnterPlanMode', 'ExitPlanMode', 'Skill', 'Agent', 'AskUserQuestion', 'EnterWorktree',
]

const RESPONSE_TOOLS: ReadonlySet<string> = new Set(['Bash', 'Agent', 'AskUserQuestion', 'ExitPlanMode', 'WebFetch'])

const SHORT_CHARS = 300
const PATH_CHARS = 1000

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined
}

function clean(s: string, max: number): string {
  return redactClip(s, max).text
}

function field(x: unknown, max: number): string | undefined {
  if (typeof x !== 'string') return undefined
  const t = clean(x, max)
  return t.trim() === '' ? undefined : t
}

function defined(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out[k] = v
  return out
}

function json(x: unknown): string {
  try { return JSON.stringify(x) ?? '' } catch { return '' }
}

export function cmPatchHeaders(patch: string): string {
  return patch.split(/\r?\n/).map(l => l.trim())
    .filter(l => /^\*\*\* (?:Begin Patch|End Patch|Add File:|Update File:|Delete File:|Move to:)/.test(l)).join('\n')
}

function todos(x: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(x)) return []
  const out: Array<Record<string, unknown>> = []
  for (const t of x.slice(0, 50)) {
    if (!isRecord(t)) continue
    const content = field(t['content'], SHORT_CHARS) ?? field(t['subject'], SHORT_CHARS)
    if (content === undefined) continue
    out.push(defined({ content, status: field(t['status'], 40) ?? 'pending', activeForm: field(t['activeForm'], SHORT_CHARS) }))
  }
  return out
}

function taskId(x: unknown): string | undefined {
  return field(typeof x === 'number' ? String(x) : x, 40)
}

function questions(x: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(x) ? x : []
  const out: Array<Record<string, unknown>> = []
  for (const q of list.slice(0, 8)) {
    const question = isRecord(q) ? field(q['question'], SHORT_CHARS) : field(q, SHORT_CHARS)
    if (question !== undefined) out.push({ question })
  }
  return out
}

function toolInput(tool: string, raw: Record<string, unknown>): Record<string, unknown> {
  switch (tool) {
    case 'Bash': return defined({ command: field(raw['command'], CM_CAPTURE_MAX_CHARS) })
    case 'Read':
    case 'Write':
    case 'Edit': return defined({ file_path: field(raw['file_path'], PATH_CHARS) })
    case 'NotebookEdit': return defined({ notebook_path: field(raw['notebook_path'], PATH_CHARS) })
    case 'Glob':
    case 'Grep': return defined({ pattern: field(raw['pattern'], SHORT_CHARS), path: field(raw['path'], PATH_CHARS) })
    case 'TodoWrite': return { todos: todos(raw['todos']) }
    case 'TaskCreate': return defined({ subject: field(raw['subject'], SHORT_CHARS), taskId: taskId(raw['taskId']) })
    case 'TaskUpdate': return defined({ taskId: taskId(raw['taskId']), status: field(raw['status'], 40), subject: field(raw['subject'], SHORT_CHARS) })
    case 'ExitPlanMode': {
      const list = Array.isArray(raw['allowedPrompts']) ? raw['allowedPrompts'] : []
      const prompts = list.slice(0, 10).map(p => field(isRecord(p) ? p['prompt'] : p, SHORT_CHARS)).filter((p): p is string => p !== undefined)
      return prompts.length > 0 ? { allowedPrompts: prompts } : {}
    }
    case 'Skill': return defined({ skill: field(raw['skill'], SHORT_CHARS) })
    case 'Agent': return defined({ prompt: field(raw['prompt'], SHORT_CHARS), subagent_type: field(raw['subagent_type'], 80) })
    case 'AskUserQuestion': return { questions: questions(raw['questions']) }
    case 'EnterWorktree': return defined({ name: field(raw['name'], SHORT_CHARS) })
    case 'WebFetch': return defined({ url: field(raw['url'], PATH_CHARS) })
    case 'apply_patch': {
      const patch = str(raw['command'])
      return patch === undefined ? {} : defined({ command: field(cmPatchHeaders(patch), CM_CAPTURE_MAX_CHARS) })
    }
    default: return {}
  }
}

export function cmPromptEvent(text: unknown): CmPromptEvent | undefined {
  if (typeof text !== 'string' || !cmIsUserPrompt(text)) return undefined
  const t = clean(text.trim(), CM_CAPTURE_MAX_CHARS)
  return t.trim() === '' ? undefined : { kind: 'prompt', text: t }
}

export function cmToolEvent(tool: string, input: unknown, response: unknown, status: CmToolStatus): CmToolEvent | undefined {
  const failed = /^failed:(.+)$/.exec(tool)
  const base = failed !== null ? (failed[1] as string) : tool
  const name = base === 'MultiEdit' ? 'Edit' : base
  if (!CM_EXTRACT_TOOLS.includes(name)) return undefined
  const keep = failed !== null || RESPONSE_TOOLS.has(name)
  return {
    kind: 'tool',
    tool: failed !== null ? `failed:${name}` : name,
    input: failed !== null ? {} : toolInput(name, isRecord(input) ? input : {}),
    response: keep && typeof response === 'string' ? clean(response, CM_CAPTURE_MAX_CHARS) : '',
    status: failed !== null ? 'error' : status,
  }
}

function failure(name: string, input: Record<string, unknown>, error: string): CmToolEvent | undefined {
  if (name === 'Bash') return cmToolEvent('Bash', input, error, 'error')
  return cmToolEvent(`failed:${name}`, {}, `${name} error: ${error}`, 'error')
}

function textOf(x: unknown): string {
  if (typeof x === 'string') return x
  if (Array.isArray(x)) return x.map(b => (isRecord(b) && typeof b['text'] === 'string' ? b['text'] : '')).filter(t => t !== '').join('\n')
  return ''
}

function claudeResponse(tool: string, resp: unknown): string {
  if (!RESPONSE_TOOLS.has(tool)) return ''
  if (typeof resp === 'string') return resp
  if (!isRecord(resp)) return ''
  switch (tool) {
    case 'Bash': return [str(resp['stdout']), str(resp['stderr'])].filter((s): s is string => s !== undefined && s.trim() !== '').join('\n')
    case 'Agent': return textOf(resp['content']) || json(resp)
    case 'AskUserQuestion': return json({ answers: isRecord(resp['answers']) ? resp['answers'] : {} })
    default: return json(resp)
  }
}

function createdTaskId(resp: unknown): unknown {
  return isRecord(resp) && isRecord(resp['task']) ? resp['task']['id'] : undefined
}

function errorText(x: unknown): string {
  if (typeof x === 'string') return x
  if (isRecord(x) && typeof x['message'] === 'string') return x['message']
  return x === undefined || x === null ? '' : json(x)
}

export function cmClaudeEvent(event: string, p: Record<string, unknown>): CmEvent | undefined {
  if (typeof p['agent_id'] === 'string' && p['agent_id'] !== '') return undefined
  if (event === 'UserPromptSubmit') return cmPromptEvent(p['prompt'])
  const name = str(p['tool_name'])
  if (name === undefined || !CM_CLAUDE_TOOLS.includes(name)) return undefined
  const input = isRecord(p['tool_input']) ? p['tool_input'] : {}
  if (event === 'PostToolUse') {
    const recorded = name === 'TaskCreate' ? { ...input, taskId: createdTaskId(p['tool_response']) } : input
    return cmToolEvent(name, recorded, claudeResponse(name, p['tool_response']), 'ok')
  }
  if (event === 'PostToolUseFailure') {
    if (p['is_interrupt'] === true) return undefined
    return failure(name === 'MultiEdit' ? 'Edit' : name, input, errorText(p['error']))
  }
  return undefined
}

function codexShell(resp: unknown): { text: string, status: CmToolStatus } {
  if (typeof resp === 'string') return { text: resp, status: 'unknown' }
  if (!isRecord(resp)) return { text: '', status: 'unknown' }
  const text = str(resp['output']) ?? [str(resp['stdout']), str(resp['stderr'])].filter((s): s is string => s !== undefined && s !== '').join('\n')
  const code = resp['exit_code'] ?? resp['exitCode']
  return { text, status: typeof code === 'number' ? (code === 0 ? 'ok' : 'error') : 'unknown' }
}

function patchOf(input: Record<string, unknown>): string | undefined {
  const cmd = input['command']
  if (typeof cmd === 'string') return cmd
  if (Array.isArray(cmd)) {
    const text = cmd.find((c): c is string => typeof c === 'string' && c.includes('*** '))
    if (text !== undefined) return text
  }
  return str(input['patch']) ?? str(input['input'])
}

function planTodos(plan: unknown): Array<{ content: unknown, status: unknown }> {
  return (Array.isArray(plan) ? plan : []).filter(isRecord).map(i => ({ content: i['step'], status: i['status'] }))
}

export function cmCodexEvent(event: string, p: Record<string, unknown>): CmEvent | undefined {
  const present = (x: unknown): boolean => typeof x === 'string' && x !== ''
  if (present(p['agent_id']) || present(p['agent_type'])) return undefined
  if (event === 'UserPromptSubmit') return cmPromptEvent(p['prompt'])
  if (event !== 'PostToolUse') return undefined
  const name = str(p['tool_name'])
  if (name === undefined) return undefined
  const input = isRecord(p['tool_input']) ? p['tool_input'] : {}
  if (name === 'update_plan') return cmToolEvent('TodoWrite', { todos: planTodos(input['plan']) }, '', 'ok')
  const c = classifyTool('codex', name, input, '')
  if (c.kind === 'patch') {
    const patch = patchOf(input)
    return patch === undefined ? undefined : cmToolEvent('apply_patch', { command: patch }, '', 'ok')
  }
  if (c.kind === 'bash' && c.command !== undefined) {
    const r = codexShell(p['tool_response'])
    return cmToolEvent('Bash', { command: c.command }, r.text, r.status)
  }
  return undefined
}

const OPENCODE_TOOLS: Readonly<Record<string, string>> = {
  shell: 'Bash', bash: 'Bash', read: 'Read', edit: 'Edit', multiedit: 'Edit', write: 'Write', patch: 'apply_patch', apply_patch: 'apply_patch',
  grep: 'Grep', glob: 'Glob', list: 'Glob', webfetch: 'WebFetch', subagent: 'Agent', task: 'Agent', todowrite: 'TodoWrite',
  question: 'AskUserQuestion', skill: 'Skill',
}

const OMP_TOOLS: Readonly<Record<string, string>> = {
  bash: 'Bash', read: 'Read', edit: 'Edit', ast_edit: 'Edit', write: 'Write', grep: 'Grep', search: 'Grep', ast_grep: 'Grep',
  find: 'Glob', glob: 'Glob', fetch: 'WebFetch', web_fetch: 'WebFetch', task: 'Agent', todo: 'TodoWrite', ask: 'AskUserQuestion',
}

function mappedInput(tool: string, raw: Record<string, unknown>): Record<string, unknown> {
  const file = str(raw['file_path']) ?? str(raw['path']) ?? str(raw['filePath'])
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit': return { file_path: file }
    case 'Bash': return { command: str(raw['command']) ?? str(raw['cmd']) }
    case 'Glob': return { pattern: str(raw['pattern']) ?? str(raw['glob']) ?? file ?? '.', path: str(raw['path']) }
    case 'Grep': return { pattern: str(raw['pattern']), path: str(raw['path']) }
    case 'apply_patch': return { command: str(raw['patchText']) ?? str(raw['patch']) ?? str(raw['input']) }
    case 'Agent': {
      const batch = Array.isArray(raw['tasks']) ? raw['tasks'].map(t => (isRecord(t) ? str(t['task']) : undefined)).filter((t): t is string => t !== undefined) : []
      const prompt = str(raw['prompt']) ?? str(raw['task']) ?? (batch.length > 0 ? [str(raw['context']), ...batch].filter(s => s !== undefined).join('\n') : undefined) ?? str(raw['description'])
      return { prompt, subagent_type: str(raw['subagent_type']) ?? str(raw['agent']) }
    }
    case 'Skill': return { skill: str(raw['skill']) ?? str(raw['name']) ?? str(raw['id']) }
    case 'WebFetch': return { url: str(raw['url']) }
    case 'TodoWrite': return { todos: raw['todos'] }
    case 'AskUserQuestion': return { questions: Array.isArray(raw['questions']) ? raw['questions'] : [raw['question']] }
    default: return {}
  }
}

function answersJson(questionList: unknown, answer: string): string {
  const first = questions(questionList)[0]?.['question']
  const a = answer.trim().slice(0, SHORT_CHARS)
  return json({ answers: typeof first === 'string' && a !== '' ? { [first]: a } : {} })
}

export interface CmOpencodeToolCall { tool: string; input: unknown; status: string; result?: unknown; error?: unknown }

function opencodeText(result: unknown): string {
  if (!isRecord(result)) return ''
  const content = result['content']
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return textOf(content)
  const output = result['output']
  return typeof output === 'string' ? output : output === undefined ? '' : json(output)
}

function opencodeShellStatus(result: unknown): CmToolStatus {
  const r = isRecord(result) ? result : {}
  const output = isRecord(r['output']) ? r['output'] : {}
  const metadata = isRecord(r['metadata']) ? r['metadata'] : {}
  const get = (k: string): unknown => output[k] ?? metadata[k]
  const exit = get('exit')
  if ((typeof exit === 'number' && exit !== 0) || get('timeout') === true || typeof get('signal') === 'string') return 'error'
  return exit === 0 ? 'ok' : 'unknown'
}

export function cmOpencodeEvent(e: CmOpencodeToolCall): CmToolEvent | undefined {
  const tool = OPENCODE_TOOLS[e.tool]
  if (tool === undefined) return undefined
  const raw = isRecord(e.input) ? e.input : {}
  const input = mappedInput(tool, raw)
  if (e.status === 'error') return failure(tool, input, errorText(e.error))
  const text = opencodeText(e.result)
  const status = tool === 'Bash' ? opencodeShellStatus(e.result) : 'ok'
  return cmToolEvent(tool, input, tool === 'AskUserQuestion' ? answersJson(input['questions'], text) : text, status)
}

export interface CmOmpToolResult { toolName: string; input: unknown; content?: unknown; isError?: unknown }

const HASHLINE_SECTION = /^\[(.+)#[0-9A-Fa-f]{4}\]\s*$/
const HASHLINE_MOVE = /^MV\s+(?:"([^"]+)"|'([^']+)'|(\S.*?))\s*$/
const SLOPPY_FILE = /^\*\*\* Edit File:\s*(.*?)\s*$/

export function cmOmpEditPaths(input: Record<string, unknown>, cwd: string): string[] {
  const out = [...classifyTool('omp', 'edit', input, cwd).paths]
  const add = (p: string | undefined): void => {
    if (p === undefined) return
    const r = resolvePath(cwd, p)
    if (r !== undefined && !out.includes(r)) out.push(r)
  }
  const text = str(input['input'])
  if (text !== undefined) {
    let inSection = false
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '').trim()
      const section = HASHLINE_SECTION.exec(line)
      if (section !== null) { add(section[1]); inSection = true; continue }
      const sloppy = SLOPPY_FILE.exec(line)
      if (sloppy !== null) { add((sloppy[1] ?? '').replace(/\s+all$/, '').trim() || undefined); continue }
      const move = inSection ? HASHLINE_MOVE.exec(line) : null
      if (move !== null) add(move[1] ?? move[2] ?? move[3])
    }
  }
  return out
}

function ompTodos(text: string): Array<Record<string, unknown>> | undefined {
  const lines = text.split('\n')
  const at = lines.findIndex(l => /^\s*Remaining items\b/.test(l))
  if (at < 0) return undefined
  if (/^\s*Remaining items:\s*none\b/i.test(lines[at] ?? '')) return []
  const out: Array<Record<string, unknown>> = []
  for (const l of lines.slice(at + 1)) {
    const m = /^\s+-\s+(.+?)\s+\[([a-z_]+)\](?:\s+\(.*\))?\s*$/.exec(l)
    if (m === null) break
    out.push({ content: m[1], status: m[2] })
  }
  return out
}

export function cmOmpEvents(e: CmOmpToolResult, opts: { cwd: string, paths?: readonly string[] }): CmToolEvent[] {
  let tool = OMP_TOOLS[e.toolName]
  if (tool === undefined) return []
  const raw = isRecord(e.input) ? e.input : {}
  const text = textOf(e.content)
  const isError = e.isError === true
  let input = mappedInput(tool, raw)
  if (tool === 'Read') {
    const p = str(raw['path']) ?? ''
    if (/^xd:\/\//i.test(p)) return []
    if (/^https?:\/\//i.test(p)) { tool = 'WebFetch'; input = { url: p } }
  }
  if (isError) {
    const f = failure(tool, input, text)
    return f === undefined ? [] : [f]
  }
  const one = (i: Record<string, unknown>, response: string): CmToolEvent[] => {
    const ev = cmToolEvent(tool as string, i, response, 'ok')
    return ev === undefined ? [] : [ev]
  }
  if (tool === 'Edit') {
    const paths = opts.paths !== undefined && opts.paths.length > 0 ? [...opts.paths] : cmOmpEditPaths(raw, opts.cwd)
    return paths.slice(0, 20).flatMap(p => one({ file_path: p }, ''))
  }
  if (tool === 'TodoWrite') {
    const list = ompTodos(text)
    return list === undefined ? [] : one({ todos: list }, '')
  }
  if (tool === 'AskUserQuestion') return one(input, answersJson(input['questions'], text))
  return one(input, text)
}

export function cmParseEvents(raw: unknown): CmEvent[] {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw['events']) ? raw['events'] : []
  const out: CmEvent[] = []
  for (const e of list) {
    if (out.length >= CM_EVENTS_MAX) break
    if (!isRecord(e)) continue
    if (e['kind'] === 'prompt') {
      const p = cmPromptEvent(e['text'])
      if (p !== undefined) out.push(p)
    } else if (e['kind'] === 'tool' && typeof e['tool'] === 'string') {
      const status = e['status'] === 'ok' || e['status'] === 'error' ? e['status'] : 'unknown'
      const t = cmToolEvent(e['tool'], e['input'], e['response'], status)
      if (t !== undefined) out.push(t)
    }
  }
  return out
}

export interface CmHookInput { tool_name: string; tool_input: Record<string, unknown>; tool_response: string; tool_output?: { isError: true } }

export function cmHookInput(ev: CmToolEvent): CmHookInput {
  const input: CmHookInput = { tool_name: ev.tool, tool_input: ev.input, tool_response: ev.response }
  if (ev.status === 'error') input.tool_output = { isError: true }
  return input
}

export interface CmExtracted { type: string; category: string; data: string; priority: number; [k: string]: unknown }

export function cmPromptRow(ev: CmPromptEvent): CmExtracted {
  return { type: 'user_prompt', category: 'user-prompt', data: ev.text, priority: 1 }
}

export function cmKeepExtracted(ev: CmEvent, extracted: unknown): CmExtracted[] {
  if (!Array.isArray(extracted)) return []
  const out: CmExtracted[] = []
  for (const r of extracted) {
    if (!isRecord(r) || typeof r['type'] !== 'string' || typeof r['category'] !== 'string' || typeof r['data'] !== 'string') continue
    if (r['type'] === 'rule_content') continue
    if (ev.kind === 'tool' && ev.status === 'ok' && (r['category'] === 'error' || r['type'] === 'constraint_discovered')) continue
    const priority = typeof r['priority'] === 'number' && Number.isFinite(r['priority']) ? r['priority'] : 3
    const data = r['data'].length > CM_ROW_MAX_CHARS ? r['data'].slice(0, CM_ROW_MAX_CHARS) : r['data']
    out.push({ ...r, type: r['type'], category: r['category'], data, priority })
  }
  return out
}

export interface CmCaptureSwitches {
  config: { contextMode: { enabled: boolean, capture: boolean } }
  env: Readonly<Record<string, string | undefined>>
}

export function cmCaptureBlocked(s: CmCaptureSwitches): string | undefined {
  if (!s.config.contextMode.enabled) return 'contextMode.enabled is false'
  if (!s.config.contextMode.capture) return 'contextMode.capture is false'
  if (memCaptureOff(s.env)) return 'BURACLE_NO_CAPTURE=1'
  return undefined
}
