import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { loadConfigSync } from '../engine/config'
import { parseFrontmatter as parseYamlFrontmatter } from '../engine/canonical'
import { agentsDir, canonicalDir, claudeDir, expandHome, repoRoot } from '../engine/paths'
import { git } from './gitx'
import { assetLayout, claudeOnlySkills, realOr } from './project-assets'
import {
  checkBuracleMentions, checkHarnessBlocks, checkLinks, checkPlaceholders, formatFinding, scanMarkdown, sizeOf, summarize,
  type LintFinding, type PlaceholderTargets,
} from './lint'
import { fail, ok, type CmdResult, type WorkflowCtx } from './result'
import { installedForList, readInstalled } from './skill-install'

export const SKILL_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const CANONICAL_KEYS = ['name', 'description', 'when_to_use', 'invocation', 'argument-hint', 'mcp', 'short-description'] as const
const TOLERATED_KEYS = ['user-invocable']
const PROJECT_KEYS = ['name', 'description', 'when_to_use', 'argument-hint', 'disable-model-invocation', 'user-invocable', 'allowed-tools', 'license', 'compatibility', 'metadata', 'model', 'paths']
const TOP_LEVEL_OK = new Set(['SKILL.md', 'references', 'scripts', 'evals', 'assets', 'agents'])

const DESCRIPTION_MAX = 1024
const SHORT_MAX = 80
const SCAFFOLD_MARK = 'Replace me'

export interface SkillSource {
  name: string
  dir?: string
  exists: boolean
  kind: 'canonical' | 'user' | 'project'
  note?: string
}

export function configuredSources(): SkillSource[] {
  let sources: Array<{ name: string, path?: string, git?: string }> = [{ name: 'buracle', path: 'canonical/skills' }]
  try { sources = loadConfigSync().config.skills.sources } catch {  }
  const canon = resolve(canonicalDir(), 'skills')
  return sources.map(s => {
    if (s.path === undefined || s.path.trim() === '') {
      return { name: s.name, exists: false, kind: 'user' as const, note: s.git !== undefined ? `git source without a local path (${s.git}); 'buracle update' manages its checkout` : 'no path configured' }
    }
    const p = expandHome(s.path)
    const dir = isAbsolute(p) ? p : resolve(repoRoot(), p)
    return { name: s.name, dir, exists: existsSync(dir), kind: resolve(dir) === canon ? 'canonical' as const : 'user' as const }
  })
}

function skillIdsIn(dir: string): string[] {
  let names: string[] = []
  try { names = readdirSync(dir).sort() } catch { return [] }
  return names.filter(n => {
    if (n.startsWith('.')) return false
    try { return statSync(join(dir, n)).isDirectory() } catch { return false }
  })
}

interface LoadedSkill {
  id: string
  dir: string
  source: SkillSource
  frontmatter?: Record<string, unknown>
  text?: string
  error?: string
}

function loadSkill(source: SkillSource, id: string): LoadedSkill {
  const dir = join(source.dir as string, id)
  const md = join(dir, 'SKILL.md')
  let text: string
  try { text = readFileSync(md, 'utf8') } catch { return { id, dir, source, error: 'SKILL.md is missing' } }
  try {
    const fm = parseYamlFrontmatter(text)
    return { id, dir, source, frontmatter: fm.frontmatter, text }
  } catch (e) {
    return { id, dir, source, text, error: `frontmatter does not parse: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` }
  }
}

function projectSource(cwdTop: string | undefined): SkillSource | undefined {
  if (cwdTop === undefined) return undefined
  const dir = join(cwdTop, '.agents', 'skills')
  return existsSync(dir) ? { name: 'project', dir, exists: true, kind: 'project' } : undefined
}

async function gitTop(cwd: string): Promise<string | undefined> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel'], { readOnly: true })
  return r.ok && r.out !== '' ? r.out : undefined
}

function mcpIds(): Set<string> {
  try {
    const raw = parseYaml(readFileSync(join(canonicalDir(), 'mcp.yaml'), 'utf8')) as { servers?: Record<string, unknown> } | null
    return new Set(Object.keys(raw?.servers ?? {}))
  } catch {
    return new Set()
  }
}

