import { rmSync } from 'node:fs'
import { isLive, type MemItem } from '../core/memory/brain'
import { BACKUP_BUDGET } from '../core/memory/budgets'
import { memIsSlug } from '../core/memory/note'
import { log } from '../engine/log'
import { backupBrains } from './backup'
import { statusFile } from './layout'
import { forgetProject } from './project'
import { bucketExists, deleteBucket, listAll, projectRef, recordEvent, withBrainLock } from './store'

export interface ProjectRemoval {
  slug: string
  brain: boolean
  memories: number
  total: number
  record: boolean
  /** The backup taken before the rows went, when there were rows. */
  backup?: string
}

/**
 * Removes a project: the rows of its bucket (by their id prefix; the person's and the other projects' stay), its status
 * and its record. A backup of the whole brain file comes first, and if it fails nothing is removed.
 */
export async function removeProject(slug: string, opts: { nowMs?: number, by?: string } = {}): Promise<ProjectRemoval> {
  if (!memIsSlug(slug)) throw new Error(`not a project slug: ${JSON.stringify(slug)}`)
  const nowMs = opts.nowMs ?? Date.now()
  const ref = projectRef(slug)
  const out: ProjectRemoval = { slug, brain: false, memories: 0, total: 0, record: false }
  await withBrainLock(ref, async () => {
    let items: MemItem[] = []
    try { items = await listAll(ref) } catch (e) { log('warn', 'memory: the brain could not be counted before its removal', { slug, error: e }) }
    out.brain = items.length > 0 || await bucketExists(ref).catch(() => false)
    out.total = items.length
    out.memories = items.filter(i => isLive(i, nowMs)).length
    if (out.brain) {
      const b = await backupBrains({ all: true }, { trigger: 'pre-remove', nowMs, keep: BACKUP_BUDGET.keep })
      if (b.manifest !== undefined) out.backup = b.manifest.id
      await deleteBucket(ref)
    }
    rmSync(statusFile(slug), { force: true })
    out.record = forgetProject(slug)
  })
  if (out.brain || out.record) recordEvent({ op: 'delete', layer: 'project', project: slug, n: out.total, by: opts.by ?? 'human' })
  return out
}
