import { mcpHealthOf } from '../policy/routing'
import type { Segment } from '../status/model'
import type { MemRegion } from './brain'

export interface MemoryStatus {
  v: 2
  computed_at: string
  project?: string
  health: 'ok' | 'warn' | 'error'
  reasons: string[]
  counts: { project: number, person: number }
  regions: Partial<Record<MemRegion, number>>
  upkeep: number
  captures: number
  last_write?: { at: string, by: string, type?: string }
  store: { engine: 'cortexdb', version?: string, ok: boolean }
  distill: { pending: number, held?: number, until?: string }
  redactions_24h: number
}

export const MEM_HEALTH_LIMITS = {
  upkeepWarn: 15,
  capturesWarn: 10,
  distillWarn: 5,
} as const

export interface MemHealthInput {
  storeOk: boolean
  readable: boolean
  mcpDown?: boolean
  embedMissing?: boolean
  upkeep: number
  captures: number
  distillPending: number
  coreMissing?: number
}

export function memReasonText(reason: string, s: Pick<MemoryStatus, 'upkeep' | 'captures' | 'distill'>): string {
  switch (reason) {
    case 'cortexdb_missing': return 'cortexdb missing'
    case 'brain_unreadable': return 'unreadable'
    case 'mcp_down': return 'mcp down'
    case 'embed_missing': return 'no embeddings'
    case 'upkeep_high': return `upkeep ${s.upkeep}`
    case 'captures_high': return `inbox ${s.captures}`
    case 'distill_backlog': return `queue ${Math.max(0, s.distill.pending - (s.distill.held ?? 0))}`
    case 'core_missing': return 'core pages missing'
    default: return reason
  }
}

export function memHealth(i: MemHealthInput): { health: 'ok' | 'warn' | 'error', reasons: string[] } {
  const L = MEM_HEALTH_LIMITS
  const errors: string[] = []
  const warns: string[] = []
  if (!i.storeOk) errors.push('cortexdb_missing')
  else if (!i.readable) errors.push('brain_unreadable')
  if (i.mcpDown) errors.push('mcp_down')
  if (i.embedMissing === true) warns.push('embed_missing')
  if ((i.coreMissing ?? 0) > 0) warns.push('core_missing')
  if (i.upkeep >= L.upkeepWarn) warns.push('upkeep_high')
  if (i.captures >= L.capturesWarn) warns.push('captures_high')
  if (i.distillPending >= L.distillWarn) warns.push('distill_backlog')
  const reasons = [...errors, ...warns]
  return { health: errors.length > 0 ? 'error' : warns.length > 0 ? 'warn' : 'ok', reasons }
}

export type MemMcpState = 'ok' | 'down' | 'unknown'

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function mcpEntryState(v: unknown, depth = 0): MemMcpState | undefined {
  if (v === 'ok' || v === 'down' || v === 'unknown') return v
  if (typeof v === 'boolean') return v ? 'ok' : 'down'
  if (isObj(v) && depth === 0) {
    if ('status' in v) return mcpEntryState(v['status'], 1)
    if (typeof v['ok'] === 'boolean') return v['ok'] ? 'ok' : 'down'
  }
  return undefined
}

function mcpEntry(health: Record<string, unknown>, id: string): { value: unknown } | undefined {
  const maps = ['mcp', 'servers'].map(k => health[k]).filter(isObj)
  if (maps.length === 0) return id in health ? { value: health[id] } : undefined
  for (const m of maps) if (id in m) return { value: m[id] }
  return undefined
}

export function memMcpHealth(health: unknown, id: string, nowMs?: number): MemMcpState {
  if (!isObj(health)) return 'unknown'
  const entry = mcpEntry(health, id)
  const state = entry !== undefined ? mcpEntryState(entry.value) ?? 'unknown' : 'unknown'
  if (state === 'down' && nowMs !== undefined && mcpHealthOf({ mcp: { [id]: entry?.value } }, nowMs)[id] === 'unknown') return 'unknown'
  return state
}

export function memAge(ms: number): string {
  if (!Number.isFinite(ms)) return '?'
  const m = Math.floor(Math.max(0, ms) / 60_000)
  if (m < 1) return '<1m'
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

const HEALTH_COLOR = { ok: 'green', warn: 'yellow', error: 'red' } as const
const HEALTH_MARK = { ok: '✓', warn: '⚠', error: '✗' } as const

export function memSegmentWith(s: MemoryStatus | undefined, nowMs: number, style: 'compact' | 'wide', opts: { emoji: boolean }): Segment {
  const brain = opts.emoji ? '🧠 ' : ''
  if (s === undefined || s.v !== 2) {
    return { id: 'mem', text: style === 'wide' ? `${brain}brain –` : 'brain –', color: 'gray', dim: true }
  }
  const color = HEALTH_COLOR[s.health] ?? 'gray'
  const mark = HEALTH_MARK[s.health] ?? '?'
  const first = s.reasons[0]
  const reason = s.health !== 'ok' && first !== undefined ? ` ${memReasonText(first, s)}` : ''
  const at = s.last_write !== undefined ? Date.parse(s.last_write.at) : Number.NaN
  const age = Number.isFinite(at) ? memAge(nowMs - at) : undefined
  const own = s.project !== undefined ? s.counts.project : s.counts.person
  if (style === 'compact') {
    const parts = [String(own)]
    if (s.upkeep > 0) parts.push(`u${s.upkeep}`)
    if (age !== undefined) parts.push(age)
    return { id: 'mem', text: `brain ${parts.join('·')} ${mark}${reason}`, color }
  }
  const head = s.project !== undefined ? `${brain}${s.project} ${s.counts.project}+${s.counts.person}p` : `${brain}person ${s.counts.person}p`
  const parts = [head]
  if (s.upkeep > 0) parts.push(`upkeep ${s.upkeep}`)
  if (s.captures > 0) parts.push(`inbox ${s.captures}`)
  if (s.last_write !== undefined && age !== undefined) parts.push(`last ${age} (${s.last_write.by})`)
  if (s.health !== 'ok') parts.push(`${mark}${reason}`)
  return { id: 'mem', text: parts.join(' · '), color }
}

export function memSegment(s: MemoryStatus | undefined, nowMs: number, style: 'compact'|'wide'): Segment {
  return memSegmentWith(s, nowMs, style, { emoji: true })
}

export function memEmptyStatus(computedAt: string, project?: string): MemoryStatus {
  const s: MemoryStatus = {
    v: 2,
    computed_at: computedAt,
    health: 'ok',
    reasons: [],
    counts: { project: 0, person: 0 },
    regions: {},
    upkeep: 0,
    captures: 0,
    store: { engine: 'cortexdb', ok: true },
    distill: { pending: 0 },
    redactions_24h: 0,
  }
  if (project !== undefined) s.project = project
  return s
}
