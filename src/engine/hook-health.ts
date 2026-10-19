import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { HookHealth } from '../core/status/model'
import { atomicWriteSync } from './fsx'
import * as paths from './paths'

export const HOOK_FAILURE_MESSAGES: readonly string[] = ['hook handler failed', 'hook command failed before dispatch', 'hook runtime failed']

export const DAY_MS = 86_400_000

export interface HookFailure { ts: string; msg: string; harness?: string; event?: string; result?: string; error?: string }

export interface HookHealthSummary {
  failures: number
  failClosed: number
  last?: HookFailure
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

function failureOf(line: string, sinceMs: number): HookFailure | undefined {
  if (!line.includes('"hook ')) return undefined
  let o: unknown
  try { o = JSON.parse(line) } catch { return undefined }
  if (o === null || typeof o !== 'object') return undefined
  const r = o as Record<string, unknown>
  const msg = str(r['msg'])
  const ts = str(r['ts'])
  if (msg === undefined || ts === undefined || !HOOK_FAILURE_MESSAGES.includes(msg)) return undefined
  const t = Date.parse(ts)
  if (!Number.isFinite(t) || t < sinceMs) return undefined
  const d = r['data'] !== null && typeof r['data'] === 'object' ? r['data'] as Record<string, unknown> : {}
  const f: HookFailure = { ts, msg }
  const argv = Array.isArray(d['argv']) ? d['argv'].map(String) : []
  const harness = str(d['harness']) ?? argv[1]
  const event = str(d['event']) ?? argv[2]
  if (harness !== undefined) f.harness = harness
  if (event !== undefined) f.event = event
  const result = str(d['result'])
  if (result !== undefined) f.result = result
  const err = d['error']
  const error = err !== null && typeof err === 'object' ? str((err as Record<string, unknown>)['message']) : str(err) ?? str(d['why'])
  if (error !== undefined) f.error = error.split('\n')[0]?.slice(0, 300) ?? error
  return f
}

export function scanHookFailures(nowMs: number, windowMs = DAY_MS, file: string = paths.logFile()): HookHealthSummary {
  const since = nowMs - windowMs
  const out: HookHealthSummary = { failures: 0, failClosed: 0 }
  for (const f of [`${file}.1`, file]) {
    let text: string
    try { text = readFileSync(f, 'utf8') } catch { continue }
    for (const line of text.split('\n')) {
      const x = failureOf(line, since)
      if (x === undefined) continue
      out.failures++
      if (x.result === 'fail-closed') out.failClosed++
      if (out.last === undefined || x.ts >= out.last.ts) out.last = x
    }
  }
  return out
}

export function hookHealthCacheFile(): string {
  return join(paths.buracleHome(), 'cache', 'hook-health.json')
}

export function hookHealthForStatus(nowMs: number, maxAgeMs = 60_000): HookHealthSummary {
  const file = hookHealthCacheFile()
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown, summary?: HookHealthSummary }
    if (typeof c.at === 'number' && nowMs - c.at >= 0 && nowMs - c.at < maxAgeMs && c.summary !== undefined && typeof c.summary.failures === 'number') return c.summary
  } catch {  }
  let summary: HookHealthSummary
  try { summary = scanHookFailures(nowMs) } catch { return { failures: 0, failClosed: 0 } }
  try { atomicWriteSync(file, JSON.stringify({ at: nowMs, summary }) + '\n') } catch {  }
  return summary
}

export function runtimeDriftCacheFile(): string {
  return join(paths.buracleHome(), 'cache', 'runtime-drift.json')
}

export function clearRuntimeDriftCache(): void {
  try { rmSync(runtimeDriftCacheFile(), { force: true }) } catch {  }
}

function shimStamp(): string {
  try {
    const s = statSync(join(paths.binDir(), 'buracle'))
    return `${s.size}:${s.mtimeMs}`
  } catch { return '' }
}

export async function runtimeBehindForStatus(nowMs: number, maxAgeMs = 300_000): Promise<boolean> {
  const file = runtimeDriftCacheFile()
  const stamp = shimStamp()
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as { at?: unknown, behind?: unknown, shim?: unknown }
    if (typeof c.at === 'number' && nowMs - c.at >= 0 && nowMs - c.at < maxAgeMs && typeof c.behind === 'boolean' && c.shim === stamp) return c.behind
  } catch {  }
  let behind = false
  try {
    const { readShim, runtimeHealth } = await import('./update/runtime')
    const shim = readShim()
    if (shim?.mode === 'frozen' && shim.checkout !== undefined) {
      const h = runtimeHealth(shim.checkout, shim)
      behind = h.problems.length > 0 || (h.drift !== undefined && h.drift !== 'current' && h.drift !== 'unknown')
    }
  } catch { return false }
  if (!existsSync(paths.buracleHome())) return behind
  try { atomicWriteSync(file, JSON.stringify({ at: nowMs, behind, shim: stamp }) + '\n') } catch {  }
  return behind
}

export async function statusHealth(nowMs: number): Promise<HookHealth> {
  const f = hookHealthForStatus(nowMs)
  const behind = await runtimeBehindForStatus(nowMs)
  return behind ? { failures: f.failures, failClosed: f.failClosed, runtimeBehind: true } : { failures: f.failures, failClosed: f.failClosed }
}
