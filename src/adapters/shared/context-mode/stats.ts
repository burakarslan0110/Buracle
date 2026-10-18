import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Harness } from '../../../core/events'
import { cmSessionsDir, cmStorageRoot } from '../../../engine/context-mode'
import { harnessOfProcess } from '../../../workflow/session-store'

export interface CmStats {
  file: string
  schemaVersion: number
  version?: string
  updatedAt: number
  keptOut: number
  totalProcessed: number
  reductionPct: number
  tokensSaved: number
  totalCalls: number
  bytesReturned: number
  byTool: Record<string, { calls: number, bytes: number }>
}

export const CM_STATS_MAX_AGE_MS = 15 * 60_000

const STATS_ID = /^[A-Za-z0-9._-]+$/

function num(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}

export function parseCmStats(raw: unknown, file: string): CmStats | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const r = raw as Record<string, unknown>
  const updatedAt = num(r['updated_at'])
  const keptOut = num(r['kept_out'])
  const totalProcessed = num(r['total_processed'])
  if (updatedAt === undefined || keptOut === undefined || totalProcessed === undefined) return undefined
  const byTool: Record<string, { calls: number, bytes: number }> = {}
  const tools = r['by_tool']
  if (tools !== null && typeof tools === 'object' && !Array.isArray(tools)) {
    for (const [name, v] of Object.entries(tools as Record<string, unknown>)) {
      if (v === null || typeof v !== 'object') continue
      const t = v as Record<string, unknown>
      byTool[name] = { calls: num(t['calls']) ?? 0, bytes: num(t['bytes']) ?? 0 }
    }
  }
  const stats: CmStats = {
    file,
    schemaVersion: num(r['schemaVersion']) ?? 0,
    updatedAt,
    keptOut,
    totalProcessed,
    reductionPct: num(r['reduction_pct']) ?? (totalProcessed > 0 ? Math.round((keptOut / totalProcessed) * 100) : 0),
    tokensSaved: num(r['tokens_saved']) ?? Math.round(keptOut / 4),
    totalCalls: num(r['total_calls']) ?? 0,
    bytesReturned: num(r['bytes_returned']) ?? Math.max(0, totalProcessed - keptOut),
    byTool,
  }
  if (typeof r['version'] === 'string') stats.version = r['version']
  return stats
}

function readStats(file: string): CmStats | undefined {
  try { return parseCmStats(JSON.parse(readFileSync(file, 'utf8')) as unknown, file) } catch { return undefined }
}

export interface CmStatsQuery {
  sessionId?: string
  pid?: number
  maxAgeMs?: number
  nowMs?: number
}

export function readCmStats(h: Harness, projectDir: string, q: CmStatsQuery = {}): CmStats | undefined {
  let dir: string
  try { dir = cmSessionsDir(cmStorageRoot(h, projectDir)) } catch { return undefined }
  const named: string[] = []
  if (q.sessionId !== undefined && STATS_ID.test(q.sessionId)) named.push(`stats-${q.sessionId}.json`)
  if (q.pid !== undefined && Number.isInteger(q.pid) && q.pid > 0) named.push(`stats-pid-${q.pid}.json`)
  for (const name of named) {
    const s = readStats(join(dir, name))
    if (s !== undefined) return s
  }
  const now = q.nowMs ?? Date.now()
  const maxAge = q.maxAgeMs ?? CM_STATS_MAX_AGE_MS
  let best: CmStats | undefined
  let names: string[]
  try { names = readdirSync(dir) } catch { return undefined }
  for (const name of names.sort()) {
    if (!name.startsWith('stats-') || !name.endsWith('.json')) continue
    const file = join(dir, name)
    try { if (now - statSync(file).mtimeMs > maxAge) continue } catch { continue }
    const s = readStats(file)
    if (s === undefined || now - s.updatedAt > maxAge) continue
    if (best === undefined || s.updatedAt > best.updatedAt) best = s
  }
  return best
}

export type CmProcessRow = (pid: number) => { ppid: number, comm: string } | undefined

function psRow(pid: number): { ppid: number, comm: string } | undefined {
  try {
    const r = Bun.spawnSync(['ps', '-o', 'ppid=,comm=', '-p', String(pid)], {
      stdin: 'ignore', stdout: 'pipe', stderr: 'ignore', timeout: 1000,
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LC_ALL: 'C' },
    })
    if (r.exitCode !== 0) return undefined
    const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(new TextDecoder().decode(r.stdout).split('\n')[0] ?? '')
    return m ? { ppid: Number(m[1]), comm: m[2] as string } : undefined
  } catch {
    return undefined
  }
}

export function harnessPidFromAncestors(h: Harness, opts: { startPid?: number, maxDepth?: number, budgetMs?: number, env?: Record<string, string | undefined>, ps?: CmProcessRow } = {}): number | undefined {
  if (process.platform === 'win32' && opts.ps === undefined) return undefined
  const ps = opts.ps ?? psRow
  let pid = opts.startPid ?? process.ppid
  const deadline = Date.now() + (opts.budgetMs ?? 250)
  const maxDepth = opts.maxDepth ?? 24
  const env = opts.env ?? process.env
  for (let depth = 0; depth < maxDepth && pid > 1 && Date.now() <= deadline; depth++) {
    const row = ps(pid)
    if (row === undefined) return undefined
    if (harnessOfProcess(row.comm, pid, env) === h) return pid
    if (row.ppid === pid) return undefined
    pid = row.ppid
  }
  return undefined
}
