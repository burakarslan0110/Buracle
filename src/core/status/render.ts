import { memSegmentWith } from '../memory/status'
import type { BarModel, GitState, RateWindow, Segment, StatusLayout } from './model'
import { WINDOW_MINUTES, pace } from './model'
import { formatPct, formatResetIn, formatTokens, formatUsd, gauge, sanitizeText, stripEmoji, textWidth, truncateToWidth } from './format'
import { INDEX_STATUS_TEXT, flowRow, flowRowColor, flowRowText } from './live'
import { hooksSegmentTexts } from './hooks'

export const SEGMENT_SEPARATOR = ' │ '
const SEP_WIDTH = 3

export const SEGMENT_IDS = ['model', 'ctx', 'windows', 'month', 'cost', 'git', 'dir', 'mem', 'index', 'flow', 'plan', 'upd', 'hooks'] as const

const PRIORITY: Readonly<Record<string, number>> = {
  ctx: 100, hooks: 95, model: 90, '5h': 85, '7d': 80, window: 75, git: 70, cost: 65, flow: 62, month: 60, plan: 55, mem: 50, index: 35, dir: 30, upd: 20,
}

interface Candidate { id: string; priority: number; variants: Segment[] }

type Color = NonNullable<Segment['color']>

function seg(id: string, text: string, color?: Color, dim?: boolean): Segment {
  const s: Segment = { id, text }
  if (color !== undefined) s.color = color
  if (dim === true) s.dim = true
  return s
}

function cand(id: string, priority: number, ...variants: Segment[]): Candidate {
  return { id, priority, variants }
}

function pctColor(p: number, warn: number, crit: number): Color {
  return p >= crit ? 'red' : p >= warn ? 'yellow' : 'green'
}

function modelCandidate(bar: BarModel): Candidate | undefined {
  const model = bar.model?.trim()
  if (!model) return undefined
  const short = seg('model', model, 'cyan')
  const effort = bar.effort?.trim()
  return effort ? cand('model', PRIORITY['model'] ?? 0, seg('model', `${model} · ${effort}`, 'cyan'), short) : cand('model', PRIORITY['model'] ?? 0, short)
}

function ctxCandidate(bar: BarModel, layout: StatusLayout): Candidate | undefined {
  const c = bar.ctx
  if (c === undefined || !Number.isFinite(c.pct)) return undefined
  const color = pctColor(c.pct, layout.thresholds.ctxWarn, layout.thresholds.ctxCrit)
  const pct = `${formatPct(c.pct)}%`
  const counts = c.tokens !== undefined && c.window !== undefined && c.window > 0 ? ` (${formatTokens(c.tokens)}/${formatTokens(c.window)})` : ''
  return cand('ctx', PRIORITY['ctx'] ?? 0,
    seg('ctx', `ctx ${gauge(c.pct)} ${pct}${counts}`, color),
    seg('ctx', `ctx ${gauge(c.pct)} ${pct}`, color),
    seg('ctx', `ctx ${pct}`, color))
}

function windowMinutesOf(w: RateWindow): number | undefined {
  return w.windowMinutes ?? WINDOW_MINUTES[w.label]
}

function windowCandidate(w: RateWindow, nowMs: number): Candidate | undefined {
  if (!Number.isFinite(w.pct) || w.label.trim() === '') return undefined
  const minutes = windowMinutesOf(w)
  const p = minutes !== undefined ? pace(w.pct, w.resetsAt, minutes, nowMs) : 'even'
  const known = w.resetsAt !== undefined && minutes !== undefined && Number.isFinite(Date.parse(w.resetsAt))
  let color: Color
  if (w.pct >= 90) color = 'red'
  else if (known && p === 'over') color = 'red'
  else if (known && p === 'under') color = 'green'
  else color = w.pct >= 75 ? 'yellow' : 'green'
  const arrow = known && p === 'over' ? '⇡' : known && p === 'under' ? '⇣' : ''
  const resetMs = w.resetsAt !== undefined ? Date.parse(w.resetsAt) : Number.NaN
  const reset = Number.isFinite(resetMs) ? ` ↺${formatResetIn(resetMs, nowMs)}` : ''
  const head = `${w.label} ${formatPct(w.pct)}%`
  const priority = PRIORITY[w.label] ?? PRIORITY['window'] ?? 0
  return cand(w.label, priority,
    seg(w.label, `${head}${arrow ? ` ${arrow}` : ''}${reset}`, color),
    seg(w.label, `${head}${arrow}`, color))
}

