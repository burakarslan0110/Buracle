import { sanitizeText, textWidth, truncateToWidth } from '../../core/status/format'
import type { Key } from './keys'
import type { Style } from './style'
import { padEnd, stripAnsi, visibleWidth, wordmark } from './style'

export type RowState = 'ok' | 'warn' | 'err' | 'off'
export type SectionId = 'buracle' | 'harnesses' | 'mcp' | 'tools' | 'lsp' | 'memory'

export const SECTION_TITLES: Readonly<Record<SectionId, string>> = {
  buracle: 'Buracle',
  harnesses: 'Harnesses',
  mcp: 'MCP servers',
  tools: 'Tools',
  lsp: 'Language servers',
  memory: 'Memory',
}

const SECTION_ORDER: readonly SectionId[] = ['buracle', 'harnesses', 'mcp', 'tools', 'lsp', 'memory']

export interface DashRow {
  id: string
  section: SectionId
  label: string
  version?: string
  state: RowState
  status: string
  update?: string // the version an update moves to
  source?: string
  detail?: string
  action?: { argv: string[]; label: string }
}

export interface DashView {
  version: string
  columns: number
  rows: number
  items: DashRow[]
  selected: number // an index into items; headings are not selectable
  scroll: number // the first visible item
  help: boolean
  message?: string
  summary: { updates: number; problems: number; checkedAt?: string; working?: string } // working: what is being verified right now
}

export type DashAction = { kind: 'run'; argv: string[] } | { kind: 'reload' } | { kind: 'back' } | { kind: 'quit' }

const MARGIN = '  '
const GAP = '  '
const GAP_WIDTH = GAP.length
// The margin, the pointer and the space after it.
const ROW_INDENT = MARGIN.length + 2
// The title, the line under it, the line above the detail, the detail and the key hints.
const CHROME_LINES = 5

interface Widths { label: number; version: number; status: number; update: number; source: number }

const MAX_WIDTH = { label: 24, version: 12, status: 30, update: 16 } as const
const SOURCE_MIN = 12
// A row that is too wide gives up width in this order, each column down to the floor named.
const SHRINK: ReadonlyArray<readonly [keyof Widths, number]> = [
  ['label', 14], ['status', 14], ['label', 10], ['status', 10], ['update', 8], ['version', 6], ['label', 6], ['status', 6],
]
// The source column stays only when this much makes room for it.
const SHRINK_FOR_SOURCE: ReadonlyArray<readonly [keyof Widths, number]> = [['label', 14], ['source', SOURCE_MIN]]

const SHORTCUTS: ReadonlyMap<string, readonly string[]> = new Map<string, readonly string[]>([
  ['u', ['update']], ['c', ['update', '--check']], ['i', ['install']], ['d', ['doctor']], ['m', ['mem', 'ui', '--open']],
])

const HELP: ReadonlyArray<readonly [string, string]> = [
  ['↑ ↓ or k j', 'move'],
  ['PgUp PgDn, Home End, g G', 'jump'],
  ['n N', 'next, previous row that needs a look'],
  ['enter', 'run the action of the selected row'],
  ['u', 'update everything'],
  ['c', 'check for updates'],
  ['i', 'install or repair'],
  ['d', 'health check'],
  ['m', 'open the memory web UI'],
  ['r', 'recheck everything now'],
  ['esc', 'back to the main menu'],
  ['?', 'close this help'],
  ['q', 'quit'],
]

interface Hint { key: string; word: string; drop?: number } // drop: the order in which hints go when the line is too narrow

const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/gu

// Every value that comes from outside goes through here before it reaches the screen.
export function clean(s: string | undefined): string {
  return s === undefined ? '' : sanitizeText(s).replace(BIDI_CONTROLS, '').trim()
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi)
const listHeight = (rows: number): number => Math.max(1, rows - CHROME_LINES)

type ListLine = { kind: 'gap' } | { kind: 'heading'; section: SectionId } | { kind: 'item'; index: number }

interface ListLayout {
  lines: ListLine[]
  itemLine: number[] // the line of each item
  top: number[] // the first line shown when the item is the first visible one: its heading when it opens a section
}

function layoutList(items: readonly DashRow[]): ListLayout {
  const lines: ListLine[] = []
  const itemLine: number[] = []
  const top: number[] = []
  let section: SectionId | undefined
  items.forEach((item, index) => {
    if (item.section !== section) {
      if (section !== undefined) lines.push({ kind: 'gap' })
      section = item.section
      lines.push({ kind: 'heading', section })
      top.push(lines.length - 1)
    } else top.push(lines.length)
    itemLine.push(lines.length)
    lines.push({ kind: 'item', index })
  })
  return { lines, itemLine, top }
}

