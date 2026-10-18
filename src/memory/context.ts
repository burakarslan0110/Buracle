import { isHarness, type Harness } from '../core/events'
import { isLive, type MemItem } from '../core/memory/brain'
import { brainStartText } from '../core/memory/brain'
import { memIsSlug } from '../core/memory/note'
import { MEMORY_INJECT } from '../core/memory/budgets'
import { log } from '../engine/log'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { profileLines } from './profile'
import { healthLine, maybeStartHeal } from './heal'
import { gitProvenance, memoryExcludeConfig, memoryExcludeProblemText, projectExclusion, resolveProject } from './project'
import { spawnCli } from './spawn'
import { readStatus } from './status'
import { listAll, personRef, projectRef } from './store'
import { markSweepStarted, sweepDue } from './sweep'

export const MEMORY_CONTEXT_MAX_BYTES = 9_600

function isHarnessName(h: string | undefined): h is Harness {
  return h !== undefined && isHarness(h)
}

const HANDOFF_FRESH_MS = 24 * 3600_000

export function freshHandoff(items: readonly MemItem[], nowMs: number, branch?: string, session?: string): MemItem | undefined {
  return items
    .filter(i => i.kind === 'handoff' && isLive(i, nowMs) && nowMs - Date.parse(i.created) < HANDOFF_FRESH_MS)
    .filter(i => branch === undefined || i.branch === undefined || i.branch === branch)
    .filter(i => session === undefined || i.session === session)
    .sort((a, b) => b.created.localeCompare(a.created))[0]
}

export function maybeStartSweep(slug: string, nowMs: number): void {
  if (process.env['BURACLE_NO_AUTOSTART'] === '1' || !memIsSlug(slug)) return
  try {
    if (!sweepDue(slug, nowMs)) return
    markSweepStarted(slug, nowMs)
    spawnCli(['mem', 'sweep', '--project', slug, '--quiet'])
  } catch (e) {
    log('warn', 'memory: cannot start the sweep', { slug, error: e })
  }
}

export async function contextText(opts: { cwd: string, harness?: string, branch?: string, nowMs?: number, project?: string, maxBytes?: number, sweep?: boolean }): Promise<string> {
  const now = opts.nowMs ?? Date.now()
  const harness = isHarnessName(opts.harness) ? { harness: opts.harness } : {}
  if (cortexdbBinary() === undefined) {
    if (opts.sweep !== false) maybeStartHeal({ nowMs: now, trigger: 'session-start', storeProblem: 'cortexdb_missing', ...harness })
    return ''
  }
  const slug = (memIsSlug(opts.project) ? opts.project : undefined) ?? (await resolveProject(opts.cwd).catch(() => undefined))?.slug
  const inject = MEMORY_INJECT
  const wanted = typeof opts.maxBytes === 'number' && Number.isFinite(opts.maxBytes) ? Math.floor(opts.maxBytes) : MEMORY_CONTEXT_MAX_BYTES
  const maxBytes = Math.min(inject.maxBytes, wanted)
  if (maxBytes <= 0 || inject.maxLines <= 0) return ''
  let projectItems: MemItem[] = []
  let personItems: MemItem[] = []
  try {
    ;[projectItems, personItems] = await Promise.all([slug !== undefined ? listAll(projectRef(slug)) : Promise.resolve([]), listAll(personRef())])
  } catch (e) {
    log('warn', 'memory: the start text could not read the brain', { slug, error: e })
    if (opts.sweep !== false) maybeStartHeal({ ...(slug !== undefined ? { slug } : {}), nowMs: now, trigger: 'session-start', storeProblem: 'brain_unreadable', ...harness })
    return ''
  }
  if (slug !== undefined && opts.sweep !== false) maybeStartSweep(slug, now)
  if (opts.sweep !== false) maybeStartHeal({ ...(slug !== undefined ? { slug } : {}), nowMs: now, trigger: 'session-start', ...harness })
  const health = healthLine(readStatus(slug))
  const branch = slug !== undefined ? opts.branch ?? (await gitProvenance(opts.cwd).catch(() => ({ branch: undefined }))).branch : undefined
  const handoff = slug !== undefined ? freshHandoff(projectItems, now, branch) : undefined
  const excluded = slug === undefined ? await projectExclusion(opts.cwd).catch(() => undefined) : undefined
  const problem = memoryExcludeConfig().problem
  return brainStartText({
    ...(excluded !== undefined ? { excluded } : {}),
    ...(problem !== undefined ? { configNote: memoryExcludeProblemText(problem) } : {}),
    nowMs: now, maxBytes, maxLines: inject.maxLines,
    profile: profileLines(personItems, 10),
    ...(handoff !== undefined ? { handoff: { id: handoff.id, ...(handoff.branch !== undefined ? { branch: handoff.branch } : {}) } } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(slug !== undefined ? { project: { slug, items: projectItems } } : {}),
    person: personItems,
  })
}
