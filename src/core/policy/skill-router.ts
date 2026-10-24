import type { CatalogSkill } from '../catalog'
import type { Harness } from '../events'
import { detectSignals, isUserText } from './intents'
import type { RoutingCategory, RoutingPolicy } from './routing'
import { parseRouteRef } from './routing'
import { fold, stripQuoted } from './text'

export interface Triggers {
  ask?: string[]
  topic?: string[]
  not?: string[]
  deps?: string[]
}

export interface SkillTriggerTable { skills: Record<string, Triggers>; categories: Record<string, Triggers> }

const TRIGGER_FIELDS = ['ask', 'topic', 'not', 'deps'] as const
type TriggerField = typeof TRIGGER_FIELDS[number]
const LANG = /^[a-z]{2}$/

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function phraseList(x: unknown, at: string, errors: string[]): string[] {
  const out: string[] = []
  const take = (list: unknown, where: string): void => {
    if (!Array.isArray(list)) { errors.push(`${where}: expected a list of phrases`); return }
    list.forEach((p, i) => {
      if (typeof p !== 'string' || p.trim() === '') { errors.push(`${where}[${i}]: expected a non-empty string`); return }
      const problem = phraseProblem(p)
      if (problem !== undefined) errors.push(`${where}[${i}]: ${problem}`)
      else out.push(p.trim())
    })
  }
  if (isObj(x)) {
    for (const [lang, list] of Object.entries(x)) {
      if (!LANG.test(lang)) errors.push(`${at}.${lang}: expected a two-letter language code`)
      else take(list, `${at}.${lang}`)
    }
  } else take(x, at)
  return out
}

function phraseProblem(p: string): string | undefined {
  const t = p.trim()
  if (t.startsWith('re:')) {
    try { new RegExp(t.slice(3).trim()) } catch { return `invalid regular expression ${JSON.stringify(t)}` }
    return t.slice(3).trim() === '' ? 'empty regular expression' : undefined
  }
  if (/[A-Z]/.test(t)) return `write phrases in lower case (${JSON.stringify(t)})`
  if (/\*(?=[^\s,;:!?])/.test(t)) return `* may only end a word (${JSON.stringify(t)})`
  return undefined
}

function triggersOf(x: unknown, at: string, errors: string[], allowed: readonly TriggerField[]): Triggers {
  const out: Triggers = {}
  if (!isObj(x)) { errors.push(`${at}: expected a mapping of ${allowed.join(', ')}`); return out }
  for (const k of Object.keys(x)) if (!(allowed as readonly string[]).includes(k)) errors.push(`${at}.${k}: unknown key`)
  for (const k of allowed) {
    if (x[k] === undefined) continue
    const list = phraseList(x[k], `${at}.${k}`, errors)
    if (list.length > 0) out[k] = list
  }
  return out
}

export function parseSkillTriggers(x: unknown): { table: SkillTriggerTable, errors: string[] } {
  const errors: string[] = []
  const table: SkillTriggerTable = { skills: {}, categories: {} }
  if (!isObj(x)) return { table, errors: ['(root): expected a mapping with version, skills and categories'] }
  for (const k of Object.keys(x)) if (!['version', 'skills', 'categories'].includes(k)) errors.push(`(root).${k}: unknown key`)
  if (x['version'] !== 1) errors.push('version: expected 1')
  for (const [section, allowed] of [['skills', ['ask', 'topic', 'not']], ['categories', ['topic', 'not', 'deps']]] as const) {
    const raw = x[section]
    if (raw === undefined) continue
    if (!isObj(raw)) { errors.push(`${section}: expected a mapping of id -> triggers`); continue }
    for (const [id, t] of Object.entries(raw)) {
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) { errors.push(`${section}.${id}: expected a kebab-case id`); continue }
      table[section][id] = triggersOf(t, `${section}.${id}`, errors, allowed)
    }
  }
  return { table, errors }
}

