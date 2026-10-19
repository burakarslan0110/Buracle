import { textWidth, truncateToWidth } from '../../core/status/format'
import { clean, fitLine, type DashView } from './dashboard'
import type { Key } from './keys'
import type { Style } from './style'
import { banner, padEnd, TAGLINE, visibleWidth, wordmark } from './style'

export type MenuAction = { kind: 'run'; argv: string[] } | { kind: 'detail' } | { kind: 'quit' }

export interface MenuItem { id: string; label: string; does: string; key: string; action: MenuAction }

// The keys are the detailed view's own letters, so a key does the same thing on both screens.
export const MENU: readonly MenuItem[] = [
  { id: 'install', label: 'Install or repair', does: 'set Buracle up in your coding agents, or repair it', key: 'i', action: { kind: 'run', argv: ['install'] } },
  { id: 'update', label: 'Update', does: 'look for new versions and apply them, step by step', key: 'u', action: { kind: 'run', argv: ['update'] } },
  { id: 'doctor', label: 'Health check', does: 'check every part and see how to fix what is broken', key: 'd', action: { kind: 'run', argv: ['doctor'] } },
  { id: 'memory', label: 'Memory', does: 'open the memory web UI in your browser', key: 'm', action: { kind: 'run', argv: ['mem', 'ui', '--open'] } },
  { id: 'detail', label: 'Detailed view', does: 'every part with its version, state and waiting update', key: 'v', action: { kind: 'detail' } },
  { id: 'quit', label: 'Quit', does: '', key: 'q', action: { kind: 'quit' } },
]

export interface MenuView {
  version: string
  columns: number
  rows: number
  selected: number
  message?: string
  summary: DashView['summary']
}

const MARGIN = '  '
const GAP = '  '
// The margin, the pointer and the space after it.
const ROW_INDENT = MARGIN.length + 2
const LABEL_WIDTH = Math.max(...MENU.map(i => textWidth(i.label)))
const DOES_WIDTH = Math.max(...MENU.map(i => textWidth(i.does)))

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi)
const copy = (a: MenuAction): MenuAction => (a.kind === 'run' ? { kind: 'run', argv: [...a.argv] } : { ...a })

function titleLine(st: Style, version: string, width: number): string {
  const head = `${MARGIN}${st.level === 0 ? st.bold('buracle') : wordmark(st)}${version === '' ? '' : ` ${st.muted(version)}`}`
  const full = `${head}${st.muted(` · ${TAGLINE}`)}`
  return visibleWidth(full) <= width ? full : head
}

function statusLine(st: Style, summary: DashView['summary'], width: number): string {
  const { updates, problems } = summary
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const main = updates === 0 && problems === 0
    ? `${st.ok(st.sym.ok)} All good`
    : [
        problems > 0 ? st.warn(st.sym.warn) : st.accent(st.sym.info),
        [...(updates > 0 ? [st.accent(count(updates, 'update waiting', 'updates waiting'))] : []), ...(problems > 0 ? [st.warn(count(problems, 'problem', 'problems'))] : [])].join(st.muted(' · ')),
      ].join(' ')
  const checked = clean(summary.checkedAt)
  const when = st.muted(` · ${checked === '' ? 'no update check yet' : `updates checked ${checked}`}`)
  const line = `${MARGIN}${main}`
  return visibleWidth(line + when) <= width ? line + when : line
}

// Every description beside its label, or none: when they do not all fit, the selected one goes below the list.
const descriptionsFit = (width: number): boolean => ROW_INDENT + LABEL_WIDTH + GAP.length + DOES_WIDTH <= width

function itemLines(st: Style, selected: number, width: number): string[] {
  const inline = descriptionsFit(width)
  return MENU.map((item, i) => {
    const on = i === selected
    const head = `${MARGIN}${on ? st.accent(st.sym.pointer) : ' '} ${padEnd(on ? st.bold(item.label) : item.label, LABEL_WIDTH)}`
    return `${head}${inline && item.does !== '' ? `${GAP}${st.muted(item.does)}` : ''}`.trimEnd()
  })
}

function hintLine(st: Style, width: number): string {
  const all = [['↑↓', 'move'], ['enter', 'choose'], ['q', 'quit']] as const
  const sep = ' · '
  const show = (hints: ReadonlyArray<readonly [string, string]>) => MARGIN + hints.map(([k, w]) => `${k} ${st.muted(w)}`).join(st.muted(sep))
  const full = show(all)
  return visibleWidth(full) <= width ? full : show(all.slice(1))
}

export function renderMenu(st: Style, view: MenuView): string[] {
  if (view.rows <= 0) return []
  // The last column stays empty, as on the detailed view.
  const width = Math.max(0, view.columns - 1)
  const selected = clamp(view.selected, 0, MENU.length - 1)
  const version = clean(view.version)
  // banner() gives the wordmark or the icon when they fit, else one line; one line here is the title.
  const logo = st.level === 0 ? [] : banner(st, { version, columns: width }).split('\n')
  const title = titleLine(st, version, width)
  const status = statusLine(st, view.summary, width)
  const items = itemLines(st, selected, width)
  const message = clean(view.message)
  const does = descriptionsFit(width) ? '' : MENU[selected]?.does ?? ''
  const note = message !== '' ? `${MARGIN}${truncateToWidth(message, width - MARGIN.length)}`
    : does !== '' ? `${MARGIN}${st.muted(truncateToWidth(does, width - MARGIN.length))}` : ''
  // The roomiest layout that fits the height wins: the logo goes first, then the empty lines, then the status.
  const layouts: string[][] = [
    ...(logo.length > 1 ? [['', ...logo, '', status, '', ...items, '', note], [...logo, '', status, '', ...items, note]] : []),
    ['', title, '', status, '', ...items, '', note],
    [title, '', status, '', ...items, note],
    [title, status, ...items, note],
    [title, ...items],
  ]
  const room = view.rows - 1
  const start = clamp(selected - room + 1, 0, Math.max(0, items.length - room))
  const body = layouts.find(l => l.length <= room) ?? items.slice(start, start + Math.max(0, room))
  while (body.length < room) body.push('')
  return [...body, hintLine(st, width)].map(l => fitLine(l, width))
}

export function menuStep(view: MenuView, key: Key): { view: MenuView; action?: MenuAction } {
  const at = (selected: number): MenuView => {
    const next: MenuView = { ...view, selected: clamp(selected, 0, MENU.length - 1) }
    delete next.message
    return next
  }
  const current = at(view.selected)
  const char = typeof key === 'object' ? key.char : undefined
  if (key === 'ctrl-c' || key === 'escape' || char === 'q') return { view: current, action: { kind: 'quit' } }
  if (key === 'up' || char === 'k') return { view: at(current.selected - 1) }
  if (key === 'down' || char === 'j') return { view: at(current.selected + 1) }
  if (key === 'home' || key === 'pageup' || char === 'g') return { view: at(0) }
  if (key === 'end' || key === 'pagedown' || char === 'G') return { view: at(MENU.length - 1) }
  const index = key === 'enter' ? current.selected : MENU.findIndex(i => i.key === char)
  const item = MENU[index]
  return item === undefined ? { view: current } : { view: at(index), action: copy(item.action) }
}

export function initialMenu(version: string, summary: DashView['summary'], size: { columns: number; rows: number }): MenuView {
  return { version, columns: size.columns, rows: size.rows, selected: 0, summary }
}