function agentIds(): Set<string> {
  try {
    return new Set(readdirSync(join(canonicalDir(), 'agents')).filter(n => n.endsWith('.md') && !n.startsWith('.')).map(n => n.slice(0, -3)))
  } catch {
    return new Set()
  }
}

function describedEntry(dir: string): string | undefined {
  try {
    const fm = parseYamlFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8')).frontmatter
    return typeof fm['description'] === 'string' ? (fm['description'] as string).replace(/\s+/g, ' ').trim() : undefined
  } catch { return undefined }
}

function outsideSkills(top: string | undefined, owned: ReadonlySet<string>): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  if (top !== undefined) {
    const layout = assetLayout(top)
    for (const s of claudeOnlySkills(layout)) {
      out.push({ id: s.id, source: 'project', kind: 'claude-only', path: join(layout.claudeSkills, s.id), ...(s.description !== undefined ? { description: s.description } : {}), harnesses: ['claude', 'opencode', 'omp'] })
    }
  }
  const byReal = new Map<string, Record<string, unknown>>()
  const folders: Array<[string, string[]]> = [[join(agentsDir(), 'skills'), ['codex', 'opencode', 'omp']], [join(claudeDir(), 'skills'), ['claude', 'opencode']]]
  for (const [dir, harnesses] of folders) {
    for (const id of skillIdsIn(dir)) {
      if (owned.has(id)) continue
      const path = join(dir, id)
      if (!existsSync(join(path, 'SKILL.md'))) continue
      const real = realOr(path)
      const seen = byReal.get(real)
      if (seen !== undefined) { seen['harnesses'] = [...new Set([...(seen['harnesses'] as string[]), ...harnesses])].sort(); continue }
      const desc = describedEntry(path)
      const entry: Record<string, unknown> = { id, source: 'user-folder', kind: 'unmanaged', path, ...(desc !== undefined ? { description: desc } : {}), harnesses: [...harnesses].sort() }
      byReal.set(real, entry)
      out.push(entry)
    }
  }
  return out
}

export async function skillsList(ctx: WorkflowCtx): Promise<CmdResult> {
  const sources = configuredSources()
  const top = await gitTop(ctx.cwd)
  const project = projectSource(top)
  if (project !== undefined && !sources.some(s => s.dir !== undefined && resolve(s.dir) === resolve(project.dir as string))) sources.push(project)
  const skills: Array<Record<string, unknown>> = []
  for (const src of sources) {
    if (src.dir === undefined || !src.exists) continue
    for (const id of skillIdsIn(src.dir)) {
      const s = loadSkill(src, id)
      const fm = s.frontmatter ?? {}
      const entry: Record<string, unknown> = { id, source: src.name, kind: src.kind, path: s.dir }
      if (typeof fm['description'] === 'string') entry['description'] = (fm['description'] as string).replace(/\s+/g, ' ').trim()
      if (typeof fm['short-description'] === 'string') entry['shortDescription'] = fm['short-description']
      if (typeof fm['invocation'] === 'string') entry['invocation'] = fm['invocation']
      else if (fm['disable-model-invocation'] === true) entry['invocation'] = 'explicit'
      if (Array.isArray(fm['mcp'])) entry['mcp'] = fm['mcp']
      if (s.text !== undefined) entry['words'] = sizeOf(s.text).words
      if (s.error !== undefined) entry['error'] = s.error
      skills.push(entry)
    }
  }
  skills.push(...installedForList())
  const owned = new Set<string>([...skills.filter(sk => sk['kind'] !== 'project').map(sk => String(sk['id'])), ...readInstalled().map(r => r.id)])
  skills.push(...outsideSkills(top, owned))
  const counts = new Map<string, number>()
  for (const s of skills) counts.set(String(s['id']), (counts.get(String(s['id'])) ?? 0) + 1)
  for (const s of skills) if ((counts.get(String(s['id'])) ?? 0) > 1) s['duplicate'] = true
  const width = Math.max(4, ...skills.map(s => String(s['id']).length))
  const lines = skills.length === 0 ? ['No skills found.'] : skills.map(s => `${String(s['id']).padEnd(width)}  ${String(s['source']).padEnd(9)} ${String(s['invocation'] ?? '?').padEnd(9)} ${String(s['shortDescription'] ?? s['description'] ?? '').slice(0, 90)}${s['duplicate'] === true ? '  [duplicate id]' : ''}${s['edited'] === true ? '  [edited locally]' : ''}${s['kind'] === 'claude-only' || s['kind'] === 'unmanaged' ? `  [${String(s['kind'])}: ${(s['harnesses'] as string[]).join(', ')}]` : ''}${typeof s['error'] === 'string' ? `  [${s['error']}]` : ''}`)
  for (const src of sources) if (!src.exists) lines.push(`(source ${src.name}: ${src.note ?? `${src.dir ?? '?'} does not exist`})`)
  return ok({ skills, sources: sources.map(s => ({ name: s.name, kind: s.kind, path: s.dir ?? null, exists: s.exists, ...(s.note !== undefined ? { note: s.note } : {}) })) }, lines)
}