export function validateSkillTriggers(x: unknown, known: { skills?: ReadonlyArray<{ id: string, invocation?: string, userInvocable?: boolean }>, categories?: readonly string[] } = {}): string[] {
  const { table, errors } = parseSkillTriggers(x)
  const skills = known.skills
  if (skills !== undefined) {
    const byId = new Map(skills.map(s => [s.id, s]))
    for (const id of Object.keys(table.skills)) {
      const s = byId.get(id)
      if (s === undefined) errors.push(`skills.${id}: no canonical skill has this id`)
      else if (s.invocation === 'explicit' && table.skills[id]?.topic !== undefined) errors.push(`skills.${id}.topic: ${id} is explicit-only, so topics never load it (use ask)`)
    }
    const raw = isObj(x) && isObj(x['skills']) ? x['skills'] : {}
    for (const s of skills) {
      if (s.userInvocable === false) continue
      const ask = isObj(raw[s.id]) ? (raw[s.id] as Record<string, unknown>)['ask'] : undefined
      for (const lang of ['en', 'tr']) {
        const list = isObj(ask) ? ask[lang] : undefined
        if (!Array.isArray(list) || list.length === 0) errors.push(`skills.${s.id}.ask.${lang}: every workflow skill needs explicit-request phrases in ${lang === 'en' ? 'English' : 'Turkish'}`)
      }
    }
  }
  if (known.categories !== undefined) {
    for (const id of Object.keys(table.categories)) if (!known.categories.includes(id)) errors.push(`categories.${id}: no routing category has this id`)
  }
  return errors
}

const B0 = "(?<![a-z0-9_'-])"
const B1 = "(?![a-z0-9_'-])"
const SEP = '[\\s,;:!?]+'
const TR_SUFFIX = "(?:'(?:y?[iu]|n[iu]|s[iu]|s?[iu]n[iu]|l[ae]r[iu](?:n[iu])?))?"

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function phraseSource(phrase: string): string | undefined {
  const t = phrase.trim()
  if (t.startsWith('re:')) {
    const src = t.slice(3).trim()
    if (src === '') return undefined
    try { new RegExp(src) } catch { return undefined }
    return `(?:${src})`
  }
  const words = fold(t).split(/[\s,;:!?]+/).filter(w => w !== '')
  if (words.length === 0) return undefined
  const parts = words.map(w => {
    const stem = w.endsWith('*')
    const body = escapeRe(stem ? w.slice(0, -1) : w)
    return stem ? `${body}[a-z0-9_']*` : `${body}${TR_SUFFIX}`
  })
  return `${B0}${parts.join(SEP)}${B1}`
}

function compileList(phrases: readonly string[] | undefined): RegExp | undefined {
  if (phrases === undefined || phrases.length === 0) return undefined
  const sources = [...new Set(phrases.map(phraseSource).filter((s): s is string => s !== undefined))]
  if (sources.length === 0) return undefined
  sources.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))
  try { return new RegExp(sources.join('|')) } catch { return undefined }
}

function generatedAsks(id: string): string[] {
  const x = escapeRe(id)
  const verbsTr = '(?:yap|coz|duzelt|hallet|gelistir|uygula)'
  const name = `(?:the\\s+|a\\s+|buracle(?:'s)?\\s+)?${x}\\s+(?:skill|workflow)${B1}`
  const byWay = `(?:^|[\\n.!?;:]\\s*|${B0}(?:do|handle|solve|tackle|implement|build|fix|approach|go|proceed|continue|work|run|start)\\s+(?:(?:it|this|that|them|these|those|on\\s+(?:it|this|that))\\s+)?)`
  return [
    `re:${B0}(?:use|run|start|invoke|launch|follow|apply)\\s+${name}`,
    `re:${byWay}(?:with|via|through|using)\\s+${name}`,
    `re:${B0}${x}\\s+(?:skill|workflow)'?(?:i|ini|u|unu|yi|yu)?\\s+(?:kullan|calistir|baslat)[a-z']*`,
    `re:${B0}${x}\\s+ile\\s+${verbsTr}[a-z']*`,
    `re:${B0}${x}\\s+(?:skill|workflow)'?(?:i|u)?(?:yla|yle|la|le)${B1}`,
    `re:${B0}${x}\\s+akis(?:iyla|ini\\s+(?:kullan|baslat|calistir|izle|takip)[a-z']*)`,
  ]
}

export interface CompiledSkill {
  id: string
  explicit: boolean
  userInvocable: boolean
  short: string
  ask?: RegExp
  topic?: RegExp
  not?: RegExp
}
export interface CompiledCategory {
  id: string
  servers: string[]
  topic?: RegExp
  not?: RegExp
  deps?: RegExp
}
export interface CompiledTriggers { skills: CompiledSkill[]; categories: CompiledCategory[] }

