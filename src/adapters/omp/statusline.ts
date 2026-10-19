import type { StatusLayout } from '../../core/status/model'

export const OMP_SEGMENT_IDS: readonly string[] = [
  'pi', 'status', 'model', 'mode', 'path', 'git', 'pr', 'subagents', 'token_in', 'token_out', 'token_total',
  'token_rate', 'cost', 'context_pct', 'context_total', 'time_spent', 'time', 'session', 'hostname',
  'cache_read', 'cache_write', 'cache_hit', 'session_name', 'usage', 'collab', 'stream', 'vim',
]

export const DEFAULT_OMP_SEGMENTS = {
  left: ['model', 'path', 'git', 'pr', 'subagents'],
  right: ['usage', 'context_pct', 'cost', 'status'],
} as const

export const DEFAULT_SET_STATUS: Readonly<Record<string, readonly string[]>> = { 'buracle.budget': ['month'], 'buracle.hooks': ['hooks'], 'buracle.mem': ['mem'] }

export const LEGACY_STATUS_KEYS: Readonly<Record<string, string>> = { 'buracle.ay': 'buracle.budget' }

export const DEFAULT_BAND_LAYOUT: StatusLayout = { rows: [['month', 'mem', 'git', 'plan', 'upd']], thresholds: { ctxWarn: 75, ctxCrit: 90 }, emoji: false }

function segmentList(x: unknown, seen: Set<string>): string[] {
  if (!Array.isArray(x)) return []
  const out: string[] = []
  for (const raw of x) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!OMP_SEGMENT_IDS.includes(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export function ompStatusLine(layout: StatusLayout | undefined): { left: string[], right: string[], showHookStatus: boolean | undefined } {
  const native = layout?.native
  const seen = new Set<string>()
  let left = segmentList(native?.leftSegments, seen)
  let right = segmentList(native?.rightSegments, seen)
  if (left.length === 0 && right.length === 0) {
    left = [...DEFAULT_OMP_SEGMENTS.left]
    right = [...DEFAULT_OMP_SEGMENTS.right]
  }
  const placed = [...left, ...right].includes('status')
  const showHookStatus = typeof native?.showHookStatus === 'boolean' ? native.showHookStatus : placed ? false : undefined
  return { left, right, showHookStatus }
}

export function ompStatusData(layout: StatusLayout | undefined): { layout: StatusLayout, setStatus: Record<string, string[]> } {
  const keys = layout?.native?.setStatus
  const setStatus: Record<string, string[]> = {}
  const source = keys !== undefined && typeof keys === 'object' && Object.keys(keys).length > 0 ? keys : DEFAULT_SET_STATUS
  for (const key of Object.keys(source).sort()) {
    const ids = source[key]
    const name = LEGACY_STATUS_KEYS[key] ?? key
    if (/^[A-Za-z0-9._-]+$/.test(name) && Array.isArray(ids)) setStatus[name] = ids.filter((i): i is string => typeof i === 'string')
  }
  const band: StatusLayout = layout !== undefined && Array.isArray(layout.rows) && layout.rows.length > 0
    ? { rows: layout.rows, thresholds: layout.thresholds ?? DEFAULT_BAND_LAYOUT.thresholds, emoji: layout.emoji === true, ...(layout.compact !== undefined ? { compact: layout.compact } : {}) }
    : DEFAULT_BAND_LAYOUT
  return { layout: band, setStatus }
}