function monthCandidate(bar: BarModel): Candidate | undefined {
  const m = bar.month
  if (m === undefined) return undefined
  const approx = m.estimate ? '≈' : ''
  const priority = PRIORITY['month'] ?? 0
  if (m.pct !== undefined && Number.isFinite(m.pct)) {
    const color: Color | undefined = m.pct >= 90 ? 'red' : m.pct >= 75 ? 'yellow' : undefined
    const head = `mo ${formatPct(m.pct)}%`
    return m.usd !== undefined && Number.isFinite(m.usd)
      ? cand('month', priority, seg('month', `${head} ${approx}${formatUsd(m.usd)}`, color), seg('month', head, color))
      : cand('month', priority, seg('month', head, color))
  }
  if (m.usd !== undefined && Number.isFinite(m.usd)) {
    const usd = `mo ${approx}${formatUsd(m.usd)}`
    return m.tokens > 0
      ? cand('month', priority, seg('month', `${usd} · ${formatTokens(m.tokens)} tok`), seg('month', usd))
      : cand('month', priority, seg('month', usd))
  }
  if (m.tokens > 0) return cand('month', priority, seg('month', `mo ${formatTokens(m.tokens)} tok`))
  return undefined
}

function costCandidate(bar: BarModel): Candidate | undefined {
  const c = bar.cost
  if (c === undefined || !Number.isFinite(c.usd)) return undefined
  return cand('cost', PRIORITY['cost'] ?? 0, seg('cost', formatUsd(c.usd)))
}

function gitCandidate(g: GitState | undefined): Candidate | undefined {
  if (g === undefined) return undefined
  const name = g.detached ? `@${g.branch ?? 'HEAD'}` : g.branch ?? '?'
  const ab = `${g.ahead > 0 ? ` ↑${g.ahead}` : ''}${g.behind > 0 ? ` ↓${g.behind}` : ''}`
  const dirty = g.staged + g.unstaged + g.untracked
  const color: Color = g.conflicts > 0 ? 'red' : dirty > 0 ? 'yellow' : 'green'
  const long = `⎇ ${name}${ab}`
    + (g.staged > 0 ? ` ●${g.staged}` : '')
    + (g.unstaged > 0 ? ` ✚${g.unstaged}` : '')
    + (g.untracked > 0 ? ` …${g.untracked}` : '')
    + (g.stash > 0 ? ` ⚑${g.stash}` : '')
    + (g.conflicts > 0 ? ` ⚠${g.conflicts}` : '')
    + (g.worktree ? ` [wt:${g.worktree}]` : '')
  const short = `⎇ ${truncateToWidth(name, 24)}${ab}${dirty > 0 ? ' *' : ''}${g.conflicts > 0 ? ` ⚠${g.conflicts}` : ''}`
  return cand('git', PRIORITY['git'] ?? 0, seg('git', long, color), seg('git', short, color))
}

function dirCandidate(bar: BarModel): Candidate | undefined {
  const d = bar.dir?.trim()
  if (!d) return undefined
  const parts = d.split('/').filter(x => x !== '')
  const last = parts[parts.length - 1] ?? d
  const variants = [seg('dir', d, 'gray')]
  if (last !== d) variants.push(seg('dir', last, 'gray'))
  return cand('dir', PRIORITY['dir'] ?? 0, ...variants)
}

function memVariant(bar: BarModel, nowMs: number, style: 'wide' | 'compact', emoji: boolean): Segment | undefined {
  const s = bar.mem
  if (s === undefined) return undefined
  try {
    const out = memSegmentWith(s, nowMs, style, { emoji })
    return { ...out, id: 'mem' }
  } catch {
    const color: Color = s.health === 'error' ? 'red' : s.health === 'warn' ? 'yellow' : 'green'
    const own = s.project !== undefined ? s.counts?.project ?? 0 : s.counts?.person ?? 0
    return seg('mem', `brain ${own}${(s.upkeep ?? 0) > 0 ? `·u${s.upkeep}` : ''} ${s.health === 'ok' ? '✓' : s.health === 'warn' ? '⚠' : '✗'}`, color)
  }
}

function memCandidate(bar: BarModel, nowMs: number, emoji: boolean): Candidate | undefined {
  const wide = memVariant(bar, nowMs, 'wide', emoji)
  const compact = memVariant(bar, nowMs, 'compact', emoji)
  const variants = [wide, compact].filter((x): x is Segment => x !== undefined)
  if (variants.length === 0) return undefined
  if (variants.length === 2 && variants[0]?.text === variants[1]?.text) variants.pop()
  return cand('mem', PRIORITY['mem'] ?? 0, ...variants)
}

