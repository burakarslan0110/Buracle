import { statSync } from 'node:fs'
import type { Harness } from '../core/events'
import { HARNESSES } from '../core/events'
import type { PricingTable } from '../core/usage'
import type { CodexCarry } from './codex'
import { dayKeyOf, monthKeyOf, monthRange, shiftDay, shiftMonth } from './month'
import { opencodeDbPath, readOpencodeMonth } from './opencode'
import { loadPricing } from './pricing'
import type { CursorStore, FileCursor, ModelTotals } from './scan'
import { aggregateDays, aggregateMonth, aggregateSessions, cursorFile, finishAggregate, loadStore, mergeTotals } from './scan'

export interface UsageAmount { tokens: number; usd?: number }

export interface HarnessHistory {
  days: Record<string, UsageAmount>
  months: Record<string, UsageAmount>
  models: Record<string, UsageAmount>
  notes?: string[]
}

export interface UsageHistory {
  days: string[]
  months: string[]
  harnesses: Record<Harness, HarnessHistory>
}

export const HISTORY_DAYS = 30
export const HISTORY_MONTHS = 6

const SCANNED: Readonly<Record<Exclude<Harness, 'opencode'>, string>> = { claude: 'claude', codex: 'codex', omp: 'omp' }

const stores = new Map<string, { sig: string, store: CursorStore<unknown> }>()

function signature(path: string): string {
  try {
    const st = statSync(path)
    return `${st.size}:${st.mtimeMs}`
  } catch { return '-' }
}

function cachedStore(collector: string): CursorStore<unknown> {
  const file = cursorFile(collector)
  const sig = signature(file)
  const hit = stores.get(file)
  if (hit !== undefined && hit.sig === sig) return hit.store
  const store = loadStore<unknown>(collector, file)
  stores.set(file, { sig, store })
  return store
}

const OPENCODE_READS_KEPT = 4
const opencodeReads = new Map<string, { sig: string, read: ReturnType<typeof readOpencodeMonth> }>()

function keepRead(key: string, sig: string, read: ReturnType<typeof readOpencodeMonth>): void {
  opencodeReads.delete(key)
  opencodeReads.set(key, { sig, read })
  for (const old of opencodeReads.keys()) {
    if (opencodeReads.size <= OPENCODE_READS_KEPT) break
    opencodeReads.delete(old)
  }
}

function opencodeRange(startMs: number, endMs: number): ReturnType<typeof readOpencodeMonth> | { error: string } | undefined {
  const db = opencodeDbPath()
  const sig = `${signature(db)}|${signature(`${db}-wal`)}`
  if (sig.startsWith('-|')) return undefined
  const key = `${db}|${startMs}|${endMs}`
  const hit = opencodeReads.get(key)
  if (hit !== undefined && hit.sig === sig) {
    keepRead(key, sig, hit.read)
    return hit.read
  }
  try {
    const read = readOpencodeMonth(db, startMs, endMs)
    keepRead(key, sig, read)
    return read
  } catch (e) {
    return { error: `OpenCode database unreadable: ${e instanceof Error ? e.message : String(e)}` }
  }
}

function amount(a: { tokens: number, usd?: number }): UsageAmount {
  return a.usd !== undefined ? { tokens: a.tokens, usd: a.usd } : { tokens: a.tokens }
}

export function historyWindow(nowMs: number, days = HISTORY_DAYS, months = HISTORY_MONTHS): { days: string[], months: string[] } {
  const today = dayKeyOf(nowMs)
  const thisMonth = monthKeyOf(nowMs)
  return {
    days: Array.from({ length: days }, (_, i) => shiftDay(today, days - 1 - i)),
    months: Array.from({ length: months }, (_, i) => shiftMonth(thisMonth, months - 1 - i)),
  }
}

function scannedHistory(collector: string, window: { days: string[], months: string[] }, current: string, pricing: PricingTable): HarnessHistory {
  const store = cachedStore(collector)
  const days = aggregateDays(store, window.days, pricing)
  const out: HarnessHistory = { days: {}, months: {}, models: {} }
  for (const d of window.days) { const a = days[d]; if (a !== undefined && a.tokens > 0) out.days[d] = amount(a) }
  for (const m of window.months) { const a = aggregateMonth(store, m, pricing); if (a.tokens > 0) out.months[m] = amount(a) }
  for (const [model, a] of Object.entries(aggregateMonth(store, current, pricing).byModel)) out.models[model] = amount(a)
  return out
}

function opencodeHistory(window: { days: string[], months: string[] }, current: string, nowMs: number, pricing: PricingTable): HarnessHistory {
  const out: HarnessHistory = { days: {}, months: {}, models: {} }
  const first = window.months[0] ?? current
  const startMs = Math.min(monthRange(first).startMs, monthRange(window.days[0]?.slice(0, 7) ?? current).startMs)
  const read = opencodeRange(startMs, Math.max(nowMs + 1, monthRange(current).endMs))
  if (read === undefined) return out
  if ('error' in read) return { ...out, notes: [read.error] }
  const byMonth: Record<string, Record<string, ModelTotals>> = {}
  for (const [day, totals] of Object.entries(read.days)) mergeTotals((byMonth[day.slice(0, 7)] ??= {}), totals)
  for (const d of window.days) {
    const a = finishAggregate(read.days[d] ?? {}, pricing)
    if (a.tokens > 0) out.days[d] = amount(a)
  }
  for (const m of window.months) {
    const a = finishAggregate(byMonth[m] ?? {}, pricing)
    if (a.tokens > 0) out.months[m] = amount(a)
  }
  for (const [model, a] of Object.entries(finishAggregate(byMonth[current] ?? {}, pricing).byModel)) out.models[model] = amount(a)
  return out
}

export function usageHistory(opts: { nowMs: number, days?: number, months?: number, pricing?: PricingTable, harnesses?: readonly Harness[] }): UsageHistory {
  const pricing = opts.pricing ?? loadPricing()
  const window = historyWindow(opts.nowMs, opts.days, opts.months)
  const current = monthKeyOf(opts.nowMs)
  const harnesses = {} as Record<Harness, HarnessHistory>
  for (const h of opts.harnesses ?? HARNESSES) {
    harnesses[h] = h === 'opencode' ? opencodeHistory(window, current, opts.nowMs, pricing) : scannedHistory(SCANNED[h], window, current, pricing)
  }
  return { days: window.days, months: window.months, harnesses }
}

function codexSession(cur: FileCursor<unknown>): string | undefined {
  return cur.session ?? (cur.carry as CodexCarry | undefined)?.thread
}

export function sessionUsage(opts: { nowMs: number, sinceMs: number, pricing?: PricingTable }): Map<string, UsageAmount> {
  const pricing = opts.pricing ?? loadPricing()
  const out = new Map<string, UsageAmount>()
  for (const h of ['claude', 'codex', 'omp'] as const) {
    const sessions = aggregateSessions(cachedStore(SCANNED[h]), pricing, h === 'codex' ? codexSession : undefined)
    for (const [sid, a] of sessions) if (a.tokens > 0) out.set(`${h}:${sid}`, amount(a))
  }
  const read = opencodeRange(monthRange(monthKeyOf(opts.sinceMs)).startMs, Math.max(opts.nowMs + 1, monthRange(monthKeyOf(opts.nowMs)).endMs))
  if (read !== undefined && !('error' in read)) {
    for (const [sid, totals] of Object.entries(read.sessions)) {
      const a = finishAggregate(totals, pricing)
      if (a.tokens > 0) out.set(`opencode:${sid}`, amount(a))
    }
  }
  return out
}