export function scaffoldSkill(id: string): { skill: string, evals: string } {
  const title = id.split('-').map(w => (w[0] ?? '').toUpperCase() + w.slice(1)).join(' ')
  const skill = [
    '---',
    `name: ${id}`,
    'description: >-',
    `  ${SCAFFOLD_MARK}: what this skill does in one or two sentences, then when to use it (the`,
    '  situations and the phrases users type), then what it is not for.',
    'when_to_use: >-',
    `  ${SCAFFOLD_MARK}: a short list of trigger situations, or delete this key.`,
    'invocation: implicit',
    'mcp: []',
    `short-description: ${SCAFFOLD_MARK} (at most 80 characters)`,
    '---',
    '',
    `# ${title}`,
    '',
    '<One or two sentences: the outcome this skill produces and what it leaves alone.>',
    '',
    '## Done means',
    '',
    '- <Observable evidence: a command and its exit code, a file, a tool result.>',
    '',
    '## Ground rules',
    '',
    '1. <A constraint specific to this procedure, with its reason.>',
    '',
    '## Phases',
    '',
    'Track the phases with {{todo}}.',
    '',
    '### 1. <Phase name>',
    '',
    '- <Imperative step naming the exact MCP tool or command.>',
    '- Gate: <what must hold before the next phase>.',
    '',
    '## Failure handling',
    '',
    '| Situation | Do |',
    '|---|---|',
    '| <Likely failure> | <Recovery, or what to report> |',
    '',
    '## Example',
    '',
    '<A short, realistic run: the request, the key steps, the result.>',
    '',
  ].join('\n')
  const evals = JSON.stringify({ target: `skill:${id}`, notes: 'Trigger cases (one in the user\'s language), near misses and one behavior case; see the create-skill skill.', cases: [] }, null, 2) + '\n'
  return { skill, evals }
}

export function skillsNew(id: string | undefined, sourceName: string | undefined): CmdResult {
  if (id === undefined) return fail('usage', 'missing <id>: buracle skills new <id> [--source <name>]')
  if (!SKILL_ID_RE.test(id) || id.length > 64) return fail('usage', `invalid skill id '${id}': kebab-case (a-z, 0-9, '-'), at most 64 characters`)
  const sources = configuredSources().filter(s => s.dir !== undefined)
  const src = sourceName !== undefined ? sources.find(s => s.name === sourceName) : sources.find(s => s.kind === 'canonical') ?? sources[0]
  if (src === undefined || src.dir === undefined) return fail('no_source', sourceName !== undefined ? `no skill source named '${sourceName}' with a local path in skills.sources` : 'no skill source with a local path is configured (skills.sources)')
  for (const s of sources) {
    if (s.dir !== undefined && existsSync(join(s.dir, id))) return fail('exists', `skill '${id}' already exists in source ${s.name}: ${join(s.dir, id)}`)
  }
  const dir = join(src.dir, id)
  const { skill, evals } = scaffoldSkill(id)
  try {
    mkdirSync(join(dir, 'evals'), { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), skill, { flag: 'wx' })
    writeFileSync(join(dir, 'evals', 'cases.json'), evals, { flag: 'wx' })
  } catch (e) {
    return fail('io', `could not scaffold ${dir}: ${e instanceof Error ? e.message : String(e)}`)
  }
  return ok({ ok: true, id, source: src.name, path: dir, files: [join(dir, 'SKILL.md'), join(dir, 'evals', 'cases.json')] }, [dir, `Scaffolded ${id} in ${src.name}. Fill in every 'Replace me' and <…> part, then run 'buracle skills lint'.`])
}

