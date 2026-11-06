import { textWidth, truncateToWidth } from '../../core/status/format'
import { clean, fitLine, footerLine, headerLines, MARGIN, type Hint, type Summary } from './frame'
import type { Key } from './keys'
import type { Style } from './style'
import { padEnd } from './style'

export type MenuAction = { kind: 'run'; argv: string[] } | { kind: 'detail' } | { kind: 'quit' }

export interface MenuItem { id: string; label: string; does: string; key: string; action: MenuAction }

// The keys are the detailed view's own letters, so a key does the same thing on both screens.
export const MENU: readonly MenuItem[] = [
  { id: 'install', label: 'Install or repair', does: 'set Buracle up in your coding agents, or repair it', key: 'i', action: { kind: 'run', argv: ['install'] } },
  { id: 'update', label: 'Update', does: 'look for new versions and apply them, step by step', key: 'u', action: { kind: 'run', argv: ['update'] } },
  { id: 'doctor', label: 'Health check', does: 'check every part and see how to fix what is broken', key: 'd', action: { kind: 'run', argv: ['doctor'] } },
  { id: 'memory', label: 'Memory', does: 'open the Buracle Console in your browser', key: 'm', action: { kind: 'run', argv: ['mem', 'ui', '--open'] } },
  { id: 'detail', label: 'Detailed view', does: 'every part with its version, state and waiting update', key: 'v', action: { kind: 'detail' } },
  { id: 'quit', label: 'Quit', does: '', key: 'q', action: { kind: 'quit' } },
]

export interface MenuView {
  version: string
  columns: number
  rows: number
  selected: number
  message?: string
  summary: Summary
}

const GAP = '  '
// The margin, the pointer and the space after it.
const ROW_INDENT = MARGIN.length + 2
const LABEL_WIDTH = Math.max(...MENU.map(i => textWidth(i.label)))
const DOES_WIDTH = Math.max(...MENU.map(i => textWidth(i.does)))

const clamp = (n: number, lo: number, hi: number): number => Math.min(Math.max(n, lo), hi)
const copy = (a: MenuAction): MenuAction => (a.kind === 'run' ? { kind: 'run', argv: [...a.argv] } : { ...a })

const HINTS: readonly Hint[] = [{ key: '↑↓', word: 'move', drop: 1 }, { key: 'enter', word: 'choose' }, { key: 'q', word: 'quit' }]

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

export function renderMenu(st: Style, view: MenuView): string[] {
  if (view.rows <= 0) return []
  // The last column stays empty, as on the detailed view.
  const width = Math.max(0, view.columns - 1)
  const selected = clamp(view.selected, 0, MENU.length - 1)
  const header = headerLines(st, view)
  const items = itemLines(st, selected, width)
  const message = clean(view.message)
  const does = descriptionsFit(width) ? '' : MENU[selected]?.does ?? ''
  const note = message !== '' ? `${MARGIN}${truncateToWidth(message, width - MARGIN.length)}`
    : does !== '' ? `${MARGIN}${st.muted(truncateToWidth(does, width - MARGIN.length))}` : ''
  // The header never goes (from 40 by 10 it always fits); under it the roomiest list layout that fits wins.
  const room = view.rows - 1
  const start = clamp(selected - room + 1, 0, Math.max(0, items.length - room))
  const layouts: string[][] = [[...items, '', note], [...items, note], items].map(body => [...header, ...body])
  // Below the size the menu opens at (after a resize), the list alone keeps the selected choice in view.
  const lines = layouts.find(l => l.length <= room) ?? items.slice(start, start + Math.max(0, room))
  while (lines.length < room) lines.push('')
  return [...lines, footerLine(st, HINTS, width)].map(l => fitLine(l, width))
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

export function initialMenu(version: string, summary: Summary, size: { columns: number; rows: number }): MenuView {
  return { version, columns: size.columns, rows: size.rows, selected: 0, summary }
}
