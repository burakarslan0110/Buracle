import type { BakedData } from './baked'
import { memoryBridge } from './memory-bridge'
import { createBuraclePlugin } from './plugin'

declare const BURACLE_BAKED: BakedData

export default createBuraclePlugin({ baked: BURACLE_BAKED, memory: memoryBridge, pluginDir: import.meta.dir })
