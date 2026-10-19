import { basename } from 'node:path'
import { sourcePath, type MemItem, type UpkeepItem } from '../core/memory/brain'
import type { ReflectEvidence } from '../core/memory/reflect'
import { log } from '../engine/log'
import { excerptsFor, fitExcerpts, knownFiles } from './evidence'

const EVIDENCE_BUDGET_CHARS = 2400
const CANDIDATES_PER_PATH = 3
const MAX_CURATED = 4

export function sameNameFiles(path: string, tracked: Iterable<string>, max = CANDIDATES_PER_PATH): string[] {
  const name = basename(path)
  const out: string[] = []
  for (const f of tracked) {
    if (f !== path && basename(f) === name) out.push(f)
    if (out.length >= max) break
  }
  return out.sort()
}

export async function curatorEvidence(opts: { root?: string, items: readonly MemItem[], upkeep: readonly UpkeepItem[] }): Promise<Map<string, ReflectEvidence>> {
  const out = new Map<string, ReflectEvidence>()
  const missingOf = new Map<string, string[]>()
  for (const u of opts.upkeep) if (u.reasons.includes('source-missing') && u.files !== undefined) missingOf.set(u.id, u.files)
  const curated = opts.items.filter(i => (i.contradictedAt !== undefined && i.review === 'pending') || missingOf.has(i.id)).slice(0, MAX_CURATED)
  if (curated.length === 0) return out
  let known: Set<string> | undefined
  if (opts.root !== undefined) {
    try {
      known = await knownFiles(opts.root)
    } catch (e) {
      log('warn', 'memory: the curator could not read the repository', { root: opts.root, error: e })
    }
  }
  for (const i of curated) {
    const contradicted = i.contradictedAt !== undefined && i.review === 'pending'
    const missing = missingOf.get(i.id) ?? []
    const candidates = known !== undefined ? [...new Set(missing.flatMap(p => sameNameFiles(p, known as Set<string>)))] : []
    let excerpts: ReflectEvidence['excerpts'] = []
    if (contradicted && opts.root !== undefined && known !== undefined) {
      try {
        const cited = i.sources.map(sourcePath).filter((p): p is string => p !== undefined)
        const readable = cited.length === 0 || cited.some(p => known.has(p))
        if (readable) excerpts = fitExcerpts(await excerptsFor(opts.root, i, known), EVIDENCE_BUDGET_CHARS)
      } catch (e) {
        log('warn', 'memory: the curator could not read a memory\'s evidence', { id: i.id, error: e })
      }
    }
    out.set(i.id, { contradicted, ...(i.contradictedNote !== undefined && i.contradictedNote !== '' ? { note: i.contradictedNote } : {}), missing, candidates, excerpts })
  }
  return out
}

export function movedSources(items: readonly MemItem[], tracked: ReadonlySet<string>): Map<string, string> {
  const out = new Map<string, string>()
  for (const i of items) {
    for (const s of i.sources) {
      const p = sourcePath(s)
      if (p === undefined || tracked.has(p) || out.has(p)) continue
      const same = sameNameFiles(p, tracked, 2)
      if (same.length === 1) out.set(p, same[0] as string)
    }
  }
  return out
}
