import type { Harness } from '../core/events'
import type { Collector } from './types'

/** The collector of a harness whose usage source is not wired yet: an entry with no windows. */
export function pendingCollector(harness: Harness): Collector {
  return async opts => ({ harness, computed_at: new Date(opts.nowMs).toISOString(), windows: [] })
}
