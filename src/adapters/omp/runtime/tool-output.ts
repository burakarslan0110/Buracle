import { classifyTool, type ToolKind } from '../../../core/events'
import { cmOmpEvents } from '../../../core/context-mode'
import { maskNotice, masksToolKind, maskToolOutput } from '../../shared/tool-output-mask'
import { isDeviceWrite } from './routing'
import type { OmpContext, OmpTextBlock, OmpToolResultEvent } from './types'
import { hasTui } from './util'

const DONE_TODO = new Set(['completed', 'done', 'abandoned', 'cancelled', 'deleted', 'failed'])

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

export function openTodosOf(event: Pick<OmpToolResultEvent, 'toolName' | 'input' | 'content' | 'isError'>): string[] | undefined {
  if (event.toolName !== 'todo' || event.isError) return undefined
  const ev = cmOmpEvents({ toolName: event.toolName, input: event.input, content: event.content, isError: false }, { cwd: '' })[0]
  const list = ev?.tool === 'TodoWrite' ? ev.input['todos'] : undefined
  if (!Array.isArray(list)) return undefined
  const out: string[] = []
  for (const t of list) {
    if (t === null || typeof t !== 'object') continue
    const item = t as Record<string, unknown>
    const text = typeof item['content'] === 'string' ? item['content'].trim() : ''
    const status = typeof item['status'] === 'string' ? item['status'] : 'pending'
    if (text !== '' && !DONE_TODO.has(status)) out.push(text.slice(0, 200))
  }
  return out.slice(0, 30)
}
