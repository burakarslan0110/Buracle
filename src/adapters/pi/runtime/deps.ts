import { defaultConfig } from '../../../core/config'
import * as paths from '../../../engine/paths'
import { createMemoryBridge } from '../../shared/pi-family/memory'
import { hostCli, hostDeps, TOOL_CALL_DEADLINE_MS, TOOL_RESULT_DEADLINE_MS, type EvalGuard, type HostDeps } from '../../shared/pi-family/inprocess-host'
import { flowViewFor, recordFlowStart } from '../../../workflow/flow'
import { readMemoryStatus } from '../../../usage/bar'
import type { PiExtrasDeps } from './extras'
import type { PiGenerated } from './types'

export { TOOL_CALL_DEADLINE_MS, TOOL_RESULT_DEADLINE_MS }
export type { EvalGuard }

/** Pi's `codemode` tool runs a script (`code`): the one tool whose input is a program. */
export const CODE_EXECUTION_TOOLS: ReadonlySet<string> = new Set(['codemode'])

/** What the extension takes from outside, so a test can replace any of it. */
export type PiDeps = HostDeps & PiExtrasDeps & { buracleHome(): string }

export function defaultDeps(): PiDeps {
  return {
    ...hostDeps('pi'),
    buracleHome: () => paths.buracleHome(),
    memory: createMemoryBridge({ harness: 'pi', cli: hostCli }),
    flow: { start: (sid, input, now) => recordFlowStart('pi', sid, input, now), view: (sid, now, foldAfterSec) => flowViewFor('pi', sid, now, foldAfterSec) },
    columns: () => (typeof process.stdout.columns === 'number' && process.stdout.columns > 0 ? process.stdout.columns : 120),
    memoryStatus: readMemoryStatus,
  }
}

export function emptyGenerated(): PiGenerated {
  return { v: 1, buracleVersion: '0.0.0', config: defaultConfig(), routing: { strictness: 'enforce', categories: [] }, mcp: [], mcpIds: [], skills: [] }
}
