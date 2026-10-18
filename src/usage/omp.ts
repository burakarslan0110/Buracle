import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { RateWindow } from '../core/status/model'
import { windowLabel } from '../core/status/model'
import { isValidSessionId, ompAgentDir } from '../engine/paths'
import { run, which as whichBin } from '../engine/proc'
import { localIso, monthDays, monthKeyOf, monthRange } from './month'
import type { ScanFile, UsageEvent } from './scan'
import { aggregateMonth, dailySeries, loadStore, saveStore, scanFiles, shortHash } from './scan'
import type { CollectOptions, Runner, UsageCacheEntry } from './types'

export type OmpCarry = Record<string, never>

export const OMP_USAGE_TTL_MS = 5 * 60_000
const OMP_USAGE_TIMEOUT_MS = 8_000

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0
}

function obj(x: unknown): Record<string, unknown> | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined
}

export function parseOmpLine(line: string, _carry: OmpCarry): UsageEvent[] | undefined {
  if (!line.includes('"usage"')) return undefined
  const o = JSON.parse(line) as Record<string, unknown>
  let u: Record<string, unknown> | undefined
  let model: unknown
  let provider: unknown
  let tsAlt: unknown
  if (o['type'] === 'message') {
    const m = obj(o['message'])
    if (m === undefined || m['role'] !== 'assistant') return undefined
    u = obj(m['usage'])
    model = m['model']
    provider = m['provider']
    tsAlt = m['timestamp']
  } else if (o['type'] === 'model_usage') {
    u = obj(o['usage'])
    model = o['model']
    provider = o['provider']
  } else return undefined
  if (u === undefined || typeof model !== 'string' || model === '') return undefined
  let ts = Date.parse(String(o['timestamp']))
  if (!Number.isFinite(ts) && typeof tsAlt === 'number') ts = tsAlt
  if (!Number.isFinite(ts)) return undefined
  const ev: UsageEvent = {
    ts,
    model: typeof provider === 'string' && provider !== '' ? `${provider}/${model}` : model,
    priceModel: model,
    input: num(u['input']),
    output: num(u['output']),
    cacheRead: num(u['cacheRead']),
    cacheWrite: num(u['cacheWrite']),
  }
  if (num(u['totalTokens']) > 0) ev.tokens = num(u['totalTokens'])
  const cost = num(obj(u['cost'])?.['total'])
  if (cost > 0) ev.costUsd = cost
  if (ev.input + ev.output + ev.cacheRead + ev.cacheWrite === 0 && ev.tokens === undefined) return undefined
  ev.key = shortHash(`${String(o['id'])}|${String(o['timestamp'])}|${model}|${num(u['totalTokens'])}`)
  return [ev]
}

export function ompSessionOf(path: string): string | undefined {
  const name = basename(path, '.jsonl')
  const sid = name.slice(name.indexOf('_') + 1)
  return name.includes('_') && isValidSessionId(sid) ? sid : undefined
}

export function ompSessionFiles(root = join(ompAgentDir(), 'sessions')): ScanFile[] {
  const out: ScanFile[] = []
  let paths: string[]
  try {
    paths = [...new Bun.Glob('**/*.jsonl').scanSync({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false })]
  } catch {
    return out
  }
  for (const path of paths) {
    try {
      const st = statSync(path)
      const session = ompSessionOf(path)
      out.push({ path, order: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs, ...(session !== undefined ? { session } : {}) })
    } catch {  }
  }
  return out
}

const LABEL_BY_ID: Readonly<Record<string, string>> = {
  '5h': '5h', '1d': '1d', '24h': '1d', daily: '1d', '7d': '7d', weekly: '7d', '30d': '30d', monthly: '30d', mo: '30d',
}

function usedPct(amount: Record<string, unknown> | undefined): number | undefined {
  if (amount === undefined) return undefined
  const f = amount['usedFraction']
  if (typeof f === 'number' && Number.isFinite(f)) return f * 100
  const used = amount['used']
  const limit = amount['limit']
  if (typeof used === 'number' && typeof limit === 'number' && limit > 0) return (used / limit) * 100
  if (amount['unit'] === 'percent' && typeof used === 'number') return used
  const rem = amount['remainingFraction']
  if (typeof rem === 'number' && Number.isFinite(rem)) return Math.max(0, 1 - rem) * 100
  return undefined
}

