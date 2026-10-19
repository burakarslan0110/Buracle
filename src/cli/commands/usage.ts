import type { CommandIO } from '../router'
import type { Harness } from '../../core/events'
import { HARNESSES, isHarness } from '../../core/events'
import { formatResetIn, formatTokens, formatUsd } from '../../core/status/format'
import { loadConfigSync } from '../../engine/config'
import { log } from '../../engine/log'
import { acquireUsageLock, currentUsageEntry, isStale, readUsageCache } from '../../usage/cache'
import { refreshUsage } from '../../usage/index'
import { isMonthKey, monthKeyOf } from '../../usage/month'
import type { UsageCacheEntry } from '../../usage/types'

export const name = 'usage'
export const summary = 'Collect usage per harness and refresh the usage cache'
export const usage = `Usage: buracle usage [refresh] [--harness <h>] [--month [YYYY-MM]] [--daily] [--offline] [--json]

  (no verb)   show the cached usage; stale or missing entries are collected first
  refresh     collect now (incremental) and update ~/.buracle/state/usage.json

Options:
  --harness   ${HARNESSES.join(' | ')} (repeatable or comma-separated; default: enabled harnesses)
  --month     show the per-model breakdown; with YYYY-MM, report that month instead of this one
  --daily     add one line per day of the month: the estimate and tokens of each harness that day
  --offline   do not call provider usage endpoints (omp usage --json)
  --json      {v, month, computed_at, harnesses: {<h>: snapshot with days[]}, errors?}

Month totals are local-calendar month to date, priced at list prices (canonical/pricing.yaml) where
the harness records no cost: an estimate (≈), not a bill.`

export interface UsageArgs { refresh: boolean; harnesses?: Harness[]; month?: string; breakdown: boolean; daily?: boolean; offline: boolean; json: boolean; background: boolean }

export function parseUsageArgs(argv: string[]): UsageArgs | { error: string } {
  const a: UsageArgs = { refresh: false, breakdown: false, offline: false, json: false, background: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined]
    switch (flag) {
      case 'refresh': a.refresh = true; break
      case '--json': a.json = true; break
      case '--verbose': case '-v': break
      case '--offline': a.offline = true; break
      case '--daily': a.daily = true; break
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
      case '--month': {
        a.breakdown = true
        const v = inline ?? (argv[i + 1] !== undefined && isMonthKey(argv[i + 1] as string) ? argv[++i] : undefined)
        if (v !== undefined) {
          if (!isMonthKey(v)) return { error: '--month expects YYYY-MM' }
          a.month = v
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
  if (e.month_pct !== undefined) parts.push(`mo ${Math.round(e.month_pct)}%`)
  return parts.join(' · ')
}

function dailyLines(entries: UsageCacheEntry[]): string[] {
  const byDay = new Map<string, Array<{ harness: string, tokens: number, usd?: number }>>()
  for (const e of entries) for (const d of e.days ?? []) byDay.set(d.day, [...(byDay.get(d.day) ?? []), { harness: e.harness, tokens: d.tokens, ...(d.usd !== undefined ? { usd: d.usd } : {}) }])
  if (byDay.size === 0) return ['By day: no usage recorded this month']
  const lines = ['By day']
  for (const day of [...byDay.keys()].sort()) {
    const parts = byDay.get(day) ?? []
    const usd = parts.reduce<number | undefined>((n, p) => (p.usd === undefined ? n : (n ?? 0) + p.usd), undefined)
    const tokens = parts.reduce((n, p) => n + p.tokens, 0)
    const each = parts.map(p => `${p.harness} ${p.usd !== undefined ? `≈${formatUsd(p.usd)}` : `${formatTokens(p.tokens)} tok`}`).join(' · ')
    lines.push(`  ${day}  ${pad(usd !== undefined ? `≈${formatUsd(usd)}` : '–', 10)} ${pad(`${formatTokens(tokens)} tok`, 11)} ${each}`.trimEnd())
  }
  return lines
}

export function formatUsageReport(entries: UsageCacheEntry[], month: string, breakdown: boolean, nowMs: number, daily = false): string {
  const lines = [`Usage · ${month} · month to date (≈ list-price estimate)`]
  for (const e of entries) {
    const usd = e.month.usd !== undefined ? `≈${formatUsd(e.month.usd)}` : '–'
    const win = windowsText(e, nowMs)
    lines.push(`${pad(e.harness, 9)} ${pad(usd, 10)} ${pad(`${formatTokens(e.month.tokens)} tok`, 11)}${win ? ` ${win}` : ''}`.trimEnd())
    if (breakdown) {
      for (const [model, m] of Object.entries(e.month.byModel).sort((a, b) => b[1].tokens - a[1].tokens)) {
        lines.push(`  ${pad(model, 34)} ${pad(`${formatTokens(m.tokens)} tok`, 11)} ${m.usd !== undefined ? `≈${formatUsd(m.usd)}` : 'unpriced'}`)
      }
    }
    for (const n of e.notes ?? []) lines.push(`  note: ${n}`)
  }
  if (daily) lines.push(...dailyLines(entries))
  return lines.join('\n') + '\n'
}

export interface UsageDeps { nowMs?: number; refresh?: typeof refreshUsage }

export async function runUsage(args: UsageArgs, io: Pick<CommandIO, 'stdout' | 'stderr'>, deps: UsageDeps = {}): Promise<number> {
  const nowMs = deps.nowMs ?? Date.now()
  const doRefresh = deps.refresh ?? refreshUsage
  const config = loadConfigSync().config
  const harnesses = args.harnesses ?? HARNESSES.filter(h => config.harnesses[h].enabled)
  const month = args.month ?? monthKeyOf(nowMs)
  const current = month === monthKeyOf(nowMs)
  const cached = readUsageCache()

  let need: Harness[] = harnesses
  if (!args.refresh && current) need = harnesses.filter(h => isStale(cached?.harnesses[h], nowMs) || (args.daily === true && cached?.harnesses[h]?.days === undefined))
  if (args.background) {
    need = harnesses.filter(h => isStale(cached?.harnesses[h], nowMs, 60_000))
    if (need.length === 0) return 0
  }

  const entries = new Map<Harness, UsageCacheEntry>()
  const errors: Array<{ harness: Harness, error: string }> = []
  if (current) for (const h of harnesses) { const e = currentUsageEntry(cached, h, nowMs); if (e !== undefined) entries.set(h, e) }

  if (need.length > 0) {
    const release = acquireUsageLock(nowMs, { waitMs: args.background ? 0 : 15_000 })
    if (release === undefined) {
      if (args.background) return 0
      io.stderr.write('buracle usage: another refresh is running; showing the cached values\n')
    } else {
      try {
        const r = await doRefresh({ harnesses: need, nowMs, month, offline: args.offline, write: current })
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
      month,
      computed_at: new Date(nowMs).toISOString(),
      harnesses: Object.fromEntries(list.map(e => [e.harness, e])),
    }
    if (errors.length > 0) out['errors'] = errors
    io.stdout.write(JSON.stringify(out, null, 2) + '\n')
  } else {
    io.stdout.write(formatUsageReport(list, month, args.breakdown, nowMs, args.daily === true))
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
