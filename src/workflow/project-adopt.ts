import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join, relative } from 'node:path'
import { agentSkills, assetLayout, claudeSkills, SKILL_DIR_RE, type ClaudeSkill } from './project-assets'
import { lintProjectSkill } from './skills'

export interface AdoptOptions { move?: boolean; dryRun?: boolean }

export interface AdoptReport {
  dryRun: boolean
  move: boolean
  linked: string[]
  moved: string[]
  replaced: string[]
  identical: string[]
  differing: Array<{ id: string; files: string[] }>
  invalid: Array<{ id: string; reason: string }>
  lint: Array<{ id: string; errors: number; warnings: number; findings: string[] }>
  needsUser: string[]
  warnings: string[]
}

const DIFF_MAX = 20

function files(dir: string, rel = ''): string[] {
  let names: string[]
  try { names = readdirSync(join(dir, rel)).sort() } catch { return [] }
  const out: string[] = []
  for (const n of names) {
    if (n === '.git' || n === 'node_modules' || n === '.DS_Store') continue
    const r = rel === '' ? n : `${rel}/${n}`
    let st
    try { st = lstatSync(join(dir, r)) } catch { continue }
    if (st.isDirectory()) out.push(...files(dir, r))
    else out.push(r)
  }
  return out
}

function sameFile(a: string, b: string): boolean {
  try {
    const sa = lstatSync(a)
    const sb = lstatSync(b)
    if (sa.isSymbolicLink() || sb.isSymbolicLink()) return sa.isSymbolicLink() && sb.isSymbolicLink()
    return readFileSync(a).equals(readFileSync(b))
  } catch { return false }
}

export function treeDiff(a: string, b: string): string[] {
  const left = files(a)
  const right = new Set(files(b))
  const out: string[] = []
  for (const f of left) {
    if (!right.has(f)) out.push(`${f} (only in .claude/skills)`)
    else if (!sameFile(join(a, f), join(b, f))) out.push(`${f} (differs)`)
    right.delete(f)
  }
  for (const f of right) out.push(`${f} (only in .agents/skills)`)
  return out.sort()
}

function invalidReason(c: ClaudeSkill): string | undefined {
  if (!SKILL_DIR_RE.test(c.id)) return 'the folder name is not a valid skill id'
  if (c.skillMd !== true) return 'no SKILL.md'
  if (c.name !== c.id) return c.name === undefined ? 'SKILL.md has no `name:`' : `SKILL.md names it '${c.name}', not '${c.id}'`
  if (c.description === undefined) return 'SKILL.md has no `description:`'
  return undefined
}

export async function adoptSkills(root: string, opts: AdoptOptions): Promise<AdoptReport> {
  const move = opts.move === true
  const dryRun = opts.dryRun === true
  const report: AdoptReport = { dryRun, move, linked: [], moved: [], replaced: [], identical: [], differing: [], invalid: [], lint: [], needsUser: [], warnings: [] }
  const layout = assetLayout(root)
  if (layout.blocked.length > 0) {
    report.needsUser.push(...layout.blocked.map(b => `adopt: ${b}; nothing was adopted`))
    return report
  }
  if (layout.alias) return report
  const agents = new Map(agentSkills(layout).map(a => [a.id, a]))
  const touched: string[] = []
  for (const c of claudeSkills(layout)) {
    if (c.kind !== 'dir') continue
    const why = invalidReason(c)
    if (why !== undefined) { report.invalid.push({ id: c.id, reason: why }); continue }
    const twin = agents.get(c.id)
    const dest = join(layout.agentsSkills, c.id)
    if (twin === undefined) {
      if (move) {
        report.moved.push(c.id)
        if (!dryRun) {
          mkdirSync(layout.agentsSkills, { recursive: true })
          renameSync(c.path, dest)
        }
      } else {
        report.linked.push(c.id)
        if (!dryRun) {
          mkdirSync(layout.agentsSkills, { recursive: true })
          symlinkSync(relative(layout.agentsSkills, c.path), dest)
        }
      }
      touched.push(c.id)
      continue
    }
    if (twin.state === 'link') continue
    const diff = treeDiff(c.path, twin.dir)
    if (diff.length > 0) {
      report.differing.push({ id: c.id, files: diff.slice(0, DIFF_MAX) })
      report.needsUser.push(`adopt: .claude/skills/${c.id} and .agents/skills/${c.id} differ (${diff.slice(0, 3).join(', ')}${diff.length > 3 ? ', ...' : ''}); merge them by hand, then run 'buracle project sync --adopt' again`)
      continue
    }
    if (!move) { report.identical.push(c.id); continue }
    report.replaced.push(c.id)
    if (!dryRun) rmSync(c.path, { recursive: true, force: true })
  }
  if (report.identical.length > 0) report.warnings.push(`identical copies in .claude/skills and .agents/skills: ${report.identical.join(', ')}; 'buracle project sync --adopt --move' replaces each Claude copy with a link`)
  if (move && report.moved.length + report.replaced.length > 0) {
    report.warnings.push(`--move turned tracked .claude/skills folders into symlinks (${[...report.moved, ...report.replaced].join(', ')}); teammates without Buracle and checkouts with core.symlinks=false (Windows) lose them in Claude Code until they run 'buracle project sync'. Commit the moved folders under .agents/skills.`)
  }
  for (const id of touched) {
    const dir = dryRun ? join(layout.claudeSkills, id) : join(layout.agentsSkills, id)
    const findings = lintProjectSkill(dir, layout.root)
    report.lint.push({
      id,
      errors: findings.filter(f => f.level === 'error').length,
      warnings: findings.filter(f => f.level === 'warning').length,
      findings: findings.slice(0, 10).map(f => `${f.level} ${f.code}: ${f.message}`),
    })
  }
  return report
}

export function describeAdopt(r: AdoptReport): string[] {
  const head = r.dryRun ? 'Adopt (dry run, nothing written)' : 'Adopt'
  const parts = [
    r.linked.length > 0 ? `${r.dryRun ? 'would link' : 'linked'} for Codex: ${r.linked.join(', ')}` : '',
    r.moved.length > 0 ? `${r.dryRun ? 'would move' : 'moved'} into .agents/skills: ${r.moved.join(', ')}` : '',
    r.replaced.length > 0 ? `${r.dryRun ? 'would replace' : 'replaced'} identical Claude copies: ${r.replaced.join(', ')}` : '',
    r.identical.length > 0 ? `identical copies kept: ${r.identical.join(', ')}` : '',
    r.differing.length > 0 ? `copies that differ, left alone: ${r.differing.map(d => d.id).join(', ')}` : '',
    r.invalid.length > 0 ? `not valid skills: ${r.invalid.map(i => `${i.id} (${i.reason})`).join(', ')}` : '',
  ].filter(p => p !== '')
  const lint = r.lint.filter(l => l.errors + l.warnings > 0).map(l => `  lint ${l.id}: ${l.errors} error(s), ${l.warnings} warning(s)${l.findings[0] !== undefined ? ` (${l.findings[0]})` : ''}`)
  return [`${head}: ${parts.length > 0 ? parts.join('; ') : 'no Claude-only skills to adopt'}`, ...lint]
}
