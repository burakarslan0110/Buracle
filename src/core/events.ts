export type Harness = 'claude' | 'codex' | 'opencode' | 'omp'

export const HARNESSES: readonly Harness[] = ['claude', 'codex', 'opencode', 'omp']

export function isHarness(x: unknown): x is Harness {
  return typeof x === 'string' && (HARNESSES as readonly string[]).includes(x)
}

export type ToolKind = 'bash' | 'edit' | 'write' | 'patch' | 'read' | 'search' | 'web_search' | 'web_fetch'
                     | 'ask_user' | 'plan_exit' | 'plan_enter' | 'todo' | 'agent' | 'mcp' | 'eval' | 'other'

export interface ToolCall {
  harness: Harness; sessionId: string; cwd: string
  tool: string
  kind: ToolKind
  input: Record<string, unknown>
  command?: string
  paths: string[]
  mcp?: { server: string, tool: string }
}
export interface ToolResult extends ToolCall { ok: boolean; output?: string; addedText?: string }
export type PreDecision = { action: 'allow', context?: string[] } | { action: 'deny', reason: string, hook: HookId }
export interface StopInput { harness: Harness; sessionId: string; cwd: string; lastMessage?: string; hookActive?: boolean; backgroundWait?: boolean; readOnly?: boolean; now: number }
export type StopDecision = { action: 'allow' } | { action: 'block', reason: string, hook: HookId }
export interface PromptInput { harness: Harness; sessionId: string; cwd: string; text: string; now: number }
export type HookId = 'H01' | 'H02' | 'H03' | 'H04' | 'H05' | 'H06' | 'H07' | 'H08' | 'H09' | 'H10' | 'H11' | 'H12' | 'H13' | 'H14' | 'H15' | 'H16' | 'H17' | 'H18' | 'H19' | 'H20' | 'H21'
  | 'H22' | 'H23' | 'H24' | 'H25' | 'H26' | 'H27' | 'H28'

export const HOOK_IDS: readonly HookId[] = [
  'H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H09', 'H10',
  'H11', 'H12', 'H13', 'H14', 'H15', 'H16', 'H17', 'H18', 'H19', 'H20', 'H21',
  'H22', 'H23', 'H24', 'H25', 'H26', 'H27', 'H28',
]

const CLAUDE_TOOLS: Readonly<Record<string, ToolKind>> = {
  Bash: 'bash', Monitor: 'bash',
  Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit',
  Write: 'write',
  Read: 'read', NotebookRead: 'read',
  Glob: 'search', Grep: 'search', LS: 'search',
  WebSearch: 'web_search',
  WebFetch: 'web_fetch',
  AskUserQuestion: 'ask_user',
  ExitPlanMode: 'plan_exit',
  EnterPlanMode: 'plan_enter',
  TodoWrite: 'todo', TaskCreate: 'todo', TaskUpdate: 'todo', TaskList: 'todo', TaskGet: 'todo',
  Agent: 'agent', Task: 'agent',
}

const CODEX_TOOLS: Readonly<Record<string, ToolKind>> = {
  Bash: 'bash', shell: 'bash', shell_command: 'bash', exec_command: 'bash', local_shell: 'bash',
  unified_exec: 'bash', 'container.exec': 'bash',
  apply_patch: 'patch', Edit: 'patch', Write: 'patch',
  view_image: 'read',
  web_search: 'web_search', webrun: 'web_search',
  request_user_input: 'ask_user', request_user_input_async: 'ask_user',
  update_plan: 'todo',
  spawn_agent: 'agent', Agent: 'agent',
}

const OPENCODE_TOOLS: Readonly<Record<string, ToolKind>> = {
  bash: 'bash', shell: 'bash',
  edit: 'edit', multiedit: 'edit',
  write: 'write',
  patch: 'patch', apply_patch: 'patch',
  read: 'read',
  grep: 'search', glob: 'search', list: 'search', ls: 'search',
  webfetch: 'web_fetch',
  websearch: 'web_search', codesearch: 'web_search',
  question: 'ask_user',
  todowrite: 'todo', todoread: 'todo',
  task: 'agent', subagent: 'agent',
  plan_exit: 'plan_exit', plan_enter: 'plan_enter',
  skill: 'other', execute: 'other', list_mcp_resources: 'other', read_mcp_resource: 'other',
}

