import type { Harness } from '../events'
import { nativeBinding } from './native'
import type { SessionState } from './state'

export const FILE_WRITING_WORKFLOWS: Readonly<Record<string, string>> = {
  'plan-build': 'its plan file under docs/plans/',
  bugfix: 'its plan file under docs/plans/',
  'goal-build': 'its run file under docs/builds/',
  requirements: 'its PRD under docs/prd/',
}

const READ_ONLY_MODE: Readonly<Record<Harness, { name: string; leave: string }>> = {
  claude: { name: "Claude Code's plan mode", leave: 'leave plan mode (Shift+Tab)' },
  codex: { name: "Codex's Plan mode", leave: 'leave Plan mode' },
  opencode: { name: "OpenCode's read-only plan agent", leave: 'switch to the build agent (Tab)' },
  omp: { name: "Oh My Pi's plan mode", leave: 'leave plan mode' },
}

export function readOnlyStartNotice(workflow: string, harness: Harness): string | undefined {
  const writes = Object.prototype.hasOwnProperty.call(FILE_WRITING_WORKFLOWS, workflow) ? FILE_WRITING_WORKFLOWS[workflow] : undefined
  const mode = READ_ONLY_MODE[harness]
  if (writes === undefined || mode === undefined) return undefined
  const native = workflow === 'plan-build' ? ' With plan.nativePlanMode on, the workflow asks the user to return to plan mode after it has registered and prepared its plan file; a plan already prepared that way (`buracle plan prepare-native`) keeps planning here and ignores this note.' : ''
  return `Buracle: ${workflow} was started while the session is in ${mode.name}, which allows no file edits, and the workflow's first phase writes ${writes}. Ask the user to ${mode.leave} first, then continue the workflow. Until then only discuss the task in the conversation: do not run \`buracle plan init\` or \`buracle plan register\`.${native}`
}

const PLAN_DIRS = /(?:^|\/)docs\/(?:plans|builds|prd)\//

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+/g, '/')
}

function absoluteIn(p: string, cwd: string): string {
  const n = norm(p)
  if (/^(?:[A-Za-z]:)?\//.test(n) || cwd === '') return n
  return `${norm(cwd).replace(/\/+$/, '')}/${n.replace(/^\.\//, '')}`
}

function isPlanArtifact(file: string, planPath: string, cwd: string): boolean {
  const f = absoluteIn(file, cwd)
  return f === absoluteIn(planPath, cwd) || PLAN_DIRS.test(f)
}

function awaitsApproval(state: SessionState, planApproval: boolean): boolean {
  const p = state.plan
  if (p === undefined || p.phase !== 'plan' || p.type === 'Plan') return false
  if (p.status === 'APPROVED' || p.status === 'IN_PROGRESS' || p.status === 'COMPLETE' || p.status === 'VERIFIED' || p.status === 'SAVED') return false
  if (state.approvals?.planApprovedAt !== undefined) return false
  return p.type === 'Build' || planApproval
}

export interface EarlyEditVerdict { note?: string; next: SessionState }

export function preApprovalEdit(state: SessionState, files: readonly string[], opts: { cwd: string; planApproval: boolean }): EarlyEditVerdict {
  const p = state?.plan
  if (p === undefined || state.guard?.earlyEditNoted === true || nativeBinding(state) !== undefined || !awaitsApproval(state, opts.planApproval !== false)) return { next: state }
  const list = Array.isArray(files) ? files.filter((f): f is string => typeof f === 'string' && f.trim() !== '') : []
  const other = list.find(f => !isPlanArtifact(f, p.path, typeof opts.cwd === 'string' ? opts.cwd : ''))
  if (other === undefined) return { next: state }
  const gate = p.type === 'Build' ? 'the run file is locked' : 'the user approves the plan'
  const note = `Buracle: this edit changes ${other} while the plan ${p.path} is still in its plan phase (status ${p.status}). The workflow allows no production code until ${gate}: if this edit is implementation work, stop there and finish the plan phase first. Edits the plan phase calls for (the plan or run file, marked temporary instrumentation, a bugfix's reproducing test) are fine. This note shows once per plan.`
  return { note, next: { ...state, guard: { ...state.guard, earlyEditNoted: true } } }
}
