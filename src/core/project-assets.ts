import type { Harness } from './events'
import { parseFrontmatter } from './frontmatter'

export const RULES_DIR = '.claude/rules'
export const SCOPED_RULES_HEADING = 'Scoped rules'
export const ASSETS_CONTEXT_MAX_RULES = 40
export const ASSETS_CONTEXT_MAX_SKILLS = 40
export const ASSETS_DESCRIPTION_MAX = 160
export const ASSETS_BLOCK_MAX_CHARS = 2_400

export interface ScopedRuleEntry { path: string; globs: string[]; line: number }
export interface ScopedRuleIndex { found: boolean; entries: ScopedRuleEntry[] }

export interface RuleFacts {
  path: string
  globs: string[]
  problem?: string
  private?: boolean
}

export interface GlobMismatch { path: string; rule: string[]; index: string[] }

export interface RuleParity {
  indexFound: boolean
  unindexed: RuleFacts[]
  privateUnindexed: RuleFacts[]
  privateIndexed: string[]
  mismatched: GlobMismatch[]
  dangling: ScopedRuleEntry[]
  invalid: RuleFacts[]
}

export interface ClaudeOnlySkill { id: string; description?: string }

const DASH = '\u2014'
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const ITEM = /^\s*[-*+]\s+(.*)$/
const CODE = /`([^`]+)`/g
const LINK_TARGET = /\]\(\s*<?((?:\.\/)?\.claude\/rules\/[^)>\s]+\.md)>?\s*\)/
const RULE_PATH = /^(?:\.\/)?\.claude\/rules\/.+\.md$/
const FIELD_SEPARATOR = /\s+(?:\u2014|\u2013|--|-)\s+/
const IMPORT_LINE = /^\s*@(?:\.\/)?AGENTS\.md\s*$/m
const IMPORT_LINE_UP = /^\s*@\.\.\/AGENTS\.md\s*$/m

export function normalizeRulePath(p: string): string {
  return p.trim().replace(/\\/g, '/').replace(/^\.\//, '')
}

function cleanGlob(g: string): string {
  return g.trim().replace(/^["']|["']$/g, '').trim()
}

function codeSpans(text: string): string[] {
  return [...text.matchAll(CODE)].map(m => (m[1] ?? '').trim()).filter(s => s !== '')
}

function entryOf(item: string, line: number): ScopedRuleEntry | undefined {
  const spans = [...item.matchAll(CODE)]
  const pathSpan = spans.find(m => RULE_PATH.test((m[1] ?? '').trim()))
  let path: string | undefined
  let rest = item
  if (pathSpan !== undefined) {
    path = normalizeRulePath(pathSpan[1] ?? '')
    rest = item.slice((pathSpan.index ?? 0) + pathSpan[0].length)
  } else {
    const link = LINK_TARGET.exec(item)
    if (link === null) return undefined
    path = normalizeRulePath(link[1] ?? '')
    rest = item.slice((link.index ?? 0) + link[0].length)
  }
  const fields = rest.split(FIELD_SEPARATOR).map(f => f.trim()).filter(f => f !== '')
  const globField = fields.length > 0 && FIELD_SEPARATOR.test(rest) ? fields[0] ?? '' : rest
  const globs = codeSpans(globField).map(cleanGlob).filter(g => g !== '' && !RULE_PATH.test(g))
  return { path, globs, line }
}

export function parseScopedRules(agentsText: string): ScopedRuleIndex {
  const lines = agentsText.replace(/^\uFEFF/, '').split(/\r?\n/)
  const entries: ScopedRuleEntry[] = []
  let found = false
  let inSection = false
  let level = 0
  let fence = false
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; continue }
    if (fence) continue
    const h = HEADING.exec(raw)
    if (h !== null) {
      const depth = (h[1] ?? '').length
      if (inSection && depth <= level) inSection = false
      if (!inSection && (h[2] ?? '').trim().toLowerCase() === SCOPED_RULES_HEADING.toLowerCase()) {
        inSection = true
        found = true
        level = depth
      }
      continue
    }
    if (!inSection) continue
    const item = ITEM.exec(raw)
    if (item === null) continue
    const e = entryOf(item[1] ?? '', i + 1)
    if (e !== undefined) entries.push(e)
  }
  return { found, entries }
}

export function ruleGlobsOf(text: string): { globs: string[]; problem?: string } {
  const fm = parseFrontmatter(text)
  if (!fm.hasFrontmatter) return { globs: [], problem: 'no `paths:` frontmatter, so Claude Code loads it in every session and the other harnesses only through the index' }
  const v = fm.data['paths']
  if (v === undefined || v === null) return { globs: [], problem: 'no `paths:` key in the frontmatter, so Claude Code loads it in every session' }
  const list = Array.isArray(v) ? v : [v]
  if (list.some(x => typeof x !== 'string')) return { globs: [], problem: '`paths:` must be a glob or a list of globs' }
  const globs = [...new Set((list as string[]).map(cleanGlob).filter(g => g !== ''))]
  if (globs.length === 0) return { globs: [], problem: '`paths:` is empty' }
  return { globs }
}

export function sameGlobs(a: readonly string[], b: readonly string[]): boolean {
  const x = [...new Set(a.map(cleanGlob))].sort()
  const y = [...new Set(b.map(cleanGlob))].sort()
  return x.length === y.length && x.every((g, i) => g === y[i])
}

export function ruleParity(rules: readonly RuleFacts[], index: ScopedRuleIndex): RuleParity {
  const byPath = new Map<string, ScopedRuleEntry>()
  for (const e of index.entries) if (!byPath.has(e.path)) byPath.set(e.path, e)
  const onDisk = new Map(rules.map(r => [r.path, r]))
  const out: RuleParity = { indexFound: index.found, unindexed: [], privateUnindexed: [], privateIndexed: [], mismatched: [], dangling: [], invalid: [] }
  for (const r of rules) {
    if (r.problem !== undefined) out.invalid.push(r)
    const e = byPath.get(r.path)
    if (e === undefined) {
      if (r.private === true) out.privateUnindexed.push(r)
      else out.unindexed.push(r)
      continue
    }
    if (r.private === true) out.privateIndexed.push(r.path)
    if (r.problem === undefined && !sameGlobs(r.globs, e.globs)) out.mismatched.push({ path: r.path, rule: r.globs, index: e.globs })
  }
  for (const e of byPath.values()) if (!onDisk.has(e.path)) out.dangling.push(e)
  return out
}

export function parityDrift(p: RuleParity): boolean {
  return p.unindexed.length > 0 || p.mismatched.length > 0 || p.dangling.length > 0 || p.invalid.length > 0
}

export const DOT_CLAUDE_MD = '.claude/CLAUDE.md'

export function agentsImportLine(file: string): string {
  return file === DOT_CLAUDE_MD ? '@../AGENTS.md' : '@AGENTS.md'
}

export function importsAgentsMd(text: string, file = 'CLAUDE.md'): boolean {
  return file === DOT_CLAUDE_MD ? IMPORT_LINE_UP.test(text) : IMPORT_LINE.test(text)
}

function globsText(globs: readonly string[]): string {
  return globs.length > 0 ? globs.map(g => `\`${g}\``).join(', ') : 'every file (no `paths:`)'
}

