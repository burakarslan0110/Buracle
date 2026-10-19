import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import {
  CORE_SECTIONS, coreId, isLive, KIND_INFO, pruneCandidates, sourcePath, upkeepFindings, type MemItem, type MemKind, type PruneItem, type UpkeepItem,
} from '../core/memory/brain'
import { similarMemories } from '../core/memory/brain'
import { detectedBlock, detectedSummary, withDetectedBlock } from '../core/memory/repo'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { run } from '../engine/proc'
import { closeCortex } from './cortex'
import { movedSources } from './curate'
import { appendJob, trimJobs } from './jobs'
import { brainAbsorbedDir, sweepStateFile, upkeepFile } from './layout'
import { dropMerged, mergedProjects, projectRoot, readProjectsCache } from './project'
import { projectScan } from './repo-scan'
import { brainExists, brainSig, deleteItem, getStored, listAll, personRef, projectRef, recordEvent, saveItem, withBrainLock, type BrainRef } from './store'
import { discoverSources, type SourcedItem } from './sources'
import { knownFiles, trackedFiles } from './evidence'
import { settledIds } from './verify-start'
import { distinctPairs, dropGoneSources, dropUnfiledCaptures, markDistinctDuplicates, settleContradictions, type DroppedSources, type SettledContradictions } from './settle'
import { focusRuns, readReflectRuns } from './reflect-log'
import { fixMemoryLinks, type LinkFix } from './links'

export interface UpkeepRecord {
  v: 1
  at: string
  layer: 'project' | 'person'
  project?: string
  items: UpkeepItem[]
  changed: Record<string, string[]>
  gitAt?: string
  sig?: string
}

import { readUpkeep } from './upkeep-file'
export { readUpkeep }

function writeUpkeep(slug: string | undefined, rec: UpkeepRecord): void {
  atomicWriteSync(upkeepFile(slug), JSON.stringify(rec, null, 2) + '\n', { mode: 0o600 })
}

function missingSources(items: readonly MemItem[], root: string | undefined): Set<string> {
  const out = new Set<string>()
  if (root === undefined) return out
  for (const i of items) {
    for (const s of i.sources) {
      const p = sourcePath(s)
      if (p !== undefined && !existsSync(join(root, p))) out.add(p)
    }
  }
  return out
}

async function changedSources(items: readonly MemItem[], root: string): Promise<Record<string, string[]>> {
  const byCommit = new Map<string, Array<{ id: string, paths: string[] }>>()
  for (const i of items) {
    const commit = i.verifiedCommit ?? i.commit
    if (i.review !== 'ok' || commit === undefined || !/^[0-9a-f]{4,40}$/.test(commit)) continue
    const paths = [...new Set(i.sources.map(sourcePath).filter((p): p is string => p !== undefined))]
    if (paths.length === 0) continue
    byCommit.set(commit, [...(byCommit.get(commit) ?? []), { id: i.id, paths }])
  }
  const out: Record<string, string[]> = {}
  if (byCommit.size === 0) return out
  const tracked = await trackedFiles(root)
  for (const [commit, list] of [...byCommit.entries()].slice(0, 40)) {
    const known = await run(['git', 'cat-file', '-e', `${commit}^{commit}`], { cwd: root, timeoutMs: 5000, env: { LC_ALL: 'C' } })
    if (known.code !== 0) continue
    const all = [...new Set(list.flatMap(l => l.paths))]
    const diff = await run(['git', 'diff', '--name-only', commit, 'HEAD', '--', ...all], { cwd: root, timeoutMs: 8000, env: { LC_ALL: 'C' } })
    if (diff.code !== 0) continue
    const changed = new Set(diff.stdout.split('\n').map(l => l.trim()).filter(Boolean))
    for (const l of list) {
      const hit = l.paths.filter(p => changed.has(p) && tracked.has(p))
      if (hit.length > 0) out[l.id] = hit
    }
  }
  return out
}