function planCandidate(bar: BarModel): Candidate | undefined {
  const p = bar.plan
  if (p === undefined) return undefined
  const counts = p.total > 0 ? ` ${p.done}/${p.total}` : ''
  const title = truncateToWidth(p.title.trim() || 'plan', 28)
  const phase = p.phase.trim() ? ` [${p.phase.trim()}]` : ''
  return cand('plan', PRIORITY['plan'] ?? 0,
    seg('plan', `plan ${title}${phase}${counts}`, 'blue'),
    seg('plan', `plan${counts || ` ${truncateToWidth(title, 12)}`}`, 'blue'))
}

function flowCandidate(bar: BarModel): Candidate | undefined {
  const row = flowRow(bar.flow)
  if (row.length === 0) return undefined
  const text = flowRowText(row)
  const color = flowRowColor(row)
  const variants: Segment[] = []
  const title = bar.flow?.title?.trim()
  if (title !== undefined && title !== '') variants.push(seg('flow', `${text} · ${truncateToWidth(title, 28)}`, color))
  variants.push(seg('flow', text, color))
  const compact = flowRowText(flowRow(bar.flow, { compact: true }))
  if (compact !== '' && compact !== text) variants.push(seg('flow', compact, color))
  return cand('flow', PRIORITY['flow'] ?? 0, ...variants)
}

function indexCandidate(bar: BarModel): Candidate | undefined {
  const s = bar.index
  if (s === undefined) return undefined
  const t = INDEX_STATUS_TEXT[s]
  if (t === undefined) return undefined
  return cand('index', PRIORITY['index'] ?? 0, seg('index', t.long, t.color, t.dim), seg('index', t.short, t.color, t.dim))
}

function updCandidate(bar: BarModel): Candidate | undefined {
  const n = bar.updates
  if (n === undefined || !Number.isFinite(n) || n <= 0) return undefined
  return cand('upd', PRIORITY['upd'] ?? 0, seg('upd', `⬆${Math.round(n)}`, 'magenta'))
}

function hooksCandidate(bar: BarModel): Candidate | undefined {
  const t = hooksSegmentTexts(bar.hooks)
  if (t === undefined) return undefined
  return cand('hooks', PRIORITY['hooks'] ?? 0, seg('hooks', t.long, t.color), seg('hooks', t.short, t.color))
}

const FIXED = new Set<string>(SEGMENT_IDS)

interface LayoutFacts { explicitLabels: ReadonlySet<string>; flowShown: boolean }

function candidatesFor(id: string, bar: BarModel, layout: StatusLayout, nowMs: number, facts: LayoutFacts): Candidate[] {
  const one = (c: Candidate | undefined): Candidate[] => (c === undefined ? [] : [c])
  const explicitLabels = facts.explicitLabels
  switch (id) {
    case 'model': return one(modelCandidate(bar))
    case 'ctx': return one(ctxCandidate(bar, layout))
    case 'month': return one(monthCandidate(bar))
    case 'cost': return one(costCandidate(bar))
    case 'git': return one(gitCandidate(bar.git))
    case 'dir': return one(dirCandidate(bar))
    case 'mem': return one(memCandidate(bar, nowMs, layout.emoji))
    case 'index': return one(indexCandidate(bar))
    case 'flow': return one(flowCandidate(bar))
    case 'plan': return facts.flowShown ? [] : one(planCandidate(bar))
    case 'upd': return one(updCandidate(bar))
    case 'hooks': return one(hooksCandidate(bar))
    case 'windows':
      return bar.windows.filter(w => !explicitLabels.has(w.label)).flatMap(w => one(windowCandidate(w, nowMs)))
    default: {
      const w = bar.windows.find(x => x.label === id)
      return w === undefined ? [] : one(windowCandidate(w, nowMs))
    }
  }
}

function cleanVariants(c: Candidate, emoji: boolean): Candidate | undefined {
  const variants: Segment[] = []
  for (const v of c.variants) {
    let text = sanitizeText(v.text)
    if (!emoji) text = stripEmoji(text)
    text = text.trim()
    if (text === '' || variants.some(x => x.text === text)) continue
    variants.push({ ...v, text })
  }
  return variants.length === 0 ? undefined : { ...c, variants }
}

function rowWidth(segs: readonly Segment[]): number {
  return segs.reduce((n, s) => n + textWidth(s.text), 0) + SEP_WIDTH * Math.max(0, segs.length - 1)
}