const OMP_TOOLS: Readonly<Record<string, ToolKind>> = {
  bash: 'bash', eval: 'eval',
  edit: 'edit', ast_edit: 'edit',
  write: 'write',
  read: 'read',
  grep: 'search', search: 'search', find: 'search', glob: 'search', ast_grep: 'search',
  web_search: 'web_search',
  fetch: 'web_fetch', web_fetch: 'web_fetch',
  ask: 'ask_user',
  todo: 'todo',
  task: 'agent',
}

const TOOL_TABLES: Readonly<Record<Harness, Readonly<Record<string, ToolKind>>>> = {
  claude: CLAUDE_TOOLS,
  codex: CODEX_TOOLS,
  opencode: OPENCODE_TOOLS,
  omp: OMP_TOOLS,
}

function own<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined
}

export function mcpServerToken(harness: Harness, server: string): string {
  switch (harness) {
    case 'omp': {
      const t = server.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
      return t.length > 0 ? t : 'server'
    }
    case 'codex':
      return server.replace(/[^A-Za-z0-9_]/g, '_')
    case 'claude':
    case 'opencode':
      return server.replace(/[^A-Za-z0-9_-]/g, '_')
  }
}

export function parseMcpName(harness: Harness, name: string, knownServers?: readonly string[]): { server: string, tool: string } | undefined {
  if (harness === 'claude' || harness === 'codex') {
    if (!name.startsWith('mcp__')) return undefined
    const rest = name.slice(5)
    if (knownServers && knownServers.length > 0) {
      let best: { server: string, tool: string, len: number } | undefined
      for (const s of knownServers) {
        const tok = mcpServerToken(harness, s)
        const direct = `${tok}__`
        if (rest.startsWith(direct) && rest.length > direct.length) {
          if (!best || tok.length > best.len) best = { server: s, tool: rest.slice(direct.length), len: tok.length }
        }
        if (harness === 'claude' && rest.startsWith('plugin_')) {
          const marker = `_${tok}__`
          const at = rest.indexOf(marker, 'plugin_'.length)
          if (at > 'plugin_'.length && rest.length > at + marker.length) {
            if (!best || tok.length > best.len) best = { server: s, tool: rest.slice(at + marker.length), len: tok.length }
          }
        }
      }
      if (best) return { server: best.server, tool: best.tool }
    }
    const sep = rest.indexOf('__')
    if (sep <= 0 || sep + 2 >= rest.length) return undefined
    let server = rest.slice(0, sep)
    const tool = rest.slice(sep + 2)
    if (harness === 'claude' && server.startsWith('plugin_')) {
      const inner = server.slice('plugin_'.length)
      const us = inner.indexOf('_')
      if (us > 0 && us + 1 < inner.length) server = inner.slice(us + 1)
    }
    return { server, tool }
  }
  if (harness === 'omp') {
    if (!name.startsWith('mcp__')) return undefined
    const rest = name.slice(5)
    if (knownServers && knownServers.length > 0) return longestPrefixServer(harness, rest, knownServers)
    const us = rest.indexOf('_')
    if (us <= 0 || us + 1 >= rest.length) return undefined
    return { server: rest.slice(0, us), tool: rest.slice(us + 1) }
  }
  if (knownServers && knownServers.length > 0) return longestPrefixServer(harness, name, knownServers)
  const us = name.indexOf('_')
  if (us <= 0 || us + 1 >= name.length) return undefined
  return { server: name.slice(0, us), tool: name.slice(us + 1) }
}

function longestPrefixServer(harness: Harness, rest: string, knownServers: readonly string[]): { server: string, tool: string } | undefined {
  let best: { server: string, tool: string, len: number } | undefined
  for (const s of knownServers) {
    const tok = mcpServerToken(harness, s)
    const pre = `${tok}_`
    if (rest.startsWith(pre) && rest.length > pre.length && (!best || tok.length > best.len)) {
      best = { server: s, tool: rest.slice(pre.length), len: tok.length }
    }
  }
  return best ? { server: best.server, tool: best.tool } : undefined
}

export function normalizePath(p: string): string {
  if (p === '') return ''
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  const body = out.join('/')
  if (abs) return '/' + body
  return body === '' ? '.' : body
}

export interface ToolPathOptions {
  homeTilde?: string
}

