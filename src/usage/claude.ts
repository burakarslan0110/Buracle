import { statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { claudeDir, isValidSessionId } from '../engine/paths'
import { monthDays, monthKeyOf, monthRange, localIso } from './month'
import type { ScanFile, TokenCounts, UsageEvent } from './scan'
import { aggregateMonth, dailySeries, loadStore, saveStore, scanFiles, shortHash } from './scan'
import { latestTelemetry, liveWindows } from './telemetry'
import type { CollectOptions, UsageCacheEntry } from './types'

export interface ClaudeCarry { recent: Array<{ k: string, c: TokenCounts }> }

const RECENT = 16

function num(x: unknown): number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0
}

export function parseClaudeLine(line: string, carry: ClaudeCarry): UsageEvent[] | undefined {
  if (!line.includes('"usage"') || !line.includes('"assistant"')) return undefined
  const o = JSON.parse(line) as Record<string, unknown>
  if (o['type'] !== 'assistant') return undefined
  const m = o['message'] as Record<string, unknown> | undefined
  if (m === null || typeof m !== 'object') return undefined
  const u = m['usage'] as Record<string, unknown> | undefined
  const model = m['model']
  if (u === null || typeof u !== 'object' || typeof model !== 'string' || model === '' || model === '<synthetic>') return undefined
  const ts = Date.parse(String(o['timestamp']))
  if (!Number.isFinite(ts)) return undefined
  const c: TokenCounts = {
    input: num(u['input_tokens']),
    output: num(u['output_tokens']),
    cacheRead: num(u['cache_read_input_tokens']),
    cacheWrite: num(u['cache_creation_input_tokens']),
  }
  if (c.input + c.output + c.cacheRead + c.cacheWrite === 0) return undefined
  const id = typeof m['id'] === 'string' ? m['id'] : undefined
  if (id === undefined) return [{ ts, model, ...c }]
  const key = shortHash(`${id}:${typeof o['requestId'] === 'string' ? o['requestId'] : ''}`)
  if (!Array.isArray(carry.recent)) carry.recent = []
  const prev = carry.recent.find(r => r.k === key)
  if (prev === undefined) {
    carry.recent.push({ k: key, c })
    if (carry.recent.length > RECENT) carry.recent.shift()
    return [{ ts, model, key, ...c }]
  }
  const d: TokenCounts = {
    input: Math.max(0, c.input - prev.c.input),
    output: Math.max(0, c.output - prev.c.output),
    cacheRead: Math.max(0, c.cacheRead - prev.c.cacheRead),
    cacheWrite: Math.max(0, c.cacheWrite - prev.c.cacheWrite),
  }
  if (d.input + d.output + d.cacheRead + d.cacheWrite === 0) return undefined
  prev.c = { input: Math.max(c.input, prev.c.input), output: Math.max(c.output, prev.c.output), cacheRead: Math.max(c.cacheRead, prev.c.cacheRead), cacheWrite: Math.max(c.cacheWrite, prev.c.cacheWrite) }
  return [{ ts, model, key: `${key}+${c.input}.${c.output}.${c.cacheRead}.${c.cacheWrite}`, ...d }]
}

export function claudeSessionOf(path: string): string | undefined {
  const own = basename(path, '.jsonl')
  if (basename(dirname(path)) === 'subagents') {
    const parent = basename(dirname(dirname(path)))
    return isValidSessionId(parent) ? parent : undefined
  }
  return isValidSessionId(own) ? own : undefined
}

export function claudeTranscripts(root = join(claudeDir(), 'projects')): ScanFile[] {
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
      const session = claudeSessionOf(path)
      out.push({ path, order: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs, ...(session !== undefined ? { session } : {}) })
    } catch {  }
  }
  return out
}

export async function collectClaude(opts: CollectOptions): Promise<UsageCacheEntry> {
  const ym = opts.month ?? monthKeyOf(opts.nowMs)
  const store = loadStore<ClaudeCarry>('claude')
  await scanFiles(store, {
    files: claudeTranscripts(),
    parse: parseClaudeLine,
    initCarry: () => ({ recent: [] }),
    nowMs: opts.nowMs,
  })
  saveStore(store)
  const agg = aggregateMonth(store, ym, opts.pricing)
  const entry: UsageCacheEntry = {
    harness: 'claude',
    computed_at: new Date(opts.nowMs).toISOString(),
    windows: [],
    month: { start: localIso(monthRange(ym).startMs), tokens: agg.tokens, byModel: agg.byModel },
    month_key: ym,
    days: dailySeries(store, monthDays(ym, opts.nowMs), opts.pricing),
  }
  if (agg.usd !== undefined) entry.month.usd = agg.usd
  const tel = latestTelemetry('claude')
  if (tel !== undefined) {
    entry.windows = liveWindows(tel.windows, opts.nowMs)
    const latest: UsageCacheEntry['latest'] = { at: tel.at, sessionId: tel.sessionId }
    if (tel.cwd !== undefined) latest.cwd = tel.cwd
    if (tel.model !== undefined) latest.model = tel.model
    if (tel.effort !== undefined) latest.effort = tel.effort
    if (tel.ctx !== undefined) latest.ctx = tel.ctx
    entry.latest = latest
  }
  return entry
}