function walk(dir: string, rel = ''): string[] {
  let names: string[] = []
  try { names = readdirSync(join(dir, rel)).sort() } catch { return [] }
  const out: string[] = []
  for (const n of names) {
    if (n === '.DS_Store' || n === 'node_modules' || n === '.git') continue
    const r = rel === '' ? n : `${rel}/${n}`
    let st
    try { st = lstatSync(join(dir, r)) } catch { continue }
    if (st.isDirectory()) out.push(...walk(dir, r))
    else out.push(r)
  }
  return out
}

export interface SkillLintOptions {
  displayRoot: string
  targets: PlaceholderTargets
  mcp: ReadonlySet<string>
  profile: 'canonical' | 'project'
  // The folder name the skill has once installed, when it differs from the folder it is linted
  // in: a fetched skill sits in a cache folder named by a hash, or in a folder named otherwise.
  folder?: string
}

function show(displayRoot: string, abs: string): string {
  const rel = relative(displayRoot, abs)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : abs
}

export function lintSkillDir(dir: string, o: SkillLintOptions): LintFinding[] {
  const out: LintFinding[] = []
  const id = o.folder ?? basename(dir)
  const mdAbs = join(dir, 'SKILL.md')
  const md = show(o.displayRoot, mdAbs)
  const where = o.profile === 'project' ? 'project skills' : 'canonical skills'
  if (!SKILL_ID_RE.test(id) || id.length > 64) out.push({ level: 'error', code: 'skill-id', file: show(o.displayRoot, dir), message: `folder name '${id}' must be kebab-case (a-z, 0-9, '-'), at most 64 characters` })
  let text: string
  try { text = readFileSync(mdAbs, 'utf8') } catch {
    out.push({ level: 'error', code: 'skill-md-missing', file: show(o.displayRoot, dir), message: 'SKILL.md is missing' })
    return out
  }

  let fm: Record<string, unknown> | undefined
  try {
    const parsed = parseYamlFrontmatter(text)
    fm = parsed.frontmatter
    if (!/^﻿?---[ \t]*\r?\n/.test(text)) {
      out.push({ level: 'error', code: 'frontmatter-missing', file: md, line: 1, message: 'SKILL.md must start with a YAML frontmatter block (---)' })
      fm = undefined
    }
  } catch (e) {
    out.push({ level: 'error', code: 'frontmatter-parse', file: md, line: 1, message: `frontmatter does not parse as YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}` })
  }
  if (fm !== undefined) out.push(...checkFrontmatter(md, id, fm, o))

  const files = walk(dir)
  const mdFiles: string[] = []
  for (const f of files) {
    const top = f.split('/')[0] as string
    if (!TOP_LEVEL_OK.has(top) && f !== 'SKILL.md') out.push({ level: 'warning', code: 'unexpected-file', file: show(o.displayRoot, join(dir, f)), message: `only SKILL.md, references/, scripts/, evals/ and assets/ belong in a skill folder` })
    if (top === 'evals') continue
    if (top === 'references' && f.split('/').length > 2) out.push({ level: 'warning', code: 'reference-nested', file: show(o.displayRoot, join(dir, f)), message: 'keep references one level deep (references/<name>.md)' })
    if (f.endsWith('.md')) mdFiles.push(f)
  }

  if (files.includes('evals/cases.json')) {
    const p = join(dir, 'evals', 'cases.json')
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
      const cases = raw !== null && typeof raw === 'object' ? (raw as { cases?: unknown }).cases : undefined
      if (!Array.isArray(cases)) out.push({ level: 'error', code: 'evals-shape', file: show(o.displayRoot, p), message: 'evals/cases.json must be an object with a "cases" array' })
      else if (cases.length === 0) out.push({ level: 'warning', code: 'evals-empty', file: show(o.displayRoot, p), message: 'evals/cases.json has no cases yet' })
    } catch (e) {
      out.push({ level: 'error', code: 'evals-json', file: show(o.displayRoot, p), message: `evals/cases.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}` })
    }
  }

  const linked = new Set<string>()
  for (const f of mdFiles) {
    const abs = join(dir, f)
    const shown = show(o.displayRoot, abs)
    const body = f === 'SKILL.md' ? text : readFileSync(abs, 'utf8')
    if (body.includes('\r\n')) out.push({ level: 'warning', code: 'crlf', file: shown, message: 'use LF line endings' })
    const scan = scanMarkdown(body)
    out.push(...checkPlaceholders(shown, scan, o.profile === 'project' ? null : o.targets, where))
    out.push(...checkHarnessBlocks(shown, scan, o.profile !== 'project', where))
    out.push(...checkBuracleMentions(shown, scan))
    out.push(...checkLinks(shown, abs, scan, { containWithin: dir }))
    for (const p of scan.prose) {
      const re = /\]\(\s*<?([^)\s>#?]+)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(p.text)) !== null) {
        try { linked.add(resolve(join(dir, f, '..'), decodeURIComponent(m[1] ?? ''))) } catch {  }
      }
    }
  }
  for (const f of mdFiles) {
    if (!f.startsWith('references/')) continue
    if (!linked.has(resolve(join(dir, f)))) out.push({ level: 'warning', code: 'reference-orphan', file: show(o.displayRoot, join(dir, f)), message: 'no Markdown file of the skill links to this reference, so agents will not find it' })
  }
  return out
}

