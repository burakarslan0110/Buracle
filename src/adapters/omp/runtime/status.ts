import { isAbsolute, resolve } from 'node:path'
import type { BandView } from '../../../core/flow/band'
import { bandSummary, bandText } from '../../../core/flow/band'
import { memoryPaneLines, planPaneLines } from '../../../core/flow/panes'
import { indexStatusOf } from '../../../core/status/live'
import type { BarModel, HookHealth, IndexStatus } from '../../../core/status/model'
import { statusHealth } from '../../../engine/hook-health'
import { brainDir } from '../../../engine/paths'
import { monthFromEntry } from '../../../usage/bar'
import { isStale } from '../../../usage/cache'
import { OMP_ASIDE_COMMAND, OMP_PING_COMMAND, OMP_STATUS_COMMAND, type StatusView } from './commands'
import type { LiveConfig } from './config'
import type { ExtensionDeps } from './deps'
import type { OmpContext, OmpGenerated } from './types'
import { hasTui, isMain, sessionOf, withDeadline } from './util'

export const WIDGET_KEY = 'buracle'
export const STATUS_KEYS = { mem: 'buracle.mem', month: 'buracle.budget' } as const
const USAGE_REFRESH_INTERVAL_MS = 60_000
const INDEX_TTL_MS = 30_000

export interface StatusHost {
  data: OmpGenerated
  deps: ExtensionDeps
  live(): LiveConfig
  guarded<T>(what: string, fn: () => T): T | undefined
  slug(sid: string): string | undefined
  band: { get(sid: string): string | undefined, set(sid: string, text: string | undefined): void }
  hooks?: (nowMs: number) => Promise<HookHealth>
}

export interface StatusTexts {
  refresh(ctx: OmpContext): Promise<void>
  lines(view: StatusView, ctx: OmpContext): Promise<string[]>
}