export function windowsFromOmpUsage(payload: unknown, nowMs: number): RateWindow[] {
  const reports = obj(payload)?.['reports']
  if (!Array.isArray(reports)) return []
  const best = new Map<string, RateWindow>()
  for (const r of reports) {
    const limits = obj(r)?.['limits']
    if (!Array.isArray(limits)) continue
    for (const l of limits) {
      const lim = obj(l)
      if (lim === undefined) continue
      const win = obj(lim['window'])
      const pct = usedPct(obj(lim['amount']))
      if (pct === undefined || win === undefined) continue
      const durationMs = typeof win['durationMs'] === 'number' && win['durationMs'] > 0 ? win['durationMs'] : undefined
      const id = typeof win['id'] === 'string' ? win['id'].toLowerCase() : ''
      const label = durationMs !== undefined ? windowLabel(durationMs / 60_000) : LABEL_BY_ID[id]
      if (label === undefined || label === '?') continue
      const w: RateWindow = { pct: Math.round(pct * 10) / 10, label }
      if (durationMs !== undefined) w.windowMinutes = Math.round(durationMs / 60_000)
      if (typeof win['resetsAt'] === 'number' && win['resetsAt'] > 0) {
        if (win['resetsAt'] <= nowMs) continue
        w.resetsAt = new Date(win['resetsAt']).toISOString()
      }
      const prev = best.get(label)
      if (prev === undefined || w.pct > prev.pct) best.set(label, w)
    }
  }
  const order = ['5h', '1d', '7d', '30d']
  return [...best.values()].sort((a, b) => {
    const ia = order.indexOf(a.label)
    const ib = order.indexOf(b.label)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || (a.label < b.label ? -1 : 1)
  })
}

const defaultRunner: Runner = (argv, opts) => run(argv, { timeoutMs: opts.timeoutMs })

export async function collectOmp(opts: CollectOptions): Promise<UsageCacheEntry> {
  const ym = opts.month ?? monthKeyOf(opts.nowMs)
  const notes: string[] = []
  const store = loadStore<OmpCarry>('omp')
  await scanFiles(store, { files: ompSessionFiles(), parse: parseOmpLine, initCarry: () => ({}), nowMs: opts.nowMs })

  const cached = obj(store.meta['quota'])
  let payload: unknown = cached?.['payload']
  const fetchedAt = typeof cached?.['at'] === 'number' ? cached['at'] : 0
  if (!opts.offline && (opts.nowMs - fetchedAt > OMP_USAGE_TTL_MS || fetchedAt > opts.nowMs)) {
    const omp = (opts.which ?? whichBin)('omp')
    if (omp !== undefined) {
      const r = await (opts.run ?? defaultRunner)([omp, 'usage', '--json'], { timeoutMs: OMP_USAGE_TIMEOUT_MS })
      if (r.code === 0 && !r.timedOut) {
        try {
          payload = JSON.parse(r.stdout) as unknown
        } catch {
          notes.push('omp usage --json printed invalid JSON')
        }
      } else notes.push(r.timedOut ? 'omp usage --json timed out' : `omp usage --json exited ${r.code}`)
      store.meta['quota'] = payload === undefined ? { at: opts.nowMs } : { at: opts.nowMs, payload }
    }
  }
  saveStore(store)

  const agg = aggregateMonth(store, ym, opts.pricing)
  const all = payload === undefined ? [] : windowsFromOmpUsage(payload, opts.nowMs)
  const monthly = all.find(w => w.label === '30d')
  const entry: UsageCacheEntry = {
    harness: 'omp',
    computed_at: new Date(opts.nowMs).toISOString(),
    windows: all.filter(w => w.label !== '30d'),
    month: { start: localIso(monthRange(ym).startMs), tokens: agg.tokens, byModel: agg.byModel },
    month_key: ym,
    days: dailySeries(store, monthDays(ym, opts.nowMs), opts.pricing),
  }
  if (agg.usd !== undefined) entry.month.usd = agg.usd
  if (monthly !== undefined) entry.month_pct = monthly.pct
  if (notes.length > 0) entry.notes = notes
  return entry
}
