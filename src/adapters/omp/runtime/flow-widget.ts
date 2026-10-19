import type { BandView } from '../../../core/flow/band'
import { bandRows } from '../../../core/flow/band'
import { renderAnsiLines, renderPlainLines } from '../../../core/status/render'
import type { OmpUI } from './types'

export const FLOW_WIDGET_KEY = 'buracle.flow'
export const FLOW_WIDGET_MAX_LINES = 10
export const FLOW_WIDGET_ROWS = 3
export const FLOW_WIDGET_PADDING = 2

export function flowWidgetLines(view: BandView, terminalColumns: number, opts: { emoji: boolean, ansi: boolean }): string[] {
  const columns = Math.floor(Number.isFinite(terminalColumns) ? terminalColumns : 0) - FLOW_WIDGET_PADDING
  const rows = bandRows(view, columns, FLOW_WIDGET_ROWS, opts.emoji)
  if (rows.length === 0) return []
  const text = opts.ansi ? renderAnsiLines(rows) : renderPlainLines(rows)
  return text.split('\n').slice(0, FLOW_WIDGET_MAX_LINES)
}

export class FlowWidget {
  #shown: string | undefined
  #foldAt: number | undefined

  draw(ui: Pick<OmpUI, 'setWidget'>, lines: readonly string[]): boolean {
    const next = lines.length > 0 ? lines.join('\n') : undefined
    if (next === this.#shown) return false
    this.#shown = next
    ui.setWidget(FLOW_WIDGET_KEY, next === undefined ? undefined : [...lines], { placement: 'aboveEditor' })
    return true
  }

  reset(): void {
    this.#shown = undefined
    this.#foldAt = undefined
  }

  foldDue(view: BandView, foldAfterSec: number): number | undefined {
    if (!view.visible || view.endedAt === undefined) return undefined
    const at = view.endedAt + Math.max(0, Number.isFinite(foldAfterSec) ? foldAfterSec : 0) * 1000
    if (this.#foldAt === at) return undefined
    this.#foldAt = at
    return at
  }
}
