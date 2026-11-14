import { RESTORE_TODOS_MAX } from '../../../core/compact'
import type { CompactDecision, CompactInput } from '../../../core/events'
import type { PipelineDeps } from './types'

export interface PreCompactPorts {
  /** The open todo items, from wherever the harness keeps them. */
  openTodos(): string[] | Promise<string[]>
  /** Save what the restore after the compaction reads: the handoff when one was written, else the open todos. */
  saveCompactRecord(handoff: string | undefined, todo: string[]): void
  /** The handoff note of the session's plan state. */
  handoffNote(o: { project: string, branch?: string, todo: string[] }): { slug: string, markdown: string }
}

/** preCompact (H06): record the compaction, write the handoff note to memory, then point the record at it. */
export async function preCompact(input: CompactInput, d: PipelineDeps & PreCompactPorts): Promise<CompactDecision> {
  const { harness: H, sessionId: sid, cwd, now } = input
  const todo = await d.step('H06 todos', [] as string[], () => d.openTodos())
  const mark = (handoff?: string) => d.step('H06 compaction record', undefined, () => { d.saveCompactRecord(handoff, todo.slice(0, RESTORE_TODOS_MAX)) })
  await mark()
  const handoff = d.memoryOff ? undefined : await d.step('H06 handoff', undefined as string | undefined, async () => {
    const write = await d.memory('writeHandoff')
    if (write === undefined) return undefined
    const { project, branch } = await d.project(cwd)
    const note = d.handoffNote({ project, todo, ...(branch !== undefined ? { branch } : {}) })
    const r = await write({
      harness: H, sessionId: sid, cwd, project, ...(branch !== undefined ? { branch } : {}), slug: note.slug, markdown: note.markdown,
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}), now,
    })
    return typeof r?.id === 'string' ? r.id : undefined
  })
  if (handoff !== undefined) await mark(handoff)
  return { todo, ...(handoff !== undefined ? { handoff } : {}) }
}
