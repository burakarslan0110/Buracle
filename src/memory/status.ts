import { readdirSync } from 'node:fs'
import { CORE_SECTIONS, coreId, isLive, regionOf, type MemItem, type MemRegion } from '../core/memory/brain'
import { memIsSlug } from '../core/memory/note'
import { memEmptyStatus, memHealth, memMcpHealth, type MemoryStatus } from '../core/memory/status'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { checkEmbedModel } from '../engine/toolchain/embed-model'
import { distillQueueState } from './distill'
import { embedOff } from './embed'
import { distillQueueDir, statusFile } from './layout'
import { redactionsSince } from './spool'
import { listAll, personRef, projectRef } from './store'
import { readUpkeep } from './sweep'

export type { MemoryStatus } from '../core/memory/status'

export function readStatus(slug?: string): MemoryStatus | undefined {
  if (slug !== undefined && !memIsSlug(slug)) return undefined
  const r = readJsonSafeSync<MemoryStatus>(statusFile(slug))
  return r.ok && r.value !== null && typeof r.value === 'object' && r.value.v === 2 ? r.value : undefined
}

export function writeStatus(s: MemoryStatus): string {
  const file = statusFile(s.project)
  atomicWriteSync(file, JSON.stringify(s, null, 2) + '\n')
  return file
}

export function memoryMcpHealth(): 'ok' | 'down' | 'unknown' {
  const r = readJsonSafeSync<unknown>(paths.healthFile())
  return r.ok ? memMcpHealth(r.value, 'buracle-memory', Date.now()) : 'unknown'
}

function countFiles(dir: string): number {
  try { return readdirSync(dir).filter(n => !n.startsWith('.')).length } catch { return 0 }
}

function distillCounts(nowMs: number): MemoryStatus['distill'] {
  const pending = countFiles(distillQueueDir())
  if (pending === 0) return { pending }
  try {
    const q = distillQueueState({ nowMs })
    return { pending, ...(q.held > 0 ? { held: q.held } : {}), ...(q.until !== undefined ? { until: q.until } : {}) }
  } catch (e) {
    log('warn', 'memory: the distill queue could not be judged', { error: e })
    return { pending }
  }
}

export interface ComputeStatusOptions {
  slug?: string
  nowMs?: number
  lastWrite?: { by: string, type?: string }
  items?: { project?: MemItem[], person?: MemItem[] }
}

export async function computeStatus(opts: ComputeStatusOptions = {}): Promise<MemoryStatus> {
  const now = opts.nowMs ?? Date.now()
  const at = new Date(now).toISOString()
  const s = memEmptyStatus(at, opts.slug)
  const bin = cortexdbBinary()
  s.store = { engine: 'cortexdb', ok: bin !== undefined, ...(bin !== undefined ? { version: bin.version } : {}) }
  let readable = true
  let project: MemItem[] = []
  let person: MemItem[] = []
  if (bin !== undefined) {
    try {
      project = opts.items?.project ?? (opts.slug !== undefined ? await listAll(projectRef(opts.slug)) : [])
      person = opts.items?.person ?? await listAll(personRef())
    } catch (e) {
      readable = false
      log('warn', 'memory: status could not read the brain', { slug: opts.slug, error: e })
    }
  }
  const liveProject = project.filter(i => isLive(i, now))
  const livePerson = person.filter(i => isLive(i, now))
  s.counts = { project: liveProject.length, person: livePerson.length }
  const regions: Partial<Record<MemRegion, number>> = {}
  for (const i of opts.slug !== undefined ? liveProject : livePerson) regions[regionOf(i.kind)] = (regions[regionOf(i.kind)] ?? 0) + 1
  s.regions = regions
  s.captures = [...liveProject, ...livePerson].filter(i => i.kind === 'capture').length
  const waiting = (slug: string | undefined): number => (readUpkeep(slug)?.items ?? []).filter(u => u.quiet !== true).length
  s.upkeep = (opts.slug !== undefined ? waiting(opts.slug) : 0) + waiting(undefined)
  s.distill = distillCounts(now)
  s.redactions_24h = redactionsSince(now - 24 * 3600_000)
  const prev = readStatus(opts.slug)
  if (opts.lastWrite !== undefined) s.last_write = { at, by: opts.lastWrite.by, ...(opts.lastWrite.type !== undefined ? { type: opts.lastWrite.type } : {}) }
  else if (prev?.last_write !== undefined) s.last_write = prev.last_write
  const coreIds = new Set(liveProject.filter(i => i.kind === 'core').map(i => i.id))
  const coreMissing = opts.slug !== undefined && coreIds.size > 0 ? CORE_SECTIONS.filter(sec => !coreIds.has(coreId(sec))).length : 0
  const h = memHealth({
    storeOk: bin !== undefined, readable, mcpDown: memoryMcpHealth() === 'down',
    embedMissing: !embedOff() && checkEmbedModel().status !== 'ok',
    upkeep: s.upkeep, captures: s.captures, distillPending: s.distill.pending - (s.distill.held ?? 0), coreMissing,
  })
  s.health = h.health
  s.reasons = h.reasons
  return s
}

export async function refreshStatus(opts: ComputeStatusOptions = {}): Promise<MemoryStatus | undefined> {
  try {
    const s = await computeStatus(opts)
    writeStatus(s)
    return s
  } catch (e) {
    log('warn', 'memory: status not written', { slug: opts.slug, error: e })
    return undefined
  }
}