export function createStatusTexts(host: StatusHost): StatusTexts {
  const { data, deps, guarded } = host
  let lastUsageRefresh = Number.NEGATIVE_INFINITY
  let indexCache: { cwd: string, at: number, value: Promise<IndexStatus | undefined> } | undefined

  const planCounts = (path: string, cwd: string): { done: number, total: number } => {
    const text = deps.readText(isAbsolute(path) ? path : resolve(cwd, path))
    if (text === undefined) return { done: 0, total: 0 }
    const plan = guarded('parsePlan', () => deps.plan.parsePlan(text))
    return plan !== undefined ? { done: plan.tasks.filter(t => t.done).length, total: plan.tasks.length } : { done: 0, total: 0 }
  }

  const indexFor = (cwd: string, lc: LiveConfig): Promise<IndexStatus | undefined> => {
    const now = deps.now()
    const c = indexCache
    if (c !== undefined && c.cwd === cwd && now >= c.at && now - c.at < INDEX_TTL_MS) return c.value
    const value = deps.workspaceInfo(cwd, lc.config, now).then(indexStatusOf, (e: unknown) => {
      guarded('index state', () => { throw e })
      return undefined
    })
    indexCache = { cwd, at: now, value }
    return value
  }

  const flowFor = (sid: string, lc: LiveConfig): BandView | undefined => {
    if (lc.config.workflow.band) return undefined
    const v = guarded('flow view', () => deps.flow.view(sid, deps.now(), lc.config.workflow.foldAfterSec))
    return v?.visible === true ? v : undefined
  }

  const barFor = async (sid: string, ctx: OmpContext, lc: LiveConfig, need: { git: boolean, index: boolean }): Promise<BarModel> => {
    const bar: BarModel = { harness: 'omp', windows: [] }
    if (lc.config.statusline.monthly !== 'off') {
      const entry = guarded('usage', () => deps.usage())
      const now = deps.now()
      const month = guarded('month', () => monthFromEntry(entry, now))
      if (month !== undefined) bar.month = month
      if ((guarded('usage staleness', () => isStale(entry, now)) ?? true) && now - lastUsageRefresh > USAGE_REFRESH_INTERVAL_MS) {
        lastUsageRefresh = now
        guarded('usage refresh', () => deps.refreshUsage())
      }
    }
    const ms = guarded('memory status', () => deps.memoryStatus(host.slug(sid)))
    if (ms !== undefined) bar.mem = ms
    const plan = guarded('state', () => deps.state.load(sid))?.plan
    if (plan !== undefined) bar.plan = { title: plan.slug, phase: plan.phase, ...planCounts(plan.path, ctx.cwd) }
    const updates = guarded('updates', () => deps.updates())
    if (updates !== undefined && updates > 0) bar.updates = updates
    const [git, index, hooks] = await Promise.all([
      need.git ? withDeadline(deps.gitState(ctx.cwd).catch(() => undefined), 5_000, undefined) : undefined,
      need.index ? withDeadline(indexFor(ctx.cwd, lc), 5_000, undefined) : undefined,
      withDeadline((host.hooks ?? statusHealth)(deps.now()).catch(() => undefined), 5_000, undefined),
    ])
    if (git !== undefined) bar.git = git
    if (index !== undefined) bar.index = index
    if (hooks !== undefined) bar.hooks = hooks
    return bar
  }

  const renderIds = (bar: BarModel, ids: string[][], emoji: boolean, width: number): string => {
    const layout = { rows: ids, thresholds: data.status.layout.thresholds, emoji }
    return guarded('status render', () => deps.status.renderPlain(deps.status.rows(bar, layout, width, deps.now()))) ?? ''
  }

  const statusText = async (key: string, sid: string, ctx: OmpContext): Promise<string | undefined> => {
    const ids = data.status.setStatus[key]
    if (ids === undefined) return undefined
    const lc = host.live()
    const bar = await barFor(sid, ctx, lc, { git: ids.includes('git'), index: ids.includes('index') })
    const text = renderIds(bar, [ids], data.status.layout.emoji && lc.config.statusline.emoji, Number.POSITIVE_INFINITY)
    return text.trim() !== '' ? text : undefined
  }

  const refresh = async (ctx: OmpContext): Promise<void> => {
    if (!hasTui(ctx) || !isMain(ctx)) return
    const sid = sessionOf(ctx)
    if (sid === undefined) return
    const lc = host.live()
    const emoji = data.status.layout.emoji && lc.config.statusline.emoji
    const plan = guarded('state', () => deps.state.load(sid))?.plan
    const flow = flowFor(sid, lc)
    const barStyle = lc.config.statusline.style === 'buracle' && deps.bar !== undefined
    const bandRows = plan === undefined && flow === undefined ? undefined : lc.config.statusline.style === 'compact' ? data.status.layout.compact ?? data.status.layout.rows : data.status.layout.rows
    const keys = Object.keys(data.status.setStatus)
    const wants = (id: string): boolean => keys.some(k => data.status.setStatus[k]?.includes(id)) || (bandRows?.some(r => r.includes(id)) ?? false)
    const bar = await barFor(sid, ctx, lc, { git: wants('git'), index: barStyle || wants('index') })
    if (flow !== undefined) bar.flow = flow
    for (const key of keys) {
      const text = renderIds(bar, [data.status.setStatus[key] ?? []], emoji, Number.POSITIVE_INFINITY)
      ctx.ui.setStatus(key, text.trim() !== '' ? text : undefined)
    }
    let band: string | undefined
    const width = deps.columns() > 20 ? deps.columns() - 2 : 118
    if (barStyle && deps.bar !== undefined) {
      const design = deps.bar
      const info = await withDeadline(design.info(deps.now()).catch(() => ({})), 2_000, {})
      const text = guarded('bar render', () => design.render(design.lines(bar, info, { thresholds: data.status.layout.thresholds, emoji }, width, deps.now()))) ?? ''
      band = text.trim() !== '' ? text : undefined
    } else if (bandRows !== undefined) {
      const text = renderIds(bar, bandRows, emoji, width)
      band = text.trim() !== '' ? text : undefined
    }
    if (band !== host.band.get(sid)) {
      host.band.set(sid, band)
      ctx.ui.setWidget(WIDGET_KEY, band !== undefined ? band.split('\n').slice(0, 10) : undefined, { placement: 'belowEditor' })
    }
  }

  const lines = async (view: StatusView, ctx: OmpContext): Promise<string[]> => {
    const sid = sessionOf(ctx)
    const lc = host.live()
    const now = deps.now()
    const flowView = (): BandView | undefined => (sid !== undefined ? guarded('flow view', () => deps.flow.view(sid, now, lc.config.workflow.foldAfterSec)) : undefined)
    if (view === 'flow') {
      const v = flowView()
      return v !== undefined ? bandText(v) : ['No session: Buracle has no workflow to show.']
    }
    if (view === 'plan') {
      const state = sid !== undefined ? guarded('state', () => deps.state.load(sid)) : undefined
      const v = flowView()
      if (state === undefined || v === undefined) return ['No session: Buracle has no plan to show.']
      return planPaneLines(v, state).map(l => l.text)
    }
    if (view === 'memory') {
      const ms = guarded('memory status', () => deps.memoryStatus(sid !== undefined ? host.slug(sid) : undefined))
      const out = memoryPaneLines(ms, undefined, brainDir()).map(l => l.text)
      const ui = guarded('memory UI', () => deps.memoryUi())
      out.splice(Math.max(0, out.length - 1), 0, ui !== undefined ? `web UI: ${ui.url} (/brain opens it)` : 'web UI: not running (/brain starts and opens it)')
      return out
    }
    const out = [`Buracle ${data.buracleVersion} · Oh My Pi (tested ${data.testedWith || 'unknown'}, minimum ${data.minOmp || 'unknown'})`]
    out.push(`session ${sid ?? '-'} · ${ctx.mode} · config ${lc.source}`)
    out.push(`permissions: ${lc.config.permissions.bypass ? "bypass (tools.approvalMode yolo; Buracle's guards and consent gate protect)" : 'the harness setting'}`)
    out.push(`routing: ${lc.config.routing.strictness} · skill router: ${lc.config.routing.skills} · workflow band: ${lc.config.workflow.band ? 'on' : 'off'}`)
    if (sid !== undefined) {
      const state = guarded('state', () => deps.state.load(sid))
      const plan = state?.plan
      out.push(plan !== undefined ? `plan ${plan.slug} · ${plan.phase} · ${plan.status}` : 'plan: none')
      if (state?.interaction?.state === 'paused') out.push(`paused (${state.interaction.kind ?? 'manual'})${state.interaction.reason ? `: ${state.interaction.reason}` : ''}`)
      if (state !== undefined) out.push(`stop guard ${lc.config.plan.stopGuard ? 'on' : 'off'} · blocks ${state.guard.blocksForPlan}/${lc.config.plan.runaway.perPlan} plan, ${state.guard.blocksInChain}/${lc.config.plan.runaway.perChain} chain`)
      const v = flowView()
      const run = v !== undefined ? bandSummary(v) : ''
      if (run !== '') out.push(`workflow: ${run}`)
      const ms = guarded('memory status', () => deps.memoryStatus(host.slug(sid)))
      const mem = guarded('memSegment', () => deps.memSegment(ms, now, 'wide'))
      if (mem?.text) out.push(mem.text)
      for (const key of Object.keys(data.status.setStatus)) {
        if (data.status.setStatus[key]?.includes('mem')) continue
        const text = await statusText(key, sid, ctx)
        if (text !== undefined) out.push(text)
      }
    }
    const workflows = data.commands.map(c => `/${c}`).join(' ')
    out.push(`commands: ${workflows !== '' ? `${workflows} · ` : ''}/remember <text> · /brain · /${OMP_ASIDE_COMMAND} <question> · /${OMP_STATUS_COMMAND} [status|memory|plan|flow] · /${OMP_PING_COMMAND}`)
    return out
  }

  return { refresh, lines }
}