export function resolvePath(cwd: string, p: string, home?: string): string | undefined {
  let s = p.trim()
  if (s === '') return undefined
  if (home !== undefined && home !== '' && (s === '~' || s.startsWith('~/'))) {
    return normalizePath(`${home.replace(/\/+$/, '')}/${s.slice(2)}`)
  }
  if (s.startsWith('file://')) {
    s = s.slice('file://'.length)
    try { s = decodeURIComponent(s) } catch {  }
    if (!s.startsWith('/')) s = '/' + s
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(s)) {
    return undefined
  }
  if (s.startsWith('/')) return normalizePath(s)
  if (cwd === '') return normalizePath(s)
  return normalizePath(`${cwd}/${s}`)
}

export function parseApplyPatch(patch: string, cwd: string, opts?: ToolPathOptions): { paths: string[], added: Record<string, string> } {
  const paths: string[] = []
  const addedLines = new Map<string, string[]>()
  const seen = new Set<string>()
  const home = opts?.homeTilde
  const touch = (raw: string): string | undefined => {
    const r = resolvePath(cwd, stripQuotes(raw), home)
    if (r === undefined) return undefined
    if (!seen.has(r)) { seen.add(r); paths.push(r) }
    return r
  }
  const lines = patch.split(/\r?\n/)
  let current: string | undefined
  let sawStarHeader = false
  for (const line of lines) {
    const t = line.trim()
    if (t.startsWith('*** ')) {
      const m = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(t)
      if (m && m[1] !== undefined && m[2] !== undefined) {
        sawStarHeader = true
        const p = touch(m[2])
        if (m[1] === 'Delete') { current = undefined; continue }
        current = p
        if (m[1] === 'Add' && p !== undefined && !addedLines.has(p)) addedLines.set(p, [])
        continue
      }
      const mv = /^\*\*\* Move to:\s*(.+)$/.exec(t)
      if (mv && mv[1] !== undefined) {
        const dest = touch(mv[1])
        if (current !== undefined && dest !== undefined) {
          const prev = addedLines.get(current)
          if (prev !== undefined) { addedLines.delete(current); addedLines.set(dest, prev) }
        }
        current = dest
        continue
      }
      if (/^\*\*\* (Begin Patch|End Patch|End of File)\b/.test(t)) {
        if (t.startsWith('*** End Patch')) current = undefined
        continue
      }
    }
    if (current !== undefined && line.startsWith('+')) {
      const list = addedLines.get(current)
      if (list) list.push(line.slice(1))
      else addedLines.set(current, [line.slice(1)])
    }
  }
  if (!sawStarHeader) {
    current = undefined
    let pendingOld: string | undefined
    for (const line of lines) {
      if (line.startsWith('--- ')) {
        pendingOld = diffHeaderPath(line.slice(4))
        current = undefined
        continue
      }
      if (line.startsWith('+++ ')) {
        const np = diffHeaderPath(line.slice(4))
        if (pendingOld !== undefined) touch(pendingOld)
        current = np !== undefined ? touch(np) : undefined
        pendingOld = undefined
        continue
      }
      if (current !== undefined && line.startsWith('+')) {
        const list = addedLines.get(current)
        if (list) list.push(line.slice(1))
        else addedLines.set(current, [line.slice(1)])
      }
    }
  }
  const added: Record<string, string> = {}
  for (const [k, v] of addedLines) added[k] = v.join('\n')
  return { paths, added }
}

function stripQuotes(s: string): string {
  const t = s.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1)
  return t
}

function diffHeaderPath(rest: string): string | undefined {
  const s = rest.split('\t')[0]?.trim() ?? ''
  if (s === '' || s === '/dev/null') return undefined
  if (s.startsWith('a/') || s.startsWith('b/')) return `./${s.slice(2)}`
  return s
}

const SHELLS = /^(?:\/(?:usr\/)?(?:local\/)?bin\/)?(?:ba|z|da|k|fi)?sh$/

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined
}

