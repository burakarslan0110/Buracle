import { readdirSync } from 'node:fs'
import type { Harness } from '../../core/events'
import { HARNESSES, isHarness } from '../../core/events'
import { memShortSid } from '../../core/memory/text'
import { loadConfigSync } from '../../engine/config'
import * as paths from '../../engine/paths'
import { tilde } from '../../engine/update/output'
import { currentUsageEntry, isStale, readUsageCache, spawnUsageRefresh } from '../../usage/cache'
import { sessionUsage, usageHistory, type UsageAmount } from '../../usage/history'
import { readTelemetry } from '../../workflow/session-store'
import { sessionRecordsDir } from '../layout'
import { projectExclusion, readProjectsCache, slugExclusion } from '../project'
import { readSessionRecord, type SessionRecord } from '../session-record'

const DAY_MS = 86_400_000
export const YIELD_DAYS = 30

export interface SessionRow {
  harness: Harness
  sid: string
  short: string
  status: 'active' | 'ended'
  startedAt: string
  endedAt?: string
  project?: string
  projectName?: string
  folder?: string
  excluded?: boolean
  branch?: string
  model?: string
  memoryId?: string
  runner?: boolean
  prompts?: number
  turns?: number
  tools?: number
  commands?: number
  files?: number
  tests?: number
  testFailures?: number
  commits?: number
  filesChanged?: number
  insertions?: number
  deletions?: number
  topTools?: Array<[string, number]>
  tokens?: number
  usd?: number
  costFrom?: 'records' | 'harness'
}

function records(): SessionRecord[] {
  let names: string[] = []
  try { names = readdirSync(sessionRecordsDir()) } catch { return [] }
  const out: SessionRecord[] = []
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const dash = n.indexOf('-')
    const h = n.slice(0, dash)
    const sid = n.slice(dash + 1, -'.json'.length)
    if (!isHarness(h) || !paths.isValidSessionId(sid)) continue
    const rec = readSessionRecord(h, sid)
    if (rec !== undefined && typeof rec.startedMs === 'number') out.push(rec)
  }
  return out
}

function iso(ms: number | undefined): string | undefined {
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : undefined
}

export async function sessionRows(nowMs: number): Promise<SessionRow[]> {
  const recs = records().sort((a, b) => b.startedMs - a.startedMs || (a.sid < b.sid ? -1 : 1))
  if (recs.length === 0) return []
  const since = Math.min(...recs.map(r => r.startedMs))
  let usage = new Map<string, UsageAmount>()
  try { usage = sessionUsage({ nowMs, sinceMs: since }) } catch {  }
  const projects = readProjectsCache().projects
  const excluded = new Map<string, boolean>()
  const keptOut = async (key: string, why: () => Promise<string | undefined>): Promise<boolean> => {
    let known = excluded.get(key)
    if (known === undefined) {
      known = (await why().catch(() => undefined)) !== undefined
      excluded.set(key, known)
    }
    return known
  }
  const out: SessionRow[] = []
  for (const r of recs) {
    const row: SessionRow = { harness: r.harness, sid: r.sid, short: memShortSid(r.sid), status: r.status === 'ended' ? 'ended' : 'active', startedAt: iso(r.startedMs) as string }
    const ended = iso(r.stats?.endedMs ?? r.finalizedMs)
    if (ended !== undefined && r.status === 'ended') row.endedAt = ended
    const slug = r.slug
    if ((slug !== undefined && await keptOut(`slug:${slug}`, () => slugExclusion(slug))) || await keptOut(`cwd:${r.cwd}`, () => projectExclusion(r.cwd))) {
      row.excluded = true
      out.push(row)
      continue
    }
    if (slug !== undefined) {
      row.project = slug
      const name = projects[slug]?.ownerRepo
      if (name !== undefined && name !== '') row.projectName = name
    }
    row.folder = tilde(r.cwd)
    if (r.branch !== undefined) row.branch = r.branch
    if (r.memoryId !== undefined) row.memoryId = r.memoryId
    const tel = readTelemetry(r.harness, r.sid)
    if (tel?.runner === true) row.runner = true
    const s = r.stats
    if (s !== undefined) {
      for (const k of ['prompts', 'turns', 'tools', 'commands', 'files', 'tests', 'testFailures', 'commits', 'filesChanged', 'insertions', 'deletions'] as const) {
        const v = s[k]
        if (typeof v === 'number') row[k] = v
      }
      if (Array.isArray(s.topTools)) row.topTools = s.topTools
    }
    const model = s?.model ?? tel?.model
    if (model !== undefined) row.model = model
    const u = usage.get(`${r.harness}:${r.sid}`)
    if (u !== undefined) {
      row.tokens = u.tokens
      if (u.usd !== undefined) row.usd = u.usd
      row.costFrom = 'records'
    } else if (typeof tel?.costUsd === 'number' && tel.costUsd > 0) {
      row.usd = Math.round(tel.costUsd * 1e6) / 1e6
      row.costFrom = 'harness'
    }
    if (row.tokens === undefined && typeof s?.tokens === 'number') row.tokens = s.tokens
    out.push(row)
  }
  return out
}

