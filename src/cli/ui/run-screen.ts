// The screen of a command the menu runs: the shared header pinned on the top rows, a key-hint footer on the last row,
// and between them a scroll region the command's output scrolls in. The command runs in a PTY; its bytes reach the
// terminal unchanged through the forwarder below, which also keeps a copy so the whole output can be shown again.

export interface RunLayout { header: readonly string[]; footer: string; columns: number; rows: number }

const ESC = '\u001b'
const SAVE = `${ESC}7`
const RESTORE = `${ESC}8`
const RESET_REGION = `${ESC}[r`
const ERASE_LINE = `${ESC}[K`
// One char per byte (code points 0-255), so escape sequences can be found in raw output whatever its encoding and
// the bytes come back unchanged. TextDecoder('latin1') is windows-1252 and would change the bytes 0x80-0x9f.
function binaryText(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return s
}

function binaryBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i)
  return b
}

const at = (row: number): string => `${ESC}[${row};1H`

/** The rows of the scroll region (counted from 1): under the header, above the footer. */
export function outputArea(l: RunLayout): { top: number; bottom: number } {
  return { top: l.header.length + 1, bottom: Math.max(l.header.length + 1, l.rows - 1) }
}

/** The size the command's PTY gets: the width of the terminal and the height of the output area, at least 1 by 1. */
export function ptySize(l: RunLayout): { cols: number; rows: number } {
  return { cols: Math.max(1, l.columns), rows: Math.max(1, l.rows - l.header.length - 1) }
}

function frame(l: RunLayout, what: 'footer' | 'all'): string {
  const header = what === 'all' ? l.header.map((line, i) => `${at(i + 1)}${line}${ERASE_LINE}`).join('') : ''
  return `${header}${at(l.rows)}${l.footer}${ERASE_LINE}`
}

/**
 * Starts the run screen: the old screen scrolls into the scrollback (it is not erased), then the header and the footer
 * are drawn. The caller sets the scroll region next and then moves the cursor with `cursorToArea`.
 */
export function enterSequence(l: RunLayout): string {
  return `${RESET_REGION}${at(l.rows)}${'\r\n'.repeat(l.rows)}${frame(l, 'all')}`
}

export function cursorToArea(l: RunLayout): string {
  return at(outputArea(l).top)
}

/** Draws the footer again (and the header with `all`) where the command's output erased it, and puts the cursor back. */
export function repaintSequence(l: RunLayout, what: 'footer' | 'all'): string {
  return `${SAVE}${frame(l, what)}${RESTORE}`
}

/** After a resize: the header and the footer for the new size. The caller sets the new region, then `cursorToBottom`. */
export function redrawSequence(l: RunLayout): string {
  return frame(l, 'all')
}

/**
 * After a resize, before `redrawSequence`: erases the rows the old frame drew that the new frame does not, so no old
 * header row or old footer is left in the new output area (a shorter header, a taller window).
 */
export function staleRowsSequence(old: RunLayout, next: RunLayout): string {
  const frameRows = (l: RunLayout): Set<number> => new Set([...l.header.map((_, i) => i + 1), l.rows])
  const keep = frameRows(next)
  return [...frameRows(old)].filter(r => r <= next.rows && !keep.has(r)).sort((a, b) => a - b).map(r => `${at(r)}${ESC}[2K`).join('')
}

export function cursorToBottom(l: RunLayout): string {
  return at(outputArea(l).bottom)
}

/** Without a PTY: the old screen scrolls into the scrollback and the header shows once; the output follows below it. */
export function fallbackSequence(l: RunLayout): string {
  return `${RESET_REGION}${at(l.rows)}${'\r\n'.repeat(l.rows)}${ESC}[H${l.header.join('\r\n')}\r\n`
}

