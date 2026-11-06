import { textWidth } from '../../core/status/format'

export type ColorLevel = 0 | 1 | 2 | 3

export function colorLevel(stream: { isTTY?: boolean } = process.stdout, env: Record<string, string | undefined> = process.env): ColorLevel {
  if (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') return 0
  const force = env['FORCE_COLOR']
  if (force === '0' || force === 'false') return 0
  if (force === undefined && stream.isTTY !== true) return 0
  if (env['TERM'] === 'dumb') return 0
  const ct = (env['COLORTERM'] ?? '').toLowerCase()
  if (ct === 'truecolor' || ct === '24bit') return 3
  const tp = env['TERM_PROGRAM'] ?? ''
  if (env['WT_SESSION'] !== undefined || ['iTerm.app', 'vscode', 'WezTerm', 'ghostty', 'Hyper', 'Tabby'].includes(tp) || env['KITTY_WINDOW_ID'] !== undefined) return 3
  if (tp === 'Apple_Terminal') return 2
  if (/-256(color)?$/.test(env['TERM'] ?? '')) return 2
  if (force !== undefined && force !== '') return force === '3' ? 3 : force === '2' ? 2 : 1
  return 1
}

export interface Rgb { r: number; g: number; b: number }

function hex(h: string): Rgb {
  const n = Number.parseInt(h.replace('#', ''), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

// The brand roles: the wordmark runs from brand to brandEnd, its eye is eye. The web UI (tokens.css, logo.js), the
// install script and the README badges carry the same brand; tests/cli/ui/brand.test.ts holds them together.
export const PALETTE = {
  brand: hex('#8B5CF6'),
  brandEnd: hex('#D946EF'),
  eye: hex('#D97706'),
  green: hex('#22C55E'),
  yellow: hex('#EAB308'),
  red: hex('#EF4444'),
  gray: hex('#6B7280'),
} as const

// The brand roles as 16-color SGR codes, for scripts/install.sh, which cannot import this file.
export const ANSI16 = { brand: 35, brandEnd: 95, eye: 33 } as const

const ESC = '\u001b['

function to256(c: Rgb): number {
  const q = (v: number) => (v < 48 ? 0 : v < 115 ? 1 : Math.min(5, Math.floor((v - 35) / 40)))
  return 16 + 36 * q(c.r) + 6 * q(c.g) + q(c.b)
}

function to16(c: Rgb): number {
  const bright = Math.max(c.r, c.g, c.b) > 170 ? 60 : 0
  const bit = (v: number) => (v > 100 ? 1 : 0)
  return 30 + bright + (bit(c.r) | (bit(c.g) << 1) | (bit(c.b) << 2))
}

export interface Style {
  level: ColorLevel
  fg(c: Rgb, s: string): string
  bold(s: string): string
  dim(s: string): string
  italic(s: string): string
  inverse(s: string): string
  gradient(s: string, from?: Rgb, to?: Rgb): string
  ok(s: string): string
  warn(s: string): string
  err(s: string): string
  accent(s: string): string
  muted(s: string): string
  link(text: string, url: string): string
  sym: { ok: string, warn: string, err: string, info: string, dot: string, arrow: string, bullet: string, pointer: string, line: string }
}

export function mix(from: Rgb, to: Rgb, t: number): Rgb {
  return { r: Math.round(from.r + (to.r - from.r) * t), g: Math.round(from.g + (to.g - from.g) * t), b: Math.round(from.b + (to.b - from.b) * t) }
}

export function makeStyle(level: ColorLevel, opts: { unicode?: boolean } = {}): Style {
  const uni = opts.unicode ?? true
  const wrap = (open: string, close: string) => (s: string) => (level === 0 ? s : `${ESC}${open}m${s}${ESC}${close}m`)
  const fg = (c: Rgb, s: string): string => {
    if (level === 0 || s === '') return s
    const code = level === 3 ? `38;2;${c.r};${c.g};${c.b}` : level === 2 ? `38;5;${to256(c)}` : String(to16(c))
    return `${ESC}${code}m${s}${ESC}39m`
  }
  const gradient = (s: string, from: Rgb = PALETTE.brand, to: Rgb = PALETTE.brandEnd): string => {
    if (level === 0) return s
    const chars = [...s]
    const n = Math.max(1, chars.length - 1)
    return chars.map((ch, i) => (ch === ' ' ? ch : fg(mix(from, to, i / n), ch))).join('')
  }
  return {
    level,
    fg,
    bold: wrap('1', '22'),
    dim: wrap('2', '22'),
    italic: wrap('3', '23'),
    inverse: wrap('7', '27'),
    gradient,
    ok: s => fg(PALETTE.green, s),
    warn: s => fg(PALETTE.yellow, s),
    err: s => fg(PALETTE.red, s),
    accent: s => fg(PALETTE.brand, s),
    muted: s => fg(PALETTE.gray, s),
    link: (text, url) => (level === 0 ? text : `\u001b]8;;${url}\u001b\\${text}\u001b]8;;\u001b\\`),
    sym: uni
      ? { ok: '✔', warn: '▲', err: '✖', info: 'ℹ', dot: '●', arrow: '→', bullet: '•', pointer: '❯', line: '─' }
      : { ok: '+', warn: '!', err: 'x', info: 'i', dot: '*', arrow: '->', bullet: '-', pointer: '>', line: '-' },
  }
}

// The menu's rule for a terminal: no color means the plain symbols (+ ! x i). A pipe keeps the Unicode symbols it always had.
export function styleFor(stream: { isTTY?: boolean } = process.stdout): Style {
  const level = colorLevel(stream)
  return makeStyle(level, { unicode: !(stream.isTTY === true && level === 0) })
}

export function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[0-9;]*m/g, '').replace(/\u001b\]8;;[^\u001b]*\u001b\\/g, '')
}

