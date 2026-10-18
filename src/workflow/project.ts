import { existsSync, lstatSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { describeBridge, projectInit, type BridgeResult } from './memory-bridge'
import { acquireRepoLock, git, listWorktrees, repoFacts, updateExclude, type RepoFacts, type RepoLock } from './gitx'
import { nonProjectReason as memoryNonProjectReason } from './non-project'
import { adoptSkills, describeAdopt, type AdoptOptions, type AdoptReport } from './project-adopt'
import { auditAgentFiles, type AgentFilesAudit } from './project-check'
import { applyLinkPlan, assetLayout, linkPlan, realOr, type AssetLayout, type LinkReport } from './project-assets'
import type { ResolvedSession } from './session-store'
import { worktreeRoot } from './worktree'
import { keepWorktreesOutOfSemble, type SembleIgnoreResult } from './workspace-index'
import { fail, ok, partial, type CmdResult, type WorkflowCtx } from './result'

export type { LinkReport } from './project-assets'

export const AUTO_LOCK_TIMEOUT_MS = 2_000

export interface SyncOptions {
  auto?: boolean
  adopt?: AdoptOptions
}

export function syncSkillLinks(root: string): LinkReport {
  const layout = assetLayout(root)
  return applyLinkPlan(layout, linkPlan(layout))
}

async function checkoutRoots(facts: RepoFacts): Promise<string[]> {
  const roots = new Set<string>([facts.top, facts.mainRoot])
  for (const e of await listWorktrees(facts.mainRoot)) if (!e.bare && !e.prunable) roots.add(e.path)
  return [...roots].filter(d => existsSync(d))
}

export function nonProjectReason(dir: string): string | undefined {
  const why = memoryNonProjectReason(dir)
  return why === undefined ? undefined : `${dir} is ${why}, not a project`
}

async function untracked(facts: RepoFacts, paths: readonly string[]): Promise<string[]> {
  const top = realOr(facts.top)
  const out: string[] = []
  for (const p of paths) {
    const rel = relative(top, p).split('\\').join('/')
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue
    const tracked = await git(facts.top, ['ls-files', '--error-unmatch', '--', rel], { readOnly: true })
    if (!tracked.ok) out.push(`/${rel}`)
  }
  return out
}

const MANAGED_LINK_PREFIXES = ['/.claude/skills/', '/.agents/skills/']

export async function excludeLinks(facts: RepoFacts, layout: AssetLayout, links: LinkReport, extraPaths: readonly string[] = [], extraEntries: readonly string[] = []): Promise<{ path: string, added: string[], removed: string[] }> {
  const linkPaths = [...links.created, ...links.unchanged].map(id => join(layout.claudeSkills, id))
  const owned = links.claudeOwned.map(id => join(layout.agentsSkills, id))
  const untrackedLinks = await untracked(facts, [...linkPaths, ...owned, ...extraPaths])
  const entries = ['/.claude/settings.local.json', ...untrackedLinks, ...extraEntries]
  const keep = new Set(untrackedLinks)
  const checkouts = await checkoutRoots(facts)
  const linkedSomewhere = (line: string): boolean => {
    const rel = line.replace(/^\/+/, '').replace(/\/+$/, '')
    return checkouts.some(dir => { try { return lstatSync(join(dir, rel)).isSymbolicLink() } catch { return false } })
  }
  return updateExclude(facts.commonDir, entries, line => MANAGED_LINK_PREFIXES.some(p => line.startsWith(p)) && !keep.has(line) && !linkedSomewhere(line))
}

const EMPTY_LINKS: LinkReport = { created: [], unchanged: [], removed: [], conflicts: [], skipped: [], claudeOwned: [], alias: false, blocked: [] }

interface PlannedLinks { create: string[]; remove: string[] }

function linkLines(links: LinkReport, planned?: PlannedLinks): string[] {
  if (links.blocked.length > 0) return [`Skill links: not written (${links.blocked.join('; ')})`]
  if (links.alias) return ['Skill links: .claude/skills is a link to .agents/skills, so every project skill is already visible to Claude Code']
  if (planned !== undefined) {
    const ids = (xs: string[]): string => (xs.length > 0 ? xs.join(', ') : 'none')
    return [`Skill links (dry run): would create ${ids(planned.create)}; would remove ${ids(planned.remove)}; ${links.unchanged.length} unchanged, ${links.conflicts.length} conflict(s)`]
  }
  return [
    `Skill links: ${links.created.length} created, ${links.unchanged.length} unchanged, ${links.removed.length} removed, ${links.conflicts.length} conflict(s)`,
    ...(links.claudeOwned.length > 0 ? [`Claude-owned skills linked for Codex: ${links.claudeOwned.join(', ')}`] : []),
  ]
}

async function autoSync(root: string, facts: RepoFacts | undefined): Promise<CmdResult> {
  const layout = assetLayout(root)
  const plan = linkPlan(layout)
  const base = { ok: true, mode: 'auto', root, git: facts !== undefined }
  if (layout.blocked.length > 0 || layout.alias || (plan.create.length === 0 && plan.remove.length === 0)) {
    return ok({ ...base, links: applyLinkPlan(layout, { ...plan, create: [], remove: [] }), exclude: null, changed: false }, [`Project skills: nothing to link in ${root}`])
  }
  let lock: RepoLock | undefined
  if (facts !== undefined) {
    try { lock = await acquireRepoLock(facts.commonDir, 'project sync --auto', AUTO_LOCK_TIMEOUT_MS) } catch {
      return ok({ ...base, links: EMPTY_LINKS, exclude: null, changed: false, busy: true }, ['Project skills: another buracle command holds the repository lock; skipped'])
    }
  }
  try {
    const fresh = assetLayout(root)
    const links = applyLinkPlan(fresh, linkPlan(fresh))
    const warnings: string[] = []
    let exclude: { path: string, added: string[], removed: string[] } | null = null
    if (facts !== undefined) {
      try { exclude = await excludeLinks(facts, fresh, links) } catch (e) { warnings.push(`could not update ${join(facts.commonDir, 'info', 'exclude')}: ${e instanceof Error ? e.message : String(e)}`) }
    }
    return ok({ ...base, links, exclude, changed: links.created.length + links.removed.length > 0 }, linkLines(links), warnings)
  } finally {
    lock?.release()
  }
}

function auditMessages(audit: AgentFilesAudit): { needsUser: string[], warnings: string[] } {
  const needsUser: string[] = []
  const warnings: string[] = []
  for (const p of audit.problems) {
    if (p.kind === 'links' || p.kind === 'agents-md') continue
    if (p.level === 'drift' && p.kind === 'layout') needsUser.push(p.message)
    else warnings.push(p.message)
  }
  return { needsUser, warnings }
}

export async function projectSync(mode: 'init' | 'sync', ctx: WorkflowCtx, _s: ResolvedSession | undefined, opts: SyncOptions = {}): Promise<CmdResult> {
  const facts = await repoFacts(ctx.cwd)
  const root = facts?.top ?? resolve(ctx.cwd)
  const notProject = nonProjectReason(root)
  if (notProject !== undefined) return fail('not_a_project', `${notProject}; run 'buracle project ${mode}' inside a repository`, { root })
  if (opts.auto === true) return autoSync(root, facts)
  const warnings: string[] = []
  const guidance: string[] = []
  const needsUser: string[] = []

  const agentsPath = join(root, 'AGENTS.md')
  const agentsExists = existsSync(agentsPath)
  if (!agentsExists) {
    const msg = `${root} has no AGENTS.md. Create it with the project-rules workflow, \`/project-rules\` (Codex: \`$project-rules\`), then run 'buracle project sync' again. Buracle never writes AGENTS.md itself.`
    guidance.push(msg)
    needsUser.push(msg)
  }

  let adopt: AdoptReport | undefined
  if (opts.adopt !== undefined) {
    adopt = await adoptSkills(root, opts.adopt)
    needsUser.push(...adopt.needsUser)
    warnings.push(...adopt.warnings)
  }

  const dryRun = opts.adopt?.dryRun === true
  let links: LinkReport
  let planned: PlannedLinks | undefined
  const layout = assetLayout(root)
  try {
    if (dryRun) {
      const plan = linkPlan(layout)
      planned = { create: plan.create.map(c => c.id), remove: plan.remove.map(r => r.id) }
      links = applyLinkPlan(layout, { ...plan, create: [], remove: [] })
    } else {
      links = syncSkillLinks(root)
    }
  } catch (e) {
    links = EMPTY_LINKS
    warnings.push(`could not link project skills: ${e instanceof Error ? e.message : String(e)}`)
  }
  for (const b of links.blocked) needsUser.push(`skill links: ${b}; fix the link or move it away, then run 'buracle project sync' again`)
  for (const c of links.conflicts) needsUser.push(`.claude/skills/${c.id}: ${c.reason}; skipped (move it away, or keep it and ignore this message)`)
  for (const sk of links.skipped) warnings.push(`.agents/skills/${sk.id} skipped: ${sk.reason}`)

  const audit = await auditAgentFiles(root, facts)
  const fromAudit = auditMessages(audit)
  for (const m of fromAudit.needsUser) if (!needsUser.some(n => n.includes(m))) needsUser.push(m)
  warnings.push(...fromAudit.warnings)
  const claude = Object.fromEntries(audit.claudeMd.map(c => [c.name, { path: c.path, importsAgents: c.importsAgents, ...(c.sharedLink ? { sharedLink: true } : {}) }]))
  const anyClaude = audit.claudeMd.length > 0

  let exclude: { path: string, added: string[], removed: string[] } | null = null
  let sembleignore: SembleIgnoreResult | null = null
  if (facts !== undefined && !dryRun) {
    const fresh = assetLayout(root)
    const wtRoot = worktreeRoot(facts)
    const wtRel = relative(facts.mainRoot, wtRoot)
    const extra = wtRel !== '' && !wtRel.startsWith('..') && !isAbsolute(wtRel) ? [`/${wtRel}/`] : []
    try {
      exclude = await excludeLinks(facts, fresh, links, [], extra)
    } catch (e) {
      warnings.push(`could not update ${join(facts.commonDir, 'info', 'exclude')}: ${e instanceof Error ? e.message : String(e)}`)
    }
    if (existsSync(wtRoot)) {
      sembleignore = await keepWorktreesOutOfSemble(facts.mainRoot, facts.commonDir, wtRoot)
      if (sembleignore.status === 'tracked') warnings.push(`${sembleignore.path} is tracked by git: add the line ${sembleignore.entry} to it so semble does not index plan worktrees with the checkout`)
      if (sembleignore.status === 'error') warnings.push(`could not update ${sembleignore.path}: ${sembleignore.error}`)
    }
  } else if (facts === undefined) {
    needsUser.push(`${root} is not a git repository: no .git/info/exclude entries were written. Run 'git init' first if this is a project.`)
  }

  const mem: BridgeResult = dryRun ? { status: 'skipped', reason: 'dry run' } : await projectInit({ cwd: ctx.cwd, root, now: ctx.now })
  if (mem.status === 'error') warnings.push(`memory project setup failed: ${mem.error}`)
  if (mem.status === 'ok' && mem.needsUser !== undefined) needsUser.push(...mem.needsUser)
  const memoryJson = mem.status === 'ok'
    ? {
      status: 'ok',
      ...(mem.path !== undefined ? { path: mem.path } : {}),
      ...(mem.detail !== undefined ? { detail: mem.detail } : {}),
      ...(mem.needsUser !== undefined ? { needsUser: mem.needsUser } : {}),
    }
    : mem.status === 'skipped' ? { status: 'skipped', reason: mem.reason } : { status: 'error', error: mem.error }

  const lines = [
    `Project ${mode === 'init' ? 'initialized' : 'synced'}: ${root}${facts === undefined ? ' (not a git repository)' : ''}`,
    `AGENTS.md: ${agentsExists ? 'present' : 'missing'}`,
    ...(adopt !== undefined ? describeAdopt(adopt) : []),
    ...linkLines(links, planned),
    `Path rules: ${audit.rules.count} in .claude/rules, ${audit.rules.unindexed.length} missing from the AGENTS.md index`,
    ...(exclude !== null ? [`.git/info/exclude: ${exclude.added.length > 0 ? `added ${exclude.added.join(', ')}` : 'up to date'}${exclude.removed.length > 0 ? `; removed ${exclude.removed.join(', ')}` : ''}`] : []),
    ...(sembleignore?.status === 'updated' ? [`.sembleignore: added ${sembleignore.entry ?? ''}`] : []),
    describeBridge('Memory', mem),
  ]
  const data: Record<string, unknown> = {
    ok: needsUser.length === 0, mode, root, git: facts !== undefined,
    agentsMd: { path: agentsPath, exists: agentsExists },
    claudeMd: anyClaude ? claude : null,
    links, rules: audit.rules, exclude, sembleignore, memory: memoryJson, guidance,
    ...(adopt !== undefined ? { adopt } : {}),
    ...(planned !== undefined ? { plannedLinks: planned } : {}),
  }
  if (needsUser.length > 0) return partial(data, lines, [...needsUser, ...warnings.map(w => `warning: ${w}`)])
  return ok(data, lines, warnings)
}

export async function projectCheck(ctx: WorkflowCtx): Promise<CmdResult> {
  const facts = await repoFacts(ctx.cwd)
  const root = facts?.top ?? resolve(ctx.cwd)
  const notProject = nonProjectReason(root)
  if (notProject !== undefined) return fail('not_a_project', `${notProject}; run 'buracle project check' inside a repository`, { root })
  const audit = await auditAgentFiles(root, facts)
  const drift = audit.problems.filter(p => p.level === 'drift')
  const notes = audit.problems.filter(p => p.level !== 'drift')
  const lines = [
    `Agent files: ${root}${facts === undefined ? ' (not a git repository)' : ''}`,
    `Path rules: ${audit.rules.count} in .claude/rules (${audit.rules.private.length} gitignored), ${audit.rules.unindexed.length} missing from the index, ${audit.rules.mismatched.length} with other globs, ${audit.rules.dangling.length} listed but missing`,
    `Skill links: ${audit.links.missing.length} missing, ${audit.links.stale.length} stale, ${audit.links.conflicts.length} conflict(s), ${audit.links.claudeOnly.length} Claude-only skill(s)`,
    ...(drift.length === 0 ? ['In step: nothing to fix.'] : drift.map(p => `drift: ${p.message}`)),
  ]
  const data: Record<string, unknown> = { ok: drift.length === 0, root, git: facts !== undefined, ...audit }
  const recovery = drift.some(p => p.kind === 'links') ? ["run 'buracle project sync' to fix the skill links"] : []
  if (drift.length > 0) return partial(data, lines, [...drift.map(p => p.message), ...recovery, ...notes.map(p => `warning: ${p.message}`)])
  return ok(data, lines, notes.map(p => p.message))
}
