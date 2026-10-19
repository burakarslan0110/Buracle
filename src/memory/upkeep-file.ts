import { readJsonSafeSync } from '../engine/fsx'
import { upkeepFile } from './layout'
import type { UpkeepRecord } from './sweep'

export function readUpkeep(slug?: string): UpkeepRecord | undefined {
  try {
    const r = readJsonSafeSync<UpkeepRecord>(upkeepFile(slug))
    return r.ok && r.value !== null && typeof r.value === 'object' && r.value.v === 1 && Array.isArray(r.value.items) ? r.value : undefined
  } catch {
    return undefined
  }
}
