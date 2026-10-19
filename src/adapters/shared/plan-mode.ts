import type { Harness } from '../../core/events'
import { FILE_WRITING_WORKFLOWS, preApprovalEdit, readOnlyStartNotice } from '../../core/plan/plan-mode'
import { loadState, updateState } from '../../workflow/session-store'

export function startedWorkflow(candidates: ReadonlyArray<string | undefined>): string | undefined {
  return candidates.find((w): w is string => typeof w === 'string' && Object.prototype.hasOwnProperty.call(FILE_WRITING_WORKFLOWS, w))
}

export function readOnlyStart(h: Harness, readOnly: boolean, candidates: ReadonlyArray<string | undefined>): string | undefined {
  if (!readOnly) return undefined
  const workflow = startedWorkflow(candidates)
  return workflow !== undefined ? readOnlyStartNotice(workflow, h) : undefined
}

export interface EarlyEdit { note: string; commit: () => void }

export function earlyEdit(h: Harness, sid: string, files: readonly string[], cwd: string, planApproval: boolean): EarlyEdit | undefined {
  if (files.length === 0) return undefined
  const opts = { cwd, planApproval }
  const r = preApprovalEdit(loadState(h, sid), files, opts)
  if (r.note === undefined) return undefined
  return { note: r.note, commit: () => { updateState(h, sid, s => preApprovalEdit(s, files, opts).next) } }
}
