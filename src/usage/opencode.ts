import { Database } from 'bun:sqlite'
import { statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { opencodeDataDir } from '../engine/paths'
import { dayKeyOf, localIso, monthDays, monthKeyOf, monthRange } from './month'
import type { ModelTotals } from './scan'
import { finishAggregate, loadStore, mergeTotals, saveStore } from './scan'
import { latestWindows } from './telemetry'
import type { CollectOptions, UsageCacheEntry } from './types'

export function opencodeDbPath(): string {
  const env = process.env['OPENCODE_DB']
  if (env !== undefined && env.trim() !== '' && env !== ':memory:') return isAbsolute(env) ? env : join(opencodeDataDir(), env)
  return join(opencodeDataDir(), 'opencode.db')
}

interface Row { id: string; sid: string | null; at: number | null; provider: string | null; model: string | null; cost: number | null; input: number | null; output: number | null; reasoning: number | null; cread: number | null; cwrite: number | null }

function n(x: number | null | undefined): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0
}

function fingerprint(path: string): string | undefined {
  const parts: string[] = []
  for (const p of [path, `${path}-wal`]) {
    try {
      const st = statSync(p)
      parts.push(`${st.size}:${Math.floor(st.mtimeMs)}`)
    } catch {
      if (p === path) return undefined
      parts.push('-')
    }
  }
  return parts.join('|')
}

export interface OpencodeTotals { totals: Record<string, ModelTotals>, days: Record<string, Record<string, ModelTotals>>, sessions: Record<string, Record<string, ModelTotals>>, tables: string[] }

export function readOpencodeMonth(dbPath: string, startMs: number, endMs: number): OpencodeTotals {
  const db = new Database(dbPath, { readonly: true })
  try {
    db.run('PRAGMA busy_timeout = 2000')
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_message', 'message')").all() as Array<{ name: string }>).map(r => r.name).sort()
    const totals: Record<string, ModelTotals> = {}
    const days: Record<string, Record<string, ModelTotals>> = {}
    const sessions: Record<string, Record<string, ModelTotals>> = {}
    const seen = new Set<string>()
    const count = (into: Record<string, ModelTotals>, r: Row) => {
      const model = r.model ?? 'unknown'
      const key = r.provider ? `${r.provider}/${model}` : model
      const input = n(r.input)
      const output = n(r.output) + n(r.reasoning)
      const cacheRead = n(r.cread)
      const cacheWrite = n(r.cwrite)
      if (input + output + cacheRead + cacheWrite === 0 && n(r.cost) === 0) return
      const t = (into[key] ??= { tokens: 0, costUsd: 0, unpriced: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })
      t.tokens += input + output + cacheRead + cacheWrite
      if (n(r.cost) > 0) t.costUsd += n(r.cost)
      else {
        t.unpriced.input += input
        t.unpriced.output += output
        t.unpriced.cacheRead += cacheRead
        t.unpriced.cacheWrite += cacheWrite
      }
      if (r.provider) t.priceModel = model
    }
    const add = (r: Row) => {
      const one: Record<string, ModelTotals> = {}
      count(one, r)
      mergeTotals(totals, one)
      if (typeof r.at === 'number' && Number.isFinite(r.at)) mergeTotals((days[dayKeyOf(r.at)] ??= {}), one)
      if (typeof r.sid === 'string' && r.sid !== '') mergeTotals((sessions[r.sid] ??= {}), one)
    }
    if (tables.includes('session_message')) {
      const rows = db.query(`SELECT id, session_id AS sid, time_created AS at,
          json_extract(data, '$.model.providerID') AS provider, json_extract(data, '$.model.id') AS model,
          json_extract(data, '$.cost') AS cost,
          json_extract(data, '$.tokens.input') AS input, json_extract(data, '$.tokens.output') AS output,
          json_extract(data, '$.tokens.reasoning') AS reasoning,
          json_extract(data, '$.tokens.cache.read') AS cread, json_extract(data, '$.tokens.cache.write') AS cwrite
        FROM session_message
        WHERE type IN ('assistant', 'compaction') AND time_created >= ?1 AND time_created < ?2`).all(startMs, endMs) as Row[]
      for (const r of rows) { seen.add(r.id); add(r) }
    }
    if (tables.includes('message')) {
      const rows = db.query(`SELECT id, session_id AS sid, time_created AS at,
          json_extract(data, '$.providerID') AS provider, json_extract(data, '$.modelID') AS model,
          json_extract(data, '$.cost') AS cost,
          json_extract(data, '$.tokens.input') AS input, json_extract(data, '$.tokens.output') AS output,
          json_extract(data, '$.tokens.reasoning') AS reasoning,
          json_extract(data, '$.tokens.cache.read') AS cread, json_extract(data, '$.tokens.cache.write') AS cwrite
        FROM message
        WHERE time_created >= ?1 AND time_created < ?2 AND json_extract(data, '$.role') = 'assistant'`).all(startMs, endMs) as Row[]
      for (const r of rows) if (!seen.has(r.id)) add(r)
    }
    return { totals, days, sessions, tables }
  } finally {
    db.close()
  }
}

export async function collectOpencode(opts: CollectOptions): Promise<UsageCacheEntry> {
  const ym = opts.month ?? monthKeyOf(opts.nowMs)
  const range = monthRange(ym)
  const entry: UsageCacheEntry = {
    harness: 'opencode',
    computed_at: new Date(opts.nowMs).toISOString(),
    windows: latestWindows('opencode', opts.nowMs),
    month: { start: localIso(range.startMs), tokens: 0, byModel: {} },
    month_key: ym,
  }
  const dbPath = opencodeDbPath()
  const fp = fingerprint(dbPath)
  if (fp === undefined) {
    entry.notes = [`no OpenCode database at ${dbPath}`]
    return entry
  }
  const store = loadStore<never>('opencode')
  const cache = store.meta['months'] as Record<string, { fp: string, totals: Record<string, ModelTotals>, days?: Record<string, Record<string, ModelTotals>> }> | undefined
  const hit = cache?.[ym]
  let totals = hit?.fp === fp && hit.days !== undefined ? hit.totals : undefined
  let days = hit?.fp === fp ? hit.days : undefined
  if (totals === undefined || days === undefined) {
    try {
      const read = readOpencodeMonth(dbPath, range.startMs, range.endMs)
      totals = read.totals
      days = read.days
    } catch (e) {
      entry.notes = [`OpenCode database unreadable: ${e instanceof Error ? e.message : String(e)}`]
      return entry
    }
    const months = { ...(cache ?? {}), [ym]: { fp, totals, days } }
    for (const k of Object.keys(months)) if (k !== ym && k !== monthKeyOf(opts.nowMs)) delete months[k]
    store.meta['months'] = months
    saveStore(store)
  }
  const agg = finishAggregate(totals, opts.pricing)
  entry.month.tokens = agg.tokens
  entry.month.byModel = agg.byModel
  if (agg.usd !== undefined) entry.month.usd = agg.usd
  const perDay = days
  entry.days = monthDays(ym, opts.nowMs).flatMap(day => {
    const a = finishAggregate(perDay[day] ?? {}, opts.pricing)
    return a.tokens > 0 ? [{ day, tokens: a.tokens, ...(a.usd !== undefined ? { usd: a.usd } : {}) }] : []
  })
  return entry
}
