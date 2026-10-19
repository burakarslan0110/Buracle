import { statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { RateWindow } from '../core/status/model'
import { windowLabel } from '../core/status/model'
import { codexHome } from '../engine/paths'
import { run, which as whichBin } from '../engine/proc'
import { localIso, monthDays, monthKeyOf, monthRange } from './month'
import type { ScanFile, UsageEvent } from './scan'
import { aggregateMonth, dailySeries, loadStore, saveStore, scanFiles } from './scan'
import type { CollectOptions, LatestSession, Runner, UsageCacheEntry } from './types'

interface CodexWindow { used: number; minutes?: number; resetsAt?: number }
interface Cumulative { input: number; cached: number; cacheWrite: number; output: number; total: number }
export interface CodexCarry {
  model?: string
  effort?: string
  cwd?: string
  thread?: string
  last?: Cumulative
  rate?: { ts: number; primary?: CodexWindow; secondary?: CodexWindow; plan?: string }
  ctx?: { ts: number; tokens: number; window?: number; model?: string; effort?: string }
}

export const CODEX_BASELINE_TOKENS = 12_000

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0
}

function obj(x: unknown): Record<string, unknown> | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : undefined
}

export function codexContextUsedPct(tokensInContext: number, contextWindow: number): number {
  if (!(contextWindow > CODEX_BASELINE_TOKENS)) return 100
  const effective = contextWindow - CODEX_BASELINE_TOKENS
  const used = Math.max(0, tokensInContext - CODEX_BASELINE_TOKENS)
  const remaining = Math.max(0, effective - used)
  const remainingPct = Math.round(Math.min(1, Math.max(0, remaining / effective)) * 100)
  return 100 - remainingPct
}

function readWindow(x: unknown, tsMs: number): CodexWindow | undefined {
  const w = obj(x)
  if (w === undefined || typeof w['used_percent'] !== 'number' || !Number.isFinite(w['used_percent'])) return undefined
  const out: CodexWindow = { used: w['used_percent'] }
  if (typeof w['window_minutes'] === 'number' && w['window_minutes'] > 0) out.minutes = w['window_minutes']
  if (typeof w['resets_at'] === 'number' && w['resets_at'] > 0) out.resetsAt = w['resets_at']
  else if (typeof w['resets_in_seconds'] === 'number' && w['resets_in_seconds'] >= 0) out.resetsAt = Math.round(tsMs / 1000 + w['resets_in_seconds'])
  return out
}

function cumulative(x: unknown): Cumulative | undefined {
  const t = obj(x)
  if (t === undefined) return undefined
  return { input: num(t['input_tokens']), cached: num(t['cached_input_tokens']), cacheWrite: num(t['cache_write_input_tokens']), output: num(t['output_tokens']), total: num(t['total_tokens']) }
}