function shortOf(s: CatalogSkill): string {
  const src = (typeof s.short === 'string' && s.short.trim() !== '' ? s.short : s.description ?? '').replace(/\s+/g, ' ').trim()
  const cut = /^(.{20,}?)(?:\. |: |; )/.exec(src)?.[1] ?? src
  return cut.length > 80 ? `${cut.slice(0, 79).replace(/[\s,;:]+\S*$/, '')}...` : cut.replace(/[.:;]+$/, '')
}

function preferServers(cat: RoutingCategory): string[] {
  const out: string[] = []
  for (const raw of Array.isArray(cat.prefer) ? cat.prefer : []) {
    const ref = parseRouteRef(raw)
    if (ref?.kind === 'mcp' && !out.includes(ref.server)) out.push(ref.server)
  }
  return out
}

export function compileTriggers(skills: readonly CatalogSkill[], policy: RoutingPolicy): CompiledTriggers {
  const list = [...(Array.isArray(skills) ? skills : [])].filter(s => s && typeof s.id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(s.id))
  list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const seen = new Set<string>()
  const out: CompiledTriggers = { skills: [], categories: [] }
  for (const s of list) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    const explicit = s.invocation === 'explicit'
    const t = s.triggers ?? {}
    const entry: CompiledSkill = { id: s.id, explicit, userInvocable: s.userInvocable !== false, short: shortOf(s) }
    const ask = compileList([...generatedAsks(s.id), ...(t.ask ?? [])])
    if (ask) entry.ask = ask
    const topic = explicit ? undefined : compileList(t.topic)
    if (topic) entry.topic = topic
    const not = compileList(t.not)
    if (not) entry.not = not
    out.skills.push(entry)
  }
  for (const cat of Array.isArray(policy?.categories) ? policy.categories : []) {
    const t = cat.triggers
    if (t === undefined) continue
    const entry: CompiledCategory = { id: cat.id, servers: preferServers(cat) }
    const topic = compileList(t.topic)
    if (topic) entry.topic = topic
    const not = compileList(t.not)
    if (not) entry.not = not
    const deps = compileList(t.deps)
    if (deps) entry.deps = deps
    if (entry.topic !== undefined || entry.deps !== undefined) out.categories.push(entry)
  }
  return out
}

export interface PromptRoute {
  invoked: string[]
  load: string[]
  candidates: string[]
  categories: string[]
  memory: { recall: boolean; write: boolean; cli?: boolean }
  libs?: string[]
}

export interface RouteOptions {
  harness: Harness
  loaded: readonly string[]
  available: readonly string[]
  deps?: readonly string[]
}

export const ROUTE_CAPS = { load: 1, candidates: 2, categories: 2 } as const
const MAX_TEXT = 12_000

const WORD_DEPS = new Set(['next', 'debug', 'path', 'events', 'util', 'utils', 'test', 'core', 'types', 'common', 'shared', 'open', 'request', 'config', 'app', 'api', 'server', 'client', 'lib', 'main', 'index'])
const ORDINARY_PARTS = new Set([
  ...WORD_DEPS, 'errors', 'sync', 'net', 'text', 'time', 'log', 'sys', 'exp', 'tools', 'term', 'mod', 'image', 'http', 'json', 'sql',
  'mock', 'assert', 'require', 'context', 'crypto', 'framework', 'console', 'kit', 'cli', 'sdk', 'go', 'node',
])

function emptyRoute(): PromptRoute {
  return { invoked: [], load: [], candidates: [], categories: [], memory: { recall: false, write: false } }
}

function explicitSyntax(text: string, ids: ReadonlySet<string>, invocable: ReadonlySet<string>, h: Harness): { invoked: string[], asked: string[] } {
  const invoked: string[] = []
  const asked: string[] = []
  const add = (id: string | undefined, native: boolean): void => {
    if (id === undefined || !ids.has(id)) return
    const list = native ? invoked : asked
    if (!list.includes(id) && !invoked.includes(id)) list.push(id)
  }
  const trimmed = text.trim()
  for (const m of trimmed.matchAll(/<command-name>\s*\/?(buracle:)?([a-z0-9-]+)\s*<\/command-name>/g)) {
    if (m[1] !== undefined || invocable.has(m[2] ?? '')) add(m[2], h === 'claude')
  }
  const lead = /^\/(?:(buracle|skill):)?([a-z0-9][a-z0-9-]*)(?=\s|$)/.exec(trimmed)
  if (lead && (lead[1] !== undefined || invocable.has(lead[2] ?? ''))) {
    const ns = lead[1]
    add(lead[2], ns === 'buracle' ? h === 'claude' : ns === 'skill' ? h === 'omp' : h !== 'codex')
  }
  const lead$ = /^\$([a-z0-9][a-z0-9-]*)(?=\s|$)/.exec(trimmed)
  if (lead$) add(lead$[1], h === 'codex')
  if (h === 'codex') for (const m of trimmed.matchAll(/(?:^|\s)\$([a-z0-9][a-z0-9-]*)(?![\w-])/g)) add(m[1], true)
  if (h === 'opencode') for (const m of trimmed.matchAll(/(?:^|\s)@([a-z0-9][a-z0-9-]*)(?![\w./-])/g)) add(m[1], true)
  return { invoked, asked }
}