export function twinsAfterWrite(prev: UpkeepRecord | undefined, items: readonly MemItem[], writtenId: string, nowMs: number): Map<string, string> {
  const twins = new Map((prev?.items ?? []).filter(u => u.twin !== undefined && u.id !== writtenId && u.twin !== writtenId).map(u => [u.id, u.twin as string]))
  const i = items.find(x => x.id === writtenId)
  if (i !== undefined && isLive(i, nowMs) && !KIND_INFO[i.kind].generated && i.kind !== 'capture' && i.kind !== 'core') {
    const dup = similarMemories(i, items.filter(o => o.id !== i.id && o.kind !== 'core'), nowMs)[0]
    if (dup !== undefined) twins.set(i.id, dup.item.id)
  }
  return twins
}

export async function refreshUpkeepFor(ref: BrainRef, opts: { cwd?: string, nowMs: number, git?: boolean, items?: MemItem[],  changed?: Record<string, string[]>,  twins?: ReadonlyMap<string, string> }): Promise<UpkeepRecord> {
  const items = opts.items ?? await listAll(ref)
  const prev = readUpkeep(ref.slug)
  const root = ref.slug !== undefined ? projectRoot(ref.slug) : undefined
  let changed: Record<string, string[]> = {}
  let gitAt = prev?.gitAt
  if (ref.layer === 'project' && root !== undefined && opts.git === true) {
    try {
      changed = opts.changed ?? await changedSources(items, root)
      gitAt = new Date(opts.nowMs).toISOString()
    } catch (e) {
      log('warn', 'memory: git did not answer during upkeep', { slug: ref.slug, error: e })
      changed = prev?.changed ?? {}
    }
  } else if (prev !== undefined && prev.gitAt !== undefined) {
    for (const [id, files] of Object.entries(prev.changed)) {
      const i = items.find(x => x.id === id)
      if (i !== undefined && (i.verifiedAt === undefined || i.verifiedAt <= prev.gitAt)) changed[id] = files
    }
  }
  let settled: Set<string>
  try {
    settled = settledIds(items, ref.layer === 'project' && root !== undefined ? { root, known: await knownFiles(root) } : undefined)
  } catch (e) {
    log('warn', 'memory: the settled memories were not computed', { slug: ref.slug, error: e })
    settled = new Set()
  }
  const findings = upkeepFindings(items, { nowMs: opts.nowMs, missing: ref.layer === 'project' ? missingSources(items, root) : new Set(), changed: new Map(Object.entries(changed)), settled, distinct: distinctPairs(ref, items), ...(opts.twins !== undefined ? { twins: opts.twins } : {}) })
  const at = new Date(opts.nowMs).toISOString()
  const firstMissing = new Map((prev?.items ?? []).filter(u => u.since !== undefined).map(u => [u.id, u.since as string]))
  for (const f of findings) if (f.reasons.includes('source-missing')) f.since = firstMissing.get(f.id) ?? at
  const rec: UpkeepRecord = { v: 1, at, layer: ref.layer, items: findings, changed, sig: brainSig(ref.db) }
  if (ref.slug !== undefined) rec.project = ref.slug
  if (gitAt !== undefined) rec.gitAt = gitAt
  writeUpkeep(ref.slug, rec)
  return rec
}

const CORE_TITLES: Readonly<Record<string, string>> = {
  brief: 'Brief: what this project is and who it is for',
  architecture: 'Architecture: the parts and how they connect',
  conventions: 'Conventions: how code is written here',
  commands: 'Commands: build, test, lint and run',
  glossary: 'Glossary: the project\'s own terms',
  progress: 'Progress: where the work stands',
}

