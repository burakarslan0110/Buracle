import { protectGlobToRegExp } from './write-guard'

export interface PathRuleIndex { id: string; globs: readonly string[] }

export interface PathRuleSource {
  rules: readonly PathRuleIndex[]
  dir: string
  shownDir?: string
  body?: (id: string) => string | undefined
  onRead?: boolean
  maxChars?: number
}

export const PATH_RULE_TEXT_MAX_CHARS = 7000

export function ruleGlobs(frontmatter: Record<string, unknown>): string[] {
  const p = frontmatter['paths']
  if (typeof p === 'string') return [p]
  return Array.isArray(p) ? p.filter((x): x is string => typeof x === 'string') : []
}

export function pathRuleIndex(rules: ReadonlyArray<{ id: string, scope: string, frontmatter: Record<string, unknown> }>): PathRuleIndex[] {
  return rules
    .filter(r => r.scope === 'paths')
    .map(r => ({ id: r.id, globs: ruleGlobs(r.frontmatter) }))
    .filter(r => r.globs.length > 0)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

const ABSOLUTE = /^(?:\/|[A-Za-z]:\/)/

function slashes(p: string): string {
  return p.replace(/\\/g, '/')
}

function trimDir(p: string): string {
  return slashes(p).replace(/\/+$/, '')
}

function withoutDot(p: string): string {
  return p.replace(/^(?:\.\/)+/, '')
}

function under(file: string, dir: string, caseInsensitive: boolean): string | undefined {
  const d = trimDir(dir)
  if (d === '') return undefined
  const f = caseInsensitive ? file.toLowerCase() : file
  const k = caseInsensitive ? d.toLowerCase() : d
  return f.startsWith(k + '/') ? file.slice(d.length + 1) : undefined
}

export function projectRelative(file: string, base: { root?: string, cwd?: string, caseInsensitive?: boolean }): string {
  const ci = base.caseInsensitive === true
  let f = slashes(file.trim())
  if (!ABSOLUTE.test(f)) {
    const cwd = base.cwd !== undefined ? trimDir(base.cwd) : undefined
    if (cwd === undefined || cwd === '') return withoutDot(f)
    f = `${cwd}/${withoutDot(f)}`
  }
  for (const dir of [base.root, base.cwd]) {
    if (dir === undefined) continue
    const rel = under(f, dir, ci)
    if (rel !== undefined) return withoutDot(rel)
  }
  return f.replace(/^[A-Za-z]:/, '').replace(/^\/+/, '')
}

export function matchPathRules(relPath: string, rules: readonly PathRuleIndex[]): string[] {
  const p = withoutDot(slashes(relPath).replace(/^\/+/, ''))
  if (p === '') return []
  const out: string[] = []
  for (const r of rules) {
    if (out.includes(r.id)) continue
    if (r.globs.some(g => protectGlobToRegExp(slashes(g.trim()))?.test(p) === true)) out.push(r.id)
  }
  return out
}

export function ruleText(file: string): string {
  const text = file.replace(/\r\n/g, '\n')
  const m = /^---\n[\s\S]*?\n---\n?/.exec(text)
  return (m !== null ? text.slice(m[0].length) : text).trim()
}

const DEFAULT_RULE_DIR = /^~\/\.buracle\/rules\/paths$|^\$(?:BURACLE_HOME|\{BURACLE_HOME\})\/rules\/paths$/

function homeForm(p: string): string {
  return p.replace(/^\$(?:HOME|\{HOME\})(?=\/|$)/, '~')
}

export function ruleFileId(path: string, src: Pick<PathRuleSource, 'rules' | 'dir' | 'shownDir'>, caseInsensitive = false): string | undefined {
  const p = homeForm(slashes(path.trim()))
  const m = /\/([a-z0-9][a-z0-9._-]*)\.md$/i.exec(p)
  const id = m?.[1]
  if (id === undefined || !src.rules.some(r => r.id === id)) return undefined
  const parent = p.slice(0, p.length - id.length - 4)
  const same = (dir: string | undefined): boolean => {
    if (dir === undefined) return false
    const d = homeForm(trimDir(dir))
    return d !== '' && (caseInsensitive ? parent.toLowerCase() === d.toLowerCase() : parent === d)
  }
  return same(src.dir) || same(src.shownDir) || DEFAULT_RULE_DIR.test(parent) ? id : undefined
}

export interface PathRuleNote { text: string; delivered: string[]; inlined: string[]; pointed: string[] }

function readableRules(ids: readonly string[], src: PathRuleSource): Array<{ id: string, text: string }> {
  const out: Array<{ id: string, text: string }> = []
  for (const id of ids) {
    let body: string | undefined
    try { body = src.body?.(id) } catch { body = undefined }
    const text = body !== undefined ? ruleText(body) : ''
    if (text !== '') out.push({ id, text })
  }
  return out
}

export function pathRuleNote(what: 'deny' | 'edit' | 'read', file: string, ids: readonly string[], src: PathRuleSource): PathRuleNote | undefined {
  const found = readableRules(ids, src)
  if (found.length === 0) return undefined
  const max = src.maxChars ?? PATH_RULE_TEXT_MAX_CHARS
  const names = found.map(r => `\`${r.id}\``).join(', ')
  const one = found.length === 1
  const rule = one ? 'the path rule' : 'the path rules'
  const it = one ? 'it' : 'them'
  const lead = what === 'deny'
    ? `Buracle: ${file} matches ${rule} ${names}, which this session has not read yet. Follow ${it}, then retry the edit; the retry is allowed.`
    : what === 'edit'
      ? `Buracle: ${file} matches ${rule} ${names}; follow ${it} for this change.`
      : `Buracle: ${file} matches ${rule} ${names}; follow ${it} when you change files like this one.`
  const parts: string[] = [lead]
  const inlined: string[] = []
  const pointed: string[] = []
  let used = lead.length
  for (const r of found) {
    if (inlined.length === 0 || used + r.text.length + 2 <= max) {
      parts.push(r.text)
      inlined.push(r.id)
      used += r.text.length + 2
    } else pointed.push(r.id)
  }
  if (pointed.length > 0) {
    const dir = trimDir(src.shownDir ?? src.dir)
    parts.push(`Read ${pointed.length === 1 ? 'this rule file' : 'these rule files'} before the edit: ${pointed.map(id => `\`${dir}/${id}.md\``).join(', ')}.`)
  }
  return { text: parts.join('\n\n'), delivered: found.map(r => r.id), inlined, pointed }
}
