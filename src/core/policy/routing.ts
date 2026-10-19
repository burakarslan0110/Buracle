import { CM_SERVER_ID } from '../context-mode'
import type { Harness, PreDecision, ToolCall, ToolKind } from '../events'
import { mcpServerToken } from '../events'
import type { CatalogMcp, CatalogSkill } from '../catalog'
import { largeOutputKind } from './output-hints'
import { commandName, parseShell, stageCommands, unwrap } from './shell'
import type { Script } from './shell'
import type { Triggers } from './skill-router'

export interface RoutingPolicy { strictness: 'enforce'|'nudge'|'off'; categories: RoutingCategory[] }
export interface RoutingCategory { id: string; intent: string; prefer: string[]; fallback: string[]; deny_builtin: string[]; nudge?: string; reminder?: string; triggers?: Triggers }
export type McpHealth = Record<string, 'ok' | 'down' | 'unknown'>

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function healthEntry(v: unknown, nowMs: number): McpHealth[string] | undefined {
  if (v === 'ok' || v === 'down' || v === 'unknown') return v
  if (typeof v === 'boolean') return v ? 'ok' : 'down'
  if (!isObj(v)) return undefined
  if (typeof v['status'] !== 'string') return typeof v['ok'] === 'boolean' ? (v['ok'] ? 'ok' : 'down') : undefined
  const status = healthEntry(v['status'], nowMs)
  const until = typeof v['until'] === 'string' ? Date.parse(v['until']) : Number.NaN
  return status === 'down' && Number.isFinite(until) && until <= nowMs ? 'unknown' : status
}

export function mcpHealthOf(raw: unknown, nowMs: number): McpHealth {
  const out: McpHealth = {}
  if (!isObj(raw)) return out
  const table = isObj(raw['mcp']) ? raw['mcp'] : isObj(raw['servers']) ? raw['servers'] : raw
  for (const [id, v] of Object.entries(table)) {
    const s = healthEntry(v, nowMs)
    if (s !== undefined) out[id] = s
  }
  return out
}

export function withDisabledServers(health: McpHealth, ids: readonly string[]): McpHealth {
  const list = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== '') : []
  if (list.length === 0) return health
  const out: McpHealth = { ...(isObj(health) ? health : {}) }
  for (const id of list) out[id] = 'down'
  return out
}

export type RouteRef =
  | { kind: 'mcp', server: string, tool?: string }
  | { kind: 'cli', name: string }
  | { kind: 'builtin', tool: string }
  | { kind: 'skill', id: string }

const TOOL_KINDS: readonly ToolKind[] = ['bash', 'edit', 'write', 'patch', 'read', 'search', 'web_search', 'web_fetch', 'ask_user', 'plan_exit', 'plan_enter', 'todo', 'agent', 'mcp', 'eval', 'other']

export function parseRouteRef(ref: string): RouteRef | undefined {
  if (typeof ref !== 'string') return undefined
  const m = /^(mcp|cli|builtin|skill):([^\s/]+)(?:\/(\S+))?$/.exec(ref.trim())
  if (!m) return undefined
  const [, kind, name, tool] = m as unknown as [string, string, string, string | undefined]
  if (kind === 'mcp') return tool !== undefined ? { kind, server: name, tool } : { kind, server: name }
  if (tool !== undefined) return undefined
  if (kind === 'cli') return { kind, name }
  if (kind === 'skill') return { kind, id: name }
  return { kind: 'builtin', tool: name }
}

export const CLAUDE_PLUGIN_NAME = 'buracle'

function ompPart(s: string, fallback: string): string {
  const t = s.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  return t.length > 0 ? t : fallback
}

