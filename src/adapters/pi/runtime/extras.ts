import type { BandView } from '../../../core/flow/band'
import { flowDef } from '../../../core/flow/catalog'
import { FOLD_AFTER_SEC } from '../../../core/flow/state'
import type { BarModel, HookHealth } from '../../../core/status/model'
import { renderPlain, rows } from '../../../core/status/render'
import type { LiveConfig } from '../../shared/pi-family/config'
import { FlowWidget, flowWidgetLines } from '../../shared/pi-family/flow-widget'
import { hasTui } from '../../shared/pi-family/util'
import type { PiContext, PiGenerated } from './types'

/** What the extras take from outside (all optional, so a test or a host without them leaves the extra out). */
export interface PiExtrasDeps {
  now(): number
  flow?: {
    start(sid: string, input: { workflow: string, source: 'skill' }, now: number): boolean
    view(sid: string, now: number, foldAfterSec: number): BandView
  }
  columns?(): number
  memoryStatus?(slug: string | undefined): BarModel['mem']
  /** Not wired by default: engine/hook-health would load ahead of the Bun stand-in in Pi's bundle. */
  hooksHealth?(nowMs: number): Promise<HookHealth | undefined>
}

export interface PiExtrasHost {
  data: Pick<PiGenerated, 'tips' | 'status'>
  deps: PiExtrasDeps
  live(): LiveConfig
  guarded<T>(what: string, fn: () => T): T | undefined
  slug(sid: string): string | undefined
}

export const TIP_PREFIX = 'Buracle Stack tip: '

/** A user prompt that loads a workflow skill: Pi spells it `/skill:<id>` (docs/skills.md of pi-coding-agent). */
export function skillWorkflowOf(text: string): string | undefined {
  const m = /^\/skill:([a-z][a-z0-9-]{0,39})(?=\s|$)/.exec(typeof text === 'string' ? text.trim() : '')
  const id = m?.[1]
  return id !== undefined && flowDef(id) !== undefined ? id : undefined
}

/**
 * The extras Pi's extension API has a place for (docs/extensions.md): the workflow band as a widget above the editor
 * (`ctx.ui.setWidget`), a Buracle Stack entry in the footer (`ctx.ui.setStatus`) and a usage tip as the working message
 * (`ctx.ui.setWorkingMessage`). Each is drawn only in the terminal UI and only where the host offers the call.
 */
export function createPiExtras(host: PiExtrasHost) {
  const { deps, guarded } = host
  const widgets = new Map<string, FlowWidget>()
  const shownStatus = new Map<string, string | undefined>()
  let tipIndex = 0

  const flowStart = (sid: string, text: string): string | undefined => {
    const workflow = skillWorkflowOf(text)
    if (workflow === undefined || deps.flow === undefined) return undefined
    const flow = deps.flow
    guarded('H25 flow start', () => flow.start(sid, { workflow, source: 'skill' }, deps.now()))
    return workflow
  }

  /** The model loaded a workflow skill (read its SKILL.md) without the user typing `/skill:<id>`. */
  const flowStartLoaded = (sid: string, skillId: string | undefined): string | undefined => {
    if (skillId === undefined || flowDef(skillId) === undefined || deps.flow === undefined) return undefined
    const flow = deps.flow
    guarded('H25 flow start', () => flow.start(sid, { workflow: skillId, source: 'skill' }, deps.now()))
    return skillId
  }

  const refreshFlow = (sid: string, ctx: PiContext): void => {
    if (!hasTui(ctx) || deps.flow === undefined || typeof ctx.ui.setWidget !== 'function') return
    const lc = host.live()
    const widget = widgets.get(sid) ?? new FlowWidget()
    widgets.set(sid, widget)
    if (!lc.config.workflow.band) { widget.draw(ctx.ui as Required<Pick<PiContext['ui'], 'setWidget'>>, []); return }
    const now = deps.now()
    const flow = deps.flow
    const view = guarded('flow view', () => flow.view(sid, now, FOLD_AFTER_SEC))
    if (view === undefined) return
    const columns = deps.columns?.() ?? 120
    widget.draw(ctx.ui as Required<Pick<PiContext['ui'], 'setWidget'>>, flowWidgetLines(view, columns, { emoji: lc.config.statusline.emoji, ansi: true }))
    const due = widget.foldDue(view, FOLD_AFTER_SEC)
    if (due !== undefined) setTimeout(() => { guarded('workflow band', () => refreshFlow(sid, ctx)) }, Math.max(0, due - now) + 250).unref?.()
  }

  const refreshStatus = async (sid: string, ctx: PiContext): Promise<void> => {
    const set = host.data.status?.setStatus
    if (!hasTui(ctx) || set === undefined || typeof ctx.ui.setStatus !== 'function') return
    const lc = host.live()
    const bar: BarModel = { harness: 'pi', windows: [] }
    const mem = guarded('memory status', () => deps.memoryStatus?.(host.slug(sid)))
    if (mem !== undefined) bar.mem = mem
    const hooks = deps.hooksHealth === undefined ? undefined : await deps.hooksHealth(deps.now()).catch(() => undefined)
    if (hooks !== undefined) bar.hooks = hooks
    const emoji = host.data.status !== undefined && host.data.status.layout.emoji && lc.config.statusline.emoji
    for (const key of Object.keys(set).sort()) {
      const layout = { rows: [set[key] ?? []], thresholds: host.data.status?.layout.thresholds ?? { ctxWarn: 75, ctxCrit: 90 }, emoji }
      const text = guarded('status render', () => renderPlain(rows(bar, layout, Number.POSITIVE_INFINITY, deps.now()))) ?? ''
      const next = text.trim() !== '' ? text : undefined
      if (shownStatus.has(key) && shownStatus.get(key) === next) continue
      shownStatus.set(key, next)
      ctx.ui.setStatus(key, next)
    }
  }

  /** One tip per run, in order, as the loader's text while the agent works. */
  const tipStart = (ctx: PiContext): void => {
    const tips = host.data.tips ?? []
    if (!hasTui(ctx) || tips.length === 0 || typeof ctx.ui.setWorkingMessage !== 'function') return
    const tip = tips[tipIndex % tips.length]
    tipIndex++
    if (tip !== undefined) ctx.ui.setWorkingMessage(`${TIP_PREFIX}${tip.text}`)
  }

  const tipEnd = (ctx: PiContext): void => {
    if (hasTui(ctx) && typeof ctx.ui.setWorkingMessage === 'function') ctx.ui.setWorkingMessage()
  }

  return { flowStart, flowStartLoaded, refreshFlow, refreshStatus, tipStart, tipEnd }
}
