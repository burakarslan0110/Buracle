import type { Harness } from '../core/events'
import type { RateWindow } from '../core/status/model'
import type { PricingTable, UsageSnapshot } from '../core/usage'

export interface LatestSession {
  at: number
  sessionId?: string
  cwd?: string
  model?: string
  effort?: string
  ctx?: { pct: number; tokens?: number; window?: number }
}

export interface UsageDay { day: string; tokens: number; usd?: number }

export interface UsageCacheEntry extends UsageSnapshot {
  month_key: string
  days?: UsageDay[]
  month_pct?: number
  notes?: string[]
  latest?: LatestSession
}

export interface UsageCache { v: 1; updated_at: string; harnesses: Partial<Record<Harness, UsageCacheEntry>> }

export type Runner = (argv: string[], opts: { timeoutMs: number }) => Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>

export interface CollectOptions {
  nowMs: number
  month?: string
  pricing: PricingTable
  run?: Runner
  which?: (name: string) => string | undefined
  offline?: boolean
}

export type Collector = (opts: CollectOptions) => Promise<UsageCacheEntry>

export type { RateWindow }
