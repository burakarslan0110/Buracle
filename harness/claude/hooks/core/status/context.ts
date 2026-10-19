import type { BuracleConfig } from '../config'

export type ContextBand = 'ok' | 'warn' | 'critical'

const RANK: Readonly<Record<ContextBand, number>> = { ok: 0, warn: 1, critical: 2 }

export const CONTEXT_DEFAULTS: Readonly<BuracleConfig['context']> = { warnPct: 85, criticalPct: 95 }

function pctOk(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 && x <= 100
}

export function contextThresholds(cfg: Partial<BuracleConfig['context']> | undefined): BuracleConfig['context'] {
  const w = cfg?.warnPct
  const c = cfg?.criticalPct
  return pctOk(w) && pctOk(c) && w < c ? { warnPct: w, criticalPct: c } : { ...CONTEXT_DEFAULTS }
}

export function contextBand(pct: number | undefined, cfg: Partial<BuracleConfig['context']> | undefined): ContextBand | undefined {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) return undefined
  const t = contextThresholds(cfg)
  return pct >= t.criticalPct ? 'critical' : pct >= t.warnPct ? 'warn' : 'ok'
}

export function contextWarning(band: ContextBand, cfg: Partial<BuracleConfig['context']> | undefined): string | undefined {
  const t = contextThresholds(cfg)
  if (band === 'critical') {
    return `Buracle: the context window is above ${t.criticalPct}% full. Finish the current atomic step, then bring the plan file up to date (ticked tasks, deviations) and save lasting decisions with memory_write before starting anything new; Buracle keeps the plan state across the coming compaction. Do not skip verification.`
  }
  if (band === 'warn') {
    return `Buracle: the context window is above ${t.warnPct}% full. Keep outputs short, read narrow line ranges instead of whole files, and keep the plan file and todo list current so the work survives a compaction.`
  }
  return undefined
}

export interface ContextWatchResult {
  band?: ContextBand
  warn?: string
  warned: ContextBand
}

export function contextWatch(warned: ContextBand | undefined, pct: number | undefined, cfg: Partial<BuracleConfig['context']> | undefined): ContextWatchResult {
  const prev: ContextBand = warned === 'warn' || warned === 'critical' ? warned : 'ok'
  const band = contextBand(pct, cfg)
  if (band === undefined) return { warned: prev }
  if (band === 'ok') return { band, warned: 'ok' }
  if (RANK[band] > RANK[prev]) {
    const warn = contextWarning(band, cfg)
    return warn !== undefined ? { band, warn, warned: band } : { band, warned: band }
  }
  return { band, warned: prev }
}
