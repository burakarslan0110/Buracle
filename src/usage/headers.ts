import type { RateWindow } from '../core/status/model'
import { windowLabel, WINDOW_MINUTES } from '../core/status/model'

export type HeaderGet = (name: string) => string | null | undefined

function num(x: unknown): number | undefined {
  const n = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : Number.NaN
  return Number.isFinite(n) ? n : undefined
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

function isoOfSeconds(s: number | undefined): string | undefined {
  if (s === undefined || s <= 0) return undefined
  const d = new Date(s * 1000)
  return Number.isFinite(d.getTime()) ? d.toISOString() : undefined
}

function windowOf(pct: number | undefined, minutes: number | undefined, resetSec: number | undefined, label?: string): RateWindow | undefined {
  if (pct === undefined || minutes === undefined || minutes <= 0) return undefined
  const w: RateWindow = { pct: round1(Math.max(0, pct)), label: label ?? windowLabel(minutes), windowMinutes: minutes }
  const reset = isoOfSeconds(resetSec)
  if (reset !== undefined) w.resetsAt = reset
  return w
}

const ANTHROPIC_WINDOWS: ReadonlyArray<readonly [string, number]> = [['5h', WINDOW_MINUTES['5h'] ?? 300], ['7d', WINDOW_MINUTES['7d'] ?? 10080]]

function anthropicWindows(get: HeaderGet): RateWindow[] {
  const out: RateWindow[] = []
  for (const [label, minutes] of ANTHROPIC_WINDOWS) {
    const util = num(get(`anthropic-ratelimit-unified-${label}-utilization`))
    const w = windowOf(util !== undefined ? util * 100 : undefined, minutes, num(get(`anthropic-ratelimit-unified-${label}-reset`)), label)
    if (w !== undefined) out.push(w)
  }
  return out
}

function codexWindows(get: HeaderGet, nowMs: number): RateWindow[] {
  const out: RateWindow[] = []
  for (const slot of ['primary', 'secondary']) {
    const after = num(get(`x-codex-${slot}-reset-after-seconds`))
    const reset = num(get(`x-codex-${slot}-reset-at`)) ?? (after !== undefined ? nowMs / 1000 + after : undefined)
    const w = windowOf(num(get(`x-codex-${slot}-used-percent`)), num(get(`x-codex-${slot}-window-minutes`)), reset)
    if (w !== undefined) out.push(w)
  }
  return out
}

export function windowsFromHeaders(get: HeaderGet, nowMs: number): RateWindow[] {
  const read: HeaderGet = name => { try { return get(name) } catch { return undefined } }
  const a = anthropicWindows(read)
  return a.length > 0 ? a : codexWindows(read, nowMs)
}

function rec(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}
}

export function windowsFromCodexEvent(payload: unknown): RateWindow[] {
  const e = rec(payload)
  if (e['type'] !== 'codex.rate_limits') return []
  const limits = rec(e['rate_limits'])
  const out: RateWindow[] = []
  for (const slot of ['primary', 'secondary']) {
    const w = rec(limits[slot])
    const win = windowOf(num(w['used_percent']), num(w['window_minutes']), num(w['reset_at']))
    if (win !== undefined) out.push(win)
  }
  return out
}

const CODEX_EVENT = 'codex.rate_limits'

export function windowsFromFrame(frame: unknown): RateWindow[] {
  let text: string | undefined
  if (typeof frame === 'string') text = frame
  else if (frame instanceof Uint8Array) text = new TextDecoder().decode(frame)
  else if (frame instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(frame))
  else if (frame !== null && typeof frame === 'object') return windowsFromCodexEvent(frame)
  if (text === undefined || !text.includes(CODEX_EVENT)) return []
  try { return windowsFromCodexEvent(JSON.parse(text)) } catch { return [] }
}
