import type { Harness } from './events'
import type { RateWindow } from './status/model'

export interface UsageSnapshot { harness: Harness; computed_at: string; windows: RateWindow[] }
