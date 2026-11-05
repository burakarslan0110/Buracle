import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseFrontmatter } from '../engine/canonical'
import { atomicWriteSync, readJsonSafeSync, sha256 } from '../engine/fsx'
import * as paths from '../engine/paths'
import { git, gitError } from './gitx'
import { formatFinding, summarize, type LintFinding, type PlaceholderTargets } from './lint'
import { fail, ok, partial, type CmdResult, type WorkflowCtx } from './result'
import { lintSkillDir, SKILL_ID_RE } from './skills'

const NO_TARGETS: PlaceholderTargets = { skills: new Set(), agents: new Set() }

export interface SkillSourceSpec {
  kind: 'git' | 'local'
  url?: string
  dir?: string
  ref?: string
  subpath?: string
  display: string
}

const GITHUB_TREE = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/(?:tree|blob)\/([^/]+)(?:\/(.*))?$/
const GITHUB_REPO = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/
const SHORTHAND = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(.+?))?(?:@([^@/]+))?$/

function clean(p: string | undefined): string | undefined {
  const s = (p ?? '').replace(/^\/+|\/+$/g, '')
  return s === '' ? undefined : s
}

export function parseSkillSource(spec: string, cwd: string): SkillSourceSpec | { error: string } {
  const s = spec.trim()
  if (s === '') return { error: 'a source is required: owner/repo, a git URL or a local folder' }
  const local = isAbsolute(s) || s.startsWith('.') || s.startsWith('~') ? resolve(cwd, paths.expandHome(s)) : resolve(cwd, s)
  if (existsSync(local) && statSync(local).isDirectory() && !/^https?:\/\//.test(s)) return { kind: 'local', dir: local, display: local }
  let m = GITHUB_TREE.exec(s)
  if (m) {
    const out: SkillSourceSpec = { kind: 'git', url: `https://github.com/${m[1]}/${m[2]}.git`, ref: m[3], display: `${m[1]}/${m[2]}` }
    const sub = clean(m[4])
    if (sub !== undefined) out.subpath = sub
    return out
  }
  m = GITHUB_REPO.exec(s)
  if (m) return { kind: 'git', url: `https://github.com/${m[1]}/${m[2]}.git`, display: `${m[1]}/${m[2]}` }
  if (/^(?:https?|ssh|git|file):\/\//.test(s) || /^[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:/.test(s)) {
    const display = s.replace(/\\/g, '/').replace(/^.*?[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/, '$1')
    return { kind: 'git', url: s, display }
  }
  m = SHORTHAND.exec(s)
  if (m && !s.includes('..')) {
    const out: SkillSourceSpec = { kind: 'git', url: `https://github.com/${m[1]}/${m[2]}.git`, display: `${m[1]}/${m[2]}` }
    const sub = clean(m[3])
    if (sub !== undefined) out.subpath = sub
    if (m[4] !== undefined) out.ref = m[4]
    return out
  }
  return { error: `${spec}: not a folder, an owner/repo shorthand or a git URL` }
}

export function sourceCacheDir(url: string): string {
  return join(paths.skillsCacheDir(), sha256(url).slice(0, 16))
}

export async function fetchSkillSource(src: SkillSourceSpec): Promise<{ root: string, commit?: string } | { error: string }> {
  if (src.kind === 'local') return { root: src.dir as string }
  const url = src.url as string
  const dir = sourceCacheDir(url)
  if (existsSync(join(dir, '.git'))) {
    const fetched = await git(dir, ['fetch', '--depth', '1', 'origin', src.ref ?? 'HEAD'])
    if (!fetched.ok) return { error: `could not fetch ${src.display}: ${gitError(fetched)}` }
    const reset = await git(dir, ['reset', '-q', '--hard', 'FETCH_HEAD'])
    if (!reset.ok) return { error: `could not check out ${src.display}: ${gitError(reset)}` }
  } else {
    mkdirSync(dirname(dir), { recursive: true })
    rmSync(dir, { recursive: true, force: true })
    const args = ['clone', '-q', '--depth', '1', ...(src.ref !== undefined ? ['--branch', src.ref] : []), url, dir]
    const cloned = await git(dirname(dir), args)
    if (!cloned.ok) return { error: `could not clone ${src.display}: ${gitError(cloned)}` }
  }
  const head = await git(dir, ['rev-parse', 'HEAD'], { readOnly: true })
  return head.ok ? { root: dir, commit: head.out } : { root: dir }
}

export interface FoundSkill { id: string, dir: string, rel: string, description?: string }

const SKIP = new Set(['.git', 'node_modules', 'evals', 'tests', 'test', 'dist', 'build'])

function skillAt(root: string, rel: string): FoundSkill | undefined {
  const dir = rel === '' ? root : join(root, rel)
  const md = join(dir, 'SKILL.md')
  if (!existsSync(md)) return undefined
  let name: string | undefined
  let description: string | undefined
  try {
    const fm = parseFrontmatter(readFileSync(md, 'utf8')).frontmatter
    if (typeof fm['name'] === 'string' && fm['name'].trim() !== '') name = fm['name'].trim()
    if (typeof fm['description'] === 'string') description = fm['description'].replace(/\s+/g, ' ').trim()
  } catch {  }
  const folder = rel === '' ? basename(root).replace(/\.git$/, '') : basename(rel)
  const id = (name !== undefined && SKILL_ID_RE.test(name) ? name : folder).toLowerCase()
  const out: FoundSkill = { id, dir, rel: rel === '' ? '.' : rel.split(sep).join('/') }
  if (description !== undefined) out.description = description
  return out
}

function subdirs(dir: string): string[] {
  let names: string[] = []
  try { names = readdirSync(dir).sort() } catch { return [] }
  return names.filter(n => !n.startsWith('.') && !SKIP.has(n) && (() => { try { return statSync(join(dir, n)).isDirectory() } catch { return false } })())
}

export function discoverSkills(root: string, subpath?: string): FoundSkill[] {
  if (subpath !== undefined) {
    const one = skillAt(root, subpath)
    if (one) return [one]
    const dir = join(root, subpath)
    return subdirs(dir).map(n => skillAt(root, join(subpath, n))).filter((s): s is FoundSkill => s !== undefined)
  }
  const self = skillAt(root, '')
  if (self) return [self]
  const out = new Map<string, FoundSkill>()
  const add = (s: FoundSkill | undefined) => { if (s && !out.has(s.dir)) out.set(s.dir, s) }
  for (const n of subdirs(root)) add(skillAt(root, n))
  for (const base of ['skills', '.claude/skills', '.agents/skills', '.codex/skills', '.opencode/skill', '.opencode/skills']) {
    for (const n of subdirs(join(root, base))) {
      const s = skillAt(root, join(base, n))
      if (s) { add(s); continue }
      for (const m of subdirs(join(root, base, n))) add(skillAt(root, join(base, n, m)))
    }
  }
  return [...out.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1))
}

export interface SkillAudit { scripts: string[], warnings: string[], allowedTools?: string }

const TEXT_FILE = /\.(?:md|txt|sh|bash|zsh|py|js|mjs|cjs|ts|rb|pl|ps1|yaml|yml|json|toml)$/i
const AUDIT_RULES: Array<{ re: RegExp, what: string }> = [
  { re: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i, what: 'downloads and runs a script in one pipe' },
  { re: /\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\$HOME)/i, what: 'recursive delete of a home or root path' },
  { re: /\bbase64\s+(?:-d|--decode)\b|\bfrom_base64\b|atob\(/i, what: 'decodes hidden content' },
  { re: /\bsudo\b|\bchmod\s+(?:-R\s+)?777\b/i, what: 'privilege escalation or world-writable files' },
  { re: /~\/\.ssh\b|\$HOME\/\.ssh\b|\.aws\/credentials|\.netrc\b|\.npmrc\b|id_rsa\b/i, what: 'reaches for credential files' },
  { re: /\b(?:AWS_SECRET_ACCESS_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|GITHUB_TOKEN|GH_TOKEN)\b/i, what: 'names secret environment variables' },
  { re: /ignore (?:all |any )?(?:previous|prior|earlier) instructions|do not (?:tell|inform|show) the user|without (?:telling|informing) the user|hide this from the user/i, what: 'prompt-injection wording' },
  { re: /\bpowershell\b[^\n]*-(?:enc|encodedcommand)\b/i, what: 'encoded PowerShell command' },
  { re: /\bnc\b[^\n]*-e\b|\/dev\/tcp\//i, what: 'reverse shell pattern' },
]

function walkFiles(dir: string, rel = ''): string[] {
  const out: string[] = []
  let names: string[] = []
  try { names = readdirSync(dir).sort() } catch { return out }
  for (const n of names) {
    if (n === '.git' || n === 'node_modules') continue
    const abs = join(dir, n)
    let st
    try { st = lstatSync(abs) } catch { continue }
    const r = rel === '' ? n : `${rel}/${n}`
    if (st.isDirectory()) out.push(...walkFiles(abs, r))
    else if (st.isFile()) out.push(r)
  }
  return out
}

export function auditSkillDir(dir: string): SkillAudit {
  const audit: SkillAudit = { scripts: [], warnings: [] }
  try {
    const fm = parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8')).frontmatter
    const at = fm['allowed-tools']
    if (typeof at === 'string' && at.trim() !== '') audit.allowedTools = at.trim()
    else if (Array.isArray(at) && at.length > 0) audit.allowedTools = at.map(String).join(', ')
  } catch {  }
  for (const rel of walkFiles(dir)) {
    const abs = join(dir, rel)
    let mode = 0
    try { mode = statSync(abs).mode } catch { continue }
    if (rel.startsWith('scripts/') || (mode & 0o111) !== 0 || /\.(?:sh|bash|zsh|py|rb|pl|ps1|js|mjs|cjs|ts)$/i.test(rel)) audit.scripts.push(rel)
    if (!TEXT_FILE.test(rel)) continue
    let text: string
    try { if (statSync(abs).size > 512 * 1024) continue; text = readFileSync(abs, 'utf8') } catch { continue }
    const lines = text.split('\n')
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      for (const rule of AUDIT_RULES) if (rule.re.test(line)) audit.warnings.push(`${rel}:${i + 1}: ${rule.what}`)
    }
  }
  if (audit.allowedTools !== undefined) audit.warnings.unshift(`SKILL.md: allowed-tools grants ${audit.allowedTools} without a prompt in Claude Code`)
  return audit
}

export interface InstalledSkill {
  id: string
  source: string
  kind: 'git' | 'local'
  url?: string
  ref?: string
  subpath?: string
  commit?: string
  sha: string
  installed_at: string
  claude_link: boolean
}

export function readInstalled(): InstalledSkill[] {
  const r = readJsonSafeSync<{ skills?: InstalledSkill[] }>(paths.installedSkillsFile())
  const list = r.ok && r.value !== null && typeof r.value === 'object' && Array.isArray(r.value.skills) ? r.value.skills : []
  return list.filter(s => typeof s.id === 'string' && SKILL_ID_RE.test(s.id))
}

function writeInstalled(skills: InstalledSkill[]): void {
  mkdirSync(dirname(paths.installedSkillsFile()), { recursive: true })
  atomicWriteSync(paths.installedSkillsFile(), JSON.stringify({ v: 1, skills: [...skills].sort((a, b) => (a.id < b.id ? -1 : 1)) }, null, 2) + '\n')
}

export function skillTreeHash(dir: string): string {
  const parts: string[] = []
  for (const rel of walkFiles(dir)) {
    const abs = join(dir, rel)
    let mode = 0
    try { mode = statSync(abs).mode & 0o111 } catch { continue }
    parts.push(`${rel}\0${mode}\0${sha256(readFileSync(abs))}`)
  }
  return sha256(parts.join('\n'))
}

export function installedSkillDir(id: string): string { return join(paths.agentsDir(), 'skills', id) }
export function claudeSkillLink(id: string): string { return join(paths.claudeDir(), 'skills', id) }

function linkState(link: string, target: string): 'absent' | 'ours' | 'foreign' {
  let st
  try { st = lstatSync(link) } catch { return 'absent' }
  if (!st.isSymbolicLink()) return 'foreign'
  const cur = readlinkSync(link)
  const abs = isAbsolute(cur) ? cur : resolve(dirname(link), cur)
  return resolve(abs) === resolve(target) ? 'ours' : 'foreign'
}

function destinationState(id: string, installed: InstalledSkill[]): 'free' | 'installed' | 'buracle' | 'foreign' {
  const dir = installedSkillDir(id)
  let st
  try { st = lstatSync(dir) } catch { return 'free' }
  if (installed.some(s => s.id === id) && !st.isSymbolicLink()) return 'installed'
  if (st.isSymbolicLink()) {
    const cur = readlinkSync(dir)
    const abs = isAbsolute(cur) ? cur : resolve(dirname(dir), cur)
    if (abs.split(sep).includes('agents-skills')) return 'buracle'
  }
  return 'foreign'
}

export interface AddOptions {
  id?: string
  ref?: string
  skill?: string[]
  all?: boolean
  force?: boolean
  dryRun?: boolean
  noClaudeLink?: boolean
}

function copySkill(from: string, to: string): void {
  rmSync(to, { recursive: true, force: true })
  mkdirSync(dirname(to), { recursive: true })
  cpSync(from, to, { recursive: true, dereference: true, filter: p => { const b = basename(p); return b !== '.git' && b !== 'node_modules' } })
}

function ensureClaudeLink(id: string, warnings: string[]): boolean {
  const link = claudeSkillLink(id)
  const target = installedSkillDir(id)
  const state = linkState(link, target)
  if (state === 'ours') return true
  if (state === 'foreign') { warnings.push(`${link} exists already (not Buracle's link); Claude Code keeps what is there`); return false }
  try {
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(target, link)
    return true
  } catch (e) {
    warnings.push(`could not link ${link}: ${e instanceof Error ? e.message : String(e)}`)
    return false
  }
}

function removeClaudeLink(id: string): boolean {
  const link = claudeSkillLink(id)
  if (linkState(link, installedSkillDir(id)) !== 'ours') return false
  try { unlinkSync(link); return true } catch { return false }
}

export async function skillsAdd(spec: string, opts: AddOptions, ctx: WorkflowCtx): Promise<CmdResult> {
  const parsed = parseSkillSource(spec, ctx.cwd)
  if ('error' in parsed) return fail('usage', parsed.error)
  if (opts.ref !== undefined) parsed.ref = opts.ref
  const fetched = await fetchSkillSource(parsed)
  if ('error' in fetched) return fail('fetch', fetched.error)
  let found = discoverSkills(fetched.root, parsed.subpath)
  if (found.length === 0) return fail('not_found', `${parsed.display}${parsed.subpath !== undefined ? `/${parsed.subpath}` : ''} holds no SKILL.md (a skill folder, or folders under skills/)`)
  if (opts.id !== undefined && found.length > 1 && (opts.skill === undefined || opts.skill.length !== 1)) return fail('usage', `--id applies to one skill; ${parsed.display} holds ${found.length}: pick one with --skill <id>`)
  if (opts.skill !== undefined && opts.skill.length > 0) {
    const want = new Set(opts.skill)
    const missing = [...want].filter(w => !found.some(f => f.id === w))
    if (missing.length > 0) return fail('not_found', `${parsed.display} has no skill ${missing.join(', ')} (found: ${found.map(f => f.id).join(', ')})`)
    found = found.filter(f => want.has(f.id))
  } else if (found.length > 1 && opts.all !== true) {
    const lines = [`${parsed.display} holds ${found.length} skills; pick with --skill <id> (repeatable) or install every one with --all:`, ...found.map(f => `  ${f.id.padEnd(28)} ${f.rel}${f.description !== undefined ? `  ${f.description.slice(0, 80)}` : ''}`)]
    return { code: 2, data: { ok: false, source: parsed.display, skills: found.map(f => ({ id: f.id, path: f.rel, ...(f.description !== undefined ? { description: f.description } : {}) })) }, lines, errors: [] }
  }
  const installed = readInstalled()
  const results: Array<Record<string, unknown>> = []
  const lines: string[] = []
  const errors: string[] = []
  const now = new Date(ctx.now).toISOString()
  for (const f of found) {
    const id = (opts.id ?? f.id).toLowerCase()
    if (!SKILL_ID_RE.test(id) || id.length > 64) { errors.push(`${f.rel}: '${id}' is not a valid skill id (a-z, 0-9, '-'); use --id`); continue }
    const findings: LintFinding[] = lintSkillDir(f.dir, { displayRoot: fetched.root, targets: NO_TARGETS, mcp: new Set(), profile: 'project', folder: f.id })
    const report = summarize(findings)
    const audit = auditSkillDir(f.dir)
    const state = destinationState(id, installed)
    const entry: Record<string, unknown> = { id, source: parsed.display, path: f.rel, lint: { errors: report.errors, warnings: report.warnings }, audit: { scripts: audit.scripts, warnings: audit.warnings }, destination: installedSkillDir(id), state }
    if (state === 'buracle') { errors.push(`${id}: a Buracle skill has this id (~/.agents/skills/${id} is Buracle's own); choose another with --id`); results.push({ ...entry, installed: false }); continue }
    if (state === 'foreign' && opts.force !== true) { errors.push(`${id}: ~/.agents/skills/${id} exists and was not installed by Buracle; --force replaces it`); results.push({ ...entry, installed: false }); continue }
    if (report.errors > 0 && opts.force !== true) {
      errors.push(`${id}: ${report.errors} lint error(s); fix the source or pass --force:`, ...report.findings.filter(x => x.level === 'error').map(formatFinding))
      results.push({ ...entry, installed: false })
      continue
    }
    for (const w of report.findings.filter(x => x.level === 'warning')) lines.push(`  lint: ${formatFinding(w)}`)
    if (opts.dryRun === true) {
      lines.push(`would install ${id} from ${parsed.display}${f.rel !== '.' ? `/${f.rel}` : ''} into ${installedSkillDir(id)}${state === 'installed' ? ' (replacing the earlier install)' : ''}`, `  read it first: ${f.dir}`)
      results.push({ ...entry, installed: false, dry_run: true, checkout: f.dir })
    } else {
      const warnings: string[] = []
      try {
        copySkill(f.dir, installedSkillDir(id))
      } catch (e) {
        errors.push(`${id}: copy failed: ${e instanceof Error ? e.message : String(e)}`)
        results.push({ ...entry, installed: false })
        continue
      }
      const claudeLink = opts.noClaudeLink === true ? false : ensureClaudeLink(id, warnings)
      const rec: InstalledSkill = { id, source: parsed.display + (f.rel !== '.' ? `/${f.rel}` : ''), kind: parsed.kind, sha: skillTreeHash(installedSkillDir(id)), installed_at: now, claude_link: claudeLink }
      if (parsed.url !== undefined) rec.url = parsed.url
      if (parsed.ref !== undefined) rec.ref = parsed.ref
      const sub = f.rel === '.' ? parsed.subpath : f.rel
      if (sub !== undefined) rec.subpath = sub
      if (fetched.commit !== undefined) rec.commit = fetched.commit
      const idx = installed.findIndex(s => s.id === id)
      if (idx >= 0) installed[idx] = rec
      else installed.push(rec)
      lines.push(`${state === 'installed' ? 'updated' : 'installed'} ${id} from ${rec.source}${rec.commit !== undefined ? ` @ ${rec.commit.slice(0, 7)}` : ''} into ${installedSkillDir(id)}${claudeLink ? ` (Claude Code: ${claudeSkillLink(id)})` : ''}`)
      for (const w of warnings) lines.push(`  ${w}`)
      results.push({ ...entry, installed: true, claude_link: claudeLink, commit: rec.commit ?? null })
    }
    if (audit.scripts.length > 0) lines.push(`  scripts the skill may run (read them first): ${audit.scripts.join(', ')}`)
    for (const w of audit.warnings) lines.push(`  audit: ${w}`)
  }
  if (opts.dryRun !== true && results.some(r => r['installed'] === true)) {
    writeInstalled(installed)
    lines.push(`Read each SKILL.md before using it; the harnesses see new skills in their next session. Remove with \`buracle skills remove <id>\`.`)
  }
  const data = { ok: errors.length === 0, source: parsed.display, commit: fetched.commit ?? null, skills: results }
  if (errors.length === 0) return ok(data, lines)
  return results.some(r => r['installed'] === true) ? partial(data, lines, errors) : { code: 1, data, lines, errors }
}

export function skillsRemove(id: string | undefined): CmdResult {
  if (id === undefined || !SKILL_ID_RE.test(id)) return fail('usage', 'a skill id is required (see `buracle skills list`)')
  const installed = readInstalled()
  const rec = installed.find(s => s.id === id)
  if (!rec) {
    const dir = installedSkillDir(id)
    return fail('not_found', existsSync(dir) ? `${id} was not installed by \`buracle skills add\`; ${dir} is left alone` : `${id} is not installed`)
  }
  const dir = installedSkillDir(id)
  const edited = existsSync(dir) && skillTreeHash(dir) !== rec.sha
  rmSync(dir, { recursive: true, force: true })
  const unlinked = removeClaudeLink(id)
  writeInstalled(installed.filter(s => s.id !== id))
  const lines = [`removed ${id} (${dir}${unlinked ? `, ${claudeSkillLink(id)}` : ''})`]
  if (edited) lines.push('  the folder had local edits; they are gone with it')
  return ok({ ok: true, id, removed: dir, claude_link_removed: unlinked, had_local_edits: edited }, lines)
}

export async function skillsUpdate(id: string | undefined, opts: { force?: boolean, dryRun?: boolean }, ctx: WorkflowCtx): Promise<CmdResult> {
  const installed = readInstalled()
  const targets = id === undefined ? installed : installed.filter(s => s.id === id)
  if (id !== undefined && targets.length === 0) return fail('not_found', `${id} is not an installed skill`)
  if (targets.length === 0) return ok({ ok: true, skills: [] }, ['No third-party skills are installed.'])
  const lines: string[] = []
  const errors: string[] = []
  const results: Array<Record<string, unknown>> = []
  let changed = false
  for (const rec of targets) {
    if (rec.kind !== 'git' || rec.url === undefined) { lines.push(`${rec.id}: from a local folder (${rec.source}); re-run \`buracle skills add ${rec.source}\` to refresh it`); results.push({ id: rec.id, action: 'manual' }); continue }
    const src: SkillSourceSpec = { kind: 'git', url: rec.url, display: rec.source }
    if (rec.ref !== undefined) src.ref = rec.ref
    const fetched = await fetchSkillSource(src)
    if ('error' in fetched) { errors.push(`${rec.id}: ${fetched.error}`); results.push({ id: rec.id, action: 'error' }); continue }
    const dir = rec.subpath !== undefined ? join(fetched.root, rec.subpath) : fetched.root
    if (!existsSync(join(dir, 'SKILL.md'))) { errors.push(`${rec.id}: ${rec.source} no longer holds a SKILL.md at ${rec.subpath ?? '.'}`); results.push({ id: rec.id, action: 'error' }); continue }
    const local = existsSync(installedSkillDir(rec.id)) ? skillTreeHash(installedSkillDir(rec.id)) : undefined
    const edited = local !== undefined && local !== rec.sha
    if (fetched.commit !== undefined && fetched.commit === rec.commit && local !== undefined) { lines.push(`${rec.id}: up to date (${fetched.commit.slice(0, 7)})`); results.push({ id: rec.id, action: 'current', commit: fetched.commit }); continue }
    if (edited && opts.force !== true) { lines.push(`${rec.id}: ${fetched.commit?.slice(0, 7) ?? 'a new version'} is available, but the installed copy has local edits; \`buracle skills update ${rec.id} --force\` replaces them`); results.push({ id: rec.id, action: 'kept', reason: 'local-edits', commit: fetched.commit ?? null }); continue }
    // Linted as the folder it is installed into, the name `add` gave it; a dry run lints too, so a
    // check never offers an update that the apply refuses.
    const findings = lintSkillDir(dir, { displayRoot: fetched.root, targets: NO_TARGETS, mcp: new Set(), profile: 'project', folder: skillAt(fetched.root, rec.subpath ?? '')?.id ?? rec.id })
    const report = summarize(findings)
    if (report.errors > 0 && opts.force !== true) {
      const kept = { id: rec.id, action: 'kept', reason: 'lint', lint_errors: report.errors, commit: fetched.commit ?? null }
      if (opts.dryRun === true) { lines.push(`${rec.id}: ${fetched.commit?.slice(0, 7) ?? 'a new version'} is available, but it has ${report.errors} lint error(s); \`buracle skills update ${rec.id} --force\` installs it anyway`); results.push(kept); continue }
      errors.push(`${rec.id}: the new version has ${report.errors} lint error(s); kept the installed one (--force updates anyway)`, ...report.findings.filter(x => x.level === 'error').map(formatFinding))
      results.push(kept)
      continue
    }
    if (opts.dryRun === true) { lines.push(`${rec.id}: would update ${rec.commit?.slice(0, 7) ?? '?'} -> ${fetched.commit?.slice(0, 7) ?? '?'}`); results.push({ id: rec.id, action: 'would-update', commit: fetched.commit ?? null }); continue }
    try { copySkill(dir, installedSkillDir(rec.id)) } catch (e) { errors.push(`${rec.id}: copy failed: ${e instanceof Error ? e.message : String(e)}`); results.push({ id: rec.id, action: 'error' }); continue }
    const warnings: string[] = []
    rec.claude_link = rec.claude_link ? ensureClaudeLink(rec.id, warnings) : false
    rec.sha = skillTreeHash(installedSkillDir(rec.id))
    rec.installed_at = new Date(ctx.now).toISOString()
    if (fetched.commit !== undefined) rec.commit = fetched.commit
    changed = true
    const audit = auditSkillDir(installedSkillDir(rec.id))
    lines.push(`${rec.id}: updated to ${rec.commit?.slice(0, 7) ?? 'the latest version'}`)
    for (const w of warnings) lines.push(`  ${w}`)
    if (audit.scripts.length > 0) lines.push(`  scripts the skill may run (read them first): ${audit.scripts.join(', ')}`)
    for (const w of audit.warnings) lines.push(`  audit: ${w}`)
    results.push({ id: rec.id, action: 'updated', commit: rec.commit ?? null, audit: { scripts: audit.scripts, warnings: audit.warnings } })
  }
  if (changed) writeInstalled(installed)
  const data = { ok: errors.length === 0, skills: results }
  return errors.length === 0 ? ok(data, lines) : partial(data, lines, errors)
}

export function installedForList(): Array<Record<string, unknown>> {
  return readInstalled().map(rec => {
    const dir = installedSkillDir(rec.id)
    const entry: Record<string, unknown> = { id: rec.id, source: 'installed', kind: 'user', path: dir, from: rec.source, installed_at: rec.installed_at }
    if (rec.commit !== undefined) entry['commit'] = rec.commit
    if (!existsSync(join(dir, 'SKILL.md'))) { entry['error'] = 'the installed folder is gone (buracle skills remove, then add it again)'; return entry }
    try {
      const fm = parseFrontmatter(readFileSync(join(dir, 'SKILL.md'), 'utf8')).frontmatter
      if (typeof fm['description'] === 'string') entry['description'] = (fm['description'] as string).replace(/\s+/g, ' ').trim()
      if (fm['disable-model-invocation'] === true) entry['invocation'] = 'explicit'
    } catch { entry['error'] = 'frontmatter does not parse' }
    if (skillTreeHash(dir) !== rec.sha) entry['edited'] = true
    entry['claude_link'] = linkState(claudeSkillLink(rec.id), dir) === 'ours'
    return entry
  })
}

export function tilde(p: string): string {
  const home = paths.home()
  const rel = relative(home, p)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? `~/${rel.split(sep).join('/')}` : p
}