export async function syncCorePages(slug: string, nowMs: number, opts: { dryRun?: boolean, items?: MemItem[] } = {}): Promise<string[]> {
  const ref = projectRef(slug)
  const root = projectRoot(slug)
  const items = opts.items ?? await listAll(ref)
  const scan = root !== undefined ? projectScan(slug, root, nowMs)?.scan : undefined
  const changed: string[] = []
  const at = new Date(nowMs).toISOString()
  for (const section of CORE_SECTIONS) {
    const id = coreId(section)
    const cur = items.find(i => i.id === id)
    const block = detectedBlock(section, scan)
    if (cur !== undefined) {
      const body = withDetectedBlock(cur.body, block)
      const summary = cur.summary !== '' && !cur.summary.startsWith('Detected: ') ? cur.summary : (scan !== undefined ? detectedSummary(section, scan) ?? cur.summary : cur.summary)
      if (body === cur.body && summary === cur.summary) continue
      changed.push(id)
      if (opts.dryRun === true) continue
      await saveItem(ref, { ...cur, body, summary, updated: at, version: cur.version + 1, history: [...cur.history, { at, by: 'buracle', what: 'detected part refreshed from the repository' }].slice(-8) })
      continue
    }
    if (readProjectsCache().projects[slug] === undefined) continue
    changed.push(id)
    if (opts.dryRun === true) continue
    await saveItem(ref, {
      id, kind: 'core', layer: 'project', title: CORE_TITLES[section] ?? section, summary: scan !== undefined ? detectedSummary(section, scan) ?? '' : '',
      body: block, tags: ['core'], sources: [], about: [], status: 'active', review: 'ok', importance: 4, created: at, updated: at,
      author: 'buracle', version: 1, history: [{ at, by: 'buracle', what: 'created' }], harness: 'buracle',
    })
  }
  return changed
}

export interface SweepLayerReport {
  layer: 'project' | 'person'
  project?: string
  pruned: PruneItem[]
  core: string[]
  upkeep: number
  skipped?: string
  absorbed?: AbsorbReport[]
  moved?: Array<{ id: string, from: string, to: string }>
  sourced?: SourcedItem[]
  settled?: SettledContradictions
  dropped?: DroppedSources[]
  unfiled?: string[]
  distinct?: string[]
  links?: LinkFix[]
}

async function fixMovedSources(ref: BrainRef, items: MemItem[], tracked: ReadonlySet<string>, nowMs: number): Promise<Array<{ id: string, from: string, to: string }>> {
  const moves = movedSources(items.filter(i => isLive(i, nowMs) && !KIND_INFO[i.kind].generated), tracked)
  const out: Array<{ id: string, from: string, to: string }> = []
  if (moves.size === 0) return out
  const at = new Date(nowMs).toISOString()
  for (const i of items) {
    if (!isLive(i, nowMs) || KIND_INFO[i.kind].generated) continue
    const sources = i.sources.map(s => {
      const p = sourcePath(s)
      const to = p !== undefined ? moves.get(p) : undefined
      return to === undefined ? s : s.replace(p as string, to)
    })
    if (sources.every((s, n) => s === i.sources[n])) continue
    const changed = i.sources.map((s, n) => ({ from: sourcePath(s), to: sourcePath(sources[n] as string) })).filter(x => x.from !== undefined && x.to !== undefined && x.from !== x.to)
    const next: MemItem = {
      ...i, sources, updated: at, version: i.version + 1, review: 'pending',
      history: [...i.history, { at, by: 'buracle', what: `sources moved by git: ${changed.map(c => `${c.from} -> ${c.to}`).join(', ')}` }].slice(-8),
    }
    delete next.verifiedAt
    delete next.verifiedBy
    delete next.verifiedCommit
    const stored = await getStored(ref, i.id)
    if (stored === undefined || stored.item.version !== i.version) continue
    await saveItem(ref, next, stored.keep)
    Object.assign(i, next)
    recordEvent({ op: 'update', layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), id: i.id, kind: i.kind, by: 'buracle' })
    for (const c of changed) out.push({ id: i.id, from: c.from as string, to: c.to as string })
  }
  return out
}

export interface SweepReport { layers: SweepLayerReport[], dryRun: boolean }