export function parseCodexLine(line: string, carry: CodexCarry): UsageEvent[] | undefined {
  if (!(line.includes('token_count') || line.includes('token_usage_record') || line.includes('turn_context') || line.includes('session_meta'))) return undefined
  const o = JSON.parse(line) as Record<string, unknown>
  const p = obj(o['payload'])
  if (p === undefined) return undefined
  const ts = Date.parse(String(o['timestamp']))
  switch (o['type']) {
    case 'session_meta':
      if (typeof p['cwd'] === 'string') carry.cwd = p['cwd']
      if (typeof p['id'] === 'string') carry.thread = p['id']
      return undefined
    case 'turn_context':
      if (typeof p['model'] === 'string' && p['model'] !== '') carry.model = p['model']
      if (typeof p['effort'] === 'string' && p['effort'] !== '') carry.effort = p['effort']
      return undefined
    case 'token_usage_record': {
      const u = obj(p['usage'])
      if (u === undefined || !Number.isFinite(ts)) return undefined
      const cached = num(u['cached_input_tokens'])
      const cacheWrite = num(u['cache_write_input_tokens'])
      const ev: UsageEvent = {
        ts,
        model: carry.model ?? 'unknown',
        input: Math.max(0, num(u['input_tokens']) - cached - cacheWrite),
        cacheRead: cached,
        cacheWrite,
        output: num(u['output_tokens']),
      }
      if (num(u['total_tokens']) > 0) ev.tokens = num(u['total_tokens'])
      if (typeof p['response_id'] === 'string' && p['response_id'] !== '') ev.key = `r:${p['response_id']}`
      return ev.input + ev.output + ev.cacheRead + ev.cacheWrite > 0 ? [ev] : undefined
    }
    case 'event_msg': {
      if (p['type'] !== 'token_count' || !Number.isFinite(ts)) return undefined
      const rl = obj(p['rate_limits'])
      if (rl !== undefined && (rl['limit_id'] === undefined || rl['limit_id'] === null || rl['limit_id'] === 'codex')) {
        const rate: NonNullable<CodexCarry['rate']> = { ts }
        const primary = readWindow(rl['primary'], ts)
        const secondary = readWindow(rl['secondary'], ts)
        if (primary) rate.primary = primary
        if (secondary) rate.secondary = secondary
        if (typeof rl['plan_type'] === 'string') rate.plan = rl['plan_type']
        if (primary || secondary) carry.rate = rate
      }
      const info = obj(p['info'])
      if (info === undefined) return undefined
      const last = obj(info['last_token_usage'])
      const ctx: NonNullable<CodexCarry['ctx']> = { ts, tokens: num(last?.['total_tokens']) }
      if (typeof info['model_context_window'] === 'number' && info['model_context_window'] > 0) ctx.window = info['model_context_window']
      if (carry.model !== undefined) ctx.model = carry.model
      if (carry.effort !== undefined) ctx.effort = carry.effort
      carry.ctx = ctx
      const cur = cumulative(info['total_token_usage'])
      if (cur === undefined) return undefined
      const prev = carry.last ?? { input: 0, cached: 0, cacheWrite: 0, output: 0, total: 0 }
      carry.last = cur
      const grew = cur.total > prev.total && cur.input >= prev.input && cur.cached >= prev.cached && cur.output >= prev.output && cur.cacheWrite >= prev.cacheWrite
      if (!grew) return undefined
      const dCached = cur.cached - prev.cached
      const dWrite = cur.cacheWrite - prev.cacheWrite
      return [{
        ts,
        model: carry.model ?? 'unknown',
        fallback: true,
        key: `${cur.input}:${cur.cached}:${cur.cacheWrite}:${cur.output}:${cur.total}`,
        input: Math.max(0, cur.input - prev.input - dCached - dWrite),
        cacheRead: dCached,
        cacheWrite: dWrite,
        output: cur.output - prev.output,
        tokens: cur.total - prev.total,
      }]
    }
    default:
      return undefined
  }
}

function rolloutOrder(path: string): number {
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/u.exec(basename(path))
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
  try { return statSync(path).mtimeMs } catch { return 0 }
}

const ROLLOUT_RE = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/u

export function codexSessionOf(path: string): string | undefined {
  return ROLLOUT_RE.exec(basename(path))?.[1]
}

export function codexRollouts(home = codexHome(), withZst = false): ScanFile[] {
  const out: ScanFile[] = []
  for (const sub of ['sessions', 'archived_sessions']) {
    const root = join(home, sub)
    let paths: string[]
    try {
      paths = [...new Bun.Glob('**/rollout-*.jsonl*').scanSync({ cwd: root, absolute: true, onlyFiles: true, followSymlinks: false })]
    } catch {
      continue
    }
    for (const path of paths) {
      const session = codexSessionOf(path)
      const s = session !== undefined ? { session } : {}
      if (path.endsWith('.jsonl')) out.push({ path, order: rolloutOrder(path), ...s })
      else if (withZst && path.endsWith('.jsonl.zst')) out.push({ path, id: path.slice(0, -4), order: rolloutOrder(path), compressed: true, ...s })
    }
  }
  return out
}

