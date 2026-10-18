import type { StatusView } from './commands'
import type { OmpContext } from './types'
import { hasTui, isMain } from './util'

export const PANE_WIDGET_KEY = 'buracle.pane'
export const PANE_MAX_LINES = 12
export type PaneView = Extract<StatusView, 'memory' | 'plan'>

export interface PaneHost {
  lines(view: PaneView, ctx: OmpContext): Promise<string[]>
}

export class StatusPane {
  #view: PaneView | undefined
  #shown: string | undefined

  constructor(private readonly host: PaneHost) {}

  get view(): PaneView | undefined { return this.#view }

  async toggle(view: PaneView, ctx: OmpContext): Promise<boolean> {
    if (!hasTui(ctx) || !isMain(ctx)) return false
    if (this.#view === view) { this.close(ctx); return true }
    this.#view = view
    await this.refresh(ctx)
    return true
  }

  close(ctx: OmpContext): void {
    this.#view = undefined
    this.#shown = undefined
    if (hasTui(ctx)) ctx.ui.setWidget(PANE_WIDGET_KEY, undefined, { placement: 'belowEditor' })
  }

  async refresh(ctx: OmpContext): Promise<void> {
    const view = this.#view
    if (view === undefined || !hasTui(ctx) || !isMain(ctx)) return
    const title = view === 'plan' ? 'Buracle plan' : 'Buracle memory'
    const body = (await this.host.lines(view, ctx)).slice(0, PANE_MAX_LINES - 2)
    const lines = [title, ...body, `/buracle-status ${view} again closes this view`]
    const text = lines.join('\n')
    if (text === this.#shown || this.#view !== view) return
    this.#shown = text
    ctx.ui.setWidget(PANE_WIDGET_KEY, lines, { placement: 'belowEditor' })
  }
}
