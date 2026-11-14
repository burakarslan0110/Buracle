import { join } from 'node:path'
import type * as CoreNs from '../../../core/index'
import type { Harness, HookId } from '../../../core/events'
import type { SpoolEntry } from '../../../core/memory/spool'
import type { WorkspaceInfo } from '../../../core/workspace'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../../engine/fsx'
import { currentBranch, projectIdentity } from '../../../engine/git'
import type { AdapterContext } from '../../registry'
import type { AssetsSpawner } from '../project-assets'
import type { UiSessionHooks } from '../ui-session'

export const CONTEXT_BUDGET_BYTES = 9_600

/** The pure functions the pipeline calls; an adapter passes its injected core, so a test's fake reaches every step. */
export type PipelineCore = Pick<typeof CoreNs,
  | 'ASYNC_QUESTION_PAUSED' | 'answerReceipt' | 'checkBash' | 'checkQuestion' | 'checkWrite' | 'consentVerdict' | 'detectSignals' | 'handoffNote'
  | 'isGuardContinuation' | 'laneStateDenial' | 'ledgerAudited' | 'ledgerCall' | 'ledgerMcpResult' | 'ledgerPrompt' | 'promptInteraction' | 'questionPause'
  | 'reminders' | 'restoreContext' | 'routeAuditAllowed' | 'routeTool' | 'stopGuardVerdict' | 'turnAudit' | 'validatePlan' | 'workspaceContext' | 'workspaceNotice'>

/** The memory layer's entry points, each optional because the memory modules load lazily and may be missing. */
export interface MemoryFns {
  appendSpool?: (h: Harness, sid: string, entries: SpoolEntry[], opts?: { suffix?: string }) => unknown
  spawnFinalizer?: (h: Harness, sid: string) => unknown
  sessionStart?: (h: Harness, sid: string, cwd: string, opts?: { nowMs?: number, model?: string }) => unknown
  promptSeen?: (h: Harness, sid: string, opts?: { nowMs?: number }) => unknown
  contextText?: (opts: { cwd: string, harness?: string, branch?: string, nowMs?: number, maxBytes?: number }) => Promise<string>
  writeHandoff?: (input: { harness: Harness, sessionId: string, cwd: string, project?: string, branch?: string, slug: string, markdown: string, trigger?: string, now?: number }) => Promise<{ id: string, path: string, rel: string } | undefined>
  latestHandoff?: (opts: { project: string, branch?: string, nowMs?: number, session?: string }) => Promise<{ id: string, path: string, rel: string, title: string } | undefined>
}

/** How the session's workspace is looked up; both hooks' dependency objects have these, so a test's fake reaches the pipeline. */
export interface WorkspaceReaders {
  prepareWorkspace?(cwd: string, ctx: AdapterContext, nowMs: number): Promise<WorkspaceInfo | undefined>
  workspaceInfo?(cwd: string, ctx: AdapterContext, nowMs: number): Promise<WorkspaceInfo | undefined>
  refreshWorkspace?(info: WorkspaceInfo, ctx: AdapterContext, nowMs: number): WorkspaceInfo
}

/**
 * What every event needs from its harness. A step's name is its label in the log; `step` runs it, and on a
 * throw logs it and returns the fallback (hooks fail open).
 */
export interface PipelineDeps {
  harness: Harness
  ctx: AdapterContext
  core: PipelineCore
  env: Record<string, string | undefined>
  /** The process environment the notices and the profile guard read, where `env` is an injected lookup; `env` by default. */
  hostEnv?: Record<string, string | undefined>
  step<T>(name: string, fallback: T, fn: () => T | Promise<T>): Promise<T>
  memory<K extends keyof MemoryFns>(name: K): Promise<MemoryFns[K] | undefined>
  workspace: WorkspaceReaders
  ui: UiSessionHooks
  /** The project and branch of a folder; git by default. */
  project?(cwd: string): Promise<{ project: string, branch?: string }>
  /** The suffix of this hook's spool file, where another writer of the harness has the plain one. */
  spoolSuffix?: string
  realpath?(p: string): string | undefined
  buracleRepo?(cwd: string, ctx: AdapterContext): Promise<string | undefined>
  assetsSpawn?: AssetsSpawner
}

export function memoryOff(d: Pick<PipelineDeps, 'env'>): boolean {
  return d.env['BURACLE_NO_MEMORY'] === '1'
}

export function captureOff(d: Pick<PipelineDeps, 'env'>): boolean {
  return d.env['BURACLE_NO_CAPTURE'] === '1' || memoryOff(d)
}

