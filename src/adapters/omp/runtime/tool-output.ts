import { classifyTool, type ToolKind } from '../../../core/events'
import { redactClip } from '../../../core/memory/text'
import { maskNotice, masksToolKind, maskToolOutput } from '../../shared/tool-output-mask'
import { isDeviceWrite } from './routing'
import type { OmpContext, OmpTextBlock, OmpToolResultEvent } from './types'
import { hasTui } from './util'

const DONE_TODO = new Set(['completed', 'done', 'abandoned', 'cancelled', 'deleted', 'failed'])
const TODO_TEXT_MAX = 200
const TODOS_MAX = 30

export function maskedContent(event: Pick<OmpToolResultEvent, 'content'>, kind: ToolKind, device: boolean): { content: OmpTextBlock[], count: number } | undefined {
  if (!masksToolKind(kind) && !device) return undefined
  const blocks = Array.isArray(event.content) ? event.content : []
  let count = 0
  const content = blocks.map(b => {
    if (b === null || typeof b !== 'object' || b.type !== 'text' || typeof b.text !== 'string') return b
    const r = maskToolOutput(b.text)
    if (r.count === 0 || typeof r.value !== 'string') return b
    count += r.count
    return { ...b, text: r.value }
  })
  return count > 0 ? { content, count } : undefined
}

export function maskResult(event: OmpToolResultEvent, ctx: OmpContext, opts: { redact: boolean, mcpIds: string[], home: string }): OmpTextBlock[] | undefined {
  if (!opts.redact) return undefined
  const input = event.input !== null && typeof event.input === 'object' ? event.input : {}
  const cls = classifyTool('omp', event.toolName, input, ctx.cwd, opts.mcpIds, { homeTilde: opts.home })
  const r = maskedContent(event, cls.kind, isDeviceWrite(event.toolName, input))
  if (r === undefined) return undefined
  if (hasTui(ctx)) {
    try { ctx.ui.notify(maskNotice(r.count), 'info') } catch {  }
  }
  return r.content
}

export interface OmpTodo { content: string; status: string }

/**
 * The checklist omp's `todo` tool prints: a `Remaining items` line, then one `  - <text> [<status>]` line per
 * item (an optional parenthesised note may follow the status). `undefined` when the text holds no such list,
 * `[]` for `Remaining items: none`.
 */
export function ompTodos(text: string): OmpTodo[] | undefined {
  const lines = text.split('\n')
  const at = lines.findIndex(l => /^\s*Remaining items\b/.test(l))
  if (at < 0) return undefined
  if (/^\s*Remaining items:\s*none\b/i.test(lines[at] ?? '')) return []
  const out: OmpTodo[] = []
  for (const l of lines.slice(at + 1)) {
    const m = /^\s+-\s+(.+?)\s+\[([a-z_]+)\](?:\s+\(.*\))?\s*$/.exec(l)
    if (m === null) break
    out.push({ content: m[1] ?? '', status: m[2] ?? 'pending' })
  }
  return out
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map(b => (b !== null && typeof b === 'object' && typeof (b as OmpTextBlock).text === 'string' ? (b as OmpTextBlock).text as string : '')).filter(t => t !== '').join('\n')
}

export function openTodosOf(event: Pick<OmpToolResultEvent, 'toolName' | 'input' | 'content' | 'isError'>): string[] | undefined {
  if (event.toolName !== 'todo' || event.isError) return undefined
  const list = ompTodos(textOf(event.content))
  if (list === undefined) return undefined
  const out: string[] = []
  for (const t of list) {
    const text = redactClip(t.content, TODO_TEXT_MAX).text.trim()
    if (text !== '' && !DONE_TODO.has(t.status)) out.push(text)
  }
  return out.slice(0, TODOS_MAX)
}
