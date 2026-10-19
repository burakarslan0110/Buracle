import { CM_SERVER_ID, isCmExecTool } from '../context-mode'
import type { Harness, StopDecision, ToolCall } from '../events'
import type { IndexExclusionContext } from '../workspace'
import { indexExclusion, isPathWithin, pathKey } from '../workspace'
import { changedExports, importedPackages, languageOf, patchDeletes, patchEdits } from './code-facts'
import type { PathRuleSource } from './path-rules'
import { matchPathRules, pathRuleNote, projectRelative, ruleFileId } from './path-rules'
import type { McpHealth, RoutingPolicy } from './routing'
import { isDocsUrl } from './routing'
import { cmCall, sandboxShellCommands } from './sandbox'
import { shellFileRead, shellFileWrite } from './shell-files'
import type { PromptRoute } from './skill-router'
import { categoryReminder } from './skill-router'
import type { ShellWord } from './shell'
import { commandName, DYN, HOME, parseShell, simpleCommands, unwrap } from './shell'
import { fold } from './text'

export interface UsageCount { n: number; turn: number }
export interface TurnTools {
  calls: number
  search: number
  read: string[]
  graph: number
  memory: number
}
export interface LedgerPrompt { turn: number; at: number; route: PromptRoute; audited?: boolean }
export interface UsageLedger {
  v: 1
  turn: number
  prompt?: LedgerPrompt
  mcp: Record<string, UsageCount>
  skills: Record<string, UsageCount>
  turnTools: TurnTools
  streak: { search: number }
  symbols: string[]
  libs: string[]
  shown: Record<string, { turn: number; n: number }>
  usedOnce: string[]
  mcpErrors?: Record<string, number>
}

const LIST_MAX = 200
const READ_MAX = 64
const MAP_MAX = 64

export function emptyTurn(): TurnTools {
  return { calls: 0, search: 0, read: [], graph: 0, memory: 0 }
}

