import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { PricingTable } from '../core/usage'
import { priceOf } from '../core/usage'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { buracleHome } from '../engine/paths'
import { dayKeyOf, monthKeyOf, shiftDay, shiftMonth } from './month'

export interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number }

export interface UsageEvent extends TokenCounts {
  ts: number
  model: string
  priceModel?: string
  key?: string
  tokens?: number
  costUsd?: number
  fallback?: boolean
}

export interface ModelTotals { tokens: number; costUsd: number; unpriced: TokenCounts; priceModel?: string }
export type MonthTotals = Record<string, Record<string, ModelTotals>>

export interface FileCursor<C> {
  size: number
  mtimeMs: number
  offset: number
  tail: string
  order: number
  primary: MonthTotals
  fallback?: MonthTotals
  days?: MonthTotals
  fallbackDays?: MonthTotals
  session?: string
  hasPrimary?: boolean
  keys: Record<string, string[]>
  carry: C
  compressed?: boolean
}

export interface CursorStore<C> { v: 1; collector: string; files: Record<string, FileCursor<C>>; meta: Record<string, unknown> }

export interface ScanFile {
  path: string
  id?: string
  order: number
  compressed?: boolean
  session?: string
}

export interface ScanSpec<C> {
  files: ScanFile[]
  parse(line: string, carry: C): UsageEvent[] | undefined
  initCarry(): C
  nowMs: number
  readCompressed?(path: string): Promise<Uint8Array | undefined>
}

export interface ScanStats { files: number; read: number; bytes: number; events: number; reset: number }

const TAIL_BYTES = 64
const KEY_MONTHS = 1
const KEEP_MONTHS = 13
export const KEEP_DAYS = 92

export function cursorFile(collector: string): string {
  return join(buracleHome(), 'cache', 'usage', `${collector}.json`)
}

export function emptyStore<C>(collector: string): CursorStore<C> {
  return { v: 1, collector, files: {}, meta: {} }
}

export function loadStore<C>(collector: string, path = cursorFile(collector)): CursorStore<C> {
  const r = readJsonSafeSync<CursorStore<C>>(path)
  if (!r.ok || r.value === null || typeof r.value !== 'object' || r.value.v !== 1 || r.value.collector !== collector || typeof r.value.files !== 'object' || r.value.files === null) {
    return emptyStore(collector)
  }
  return { v: 1, collector, files: r.value.files, meta: r.value.meta && typeof r.value.meta === 'object' ? r.value.meta : {} }
}

export function saveStore<C>(store: CursorStore<C>, path = cursorFile(store.collector)): void {
  atomicWriteSync(path, JSON.stringify(store) + '\n')
}

export function shortHash(data: string | Uint8Array): string {
  return Bun.hash(data).toString(36)
}

function readRange(path: string, start: number, end: number): Uint8Array | undefined {
  if (end <= start) return new Uint8Array(0)
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = new Uint8Array(end - start)
    let off = 0
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off)
      if (n <= 0) break
      off += n
    }
    return off === buf.length ? buf : buf.subarray(0, off)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch {  } }
  }
}

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0
}

function freshCursor<C>(f: ScanFile, carry: C): FileCursor<C> {
  return { size: 0, mtimeMs: 0, offset: 0, tail: '', order: f.order, primary: {}, days: {}, keys: {}, carry, ...(f.session !== undefined ? { session: f.session } : {}) }
}