export function indexLine(rule: RuleFacts): string {
  return `- \`${rule.path}\` ${DASH} ${rule.globs.length > 0 ? rule.globs.map(g => `\`${g}\``).join(', ') : '`<glob>`'} ${DASH} <purpose>`
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}\u2026`
}

function block(head: string, items: readonly string[], maxItems: number, tail: (more: number) => string): string {
  const lines = [head]
  let size = head.length
  let shown = 0
  for (const item of items) {
    if (shown >= maxItems || size + item.length + 1 > ASSETS_BLOCK_MAX_CHARS) break
    lines.push(item)
    size += item.length + 1
    shown++
  }
  if (items.length > shown) lines.push(tail(items.length - shown))
  return lines.join('\n')
}

export function assetsContextText(o: { harness: Harness; rules: readonly RuleFacts[]; claudeOnly: readonly ClaudeOnlySkill[] }): string {
  if (o.harness === 'claude') return ''
  const parts: string[] = []
  if (o.rules.length > 0) {
    parts.push(block(
      `Buracle project rules (H28): AGENTS.md's \`## ${SCOPED_RULES_HEADING}\` list does not name these path rules, so read the matching one before you edit files its globs match:`,
      o.rules.map(r => `- \`${r.path}\` ${DASH} ${globsText(r.globs)}`),
      ASSETS_CONTEXT_MAX_RULES,
      more => `- and ${more} more: \`buracle project check\` lists them all.`,
    ))
  }
  if (o.harness === 'codex' && o.claudeOnly.length > 0) {
    parts.push(block(
      'Buracle project skills (H28): these skills live only in .claude/skills, which Codex does not read. When a task matches one, read `.claude/skills/<id>/SKILL.md` and follow it; `buracle project sync --adopt` links them into .agents/skills for Codex.',
      o.claudeOnly.map(s => `- \`${s.id}\`${s.description !== undefined && s.description !== '' ? `: ${oneLine(s.description, ASSETS_DESCRIPTION_MAX)}` : ''}`),
      ASSETS_CONTEXT_MAX_SKILLS,
      more => `- and ${more} more in .claude/skills.`,
    ))
  }
  return parts.join('\n\n')
}