function toRateWindow(w: CodexWindow | undefined, fallbackLabel: string): RateWindow | undefined {
  if (w === undefined) return undefined
  const rw: RateWindow = { pct: w.used, label: w.minutes !== undefined ? windowLabel(w.minutes) : fallbackLabel }
  if (w.minutes !== undefined) rw.windowMinutes = w.minutes
  if (w.resetsAt !== undefined) rw.resetsAt = new Date(w.resetsAt * 1000).toISOString()
  return rw
}

const defaultRunner: Runner = (argv, opts) => run(argv, { timeoutMs: opts.timeoutMs })

export async function collectCodex(opts: CollectOptions): Promise<UsageCacheEntry> {
  const ym = opts.month ?? monthKeyOf(opts.nowMs)
  const which = opts.which ?? whichBin
  const runner = opts.run ?? defaultRunner
  const zstd = which('zstd')
  const notes: string[] = []
  const files = codexRollouts(codexHome(), zstd !== undefined)
  if (zstd === undefined) {
    const skipped = codexRollouts(codexHome(), true).filter(f => f.compressed).length
    if (skipped > 0) notes.push(`${skipped} compressed rollout(s) skipped: zstd is not installed`)
  }
  const store = loadStore<CodexCarry>('codex')
  await scanFiles(store, {
    files,
    parse: parseCodexLine,
    initCarry: () => ({}),
    nowMs: opts.nowMs,
    readCompressed: async path => {
      if (zstd === undefined) return undefined
      const r = await runner([zstd, '-dcq', path], { timeoutMs: 30_000 })
      return r.code === 0 ? new TextEncoder().encode(r.stdout) : undefined
    },
  })
  saveStore(store)
  const agg = aggregateMonth(store, ym, opts.pricing)

  let rate: CodexCarry['rate']
  let ctx: { carry: CodexCarry, ctx: NonNullable<CodexCarry['ctx']> } | undefined
  for (const cur of Object.values(store.files)) {
    const c = cur.carry
    if (c?.rate && (rate === undefined || c.rate.ts > rate.ts)) rate = c.rate
    if (c?.ctx && (ctx === undefined || c.ctx.ts > ctx.ctx.ts)) ctx = { carry: c, ctx: c.ctx }
  }
  const windows: RateWindow[] = []
  for (const w of [toRateWindow(rate?.primary, 'usage'), toRateWindow(rate?.secondary, 'usage2')]) {
    if (w === undefined) continue
    if (w.resetsAt !== undefined && Date.parse(w.resetsAt) <= opts.nowMs) continue
    windows.push(w)
  }
  const entry: UsageCacheEntry = {
    harness: 'codex',
    computed_at: new Date(opts.nowMs).toISOString(),
    windows,
    month: { start: localIso(monthRange(ym).startMs), tokens: agg.tokens, byModel: agg.byModel },
    month_key: ym,
    days: dailySeries(store, monthDays(ym, opts.nowMs), opts.pricing),
  }
  if (agg.usd !== undefined) entry.month.usd = agg.usd
  if (notes.length > 0) entry.notes = notes
  if (ctx !== undefined) {
    const latest: LatestSession = { at: ctx.ctx.ts }
    if (ctx.carry.thread !== undefined) latest.sessionId = ctx.carry.thread
    if (ctx.carry.cwd !== undefined) latest.cwd = ctx.carry.cwd
    if (ctx.ctx.model !== undefined) latest.model = ctx.ctx.model
    if (ctx.ctx.effort !== undefined) latest.effort = ctx.ctx.effort
    if (ctx.ctx.window !== undefined) latest.ctx = { pct: codexContextUsedPct(ctx.ctx.tokens, ctx.ctx.window), tokens: ctx.ctx.tokens, window: ctx.ctx.window }
    entry.latest = latest
  }
  return entry
}