export function emptyLedger(): UsageLedger {
  return { v: 1, turn: 0, mcp: {}, skills: {}, turnTools: emptyTurn(), streak: { search: 0 }, symbols: [], libs: [], shown: {}, usedOnce: [] }
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
const strList = (x: unknown, max: number): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string').slice(-max) : [])

function counts(x: unknown): Record<string, UsageCount> {
  const out: Record<string, UsageCount> = {}
  if (!isObj(x)) return out
  for (const [k, v] of Object.entries(x).slice(0, MAP_MAX)) if (isObj(v) && isNum(v['n']) && isNum(v['turn'])) out[k] = { n: v['n'], turn: v['turn'] }
  return out
}

function routeOf(x: unknown): PromptRoute | undefined {
  if (!isObj(x)) return undefined
  const mem = isObj(x['memory']) ? x['memory'] : {}
  const r: PromptRoute = {
    invoked: strList(x['invoked'], 8), load: strList(x['load'], 1), candidates: strList(x['candidates'], 4), categories: strList(x['categories'], 4),
    memory: { recall: mem['recall'] === true, write: mem['write'] === true },
  }
  if (mem['cli'] === true) r.memory.cli = true
  const libs = strList(x['libs'], 8)
  if (libs.length > 0) r.libs = libs
  return r
}

export function parseLedger(raw: unknown): UsageLedger {
  const l = emptyLedger()
  if (!isObj(raw) || raw['v'] !== 1) return l
  if (isNum(raw['turn'])) l.turn = Math.floor(raw['turn'])
  const p = raw['prompt']
  if (isObj(p) && isNum(p['turn']) && isNum(p['at'])) {
    const route = routeOf(p['route'])
    if (route !== undefined) l.prompt = { turn: p['turn'], at: p['at'], route, ...(p['audited'] === true ? { audited: true } : {}) }
  }
  l.mcp = counts(raw['mcp'])
  l.skills = counts(raw['skills'])
  const t = raw['turnTools']
  if (isObj(t)) {
    l.turnTools = {
      calls: isNum(t['calls']) ? t['calls'] : 0, search: isNum(t['search']) ? t['search'] : 0, read: strList(t['read'], READ_MAX),
      graph: isNum(t['graph']) ? t['graph'] : 0, memory: isNum(t['memory']) ? t['memory'] : 0,
    }
  }
  if (isObj(raw['streak']) && isNum(raw['streak']['search'])) l.streak = { search: raw['streak']['search'] }
  l.symbols = strList(raw['symbols'], LIST_MAX)
  l.libs = strList(raw['libs'], LIST_MAX)
  if (isObj(raw['shown'])) {
    for (const [k, v] of Object.entries(raw['shown']).slice(0, MAP_MAX)) if (isObj(v) && isNum(v['turn']) && isNum(v['n'])) l.shown[k] = { turn: v['turn'], n: v['n'] }
  }
  l.usedOnce = strList(raw['usedOnce'], LIST_MAX)
  if (isObj(raw['mcpErrors'])) {
    const errors: Record<string, number> = {}
    for (const [k, v] of Object.entries(raw['mcpErrors']).slice(0, MAP_MAX)) if (isNum(v) && v >= 1) errors[k] = Math.floor(v)
    if (Object.keys(errors).length > 0) l.mcpErrors = errors
  }
  return l
}

function bump(map: Record<string, UsageCount>, id: string, turn: number): Record<string, UsageCount> {
  const next = { ...map }
  if (next[id] === undefined && Object.keys(next).length >= MAP_MAX) return next
  next[id] = { n: (next[id]?.n ?? 0) + 1, turn }
  return next
}

function pushUnique(list: readonly string[], items: readonly string[], max = LIST_MAX): string[] {
  const out = [...list]
  for (const it of items) if (it !== '' && !out.includes(it)) out.push(it)
  return out.slice(-max)
}

export function ledgerOnce(l: UsageLedger, key: string): { fresh: boolean, next: UsageLedger } {
  if (typeof key !== 'string' || key === '' || l.usedOnce.includes(key)) return { fresh: false, next: l }
  return { fresh: true, next: { ...l, usedOnce: pushUnique(l.usedOnce, [key]) } }
}

export function ledgerPrompt(l: UsageLedger, route: PromptRoute, now: number): UsageLedger {
  const turn = l.turn + 1
  let skills = l.skills
  for (const id of route.invoked) skills = bump(skills, id, turn)
  return { ...l, turn, skills, prompt: { turn, at: now, route }, turnTools: emptyTurn() }
}

const ID = /^[a-z0-9][a-z0-9-]{0,63}$/

function skillName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim().replace(/^\//, '')
  const m = /^(?:buracle:)?([a-z0-9][a-z0-9-]*)(?:\s|$)/.exec(s)
  if (m === null || (s.includes(':') && !s.startsWith('buracle:'))) return undefined
  return ID.test(m[1] ?? '') ? m[1] : undefined
}

function skillFromPath(p: unknown): string | undefined {
  if (typeof p !== 'string') return undefined
  const m = /(?:^|[/\\])skills[/\\]([a-z0-9][a-z0-9-]*)[/\\]SKILL\.md$/.exec(p.trim())
  return m?.[1]
}

function wordPath(w: ShellWord): string {
  if (w.text.startsWith('~')) return ''
  let out = ''
  let k = 0
  for (const ch of w.text) {
    if (ch === HOME) out += '~'
    else if (ch === DYN) out += `$${w.vars?.[k++]?.name ?? ''}`
    else out += ch
  }
  return out
}

function shellArgv(command: string, word: (w: ShellWord) => string = w => w.text): string[][] {
  try {
    const out: string[][] = []
    const { script, subs } = parseShell(command)
    for (const s of [script, ...subs.slice(0, 8).map(x => parseShell(x).script)]) {
      for (const c of simpleCommands(s)) {
        const u = unwrap(c.words)
        const name = commandName(u.argv[0])
        if (name !== undefined) out.push([name, ...u.argv.slice(1).map(word)])
      }
    }
    return out
  } catch {
    return []
  }
}

export function skillOf(call: Pick<ToolCall, 'tool' | 'input' | 'kind' | 'command'>, harness: Harness): string | undefined {
  const input = isObj(call.input) ? call.input : {}
  if (harness === 'claude' && call.tool === 'Skill') return skillName(input['skill'] ?? input['name'] ?? input['command'])
  if (harness === 'opencode' && call.tool === 'skill') return skillName(input['id'] ?? input['name'])
  if (harness === 'omp' && call.kind === 'read') {
    const p = input['path']
    const m = typeof p === 'string' ? /^skill:\/\/([a-z0-9][a-z0-9-]*)(?:[/?#]|$)/.exec(p.trim()) : null
    if (m) return m[1]
  }
  if (call.kind === 'read') return skillFromPath(input['file_path'] ?? input['filePath'] ?? input['path'])
  if (call.kind === 'bash' && typeof call.command === 'string') {
    for (const argv of shellArgv(call.command)) for (const a of argv.slice(1)) { const id = skillFromPath(a); if (id !== undefined) return id }
  }
  return undefined
}

const SHELL_SEARCH = new Set(['rg', 'grep', 'egrep', 'fgrep', 'rgrep', 'ag', 'ack', 'find', 'fd', 'fdfind'])

function searchesText(command: string): boolean {
  return shellArgv(command).some(a => SHELL_SEARCH.has(a[0] as string) || (a[0] === 'git' && a[1] === 'grep'))
}

function isTextSearch(call: ToolCall): boolean {
  if (call.kind === 'search') return !['LS', 'list', 'ls'].includes(call.tool)
  if (call.kind === 'bash') return typeof call.command === 'string' && searchesText(call.command)
  const cm = cmCall(call)
  return cm !== undefined && isCmExecTool(cm.tool) && sandboxShellCommands(call).some(searchesText)
}

function memoryCliOps(call: ToolCall): string[] {
  if (call.kind !== 'bash' || typeof call.command !== 'string') return []
  return shellArgv(call.command).filter(a => a[0] === 'buracle' && a[1] === 'mem').map(a => a[2] ?? '')
}

function isMemoryCli(call: ToolCall): boolean {
  return memoryCliOps(call).some(op => ['search', 'get', 'timeline', 'status', 'update'].includes(op))
}

function isMemoryCall(call: ToolCall): boolean {
  return (call.kind === 'mcp' && call.mcp?.server === 'buracle-memory') || isMemoryCli(call)
}

function identifiers(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const k of ['symbol', 'name', 'query', 'symbolName', 'qualifiedName', 'target', 'node', 'from', 'to', 'id']) {
    const v = input[k]
    if (typeof v !== 'string') continue
    for (const m of v.matchAll(/[A-Za-z_$][\w$]*/g)) if (m[0].length >= 2) out.push(m[0])
  }
  return [...new Set(out)].slice(0, 32)
}

function libraryNames(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const k of ['libraryName', 'libraryId', 'library', 'context7CompatibleLibraryID']) {
    const v = input[k]
    if (typeof v !== 'string' || v.trim() === '') continue
    const f = fold(v).replace(/^\/+/, '')
    out.push(f)
    for (const seg of f.split('/')) if (seg.length >= 2) out.push(seg)
  }
  return [...new Set(out)].slice(0, 16)
}

export function ledgerCall(l: UsageLedger, call: ToolCall): UsageLedger {
  const turn = l.turn
  const t: TurnTools = { ...l.turnTools, calls: l.turnTools.calls + 1, read: [...l.turnTools.read] }
  const next: UsageLedger = { ...l, turnTools: t, streak: { ...l.streak } }
  const skill = skillOf(call, call.harness)
  if (skill !== undefined) next.skills = bump(l.skills, skill, turn)
  const server = call.kind === 'mcp' ? call.mcp?.server : undefined
  const input = isObj(call.input) ? call.input : {}
  if (server !== undefined && server !== '') {
    next.mcp = bump(l.mcp, server, turn)
    if (server === 'semble' || server === 'codegraph') { t.graph++; next.streak.search = 0 }
    if (server === 'codegraph') next.symbols = pushUnique(l.symbols, identifiers(input))
    if (server === 'context7') next.libs = pushUnique(l.libs, libraryNames(input))
    if (server === 'buracle-memory') t.memory++
  }
  if (isMemoryCli(call)) { next.mcp = bump(next.mcp, 'buracle-memory', turn); t.memory++ }
  if (isTextSearch(call)) { t.search++; next.streak.search++ }
  if (call.kind === 'read') for (const p of call.paths ?? []) if (!t.read.includes(p) && t.read.length < READ_MAX) t.read.push(p)
  return next
}

export const MCP_SESSION_DOWN_ERRORS = 2

export function ledgerMcpResult(l: UsageLedger, server: string, ok: boolean, tool?: string): UsageLedger {
  if (typeof server !== 'string' || server === '') return l
  if (!ok && server === CM_SERVER_ID && isCmExecTool(tool)) return l
  const errors = { ...(l.mcpErrors ?? {}) }
  if (ok) {
    if (errors[server] === undefined) return l
    delete errors[server]
  } else {
    if (errors[server] === undefined && Object.keys(errors).length >= MAP_MAX) return l
    errors[server] = (errors[server] ?? 0) + 1
  }
  const next: UsageLedger = { ...l }
  if (Object.keys(errors).length > 0) next.mcpErrors = errors
  else delete next.mcpErrors
  return next
}

export function sessionMcpHealth(health: McpHealth, l: UsageLedger): McpHealth {
  const failing = Object.entries(l.mcpErrors ?? {}).filter(([, n]) => n >= MCP_SESSION_DOWN_ERRORS).map(([id]) => id)
  if (failing.length === 0) return health
  const out: McpHealth = { ...health }
  for (const id of failing) out[id] = 'down'
  return out
}

export interface WorkspaceFacts {
  root?: string
  home?: string
  excluded?: readonly string[]
  caseInsensitive?: boolean
  codegraphIndexed?: boolean
  cwd?: string
  children?: readonly string[]
  exclusion?: IndexExclusionContext
  excludedReason?: (dir: string) => string | undefined
  realpath?: (path: string) => string | undefined
}

export interface ReminderContext {
  strictness: RoutingPolicy['strictness']
  reminders?: boolean
  available: readonly string[]
  policy?: RoutingPolicy
  facts?: WorkspaceFacts
  edits?: ReadonlyArray<{ file: string, removed: string, added: string }>
  deps?: readonly string[]
  pathRules?: PathRuleSource
}

export interface ReminderResult {
  context?: string
  deny?: { reason: string; key: string }
  next: UsageLedger
}

const FALLBACK_REMINDER: Record<string, string> = {
  'code-search': 'find code by intent with semble search (repo = the project root); use rg for exact text',
  'code-structure': 'ask codegraph (callers, callees, impact) before changing a shared symbol',
  memory: 'search memory with memory_search, then memory_get the relevant memories, and cite their ids',
  'library-docs': 'resolve the library with context7 (resolve-library-id), then query-docs at the version in the lockfile',
}

function reminderText(ctx: ReminderContext, category: string): string {
  return categoryReminder(ctx.policy, category) ?? FALLBACK_REMINDER[category] ?? ''
}

interface ShowRule { perTurn?: boolean; cooldownTurns?: number; max: number; topic?: string }

function canShow(l: UsageLedger, id: string, rule: ShowRule): boolean {
  const s = l.shown[id]
  if (s === undefined) return true
  if (s.turn === l.turn && (rule.perTurn === true || rule.topic !== undefined)) return false
  if (rule.topic !== undefined && l.prompt?.turn === l.turn && l.prompt.route.categories.includes(rule.topic)) return true
  if (s.n >= rule.max) return false
  if (rule.perTurn === true && s.turn === l.turn) return false
  return rule.cooldownTurns === undefined || l.turn - s.turn >= rule.cooldownTurns
}

function markShown(l: UsageLedger, id: string): UsageLedger {
  const prev = l.shown[id]
  return { ...l, shown: { ...l.shown, [id]: { turn: l.turn, n: (prev?.n ?? 0) + 1 } } }
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' ? x : undefined
}

const PATCH_TEXT = /^(?:\*\*\* |--- |\+\+\+ )/m

function patchText(call: ToolCall): string | undefined {
  const input = isObj(call.input) ? call.input : {}
  return [input['patchText'], input['patch'], input['input'], input['diff'], input['command']].find((v): v is string => typeof v === 'string' && PATCH_TEXT.test(v))
}

function editsOf(call: ToolCall, ctx: ReminderContext): Array<{ file: string, removed: string, added: string }> {
  if (ctx.edits !== undefined) return [...ctx.edits]
  const input = isObj(call.input) ? call.input : {}
  const file = call.paths[0] ?? str(input['file_path']) ?? str(input['filePath']) ?? str(input['path']) ?? ''
  if (call.kind === 'edit') {
    const out: Array<{ file: string, removed: string, added: string }> = []
    const one = (o: Record<string, unknown>): void => {
      const removed = str(o['old_string']) ?? str(o['oldString']) ?? str(o['old_text'])
      const added = str(o['new_string']) ?? str(o['newString']) ?? str(o['new_text'])
      if (removed !== undefined && added !== undefined) out.push({ file, removed, added })
    }
    one(input)
    const edits = input['edits']
    if (Array.isArray(edits)) for (const e of edits) if (isObj(e)) one(e)
    return out
  }
  if (call.kind === 'patch') {
    const text = patchText(call)
    return text === undefined ? [] : patchEdits(text).map(e => ({ file: e.path, removed: e.removed, added: e.added }))
  }
  return []
}

const normDep = (s: string): string => fold(s).replace(/_/g, '-')
const alnum = (s: string): string => fold(s).replace(/[^a-z0-9]/g, '')

function libResolved(libs: readonly string[], pkg: string): boolean {
  const parts = [pkg, pkg.split('/').pop() ?? pkg, pkg.startsWith('@') ? (pkg.split('/')[0] ?? '').slice(1) : ''].map(alnum).filter(c => c.length >= 2)
  return libs.map(alnum).some(lib => lib.length >= 2 && parts.some(c => lib === c || (c.length >= 3 && lib.includes(c)) || (lib.length >= 3 && c.includes(lib))))
}

function gateable(pkg: string, file: string, deps: ReadonlySet<string>): boolean {
  switch (languageOf(file)) {
    case 'ts': return deps.size === 0 || deps.has(normDep(pkg)) || pkg.startsWith('@')
    case 'py': return deps.has(normDep(pkg))
    case 'rs': return deps.has(normDep(pkg))
    case 'go': return true
    default: return false
  }
}

const ABSOLUTE_PATH = /^(?:\/|[A-Za-z]:[\\/]|\\\\)/

export function rootProblem(value: string, facts: WorkspaceFacts | undefined): string | undefined {
  const f = facts ?? {}
  const home = f.exclusion?.home ?? f.home
  let p = typeof value === 'string' ? value.trim() : ''
  if (home !== undefined && home !== '' && (p === '~' || p.startsWith('~/'))) p = home.replace(/[\\/]+$/, '') + p.slice(1)
  if (p === '' || !ABSOLUTE_PATH.test(p)) return undefined
  const dir = f.realpath?.(p) ?? p
  const ci = f.exclusion?.caseInsensitive ?? f.caseInsensitive === true
  const why = f.excludedReason !== undefined
    ? f.excludedReason(dir)
    : indexExclusion(dir, f.exclusion ?? { home: home ?? '', buracleHome: '', vault: '', exclude: [], caseInsensitive: ci })
  if (why !== undefined) return why
  for (const e of f.excluded ?? []) if (typeof e === 'string' && e.trim() !== '' && isPathWithin(dir, e, ci)) return 'a folder Buracle never indexes'
  if (f.root !== undefined) return pathKey(dir, ci) !== pathKey(f.root, ci) && isPathWithin(f.root, dir, ci) ? 'a parent folder of the project' : undefined
  if (f.cwd !== undefined && (f.children?.length ?? 0) > 0 && pathKey(dir, ci) === pathKey(f.cwd, ci)) return 'a folder of projects, not a project'
  return undefined
}

function lastSegment(p: string): string {
  const k = p.replace(/[\\/]+$/, '')
  return k.slice(Math.max(k.lastIndexOf('/'), k.lastIndexOf('\\')) + 1) || k
}

function rootFix(facts: WorkspaceFacts | undefined): string {
  if (facts?.root !== undefined) return `Pass the project root ${facts.root} instead.`
  const children = facts?.children ?? []
  if (facts?.cwd !== undefined && children.length > 0) {
    return `Pass one of its projects instead (${children.map(lastSegment).join(', ')}), as ${facts.cwd.replace(/[\\/]+$/, '')}/<name>.`
  }
  return 'Pass the project folder you work in.'
}

export function rootCheckText(server: string, key: string, value: string, why: string, facts: WorkspaceFacts | undefined): string {
  return `${server} \`${key}\` is ${value.trim()}, ${why}; indexing it is slow and searches the wrong tree. ${rootFix(facts)}`
}

function urlIn(input: Record<string, unknown>): string | undefined {
  for (const k of ['url', 'uri', 'href']) { const v = input[k]; if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v }
  return undefined
}

function fetchUrls(input: Record<string, unknown>): string[] {
  const out: string[] = []
  const one = urlIn(input)
  if (one !== undefined) out.push(one)
  let reqs: unknown = input['requests']
  if (typeof reqs === 'string') { try { reqs = JSON.parse(reqs) } catch { reqs = undefined } }
  if (Array.isArray(reqs)) for (const r of reqs.slice(0, 32)) if (isObj(r)) { const u = urlIn(r); if (u !== undefined) out.push(u) }
  return out
}

function rootArgument(call: ToolCall): { server: string, key: string } | undefined {
  const server = call.kind === 'mcp' ? call.mcp?.server : undefined
  if (server === 'semble') return { server, key: 'repo' }
  if (server === 'codegraph') return { server, key: 'projectPath' }
  return cmCall(call)?.tool === 'ctx_index' ? { server: CM_SERVER_ID, key: 'path' } : undefined
}

const ruleKey = (id: string): string => `R5:${id}`

function markRules(l: UsageLedger, ids: readonly string[]): UsageLedger {
  return { ...l, usedOnce: pushUnique(l.usedOnce, ids.map(ruleKey)) }
}

function caseInsensitiveOf(ctx: ReminderContext): boolean {
  return ctx.facts?.exclusion?.caseInsensitive ?? ctx.facts?.caseInsensitive === true
}

const FILE_PRINTERS = new Set(['cat', 'bat', 'batcat', 'less', 'more', 'head', 'tail', 'sed', 'awk', 'nl'])

function ruleFileReads(call: ToolCall, src: PathRuleSource, ci: boolean): string[] {
  const out: string[] = []
  const add = (p: unknown): void => {
    const id = typeof p === 'string' && p !== '' ? ruleFileId(p, src, ci) : undefined
    if (id !== undefined && !out.includes(id)) out.push(id)
  }
  if (call.kind === 'read') {
    const input = isObj(call.input) ? call.input : {}
    for (const p of [...call.paths, input['file_path'], input['filePath'], input['path']]) add(p)
  }
  if (call.kind === 'bash' && typeof call.command === 'string') {
    for (const argv of shellArgv(call.command, wordPath)) if (FILE_PRINTERS.has(argv[0] as string)) for (const a of argv.slice(1)) add(a)
  }
  return out
}

function relBase(call: ToolCall, ctx: ReminderContext): { root?: string, cwd: string, caseInsensitive: boolean } {
  return { ...(ctx.facts?.root !== undefined ? { root: ctx.facts.root } : {}), cwd: call.cwd, caseInsensitive: caseInsensitiveOf(ctx) }
}

function pendingRules(l: UsageLedger, call: ToolCall, ctx: ReminderContext, src: PathRuleSource, files: readonly string[]): { file: string, ids: string[] } | undefined {
  const base = relBase(call, ctx)
  const ids: string[] = []
  let first: string | undefined
  for (const f of files) {
    if (typeof f !== 'string' || f.trim() === '') continue
    const rel = projectRelative(f, base)
    for (const id of matchPathRules(rel, src.rules)) {
      if (l.usedOnce.includes(ruleKey(id)) || ids.includes(id)) continue
      ids.push(id)
      first ??= rel
    }
  }
  return first !== undefined ? { file: first, ids } : undefined
}

function editTargets(call: ToolCall, ctx: ReminderContext): string[] {
  const input = isObj(call.input) ? call.input : {}
  const edited = editsOf(call, ctx).map(e => e.file)
  const more: unknown[] = [call.command, ...(Array.isArray(input['command']) ? input['command'] : [])]
  const text = call.kind === 'patch' ? patchText(call) ?? more.find((v): v is string => typeof v === 'string' && PATCH_TEXT.test(v)) : undefined
  const base = relBase(call, ctx)
  const gone = new Set(text !== undefined ? patchDeletes(text).map(p => projectRelative(p, base)) : [])
  const files = [...call.paths.filter(p => !gone.has(projectRelative(p, base))), ...edited]
  const named = str(input['file_path']) ?? str(input['filePath']) ?? str(input['path'])
  if (files.length === 0 && gone.size === 0 && named !== undefined) files.push(named)
  return [...new Set(files)]
}

const EDIT_TOOLS: Record<Harness, string> = { claude: 'the Edit or Write tool', codex: 'apply_patch', opencode: 'the edit, write or patch tool', omp: 'the edit or write tool' }
const READ_TOOLS: Partial<Record<Harness, string>> = { claude: 'the Read tool', opencode: 'the read tool', omp: 'the read tool' }
export const SHELL_READ_NUDGES = 3

function shellNudge(l: UsageLedger, call: ToolCall, base: UsageLedger, facts: WorkspaceFacts | undefined): ReminderResult | undefined {
  if (call.kind !== 'bash' || typeof call.command !== 'string' || call.tool === 'Monitor') return undefined
  const write = shellFileWrite(call.command, { cwd: call.cwd, ...(facts?.root !== undefined ? { root: facts.root } : {}), ...(facts?.home !== undefined ? { home: facts.home } : {}) })
  if (write !== undefined) {
    if (!canShow(l, 'shell-write', { max: 1 })) return undefined
    return {
      context: `Buracle: this shell command writes ${write.file !== undefined ? `\`${write.file}\`` : 'files'} (${write.label}). Make ordinary source edits with ${EDIT_TOOLS[call.harness]} instead: the user sees them as a diff, and Buracle's file checks (H04) run only on them. Keeping command output and running generators, formatters or codemods is fine; read the diff they leave.`,
      next: markShown(base, 'shell-write'),
    }
  }
  const tool = READ_TOOLS[call.harness]
  if (tool === undefined) return undefined
  const files = shellFileRead(call.command)
  if (files === undefined || !canShow(l, 'shell-read', { perTurn: true, max: SHELL_READ_NUDGES })) return undefined
  const shown = files.slice(0, 2).map(f => `\`${f}\``).join(', ')
  return {
    context: `Buracle: read ${shown} with ${tool} instead of printing ${files.length === 1 ? 'it' : 'them'} in the shell (cat, head, tail, sed -n): shell dumps clutter the user's terminal, and ${tool} gives line numbers you can edit from. Keep the shell for real processing (pipes, filters, scripts).`,
    next: markShown(base, 'shell-read'),
  }
}

