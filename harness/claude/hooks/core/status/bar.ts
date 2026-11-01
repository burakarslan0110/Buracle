import { memSegmentWith } from '../memory/status'
import { hooksSegmentTexts } from './hooks'
import { formatPct, formatTokens, formatUsd, sanitizeText, stripEmoji, textWidth, truncateToWidth } from './format'
import { gitTreeLines } from './git'
import { INDEX_STATUS_TEXT, flowElapsed, flowRow, flowRowText } from './live'
import type { BarModel, GitState, RateWindow, Segment, StatusLayout } from './model'
import { WINDOW_MINUTES, pace } from './model'

export interface BarInfo {
  product?: { name: string, version: string }
  harness?: { label: string, version?: string, plan?: string }
  memoryUrl?: string
  lines?: { added: number, removed: number }
}

type Color = NonNullable<Segment['color']>

interface Part { priority: number, variants: Segment[][] }

export const CONTEXT_BAR_CELLS = 8
const PIPE: Segment = { id: 'sep', text: ' | ', color: 'gray', dim: true }
const DOT: Segment = { id: 'sep', text: ' · ', color: 'gray', dim: true }

function seg(id: string, text: string, color?: Color, extra: { dim?: boolean, bold?: boolean, link?: string } = {}): Segment {
  const s: Segment = { id, text }
  if (color !== undefined) s.color = color
  if (extra.dim === true) s.dim = true
  if (extra.bold === true) s.bold = true
  if (extra.link !== undefined) s.link = extra.link
  return s
}

function partWidth(segs: readonly Segment[]): number {
  return segs.reduce((n, s) => n + textWidth(s.text), 0)
}

function pctColor(p: number, warn: number, crit: number): Color {
  return p >= crit ? 'red' : p >= warn ? 'yellow' : 'green'
}

export function shortDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const mins = Math.ceil(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) {
    const m = mins % 60
    return m === 0 || hours >= 10 ? `${hours}h` : `${hours}h${m}m`
  }
  const days = Math.floor(hours / 24)
  const h = hours % 24
  return h === 0 || days >= 2 ? `${days}d` : `${days}d${h}h`
}

export function contextBar(pct: number | undefined, cells = CONTEXT_BAR_CELLS): { bar: string, filled: number } {
  if (pct === undefined || !Number.isFinite(pct)) return { bar: '░'.repeat(cells), filled: 0 }
  const p = Math.min(100, Math.max(0, pct))
  const filled = p > 0 ? Math.max(1, Math.round((p / 100) * cells)) : 0
  return { bar: '█'.repeat(filled) + '░'.repeat(cells - filled), filled }
}

function modelPart(bar: BarModel): Part | undefined {
  const model = bar.model?.trim()
  if (!model) return undefined
  const name = seg('model', model, 'cyan', { bold: true })
  const effort = bar.effort?.trim() ? seg('effort', ` [${bar.effort.trim()}]`, 'cyan') : undefined
  const win = bar.ctx?.window !== undefined && bar.ctx.window > 0 ? seg('window', ` [${formatTokens(bar.ctx.window).toUpperCase().replace('K', 'k')}]`, 'cyan') : undefined
  const full = [name, ...(effort ? [effort] : []), ...(win ? [win] : [])]
  const variants = [full]
  if (win && effort) variants.push([name, effort])
  if (full.length > 1) variants.push([name])
  return { priority: 100, variants }
}

function ctxPart(bar: BarModel, layout: Pick<StatusLayout, 'thresholds'>): Part {
  const pct = bar.ctx?.pct
  const known = pct !== undefined && Number.isFinite(pct)
  const { bar: cells, filled } = contextBar(known ? pct : undefined)
  const color: Color = known ? pctColor(pct, layout.thresholds.ctxWarn, layout.thresholds.ctxCrit) : 'gray'
  const head = seg('ctx', cells.slice(0, filled), color)
  const tail = seg('ctx', cells.slice(filled), 'gray', { dim: true })
  const text = seg('ctx', known ? ` ${formatPct(pct)}%` : ' --%', known ? color : 'gray')
  const full = [...(filled > 0 ? [head] : []), tail, text]
  return { priority: 90, variants: [full, [seg('ctx', known ? `${formatPct(pct)}%` : '--%', known ? color : 'gray')]] }
}