export function harnessMcpToolName(harness: Harness, server: string, tool: string): string {
  switch (harness) {
    case 'claude':
      return `mcp__plugin_${CLAUDE_PLUGIN_NAME}_${mcpServerToken('claude', server)}__${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`
    case 'codex':
      return `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, '_')
    case 'opencode':
      return `${mcpServerToken('opencode', server)}_${tool.replace(/[^A-Za-z0-9_-]/g, '_')}`
    case 'omp': {
      const s = mcpServerToken('omp', server)
      let t = ompPart(tool, 'tool')
      if (t.startsWith(`${s}_`) && t.length > s.length + 1) t = t.slice(s.length + 1)
      return `mcp__${s}_${t}`
    }
  }
}

export function harnessMcpPattern(harness: Harness, server: string): string {
  switch (harness) {
    case 'claude': return `mcp__plugin_${CLAUDE_PLUGIN_NAME}_${mcpServerToken('claude', server)}__*`
    case 'codex': return `mcp__${server.replace(/[^A-Za-z0-9_]/g, '_')}__*`
    case 'opencode': return `${mcpServerToken('opencode', server)}_*`
    case 'omp': return `mcp__${mcpServerToken('omp', server)}_*`
  }
}

const HARNESS_LABEL: Record<Harness, string> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', omp: 'Oh My Pi' }
const SKILL_HOWTO: Record<Harness, string> = {
  claude: 'the user starts a workflow with /<id>; you load the others with the Skill tool as buracle:<id>',
  codex: 'the user starts a workflow with $<id>; you load one by reading ~/.agents/skills/<id>/SKILL.md',
  opencode: 'the user starts a workflow with /<id>; you load one with the skill tool',
  omp: 'the user starts a workflow with /<id>; you load one by reading skill://<id>',
}
const MCP_SYNTAX: Record<Harness, string> = {
  claude: `mcp__plugin_${CLAUDE_PLUGIN_NAME}_<server>__<tool>`,
  codex: 'mcp__<server>__<tool>, with - written as _',
  opencode: '<server>_<tool>',
  omp: 'mcp__<server>_<tool>, lower-case with - written as _',
}
const HIDDEN_NOTE: Record<Harness, string> = {
  claude: '* = may be deferred: find its tools with tool search before assuming they are missing',
  codex: '* = may be deferred: find its tools with tool_search before assuming they are missing',
  opencode: '* = in Code Mode: its tools are not on your tool list; call them from a script run by the execute tool',
  omp: '* = may be an xd:// device instead of a tool: read xd:// to find it before assuming it is missing',
}
const BUILTIN_LABEL: Record<string, string> = { web_search: 'built-in web search', web_fetch: 'built-in web fetch' }

function code(s: string): string { return '`' + s + '`' }

interface Choice { ref?: RouteRef; down: string[] }

function choose(cat: RoutingCategory, kind: string, health: McpHealth): Choice {
  const down: string[] = []
  const refs = [...(Array.isArray(cat.prefer) ? cat.prefer : []), ...(Array.isArray(cat.fallback) ? cat.fallback : [])]
  for (const raw of refs) {
    const ref = parseRouteRef(raw)
    if (!ref) continue
    if (ref.kind === 'mcp') {
      if (health[ref.server] === 'down') { if (!down.includes(ref.server)) down.push(ref.server); continue }
      return { ref, down }
    }
    if (ref.kind === 'builtin' && ref.tool === kind) return { ref, down }
  }
  return { down }
}

function mcpTools(cat: RoutingCategory, server: string, harness: Harness): string[] {
  const names: string[] = []
  for (const raw of [...(Array.isArray(cat.prefer) ? cat.prefer : []), ...(Array.isArray(cat.fallback) ? cat.fallback : [])]) {
    const ref = parseRouteRef(raw)
    if (ref?.kind === 'mcp' && ref.server === server && ref.tool !== undefined) names.push(code(harnessMcpToolName(harness, server, ref.tool)))
  }
  return names.slice(0, 2)
}

function serverLabel(cat: RoutingCategory, ref: Extract<RouteRef, { kind: 'mcp' }>, harness: Harness): string {
  const tools = mcpTools(cat, ref.server, harness)
  if (tools.length === 0) return `the ${code(ref.server)} MCP server (${code(harnessMcpPattern(harness, ref.server))})`
  return tools.join(' then ')
}

function urlOf(call: ToolCall): string | undefined {
  const input = call.input !== null && typeof call.input === 'object' ? call.input : {}
  for (const k of ['url', 'uri', 'path']) {
    const v = input[k]
    if (typeof v === 'string' && /^https?:\/\//i.test(v)) return v
  }
  return undefined
}

function needsBuiltinSession(call: ToolCall): boolean {
  const url = urlOf(call)
  if (url === undefined) return false
  const host = /^https?:\/\/([^/?#:]+)/i.exec(url)?.[1]?.toLowerCase() ?? ''
  return host === 'claude.ai' || host.endsWith('.claude.ai')
}

export function isDocsUrl(url: string): boolean {
  const m = /^https?:\/\/([^/?#:]+)(?::\d+)?([^?#]*)/i.exec(typeof url === 'string' ? url.trim() : '')
  if (!m) return false
  const host = (m[1] ?? '').toLowerCase().replace(/\.$/, '')
  const path = (m[2] ?? '').toLowerCase()
  if (host === 'readthedocs.io' || host === 'readthedocs.org' || host.endsWith('.readthedocs.io') || host.endsWith('.readthedocs.org')) return true
  if (host.startsWith('docs.')) return true
  if ((host === 'www.npmjs.com' || host === 'npmjs.com') && path.startsWith('/package/')) return true
  if (host === 'pypi.org' && path.startsWith('/project/')) return true
  if (host === 'pkg.go.dev' || host === 'docs.rs') return true
  return host === 'developer.mozilla.org'
}

function docsFetchRoute(call: ToolCall, policy: RoutingPolicy, health: McpHealth): PreDecision | undefined {
  if (call.kind !== 'web_fetch') return undefined
  const url = urlOf(call)
  if (url === undefined || !isDocsUrl(url)) return undefined
  const cat = (Array.isArray(policy.categories) ? policy.categories : []).find(c => c.id === 'library-docs')
  if (!cat) return undefined
  const first = (Array.isArray(cat.prefer) ? cat.prefer : []).map(parseRouteRef).find((r): r is Extract<RouteRef, { kind: 'mcp' }> => r?.kind === 'mcp')
  if (first === undefined || health[first.server] === 'down') return undefined
  const docs = serverLabel(cat, first, call.harness)
  const fetchCat = policy.categories.find(c => Array.isArray(c.deny_builtin) && c.deny_builtin.includes('web_fetch'))
  const fallback = fetchCat ? choose(fetchCat, 'web_fetch', health).ref : undefined
  const builtin = BUILTIN_LABEL['web_fetch'] as string
  if (policy.strictness === 'enforce' && fallback?.kind === 'mcp') {
    return { action: 'deny', hook: 'H03', reason: `This page is library documentation: call ${docs} for the docs at the installed version instead of the ${builtin}; if context7 does not know the library, fetch the page with ${serverLabel(fetchCat as RoutingCategory, fallback, call.harness)}.` }
  }
  return { action: 'allow', context: [`This page is library documentation: ${docs} answers at the installed version; use the ${builtin} only when context7 does not know the library.`] }
}

function cmAvailable(policy: RoutingPolicy, health: McpHealth): boolean {
  if (health?.[CM_SERVER_ID] === 'down') return false
  return (Array.isArray(policy?.categories) ? policy.categories : []).some(c =>
    [...(Array.isArray(c.prefer) ? c.prefer : []), ...(Array.isArray(c.fallback) ? c.fallback : [])].some(r => {
      const ref = parseRouteRef(r)
      return ref?.kind === 'mcp' && ref.server === CM_SERVER_ID
    }))
}

function cmTool(harness: Harness, tool: string): string {
  return code(harnessMcpToolName(harness, CM_SERVER_ID, tool))
}

function sandboxHint(call: ToolCall, policy: RoutingPolicy, health: McpHealth): string | undefined {
  if (typeof call.command !== 'string' || !cmAvailable(policy, health)) return undefined
  const kind = largeOutputKind(call.command)
  if (kind === undefined) return undefined
  const h = call.harness
  return kind === 'remote'
    ? `This prints a remote response into your context. For a page or a long response, call ${cmTool(h, 'ctx_fetch_and_index')} and then ${cmTool(h, 'ctx_search')}; otherwise filter it here (jq, head) or run it in ${cmTool(h, 'ctx_execute')} (language: "shell") and print only what you need.`
    : `Build output is long: run the build in ${cmTool(h, 'ctx_execute')} (language: "shell") or ${cmTool(h, 'ctx_batch_execute')} and print only the summary counts and every failure with its message.`
}

export function routeTool(call: ToolCall, policy: RoutingPolicy, health: McpHealth): PreDecision {
  if (!policy || policy.strictness === 'off') return { action: 'allow' }
  if (call.kind === 'bash') {
    const nudge = typeof call.command === 'string' ? bashNudge(call.command) : undefined
    const hint = sandboxHint(call, policy, health ?? {})
    const context = [nudge, hint].filter((x): x is string => x !== undefined)
    return context.length > 0 ? { action: 'allow', context } : { action: 'allow' }
  }
  if (call.kind === 'mcp' || call.kind === 'eval' || call.kind === 'other') return { action: 'allow' }
  if (call.kind === 'web_fetch' && needsBuiltinSession(call)) return { action: 'allow' }
  const docsRoute = docsFetchRoute(call, policy, health ?? {})
  if (docsRoute !== undefined) return docsRoute
  const cats = (Array.isArray(policy.categories) ? policy.categories : []).filter(c => Array.isArray(c.deny_builtin) && c.deny_builtin.includes(call.kind))
  if (cats.length === 0) return { action: 'allow' }
  const builtin = BUILTIN_LABEL[call.kind] ?? `the built-in ${call.kind} tool`
  const redirects: string[] = []
  const nudges: string[] = []
  const notes: string[] = []
  let toCm = false
  for (const cat of cats) {
    const choice = choose(cat, call.kind, health ?? {})
    if (choice.ref?.kind === 'mcp') {
      redirects.push(serverLabel(cat, choice.ref, call.harness))
      if (choice.ref.server === CM_SERVER_ID) toCm = true
      if (typeof cat.nudge === 'string' && cat.nudge.trim() !== '') nudges.push(cat.nudge.trim())
    } else if (choice.down.length > 0) {
      notes.push(`The ${choice.down.map(code).join(', ')} MCP server is down, so the ${builtin} is allowed as a fallback; mention the fallback in your report.`)
    }
  }
  if (redirects.length === 0) return notes.length > 0 ? { action: 'allow', context: notes } : { action: 'allow' }
  const docs = libraryDocsHint(policy, call, health ?? {})
  const target = redirects.join(' or ')
  const longPage = call.kind !== 'web_fetch' || !cmAvailable(policy, health ?? {}) ? ''
    : toCm ? ` It indexes the page instead of returning it: query it with ${cmTool(call.harness, 'ctx_search')}.`
      : ` For a long page you need only parts of, call ${cmTool(call.harness, 'ctx_fetch_and_index')} and then ${cmTool(call.harness, 'ctx_search')} instead.`
  if (policy.strictness === 'enforce') {
    return { action: 'deny', hook: 'H03', reason: `The ${builtin} is disabled while the preferred MCP server is available: call ${target} instead${docs}.${longPage}` }
  }
  return { action: 'allow', context: [`Prefer ${target} over the ${builtin}${docs}.${longPage}`, ...nudges] }
}

function libraryDocsHint(policy: RoutingPolicy, call: ToolCall, health: McpHealth): string {
  if (call.kind !== 'web_search' && call.kind !== 'web_fetch') return ''
  const cat = (Array.isArray(policy.categories) ? policy.categories : []).find(c => c.id === 'library-docs')
  if (!cat) return ''
  const choice = choose(cat, '-', health)
  if (choice.ref?.kind !== 'mcp') return ''
  return ` (for library or framework docs, use ${serverLabel(cat, choice.ref, call.harness)} first)`
}

const GREP_FAMILY = new Set(['grep', 'egrep', 'fgrep', 'ggrep'])

function grepIsRecursive(argv: string[]): boolean {
  for (let k = 1; k < argv.length; k++) {
    const t = argv[k] as string
    if (t === '--') break
    if (t === '--recursive' || t === '--dereference-recursive' || t === '--directories=recurse') return true
    if ((t === '-d' || t === '--directories') && argv[k + 1] === 'recurse') return true
    if (/^-[A-Za-z]+$/.test(t)) {
      const letters = t.slice(1)
      for (let j = 0; j < letters.length; j++) {
        const ch = letters[j] as string
        if (ch === 'r' || ch === 'R') return true
        if ('efmABCdD'.includes(ch)) { if (j === letters.length - 1) k++; break }
      }
    }
  }
  return false
}

const NUDGE_GREP = 'Search with `rg -n "<pattern>" <dir>` instead of `grep -r` (faster, respects .gitignore); for code by intent use the semble MCP `search`, and for definitions and callers use codegraph.'
const NUDGE_FIND = 'Search with `rg -n "<pattern>" -g "<glob>"` instead of `find … | xargs grep` or `find -exec grep`; for code by intent use the semble MCP `search`, and for definitions and callers use codegraph.'

function scanScript(script: Script, depth: number): string | undefined {
  for (const pl of script.pipelines) {
    let sawFind = false
    for (const stage of pl.stages) {
      for (const cmd of stageCommands(stage)) {
        const first = commandName(cmd.words[0])
        const u = unwrap(cmd.words)
        const name = commandName(u.argv[0])
        const argv = u.argv.map(w => w.text)
        if (name === 'rgrep') return NUDGE_GREP
        if (name !== undefined && GREP_FAMILY.has(name)) {
          if (grepIsRecursive(argv)) return NUDGE_GREP
          if (sawFind && first === 'xargs') return NUDGE_FIND
        }
        if (name === 'find') {
          for (let k = 0; k < argv.length; k++) {
            if (['-exec', '-execdir', '-ok', '-okdir'].includes(argv[k] as string)) {
              const n = commandName(u.argv[k + 1])
              if (n !== undefined && GREP_FAMILY.has(n)) return NUDGE_FIND
            }
          }
          sawFind = true
        }
        if (depth < 4) {
          for (const s of u.scripts) {
            const inner = scanScript(parseShell(s).script, depth + 1)
            if (inner) return inner
          }
        }
      }
    }
  }
  return undefined
}

export function bashNudge(command: string): string | undefined {
  if (typeof command !== 'string' || command.trim() === '') return undefined
  try {
    const { script, subs } = parseShell(command)
    const direct = scanScript(script, 0)
    if (direct) return direct
    for (const s of subs) {
      const inner = scanScript(parseShell(s).script, 1)
      if (inner) return inner
    }
  } catch {
    return undefined
  }
  return undefined
}

export const CAPABILITY_CARD_MAX_LINES = 30

function firstClause(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim()
  let cut = t
  for (const sep of ['. ', ': ', '; ', ' — ']) {
    const at = t.indexOf(sep)
    if (at >= 20 && at < cut.length) cut = t.slice(0, at)
  }
  cut = cut.replace(/[.:;]+$/, '')
  if (cut.length <= max) return cut
  const room = cut.slice(0, max - 1)
  const space = room.lastIndexOf(' ')
  return `${(space > max / 2 ? room.slice(0, space) : room).replace(/[,;:\s]+$/, '')}…`
}

function wrapList(prefix: string, items: string[], width = 110): string[] {
  const lines: string[] = []
  let cur = prefix
  for (const [i, it] of items.entries()) {
    const piece = it + (i < items.length - 1 ? ',' : '')
    if (cur.length + 1 + piece.length > width && cur !== prefix) { lines.push(cur); cur = '  ' + piece }
    else cur = cur === prefix ? `${prefix} ${piece}` : `${cur} ${piece}`
  }
  lines.push(cur)
  return lines
}

function byId<T extends { id: string }>(xs: readonly T[]): T[] {
  const seen = new Set<string>()
  return [...xs].filter(x => x && typeof x.id === 'string').sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).filter(x => (seen.has(x.id) ? false : (seen.add(x.id), true)))
}

export function capabilityCard(input: { policy: RoutingPolicy, mcp: CatalogMcp[], skills: CatalogSkill[], plugins: string[], harness: Harness, lsp?: string[] }): string {
  const h = input.harness
  const hiddenNote = HIDDEN_NOTE[h]
  const servers = byId(Array.isArray(input.mcp) ? input.mcp : []).filter(m => !Array.isArray(m.harnesses) || m.harnesses.includes(h))
  const skills = byId(Array.isArray(input.skills) ? input.skills : [])
  const plugins = [...new Set((Array.isArray(input.plugins) ? input.plugins : []).filter(p => typeof p === 'string' && p.trim() !== '').map(p => p.trim().split('@')[0] as string))].sort()
  const strictness = input.policy?.strictness ?? 'enforce'

  const head = [
    `Buracle capabilities (${HARNESS_LABEL[h]}). ` + (strictness === 'enforce'
      ? 'Tool routing is enforced: follow "Tool routing (strict)" in your rules. Buracle names the skills and MCP servers each prompt calls for and holds a few calls until the right tool has run; when it denies a call, use the tool the denial names.'
      : strictness === 'nudge'
        ? 'Tool routing is advisory: follow "Tool routing (strict)" in your rules. Buracle names the skills and MCP servers each prompt calls for and adds reminders instead of denying calls.'
        : 'Tool routing hooks are off; still follow "Tool routing (strict)" in your rules.'),
  ]
  const mcpHeader = `MCP servers (tools are named ${MCP_SYNTAX[h]}${servers.some(s => !s.critical) ? `; ${hiddenNote}` : ''}):`
  const mcpLines = servers.map(s => `- ${s.id}${!s.critical ? '*' : ''}: ${firstClause(s.description ?? '', 80)}`)
  const skillHeader = `Skills (${SKILL_HOWTO[h]}):`
  const skillLines = skills.map(s => {
    const short = typeof s.short === 'string' && s.short.trim() !== '' ? firstClause(s.short, 90) : firstClause(s.description ?? '', 90)
    return `- ${s.id}: ${short}${s.invocation === 'explicit' ? ' (on request)' : ''}`
  })
  const pluginLine = plugins.length > 0 ? [`Plugins: ${plugins.join(', ')}`] : []
  const lsp = [...new Set((Array.isArray(input.lsp) ? input.lsp : []).filter(x => typeof x === 'string' && x.trim() !== '').map(x => x.trim()))].sort()
  if (lsp.length > 0) pluginLine.push(`Language servers (LSP tool: definitions, references, hover, diagnostics): ${lsp.join(', ')}`)

  const assemble = (mcpBlock: string[], skillBlock: string[]): string[] => [...head, ...mcpBlock, ...skillBlock, ...pluginLine]
  const fullMcp = servers.length > 0 ? [mcpHeader, ...mcpLines] : []
  const fullSkills = skills.length > 0 ? [skillHeader, ...skillLines] : []
  let lines = assemble(fullMcp, fullSkills)
  if (lines.length > CAPABILITY_CARD_MAX_LINES && skills.length > 0) {
    lines = assemble(fullMcp, wrapList(skillHeader, skills.map(s => s.id)))
  }
  if (lines.length > CAPABILITY_CARD_MAX_LINES && servers.length > 0) {
    const compactMcp = wrapList(`MCP servers (${MCP_SYNTAX[h]}):`, servers.map(s => s.id))
    lines = assemble(compactMcp, skills.length > 0 ? wrapList(skillHeader, skills.map(s => s.id)) : [])
  }
  if (lines.length > CAPABILITY_CARD_MAX_LINES) {
    const kept = lines.slice(0, CAPABILITY_CARD_MAX_LINES - 1)
    kept.push(`… ${lines.length - kept.length} more lines omitted (run buracle doctor for the full list)`)
    lines = kept
  }
  return lines.join('\n')
}

export function validateRoutingPolicy(x: unknown, knownServers?: readonly string[]): string[] {
  const errors: string[] = []
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return ['(root): expected a mapping']
  const p = x as Record<string, unknown>
  for (const k of Object.keys(p)) if (k !== 'strictness' && k !== 'categories') errors.push(`(root).${k}: unknown key`)
  if (!['enforce', 'nudge', 'off'].includes(p['strictness'] as string)) errors.push('strictness: expected enforce | nudge | off')
  const cats = p['categories']
  if (!Array.isArray(cats)) return [...errors, 'categories: expected a list']
  const ids = new Set<string>()
  cats.forEach((c, i) => {
    const at = `categories[${i}]`
    if (c === null || typeof c !== 'object' || Array.isArray(c)) { errors.push(`${at}: expected a mapping`); return }
    const cat = c as Record<string, unknown>
    for (const k of Object.keys(cat)) if (!['id', 'intent', 'prefer', 'fallback', 'deny_builtin', 'nudge', 'reminder', 'triggers'].includes(k)) errors.push(`${at}.${k}: unknown key`)
    const reminder = cat['reminder']
    if (reminder !== undefined && (typeof reminder !== 'string' || reminder.trim() === '' || reminder.length > 200)) errors.push(`${at}.reminder: expected one line of at most 200 characters`)
    const triggers = cat['triggers']
    if (triggers !== undefined) {
      if (triggers === null || typeof triggers !== 'object' || Array.isArray(triggers)) errors.push(`${at}.triggers: expected a mapping of topic, not, deps`)
      else for (const [k, v] of Object.entries(triggers)) {
        if (!['topic', 'not', 'deps'].includes(k)) errors.push(`${at}.triggers.${k}: unknown key`)
        else if (!Array.isArray(v) || !v.every(p => typeof p === 'string' && p.trim() !== '')) errors.push(`${at}.triggers.${k}: expected a list of phrases`)
      }
    }
    const id = cat['id']
    if (typeof id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(id)) errors.push(`${at}.id: expected a kebab-case id`)
    else if (ids.has(id)) errors.push(`${at}.id: duplicate ${JSON.stringify(id)}`)
    else ids.add(id)
    if (typeof cat['intent'] !== 'string' || (cat['intent'] as string).trim() === '') errors.push(`${at}.intent: required string`)
    for (const key of ['prefer', 'fallback'] as const) {
      const list = cat[key]
      if (!Array.isArray(list)) { errors.push(`${at}.${key}: expected a list`); continue }
      list.forEach((r, j) => {
        const ref = parseRouteRef(r as string)
        if (!ref) errors.push(`${at}.${key}[${j}]: expected mcp:<server>[/<tool>], cli:<name>, builtin:<kind> or skill:<id>`)
        else if (ref.kind === 'mcp' && knownServers && !knownServers.includes(ref.server)) errors.push(`${at}.${key}[${j}]: unknown MCP server ${JSON.stringify(ref.server)}`)
        else if (ref.kind === 'builtin' && !(TOOL_KINDS as readonly string[]).includes(ref.tool)) errors.push(`${at}.${key}[${j}]: unknown tool kind ${JSON.stringify(ref.tool)}`)
      })
    }
    if (Array.isArray(cat['prefer']) && cat['prefer'].length === 0) errors.push(`${at}.prefer: must name at least one tool`)
    const deny = cat['deny_builtin']
    if (!Array.isArray(deny)) errors.push(`${at}.deny_builtin: expected a list`)
    else deny.forEach((d, j) => {
      if (!(TOOL_KINDS as readonly string[]).includes(d as string) || d === 'mcp' || d === 'other') errors.push(`${at}.deny_builtin[${j}]: expected a built-in tool kind`)
    })
    if (cat['nudge'] !== undefined && (typeof cat['nudge'] !== 'string' || cat['nudge'].trim() === '')) errors.push(`${at}.nudge: expected a non-empty string`)
  })
  return errors
}
