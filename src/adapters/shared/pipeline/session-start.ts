import type { SessionStartDecision, SessionStartInput } from '../../../core/events'
import type { NoticeTexts } from '../../../core/notices'
import { readJsonSafeSync } from '../../../engine/fsx'
import { resetLedger } from '../../../workflow/ledger'
import { profileGuard } from '../../../workflow/session-store'
import { assetsOptions, assetsSessionStart } from '../project-assets'
import { byteLength, CONTEXT_BUDGET_BYTES, type PipelineDeps } from './types'

export type SessionStartStep = 'ledger' | 'record' | 'ui' | 'restore' | 'card' | 'workspace' | 'assets' | 'notices' | 'profile' | 'memory' | 'maint'

export interface SessionStartParts {
  restore: string
  notice?: NoticeTexts
  workspace: string
  assets: string
  card: string
  /** The memory index, unclipped; `room` is the bytes it may take. */
  memory: string
  room: number
  /** The profile guard's finding (H17). */
  profile?: string
}

export interface SessionStartPorts {
  /** The order this harness runs the steps in; a function is a step only it has. */
  sessionStartOrder: ReadonlyArray<SessionStartStep | (() => void | Promise<void>)>
  capabilityCard(): string
  /** The restore note after a compaction (H07): the plan state with the handoff or the open todos the session recorded. */
  restore(): string | Promise<string>
  noticesOff(): boolean
  startupNotices(): NoticeTexts | undefined
  runtimeConfigFile(): string
  profileEnv(): Record<string, string | undefined>
  sessionMaint(now: number, keep: string[]): void
  /** Context of the harness's own that counts against the memory index's room. */
  fixedContext?(parts: SessionStartParts): string[]
}

export interface SessionStartResult extends SessionStartDecision { parts: SessionStartParts }

export async function workspaceStart(input: Pick<SessionStartInput, 'sessionId' | 'cwd' | 'subagent' | 'now'>, d: PipelineDeps): Promise<string> {
  const sub = input.subagent === true
  const info = sub ? await d.workspace.subagent(input.sessionId, input.cwd, input.now) : await d.workspace.prepare(input.cwd, input.now)
  if (info === undefined) return ''
  if (!sub) d.workspace.save(input.sessionId, info)
  return d.core.workspaceContext(info, d.harness)
}

/**
 * sessionStart: the usage ledger (H24), the session record and the memory UI (H14), the restore after a
 * compaction (H07), the capability card (H15), the workspace (H21), project assets (H28), release notices and
 * the profile guard (H17), the memory index (H13) and session maintenance (H16).
 */
export async function sessionStart(input: SessionStartInput, d: PipelineDeps & SessionStartPorts): Promise<SessionStartResult> {
  const { harness: H, sessionId: sid, cwd, source, now } = input
  const sub = input.subagent === true
  const p: SessionStartParts = { restore: '', workspace: '', assets: '', card: '', memory: '', room: 0 }
  const steps: Record<SessionStartStep, () => Promise<void>> = {
    async ledger() {
      if (!sub && (source === 'startup' || source === 'clear')) await d.step('H24 ledger reset', undefined, () => { resetLedger(H, sid) })
    },
    async record() {
      if (source === 'compact' || d.captureOff) return
      await d.step('H14 session record', undefined, async () => {
        const start = await d.memory('sessionStart')
        if (start !== undefined) await start(H, sid, cwd, input.model !== undefined ? { nowMs: now, model: input.model } : { nowMs: now })
      })
    },
    async ui() {
      if (!sub) await d.step('H14 memory UI', undefined, () => (source === 'compact' ? d.ui.seen(H, sid, now) : d.ui.started(H, sid, now)))
    },
    async restore() {
      if (source !== 'compact') return
      p.restore = await d.step('H07 restore', '', () => d.restore())
    },
    async card() {
      p.card = await d.step('H15 capability card', '', () => d.capabilityCard())
    },
    async workspace() {
      p.workspace = await d.step('H21 workspace', '', () => workspaceStart(input, d))
    },
    async assets() {
      if (!sub) p.assets = await d.step('H28 project assets', '', () => assetsSessionStart(d.workspace.read(sid)?.root, H, assetsOptions(now, d.assetsSpawn)))
    },
    async notices() {
      if (source !== 'startup' || sub || d.noticesOff()) return
      const notice = await d.step('H17 notices', undefined as NoticeTexts | undefined, () => d.startupNotices())
      if (notice !== undefined) p.notice = notice
    },
    async profile() {
      if (source !== 'startup') return
      const text = await d.step('H17 profile guard', undefined as string | undefined, () => {
        const r = readJsonSafeSync<unknown>(d.runtimeConfigFile())
        return profileGuard(H, r.ok ? r.value : undefined, d.profileEnv())
      })
      if (text !== undefined) p.profile = text
    },
    async memory() {
      const fixed = [p.restore, p.notice?.model ?? '', p.workspace, p.assets, p.card, ...(d.fixedContext?.(p) ?? [])].filter(s => s.trim() !== '')
      p.room = CONTEXT_BUDGET_BYTES - byteLength(fixed.join('\n\n')) - 64
      if (p.room <= 400 || d.memoryOff) return
      p.memory = await d.step('H13 memory context', '', async () => {
        const contextText = await d.memory('contextText')
        if (contextText === undefined) return ''
        const text = await contextText({ cwd, harness: H, nowMs: now, maxBytes: p.room })
        return text.trim() === '' ? '' : text
      })
    },
    async maint() {
      if (source === 'startup') await d.step('H16 session maintenance', undefined, () => { d.sessionMaint(now, [sid]) })
    },
  }
  for (const s of d.sessionStartOrder) await (typeof s === 'function' ? s() : steps[s]())
  return { parts: p, context: [p.restore, p.notice?.model ?? '', p.workspace, p.assets, p.memory, p.card].filter(s => s.trim() !== '') }
}