function depVariants(name: string): string[] {
  const n = fold(name)
  if (n.length < 2) return []
  const out = new Set<string>()
  const whole = (v: string): void => {
    if (v.length < 2) return
    if (WORD_DEPS.has(v)) { out.add(`${v}.js`); out.add(`${v}js`) }
    else if (v.length >= 3 || /[^a-z]/.test(v)) out.add(v)
  }
  const part = (v: string): void => { if (v.length >= 3 && !ORDINARY_PARTS.has(v)) out.add(v) }
  whole(n)
  const scoped = /^@([^/]+)\/(.+)$/.exec(n)
  if (scoped !== null) {
    if (scoped[1] === 'types') return [...out]
    whole(scoped[2] ?? '')
    part(scoped[1] ?? '')
  } else if (n.includes('/')) {
    const segs = n.split('/').filter(s => s !== '')
    const host = segs[0]?.includes('.') === true
    let rest = host ? segs.slice(1) : segs
    while (rest.length > 1 && /^v\d+$/.test(rest[rest.length - 1] ?? '')) rest = rest.slice(0, -1)
    const last = (rest[rest.length - 1] ?? '').replace(/\.v\d+$/, '')
    part(last)
    part(last.replace(/^go-|-go$/g, ''))
    if (!host && rest.length === 2) part(rest[0] ?? '')
  }
  for (const v of [...out]) {
    if (v.includes('-') && !v.includes('/') && v.split('-').every(p => p.length >= 3)) out.add(v.replace(/-/g, ' '))
    const bare = /^([a-z][a-z0-9-]{4,}?)(?:css|[.-]?js)$/.exec(v)?.[1]
    if (bare !== undefined) part(bare)
  }
  return [...out]
}

function namedDeps(f: string, deps: readonly string[] | undefined): { names: string[], at: number } {
  if (deps === undefined || deps.length === 0) return { names: [], at: -1 }
  const hits: Array<{ name: string, at: number, len: number, own: boolean }> = []
  for (const d of new Set(deps)) {
    if (typeof d !== 'string') continue
    for (const v of depVariants(d)) {
      if (!f.includes(v)) continue
      const m = new RegExp(`(?<![a-z0-9_'@/.-])${escapeRe(v)}(?:\\.js)?(?=$|'[a-z]{0,6}(?![a-z0-9])|[^a-z0-9_'.-]|\\.(?![a-z0-9]))`).exec(f)
      if (m) { hits.push({ name: d, at: m.index, len: m[0].length, own: v === fold(d) }); break }
    }
  }
  hits.sort((a, b) => a.at - b.at || b.len - a.len || Number(b.own) - Number(a.own) || (a.name < b.name ? -1 : 1))
  const names = hits.filter((h, i) => i === 0 || hits[i - 1]?.at !== h.at).slice(0, 3).map(x => x.name)
  return { names, at: hits[0]?.at ?? -1 }
}

