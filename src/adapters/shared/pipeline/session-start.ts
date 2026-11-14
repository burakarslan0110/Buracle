import type { SessionStartDecision, SessionStartInput } from '../../../core/events'
import type { NoticeTexts } from '../../../core/notices'
import { readJsonSafeSync } from '../../../engine/fsx'
import { resetLedger } from '../../../workflow/ledger'
import { loadState, profileGuard, sessionMaint } from '../../../workflow/session-store'
import { canonicalDir } from '../../../workflow/workspace'
import { noticesOff, runtimeVersion, startupNotices } from '../notices'
import { assetsOptions, assetsSessionStart } from '../project-assets'
import {
  byteLength, captureOff, clipBytes, CONTEXT_BUDGET_BYTES, latestHandoffId, memoryOff, readWorkspace, saveWorkspace, type PipelineDeps,
} from './types'

/** What the last compaction left for the restore; `recent` says a compaction was recorded lately, so an empty record is trusted. */
export interface CompactRecord { handoff?: string, todo?: string[], recent: boolean }

export interface CompactStore {
  read(now: number): CompactRecord
  /** Save what the restore after the compaction reads: the handoff when one was written, else the open todos. */
  save(handoff: string | undefined, todo: string[]): void
}

export interface SessionStartPorts {
  capabilityCard(): string
  compact: Pick<CompactStore, 'read'>
  /** Context of the harness's own, placed before the memory index. */
  extraContext?: readonly string[]
  /** The profile warning (H17) in words for the model to pass on; absent where the harness shows it to the user itself. */
  profileNote?(finding: string): string
  sessionMaint?(now: number, keep: string[]): void
}

export interface SessionStartResult extends SessionStartDecision { notice?: NoticeTexts, profile?: string }

/** The workspace note (H21); a subagent reads the session's saved workspace when it works in the same folder. */
export async function workspaceStart(input: Pick<SessionStartInput, 'sessionId' | 'cwd' | 'subagent' | 'now'>, d: PipelineDeps): Promise<string> {
  const { sessionId: sid, cwd, now } = input
  const w = d.workspace
  let info
  if (input.subagent === true) {
    const saved = readWorkspace(d.ctx, d.harness, sid)
    info = saved !== undefined && w.refreshWorkspace !== undefined && saved.cwd === canonicalDir(cwd) ? w.refreshWorkspace(saved, d.ctx, now) : await w.workspaceInfo?.(cwd, d.ctx, now)
  } else {
    info = await w.prepareWorkspace?.(cwd, d.ctx, now)
    if (info !== undefined) saveWorkspace(d.ctx, d.harness, sid, info)
  }
  return info !== undefined ? d.core.workspaceContext(info, d.harness) : ''
}

/** The restore note after a compaction (H07): the plan state with the handoff or the open todos the session recorded. */
async function restore(input: SessionStartInput, d: PipelineDeps & SessionStartPorts): Promise<string> {
  const { sessionId: sid, cwd, now } = input
  const own = d.compact.read(now)
  const todo = own.handoff === undefined && (own.todo?.length ?? 0) > 0 ? own.todo : undefined
  const handoff = own.handoff ?? (todo === undefined && !own.recent && !memoryOff(d) ? await latestHandoffId(d, sid, cwd, now) : undefined)
  return d.core.restoreContext(loadState(d.harness, sid), handoff, todo) ?? ''
}

/**
 * sessionStart: the session record and the usage ledger (H14, H24), the memory UI, the workspace (H21), project
 * assets (H28), the capability card (H15), the restore after a compaction (H07), release notices and the profile
 * guard (H17), the memory index (H13) and session maintenance (H16).
 */
export async function sessionStart(input: SessionStartInput, d: PipelineDeps & SessionStartPorts): Promise<SessionStartResult> {
  const { harness: H, sessionId: sid, cwd, source, now } = input
  const sub = input.subagent === true
  if (source !== 'compact' && !captureOff(d)) {
    await d.step('H14 session record', undefined, async () => {
      await (await d.memory('sessionStart'))?.(H, sid, cwd, input.model !== undefined ? { nowMs: now, model: input.model } : { nowMs: now })
    })
  }
  if (!sub && (source === 'startup' || source === 'clear')) await d.step('H24 ledger reset', undefined, () => { resetLedger(H, sid) })
  if (!sub) await d.step('H14 memory UI', undefined, () => (source === 'compact' ? d.ui.seen(H, sid, now) : d.ui.started(H, sid, now)))
  const workspace = await d.step('H21 workspace', '', () => workspaceStart(input, d))
  const assets = sub ? '' : await d.step('H28 project assets', '', () => assetsSessionStart(readWorkspace(d.ctx, H, sid)?.root, H, assetsOptions(now, d.assetsSpawn)))
  const card = await d.step('H15 capability card', '', () => d.capabilityCard())
  const restored = source === 'compact' ? await d.step('H07 restore', '', () => restore(input, d)) : ''
  const notice = source === 'startup' && !sub && !noticesOff(d.hostEnv ?? d.env)
    ? await d.step('H17 notices', undefined as NoticeTexts | undefined, () => startupNotices(d.ctx.canonical.notices, { version: runtimeVersion(d.ctx.repoRoot), nowMs: now, harness: H }))
    : undefined
  const profile = source !== 'startup' ? undefined : await d.step('H17 profile guard', undefined as string | undefined, () => {
    const r = readJsonSafeSync<unknown>(d.ctx.paths.runtimeConfigFile())
    return profileGuard(H, r.ok ? r.value : undefined, d.hostEnv ?? d.env)
  })
  const before = [profile !== undefined ? d.profileNote?.(profile) ?? '' : '', restored, notice?.model ?? '', workspace, assets, ...(d.extraContext ?? [])]
  const room = CONTEXT_BUDGET_BYTES - byteLength([...before, card].filter(s => s.trim() !== '').join('\n\n')) - 64
  const memory = room <= 400 || memoryOff(d) ? '' : await d.step('H13 memory context', '', async () => {
    const text = (await (await d.memory('contextText'))?.({ cwd, harness: H, nowMs: now, maxBytes: room }))?.trim() ?? ''
    return clipBytes(text, room)
  })
  if (source === 'startup') await d.step('H16 session maintenance', undefined, () => { (d.sessionMaint ?? ((n, keep) => { sessionMaint(H, n, { keep }) }))(now, [sid]) })
  return {
    context: [...before, memory, card].filter(s => s.trim() !== ''),
    ...(notice !== undefined ? { notice } : {}), ...(profile !== undefined ? { profile } : {}),
  }
}