export function claudeParityText(p: RuleParity): string {
  const paths = new Set([...p.unindexed.map(r => r.path), ...p.mismatched.map(m => m.path), ...p.dangling.map(e => e.path), ...p.invalid.filter(r => r.private !== true).map(r => r.path)])
  if (paths.size === 0) return ''
  return `Buracle (H28): ${paths.size} path rule(s) in ${RULES_DIR} are out of step with AGENTS.md's \`## ${SCOPED_RULES_HEADING}\` list, which is how Codex, OpenCode and omp find them. Run \`buracle project check\` for the fixes before you change those files.`
}

export function claudeOnlySkillNote(id: string): string {
  return `Buracle (H28): .claude/skills/${id} exists only in .claude/skills, so Codex cannot see it (Claude Code, OpenCode and omp read that folder). Keep project skills in .agents/skills/${id}, which Buracle links into .claude/skills, or run \`buracle project sync --adopt\` to link this one for Codex.`
}

export function claudeImportNote(file: string): string {
  const reader = file === DOT_CLAUDE_MD ? 'Claude Code and omp read it' : 'Claude Code reads it'
  return `Buracle (H28): ${file} does not import AGENTS.md, so ${reader} instead of the shared rules. Keep the line \`${agentsImportLine(file)}\` in it (Claude-only notes may follow).`
}

export function ruleEditNote(rule: RuleFacts, index: ScopedRuleIndex): string | undefined {
  if (rule.private === true) return undefined
  if (rule.problem !== undefined) return `Buracle (H28): ${rule.path} has ${rule.problem}. Give it quoted globs, for example \`paths: ["src/**/*.ts"]\`.`
  const e = index.entries.find(x => x.path === rule.path)
  if (e === undefined) {
    return `Buracle (H28): ${rule.path} is not in AGENTS.md's \`## ${SCOPED_RULES_HEADING}\` list, and Codex, OpenCode and omp find path rules only there. Add the line ${indexLine(rule)}`
  }
  if (!sameGlobs(rule.globs, e.globs)) {
    return `Buracle (H28): the \`## ${SCOPED_RULES_HEADING}\` line for ${rule.path} (AGENTS.md:${e.line}) names ${globsText(e.globs)}, but its \`paths:\` are ${globsText(rule.globs)}. Make them the same.`
  }
  return undefined
}

export function indexEditNote(p: RuleParity, max = 5): string | undefined {
  const items: string[] = [
    ...p.dangling.map(e => `AGENTS.md:${e.line} lists ${e.path}, which does not exist`),
    ...p.mismatched.map(m => `${m.path}: the index names ${globsText(m.index)}, its \`paths:\` are ${globsText(m.rule)}`),
    ...p.unindexed.map(r => `${r.path} is missing; add ${indexLine(r)}`),
  ]
  if (items.length === 0) return undefined
  const shown = items.slice(0, max)
  return [
    `Buracle (H28): AGENTS.md's \`## ${SCOPED_RULES_HEADING}\` list is out of step with ${RULES_DIR}:`,
    ...shown.map(s => `- ${s}`),
    ...(items.length > shown.length ? [`- and ${items.length - shown.length} more: run \`buracle project check\`.`] : []),
  ].join('\n')
}