function windowPart(w: RateWindow, nowMs: number, priority: number): Part | undefined {
  if (!Number.isFinite(w.pct) || w.label.trim() === '') return undefined
  const minutes = w.windowMinutes ?? WINDOW_MINUTES[w.label]
  const resetMs = w.resetsAt !== undefined ? Date.parse(w.resetsAt) : Number.NaN
  const known = Number.isFinite(resetMs) && minutes !== undefined
  const p = known ? pace(w.pct, w.resetsAt, minutes, nowMs) : 'even'
  const color: Color = w.pct >= 90 ? 'red' : p === 'over' ? 'red' : p === 'under' ? 'green' : w.pct >= 75 ? 'yellow' : 'green'
  const arrow = p === 'over' ? ' ↑' : p === 'under' ? ' ↓' : ''
  const label = seg(w.label, `${w.label}: `)
  const value = seg(w.label, `${formatPct(w.pct)}%${arrow}`, color, { bold: true })
  const reset = Number.isFinite(resetMs) ? seg(w.label, ` ${shortDuration(resetMs - nowMs)}`, 'gray', { dim: true }) : undefined
  const full = [label, value, ...(reset ? [reset] : [])]
  return { priority, variants: reset ? [full, [label, value]] : [full] }
}

function linesPart(info: BarInfo): Part | undefined {
  const l = info.lines
  if (l === undefined || (l.added <= 0 && l.removed <= 0)) return undefined
  return { priority: 35, variants: [[seg('lines', `+${Math.max(0, Math.round(l.added))}`, 'green'), seg('lines', ` -${Math.max(0, Math.round(l.removed))}`, 'red')]] }
}

function dirPart(bar: BarModel): Part | undefined {
  const d = bar.dir?.trim()
  if (!d) return undefined
  const parts = d.split(/[\\/]/u).filter(x => x !== '')
  const last = parts[parts.length - 1] ?? d
  const variants: Segment[][] = [[seg('dir', d, 'blue')]]
  if (last !== d) variants.push([seg('dir', last, 'blue')])
  return { priority: 30, variants }
}

function gitText(g: GitState, long: boolean): string {
  const name = g.detached ? `@${g.branch ?? 'HEAD'}` : g.branch ?? '?'
  const ab = `${g.ahead > 0 ? ` ↑${g.ahead}` : ''}${g.behind > 0 ? ` ↓${g.behind}` : ''}`
  if (!long) {
    const dirty = g.staged + g.unstaged + g.untracked
    return `⎇ ${truncateToWidth(name, 24)}${ab}${dirty > 0 ? ' *' : ''}${g.conflicts > 0 ? ` ⚠${g.conflicts}` : ''}`
  }
  return `⎇ ${name}${ab}`
    + (g.staged > 0 ? ` ●${g.staged}` : '')
    + (g.unstaged > 0 ? ` ✚${g.unstaged}` : '')
    + (g.untracked > 0 ? ` …${g.untracked}` : '')
    + gitTreeLines(g)
    + (g.stash > 0 ? ` ⚑${g.stash}` : '')
    + (g.conflicts > 0 ? ` ⚠${g.conflicts}` : '')
    + (g.worktree ? ` [wt:${g.worktree}]` : '')
}

function gitPart(bar: BarModel): Part | undefined {
  const g = bar.git
  if (g === undefined) return undefined
  const dirty = g.staged + g.unstaged + g.untracked
  const color: Color = g.conflicts > 0 ? 'red' : dirty > 0 ? 'yellow' : 'green'
  return { priority: 50, variants: [[seg('git', gitText(g, true), color)], [seg('git', gitText(g, false), color)]] }
}