export function routePrompt(text: string, t: CompiledTriggers, o: RouteOptions): PromptRoute {
  const route = emptyRoute()
  if (typeof text !== 'string' || t === undefined || t === null) return route
  const raw = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 2_000)}\n${text.slice(-2_000)}` : text
  const skills = Array.isArray(t.skills) ? t.skills : []
  const byId = new Map(skills.map(s => [s.id, s]))
  const syntax = explicitSyntax(stripQuoted(raw), new Set(byId.keys()), new Set(skills.filter(s => s.userInvocable).map(s => s.id)), o.harness)
  route.invoked = syntax.invoked
  if (!isUserText(raw)) {
    return route
  }
  const body = raw.trim().replace(/^[/$](?:[a-z]+:)?[a-z0-9][a-z0-9-]*(?=\s|$)/, ' ')
  const f = fold(stripQuoted(body))
  const loaded = new Set(Array.isArray(o.loaded) ? o.loaded : [])
  const available = new Set(Array.isArray(o.available) ? o.available : [])

  const asks: Array<{ id: string, at: number }> = syntax.asked.map(id => ({ id, at: -1 }))
  const topics: Array<{ id: string, at: number }> = []
  for (const s of skills) {
    if (route.invoked.includes(s.id) || asks.some(a => a.id === s.id)) continue
    if (s.not?.test(f)) continue
    const a = s.ask?.exec(f)
    if (a) { asks.push({ id: s.id, at: a.index }); continue }
    const tp = s.explicit ? null : s.topic?.exec(f)
    if (tp) topics.push({ id: s.id, at: tp.index })
  }
  const order = (a: { id: string, at: number }, b: { id: string, at: number }): number => a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  asks.sort(order)
  topics.sort(order)
  const candidates: string[] = []
  for (const a of asks) {
    const s = byId.get(a.id)
    if (loaded.has(a.id) && s?.explicit !== true) continue
    if (route.load.length < ROUTE_CAPS.load) route.load.push(a.id)
    else if (s !== undefined && !s.explicit) candidates.push(a.id)
  }
  const workflow = [...route.invoked, ...route.load].some(id => byId.get(id)?.explicit === true)
  if (!workflow) {
    for (const tp of topics) if (!loaded.has(tp.id) && !route.load.includes(tp.id) && !candidates.includes(tp.id)) candidates.push(tp.id)
    route.candidates = candidates.slice(0, ROUTE_CAPS.candidates)
  }

  const signals = detectSignals(raw)
  route.memory = { recall: signals.recall, write: signals.write }
  if ((signals.recall || signals.write) && !available.has('buracle-memory')) route.memory.cli = true
  const cats: Array<{ id: string, at: number, end: number, lead?: boolean }> = []
  let docs: { id: string, at: number, end: number, lead?: boolean } | undefined
  let libAt = -1
  for (const c of Array.isArray(t.categories) ? t.categories : []) {
    const first = c.servers[0]
    if (first === undefined || !available.has(first)) continue
    if (c.id === 'memory' && (signals.recall || signals.write)) continue
    if (c.not?.test(f)) continue
    const m = c.topic?.exec(f)
    let at = m?.index ?? -1
    const end = m !== null && m !== undefined ? m.index + m[0].length : -1
    let deps = false
    if (c.deps !== undefined) {
      const named = namedDeps(f, o.deps)
      if (named.names.length > 0 && c.deps.test(f)) {
        route.libs = named.names
        at = at < 0 ? named.at : Math.min(at, named.at)
        libAt = named.at
        deps = true
      }
    }
    if (at < 0) continue
    const hit = { id: c.id, at, end }
    cats.push(hit)
    if (deps) docs = hit
  }
  if (docs !== undefined) {
    for (const c of cats) if (c !== docs && c.at < docs.at && c.at <= libAt && libAt < c.end) { docs.at = c.at; docs.lead = true }
  }
  cats.sort((a, b) => a.at - b.at || (a.lead === b.lead ? 0 : a.lead === true ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  route.categories = cats.slice(0, ROUTE_CAPS.categories).map(c => c.id)
  if (route.libs !== undefined && !route.categories.some(id => t.categories.find(c => c.id === id)?.deps !== undefined)) delete route.libs
  return route
}

export const ROUTE_TEXT_MAX_BYTES = 600
export const PROMPT_CONTEXT_MAX_CHARS = 1_500
export const ROUTE_HEADER = 'Buracle routing for this prompt:'

export interface RouteTextOptions {
  triggers?: CompiledTriggers
  skillFile?: (id: string) => string | undefined
  attached?: readonly string[]
}

export function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) { n += 4; i++ }
    else n += 3
  }
  return n
}

function loadHow(h: Harness, id: string, explicit: boolean, file: string | undefined): string {
  switch (h) {
    case 'claude':
      if (!explicit) return `Skill tool, buracle:${id}`
      return `read ${file ?? `skills/${id}/SKILL.md in the Buracle plugin`}`
    case 'codex': return `read ~/.agents/skills/${id}/SKILL.md`
    case 'opencode': return `skill tool, ${id}`
    case 'omp': return `read skill://${id}`
  }
}

