import { isLive, type MemItem } from '../core/memory/brain'
import { brainStartText } from '../core/memory/brain'
import { memIsSlug } from '../core/memory/note'
import { MEMORY_INJECT } from '../core/memory/budgets'
import { log } from '../engine/log'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { CortexError } from './cortex'
import { gitProvenance, memoryExcludeConfig, memoryExcludeProblemText, projectExclusion, resolveProject } from './project'
import { healthLine, readStatus } from './status'
import { listAll, personRef, projectRef } from './store'

export const MEMORY_CONTEXT_MAX_BYTES = 9_600

const HANDOFF_FRESH_MS = 24 * 3600_000

export function freshHandoff(items: readonly MemItem[], nowMs: number, branch?: string, session?: string): MemItem | undefined {
  return items
    .filter(i => i.kind === 'handoff' && isLive(i, nowMs) && nowMs - Date.parse(i.created) < HANDOFF_FRESH_MS)
    .filter(i => branch === undefined || i.branch === undefined || i.branch === branch)
    .filter(i => session === undefined || i.session === session)
    .sort((a, b) => b.created.localeCompare(a.created))[0]
}

/** The text a session starts with. It only reads: nothing is spawned and nothing is written. */
export async function contextText(opts: { cwd: string, branch?: string, nowMs?: number, project?: string, maxBytes?: number }): Promise<string> {
  const now = opts.nowMs ?? Date.now()
  if (cortexdbBinary() === undefined) return ''
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
    // A brain that is being migrated is not an empty one: say so, so the agent does not conclude there is nothing to recall.
    if (e instanceof CortexError && (e.code === 'migrating' || e.code === 'migration_failed')) return `# Buracle memory (CortexDB brain)\n\n${e.message}\n`
    return ''
  }
  const health = healthLine(readStatus(slug))
  const branch = slug !== undefined ? opts.branch ?? (await gitProvenance(opts.cwd).catch(() => ({ branch: undefined }))).branch : undefined
  const handoff = slug !== undefined ? freshHandoff(projectItems, now, branch) : undefined
  const excluded = slug === undefined ? await projectExclusion(opts.cwd).catch(() => undefined) : undefined
  const problem = memoryExcludeConfig().problem
  return brainStartText({
    ...(excluded !== undefined ? { excluded } : {}),
    ...(problem !== undefined ? { configNote: memoryExcludeProblemText(problem) } : {}),
    nowMs: now, maxBytes, maxLines: inject.maxLines,
    ...(handoff !== undefined ? { handoff: { id: handoff.id, ...(handoff.branch !== undefined ? { branch: handoff.branch } : {}) } } : {}),
    ...(health !== undefined ? { health } : {}),
    ...(slug !== undefined ? { project: { slug, items: projectItems } } : {}),
    person: personItems,
  })
}
