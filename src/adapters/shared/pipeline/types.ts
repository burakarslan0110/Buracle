import type * as CoreNs from '../../../core/index'
import type { Harness } from '../../../core/events'
import type { SpoolEntry } from '../../../core/memory/spool'
import type { WorkspaceInfo } from '../../../core/workspace'
import type { AdapterContext } from '../../registry'
import type { AssetsSpawner } from '../project-assets'
import type { UiSessionHooks } from '../ui-session'

export const CONTEXT_BUDGET_BYTES = 9_600

/** The pure functions the pipeline calls; an adapter passes its injected core, so a test's fake reaches every step. */
export type PipelineCore = Pick<typeof CoreNs,
  | 'ASYNC_QUESTION_PAUSED' | 'checkBash' | 'checkQuestion' | 'checkWrite' | 'consentVerdict' | 'detectSignals' | 'isGuardContinuation'
  | 'ledgerAudited' | 'ledgerCall' | 'ledgerMcpResult' | 'ledgerPrompt' | 'promptInteraction' | 'questionPause' | 'reminders'
  | 'routeAuditAllowed' | 'routeTool' | 'stopGuardVerdict' | 'turnAudit' | 'validatePlan' | 'workspaceContext' | 'workspaceNotice'>

/** The memory layer's entry points, each optional because the memory modules load lazily and may be missing. */
export interface MemoryFns {
  appendSpool?: (h: Harness, sid: string, entries: SpoolEntry[]) => unknown
  spawnFinalizer?: (h: Harness, sid: string) => unknown
  sessionStart?: (h: Harness, sid: string, cwd: string, opts?: { nowMs?: number, model?: string }) => unknown
  promptSeen?: (h: Harness, sid: string, opts?: { nowMs?: number }) => unknown
  contextText?: (opts: { cwd: string, harness?: string, branch?: string, nowMs?: number, maxBytes?: number }) => Promise<string>
  writeHandoff?: (input: { harness: Harness, sessionId: string, cwd: string, project?: string, branch?: string, slug: string, markdown: string, trigger?: string, now?: number }) => Promise<{ id: string, path: string, rel: string } | undefined>
  latestHandoff?: (opts: { project: string, branch?: string, nowMs?: number, session?: string }) => Promise<{ id: string, path: string, rel: string, title: string } | undefined>
}

/** The session's saved workspace record, in the harness's own file. */
export interface WorkspaceStore {
  read(sid: string): WorkspaceInfo | undefined
  save(sid: string, info: WorkspaceInfo): void
  prepare(cwd: string, now: number): Promise<WorkspaceInfo | undefined>
  subagent(sid: string, cwd: string, now: number): Promise<WorkspaceInfo | undefined>
  refresh?(info: WorkspaceInfo, now: number): WorkspaceInfo
}

/** Places where an adapter runs a step only its harness has, in the order that harness always ran it. */
export type PipelinePoint =
  | 'prompt.user' | 'prompt.granted' | 'prompt.routed' | 'prompt.record'
  | 'postTool.tool' | 'postTool.checked' | 'postTool.edited'
  | 'stop.guard'

/**
 * What every event needs from its harness. A step's name is its label in the log; `step` runs it, and on a
 * throw logs in the harness's own words and returns the fallback (hooks fail open). Some ports of the events
 * only wrap one shared call (the lane guard, the review notes, the answer receipt, the restore, the handoff
 * note, the notices, the read-only start, the early edit): tests/adapters/parity.test.ts reads each adapter's
 * source for those calls, so they stay there.
 */
export interface PipelineDeps {
  harness: Harness
  ctx: Pick<AdapterContext, 'config' | 'canonical' | 'repoRoot'>
  core: PipelineCore
  step<T>(name: string, fallback: T, fn: () => T | Promise<T>): Promise<T>
  at?(point: PipelinePoint): void | Promise<void>
  memoryOff: boolean
  captureOff: boolean
  memory<K extends keyof MemoryFns>(name: K): Promise<MemoryFns[K] | undefined>
  spool(sid: string, entries: SpoolEntry[]): Promise<void>
  project(cwd: string): Promise<{ project: string, branch?: string }>
  ui: UiSessionHooks
  workspace: WorkspaceStore
  assetsSpawn?: AssetsSpawner
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/** The newest handoff of the project another session left, for a compaction this session has no record of. */
export async function latestHandoffId(d: PipelineDeps, sid: string, cwd: string, now: number): Promise<string | undefined> {
  const latest = await d.memory('latestHandoff')
  if (latest === undefined) return undefined
  const { project, branch } = await d.project(cwd)
  const r = await latest({ project, ...(branch !== undefined ? { branch } : {}), nowMs: now, session: sid })
  return typeof r?.id === 'string' ? r.id : undefined
}
