import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, unlinkSync, type Dirent } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter } from '../core/frontmatter'
import {
  DOT_CLAUDE_MD, importsAgentsMd, parseScopedRules, ruleGlobsOf, ruleParity, RULES_DIR,
  type ClaudeOnlySkill, type RuleFacts, type RuleParity, type ScopedRuleIndex,
} from '../core/project-assets'

export const SKILL_DIR_RE = /^[a-z0-9][a-z0-9._-]*$/
const RULES_MAX_FILES = 500
const RULES_MAX_DEPTH = 8

export type EntryKind = 'missing' | 'file' | 'dir' | 'link' | 'other'

export interface PathFacts { rel: string; kind: EntryKind; real?: string; inside: boolean }

export interface AssetLayout {
  root: string
  agentsSkills: string
  claudeSkills: string
  alias: boolean
  blocked: string[]
  facts: PathFacts[]
}

export interface AgentSkill { id: string; dir: string; state: 'skill' | 'bad-id' | 'no-skill-md' | 'link'; target?: string; claudeOwned?: boolean }

export interface ClaudeSkill {
  id: string
  path: string
  kind: 'link' | 'dir' | 'file'
  target?: string
  ours?: boolean
  dangling?: boolean
  intoAgents?: boolean
  skillMd?: boolean
  name?: string
  description?: string
}

export interface LinkPlan {
  create: Array<{ id: string; link: string; target: string }>
  unchanged: string[]
  remove: Array<{ id: string; link: string }>
  conflicts: Array<{ id: string; path: string; reason: string }>
  skipped: Array<{ id: string; reason: string }>
  claudeOwned: string[]
}

export interface LinkReport {
  created: string[]
  unchanged: string[]
  removed: string[]
  conflicts: Array<{ id: string, path: string, reason: string }>
  skipped: Array<{ id: string, reason: string }>
  claudeOwned: string[]
  alias: boolean
  blocked: string[]
}

export interface ClaudeFileRouting { name: string; path: string; importsAgents: boolean; sharedLink: boolean; outside?: string }

export function realOr(p: string): string {
  try { return realpathSync.native(p) } catch { return resolve(p) }
}

