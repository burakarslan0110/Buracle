import type { Harness } from '../../core/events'
import { harnessProfile } from '../../core/harness/index'
import { detectBinary } from '../../engine/proc'
import type { Adapter, AdapterContext } from '../registry'

type Finding = { level: 'ok' | 'warn' | 'error', check: string, detail: string }

/**
 * The adapter of a harness Buracle knows but does not support yet: detects the program, builds and installs nothing,
 * and says so in `doctor`. `extra` adds findings that already hold today (Pi's folder shared with omp).
 */
export function stubAdapter(harness: Harness, extra?: (ctx: AdapterContext) => Promise<Finding[]>): Adapter {
  const profile = harnessProfile(harness)
  return {
    harness,
    detect: () => detectBinary(profile.bin),
    build: async () => [],
    installPlan: async () => ({ id: harness, harness, ops: [] }),
    doctor: async ctx => [
      { level: 'warn', check: `${harness}.support`, detail: `Buracle support for ${profile.label} is not installed yet` },
      ...(extra !== undefined ? await extra(ctx) : []),
    ],
  }
}