function shellQuote(a: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`
}

function commandOf(input: Record<string, unknown>): string | undefined {
  const raw = input['command'] ?? input['cmd']
  if (typeof raw === 'string') return raw
  if (Array.isArray(raw) && raw.every((x): x is string => typeof x === 'string')) {
    const argv = raw
    const [a0, a1, a2] = argv
    if (a0 !== undefined && a1 !== undefined && a2 !== undefined && SHELLS.test(a0) && /^-[a-z]*c$/.test(a1)) return a2
    return argv.map(shellQuote).join(' ')
  }
  return undefined
}

const PATCH_FIELDS = ['patchText', 'patch', 'input', 'diff'] as const

function looksLikePatch(s: string): boolean {
  return /\*\*\* (Begin Patch|Add File:|Update File:|Delete File:)/.test(s)
}

function patchTextOf(input: Record<string, unknown>): string | undefined {
  const cmd = input['command']
  if (typeof cmd === 'string' && looksLikePatch(cmd)) return cmd
  if (Array.isArray(cmd)) {
    for (const part of cmd) if (typeof part === 'string' && looksLikePatch(part)) return part
  }
  for (const f of PATCH_FIELDS) {
    const v = input[f]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return typeof cmd === 'string' ? cmd : undefined
}

const PATH_FIELDS = ['file_path', 'filePath', 'notebook_path', 'notebookPath', 'path', 'file'] as const

function directPaths(input: Record<string, unknown>, cwd: string, home: string | undefined): string[] {
  const out: string[] = []
  const add = (v: unknown) => {
    if (typeof v !== 'string') return
    const r = resolvePath(cwd, v, home)
    if (r !== undefined && !out.includes(r)) out.push(r)
  }
  for (const f of PATH_FIELDS) add(input[f])
  const many = input['paths']
  if (Array.isArray(many)) for (const v of many) add(v)
  const edits = input['edits']
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (e !== null && typeof e === 'object') {
        const rec = e as Record<string, unknown>
        add(rec['path'])
        add(rec['rename'])
      }
    }
  }
  return out
}

function uniqueConcat(a: string[], b: string[]): string[] {
  const out = [...a]
  for (const x of b) if (!out.includes(x)) out.push(x)
  return out
}

export function classifyTool(harness: Harness, tool: string, rawInput: Record<string, unknown>, cwd: string, knownServers?: readonly string[], opts?: ToolPathOptions): Pick<ToolCall, 'kind' | 'command' | 'paths' | 'mcp'> {
  const input: Record<string, unknown> = rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {}
  const home = opts?.homeTilde
  const table = TOOL_TABLES[harness]
  let kind: ToolKind | undefined = own(table, tool)
  if (kind === undefined) {
    const mcp = parseMcpName(harness, tool, knownServers)
    if (mcp) return { kind: 'mcp', paths: [], mcp }
    return { kind: 'other', paths: [] }
  }

  if (harness === 'omp' && (kind === 'read' || kind === 'write')) {
    const p = str(input['path'])
    if (p !== undefined) {
      const dev = /^xd:\/\/([^/?#\s]+)/.exec(p)
      if (dev && dev[1] !== undefined) {
        if (kind === 'write') {
          const mcp = parseMcpName('omp', dev[1], knownServers)
          if (mcp) return { kind: 'mcp', paths: [], mcp }
        }
        return { kind: 'other', paths: [] }
      }
      if (kind === 'read' && /^https?:\/\//i.test(p)) return { kind: 'web_fetch', paths: [] }
    }
  }
  if (harness === 'omp' && kind === 'edit') {
    const inner = str(input['input'])
    if (inner !== undefined && looksLikePatch(inner)) kind = 'patch'
  }

  if (harness === 'claude' && tool === 'Monitor') {
    const command = str(input['command'])
    return command !== undefined ? { kind: 'bash', command, paths: [] } : { kind: 'other', paths: [] }
  }

  switch (kind) {
    case 'bash': {
      const command = commandOf(input)
      const raw = input['command']
      if (Array.isArray(raw) && raw[0] === 'apply_patch' && typeof raw[1] === 'string') {
        return { kind: 'patch', paths: parseApplyPatch(raw[1], cwd, opts).paths }
      }
      return command !== undefined ? { kind, command, paths: [] } : { kind, paths: [] }
    }
    case 'patch': {
      const text = patchTextOf(input)
      const fromPatch = text !== undefined ? parseApplyPatch(text, cwd, opts).paths : []
      return { kind, paths: uniqueConcat(directPaths(input, cwd, home), fromPatch) }
    }
    case 'edit':
    case 'write':
    case 'read':
    case 'search':
      return { kind, paths: directPaths(input, cwd, home) }
    default:
      return { kind, paths: [] }
  }
}
