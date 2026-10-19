import type { HookHealth, Segment } from './model'

export interface HooksSegmentTexts { long: string; short: string; color: NonNullable<Segment['color']> }

export function hooksSegmentTexts(h: HookHealth | undefined): HooksSegmentTexts | undefined {
  if (h === undefined) return undefined
  const n = Number.isFinite(h.failures) ? Math.max(0, Math.round(h.failures)) : 0
  const closed = Number.isFinite(h.failClosed) ? Math.max(0, Math.round(h.failClosed)) : 0
  const behind = h.runtimeBehind === true
  if (n === 0 && !behind) return undefined
  const long = [n > 0 ? `hooks ✗${n}${closed > 0 ? ` (${closed} denied)` : ''}` : '', behind ? 'runtime behind: buracle install' : ''].filter(Boolean).join(' · ')
  const short = [n > 0 ? `hooks ✗${n}` : '', behind ? 'sync' : ''].filter(Boolean).join(' ')
  return { long, short, color: n > 0 ? 'red' : 'yellow' }
}