function naturalLanguage(pattern: string): boolean {
  const p = pattern.trim()
  if (p.length < 12 || p.length > 200 || /[\\^$.*+?()[\]{}|]/.test(p)) return false
  const words = p.split(/\s+/)
  return words.length >= 3 && words.every(w => /^[A-Za-z][A-Za-z'-]*[,!?]?$/.test(w))
}

export function reminders(l: UsageLedger, call: ToolCall, ctx: ReminderContext): ReminderResult {
  const counted = ledgerCall(l, call)
  if (ctx.strictness === 'off') return { next: counted }
  const enforce = ctx.strictness === 'enforce'
  const remind = ctx.reminders !== false
  const available = new Set(ctx.available)
  const input = isObj(call.input) ? call.input : {}
  const rules = ctx.pathRules
  const ruleReads = rules !== undefined ? ruleFileReads(call, rules, caseInsensitiveOf(ctx)) : []
  const recorded = ruleReads.length > 0 ? markRules(counted, ruleReads) : counted

  const server = call.kind === 'mcp' ? call.mcp?.server : undefined
  const root = rootArgument(call)
  if (root !== undefined) {
    const value = input[root.key]
    const why = typeof value === 'string' ? rootProblem(value, ctx.facts) : undefined
    if (why !== undefined && typeof value === 'string') {
      const reason = `Buracle: ${rootCheckText(root.server, root.key, value, why, ctx.facts)}`
      if (enforce) return { deny: { reason, key: 'root' }, next: l }
      if (remind) return { context: reason, next: recorded }
    }
  }

  if (call.kind === 'edit' || call.kind === 'write' || call.kind === 'patch') {
    const hit = rules !== undefined && (enforce || remind) ? pendingRules(l, call, ctx, rules, editTargets(call, ctx)) : undefined
    const note = rules !== undefined && hit !== undefined ? pathRuleNote(enforce ? 'deny' : 'edit', hit.file, hit.ids, rules) : undefined
    if (note !== undefined && enforce) return { deny: { reason: note.text, key: ruleKey(note.delivered[0] as string) }, next: markRules(l, note.delivered) }
    const base = note !== undefined ? markRules(recorded, note.delivered) : recorded
    const withRules = (text: string): string => (note !== undefined ? `${note.text}\n\n${text}` : text)
    const edits = editsOf(call, ctx)
    const codegraph = available.has('codegraph') && ctx.facts?.codegraphIndexed === true
    const symbols: Array<{ sym: string, file: string }> = []
    for (const e of edits) for (const sym of changedExports(e.removed, e.added, e.file)) if (!l.symbols.includes(sym) && !symbols.some(s => s.sym === sym)) symbols.push({ sym, file: e.file })
    const list = (xs: string[]): string => xs.slice(0, 5).map(x => `\`${x}\``).join(', ') + (xs.length > 5 ? ` and ${xs.length - 5} more` : '')
    const fresh3 = symbols.filter(s => !l.usedOnce.includes(`R3:${s.sym}`))
    if (codegraph && enforce && fresh3.length > 0) {
      const names = fresh3.map(s => s.sym)
      const where = fresh3[0]?.file !== undefined && fresh3[0].file !== '' ? ` (${fresh3[0].file.split('/').slice(-2).join('/')})` : ''
      return { deny: { reason: `Buracle: this edit changes the exported ${list(names)}${where}, and codegraph has not been asked about ${names.length > 1 ? 'them' : 'it'} in this session. Check the callers first (codegraph callers or impact for ${list(names)}), then retry the edit; the retry is allowed.`, key: `R3:${names[0]}` }, next: { ...l, usedOnce: pushUnique(l.usedOnce, names.map(n => `R3:${n}`)) } }
    }
    const note3 = codegraph && enforce ? [] : symbols.filter(s => canShow(l, `R3:${s.sym}`, { max: 1 }))
    if (remind && note3.length > 0) {
      const names = note3.map(s => s.sym)
      const how = codegraph ? `codegraph callers or impact for ${list(names)}` : `\`rg -n "\\b${names[0]}\\b"\``
      return { context: withRules(`Buracle: this edit changes the exported ${list(names)}; check the callers (${how}) and update them in the same change.`), next: names.reduce((acc, n) => markShown(acc, `R3:${n}`), base) }
    }
    if (available.has('context7')) {
      const deps = new Set((ctx.deps ?? []).map(normDep))
      const pkgs: string[] = []
      for (const e of edits) {
        const had = new Set(importedPackages(e.removed, e.file))
        for (const pkg of importedPackages(e.added, e.file)) {
          if (!had.has(pkg) && !pkgs.includes(pkg) && gateable(pkg, e.file, deps) && !libResolved(l.libs, pkg)) pkgs.push(pkg)
        }
      }
      const fresh4 = pkgs.filter(p => !l.usedOnce.includes(`R4:${p}`))
      if (enforce && fresh4.length > 0) {
        return { deny: { reason: `Buracle: this edit adds an import of ${list(fresh4)}, and context7 has not been asked about ${fresh4.length > 1 ? 'them' : 'it'} in this session. Check the API at the version in the lockfile first (context7 resolve-library-id, then query-docs), then retry the edit; if context7 does not know a library, just retry.`, key: `R4:${fresh4[0]}` }, next: { ...l, usedOnce: pushUnique(l.usedOnce, fresh4.map(p => `R4:${p}`)) } }
      }
      const note4 = enforce ? [] : pkgs.filter(p => canShow(l, `R4:${p}`, { max: 1 }))
      if (remind && note4.length > 0) {
        return { context: withRules(`Buracle: this edit imports ${list(note4)}; check the API at the version in the lockfile with context7 (resolve-library-id, then query-docs).`), next: note4.reduce((acc, p) => markShown(acc, `R4:${p}`), base) }
      }
    }
    if (note !== undefined) return { context: note.text, next: base }
  }

  const readHit = rules?.onRead === true && call.kind === 'read' && ruleReads.length === 0 ? pendingRules(l, call, ctx, rules, call.paths) : undefined
  const readNote = (): ReminderResult | undefined => {
    const n = rules !== undefined && readHit !== undefined ? pathRuleNote('read', readHit.file, readHit.ids, rules) : undefined
    return n !== undefined ? { context: n.text, next: markRules(recorded, n.delivered) } : undefined
  }
  const shell = shellNudge(l, call, recorded, ctx.facts)
  if (!remind) return shell ?? (enforce ? readNote() : undefined) ?? { next: recorded }
  const turnOf = l.prompt?.turn === l.turn ? l.prompt.route : undefined

  if (turnOf?.memory.recall === true && l.turnTools.calls === 0 && l.turnTools.memory === 0 && !isMemoryCall(call) && canShow(l, 'memory-first', { perTurn: true, max: 50 })) {
    const how = available.has('buracle-memory') ? reminderText(ctx, 'memory') : 'run `buracle mem search "<query>"` (the memory server is unavailable)'
    return { context: `Buracle: this prompt asks about earlier work; before anything else, ${how}.`, next: markShown(recorded, 'memory-first') }
  }
  if (shell !== undefined) return shell
  const ruleNote = readNote()
  if (ruleNote !== undefined) return ruleNote
  const pattern = str(input['pattern']) ?? str(input['query'])
  if (call.kind === 'search' && pattern !== undefined && available.has('semble') && naturalLanguage(pattern) && canShow(l, 'semble-intent', { cooldownTurns: 3, max: 3, topic: 'code-search' })) {
    return { context: `Buracle: "${pattern.trim().slice(0, 80)}" reads like a question about intent: ${reminderText(ctx, 'code-search')}.`, next: markShown(recorded, 'semble-intent') }
  }
  const t = recorded.turnTools
  if (t.read.length >= 5 && t.graph === 0 && available.has('codegraph') && canShow(l, 'read-fanout', { perTurn: true, max: 2, topic: 'code-structure' })) {
    return { context: `Buracle: ${t.read.length} files read this turn without codegraph; to map how they connect, ${reminderText(ctx, 'code-structure')}.`, next: markShown(recorded, 'read-fanout') }
  }
  if (t.search >= 4 && t.graph === 0 && (available.has('semble') || available.has('codegraph')) && canShow(l, 'search-streak', { perTurn: true, max: 3, topic: 'code-search' })) {
    return { context: `Buracle: ${t.search} text searches this turn and no semble or codegraph call; ${reminderText(ctx, 'code-search')}, and ask codegraph for definitions and callers.`, next: markShown(recorded, 'search-streak') }
  }
  const urls = server === 'web-fetch' ? [urlIn(input)] : cmCall(call)?.tool === 'ctx_fetch_and_index' ? fetchUrls(input) : []
  const url = urls.find((u): u is string => u !== undefined && isDocsUrl(u))
  if (url !== undefined && available.has('context7') && canShow(l, 'docs-fetch', { cooldownTurns: 1, max: 3, topic: 'library-docs' })) {
    return { context: `Buracle: this is a library documentation page; for docs at the installed version, ${reminderText(ctx, 'library-docs')}.`, next: markShown(recorded, 'docs-fetch') }
  }
  return { next: recorded }
}

export function turnAudit(l: UsageLedger): StopDecision {
  const p = l.prompt
  if (p === undefined || p.audited === true || p.turn !== l.turn) return { action: 'allow' }
  for (const id of p.route.load) {
    const s = l.skills[id]
    if (s === undefined || s.turn < p.turn) {
      return { action: 'block', hook: 'H23', reason: `Buracle routing check: the user asked for ${id} and it was not loaded. Load it now and follow it, or say in one line why it does not apply.` }
    }
  }
  if (p.route.memory.recall && l.turnTools.memory === 0 && (l.mcp['buracle-memory']?.turn ?? -1) < p.turn) {
    const how = p.route.memory.cli === true ? '`buracle mem search "<query>"`' : 'memory_search (buracle-memory)'
    return { action: 'block', hook: 'H23', reason: `Buracle routing check: this prompt asks about earlier work and memory was not searched. Run ${how} now, or say in one line why memory cannot help.` }
  }
  return { action: 'allow' }
}

export function ledgerAudited(l: UsageLedger, _decision?: StopDecision): UsageLedger {
  if (l.prompt === undefined) return l
  return { ...l, prompt: { ...l.prompt, audited: true } }
}