export async function sweepLayer(ref: BrainRef, opts: { nowMs: number, dryRun?: boolean }): Promise<SweepLayerReport> {
  const base: SweepLayerReport = { layer: ref.layer, pruned: [], core: [], upkeep: 0 }
  if (ref.slug !== undefined) base.project = ref.slug
  if (!brainExists(ref) && ref.layer === 'person') return { ...base, skipped: 'no memory yet' }
  const root = ref.slug !== undefined ? projectRoot(ref.slug) : undefined
  let changed: Record<string, string[]> | undefined
  let tracked: Set<string> | undefined
  let known: Set<string> | undefined
  if (opts.dryRun !== true && ref.layer === 'project' && root !== undefined && brainExists(ref)) {
    try { changed = await changedSources(await listAll(ref), root) } catch (e) { log('warn', 'memory: git did not answer during the sweep', { slug: ref.slug, error: e }) }
    try { tracked = await trackedFiles(root); known = await knownFiles(root) } catch (e) { log('warn', 'memory: git ls-files did not answer during the sweep', { slug: ref.slug, error: e }) }
  }
  return withBrainLock(ref, async () => {
    let items = await listAll(ref)
    const pruned = pruneCandidates(items, opts.nowMs)
    if (opts.dryRun !== true) {
      for (const p of pruned) await deleteItem(ref, p.id)
      if (pruned.length > 0) recordEvent({ op: 'prune', layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), n: pruned.length, by: 'buracle' })
      items = items.filter(i => !pruned.some(p => p.id === i.id))
    }
    let links: LinkFix[] | undefined
    if (opts.dryRun !== true) {
      try {
        links = await fixMemoryLinks(ref, items, opts.nowMs)
        if (links.length > 0) items = await listAll(ref)
      } catch (e) { log('warn', 'memory: memory links were not fixed', { slug: ref.slug, error: e }) }
    }
    let moved: SweepLayerReport['moved']
    if (opts.dryRun !== true && tracked !== undefined && tracked.size > 0) {
      try { moved = await fixMovedSources(ref, items, tracked, opts.nowMs) } catch (e) { log('warn', 'memory: moved sources were not fixed', { slug: ref.slug, error: e }) }
    }
    let sourced: SourcedItem[] | undefined
    if (opts.dryRun !== true && root !== undefined && known !== undefined && known.size > 0) {
      try {
        sourced = await discoverSources(ref, items, root, opts.nowMs)
        if (sourced.length > 0) items = await listAll(ref)
      } catch (e) { log('warn', 'memory: sources were not found by name', { slug: ref.slug, error: e }) }
    }
    const focus = focusRuns(readReflectRuns(), ref)
    let settled: SettledContradictions | undefined
    let dropped: DroppedSources[] | undefined
    if (opts.dryRun !== true && ref.layer === 'project') {
      try {
        settled = await settleContradictions(ref, items, opts.nowMs, focus)
        if (settled.retired.length + settled.kept.length > 0) items = await listAll(ref)
      } catch (e) { log('warn', 'memory: contradictions were not settled', { slug: ref.slug, error: e }) }
      if (root !== undefined && known !== undefined) {
        try {
          const since = new Map((readUpkeep(ref.slug)?.items ?? []).filter(u => u.since !== undefined).map(u => [u.id, u.since as string]))
          dropped = await dropGoneSources(ref, items, since, root, known, opts.nowMs)
          if (dropped.length > 0) items = await listAll(ref)
        } catch (e) { log('warn', 'memory: gone sources were not dropped', { slug: ref.slug, error: e }) }
      }
    }
    let unfiled: string[] | undefined
    if (opts.dryRun !== true) {
      try {
        unfiled = await dropUnfiledCaptures(ref, items, focus, opts.nowMs)
        if (unfiled.length > 0) items = await listAll(ref)
      } catch (e) { log('warn', 'memory: unfiled captures were not dropped', { slug: ref.slug, error: e }) }
    }
    let distinct: string[] | undefined
    if (opts.dryRun !== true) {
      try { distinct = markDistinctDuplicates(ref, items, readUpkeep(ref.slug)?.items ?? [], focus, opts.nowMs) } catch (e) { log('warn', 'memory: unmerged duplicates were not marked distinct', { slug: ref.slug, error: e }) }
    }
    let core: string[] = []
    if (ref.slug !== undefined) {
      core = await syncCorePages(ref.slug, opts.nowMs, { ...(opts.dryRun === true ? { dryRun: true } : {}), items })
      if (core.length > 0 && opts.dryRun !== true) items = await listAll(ref)
    }
    const up = opts.dryRun === true
      ? upkeepFindings(items, { nowMs: opts.nowMs, missing: new Set(), changed: new Map() })
      : (await refreshUpkeepFor(ref, { nowMs: opts.nowMs, git: true, items, ...(changed !== undefined ? { changed } : {}) })).items
    if (opts.dryRun !== true) recordEvent({ op: 'sweep', layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), n: up.length, by: 'buracle' })
    return {
      ...base, pruned, core, upkeep: up.length, ...(moved !== undefined && moved.length > 0 ? { moved } : {}), ...(sourced !== undefined && sourced.length > 0 ? { sourced } : {}),
      ...(settled !== undefined && settled.retired.length + settled.kept.length > 0 ? { settled } : {}), ...(dropped !== undefined && dropped.length > 0 ? { dropped } : {}),
      ...(unfiled !== undefined && unfiled.length > 0 ? { unfiled } : {}), ...(distinct !== undefined && distinct.length > 0 ? { distinct } : {}), ...(links !== undefined && links.length > 0 ? { links } : {}),
    }
  })
}