function addEvent(target: MonthTotals, ym: string, ev: UsageEvent): void {
  const month = (target[ym] ??= {})
  const t = (month[ev.model] ??= { tokens: 0, costUsd: 0, unpriced: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
  const input = num(ev.input)
  const output = num(ev.output)
  const cacheRead = num(ev.cacheRead)
  const cacheWrite = num(ev.cacheWrite)
  t.tokens += ev.tokens !== undefined && num(ev.tokens) > 0 ? num(ev.tokens) : input + output + cacheRead + cacheWrite
  if (num(ev.costUsd) > 0) t.costUsd += num(ev.costUsd)
  else {
    t.unpriced.input += input
    t.unpriced.output += output
    t.unpriced.cacheRead += cacheRead
    t.unpriced.cacheWrite += cacheWrite
  }
  if (ev.priceModel !== undefined && ev.priceModel !== ev.model) t.priceModel = ev.priceModel
}

function pruneKeys(m: MonthTotals | undefined, keepFrom: string): void {
  if (m === undefined) return
  for (const ym of Object.keys(m)) if (ym < keepFrom) delete m[ym]
}

export async function scanFiles<C>(store: CursorStore<C>, spec: ScanSpec<C>): Promise<ScanStats> {
  const stats: ScanStats = { files: spec.files.length, read: 0, bytes: 0, events: 0, reset: 0 }
  const current = monthKeyOf(spec.nowMs)
  const keysFrom = shiftMonth(current, KEY_MONTHS)
  const keepFrom = shiftMonth(current, KEEP_MONTHS)
  const keepDaysFrom = shiftDay(dayKeyOf(spec.nowMs), KEEP_DAYS)
  const owned = new Set<string>()
  for (const cur of Object.values(store.files)) for (const list of Object.values(cur.keys ?? {})) for (const k of list) owned.add(k)
  const decoder = new TextDecoder()

  const ingest = (cur: FileCursor<C>, text: string): void => {
    for (const line of text.split('\n')) {
      if (line.length < 2) continue
      let events: UsageEvent[] | undefined
      try { events = spec.parse(line, cur.carry) } catch { events = undefined }
      if (!events) continue
      for (const ev of events) {
        if (!Number.isFinite(ev.ts) || typeof ev.model !== 'string' || ev.model === '') continue
        const ym = monthKeyOf(ev.ts)
        if (ev.key !== undefined) {
          const k = ev.fallback ? `c:${ev.key}` : ev.key
          if (owned.has(k)) continue
          owned.add(k)
          if (ym >= keysFrom) (cur.keys[ym] ??= []).push(k)
        }
        const day = dayKeyOf(ev.ts)
        if (ev.fallback) {
          addEvent((cur.fallback ??= {}), ym, ev)
          if (day >= keepDaysFrom) addEvent((cur.fallbackDays ??= {}), day, ev)
        } else {
          addEvent(cur.primary, ym, ev)
          if (day >= keepDaysFrom) addEvent((cur.days ??= {}), day, ev)
          cur.hasPrimary = true
        }
        stats.events++
      }
    }
  }

  const files = [...spec.files].sort((a, b) => a.order - b.order || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  for (const f of files) {
    let st: { size: number, mtimeMs: number }
    try {
      const s = statSync(f.path)
      if (!s.isFile()) continue
      st = { size: s.size, mtimeMs: Math.floor(s.mtimeMs) }
    } catch {
      continue
    }
    const id = f.id ?? f.path
    let cur = store.files[id]
    if (cur && f.session !== undefined && cur.session !== f.session) cur.session = f.session
    if (cur && cur.size === st.size && cur.mtimeMs === st.mtimeMs && cur.days !== undefined) continue

    if (f.compressed) {
      if (cur && !cur.compressed && cur.offset > 0 && cur.days !== undefined) {
        cur.compressed = true
        cur.size = st.size
        cur.mtimeMs = st.mtimeMs
        continue
      }
      const bytes = spec.readCompressed ? await spec.readCompressed(f.path) : undefined
      if (bytes === undefined) continue
      if (cur) { for (const list of Object.values(cur.keys)) for (const k of list) owned.delete(k); stats.reset++ }
      cur = freshCursor(f, spec.initCarry())
      const end = bytes.lastIndexOf(10) + 1
      ingest(cur, decoder.decode(bytes.subarray(0, end)))
      cur.offset = end
      cur.tail = shortHash(bytes.subarray(Math.max(0, end - TAIL_BYTES), end))
      cur.size = st.size
      cur.mtimeMs = st.mtimeMs
      cur.compressed = true
      store.files[id] = cur
      stats.read++
      stats.bytes += bytes.length
      continue
    }

    let from = 0
    if (cur && cur.offset > 0 && st.size >= cur.offset && cur.days !== undefined) {
      const tail = readRange(f.path, Math.max(0, cur.offset - TAIL_BYTES), cur.offset)
      if (tail !== undefined && shortHash(tail) === cur.tail) from = cur.offset
    }
    if (!cur || from === 0) {
      if (cur) {
        for (const list of Object.values(cur.keys)) for (const k of list) owned.delete(k)
        if (cur.offset > 0) stats.reset++
      }
      cur = freshCursor(f, spec.initCarry())
    }
    const bytes = readRange(f.path, from, st.size)
    if (bytes === undefined) continue
    const end = bytes.lastIndexOf(10) + 1
    if (end > 0) {
      ingest(cur, decoder.decode(bytes.subarray(0, end)))
      const newOffset = from + end
      const tailBytes = end >= TAIL_BYTES ? bytes.subarray(end - TAIL_BYTES, end) : readRange(f.path, Math.max(0, newOffset - TAIL_BYTES), newOffset)
      cur.offset = newOffset
      cur.tail = tailBytes === undefined ? '' : shortHash(tailBytes)
    }
    cur.size = st.size
    cur.mtimeMs = st.mtimeMs
    cur.order = f.order
    store.files[id] = cur
    stats.read++
    stats.bytes += bytes.length
  }

  const present = new Set(files.map(f => f.id ?? f.path))
  for (const [id, cur] of Object.entries(store.files)) {
    pruneKeys(cur.primary, keepFrom)
    pruneKeys(cur.fallback, keepFrom)
    pruneKeys(cur.days, keepDaysFrom)
    pruneKeys(cur.fallbackDays, keepDaysFrom)
    for (const ym of Object.keys(cur.keys ?? {})) if (ym < keysFrom) delete cur.keys[ym]
    const empty = Object.keys(cur.primary).length === 0 && Object.keys(cur.fallback ?? {}).length === 0 && Object.keys(cur.keys ?? {}).length === 0
    if (!present.has(id) && empty) delete store.files[id]
  }
  return stats
}

export interface MonthAggregate { tokens: number; usd?: number; byModel: Record<string, { tokens: number; usd?: number }> }

export function mergeTotals(into: Record<string, ModelTotals>, from: Readonly<Record<string, ModelTotals>> | undefined): void {
  for (const [model, t] of Object.entries(from ?? {})) {
    const m = (into[model] ??= { tokens: 0, costUsd: 0, unpriced: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
    m.tokens += t.tokens
    m.costUsd += t.costUsd
    m.unpriced.input += t.unpriced.input
    m.unpriced.output += t.unpriced.output
    m.unpriced.cacheRead += t.unpriced.cacheRead
    m.unpriced.cacheWrite += t.unpriced.cacheWrite
    if (t.priceModel !== undefined) m.priceModel = t.priceModel
  }
}

export function aggregateMonth<C>(store: CursorStore<C>, ym: string, pricing: PricingTable): MonthAggregate {
  const merged: Record<string, ModelTotals> = {}
  for (const cur of Object.values(store.files)) mergeTotals(merged, (cur.hasPrimary ? cur.primary : (cur.fallback ?? {}))[ym])
  return finishAggregate(merged, pricing)
}

export function aggregateDays<C>(store: CursorStore<C>, days: readonly string[], pricing: PricingTable): Record<string, MonthAggregate> {
  const merged: Record<string, Record<string, ModelTotals>> = {}
  for (const day of days) merged[day] = {}
  for (const cur of Object.values(store.files)) {
    const src = cur.hasPrimary ? cur.days : cur.fallbackDays
    for (const day of days) mergeTotals(merged[day] as Record<string, ModelTotals>, src?.[day])
  }
  return Object.fromEntries(days.map(day => [day, finishAggregate(merged[day] as Record<string, ModelTotals>, pricing)]))
}

export function dailySeries<C>(store: CursorStore<C>, days: readonly string[], pricing: PricingTable): Array<{ day: string, tokens: number, usd?: number }> {
  const agg = aggregateDays(store, days, pricing)
  return days.flatMap(day => {
    const a = agg[day]
    return a === undefined || a.tokens <= 0 ? [] : [{ day, tokens: a.tokens, ...(a.usd !== undefined ? { usd: a.usd } : {}) }]
  })
}

export function aggregateSessions<C>(store: CursorStore<C>, pricing: PricingTable, sessionOf: (cur: FileCursor<C>) => string | undefined = cur => cur.session): Map<string, MonthAggregate> {
  const merged = new Map<string, Record<string, ModelTotals>>()
  for (const cur of Object.values(store.files)) {
    const sid = sessionOf(cur)
    if (sid === undefined || sid === '') continue
    let into = merged.get(sid)
    if (into === undefined) { into = {}; merged.set(sid, into) }
    for (const month of Object.values(cur.hasPrimary ? cur.primary : (cur.fallback ?? {}))) mergeTotals(into, month)
  }
  return new Map([...merged].map(([sid, t]) => [sid, finishAggregate(t, pricing)]))
}

export function finishAggregate(merged: Record<string, ModelTotals>, pricing: PricingTable): MonthAggregate {
  const out: MonthAggregate = { tokens: 0, byModel: {} }
  let usd: number | undefined
  for (const model of Object.keys(merged).sort()) {
    const t = merged[model] as ModelTotals
    const u = t.unpriced
    const needsPrice = u.input + u.output + u.cacheRead + u.cacheWrite > 0
    const est = needsPrice ? priceOf(t.priceModel ?? model, u, pricing) : 0
    const entry: { tokens: number; usd?: number } = { tokens: t.tokens }
    if (t.costUsd > 0 || est !== undefined) {
      entry.usd = round6(t.costUsd + (est ?? 0))
      usd = (usd ?? 0) + entry.usd
    }
    out.byModel[model] = entry
    out.tokens += t.tokens
  }
  if (usd !== undefined) out.usd = round6(usd)
  return out
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6
}
