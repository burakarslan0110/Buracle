import { truncateToWidth } from '../../core/status/format'
import { colorLevel, makeStyle, type Style } from './style'

// The install summary: one line per section in a fixed order, and under it only the items that did not pass.
// scripts/install.sh and scripts/install.ps1 print the first two sections in the same layout themselves
// (tests/engine/install-script.test.ts compares them with this file).

export const SECTION_ORDER = ['Prerequisites', 'Buracle', 'Harnesses', 'Tools', 'Memory', 'Result'] as const
export type SectionName = typeof SECTION_ORDER[number]
export type SectionStatus = 'ok' | 'warn' | 'fail' | 'skip' | 'info'

export interface SectionItem { status: SectionStatus, name: string, detail: string }
export interface SectionResult { name: SectionName, status: SectionStatus, detail: string, items?: readonly SectionItem[] }

/** The section name is padded to this many columns; an item name to ITEM_NAME_WIDTH, then one space. */
export const NAME_WIDTH = 16
export const ITEM_NAME_WIDTH = 12
const ITEM_INDENT = '    '

function icon(st: Style, s: SectionStatus): string {
  switch (s) {
    case 'ok': return st.ok(st.sym.ok)
    case 'warn': case 'skip': return st.warn(st.sym.warn)
    case 'fail': return st.err(st.sym.err)
    case 'info': return st.accent(st.sym.info)
  }
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length)
}

function line(st: Style, prefix: string, status: SectionStatus, rest: string, columns: number | undefined): string {
  // The icon is one column wide; the text after it is cut so the whole line stays under the terminal width.
  const room = columns === undefined ? Number.POSITIVE_INFINITY : Math.max(1, columns - 1 - prefix.length - 2)
  const text = room === Number.POSITIVE_INFINITY ? rest : truncateToWidth(rest, room)
  return `${prefix}${icon(st, status)} ${text}`.replace(/\s+$/u, '')
}

/** The lines of one finished section: the section line, then each item that did not pass. */
export function renderSection(r: SectionResult, opts: { style: Style, columns?: number }): string[] {
  const out = [line(opts.style, '', r.status, `${pad(r.name, NAME_WIDTH)}${r.detail}`, opts.columns)]
  for (const item of r.items ?? []) {
    if (item.status === 'ok') continue
    out.push(line(opts.style, ITEM_INDENT, item.status, `${pad(item.name, ITEM_NAME_WIDTH)} ${item.detail}`, opts.columns))
  }
  return out
}

/** Block symbols need a UTF-8 locale (the first of LC_ALL, LC_CTYPE, LANG that is set, as a shell reads it); Windows always has them. */
export function unicodeLocale(env: Readonly<Record<string, string | undefined>> = process.env, platform: string = process.platform): boolean {
  if (platform === 'win32') return true
  const locale = [env['LC_ALL'], env['LC_CTYPE'], env['LANG']].find(v => v !== undefined && v !== '')
  return locale !== undefined && /utf-?8/i.test(locale)
}

export interface SectionMode { live: boolean, unicode: boolean, style: Style }

/** A live line only on a terminal that takes control codes; NO_COLOR, TERM=dumb and a pipe get plain lines. */
export function sectionMode(stream: { isTTY?: boolean }, env: Readonly<Record<string, string | undefined>> = process.env, platform: string = process.platform): SectionMode {
  const noCodes = (env['NO_COLOR'] !== undefined && env['NO_COLOR'] !== '') || env['TERM'] === 'dumb'
  const live = stream.isTTY === true && !noCodes
  const unicode = unicodeLocale(env, platform)
  return { live, unicode, style: makeStyle(live ? colorLevel(stream, { ...env }) : 0, { unicode }) }
}

export interface SectionPrinter {
  readonly live: boolean
  /** Shows `name` as running with `text` (a live line on a terminal; nothing otherwise). */
  start(name: SectionName, text: string): void
  update(text: string): void
  /** Clears the live line and prints the finished section. */
  done(r: SectionResult): void
  /** Clears a live line that is still shown (before a question, or at the end). */
  stop(): void
}

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function sectionPrinter(out: { write(s: string): void }, opts: { live: boolean, style: Style, columns?: number, frameMs?: number }): SectionPrinter {
  const st = opts.style
  let running: { name: SectionName, text: string } | undefined
  let frame = 0
  let shown = false
  let timer: ReturnType<typeof setInterval> | undefined
  const clear = (): void => {
    if (!shown) return
    out.write('\r\u001b[2K')
    shown = false
  }
  const draw = (): void => {
    if (!opts.live || running === undefined) return
    const spin = st.sym.ok === '✔' ? FRAMES[frame % FRAMES.length] ?? '-' : '|/-\\'[frame % 4] ?? '-'
    const room = opts.columns === undefined ? Number.POSITIVE_INFINITY : Math.max(1, opts.columns - 3)
    const text = `${pad(running.name, NAME_WIDTH)}${running.text}`
    out.write(`\r\u001b[2K${st.accent(spin)} ${room === Number.POSITIVE_INFINITY ? text : truncateToWidth(text, room)}`)
    shown = true
  }
  const stopTimer = (): void => {
    if (timer !== undefined) clearInterval(timer)
    timer = undefined
  }
  return {
    live: opts.live,
    start(name, text) {
      running = { name, text }
      if (!opts.live) return
      draw()
      if (timer === undefined && (opts.frameMs ?? 90) > 0) {
        timer = setInterval(() => { frame++; draw() }, opts.frameMs ?? 90)
        timer.unref?.()
      }
    },
    update(text) {
      if (running === undefined) return
      running = { ...running, text }
      draw()
    },
    done(r) {
      stopTimer()
      clear()
      running = undefined
      out.write(renderSection(r, { style: st, ...(opts.columns !== undefined ? { columns: opts.columns } : {}) }).join('\n') + '\n')
    },
    stop() {
      stopTimer()
      clear()
      running = undefined
    },
  }
}