export function visibleWidth(s: string): number {
  return textWidth(stripAnsi(s))
}

export function padEnd(s: string, width: number): string {
  const w = visibleWidth(s)
  return w >= width ? s : s + ' '.repeat(width - w)
}

export function box(lines: readonly string[], st: Style, opts: { title?: string, width?: number, color?: Rgb, padding?: number } = {}): string {
  const pad = opts.padding ?? 1
  const inner = Math.max(opts.width ?? 0, ...lines.map(visibleWidth), opts.title !== undefined ? visibleWidth(opts.title) + 2 : 0) + pad * 2
  const paint = (s: string) => (opts.color !== undefined ? st.fg(opts.color, s) : st.muted(s))
  const top = opts.title !== undefined
    ? paint('╭─ ') + st.bold(opts.title) + paint(' ' + '─'.repeat(Math.max(0, inner - visibleWidth(opts.title) - 3)) + '╮')
    : paint('╭' + '─'.repeat(inner) + '╮')
  const body = lines.map(l => paint('│') + ' '.repeat(pad) + padEnd(l, inner - pad * 2) + ' '.repeat(pad) + paint('│'))
  return [top, ...body, paint('╰' + '─'.repeat(inner) + '╯')].join('\n')
}

// The wordmark: lowercase "buracle" on a pixel grid, the bowl of the "b" holding the oracle's slit eye (LOGO_EYE).
export const LOGO: readonly string[] = [
  '██                                       ██        ',
  '██                                       ██        ',
  '██▀▀▀▀█▄  ██  ██  ██▄█▀   ▀▀▀█▄  ▄█▀▀▀▀  ██  ▄█▀▀█▄',
  '██ ██ ██  ██  ██  ██      ▄▄▄██  ██      ██  ██▄▄██',
  '██ ██ ██  ██  ██  ██     ██  ██  ██      ██  ██    ',
  '██▄▄▄▄█▀  ▀█▄▄██  ██     ▀█▄▄██  ▀█▄▄▄▄  ██  ▀█▄▄▄▄',
]

export const LOGO_EYE: ReadonlyArray<readonly [number, number]> = [[3, 3], [3, 4], [4, 3], [4, 4]]

export const ICON: readonly string[] = LOGO.map(l => l.slice(0, 8))

const LOGO_WIDTH = Math.max(...LOGO.map(l => [...l].length))

export function paintLogo(st: Style, rows: readonly string[] = LOGO): string[] {
  const eye = new Set(LOGO_EYE.map(([r, c]) => `${r}:${c}`))
  return rows.map((row, r) => [...row.trimEnd()].map((ch, c) => {
    if (ch === ' ') return ch
    return st.fg(eye.has(`${r}:${c}`) ? PALETTE.eye : mix(PALETTE.brand, PALETTE.brandEnd, c / (LOGO_WIDTH - 1)), ch)
  }).join(''))
}

export function wordmark(st: Style): string {
  return `${st.accent('◉')} ${st.bold(st.gradient('buracle'))}`
}

export const TAGLINE = 'One engineering setup, one memory, every coding agent'