function fitRow(cands: Candidate[], width: number): Segment[] {
  const state = cands.map((c, i) => ({ c, i, level: 0, alive: true }))
  const current = (): Segment[] => state.filter(x => x.alive).map(x => x.c.variants[x.level] as Segment)
  if (rowWidth(current()) <= width) return current()
  const order = [...state].sort((a, b) => a.c.priority - b.c.priority || b.i - a.i)
  for (const x of order) {
    while (x.level < x.c.variants.length - 1 && rowWidth(current()) > width) x.level++
    if (rowWidth(current()) <= width) return current()
  }
  for (const x of order) {
    if (state.filter(y => y.alive).length <= 1) break
    x.alive = false
    if (rowWidth(current()) <= width) return current()
  }
  return current().map(s => (textWidth(s.text) > width ? { ...s, text: truncateToWidth(s.text, width) } : s))
}

export function rows(bar: BarModel, layout: StatusLayout, width: number, nowMs: number): Segment[][] {
  const w = Number.isFinite(width) && width > 0 ? Math.floor(width) : Number.POSITIVE_INFINITY
  const explicitLabels = new Set<string>()
  for (const r of layout.rows) for (const id of r) if (!FIXED.has(id)) explicitLabels.add(id)
  const facts: LayoutFacts = { explicitLabels, flowShown: layout.rows.some(r => r.includes('flow')) && flowRow(bar.flow).length > 0 }
  const out: Segment[][] = []
  for (const ids of layout.rows) {
    const cands: Candidate[] = []
    for (const id of ids) {
      for (const c of candidatesFor(id, bar, layout, nowMs, facts)) {
        const clean = cleanVariants(c, layout.emoji)
        if (clean !== undefined) cands.push(clean)
      }
    }
    if (cands.length === 0) continue
    const fitted = fitRow(cands, w)
    if (fitted.length > 0) out.push(fitted)
  }
  return out
}

const ANSI_COLOR: Readonly<Record<Color, string>> = { green: '32', yellow: '33', red: '31', blue: '34', magenta: '35', cyan: '36', gray: '90', white: '97' }
const ESC = '\u001b'

function safeLink(url: string | undefined): string | undefined {
  if (url === undefined || !/^(https?|file|obsidian):\/\/[^\s\u0000-\u001f\u007f]+$/u.test(url)) return undefined
  return url
}

export function ansiSegment(s: Segment): string {
  const codes: string[] = []
  if (s.bold) codes.push('1')
  if (s.dim) codes.push('2')
  if (s.color !== undefined) codes.push(ANSI_COLOR[s.color])
  const text = sanitizeText(s.text)
  const styled = codes.length === 0 ? text : `${ESC}[${codes.join(';')}m${text}${ESC}[0m`
  const link = safeLink(s.link)
  return link === undefined ? styled : `${ESC}]8;;${link}${ESC}\\${styled}${ESC}]8;;${ESC}\\`
}

export function renderAnsi(rows: Segment[][]): string {
  const sep = `${ESC}[2m${SEGMENT_SEPARATOR}${ESC}[0m`
  return rows.map(r => r.map(ansiSegment).join(sep)).join('\n')
}

export function renderAnsiLines(lines: Segment[][]): string {
  return lines.map(l => l.map(ansiSegment).join('')).join('\n')
}

export function renderPlainLines(lines: Segment[][]): string {
  return lines.map(l => l.map(s => sanitizeText(s.text)).join('')).join('\n')
}

export function renderPlain(rows: Segment[][]): string {
  return rows.map(r => r.map(s => sanitizeText(s.text)).join(SEGMENT_SEPARATOR)).join('\n')
}

const TMUX_COLOR: Readonly<Record<Color, string>> = { green: 'green', yellow: 'yellow', red: 'red', blue: 'blue', magenta: 'magenta', cyan: 'cyan', gray: 'colour244', white: 'brightwhite' }

function tmuxSegment(s: Segment): string {
  const text = sanitizeText(s.text).replace(/#/gu, '##')
  const style: string[] = []
  if (s.color !== undefined) style.push(`fg=${TMUX_COLOR[s.color]}`)
  if (s.dim) style.push('dim')
  if (s.bold) style.push('bold')
  return style.length === 0 ? text : `#[${style.join(',')}]${text}#[default]`
}

export function renderTmuxLines(lines: Segment[][]): string {
  return lines.filter(l => l.length > 0).map(l => l.map(tmuxSegment).join('')).join('#[fg=colour244] · #[default]')
}

export function renderTmux(rows: Segment[][]): string {
  const sep = `#[fg=colour244]${SEGMENT_SEPARATOR}#[default]`
  return rows.filter(r => r.length > 0).map(r => r.map(tmuxSegment).join(sep)).join(sep)
}
