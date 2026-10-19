import type { BandView } from '../flow/band'
import { bandRows } from '../flow/band'
import type { WorkspaceInfo } from '../workspace'
import { indexHealth } from '../workspace'
import type { IndexStatus, Segment } from './model'

type Color = NonNullable<Segment['color']>

export const FLOW_ROW_COLUMNS = 160
export const FLOW_ROW_MIN_COLUMNS = 24

export interface FlowRowOptions {
  columns?: number
  compact?: boolean
}

function compactView(v: BandView): BandView {
  const inner = v.workflow ?? v.breadcrumb[v.breadcrumb.length - 1]
  return { ...v, breadcrumb: inner !== undefined ? [inner] : v.breadcrumb, phases: v.phases.map(p => ({ ...p, label: p.short })) }
}

export function flowRow(view: BandView | undefined, opts: FlowRowOptions = {}): Segment[] {
  if (view === undefined || !view.visible) return []
  const columns = opts.columns ?? FLOW_ROW_COLUMNS
  const cols = Number.isFinite(columns) ? Math.max(FLOW_ROW_MIN_COLUMNS, Math.floor(columns)) : FLOW_ROW_COLUMNS
  const compact = opts.compact === true
  let row = (bandRows(compact ? compactView(view) : view, cols, 1, true)[0] ?? []).filter(s => s.text !== '')
  if (compact) row = row.filter(s => s.id !== 'band-status')
  const last = row[row.length - 1]
  if (last !== undefined && last.text !== last.text.trimEnd()) row[row.length - 1] = { ...last, text: last.text.trimEnd() }
  return row.filter(s => s.text !== '')
}

export function flowRowText(row: readonly Segment[]): string {
  return row.map(s => s.text).join('').trim()
}

export function flowRowColor(row: readonly Segment[]): Color {
  const phase = row.find(s => s.id.startsWith('band-phase'))
  return phase?.color ?? row.find(s => s.id === 'band-status')?.color ?? 'magenta'
}

export function flowElapsed(min: number): string {
  if (!Number.isFinite(min) || min < 1) return '<1m'
  const m = Math.floor(min)
  return m < 120 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 > 0 ? `${m % 60}m` : ''}`
}

export interface IndexStatusText { long: string; short: string; color: Color; dim?: boolean }

export const INDEX_STATUS_TEXT: Readonly<Record<IndexStatus, IndexStatusText>> = {
  ready: { long: 'idx ready', short: 'idx \u2713', color: 'green' },
  building: { long: 'idx building', short: 'idx \u27F3', color: 'yellow' },
  none: { long: 'idx none', short: 'idx \u25CB', color: 'gray' },
  failed: { long: 'idx failed', short: 'idx \u2717', color: 'red' },
  off: { long: 'idx off', short: 'idx off', color: 'gray', dim: true },
}

export function isIndexStatus(x: unknown): x is IndexStatus {
  return typeof x === 'string' && Object.prototype.hasOwnProperty.call(INDEX_STATUS_TEXT, x)
}

const INDEX_ORDER: readonly IndexStatus[] = ['failed', 'none', 'building', 'ready']

export function worstIndexStatus(states: readonly IndexStatus[]): IndexStatus | undefined {
  if (states.length === 0) return undefined
  const live = new Set<IndexStatus>(states.filter(s => s !== 'off'))
  if (live.size === 0) return 'off'
  return INDEX_ORDER.find(s => live.has(s)) ?? 'ready'
}

export function indexStatusOf(info: WorkspaceInfo): IndexStatus | undefined {
  if (info.root !== undefined) return indexHealth(info.index)
  return worstIndexStatus(Object.values(info.childIndex ?? {}).map(indexHealth))
}