function planLine(bar: BarModel): Part | undefined {
  const p = bar.plan
  if (p === undefined) return undefined
  const cells = 6
  const done = p.total > 0 ? Math.round((Math.min(p.done, p.total) / p.total) * cells) : 0
  const prog = p.total > 0 ? `${'▰'.repeat(done)}${'▱'.repeat(cells - done)} ${p.done}/${p.total}` : ''
  const title = truncateToWidth(p.title.trim() || 'plan', 40)
  const phase = p.phase.trim() ? ` [${p.phase.trim()}]` : ''
  const full = [seg('plan', 'Plan: ', 'magenta', { bold: true }), seg('plan', title, 'white'), seg('plan', phase, 'magenta'), ...(prog ? [seg('plan', ` ${prog}`, 'blue')] : [])]
  return { priority: 55, variants: [full, [seg('plan', 'Plan: ', 'magenta', { bold: true }), seg('plan', truncateToWidth(title, 16), 'white'), ...(prog ? [seg('plan', ` ${p.done}/${p.total}`, 'blue')] : [])]] }
}

const FLOW_PRIORITY = {
  line: { run: 90, title: 60, detail: 50, agents: 40, elapsed: 30 },
  folded: { run: 70, title: 45, detail: 34, agents: 26, elapsed: 15 },
} as const

const STEP_MARK = '\u25B8'
const AGENTS_MARK = '\u27F3'

function flowParts(bar: BarModel, mode: keyof typeof FLOW_PRIORITY): Part[] | undefined {
  const v = bar.flow
  const run = flowRow(v).map(s => ({ ...s, id: 'flow' }))
  if (v === undefined || run.length === 0) return undefined
  const p = FLOW_PRIORITY[mode]
  const compact = flowRow(v, { compact: true }).map(s => ({ ...s, id: 'flow' }))
  const parts: Part[] = [{ priority: p.run, variants: compact.length > 0 && flowRowText(compact) !== flowRowText(run) ? [run, compact] : [run] }]
  const title = v.title?.trim()
  if (title !== undefined && title !== '') {
    parts.push({ priority: p.title, variants: [[seg('flow', truncateToWidth(title, 40), 'white')], [seg('flow', truncateToWidth(title, 16), 'white')]] })
  }
  const waiting = (v.status === 'waiting' || v.status === 'paused') && v.note !== undefined
  const detail = waiting ? v.note : v.current ?? v.note
  if (detail !== undefined && detail.trim() !== '') {
    const color: Color | undefined = waiting ? 'yellow' : v.current !== undefined ? undefined : 'gray'
    const extra = color === 'gray' ? { dim: true } : {}
    parts.push({ priority: p.detail, variants: [[seg('flow', `${STEP_MARK} ${truncateToWidth(detail.trim(), 60)}`, color, extra)], [seg('flow', `${STEP_MARK} ${truncateToWidth(detail.trim(), 24)}`, color, extra)]] })
  }
  if (v.agents.length > 0) parts.push({ priority: p.agents, variants: [[seg('flow', `${AGENTS_MARK} ${truncateToWidth(v.agents.join(', '), 40)}`, 'cyan')]] })
  if (v.elapsedMin !== undefined) parts.push({ priority: p.elapsed, variants: [[seg('flow', flowElapsed(v.elapsedMin), 'gray', { dim: true })]] })
  return parts
}

function hooksPart(bar: BarModel): Part | undefined {
  const t = hooksSegmentTexts(bar.hooks)
  return t === undefined ? undefined : { priority: 95, variants: [[seg('hooks', t.long, t.color)], [seg('hooks', t.short, t.color)]] }
}

