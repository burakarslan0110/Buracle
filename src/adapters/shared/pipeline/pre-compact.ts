import { RESTORE_TODOS_MAX } from '../../../core/compact'
import type { CompactDecision, CompactInput } from '../../../core/events'
import { loadState } from '../../../workflow/session-store'
import type { CompactStore } from './session-start'
import { memoryOff, projectOf, type PipelineDeps } from './types'

export interface PreCompactPorts {
  /** The open todo items, from wherever the harness keeps them. */
  openTodos(): string[] | Promise<string[]>
  compact: Pick<CompactStore, 'save'>
}

/** preCompact (H06): record the compaction, write the handoff note to memory, then point the record at it. */
export async function preCompact(input: CompactInput, d: PipelineDeps & PreCompactPorts): Promise<CompactDecision> {
  const { harness: H, sessionId: sid, cwd, now } = input
  const todo = await d.step('H06 todos', [] as string[], () => d.openTodos())
  const mark = (handoff?: string) => d.step('H06 compaction record', undefined, () => { d.compact.save(handoff, todo.slice(0, RESTORE_TODOS_MAX)) })
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
