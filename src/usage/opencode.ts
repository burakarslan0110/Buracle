import { latestWindows } from './telemetry'
import type { CollectOptions, UsageCacheEntry } from './types'

export async function collectOpencode(opts: CollectOptions): Promise<UsageCacheEntry> {
  return { harness: 'opencode', computed_at: new Date(opts.nowMs).toISOString(), windows: latestWindows('opencode', opts.nowMs) }
}
