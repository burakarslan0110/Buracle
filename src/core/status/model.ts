import type { Harness } from '../events'
import type { BandView } from '../flow/band'
import type { MemoryStatus } from '../memory/status'

export interface RateWindow { pct: number; resetsAt?: string; windowMinutes?: number; label: string }
export interface GitState { branch?: string; detached?: boolean; ahead: number; behind: number; staged: number; unstaged: number; untracked: number; stash: number; conflicts: number; worktree?: string; lines?: { added: number; removed: number } }

export type IndexStatus = 'ready' | 'building' | 'none' | 'failed' | 'off'

export interface HookHealth { failures: number; failClosed: number; runtimeBehind?: boolean }

export interface BarModel {
  harness: Harness; model?: string; effort?: string
  ctx?: { pct: number; tokens?: number; window?: number; autoCompactAt?: number }
  windows: RateWindow[]
  month?: { tokens: number; usd?: number; estimate: boolean; pct?: number }
  cost?: { usd: number }
  git?: GitState; dir?: string
  mem?: MemoryStatus
  plan?: { title: string; phase: string; done: number; total: number }
  flow?: BandView
  index?: IndexStatus
  hooks?: HookHealth
  updates?: number
}
export interface Segment {
  id: string
  text: string
  color?: 'green'|'yellow'|'red'|'blue'|'magenta'|'cyan'|'gray'|'white'
  dim?: boolean
  bold?: boolean
  link?: string
}

export interface StatusLayout {
  rows: string[][]
  thresholds: { ctxWarn: number; ctxCrit: number }
  emoji: boolean
  compact?: string[][]
  native?: NativeStatusConfig
}

export interface NativeStatusConfig {
  status_line?: string[]
  terminal_title?: string[]
  preset?: string
  leftSegments?: string[]
  rightSegments?: string[]
  showHookStatus?: boolean
  setStatus?: Record<string, string[]>
  slot?: string
}

export const WINDOW_MINUTES: Readonly<Record<string, number>> = { '5h': 300, '1d': 1440, '7d': 10080, '30d': 43200, '365d': 525600 }

export const PACE_BAND = 5

export function pace(usedPct: number, resetsAtIso: string | undefined, windowMinutes: number, nowMs: number): 'over' | 'under' | 'even' {
  if (resetsAtIso === undefined || !Number.isFinite(usedPct) || !Number.isFinite(windowMinutes) || windowMinutes <= 0 || !Number.isFinite(nowMs)) return 'even'
  const resetMs = Date.parse(resetsAtIso)
  if (!Number.isFinite(resetMs)) return 'even'
  const windowMs = windowMinutes * 60_000
  const elapsedPct = Math.min(1, Math.max(0, (nowMs - (resetMs - windowMs)) / windowMs)) * 100
  const diff = usedPct - elapsedPct
  if (diff > PACE_BAND) return 'over'
  if (diff < -PACE_BAND) return 'under'
  return 'even'
}

export function windowLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return '?'
  for (const [label, m] of Object.entries(WINDOW_MINUTES)) {
    if (minutes >= m * 0.95 && minutes <= m * 1.05) return label
  }
  if (minutes < 60) return `${Math.round(minutes)}m`
  if (minutes % 1440 === 0) return `${minutes / 1440}d`
  if (minutes % 60 === 0) return `${minutes / 60}h`
  if (minutes < 1440) return `${Math.round(minutes)}m`
  return `${Math.round(minutes / 60)}h`
}
