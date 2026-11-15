import type { ToolKind } from '../../../core/events'

// Pi's two file tools: `write` ({ path, content }) and `edit` ({ path, edits: [{ oldText, newText }] }).

export interface PiEdit { file: string, removed: string, added: string }

function pairs(input: Record<string, unknown>): Array<{ oldText: string, newText: string }> {
  const edits = input['edits']
  if (!Array.isArray(edits)) return []
  return edits.flatMap(e => {
    const o = e !== null && typeof e === 'object' ? e as Record<string, unknown> : {}
    return typeof o['oldText'] === 'string' && typeof o['newText'] === 'string' ? [{ oldText: o['oldText'], newText: o['newText'] }] : []
  })
}

/** What a call adds and removes in its one file, as far as the call shows it (a write's removed text is read by the caller). */
export function piEdit(kind: ToolKind, input: Record<string, unknown>, file: string | undefined, before: () => string | undefined): PiEdit | undefined {
  if (file === undefined) return undefined
  if (kind === 'write' && typeof input['content'] === 'string') return { file, removed: before() ?? '', added: input['content'] }
  if (kind !== 'edit') return undefined
  const list = pairs(input)
  if (list.length === 0) return undefined
  return { file, removed: list.map(p => p.oldText).join('\n'), added: list.map(p => p.newText).join('\n') }
}

export function textsOf(edit: PiEdit | undefined, which: 'added' | 'removed'): Record<string, string> {
  return edit !== undefined && edit[which] !== '' ? { [edit.file]: edit[which] } : {}
}