const STAYS_BEHIND: ReadonlySet<MemKind> = new Set<MemKind>(['core', 'session', 'handoff'])

export interface AbsorbReport { from: string, copied: string[] }

export async function absorbMerged(slug: string, nowMs: number): Promise<AbsorbReport[]> {
  const out: AbsorbReport[] = []
  const target = projectRef(slug)
  for (const m of mergedProjects(slug)) {
    const src = projectRef(m)
    if (!brainExists(src)) { dropMerged(slug, m); continue }
    const copied = await withBrainLock(src, () => withBrainLock(target, async () => {
      const taken = new Set((await listAll(target)).map(i => i.id))
      const at = new Date(nowMs).toISOString()
      const ids: string[] = []
      for (const item of await listAll(src)) {
        if (!isLive(item, nowMs) || STAYS_BEHIND.has(item.kind) || taken.has(item.id)) continue
        await saveItem(target, { ...item, layer: 'project', history: [...item.history, { at, by: 'buracle', what: `taken over from the folder project ${m}` }] })
        ids.push(item.id)
      }
      await closeCortex(src.db)
      mkdirSync(brainAbsorbedDir(), { recursive: true, mode: 0o700 })
      const dest = join(brainAbsorbedDir(), existsSync(join(brainAbsorbedDir(), `${m}.db`)) ? `${m}-${nowMs}.db` : `${m}.db`)
      for (const suffix of ['', '-wal', '-shm']) if (existsSync(src.db + suffix)) renameSync(src.db + suffix, dest + suffix)
      return ids
    }))
    dropMerged(slug, m)
    if (copied.length > 0) recordEvent({ op: 'import', layer: 'project', project: slug, n: copied.length, by: 'buracle' })
    out.push({ from: m, copied })
  }
  return out
}