// The first visible item that keeps the selected one in view and leaves no needless empty space below.
function fitScroll(layout: ListLayout, height: number, selected: number, scroll: number): number {
  if (layout.itemLine.length === 0) return 0
  const line = (i: number) => layout.itemLine[i] ?? 0
  const top = (i: number) => layout.top[i] ?? 0
  let s = clamp(scroll, 0, selected)
  while (s < selected && line(selected) - top(s) >= height) s++
  while (s > 0 && layout.lines.length - top(s - 1) <= height) s--
  return s
}

function visibleLines(layout: ListLayout, height: number, selected: number, scroll: number): { start: number; end: number } {
  const line = layout.itemLine[selected] ?? 0
  let start = layout.top[scroll] ?? 0
  if (line >= start + height) start = line - height + 1
  let end = Math.min(layout.lines.length, start + height)
  while (end > start && layout.lines[end - 1]?.kind !== 'item') end-- // no heading without its rows at the bottom
  return { start, end }
}

function symbolOf(st: Style, state: RowState): string {
  switch (state) {
    case 'ok': return st.sym.ok
    case 'warn': return st.sym.warn
    case 'err': return st.sym.err
    case 'off': return st.sym.dot
  }
}

function paint(st: Style, state: RowState, s: string): string {
  switch (state) {
    case 'ok': return st.ok(s)
    case 'warn': return st.warn(s)
    case 'err': return st.err(s)
    case 'off': return st.muted(s)
  }
}

interface Cells { label: string; version: string; status: string; update: string; source: string }

// With `fold` there is no update column: a row with an update shows it in place of its status.
function cellsOf(st: Style, row: DashRow, fold: boolean): Cells {
  const update = clean(row.update)
  const updateText = update === '' ? '' : `${st.sym.arrow} ${update}`
  return {
    label: clean(row.label),
    version: clean(row.version),
    status: fold && updateText !== '' ? updateText : clean(row.status),
    update: fold ? '' : updateText,
    source: clean(row.source),
  }
}

function rowWidth(w: Widths): number {
  const extra = (n: number) => (n > 0 ? GAP_WIDTH + n : 0)
  return ROW_INDENT + w.label + extra(w.version) + GAP_WIDTH + w.status + extra(w.update) + extra(w.source)
}

function shrink(w: Widths, width: number, steps: ReadonlyArray<readonly [keyof Widths, number]>): Widths {
  const out = { ...w }
  for (const [col, floor] of steps) {
    const over = rowWidth(out) - width
    if (over <= 0) break
    out[col] = Math.max(Math.min(out[col], floor), out[col] - over)
  }
  return out
}

// Below 60 columns there is no version column, below 50 no source; the rest share what is left.
function columnWidths(cells: readonly Cells[], width: number, columns: number): Widths {
  const widest = (pick: (c: Cells) => string) => cells.reduce((m, c) => Math.max(m, textWidth(pick(c))), 0)
  const natural: Widths = {
    label: Math.min(MAX_WIDTH.label, widest(c => c.label)),
    version: columns >= 60 ? Math.min(MAX_WIDTH.version, widest(c => c.version)) : 0,
    status: Math.min(MAX_WIDTH.status, 2 + widest(c => c.status)),
    update: Math.min(MAX_WIDTH.update, widest(c => c.update)),
    source: 0,
  }
  const source = columns >= 50 ? widest(c => c.source) : 0
  if (source > 0) {
    const withSource = shrink({ ...natural, source }, width, SHRINK_FOR_SOURCE)
    if (rowWidth(withSource) <= width) return withSource
  }
  return shrink(natural, width, SHRINK)
}

function statusCell(st: Style, state: RowState, text: string, width: number): string {
  const symbol = symbolOf(st, state)
  const shown = truncateToWidth(text, width - textWidth(symbol) - 1)
  const icon = paint(st, state, symbol)
  return shown === '' ? icon : `${icon} ${state === 'ok' ? shown : paint(st, state, shown)}`
}

function rowLine(st: Style, row: DashRow, c: Cells, w: Widths, selected: boolean): string {
  const label = truncateToWidth(c.label, w.label)
  const parts = [`${MARGIN}${selected ? st.accent(st.sym.pointer) : ' '} ${padEnd(selected ? st.bold(label) : label, w.label)}`]
  if (w.version > 0) parts.push(padEnd(st.muted(truncateToWidth(c.version, w.version)), w.version))
  parts.push(padEnd(statusCell(st, row.state, c.status, w.status), w.status))
  if (w.update > 0) parts.push(padEnd(st.accent(truncateToWidth(c.update, w.update)), w.update))
  if (w.source > 0) parts.push(st.muted(truncateToWidth(c.source, w.source)))
  return parts.join(GAP).trimEnd()
}

