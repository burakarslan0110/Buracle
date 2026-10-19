const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}​-‏︀-️]$/u
const EMOJI_WIDE = /^\p{Emoji_Presentation}$/u

function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
}

function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (ZERO_WIDTH.test(ch)) return 0
  if (isWideCodePoint(cp) || EMOJI_WIDE.test(ch)) return 2
  return 1
}

export function textWidth(s: string): number {
  let w = 0
  let prev = ''
  for (const ch of s) {
    if (ch === '️' && prev !== '' && charWidth(prev) === 1 && /\p{Extended_Pictographic}/u.test(prev)) w += 1
    w += charWidth(ch)
    prev = ch
  }
  return w
}

export function truncateToWidth(s: string, width: number): string {
  if (width <= 0) return ''
  if (textWidth(s) <= width) return s
  if (width === 1) return '…'
  let out = ''
  let w = 0
  for (const ch of s) {
    const cw = charWidth(ch)
    if (w + cw > width - 1) break
    out += ch
    w += cw
  }
  return out.replace(/\s+$/u, '') + '…'
}

export function sanitizeText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f]/gu, ' ')
}

export function stripEmoji(s: string): string {
  const seq = /(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️)(?:[\u{1F3FB}-\u{1F3FF}]|️|‍(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}️?))*\s?/gu
  return s.replace(seq, '').replace(/\s{2,}/gu, ' ').trim()
}

function oneDecimal(x: number): string {
  const s = x.toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) : s
}

export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '?'
  const v = Math.max(0, n)
  if (v < 1000) return String(Math.round(v))
  if (v < 10_000) return `${oneDecimal(v / 1000)}k`
  if (v < 999_500) return `${Math.round(v / 1000)}k`
  if (v < 9_950_000) return `${oneDecimal(v / 1e6)}M`
  if (v < 999_500_000) return `${Math.round(v / 1e6)}M`
  return `${oneDecimal(v / 1e9)}B`
}

const BYTE_UNITS = ['KB', 'MB', 'GB', 'TB'] as const

export function formatBytes(n: number): string {
  if (!Number.isFinite(n)) return '?'
  const v = Math.max(0, n)
  if (v < 999.5) return `${Math.round(v)} B`
  let x = v / 1024
  for (const [i, unit] of BYTE_UNITS.entries()) {
    if (x < 9.95) return `${oneDecimal(x)} ${unit}`
    if (x < 999.5 || i === BYTE_UNITS.length - 1) return `${Math.round(x)} ${unit}`
    x /= 1024
  }
  return '?'
}

export function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return '$?'
  const v = Math.max(0, n)
  return v < 100 ? `$${v.toFixed(2)}` : `$${Math.round(v)}`
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

export function formatResetIn(resetMs: number, nowMs: number): string {
  if (!Number.isFinite(resetMs) || !Number.isFinite(nowMs)) return '?'
  const d = resetMs - nowMs
  if (d <= 0) return '0m'
  const mins = Math.ceil(d / 60_000)
  if (mins < 60) return `${mins}m`
  if (mins < 24 * 60) {
    const h = Math.floor(mins / 60)
    const m = mins % 60
    return m === 0 ? `${h}h` : `${h}h${m}m`
  }
  const at = new Date(resetMs)
  if (d < 7 * 24 * 3600_000) return `${DAYS[at.getDay()] ?? '?'} ${pad2(at.getHours())}:${pad2(at.getMinutes())}`
  return `${MONTHS[at.getMonth()] ?? '?'} ${at.getDate()}`
}

export function formatPct(p: number): string {
  if (!Number.isFinite(p)) return '?'
  return String(Math.round(Math.max(0, p)))
}

export function gauge(pct: number, cells = 6): string {
  const p = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 0
  const filled = Math.round((p / 100) * cells)
  return '▓'.repeat(filled) + '░'.repeat(cells - filled)
}