const CANDIDATE_HOW: Record<Harness, string> = {
  claude: 'Skill tool, buracle:<id>',
  codex: 'read ~/.agents/skills/<id>/SKILL.md',
  opencode: 'skill tool',
  omp: 'read skill://<id>',
}

const CATEGORY_LABEL: Record<string, string> = {
  'library-docs': 'Library docs', 'web-search': 'Web search', 'web-fetch': 'Web pages', 'code-examples': 'Public code examples',
  'code-search': 'Code search', 'code-structure': 'Code structure', browser: 'Browser', memory: 'Memory',
}

function labelOf(id: string): string {
  const l = CATEGORY_LABEL[id]
  if (l !== undefined) return l
  const words = id.replace(/-/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function categoryReminder(policy: RoutingPolicy | undefined, id: string): string | undefined {
  const cat = (Array.isArray(policy?.categories) ? policy.categories : []).find(c => c.id === id)
  const text = typeof cat?.reminder === 'string' && cat.reminder.trim() !== '' ? cat.reminder : cat?.nudge
  return typeof text === 'string' && text.trim() !== '' ? text.trim().replace(/[.\s]+$/, '') : undefined
}

export function routeText(r: PromptRoute, h: Harness, policy: RoutingPolicy, opts: RouteTextOptions = {}): string | undefined {
  if (r === undefined || r === null) return undefined
  const skill = (id: string): CompiledSkill | undefined => opts.triggers?.skills.find(s => s.id === id)
  const lines: Array<{ text: string, must: boolean }> = []
  for (const id of (r.load ?? []).slice(0, ROUTE_CAPS.load)) {
    const s = skill(id)
    const file = opts.skillFile?.(id)
    const explicit = s?.explicit ?? file !== undefined
    const asked = `- The user asked for the ${id} ${explicit ? 'workflow' : 'skill'}`
    lines.push({ must: true, text: opts.attached?.includes(id) === true
      ? `${asked}: its skill is attached to this message; follow it, and treat the rest of the prompt as its input.`
      : `${asked}: load it before any other step and follow it (${loadHow(h, id, explicit, file)}); the rest of the prompt is its input.` })
  }
  const mem = r.memory ?? { recall: false, write: false }
  if (mem.recall) {
    lines.push({ must: false, text: mem.cli === true
      ? '- Earlier work: search memory first (`buracle mem search "<query>"`; the memory server is unavailable) and cite the note ids you use.'
      : '- Earlier work: search memory first (memory_search, then memory_get on the relevant notes) and cite the note ids you use.' })
  }
  if (mem.write) {
    lines.push({ must: false, text: mem.cli === true
      ? '- The user wants this remembered: save it with `buracle mem remember -- "<text>"` (one fact per note).'
      : '- The user wants this remembered: memory_search for an existing note, then memory_write one note per fact (or memory_update that note).' })
  }
  const cands = (r.candidates ?? []).slice(0, ROUTE_CAPS.candidates)
  if (cands.length > 0) {
    const list = cands.map(id => {
      const short = skill(id)?.short
      return short !== undefined && short !== '' ? `${id} (${short})` : id
    }).join(', ')
    lines.push({ must: false, text: `- Skills to evaluate first: ${list}. Decide YES or NO for each with a one-line reason, then load every YES (${CANDIDATE_HOW[h]}) before any other tool.` })
  }
  for (const id of (r.categories ?? []).slice(0, ROUTE_CAPS.categories)) {
    const reminder = categoryReminder(policy, id)
    if (reminder === undefined) continue
    const libs = id === 'library-docs' && r.libs !== undefined && r.libs.length > 0 ? ` (${r.libs.join(', ')})` : ''
    lines.push({ must: false, text: `- ${labelOf(id)}${libs}: ${reminder}.` })
  }
  if (lines.length === 0) return undefined
  const out: string[] = [ROUTE_HEADER]
  let size = utf8Bytes(ROUTE_HEADER)
  for (const l of lines) {
    const add = 1 + utf8Bytes(l.text)
    if (!l.must && size + add > ROUTE_TEXT_MAX_BYTES) continue
    out.push(l.text)
    size += add
  }
  return out.length > 1 ? out.join('\n') : undefined
}
