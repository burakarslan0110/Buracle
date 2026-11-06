import { sanitizeText, textWidth, truncateToWidth } from '../../core/status/format'
import type { ColorLevel, Style } from './style'
import { ICON, paintLogo, padEnd, stripAnsi, TAGLINE, visibleWidth, wordmark } from './style'

// One frame for every screen of the interactive CLI: the logo header (in one of three sizes) with the status line
// under it, the screen's own lines, and one key-hint line at the bottom. Every screen at one terminal size and color
// level shows the same header lines, so moving between screens never moves the logo.

export const MARGIN = '  '

/** What the header's status line counts: waiting updates, problems, the last update check, what is checked now. */
export interface Summary { updates: number; problems: number; checkedAt?: string; working?: string }

export type HeaderKind = 'logo' | 'icon' | 'wordmark'

export interface HeaderView { version: string; columns: number; rows: number; summary: Summary }

export interface Hint { key: string; word: string; drop?: number; shrink?: boolean } // drop: the order in which hints go when the line is too narrow; shrink: this word is cut before the line is

const LOGO_MIN = { columns: 63, rows: 20 } as const
const ICON_MIN_COLUMNS = 43
const ICON_WIDTH = 8
const ICON_GAP = '   '
const HARNESSES = 'Claude Code · Codex · OpenCode · Oh My Pi'
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069]/gu

// Every value that comes from outside goes through here before it reaches the screen.
export function clean(s: string | undefined): string {
  return s === undefined ? '' : sanitizeText(s).replace(BIDI_CONTROLS, '').trim()
}

// Lines are built to fit; this only guards the corner cases (a terminal narrower than the fixed parts).
export function fitLine(line: string, width: number): string {
  return visibleWidth(line) <= width ? line : truncateToWidth(stripAnsi(line), width)
}

/** The header size for a terminal: the full logo, the icon with the name beside it, or one line. */
export function headerKind(columns: number, rows: number, level: ColorLevel): HeaderKind {
  if (level === 0 || rows < LOGO_MIN.rows) return 'wordmark'
  if (columns >= LOGO_MIN.columns) return 'logo'
  return columns >= ICON_MIN_COLUMNS ? 'icon' : 'wordmark'
}

function wrapWords(text: string, width: number, maxLines: number): string[] | undefined {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(' ')) {
    if (line === '') line = word
    else if (textWidth(line) + 1 + textWidth(word) <= width) line = `${line} ${word}`
    else { lines.push(line); line = word }
  }
  lines.push(line)
  return lines.length <= maxLines && lines.every(l => textWidth(l) <= width) ? lines : undefined
}

function titleLine(st: Style, version: string, width: number): string {
  const head = `${MARGIN}${st.level === 0 ? st.bold('buracle') : wordmark(st)}${version === '' ? '' : ` ${st.muted(`v${version}`)}`}`
  const full = `${head}${st.muted(` · ${TAGLINE}`)}`
  return visibleWidth(full) <= width ? full : head
}

/** One line under the logo: all good or what waits, then the time of the last update check or what is checked now. */
export function statusLine(st: Style, summary: Summary, width: number): string {
  const { updates, problems } = summary
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  const main = updates === 0 && problems === 0
    ? `${st.ok(st.sym.ok)} All good`
    : [
        problems > 0 ? st.warn(st.sym.warn) : st.accent(st.sym.info),
        [...(updates > 0 ? [st.accent(count(updates, 'update waiting', 'updates waiting'))] : []), ...(problems > 0 ? [st.warn(count(problems, 'problem', 'problems'))] : [])].join(st.muted(' · ')),
      ].join(' ')
  const checked = clean(summary.checkedAt)
  const working = clean(summary.working)
  const when = working !== '' ? st.muted(' · ') + st.accent(working) : st.muted(` · ${checked === '' ? 'no update check yet' : `updates checked ${checked}`}`)
  const line = `${MARGIN}${main}`
  return visibleWidth(line + when) <= width ? line + when : line
}

