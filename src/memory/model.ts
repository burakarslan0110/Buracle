import { readdirSync } from 'node:fs'
import { HARNESSES, type Harness } from '../core/events'
import { HEADROOM, type Headroom } from '../core/memory/budgets'
import { WINDOW_MINUTES, type RateWindow } from '../core/status/model'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { currentUsageEntry, readUsageCache } from '../usage/cache'
import { readTelemetry } from '../workflow/session-store'
import { harnessRunner, markRunnerFailed, runnerModelId, runnerRefusesForGood, runnerUnavailable, type ModelAnswer, type ModelRunner } from './runner'
import { isMemoryRunnerDir } from './spawn'

export interface HarnessPick {
  harness: Harness
  model?: string
  used?: number
}

export interface HarnessHold {
  harness: Harness
  why: string
  kind: 'window' | 'cli'
  window?: string
  pct?: number
  until?: string
}

export interface ModelChoice {
  picks: HarnessPick[]
  held: HarnessHold[]
}

export const RECENT_HARNESS_MS = 7 * 86_400_000

function runnerTelemetry(t: NonNullable<ReturnType<typeof readTelemetry>>): boolean {
  return t.runner === true || isMemoryRunnerDir(t.cwd)
}

function newestTelemetry(h: Harness): ReturnType<typeof readTelemetry> {
  let best: ReturnType<typeof readTelemetry> | undefined
  let sids: string[] = []
  try { sids = readdirSync(paths.sessionsDir(h)) } catch { return undefined }
  for (const sid of sids) {
    if (!paths.isValidSessionId(sid)) continue
    const t = readTelemetry(h, sid)
    if (t !== undefined && !runnerTelemetry(t) && (best === undefined || t.at > best.at)) best = t
  }
  return best
}

export function latestWindows(h?: Harness, nowMs: number = Date.now()): RateWindow[] {
  let best: { at: number, windows: RateWindow[] } | undefined
  const cache = readUsageCache()
  for (const one of h !== undefined ? [h] : HARNESSES) {
    const entry = currentUsageEntry(cache, one, nowMs)
    const cachedAt = entry !== undefined ? Date.parse(entry.computed_at) : Number.NaN
    if (entry !== undefined && Number.isFinite(cachedAt) && entry.windows.length > 0 && (!best || cachedAt > best.at)) best = { at: cachedAt, windows: entry.windows }
    let sids: string[] = []
    try { sids = readdirSync(paths.sessionsDir(one)) } catch { continue }
    for (const sid of sids) {
      if (!paths.isValidSessionId(sid)) continue
      const t = readTelemetry(one, sid)
      if (t?.windows && t.windows.length > 0 && (!best || t.at > best.at)) best = { at: t.at, windows: t.windows }
    }
  }
  return best !== undefined ? currentWindows(best.windows, best.at, nowMs) : []
}

export function currentWindows(windows: readonly RateWindow[], atMs: number, nowMs: number): RateWindow[] {
  return windows.filter(w => {
    if (w.resetsAt !== undefined) {
      const reset = Date.parse(w.resetsAt)
      if (Number.isFinite(reset)) return reset > nowMs
    }
    const minutes = windowMinutes(w)
    return minutes === undefined || nowMs - atMs <= minutes * 60_000
  })
}

function windowMinutes(w: RateWindow): number | undefined {
  return w.windowMinutes ?? WINDOW_MINUTES[w.label]
}

export function windowLimit(w: RateWindow, limits: Headroom = HEADROOM): number | undefined {
  const minutes = windowMinutes(w)
  if (minutes === undefined) return undefined
  return minutes <= 300 ? limits.max5hPct : limits.max7dPct
}

export function rateLimitWindow(windows: readonly RateWindow[], limits: Headroom = HEADROOM): RateWindow | undefined {
  return windows.find(w => {
    const limit = windowLimit(w, limits)
    return limit !== undefined && Number.isFinite(w.pct) && w.pct >= limit
  })
}

const WINDOW_NAMES: Readonly<Record<string, string>> = { '5h': '5-hour', '1d': '1-day', '7d': '7-day', '30d': '30-day', '365d': '365-day' }

export function rateLimitBlock(windows: readonly RateWindow[], limits: Headroom = HEADROOM): string | undefined {
  const w = rateLimitWindow(windows, limits)
  if (w === undefined) return undefined
  return `${WINDOW_NAMES[w.label] ?? w.label} window at ${w.pct}% (limit ${windowLimit(w, limits)}%)`
}

export function latestModel(h: Harness): string | undefined {
  try { return runnerModelId(newestTelemetry(h)?.modelId) } catch { return undefined }
}