export async function sweep(opts: { slug?: string, all?: boolean, person?: boolean, nowMs?: number, dryRun?: boolean, trigger?: string }): Promise<SweepReport> {
  const nowMs = opts.nowMs ?? Date.now()
  const trigger = opts.trigger ?? 'cli'
  const slugs = opts.all === true ? Object.keys(readProjectsCache().projects).filter(s => brainExists(projectRef(s)) || projectRoot(s) !== undefined) : opts.slug !== undefined ? [opts.slug] : []
  const layers: SweepLayerReport[] = []
  for (const s of slugs) {
    let absorbed: AbsorbReport[] = []
    if (opts.dryRun !== true) {
      try { absorbed = await absorbMerged(s, nowMs) } catch (e) { log('warn', 'memory: taking over a merged folder project failed', { slug: s, error: e }) }
    }
    try {
      const layer = await sweepLayer(projectRef(s), { nowMs, ...(opts.dryRun === true ? { dryRun: true } : {}) })
      layers.push(absorbed.length > 0 ? { ...layer, absorbed } : layer)
    } catch (e) {
      log('warn', 'memory: sweep of a project failed', { slug: s, error: e })
      layers.push({ layer: 'project', project: s, pruned: [], core: [], upkeep: 0, skipped: (e as Error).message })
    }
  }
  if (opts.person !== false) {
    try { layers.push(await sweepLayer(personRef(), { nowMs, ...(opts.dryRun === true ? { dryRun: true } : {}) })) } catch (e) {
      layers.push({ layer: 'person', pruned: [], core: [], upkeep: 0, skipped: (e as Error).message })
    }
  }
  if (opts.dryRun !== true) {
    const ok = (l: SweepLayerReport): boolean => l.skipped === undefined || l.skipped === 'no memory yet'
    markSwept(layers.filter(ok).map(l => l.layer === 'person' ? PERSON_SWEEP_KEY : l.project as string), nowMs)
    for (const l of layers) {
      appendJob({
        job: 'sweep', trigger, outcome: ok(l) ? (l.skipped === undefined ? 'ran' : 'skipped') : 'failed',
        ...(l.skipped !== undefined ? { reason: ok(l) ? 'no-memory' : 'error', detail: l.skipped } : { detail: `deleted ${l.pruned.length}; ${l.core.length} core page(s) refreshed; ${l.upkeep} upkeep item(s)` }),
        layer: l.layer, ...(l.project !== undefined ? { project: l.project } : {}),
      })
    }
    trimJobs(nowMs)
    try {
      const { pruneDistillQueue } = await import('./distill')
      pruneDistillQueue({ nowMs })
    } catch (e) { log('warn', 'memory: the distill queue was not pruned', { error: e }) }
  }
  return { layers, dryRun: opts.dryRun === true }
}

const SWEEP_EVERY_MS = 6 * 3600_000
export const PERSON_SWEEP_KEY = '_person'

interface SweepState { v: 1, last: Record<string, number>, started?: Record<string, number> }

function readSweepState(): SweepState {
  const r = readJsonSafeSync<SweepState>(sweepStateFile())
  return r.ok && r.value !== null && typeof r.value === 'object' && r.value.v === 1 && typeof r.value.last === 'object' ? r.value : { v: 1, last: {} }
}

function markSwept(keys: readonly string[], nowMs: number): void {
  try {
    const s = readSweepState()
    for (const k of keys) { s.last[k] = nowMs; if (s.started) delete s.started[k] }
    atomicWriteSync(sweepStateFile(), JSON.stringify(s) + '\n')
  } catch (e) { log('warn', 'memory: sweep state not recorded', { error: e }) }
}

export function forgetSwept(slug: string): void {
  try {
    const s = readSweepState()
    if (s.last[slug] === undefined && s.started?.[slug] === undefined) return
    delete s.last[slug]
    if (s.started) delete s.started[slug]
    atomicWriteSync(sweepStateFile(), JSON.stringify(s) + '\n')
  } catch (e) { log('warn', 'memory: sweep state not updated', { error: e }) }
}

export function lastSwept(key: string): number | undefined {
  const t = readSweepState().last[key]
  return typeof t === 'number' && Number.isFinite(t) ? t : undefined
}

export function sweepDue(slug: string, nowMs: number): boolean {
  const s = readSweepState()
  const last = s.last[slug] ?? 0
  const started = s.started?.[slug] ?? 0
  return nowMs - last > SWEEP_EVERY_MS && nowMs - started > 30 * 60_000
}

export function markSweepStarted(slug: string, nowMs: number): void {
  try {
    const s = readSweepState()
    s.started = { ...(s.started ?? {}), [slug]: nowMs }
    atomicWriteSync(sweepStateFile(), JSON.stringify(s) + '\n')
  } catch {  }
}
