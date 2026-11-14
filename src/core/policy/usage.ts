import type { Harness, StopDecision, ToolCall } from '../events'
import type { IndexExclusionContext } from '../workspace'
import { indexExclusion, isPathWithin, pathKey } from '../workspace'
import { patchDeletes, patchEdits } from './code-facts'
import type { PathRuleSource } from './path-rules'
import { matchPathRules, pathRuleNote, projectRelative, ruleFileId } from './path-rules'
import type { McpHealth, RoutingPolicy } from './routing'
import { isDocsUrl } from './routing'
import type { PromptRoute } from './skill-router'
import { categoryReminder } from './skill-router'
import type { ShellWord } from './shell'
import { commandName, DYN, HOME, parseShell, simpleCommands, unwrap } from './shell'

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
  return { v: 1, turn: 0, mcp: {}, skills: {}, turnTools: emptyTurn(), streak: { search: 0 }, shown: {}, usedOnce: [] }
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
  return call.kind === 'bash' && typeof call.command === 'string' && searchesText(call.command)
}

function memoryCliOps(call: ToolCall): string[] {
  if (call.kind !== 'bash' || typeof call.command !== 'string') return []
  return shellArgv(call.command).filter(a => a[0] === 'buracle' && a[1] === 'mem').map(a => a[2] ?? '')
}

function isMemoryCli(call: ToolCall): boolean {
  return memoryCliOps(call).some(op => ['search', 'get', 'timeline', 'status', 'update'].includes(op))
}

export function ledgerCall(l: UsageLedger, call: ToolCall): UsageLedger {
  const turn = l.turn
  const t: TurnTools = { ...l.turnTools, calls: l.turnTools.calls + 1, read: [...l.turnTools.read] }
  const next: UsageLedger = { ...l, turnTools: t, streak: { ...l.streak } }
  const skill = skillOf(call, call.harness)
  if (skill !== undefined) next.skills = bump(l.skills, skill, turn)
  const server = call.kind === 'mcp' ? call.mcp?.server : undefined
  if (server !== undefined && server !== '') {
    next.mcp = bump(l.mcp, server, turn)
    if (server === 'semble' || server === 'codegraph') { t.graph++; next.streak.search = 0 }
    if (server === 'buracle-memory') t.memory++
  }
  if (isMemoryCli(call)) { next.mcp = bump(next.mcp, 'buracle-memory', turn); t.memory++ }
  if (isTextSearch(call)) { t.search++; next.streak.search++ }
  if (call.kind === 'read') for (const p of call.paths ?? []) if (!t.read.includes(p) && t.read.length < READ_MAX) t.read.push(p)
  return next
}

export const MCP_SESSION_DOWN_ERRORS = 2

export function ledgerMcpResult(l: UsageLedger, server: string, ok: boolean): UsageLedger {
  if (typeof server !== 'string' || server === '') return l
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
  // A server that is off stays off: errors from calls made before it was turned off do not bring it back as down.
  for (const id of failing) if (out[id] !== 'off') out[id] = 'down'
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
  pathRules?: PathRuleSource
}

export interface ReminderResult {
  context?: string
  deny?: { reason: string; key: string }
  next: UsageLedger
}

function reminderText(ctx: ReminderContext, category: string): string {
  return categoryReminder(ctx.policy, category) ?? ''
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

function rootArgument(call: ToolCall): { server: string, key: string } | undefined {
  const server = call.kind === 'mcp' ? call.mcp?.server : undefined
  if (server === 'semble') return { server, key: 'repo' }
  if (server === 'codegraph') return { server, key: 'projectPath' }
  return undefined
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
    if (note !== undefined) return { context: note.text, next: base }
  }

  const readHit = rules?.onRead === true && call.kind === 'read' && ruleReads.length === 0 ? pendingRules(l, call, ctx, rules, call.paths) : undefined
  const readNote = (): ReminderResult | undefined => {
    const n = rules !== undefined && readHit !== undefined ? pathRuleNote('read', readHit.file, readHit.ids, rules) : undefined
    return n !== undefined ? { context: n.text, next: markRules(recorded, n.delivered) } : undefined
  }
  if (!remind) return (enforce ? readNote() : undefined) ?? { next: recorded }
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
  const url = server === 'web-fetch' ? [urlIn(input)].find((u): u is string => u !== undefined && isDocsUrl(u)) : undefined
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
  return { action: 'allow' }
}

export function ledgerAudited(l: UsageLedger, _decision?: StopDecision): UsageLedger {
  if (l.prompt === undefined) return l
  return { ...l, prompt: { ...l.prompt, audited: true } }
}