export interface ChooseOptions {
  prefer?: Harness
  model?: string
  nowMs?: number
  checkCli?: boolean
  which?: (bin: string) => string | null
}

export function chooseHarnesses(opts: ChooseOptions = {}): ModelChoice {
  const now = opts.nowMs ?? Date.now()
  const picks: HarnessPick[] = []
  const held: HarnessHold[] = []
  const candidates: Harness[] = []
  if (opts.prefer !== undefined) candidates.push(opts.prefer)
  for (const h of HARNESSES) {
    if (candidates.includes(h)) continue
    const t = newestTelemetry(h)
    if (t !== undefined && now - t.at <= RECENT_HARNESS_MS) candidates.push(h)
  }
  const others: HarnessPick[] = []
  for (const h of candidates) {
    const windows = latestWindows(h, now)
    const w = rateLimitWindow(windows)
    if (w !== undefined) {
      held.push({ harness: h, why: `${h}: ${rateLimitBlock([w]) as string}`, kind: 'window', window: w.label, pct: w.pct, ...(w.resetsAt !== undefined ? { until: w.resetsAt } : {}) })
      continue
    }
    const model = h === opts.prefer ? runnerModelId(opts.model) ?? latestModel(h) : latestModel(h)
    if (opts.checkCli !== false) {
      const why = runnerUnavailable(h, now, { model: model ?? '', ...(opts.which !== undefined ? { which: opts.which } : {}) })
      if (why !== undefined) { held.push({ harness: h, why: `${h}: ${why}`, kind: 'cli' }); continue }
    }
    const used = windows.reduce<number | undefined>((m, x) => Number.isFinite(x.pct) ? Math.max(m ?? 0, x.pct) : m, undefined)
    const pick: HarnessPick = { harness: h, ...(model !== undefined ? { model } : {}), ...(used !== undefined ? { used } : {}) }
    if (h === opts.prefer) picks.push(pick)
    else others.push(pick)
  }
  others.sort((a, b) => (a.used ?? 101) - (b.used ?? 101) || HARNESSES.indexOf(a.harness) - HARNESSES.indexOf(b.harness))
  picks.push(...others)
  return { picks, held }
}

export function choiceWhy(c: ModelChoice): string {
  if (c.held.length > 0) return c.held.map(h => h.why).join('; ')
  return 'no harness ran a session in the last week, so none can run the memory\'s model'
}

export function choiceSkip(c: ModelChoice): 'rate-limit' | 'runner-unavailable' | 'no-harness' {
  if (c.held.some(h => h.kind === 'window')) return 'rate-limit'
  return c.held.length > 0 ? 'runner-unavailable' : 'no-harness'
}

export function choiceHoldsRunner(c: ModelChoice): boolean {
  return c.picks.length === 0 && c.held.some(h => h.kind === 'window')
}

export function choiceUntil(c: ModelChoice): string | undefined {
  return c.held.map(h => h.until).filter((u): u is string => u !== undefined).sort()[0]
}

export interface ChoiceRunnerDeps {
  harnessRunner?: (h: Harness) => ModelRunner
  nowMs?: () => number
  onNext?: (from: HarnessPick, error: string, to: HarnessPick | undefined) => void
}

export interface ChoiceRunner extends ModelRunner {
  current: HarnessPick | undefined
}

export function choiceRunner(choice: ModelChoice, deps: ChoiceRunnerDeps = {}): ChoiceRunner {
  const picks = [...choice.picks]
  const runners = deps.harnessRunner ?? harnessRunner
  const run = async (prompt: string, opts: Parameters<ModelRunner>[1]): Promise<ModelAnswer> => {
    const errors: string[] = []
    let unavailable = picks.length > 0
    for (let i = 0; i < picks.length; i++) {
      const pick = picks[i] as HarnessPick
      run.current = pick
      const { model: _m, ...rest } = opts
      const out = await runners(pick.harness)(prompt, { ...rest, ...(pick.model !== undefined ? { model: pick.model } : {}) })
      if (out.ok) return out
      const error = out.error ?? `${pick.harness}: the model did not answer`
      errors.push(error)
      if (out.unavailable !== true) {
        unavailable = false
        markRunnerFailed(pick.harness, (deps.nowMs ?? Date.now)(), error, runnerRefusesForGood(error), pick.model)
      }
      const next = picks[i + 1]
      deps.onNext?.(pick, error, next)
      if (next !== undefined) log('info', 'memory: a harness CLI failed; the call moves to the next harness', { from: pick.harness, to: next.harness, error })
    }
    return { ok: false, text: '', error: errors.join('; ') || 'no harness can run the memory\'s model now', ...(unavailable ? { unavailable: true } : {}) }
  }
  run.current = undefined as HarnessPick | undefined
  return run
}