function logoLines(st: Style, version: string, width: number): string[] {
  const withHarnesses = `v${version}  ·  ${TAGLINE}  ·  ${HARNESSES}`
  const short = `v${version}  ·  ${TAGLINE}`
  const meta = [withHarnesses, short, `v${version}`].find(m => textWidth(MARGIN + m) <= width) ?? ''
  return [...paintLogo(st).map(l => `${MARGIN}${l}`), `${MARGIN}${st.muted(meta)}`]
}

function iconLines(st: Style, version: string, width: number): string[] {
  const room = width - MARGIN.length - ICON_WIDTH - ICON_GAP.length
  const tagline = wrapWords(TAGLINE, room, 2) ?? []
  const beside = ['', '', st.bold(st.gradient('buracle')), st.muted(`v${version}`), ...tagline.map(l => st.muted(l)), '']
  return paintLogo(st, ICON).map((l, i) => {
    const text = beside[i] ?? ''
    return text === '' ? `${MARGIN}${l}` : `${MARGIN}${padEnd(l, ICON_WIDTH)}${ICON_GAP}${text}`
  })
}

/**
 * The header of every screen: the logo in the size `headerKind` picks, then the status line. It depends only on the
 * size, the color level and the data, so every screen at one size shows the same lines.
 */
export function headerLines(st: Style, view: HeaderView): string[] {
  const width = Math.max(0, view.columns - 1)
  const version = clean(view.version)
  const status = statusLine(st, view.summary, width)
  const lines = ((): string[] => {
    switch (headerKind(view.columns, view.rows, st.level)) {
      case 'logo': return ['', ...logoLines(st, version, width), '', status, '']
      case 'icon': return ['', ...iconLines(st, version, width), '', status, '']
      case 'wordmark': {
        const title = titleLine(st, version, width)
        if (view.rows >= 16) return ['', title, '', status, '']
        return view.rows >= 12 ? [title, status, ''] : [title, status]
      }
    }
  })()
  return lines.map(l => fitLine(l, width))
}

/** The first line of a command's output in a terminal: the wordmark, the version and the command. */
export function commandHeader(st: Style, version: string, command: string): string {
  const v = clean(version)
  return `${MARGIN}${st.level === 0 ? st.bold('buracle') : wordmark(st)}${v === '' ? '' : ` ${st.muted(`v${v}`)}`}${st.muted(` · ${clean(command)}`)}`
}

/** How many lines `headerLines` gives for this size and color level, for code that has no style (key handling). */
export function headerHeight(columns: number, rows: number, level: ColorLevel): number {
  switch (headerKind(columns, rows, level)) {
    case 'logo': return 11
    case 'icon': return 10
    case 'wordmark': return rows >= 16 ? 5 : rows >= 12 ? 3 : 2
  }
}

/** A section title over the rows of one group, the same in the detailed view and in command output. */
export function sectionHeading(st: Style, title: string, width: number): string {
  const total = Math.min(width, 72)
  const rest = Math.max(2, total - MARGIN.length - 2 - 1 - textWidth(title) - 1)
  return fitLine(`${MARGIN}${st.muted(st.sym.line.repeat(2))} ${st.bold(st.accent(title))} ${st.muted(st.sym.line.repeat(rest))}`, width)
}

/** The key hints of a screen as `key word` pairs; hints go in their `drop` order until the line fits the width. */
export function footerLine(st: Style, hints: readonly Hint[], width: number): string {
  const sep = ' · '
  const widthOf = (hs: readonly Hint[]) =>
    MARGIN.length + hs.reduce((n, h) => n + textWidth(h.key) + (h.word === '' ? 0 : 1 + textWidth(h.word)), 0) + sep.length * Math.max(0, hs.length - 1)
  let shown = [...hints]
  const orders = [...new Set(hints.map(h => h.drop).filter((d): d is number => d !== undefined))].sort((a, b) => a - b)
  for (const order of orders) {
    if (widthOf(shown) <= width) break
    shown = shown.filter(h => h.drop !== order)
  }
  const over = widthOf(shown) - width
  if (over > 0) shown = shown.map(h => (h.shrink === true ? { ...h, word: truncateToWidth(h.word, Math.max(0, textWidth(h.word) - over)) } : h))
  const line = MARGIN + shown.map(h => (h.word === '' ? h.key : `${h.key} ${st.muted(h.word)}`)).join(st.muted(sep))
  return fitLine(line, width)
}
