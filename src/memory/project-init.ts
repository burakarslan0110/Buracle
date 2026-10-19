import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { toplevel } from '../engine/git'
import { log } from '../engine/log'
import { applyPlans, readLedgerSync, type Plan } from '../engine/txn'
import { nonProjectReason, projectExclusion, resolveProject } from './project'
import { projectRef, withBrainLock } from './store'
import { syncCorePages } from './sweep'

export interface ProjectInitResult {
  slug: string
  scope: 'project' | 'adhoc'
  db: string
  core: string[]
  claudeRedirect: 'none' | 'removed' | 'kept'
  warnings: string[]
}

const LOCAL_SETTINGS = '.claude/settings.local.json'

export async function removeClaudeRedirects(files?: readonly string[]): Promise<{ removed: string[], kept: Array<{ path: string, why: string }> }> {
  const ledger = readLedgerSync()
  const keys = Object.keys(ledger).filter(k => k.endsWith('#autoMemoryDirectory') && ledger[k]?.owner === 'memory' && (files === undefined || files.includes(k.slice(0, -'#autoMemoryDirectory'.length))))
  const removed: string[] = []
  const kept: Array<{ path: string, why: string }> = []
  for (const key of keys) {
    const path = key.slice(0, -'#autoMemoryDirectory'.length)
    const plans: Plan[] = [{ id: `memory-project-redirect-off-${removed.length + kept.length}`, harness: 'claude', ops: [{ kind: 'remove', path: key, owner: 'memory' }] }]
    try {
      const r = await applyPlans(plans)
      if (r.conflicts.length > 0) kept.push({ path, why: r.conflicts.map(c => c.detail).join('; ') })
      else removed.push(path)
    } catch (e) {
      log('warn', 'memory: the old Claude Code memory redirect was not removed', { path, error: e })
      kept.push({ path, why: (e as Error).message })
    }
  }
  return { removed, kept }
}

export async function projectInit(cwd: string): Promise<ProjectInitResult> {
  const abs = resolve(cwd)
  const why = nonProjectReason(abs)
  if (why !== undefined) throw new Error(`${abs} is not a project directory (${why})`)
  const excluded = await projectExclusion(abs)
  if (excluded !== undefined) throw new Error(`${abs} is ${excluded}: Buracle keeps no project memory for it`)
  const rec = await resolveProject(abs)
  if (!rec) throw new Error(`cannot resolve a project for ${abs}`)
  const warnings: string[] = []
  let core: string[] = []
  if (cortexdbBinary() !== undefined) {
    try { core = await withBrainLock(projectRef(rec.slug), () => syncCorePages(rec.slug, Date.now())) } catch (e) { warnings.push(`core pages not written: ${(e as Error).message}`) }
  } else {
    warnings.push('CortexDB is not installed yet, so the core pages wait (buracle install)')
  }
  const top = (await toplevel(abs)) ?? abs
  const settings = join(top, LOCAL_SETTINGS)
  let claudeRedirect: ProjectInitResult['claudeRedirect'] = 'none'
  if (existsSync(settings)) {
    const r = await removeClaudeRedirects([settings])
    if (r.removed.length > 0) claudeRedirect = 'removed'
    if (r.kept.length > 0) {
      claudeRedirect = 'kept'
      warnings.push(`${settings} keeps an autoMemoryDirectory that is not Buracle's to remove (${r.kept[0]?.why ?? 'changed'}); Claude Code's own auto memory is off, so it is unused`)
    }
  }
  return { slug: rec.slug, scope: rec.scope, db: projectRef(rec.slug).db, core, claudeRedirect, warnings }
}