export function workYield(rows: readonly SessionRow[], nowMs: number, days = YIELD_DAYS): Record<string, unknown> {
  const since = nowMs - days * DAY_MS
  const recent = rows.filter(r => Date.parse(r.startedAt) >= since && r.runner !== true && r.excluded !== true)
  const counted = recent.filter(r => r.status === 'ended' && r.commits !== undefined)
  const landed = counted.filter(r => (r.commits ?? 0) > 0)
  const commits = counted.reduce((n, r) => n + (r.commits ?? 0), 0)
  const priced = counted.filter(r => r.usd !== undefined)
  const pricedCommits = priced.reduce((n, r) => n + (r.commits ?? 0), 0)
  const usd = Math.round(priced.reduce((n, r) => n + (r.usd ?? 0), 0) * 1e6) / 1e6
  return {
    days, sessions: recent.length, counted: counted.length, landed: landed.length, commits,
    usd, priced: priced.length, pricedCommits,
    ...(pricedCommits > 0 ? { perCommit: Math.round((usd / pricedCommits) * 1e4) / 1e4 } : {}),
  }
}

export async function sessionsPayload(nowMs: number): Promise<Record<string, unknown>> {
  const rows = await sessionRows(nowMs)
  return { now: new Date(nowMs).toISOString(), harnesses: [...HARNESSES], sessions: rows, yield: workYield(rows, nowMs) }
}

export async function usagePayload(nowMs: number): Promise<Record<string, unknown>> {
  let enabled: Record<Harness, boolean> = { claude: true, codex: true, opencode: true, omp: true }
  try {
    const c = loadConfigSync().config
    enabled = Object.fromEntries(HARNESSES.map(h => [h, c.harnesses[h].enabled])) as Record<Harness, boolean>
  } catch {  }
  const history = usageHistory({ nowMs })
  const cache = readUsageCache()
  const refreshing: Harness[] = []
  const harnesses: Record<string, unknown> = {}
  for (const h of HARNESSES) {
    const e = currentUsageEntry(cache, h, nowMs)
    if (enabled[h] && isStale(e, nowMs) && process.env['BURACLE_NO_AUTOSTART'] !== '1' && spawnUsageRefresh(h)) refreshing.push(h)
    const hist = history.harnesses[h]
    harnesses[h] = {
      enabled: enabled[h],
      ...(e !== undefined ? { computedAt: e.computed_at, windows: e.windows, ...(e.month_pct !== undefined ? { monthPct: e.month_pct } : {}) } : { windows: [] }),
      days: hist.days, months: hist.months, models: hist.models,
      ...(hist.notes !== undefined || (e?.notes?.length ?? 0) > 0 ? { notes: [...(hist.notes ?? []), ...(e?.notes ?? [])] } : {}),
    }
  }
  const rows = await sessionRows(nowMs)
  return { now: new Date(nowMs).toISOString(), days: history.days, months: history.months, harnesses, refreshing, yield: workYield(rows, nowMs) }
}