/** Append to the session's memory spool (H14). */
export async function spool(d: PipelineDeps, sid: string, entries: SpoolEntry[]): Promise<void> {
  if (entries.length === 0 || captureOff(d)) return
  await d.step('H14 spool', undefined, async () => {
    await (await d.memory('appendSpool'))?.(d.harness, sid, entries, d.spoolSuffix !== undefined ? { suffix: d.spoolSuffix } : {})
  })
}

export async function projectOf(d: PipelineDeps, cwd: string): Promise<{ project: string, branch?: string }> {
  if (d.project !== undefined) return d.project(cwd)
  const id = await projectIdentity(cwd)
  const branch = await currentBranch(cwd)
  return { project: id.slug, ...(branch !== undefined ? { branch } : {}) }
}

/** The newest handoff of the project another session left, for a compaction this session has no record of. */
export async function latestHandoffId(d: PipelineDeps, sid: string, cwd: string, now: number): Promise<string | undefined> {
  const latest = await d.memory('latestHandoff')
  if (latest === undefined) return undefined
  const { project, branch } = await projectOf(d, cwd)
  const r = await latest({ project, ...(branch !== undefined ? { branch } : {}), nowMs: now, session: sid })
  return typeof r?.id === 'string' ? r.id : undefined
}

type Paths = Pick<AdapterContext, 'paths'>

export function workspaceFile(ctx: Paths, h: Harness, sid: string): string {
  return join(ctx.paths.sessionDir(h, sid), 'workspace.json')
}

function isRec(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

/** The session's saved workspace record. */
export function readWorkspace(ctx: Paths, h: Harness, sid: string): WorkspaceInfo | undefined {
  const r = readJsonSafeSync<unknown>(workspaceFile(ctx, h, sid))
  const v = r.ok ? r.value : undefined
  const ok = isRec(v) && typeof v['cwd'] === 'string' && Array.isArray(v['children']) && isRec(v['index']) && isRec(v['index']['codegraph']) && isRec(v['index']['semble'])
  return ok ? v as unknown as WorkspaceInfo : undefined
}

export function saveWorkspace(ctx: Paths, h: Harness, sid: string, info: WorkspaceInfo): void {
  ensureDirSync(ctx.paths.sessionDir(h, sid))
  atomicWriteSync(workspaceFile(ctx, h, sid), JSON.stringify(info) + '\n')
}

/** The one shape of a denial on every harness. */
export function denyReason(hook: HookId, reason: string): string {
  return `Buracle ${hook}: ${reason.replace(/^Buracle:\s*/, '')}`
}

export function errText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).split('\n')[0]?.slice(0, 200) ?? 'unknown error'
}

/** The denial of a guard that could not run: guards fail closed. */
export function guardFailed(hook: 'H01' | 'H02', e: unknown): string {
  const what = hook === 'H01' ? 'bash guard could not check this command' : 'write guard could not check the files of this edit'
  return denyReason(hook, `the ${what} (${errText(e)}), so the call is blocked: Buracle's guards fail closed. Ask the user to run it themselves, or have them check \`buracle doctor\`.`)
}

/** The denial of a second-opinion fence that could not run; it fails closed like the guards. */
export const FENCE_FAILED = denyReason('H01', 'the read-only check of this second-opinion review failed, so the call was blocked.')

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

export function clipBytes(text: string, max: number, note = '\n… (truncated)'): string {
  if (byteLength(text) <= max) return text
  const room = Math.max(0, max - byteLength(note))
  let cut = text
  while (cut.length > 0 && byteLength(cut) > room) cut = cut.slice(0, Math.floor(cut.length * 0.9))
  const nl = cut.lastIndexOf('\n')
  return (nl > cut.length * 0.5 ? cut.slice(0, nl) : cut) + note
}

/** The parts that fit in `max` characters, in order; the first always stays. */
export function fitParts(parts: readonly string[], max: number): string[] {
  const out: string[] = []
  let size = 0
  for (const raw of parts) {
    const part = raw.trim()
    if (part === '') continue
    const add = part.length + (out.length > 0 ? 2 : 0)
    if (out.length > 0 && size + add > max) continue
    out.push(part)
    size += add
  }
  return out
}

/** A hook's context output, in the shape Claude Code and Codex share; undefined when there is nothing to say. */
export function contextJson(event: string, parts: readonly string[], systemMessage?: string): Record<string, unknown> | undefined {
  const text = parts.map(p => p.trim()).filter(p => p !== '').join('\n\n')
  const out: Record<string, unknown> = {}
  if (systemMessage !== undefined && systemMessage.trim() !== '') out['systemMessage'] = systemMessage.trim()
  if (text !== '') out['hookSpecificOutput'] = { hookEventName: event, additionalContext: clipBytes(text, CONTEXT_BUDGET_BYTES) }
  return Object.keys(out).length === 0 ? undefined : out
}
