import { latestTelemetry, liveWindows } from './telemetry'
import type { CollectOptions, UsageCacheEntry } from './types'

export async function collectClaude(opts: CollectOptions): Promise<UsageCacheEntry> {
  const entry: UsageCacheEntry = { harness: 'claude', computed_at: new Date(opts.nowMs).toISOString(), windows: [] }
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