function memoryHost(url: string): string {
  return url.replace(/^https?:\/\//u, '').replace(/\/+$/u, '').replace(/^127\.0\.0\.1/u, 'localhost')
}

function footerParts(bar: BarModel, info: BarInfo, nowMs: number, emoji: boolean): Part[] {
  const out: Part[] = []
  if (info.product !== undefined) {
    out.push({ priority: 60, variants: [[seg('product', `${info.product.name} `, 'gray'), seg('product', info.product.version, 'white')], [seg('product', info.product.name, 'gray')]] })
  }
  if (info.harness !== undefined) {
    const h = info.harness
    const v: Segment[] = [seg('harness', h.label, 'gray')]
    if (h.version !== undefined) v.push(seg('harness', ` ${h.version}`, 'white'))
    if (h.plan !== undefined) v.push(seg('harness', ` (${h.plan})`, 'cyan'))
    out.push({ priority: 58, variants: [v, [seg('harness', h.label, 'gray'), ...(h.plan !== undefined ? [seg('harness', ` (${h.plan})`, 'cyan')] : [])]] })
  }
  const hooks = hooksPart(bar)
  if (hooks !== undefined) out.push(hooks)
  if (info.memoryUrl !== undefined) {
    const host = memoryHost(info.memoryUrl)
    out.push({ priority: 70, variants: [[seg('memui', 'Buracle Brain: ', 'gray'), seg('memui', host, 'gray', { link: info.memoryUrl })], [seg('memui', host, 'gray', { link: info.memoryUrl })]] })
  }
  if (bar.mem !== undefined) {
    try {
      const m = memSegmentWith(bar.mem, nowMs, 'compact', { emoji })
      const text = emoji ? m.text : stripEmoji(m.text)
      const segm = seg('mem', text, m.color ?? 'gray')
      out.push({ priority: 45, variants: [[segm]] })
    } catch {  }
  }
  const idx = bar.index !== undefined ? INDEX_STATUS_TEXT[bar.index] : undefined
  if (idx !== undefined) {
    const extra = idx.dim === true ? { dim: true } : {}
    out.push({ priority: 44, variants: [[seg('index', idx.long, idx.color, extra)], [seg('index', idx.short, idx.color, extra)]] })
  }
  const m = bar.month
  if (m !== undefined) {
    const approx = m.estimate ? '≈' : ''
    const text = m.pct !== undefined && Number.isFinite(m.pct) ? `mo ${formatPct(m.pct)}%` : m.usd !== undefined && Number.isFinite(m.usd) ? `mo ${approx}${formatUsd(m.usd)}` : m.tokens > 0 ? `mo ${formatTokens(m.tokens)} tok` : ''
    if (text !== '') out.push({ priority: 40, variants: [[seg('month', text, 'gray')]] })
  }
  if (bar.cost !== undefined && Number.isFinite(bar.cost.usd) && bar.cost.usd > 0) out.push({ priority: 42, variants: [[seg('cost', formatUsd(bar.cost.usd), 'gray')]] })
  if (bar.updates !== undefined && Number.isFinite(bar.updates) && bar.updates > 0) out.push({ priority: 20, variants: [[seg('upd', `⬆${Math.round(bar.updates)}`, 'magenta')]] })
  return out
}

function fitLine(parts: Part[], width: number, sepSeg: Segment): Segment[] {
  const state = parts.map((p, i) => ({ p, i, level: 0, alive: true }))
  const line = (): Segment[] => {
    const out: Segment[] = []
    for (const x of state) {
      if (!x.alive) continue
      if (out.length > 0) out.push(sepSeg)
      out.push(...(x.p.variants[x.level] as Segment[]))
    }
    return out
  }
  if (partWidth(line()) <= width) return line()
  const order = [...state].sort((a, b) => a.p.priority - b.p.priority || b.i - a.i)
  for (const x of order) {
    while (x.level < x.p.variants.length - 1 && partWidth(line()) > width) x.level++
    if (partWidth(line()) <= width) return line()
    if (state.filter(y => y.alive).length <= 1) break
    x.alive = false
    if (partWidth(line()) <= width) return line()
  }
  let left = width
  return line().map(s => {
    const t = truncateToWidth(s.text, Math.max(0, left))
    left -= textWidth(t)
    return { ...s, text: t }
  }).filter(s => s.text !== '')
}

function withoutEmoji(text: string): string {
  const lead = /^\s*/u.exec(text)?.[0] ?? ''
  const trail = /\s*$/u.exec(text)?.[0] ?? ''
  const core = stripEmoji(text)
  return core === '' ? '' : `${lead}${core}${trail}`
}

function clean(parts: Part[], emoji: boolean): Part[] {
  return parts.map(p => ({ ...p, variants: p.variants.map(v => v.map(s => ({ ...s, text: emoji ? sanitizeText(s.text) : withoutEmoji(sanitizeText(s.text)) }))) }))
}

function firstParts(bar: BarModel, info: BarInfo, layout: Pick<StatusLayout, 'thresholds'>, nowMs: number): Part[] {
  const first: Part[] = []
  const model = modelPart(bar)
  if (model !== undefined) first.push(model)
  first.push(ctxPart(bar, layout))
  const five = bar.windows.find(x => x.label === '5h')
  const seven = bar.windows.find(x => x.label === '7d')
  const others = bar.windows.filter(x => x.label !== '5h' && x.label !== '7d')
  for (const [win, prio] of [[five, 66], [seven, 64]] as const) {
    if (win === undefined) continue
    const p = windowPart(win, nowMs, prio)
    if (p !== undefined) first.push(p)
  }
  for (const win of others) {
    const p = windowPart(win, nowMs, 62)
    if (p !== undefined) first.push(p)
  }
  for (const p of [linesPart(info), dirPart(bar), gitPart(bar)]) if (p !== undefined) first.push(p)
  return first
}

export function barLines(bar: BarModel, info: BarInfo, layout: Pick<StatusLayout, 'thresholds' | 'emoji'>, width: number, nowMs: number): Segment[][] {
  const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : Number.POSITIVE_INFINITY
  const out: Segment[][] = [fitLine(clean(firstParts(bar, info, layout, nowMs), layout.emoji), w, PIPE)]
  const flow = flowParts(bar, 'line')
  const plan = flow === undefined ? planLine(bar) : undefined
  if (flow !== undefined) out.push(fitLine(clean(flow, layout.emoji), w, PIPE))
  else if (plan !== undefined) out.push(fitLine(clean([plan], layout.emoji), w, PIPE))
  const footer = footerParts(bar, info, nowMs, layout.emoji)
  if (footer.length > 0) out.push(fitLine(clean(footer, layout.emoji), w, DOT))
  return out.filter(l => l.length > 0)
}

export function barOneLine(bar: BarModel, info: BarInfo, layout: Pick<StatusLayout, 'thresholds' | 'emoji'>, width: number, nowMs: number): Segment[] {
  const lines = barLines(bar, { ...info, product: undefined, harness: undefined }, layout, Number.POSITIVE_INFINITY, nowMs)
  const flat: Segment[] = []
  for (const l of lines) {
    if (flat.length > 0) flat.push(PIPE)
    flat.push(...l)
  }
  if (partWidth(flat) <= width) return flat
  const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : Number.POSITIVE_INFINITY
  const flow = flowParts(bar, 'folded')
  const hooks = hooksPart(bar)
  const alarm = hooks !== undefined ? [hooks] : []
  if (flow !== undefined) return fitLine(clean([...firstParts(bar, info, layout, nowMs), ...alarm, ...flow], layout.emoji), w, PIPE)
  if (hooks !== undefined) return fitLine(clean([...firstParts(bar, info, layout, nowMs), hooks], layout.emoji), w, PIPE)
  return barLines(bar, { ...info, product: undefined, harness: undefined, memoryUrl: undefined }, layout, width, nowMs)[0] ?? []
}
