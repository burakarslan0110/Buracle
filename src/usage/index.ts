import type { Harness } from '../core/events'
import { HARNESSES } from '../core/events'
import type { PricingTable } from '../core/usage'
import { log } from '../engine/log'
import { writeUsageEntries } from './cache'
import { collectClaude } from './claude'
import { collectCodex } from './codex'
import { monthKeyOf } from './month'
import { collectOmp } from './omp'
import { collectOpencode } from './opencode'
import { loadPricing } from './pricing'
import type { Collector, CollectOptions, UsageCacheEntry } from './types'

export const COLLECTORS: Readonly<Record<Harness, Collector>> = {
  claude: collectClaude,
  codex: collectCodex,
  opencode: collectOpencode,
  omp: collectOmp,
}

export interface RefreshOptions extends Partial<Omit<CollectOptions, 'pricing'>> {
  harnesses?: Harness[]
  pricing?: PricingTable
  write?: boolean
}

export interface RefreshResult { entries: UsageCacheEntry[]; errors: Array<{ harness: Harness, error: string }>; written: boolean }

export async function refreshUsage(opts: RefreshOptions = {}): Promise<RefreshResult> {
  const nowMs = opts.nowMs ?? Date.now()
  const pricing = opts.pricing ?? loadPricing()
  const harnesses = opts.harnesses ?? [...HARNESSES]
  const entries: UsageCacheEntry[] = []
  const errors: RefreshResult['errors'] = []
  for (const h of harnesses) {
    const co: CollectOptions = { nowMs, pricing }
    if (opts.month !== undefined) co.month = opts.month
    if (opts.run !== undefined) co.run = opts.run
    if (opts.which !== undefined) co.which = opts.which
    if (opts.offline !== undefined) co.offline = opts.offline
    try {
      entries.push(await COLLECTORS[h](co))
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      errors.push({ harness: h, error })
      log('warn', 'usage collector failed', { harness: h, error })
    }
  }
  const current = (opts.month ?? monthKeyOf(nowMs)) === monthKeyOf(nowMs)
  const written = opts.write !== false && current && entries.length > 0
  if (written) writeUsageEntries(entries, nowMs)
  return { entries, errors, written }
}

export { readUsageCache, currentUsageEntry, isStale, spawnUsageRefresh, acquireUsageLock, USAGE_TTL_MS } from './cache'
export { loadPricing, refreshPricing, pricingFile, LITELLM_PRICES_URL } from './pricing'
export type { UsageCache, UsageCacheEntry, LatestSession, CollectOptions } from './types'
