import type { CommandIO } from '../router'
import type { Harness } from '../../core/events'
import { HARNESSES, isHarness } from '../../core/events'
import { formatResetIn } from '../../core/status/format'
import { loadConfigSync } from '../../engine/config'
import { log } from '../../engine/log'
import { acquireUsageLock, currentUsageEntry, isStale, readUsageCache } from '../../usage/cache'
import { refreshUsage } from '../../usage/index'
import type { UsageCacheEntry } from '../../usage/types'

export const name = 'usage'
export const summary = 'Collect usage per harness and refresh the usage cache'
export const usage = `Usage: buracle usage [refresh] [--harness <h>] [--offline] [--json]

  (no verb)   show the cached usage; stale or missing entries are collected first
  refresh     collect now (incremental) and update ~/.buracle/state/usage.json

Options:
  --harness   ${HARNESSES.join(' | ')} (repeatable or comma-separated; default: enabled harnesses)
  --offline   do not call provider usage endpoints (omp usage --json)
  --json      {v, computed_at, harnesses: {<h>: snapshot}, errors?}

Shows the rate-limit windows each harness reports (5-hour, 7-day), with the time they reset.`

export interface UsageArgs { refresh: boolean; harnesses?: Harness[]; offline: boolean; json: boolean; background: boolean }

export function parseUsageArgs(argv: string[]): UsageArgs | { error: string } {
  const a: UsageArgs = { refresh: false, offline: false, json: false, background: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    switch (flag) {
      case 'refresh': a.refresh = true; break
      case '--json': a.json = true; break
      case '--verbose': case '-v': break
      case '--offline': a.offline = true; break
      case '--background': a.background = true; a.refresh = true; break
      case '--harness': {
        const v = inline ?? argv[++i]
        if (v === undefined) return { error: '--harness expects a harness name' }
        for (const h of v.split(',').map(s => s.trim()).filter(Boolean)) {
          if (!isHarness(h)) return { error: `unknown harness '${h}' (expected ${HARNESSES.join(', ')})` }
          a.harnesses = [...new Set([...(a.harnesses ?? []), h])]
        }
        break
      }
      default:
        return { error: arg.startsWith('-') ? `unknown option ${arg}` : `unknown argument ${arg}` }
    }
  }
  return a
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length)
}

function windowsText(e: UsageCacheEntry, nowMs: number): string {
  const parts = e.windows.map(w => {
    const reset = w.resetsAt !== undefined && Number.isFinite(Date.parse(w.resetsAt)) ? ` ↺${formatResetIn(Date.parse(w.resetsAt), nowMs)}` : ''
    return `${w.label} ${Math.round(w.pct)}%${reset}`
  })
  return parts.join(' · ')
}

export function formatUsageReport(entries: UsageCacheEntry[], nowMs: number): string {
  const lines = ['Usage']
  for (const e of entries) {
    const win = windowsText(e, nowMs)
    lines.push(`${pad(e.harness, 9)} ${win !== '' ? win : '–'}`.trimEnd())
    for (const n of e.notes ?? []) lines.push(`  note: ${n}`)
  }
  return lines.join('\n') + '\n'
}

export interface UsageDeps { nowMs?: number; refresh?: typeof refreshUsage }

export async function runUsage(args: UsageArgs, io: Pick<CommandIO, 'stdout' | 'stderr'>, deps: UsageDeps = {}): Promise<number> {
  const nowMs = deps.nowMs ?? Date.now()
  const doRefresh = deps.refresh ?? refreshUsage
  const config = loadConfigSync().config
  const harnesses = args.harnesses ?? HARNESSES.filter(h => config.harnesses[h].enabled)
  const cached = readUsageCache()

  let need: Harness[] = harnesses
  if (!args.refresh) need = harnesses.filter(h => isStale(cached?.harnesses[h], nowMs))
  if (args.background) {
    need = harnesses.filter(h => isStale(cached?.harnesses[h], nowMs, 60_000))
    if (need.length === 0) return 0
  }

  const entries = new Map<Harness, UsageCacheEntry>()
  const errors: Array<{ harness: Harness, error: string }> = []
  for (const h of harnesses) { const e = currentUsageEntry(cached, h, nowMs); if (e !== undefined) entries.set(h, e) }

  if (need.length > 0) {
    const release = acquireUsageLock(nowMs, { waitMs: args.background ? 0 : 15_000 })
    if (release === undefined) {
      if (args.background) return 0
      io.stderr.write('buracle usage: another refresh is running; showing the cached values\n')
    } else {
      try {
        const r = await doRefresh({ harnesses: need, nowMs, offline: args.offline })
        for (const e of r.entries) entries.set(e.harness, e)
        errors.push(...r.errors)
      } catch (e) {
        log('error', 'usage refresh failed', { error: e })
        errors.push({ harness: need[0] as Harness, error: e instanceof Error ? e.message : String(e) })
      } finally {
        release()
      }
    }
  }
  if (args.background) return 0

  const list = harnesses.flatMap(h => { const e = entries.get(h); return e === undefined ? [] : [e] })
  if (args.json) {
    const out: Record<string, unknown> = {
      v: 1,
      computed_at: new Date(nowMs).toISOString(),
      harnesses: Object.fromEntries(list.map(e => [e.harness, e])),
    }
    if (errors.length > 0) out['errors'] = errors
    io.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } else {
    io.stdout.write(formatUsageReport(list, nowMs))
    for (const e of errors) io.stderr.write(`buracle usage: ${e.harness}: ${e.error}\n`)
  }
  return errors.length === 0 ? 0 : list.length > 0 ? 2 : 1
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const args = parseUsageArgs(argv)
  if ('error' in args) {
    io.stderr.write(`buracle usage: ${args.error}\n${usage}\n`)
    return 1
  }
  if (io.flags.json) args.json = true
  return runUsage(args, io)
}
