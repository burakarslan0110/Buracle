import { harnessProfile, type Harness } from './harness/index'
import { mcpToken, parseMcpToolName, toolKindOf, type HarnessProfile, type ToolKind } from './harness/profile'

export { HARNESSES, isHarness, type Harness } from './harness/index'
export { CANONICAL_EVENTS, type CanonicalEvent, type ToolKind } from './harness/profile'

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
export interface StopInput { harness: Harness; sessionId: string; cwd: string; lastMessage?: string; hookActive?: boolean; backgroundWait?: boolean; readOnly?: boolean; subagent?: boolean; now: number }
export type StopDecision = { action: 'allow' } | { action: 'block', reason: string, hook: HookId }
export interface PromptInput { harness: Harness; sessionId: string; cwd: string; text: string; userText?: boolean; now: number }

// The seven canonical events (`CanonicalEvent`) every harness maps its native hooks onto. The types above and
// below are their inputs and decisions: ToolCall/PreDecision (preTool), ToolResult/PostToolDecision (postTool),
// PromptInput/PromptDecision (prompt), StopInput/StopDecision (stop).
export interface SessionStartInput { harness: Harness; sessionId: string; cwd: string; source: string; model?: string; subagent?: boolean; now: number }
export interface SessionStartDecision { context: string[] }
export interface PromptDecision { context: string[] }
export interface PostToolDecision { context: string[] }
export interface CompactInput { harness: Harness; sessionId: string; cwd: string; trigger?: string; now: number }
export interface CompactDecision { handoff?: string; todo: string[] }
export interface SessionEndInput { harness: Harness; sessionId: string; now: number }
export interface SessionEndDecision { finalized: boolean }
export type HookId = 'H01' | 'H02' | 'H03' | 'H04' | 'H05' | 'H06' | 'H07' | 'H08' | 'H09' | 'H10' | 'H11' | 'H12' | 'H13' | 'H14' | 'H15' | 'H16' | 'H17' | 'H18' | 'H19' | 'H20' | 'H21'
  | 'H22' | 'H23' | 'H24' | 'H25' | 'H26' | 'H28'

// Hook ids are stable: a retired hook leaves a gap, and its id is never reused.
export const HOOK_IDS: readonly HookId[] = [
  'H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H09', 'H10',
  'H11', 'H12', 'H13', 'H14', 'H15', 'H16', 'H17', 'H18', 'H19', 'H20', 'H21',
  'H22', 'H23', 'H24', 'H25', 'H26', 'H28',
]

// Ids of hooks earlier Buracle versions had (H27 context.session came and went with Context Mode).
export const RETIRED_HOOK_IDS = ['H27'] as const

export function mcpServerToken(harness: Harness, server: string): string {
  return mcpToken(harnessProfile(harness).mcp, server)
}

export function parseMcpName(harness: Harness, name: string, knownServers?: readonly string[]): { server: string, tool: string } | undefined {
  return parseMcpToolName(harnessProfile(harness).mcp, name, knownServers)
}

export function isAbsPath(p: string): boolean {
  return typeof p === 'string' && p.startsWith('/')
}

// A backslash is part of a name, never a separator: Buracle runs on macOS and Linux only.
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

// The root of an absolute path (`/`), or '' for a relative one.
export function pathRoot(p: string): string {
  return typeof p === 'string' && p.startsWith('/') ? '/' : ''
}

export function isRootPath(p: string): boolean {
  return typeof p === 'string' && p !== '' && normalizePath(p) === pathRoot(normalizePath(p))
}

export interface ToolPathOptions {
  homeTilde?: string
}

// The normalized form the guards compare.
export function resolvePath(cwd: string, p: string, home?: string): string | undefined {
  let s = p.trim()
  if (s === '') return undefined
  if (home !== undefined && home !== '' && (s === '~' || s.startsWith('~/'))) {
    return normalizePath(`${home.replace(/[\\/]+$/, '')}/${s.slice(2)}`)
  }
  if (s.startsWith('file://')) {
    s = s.slice('file://'.length)
    try { s = decodeURIComponent(s) } catch {  }
    if (!s.startsWith('/')) s = '/' + s
  } else if (/^[A-Za-z][A-Za-z0-9+.-]+:\/\//.test(s)) {
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
  return classifyToolFor(harnessProfile(harness), tool, rawInput, cwd, knownServers, opts)
}

/** `classifyTool` for a profile: everything it knows about the host's tools comes from there. */
export function classifyToolFor(profile: Pick<HarnessProfile, 'tools' | 'mcp'>, tool: string, rawInput: Record<string, unknown>, cwd: string, knownServers?: readonly string[], opts?: ToolPathOptions): Pick<ToolCall, 'kind' | 'command' | 'paths' | 'mcp'> {
  const input: Record<string, unknown> = rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {}
  const home = opts?.homeTilde
  const t = profile.tools
  let kind: ToolKind | undefined = toolKindOf(profile, tool)
  if (kind === undefined) {
    const mcp = parseMcpToolName(profile.mcp, tool, knownServers)
    if (mcp) return { kind: 'mcp', paths: [], mcp }
    return { kind: 'other', paths: [] }
  }

  if ((t.deviceScheme !== undefined || t.readFetchesUrls === true) && (kind === 'read' || kind === 'write')) {
    const p = str(input['path'])
    if (p !== undefined) {
      const dev = t.deviceScheme !== undefined && p.startsWith(`${t.deviceScheme}://`) ? /^[^/?#\s]+/.exec(p.slice(t.deviceScheme.length + 3)) : null
      if (dev) {
        if (kind === 'write') {
          const mcp = parseMcpToolName(profile.mcp, dev[0], knownServers)
          if (mcp) return { kind: 'mcp', paths: [], mcp }
        }
        return { kind: 'other', paths: [] }
      }
      if (kind === 'read' && t.readFetchesUrls === true && /^https?:\/\//i.test(p)) return { kind: 'web_fetch', paths: [] }
    }
  }
  if (t.editTakesPatch === true && kind === 'edit') {
    const inner = str(input['input'])
    if (inner !== undefined && looksLikePatch(inner)) kind = 'patch'
  }

  if (t.stringCommandOnly?.includes(tool) === true) {
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
