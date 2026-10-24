import { isLive, regionOf, type MemItem, type MemRegion } from '../core/memory/brain'
import { memIsSlug } from '../core/memory/note'
import { memEmptyStatus, memHealth, memHealthLine, memMcpHealth, type MemoryStatus } from '../core/memory/status'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { cortexdbBinary } from '../engine/toolchain/cortexdb'
import { statusFile } from './layout'
import { redactionsSince } from './spool'
import { listAll, personRef, projectRef } from './store'

export type { MemoryStatus } from '../core/memory/status'

export function readStatus(slug?: string): MemoryStatus | undefined {
  if (slug !== undefined && !memIsSlug(slug)) return undefined
  const r = readJsonSafeSync<MemoryStatus>(statusFile(slug))
  return r.ok && r.value !== null && typeof r.value === 'object' && r.value.v === 3 ? r.value : undefined
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

export interface ComputeStatusOptions {
  slug?: string
  nowMs?: number
  lastWrite?: { by: string, type?: string }
  lastCapture?: { by: string, saved: number }
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
  s.redactions_24h = redactionsSince(now - 24 * 3600_000)
  const prev = readStatus(opts.slug)
  if (opts.lastWrite !== undefined) s.last_write = { at, by: opts.lastWrite.by, ...(opts.lastWrite.type !== undefined ? { type: opts.lastWrite.type } : {}) }
  else if (prev?.last_write !== undefined) s.last_write = prev.last_write
  if (opts.lastCapture !== undefined) s.last_capture = { at, by: opts.lastCapture.by, saved: opts.lastCapture.saved }
  else if (prev?.last_capture !== undefined) s.last_capture = prev.last_capture
  const h = memHealth({ storeOk: bin !== undefined, readable, mcpDown: memoryMcpHealth() === 'down', captures: s.captures })
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

/** The line the session-start text carries while the memory is unhealthy. */
export function healthLine(s: MemoryStatus | undefined): string | undefined {
  return memHealthLine(s)
}