export function within(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

function kindOf(p: string): EntryKind {
  try {
    const st = lstatSync(p)
    return st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
  } catch { return 'missing' }
}

function targetKind(p: string): EntryKind {
  try {
    const st = statSync(p)
    return st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other'
  } catch { return 'missing' }
}

export function pathFacts(root: string, rel: string): PathFacts {
  const p = join(root, ...rel.split('/'))
  const kind = kindOf(p)
  if (kind === 'missing') return { rel, kind, inside: true }
  let real: string | undefined
  try { real = realpathSync.native(p) } catch { real = undefined }
  return real !== undefined ? { rel, kind, real, inside: within(root, real) } : { rel, kind, inside: false }
}

export function assetLayout(rootIn: string): AssetLayout {
  const root = realOr(rootIn)
  const facts = ['.agents', '.agents/skills', '.claude', '.claude/skills'].map(rel => pathFacts(root, rel))
  const blocked: string[] = []
  for (const f of facts) {
    if (f.kind === 'link' && f.real === undefined) blocked.push(`${f.rel} is a dangling symlink; Buracle does not write through it`)
    else if (f.kind === 'link' && !f.inside) blocked.push(`${f.rel} is a symlink to ${f.real ?? '?'}, outside the repository; Buracle does not write through it`)
    else if (f.kind === 'link' && targetKind(join(root, f.rel)) !== 'dir') blocked.push(`${f.rel} is a symlink to a file, not a folder`)
    else if (f.kind === 'file' || f.kind === 'other') blocked.push(`${f.rel} is a file, not a folder`)
  }
  const agentsSkills = realOr(join(root, '.agents', 'skills'))
  const claudeDir = realOr(join(root, '.claude'))
  const claudeSkills = existsSync(join(root, '.claude', 'skills')) ? realOr(join(root, '.claude', 'skills')) : join(claudeDir, 'skills')
  const alias = existsSync(join(root, '.claude', 'skills')) && existsSync(join(root, '.agents', 'skills')) && claudeSkills === agentsSkills
  return { root, agentsSkills, claudeSkills, alias, blocked, facts }
}

function list(dir: string): string[] {
  try { return readdirSync(dir).filter(n => !n.startsWith('.')).sort() } catch { return [] }
}

export function agentSkills(layout: AssetLayout): AgentSkill[] {
  const out: AgentSkill[] = []
  for (const id of list(layout.agentsSkills)) {
    const dir = join(layout.agentsSkills, id)
    const kind = kindOf(dir)
    if (kind === 'link') {
      let target: string | undefined
      try { target = readlinkSync(dir) } catch { target = undefined }
      const claudeOwned = existsSync(join(layout.claudeSkills, id)) && kindOf(join(layout.claudeSkills, id)) === 'dir' && realOr(dir) === realOr(join(layout.claudeSkills, id))
      out.push({ id, dir, state: 'link', ...(target !== undefined ? { target } : {}), ...(claudeOwned ? { claudeOwned } : {}) })
      continue
    }
    if (kind !== 'dir') continue
    if (!SKILL_DIR_RE.test(id)) { out.push({ id, dir, state: 'bad-id' }); continue }
    out.push({ id, dir, state: existsSync(join(dir, 'SKILL.md')) ? 'skill' : 'no-skill-md' })
  }
  return out
}

function skillMeta(dir: string): { name?: string; description?: string } | undefined {
  let text: string
  try { text = readFileSync(join(dir, 'SKILL.md'), 'utf8') } catch { return undefined }
  const fm = parseFrontmatter(text).data
  const out: { name?: string; description?: string } = {}
  if (typeof fm['name'] === 'string') out.name = fm['name']
  if (typeof fm['description'] === 'string' && fm['description'].trim() !== '') out.description = fm['description'].replace(/\s+/g, ' ').trim()
  return out
}

export function claudeSkills(layout: AssetLayout, withMeta = true): ClaudeSkill[] {
  const out: ClaudeSkill[] = []
  if (layout.alias) return out
  const agentsPlain = join(layout.root, '.agents', 'skills')
  for (const id of list(layout.claudeSkills)) {
    const path = join(layout.claudeSkills, id)
    const kind = kindOf(path)
    if (kind === 'link') {
      let target = ''
      try { target = readlinkSync(path) } catch {  }
      const abs = isAbsolute(target) ? target : resolve(dirname(path), target)
      const intoAgents = within(agentsPlain, abs) || within(layout.agentsSkills, abs)
      const dangling = !existsSync(abs)
      const ours = !dangling && realOr(abs) === realOr(join(layout.agentsSkills, id)) && kindOf(join(layout.agentsSkills, id)) !== 'link'
      out.push({ id, path, kind, target, ours, dangling, intoAgents })
      continue
    }
    if (kind === 'dir') {
      if (!withMeta) { out.push({ id, path, kind }); continue }
      const meta = skillMeta(path)
      out.push({ id, path, kind, skillMd: meta !== undefined, ...(meta ?? {}) })
      continue
    }
    if (kind === 'file') out.push({ id, path, kind })
  }
  return out
}

export function linkPlan(layout: AssetLayout, agents: readonly AgentSkill[] = agentSkills(layout), claude: readonly ClaudeSkill[] = claudeSkills(layout)): LinkPlan {
  const plan: LinkPlan = { create: [], unchanged: [], remove: [], conflicts: [], skipped: [], claudeOwned: [] }
  if (layout.blocked.length > 0) return plan
  if (layout.alias) {
    plan.unchanged.push(...agents.filter(a => a.state === 'skill').map(a => a.id))
    return plan
  }
  const byId = new Map(claude.map(c => [c.id, c]))
  const wanted = new Set<string>()
  for (const a of agents) {
    if (a.state === 'link') {
      if (a.claudeOwned === true) plan.claudeOwned.push(a.id)
      else plan.skipped.push({ id: a.id, reason: `a symlink${a.target !== undefined ? ` to ${a.target}` : ''}; Buracle links only real skill folders` })
      continue
    }
    if (a.state === 'bad-id') { plan.skipped.push({ id: a.id, reason: 'folder name is not a valid skill id' }); continue }
    if (a.state === 'no-skill-md') { plan.skipped.push({ id: a.id, reason: 'no SKILL.md' }); continue }
    wanted.add(a.id)
    const link = join(layout.claudeSkills, a.id)
    const c = byId.get(a.id)
    if (c === undefined) { plan.create.push({ id: a.id, link, target: relative(layout.claudeSkills, a.dir) }); continue }
    if (c.kind === 'link') {
      if (c.ours === true) plan.unchanged.push(a.id)
      else plan.conflicts.push({ id: a.id, path: link, reason: `a symlink to ${c.target ?? '?'} already exists` })
      continue
    }
    plan.conflicts.push({ id: a.id, path: link, reason: c.kind === 'dir' ? 'a real directory already exists (a Claude-only copy?)' : 'a file already exists' })
  }
  for (const c of claude) {
    if (wanted.has(c.id) || c.kind !== 'link') continue
    if (c.intoAgents === true && c.dangling === true) plan.remove.push({ id: c.id, link: c.path })
  }
  return plan
}

export function linkWorkPending(root: string): boolean {
  const layout = assetLayout(root)
  if (layout.blocked.length > 0 || layout.alias) return false
  const plan = linkPlan(layout, agentSkills(layout), claudeSkills(layout, false))
  return plan.create.length > 0 || plan.remove.length > 0
}

export function applyLinkPlan(layout: AssetLayout, plan: LinkPlan): LinkReport {
  const report: LinkReport = {
    created: [], unchanged: [...plan.unchanged], removed: [], conflicts: [...plan.conflicts], skipped: [...plan.skipped],
    claudeOwned: [...plan.claudeOwned], alias: layout.alias, blocked: [...layout.blocked],
  }
  for (const c of plan.create) {
    mkdirSync(layout.claudeSkills, { recursive: true })
    try {
      symlinkSync(c.target, c.link)
      report.created.push(c.id)
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e
      let cur = ''
      try { cur = readlinkSync(c.link) } catch {  }
      if (cur === c.target) report.unchanged.push(c.id)
      else report.conflicts.push({ id: c.id, path: c.link, reason: cur !== '' ? `a symlink to ${cur} already exists` : 'something else appeared there while linking' })
    }
  }
  for (const r of plan.remove) {
    try { unlinkSync(r.link); report.removed.push(r.id) } catch {  }
  }
  report.unchanged.sort()
  return report
}

function walkRules(dir: string, root: string, depth: number, out: string[]): void {
  if (depth > RULES_MAX_DEPTH || out.length >= RULES_MAX_FILES) return
  let entries: Dirent[]
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (out.length >= RULES_MAX_FILES) return
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    let isDir = e.isDirectory()
    let isFile = e.isFile()
    if (e.isSymbolicLink()) {
      const real = realOr(p)
      if (!within(root, real)) continue
      const k = targetKind(p)
      isDir = k === 'dir'
      isFile = k === 'file'
    }
    if (isDir) walkRules(p, root, depth + 1, out)
    else if (isFile && e.name.toLowerCase().endsWith('.md') && e.name.toLowerCase() !== 'readme.md') out.push(p)
  }
}

