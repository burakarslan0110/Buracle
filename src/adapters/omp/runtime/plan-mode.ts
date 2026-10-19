import { FILE_WRITING_WORKFLOWS, preApprovalEdit, readOnlyStartNotice } from '../../../core/plan/plan-mode'
import type { ExtensionDeps } from './deps'
import { planModeOn } from './stop'
import type { OmpContext } from './types'

export function readOnlyStart(ctx: OmpContext, candidates: ReadonlyArray<string | undefined>): string | undefined {
  const workflow = candidates.find((w): w is string => typeof w === 'string' && Object.prototype.hasOwnProperty.call(FILE_WRITING_WORKFLOWS, w))
  return workflow !== undefined && planModeOn(ctx) ? readOnlyStartNotice(workflow, 'omp') : undefined
}

export function earlyEditNote(deps: Pick<ExtensionDeps, 'state'>, sid: string, files: readonly string[], cwd: string, planApproval: boolean): string | undefined {
  if (files.length === 0) return undefined
  const opts = { cwd, planApproval }
  const note = preApprovalEdit(deps.state.load(sid), files, opts).note
  if (note !== undefined) deps.state.update(sid, s => preApprovalEdit(s, files, opts).next)
  return note
}