function titleLine(st: Style, view: DashView, width: number): string {
  const head = `${MARGIN}${st.level === 0 ? st.bold('buracle') : wordmark(st)}`
  const version = truncateToWidth(clean(view.version), width - visibleWidth(head) - 1)
  const left = version === '' ? head : `${head} ${st.muted(version)}`
  const { updates, problems } = view.summary
  const count = (n: number, noun: string, color: (s: string) => string) => {
    const text = `${n} ${noun}${n === 1 ? '' : 's'}`
    return n > 0 ? color(text) : st.muted(text)
  }
  const counts = updates === 0 && problems === 0 ? [st.ok('all good')] : [count(updates, 'update', st.accent), count(problems, 'problem', st.warn)]
  const checked = clean(view.summary.checkedAt)
  const working = clean(view.summary.working)
  const tail = working !== '' ? st.accent(working) : checked !== '' ? st.muted(`checked ${checked}`) : ''
  for (const parts of tail === '' ? [counts] : [[...counts, tail], counts]) {
    const right = parts.join(st.muted(' · '))
    const pad = width - visibleWidth(left) - visibleWidth(right)
    if (pad >= 2) return `${left}${' '.repeat(pad)}${right}`
  }
  return left
}

function hintLine(st: Style, row: DashRow | undefined, width: number): string {
  const action = clean(row?.action?.label)
  const all: Hint[] = [
    { key: '↑↓', word: 'move', drop: 6 },
    { key: 'enter', word: action === '' ? 'check this' : action },
    { key: 'u', word: 'update', drop: 5 },
    { key: 'c', word: 'check', drop: 4 },
    { key: 'i', word: 'install', drop: 3 },
    { key: 'd', word: 'doctor', drop: 2 },
    { key: 'm', word: 'memory', drop: 1 },
    { key: 'r', word: 'recheck', drop: 1 },
    { key: 'esc', word: 'menu', drop: 7 },
    { key: '?', word: 'keys' },
    { key: 'q', word: 'quit' },
  ]
  const sep = ' · '
  const widthOf = (hints: readonly Hint[]) =>
    MARGIN.length + hints.reduce((n, h) => n + textWidth(h.key) + 1 + textWidth(h.word), 0) + sep.length * Math.max(0, hints.length - 1)
  let hints = all
  for (let order = 1; order <= 7 && widthOf(hints) > width; order++) hints = hints.filter(h => h.drop !== order)
  const over = widthOf(hints) - width
  if (over > 0) hints = hints.map(h => (h.key === 'enter' ? { ...h, word: truncateToWidth(h.word, textWidth(h.word) - over) } : h))
  return MARGIN + hints.map(h => (h.word === '' ? h.key : `${h.key} ${st.muted(h.word)}`)).join(st.muted(sep))
}

function detailLine(st: Style, view: DashView, row: DashRow | undefined, width: number): string {
  const room = width - MARGIN.length
  if (view.help) return `${MARGIN}${st.muted(truncateToWidth('Esc or any key closes this help · q quits', room))}`
  const message = clean(view.message)
  if (message !== '') return `${MARGIN}${truncateToWidth(message, room)}`
  if (row === undefined) return ''
  const detail = clean(row.detail)
  const text = detail !== '' ? detail : [clean(row.source), clean(row.status)].filter(s => s !== '').join(' · ')
  return text === '' ? '' : `${MARGIN}${st.muted(truncateToWidth(text, room))}`
}

function helpLines(st: Style, width: number): string[] {
  const keyWidth = Math.max(...HELP.map(([k]) => textWidth(k)))
  const descWidth = Math.max(...HELP.map(([, d]) => textWidth(d)))
  const aligned = MARGIN.length + keyWidth + 2 + descWidth <= width
  return [`${MARGIN}${st.bold('Keys')}`, ...HELP.map(([k, d]) => {
    const key = aligned ? padEnd(k, keyWidth) : k
    const room = width - MARGIN.length - textWidth(key) - 2
    return room > 0 ? `${MARGIN}${key}  ${st.muted(truncateToWidth(d, room))}` : `${MARGIN}${k}`
  })]
}

// Lines are built to fit; this only guards the corner cases (a terminal narrower than the fixed parts).
export function fitLine(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(stripAnsi(line), width)
}

