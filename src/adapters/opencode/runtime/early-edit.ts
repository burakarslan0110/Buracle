import type { BuracleConfig } from '../../../core/config'
import type { ToolCall } from '../../../core/events'
import * as paths from '../../../engine/paths'
import { earlyEdit } from '../../shared/plan-mode'

const HARNESS = 'opencode' as const

export function earlyEditNote(call: ToolCall, approval: BuracleConfig['plan']['planApproval'], push: (note: string) => void, warn: (error: unknown) => void): void {
  try {
    const early = paths.isValidSessionId(call.sessionId) ? earlyEdit(HARNESS, call.sessionId, call.paths, call.cwd, approval) : undefined
    if (early === undefined) return
    push(early.note)
    early.commit()
  } catch (err) { warn(err) }
}
