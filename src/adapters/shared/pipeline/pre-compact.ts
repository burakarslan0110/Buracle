import { join } from 'node:path'
import { RESTORE_RECORD_MAX_MS, RESTORE_TODOS_MAX } from '../../../core/compact'
import type { CompactDecision, CompactInput, Harness } from '../../../core/events'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../../../engine/fsx'
import { loadState } from '../../../workflow/session-store'
import type { AdapterContext } from '../../registry'
import { memoryOff, projectOf, type PipelineDeps } from './types'

export interface PreCompactPorts {
  /** The open todo items, from wherever the harness keeps them. */
  openTodos(): string[] | Promise<string[]>
}

/** What the last compaction left for the restore; `recent` says a compaction was recorded lately, so an empty record is trusted. */
export interface CompactRecord { handoff?: string, todo?: string[], recent: boolean }

type Paths = Pick<AdapterContext, 'paths'>

/** compact.json of a session: `{ v: 1, at, handoff? | todo? }`, the one compaction record of every harness. */
export function compactFile(ctx: Paths, h: Harness, sid: string): string {
  return join(ctx.paths.sessionDir(h, sid), 'compact.json')
}

/** Save what the restore after the compaction reads: the handoff when one was written, else the open todos. */
export function saveCompact(ctx: Paths, h: Harness, sid: string, at: number, handoff: string | undefined, todo: readonly string[]): void {
  ensureDirSync(ctx.paths.sessionDir(h, sid))
  atomicWriteSync(compactFile(ctx, h, sid), JSON.stringify({ v: 1, at, ...(handoff !== undefined ? { handoff } : todo.length > 0 ? { todo } : {}) }) + '\n')
}

/** The session's compaction record; a missing, unreadable, foreign or old one reads as no recent compaction. */
export function readCompact(ctx: Paths, h: Harness, sid: string, now: number): CompactRecord {
  const r = readJsonSafeSync<unknown>(compactFile(ctx, h, sid))
  const v = r.ok && r.value !== null && typeof r.value === 'object' && !Array.isArray(r.value) ? r.value as Record<string, unknown> : {}
  const at = v['at']
  if (v['v'] !== 1 || typeof at !== 'number' || now - at > RESTORE_RECORD_MAX_MS) return { recent: false }
  const { handoff, todo } = v
  if (typeof handoff === 'string') return { recent: true, ...(/^handoff-[a-z0-9-]+$/.test(handoff) ? { handoff } : {}) }
  const open = Array.isArray(todo) ? todo.filter((t): t is string => typeof t === 'string' && t.trim() !== '').slice(0, RESTORE_TODOS_MAX) : []
  return { recent: true, ...(open.length > 0 ? { todo: open } : {}) }
}

/** preCompact (H06): record the compaction, write the handoff note to memory, then point the record at it. */
export async function preCompact(input: CompactInput, d: PipelineDeps & PreCompactPorts): Promise<CompactDecision> {
  const { harness: H, sessionId: sid, cwd, now } = input
  const todo = await d.step('H06 todos', [] as string[], () => d.openTodos())
  const mark = (handoff?: string) => d.step('H06 compaction record', undefined, () => { saveCompact(d.ctx, H, sid, now, handoff, todo.slice(0, RESTORE_TODOS_MAX)) })
  await mark()
  const handoff = memoryOff(d) ? undefined : await d.step('H06 handoff', undefined as string | undefined, async () => {
    const write = await d.memory('writeHandoff')
    if (write === undefined) return undefined
    const { project, branch } = await projectOf(d, cwd)
    const where = { project, ...(branch !== undefined ? { branch } : {}) }
    const note = d.core.handoffNote({ state: loadState(H, sid), harness: H, sessionId: sid, now, ...where, ...(todo.length > 0 ? { todo } : {}) })
    const r = await write({ harness: H, sessionId: sid, cwd, ...where, slug: note.slug, markdown: note.markdown, ...(input.trigger !== undefined ? { trigger: input.trigger } : {}), now })
    return typeof r?.id === 'string' ? r.id : undefined
  })
  if (handoff !== undefined) await mark(handoff)
  return { todo, ...(handoff !== undefined ? { handoff } : {}) }
}