export function renderDashboard(st: Style, view: DashView): string[] {
  // The last column stays empty: an erase to the end of the line right after a full line clears its last character on many terminals.
  const width = Math.max(0, view.columns - 1)
  const height = listHeight(view.rows)
  const selected = clamp(view.selected, 0, Math.max(0, view.items.length - 1))
  const row = view.items[selected]
  let above = ''
  let below = ''
  const area: string[] = []
  if (view.help) area.push(...helpLines(st, width).slice(0, height))
  else {
    const layout = layoutList(view.items)
    const cells = view.items.map(r => cellsOf(st, r, view.columns < 50))
    const widths = columnWidths(cells, width, view.columns)
    const { start, end } = visibleLines(layout, height, selected, fitScroll(layout, height, selected, view.scroll))
    for (const line of layout.lines.slice(start, end)) {
      if (line.kind === 'gap') area.push('')
      else if (line.kind === 'heading') area.push(`${MARGIN}${st.bold(SECTION_TITLES[line.section])}`)
      else {
        const item = view.items[line.index]
        const c = cells[line.index]
        area.push(item !== undefined && c !== undefined ? rowLine(st, item, c, widths, line.index === selected) : '')
      }
    }
    const hiddenAbove = layout.itemLine.filter(l => l < start).length
    const hiddenBelow = layout.itemLine.filter(l => l >= end).length
    if (hiddenAbove > 0) above = `${MARGIN}${st.muted(`${hiddenAbove} more above`)}`
    if (hiddenBelow > 0) below = `${MARGIN}${st.muted(`${hiddenBelow} more below`)}`
  }
  while (area.length < height) area.push('')
  const hint = fitLine(hintLine(st, row, width), width)
  const lines = [titleLine(st, view, width), above, ...area, below, detailLine(st, view, row, width)].map(l => fitLine(l, width))
  lines.push(hint)
  if (lines.length <= view.rows) return lines
  return view.rows <= 0 ? [] : [...lines.slice(0, view.rows - 1), hint]
}

export function dashboardStep(view: DashView, key: Key): { view: DashView; action?: DashAction } {
  const count = view.items.length
  const height = listHeight(view.rows)
  const layout = layoutList(view.items)
  const at = (selected: number): DashView => {
    const s = clamp(selected, 0, Math.max(0, count - 1))
    const next: DashView = { ...view, selected: s, scroll: fitScroll(layout, height, s, view.scroll) }
    delete next.message
    return next
  }
  const current = at(view.selected)
  const char = typeof key === 'object' ? key.char : undefined
  if (key === 'ctrl-c' || char === 'q') return { view: current, action: { kind: 'quit' } }
  if (view.help) return { view: { ...current, help: false } }
  if (key === 'escape' || key === 'backspace') return { view: current, action: { kind: 'back' } }
  if (char === '?') return { view: { ...current, help: true } }
  if (key === 'up' || char === 'k') return { view: at(current.selected - 1) }
  if (key === 'down' || char === 'j') return { view: at(current.selected + 1) }
  if (key === 'pageup') return { view: at(current.selected - height) }
  if (key === 'pagedown') return { view: at(current.selected + height) }
  if (key === 'home' || char === 'g') return { view: at(0) }
  if (key === 'end' || char === 'G') return { view: at(count - 1) }
  if (char === 'n' || char === 'N') {
    for (let step = 1; step <= count; step++) {
      const i = (((current.selected + (char === 'n' ? step : -step)) % count) + count) % count
      const state = view.items[i]?.state
      if (state === 'err' || state === 'warn') return { view: at(i) }
    }
    return { view: { ...current, message: 'nothing needs a look' } }
  }
  if (key === 'enter') {
    const action = view.items[current.selected]?.action
    return action === undefined ? { view: current } : { view: current, action: { kind: 'run', argv: [...action.argv] } }
  }
  if (char === 'r') return { view: current, action: { kind: 'reload' } }
  const argv = char === undefined ? undefined : SHORTCUTS.get(char)
  return argv === undefined ? { view: current } : { view: current, action: { kind: 'run', argv: [...argv] } }
}

function summarize(items: readonly DashRow[]): DashView['summary'] {
  const hasUpdate = (r: DashRow) => clean(r.update) !== ''
  return {
    updates: items.filter(hasUpdate).length,
    problems: items.filter(r => r.state === 'err' || (r.state === 'warn' && !hasUpdate(r))).length,
  }
}

export function initialView(version: string, items: DashRow[], size: { columns: number; rows: number }): DashView {
  const rank = (r: DashRow) => SECTION_ORDER.indexOf(r.section)
  const sorted = [...items].sort((a, b) => rank(a) - rank(b))
  return { version, columns: size.columns, rows: size.rows, items: sorted, selected: 0, scroll: 0, help: false, summary: summarize(sorted) }
}
