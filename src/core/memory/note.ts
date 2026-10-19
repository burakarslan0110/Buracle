import { parseFrontmatter } from '../frontmatter'

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,79}$/

export function memIsSlug(v: unknown): v is string {
  return typeof v === 'string' && SLUG_RE.test(v)
}

export function parseNote(markdown: string): { fm: Record<string, unknown>, body: string } {
  const parsed = parseFrontmatter(markdown.replace(/\r\n/g, '\n'))
  return { fm: parsed.data as Record<string, unknown>, body: parsed.body }
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

export function memLocalParts(ms: number, offsetMin: number): { y: number, mo: number, d: number, h: number, mi: number, s: number } {
  const t = new Date(ms + offsetMin * 60_000)
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), mi: t.getUTCMinutes(), s: t.getUTCSeconds() }
}

export function memIsoLocal(ms: number, offsetMin: number): string {
  const p = memLocalParts(ms, offsetMin)
  const sign = offsetMin < 0 ? '-' : '+'
  const abs = Math.abs(offsetMin)
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
}

export function memLocalDate(ms: number, offsetMin: number): string {
  const p = memLocalParts(ms, offsetMin)
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}`
}

export function memLocalTime(ms: number, offsetMin: number): string {
  const p = memLocalParts(ms, offsetMin)
  return `${pad(p.h)}:${pad(p.mi)}`
}

export function memParseTime(v: unknown): number | undefined {
  if (typeof v !== 'string' || v === '') return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? ms : undefined
}

export function memNoteHarness(h: string): string {
  return h === 'claude' ? 'claude-code' : h
}
