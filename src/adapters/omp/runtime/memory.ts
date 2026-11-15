import { createMemoryBridge as familyBridge, uiBridgeFor, type MemoryBridge, type MemoryBridgeOptions } from '../../shared/pi-family/memory'

export { buracleCli, capText, readMemoryStatus, spawnDetached } from '../../shared/pi-family/memory'
export type { MemoryBridge, MemoryBridgeOptions, SpoolEntry, UiBridge } from '../../shared/pi-family/memory'

/** The memory UI's session record and start for Oh My Pi. */
export const ompUiBridge = uiBridgeFor('omp')

export function createMemoryBridge(opts: Omit<MemoryBridgeOptions, 'harness'>): MemoryBridge {
  return familyBridge({ harness: 'omp', ...opts })
}
