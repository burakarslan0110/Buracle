import { rmSync } from 'node:fs'
import { isLive, type MemItem } from '../core/memory/brain'
import { memIsSlug } from '../core/memory/note'
import { log } from '../engine/log'
import { closeCortex } from './cortex'
import { statusFile } from './layout'
import { forgetProject } from './project'
import { brainExists, listAll, projectRef, recordEvent, withBrainLock } from './store'

export interface ProjectRemoval {
  slug: string
  brain: boolean
  memories: number
  total: number
  record: boolean
}

export async function removeProject(slug: string, opts: { nowMs?: number, by?: string } = {}): Promise<ProjectRemoval> {
  if (!memIsSlug(slug)) throw new Error(`not a project slug: ${JSON.stringify(slug)}`)
  const nowMs = opts.nowMs ?? Date.now()
  const ref = projectRef(slug)
  const out: ProjectRemoval = { slug, brain: false, memories: 0, total: 0, record: false }
  await withBrainLock(ref, async () => {
    if (brainExists(ref)) {
      let items: MemItem[] = []
      try { items = await listAll(ref) } catch (e) { log('warn', 'memory: the brain could not be counted before its removal', { slug, error: e }) }
      out.brain = true
      out.total = items.length
      out.memories = items.filter(i => isLive(i, nowMs)).length
      await closeCortex(ref.db)
      for (const suffix of ['', '-wal', '-shm']) rmSync(ref.db + suffix, { force: true })
    }
    rmSync(statusFile(slug), { force: true })
    out.record = forgetProject(slug)
  })
  if (out.brain || out.record) recordEvent({ op: 'delete', layer: 'project', project: slug, n: out.total, by: opts.by ?? 'human' })
  return out
}