// Queries a terminal answers on its input: replayed, their answers would arrive as keys.
const QUERIES = /\u001b\[(?:[56]n|>?0?c)/g

/** The copy of the output without the terminal queries in it, ready to be written again. */
export function replayBytes(copy: Uint8Array): Uint8Array {
  return binaryBytes(binaryText(copy).replace(QUERIES, ''))
}

/** The start of the replay: the screen cleared (the region is already reset) and the header once. */
export function replayStart(l: RunLayout): string {
  return `${ESC}[H${ESC}[2J${l.header.join('\r\n')}\r\n`
}

export interface Forwarder {
  feed(chunk: Uint8Array): void
  /** Writes what is held back; call it when the command ended. */
  flush(): void
  /** The command's output so far, as it came, up to the limit. */
  copy(): Uint8Array
  truncated(): boolean
}

export const MAX_HOLD_BYTES = 64
export const HOLD_MS = 50
export const MAX_COPY_BYTES = 4 * 1024 * 1024

// An erase in display: below the cursor (J, 0J) wipes the footer; above it (1J) or all of it (2J) wipes the header too.
const ERASE_BELOW = /\u001b\[0?J/
const ERASE_ABOVE = /\u001b\[[12]J/

// Where a chunk stops being complete: an escape sequence or a UTF-8 character that the next chunk finishes.
function completeLength(b: Uint8Array): number {
  const from = Math.max(0, b.length - MAX_HOLD_BYTES)
  let esc = -1
  for (let i = b.length - 1; i >= from; i--) if (b[i] === 0x1b) { esc = i; break }
  if (esc >= 0 && !sequenceDone(b, esc)) return esc
  // A UTF-8 lead byte near the end whose continuation bytes have not all come yet.
  for (let i = b.length - 1; i >= Math.max(0, b.length - 3); i--) {
    const c = b[i] ?? 0
    if ((c & 0xc0) === 0x80) continue
    const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1
    return b.length - i < need ? i : b.length
  }
  return b.length
}

function sequenceDone(b: Uint8Array, esc: number): boolean {
  const kind = b[esc + 1]
  if (kind === undefined) return false
  if (kind === 0x5b) { // CSI: parameters and intermediates, then a final byte in 0x40-0x7e
    for (let i = esc + 2; i < b.length; i++) if ((b[i] ?? 0) >= 0x40 && (b[i] ?? 0) <= 0x7e) return true
    return false
  }
  if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) { // OSC, DCS, SOS, PM, APC: up to BEL or ESC \
    for (let i = esc + 2; i < b.length; i++) {
      if (b[i] === 0x07) return true
      if (b[i] === 0x1b && b[i + 1] === 0x5c) return true
    }
    return false
  }
  return true // a two-byte escape such as ESC 7
}

export function createForwarder(o: {
  write(d: Uint8Array): void
  repaint(what: 'footer' | 'all'): void
  setTimer?: (f: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  maxCopy?: number
}): Forwarder {
  const setTimer = o.setTimer ?? ((f: () => void, ms: number): unknown => setTimeout(f, ms))
  const clearTimer = o.clearTimer ?? ((t: unknown) => { clearTimeout(t as ReturnType<typeof setTimeout>) })
  const maxCopy = o.maxCopy ?? MAX_COPY_BYTES
  const kept: Uint8Array[] = []
  let keptBytes = 0
  let cut = false
  let held = new Uint8Array(0)
  let timer: unknown

  const keep = (chunk: Uint8Array): void => {
    if (keptBytes >= maxCopy) { if (chunk.length > 0) cut = true; return }
    const part = chunk.length <= maxCopy - keptBytes ? chunk : chunk.subarray(0, maxCopy - keptBytes)
    if (part.length < chunk.length) cut = true
    kept.push(part.slice())
    keptBytes += part.length
  }
  const out = (b: Uint8Array): void => {
    if (b.length === 0) return
    o.write(b)
    const text = binaryText(b)
    if (ERASE_ABOVE.test(text)) o.repaint('all')
    else if (ERASE_BELOW.test(text)) o.repaint('footer')
  }
  const stop = (): void => {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }
  const release = (): void => {
    stop()
    const b = held
    held = new Uint8Array(0)
    out(b)
  }

  return {
    feed(chunk) {
      keep(chunk)
      stop()
      const all = new Uint8Array(held.length + chunk.length)
      all.set(held, 0)
      all.set(chunk, held.length)
      const n = completeLength(all)
      held = all.slice(n)
      out(all.subarray(0, n))
      if (held.length > 0) timer = setTimer(release, HOLD_MS)
    },
    flush: release,
    copy() {
      const all = new Uint8Array(keptBytes)
      let i = 0
      for (const k of kept) { all.set(k, i); i += k.length }
      return all
    },
    truncated: () => cut,
  }
}