function checkFrontmatter(md: string, id: string, fm: Record<string, unknown>, o: SkillLintOptions): LintFinding[] {
  const out: LintFinding[] = []
  const err = (code: string, message: string) => out.push({ level: 'error', code, file: md, line: 1, message })
  const allowed = o.profile === 'project' ? PROJECT_KEYS : [...CANONICAL_KEYS, ...TOLERATED_KEYS]
  for (const k of Object.keys(fm)) {
    if (!allowed.includes(k)) {
      if (o.profile === 'project') out.push({ level: 'warning', code: 'frontmatter-unknown-key', file: md, line: 1, message: `'${k}' is not a portable skill key; some harnesses ignore or reject it` })
      else err('frontmatter-unknown-key', `unknown frontmatter key '${k}' (canonical keys: ${CANONICAL_KEYS.join(', ')})`)
    }
  }
  const name = fm['name']
  if (typeof name !== 'string' || name.trim() === '') err('frontmatter-name', "'name' is required")
  else if (name !== id) err('frontmatter-name', `'name: ${name}' must equal the folder name '${id}'`)
  const desc = fm['description']
  const when = fm['when_to_use']
  if (typeof desc !== 'string' || desc.trim() === '') err('frontmatter-description', "'description' is required: what the skill does and when to use it")
  if (when !== undefined && typeof when !== 'string') err('frontmatter-when', "'when_to_use' must be a string")
  const total = (typeof desc === 'string' ? desc.length : 0) + (typeof when === 'string' ? when.length : 0)
  if (total > DESCRIPTION_MAX) err('description-too-long', `description${typeof when === 'string' ? ' + when_to_use' : ''} is ${total} characters; the limit is ${DESCRIPTION_MAX}`)
  for (const k of ['description', 'when_to_use', 'short-description']) {
    const v = fm[k]
    if (typeof v === 'string' && v.includes(SCAFFOLD_MARK)) err('scaffold-left', `'${k}' still holds the scaffold text ('${SCAFFOLD_MARK}…')`)
  }
  const hint = fm['argument-hint']
  if (hint !== undefined && typeof hint !== 'string') err('frontmatter-argument-hint', "'argument-hint' must be a string")
  if (o.profile === 'project') return out
  const inv = fm['invocation']
  if (inv !== 'explicit' && inv !== 'implicit') err('frontmatter-invocation', "'invocation' must be explicit or implicit")
  const mcp = fm['mcp']
  if (mcp === undefined) err('frontmatter-mcp', "'mcp' is required: the MCP server ids the skill uses, [] when none")
  else if (!Array.isArray(mcp) || !mcp.every(x => typeof x === 'string')) err('frontmatter-mcp', "'mcp' must be a list of server ids")
  else {
    const seen = new Set<string>()
    for (const s of mcp as string[]) {
      if (seen.has(s)) out.push({ level: 'warning', code: 'mcp-duplicate', file: md, line: 1, message: `MCP id '${s}' is listed twice` })
      seen.add(s)
      if (o.mcp.size > 0 && !o.mcp.has(s)) err('mcp-unknown', `MCP id '${s}' is not a server in canonical/mcp.yaml (known: ${[...o.mcp].sort().join(', ')})`)
    }
  }
  const short = fm['short-description']
  if (typeof short !== 'string' || short.trim() === '') err('frontmatter-short-description', "'short-description' is required (at most 80 characters)")
  else if (short.length > SHORT_MAX) err('frontmatter-short-description', `'short-description' is ${short.length} characters; the limit is ${SHORT_MAX}`)
  const ui = fm['user-invocable']
  if (ui !== undefined && typeof ui !== 'boolean') err('frontmatter-user-invocable', "'user-invocable' must be true or false")
  return out
}