export function ruleFiles(rootIn: string): string[] {
  const root = realOr(rootIn)
  const claude = pathFacts(root, '.claude')
  if (claude.kind === 'link' && !claude.inside) return []
  const dir = join(root, ...RULES_DIR.split('/'))
  const out: string[] = []
  walkRules(dir, root, 0, out)
  return out.map(p => relative(root, p).split(sep).join('/'))
}

export function ruleFacts(rootIn: string, privatePaths: ReadonlySet<string> = new Set()): RuleFacts[] {
  const root = realOr(rootIn)
  return ruleFiles(root).map(path => {
    let text = ''
    try { text = readFileSync(join(root, ...path.split('/')), 'utf8') } catch {  }
    const g = ruleGlobsOf(text)
    const r: RuleFacts = { path, globs: g.globs }
    if (g.problem !== undefined) r.problem = g.problem
    if (privatePaths.has(path)) r.private = true
    return r
  })
}

export function readRuleIndex(rootIn: string): ScopedRuleIndex & { exists: boolean } {
  let text: string
  try { text = readFileSync(join(realOr(rootIn), 'AGENTS.md'), 'utf8') } catch { return { exists: false, found: false, entries: [] } }
  return { exists: true, ...parseScopedRules(text) }
}

export function rulesParity(rootIn: string, privatePaths?: ReadonlySet<string>): RuleParity & { rules: RuleFacts[], agentsMd: boolean } {
  const rules = ruleFacts(rootIn, privatePaths)
  const index = readRuleIndex(rootIn)
  return { ...ruleParity(rules, index), rules, agentsMd: index.exists }
}

export function claudeRouting(rootIn: string): ClaudeFileRouting[] {
  const root = realOr(rootIn)
  const agents = join(root, 'AGENTS.md')
  const agentsReal = existsSync(agents) ? realOr(agents) : undefined
  const out: ClaudeFileRouting[] = []
  for (const name of ['CLAUDE.md', 'CLAUDE.local.md', DOT_CLAUDE_MD]) {
    const path = join(root, ...name.split('/'))
    const kind = kindOf(path)
    if (kind === 'missing') continue
    const real = existsSync(path) ? realOr(path) : undefined
    const sharedLink = agentsReal !== undefined && real !== undefined && real === agentsReal && (kind === 'link' || kindOf(agents) === 'link')
    const entry: ClaudeFileRouting = { name, path, importsAgents: sharedLink, sharedLink }
    if (kind === 'link' && real !== undefined && !within(root, real)) entry.outside = real
    if (!sharedLink) {
      let text: string | undefined
      try { text = readFileSync(path, 'utf8') } catch { text = undefined }
      if (text === undefined) continue
      entry.importsAgents = importsAgentsMd(text, name)
    }
    out.push(entry)
  }
  return out
}

export function claudeOnlySkills(layout: AssetLayout, agents: readonly AgentSkill[] = agentSkills(layout), claude: readonly ClaudeSkill[] = claudeSkills(layout)): ClaudeOnlySkill[] {
  if (layout.alias) return []
  const agentIds = new Set(agents.map(a => a.id))
  return claude
    .filter(c => c.kind === 'dir' && c.skillMd === true && SKILL_DIR_RE.test(c.id) && !agentIds.has(c.id))
    .map(c => (c.description !== undefined ? { id: c.id, description: c.description } : { id: c.id }))
}

export function assetsContextFacts(rootIn: string): { rules: RuleFacts[]; claudeOnly: ClaudeOnlySkill[] } {
  const p = rulesParity(rootIn)
  const layout = assetLayout(rootIn)
  return { rules: [...p.unindexed, ...p.privateUnindexed].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)), claudeOnly: claudeOnlySkills(layout) }
}