function lintTargets(args: readonly string[], ctx: WorkflowCtx): { dirs: Array<{ dir: string, profile: 'canonical' | 'project' }>, problems: string[], sources: SkillSource[] } {
  const problems: string[] = []
  const dirs: Array<{ dir: string, profile: 'canonical' | 'project' }> = []
  const sources = configuredSources()
  const profileFor = (d: string): 'canonical' | 'project' => (/(^|[\\/])\.agents[\\/]skills([\\/]|$)/.test(d) && !sources.some(s => s.dir !== undefined && (d + sep).startsWith(resolve(s.dir) + sep)) ? 'project' : 'canonical')
  if (args.length === 0) {
    for (const s of sources) {
      if (s.dir === undefined || !s.exists) continue
      for (const id of skillIdsIn(s.dir)) dirs.push({ dir: join(s.dir, id), profile: 'canonical' })
    }
    return { dirs, problems, sources }
  }
  for (const a of args) {
    const p = resolve(ctx.cwd, expandHome(a))
    if (!existsSync(p)) { problems.push(`${a}: not found`); continue }
    if (existsSync(join(p, 'SKILL.md'))) { dirs.push({ dir: p, profile: profileFor(p) }); continue }
    const ids = skillIdsIn(p)
    if (ids.length === 0) { problems.push(`${a}: neither a skill folder (no SKILL.md) nor a folder of skills`); continue }
    for (const id of ids) dirs.push({ dir: join(p, id), profile: profileFor(join(p, id)) })
  }
  return { dirs, problems, sources }
}

export function lintProjectSkill(dir: string, displayRoot: string): LintFinding[] {
  return lintSkillDir(dir, { displayRoot, targets: { skills: new Set(), agents: agentIds() }, mcp: mcpIds(), profile: 'project' })
}

export function skillsLint(args: readonly string[], strict: boolean, ctx: WorkflowCtx): CmdResult {
  const { dirs, problems, sources } = lintTargets(args, ctx)
  if (problems.length > 0) return fail('usage', problems.join('; '))
  const ids = new Set<string>()
  for (const s of sources) if (s.dir !== undefined && s.exists) for (const id of skillIdsIn(s.dir)) ids.add(id)
  const targets: PlaceholderTargets = { skills: ids, agents: agentIds() }
  const mcp = mcpIds()
  const findings: LintFinding[] = []
  const displayRoot = args.length === 0 ? repoRoot() : ctx.cwd
  if (mcp.size === 0) findings.push({ level: 'warning', code: 'mcp-catalog', file: show(displayRoot, join(canonicalDir(), 'mcp.yaml')), message: 'canonical/mcp.yaml could not be read; MCP ids were not checked' })
  const seen = new Map<string, string>()
  for (const { dir, profile } of dirs) {
    findings.push(...lintSkillDir(dir, { displayRoot, targets, mcp, profile }))
    const id = basename(dir)
    const prev = seen.get(id)
    if (prev !== undefined && profile === 'canonical') findings.push({ level: 'error', code: 'duplicate-skill', file: show(displayRoot, dir), message: `skill id '${id}' also exists at ${prev}` })
    seen.set(id, show(displayRoot, dir))
  }
  const report = summarize(findings)
  const code = report.errors > 0 ? 1 : strict && report.warnings > 0 ? 2 : 0
  const lines = report.findings.map(formatFinding)
  lines.push(`${dirs.length} skill(s) checked: ${report.errors} error(s), ${report.warnings} warning(s)`)
  return { code, data: { ok: code === 0, skills: dirs.length, errors: report.errors, warnings: report.warnings, findings: report.findings }, lines, errors: [] }
}
