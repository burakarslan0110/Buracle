import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { BuracleConfig } from '../core/config'
import type { Harness } from '../core/events'
import type { BandView } from '../core/flow/band'
import { bandPlanOf, bandView } from '../core/flow/band'
import type { MemoryStatus } from '../core/memory/status'
import { gitFromPorcelainV2 } from '../core/status/git'
import { indexStatusOf } from '../core/status/live'
import type { BarModel, GitState, IndexStatus, RateWindow, StatusLayout } from '../core/status/model'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { projectSlug } from '../engine/git'
import { buracleHome, canonicalDir, home, isValidSessionId, memoryStateDir, updatesFile } from '../engine/paths'
import { run } from '../engine/proc'
import { DEFAULT_FOLD_SEC, bandInputFor } from '../workflow/flow'
import type { Telemetry } from '../workflow/session-store'
import { loadState, readTelemetry } from '../workflow/session-store'
import { workspaceInfo } from '../workflow/workspace'
import { monthKeyOf } from './month'
import { latestTelemetry, liveWindows } from './telemetry'
import type { UsageCacheEntry } from './types'

type Obj = Record<string, unknown>

function obj(x: unknown): Obj | undefined {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Obj : undefined
}
function str(x: unknown): string | undefined {
  return typeof x === 'string' && x.trim() !== '' ? x : undefined
}
function finite(x: unknown): number | undefined {
  return typeof x === 'number' && Number.isFinite(x) ? x : undefined
}

export const FALLBACK_LAYOUT: StatusLayout = {
  rows: [['model', 'ctx', 'windows', 'month'], ['git', 'mem', 'index', 'flow', 'plan', 'upd', 'hooks']],
  thresholds: { ctxWarn: 75, ctxCrit: 90 },
  emoji: false,
}

function isRows(x: unknown): x is string[][] {
  return Array.isArray(x) && x.every(r => Array.isArray(r) && r.every(id => typeof id === 'string'))
}

export function validateLayout(x: unknown): string[] {
  const e = obj(x)
  if (e === undefined) return ['expected a mapping']
  const errors: string[] = []
  if (!isRows(e['rows'])) errors.push('rows: expected a list of lists of segment ids')
  if (e['compact'] !== undefined && !isRows(e['compact'])) errors.push('compact: expected a list of lists of segment ids')
  const t = obj(e['thresholds'])
  if (t === undefined || finite(t['ctxWarn']) === undefined || finite(t['ctxCrit']) === undefined) errors.push('thresholds: expected { ctxWarn, ctxCrit } numbers')
  if (typeof e['emoji'] !== 'boolean') errors.push('emoji: expected a boolean')
  if (e['native'] !== undefined && obj(e['native']) === undefined) errors.push('native: expected a mapping')
  return errors
}

export function loadLayout(h: Harness, path = join(canonicalDir(), 'statusline.yaml')): StatusLayout {
  try {
    const doc = obj(parseYaml(readFileSync(path, 'utf8')) as unknown)
    const e = doc?.[h]
    if (e !== undefined && validateLayout(e).length === 0) return e as StatusLayout
  } catch {  }
  return FALLBACK_LAYOUT
}

export function effectiveLayout(layout: StatusLayout, cfg: BuracleConfig['statusline'], style?: 'buracle' | 'full' | 'compact'): StatusLayout {
  const s = style ?? cfg.style
  const out: StatusLayout = { ...layout, emoji: layout.emoji && cfg.emoji }
  if (s === 'compact' && layout.compact !== undefined) out.rows = layout.compact
  return out
}

export interface ClaudePayload {
  sessionId?: string
  cwd: string
  projectDir?: string
  worktree?: string
  model?: string
  modelId?: string
  effort?: string
  ctx?: NonNullable<BarModel['ctx']>
  windows: RateWindow[]
  hasRateLimits: boolean
  costUsd?: number
  monthPct?: number
  monthUsd?: number
  version?: string
  lines?: { added: number, removed: number }
}

function epochIso(s: unknown): string | undefined {
  const v = finite(s)
  return v !== undefined && v > 0 ? new Date(v * 1000).toISOString() : undefined
}

export function readClaudePayload(j: unknown, fallbackCwd: string): ClaudePayload {
  const o = obj(j) ?? {}
  const ws = obj(o['workspace'])
  const cwd = str(ws?.['current_dir']) ?? str(o['cwd']) ?? fallbackCwd
  const out: ClaudePayload = { cwd, windows: [], hasRateLimits: false }
  const sid = o['session_id']
  if (isValidSessionId(sid)) out.sessionId = sid
  const projectDir = str(ws?.['project_dir'])
  if (projectDir !== undefined) out.projectDir = projectDir
  const wtName = str(obj(o['worktree'])?.['name'])
  const linked = str(ws?.['git_worktree'])
  if (wtName !== undefined) out.worktree = wtName
  else if (linked !== undefined) out.worktree = linked.split(/[\\/]/u).filter(Boolean).pop() ?? linked
  const m = obj(o['model'])
  const model = str(m?.['display_name']) ?? str(m?.['id'])
  if (model !== undefined) out.model = model.replace(/^Claude\s+/u, '')
  const modelId = str(m?.['id'])
  if (modelId !== undefined) out.modelId = modelId
  const effort = str(obj(o['effort'])?.['level'])
  if (effort !== undefined) out.effort = effort

  const cw = obj(o['context_window'])
  if (cw !== undefined) {
    const size = finite(cw['context_window_size'])
    const cu = obj(cw['current_usage'])
    const tokens = cu === undefined ? undefined
      : (finite(cu['input_tokens']) ?? 0) + (finite(cu['cache_creation_input_tokens']) ?? 0) + (finite(cu['cache_read_input_tokens']) ?? 0)
    let pct = finite(cw['used_percentage'])
    if (pct === undefined && tokens !== undefined && size !== undefined && size > 0) pct = (tokens / size) * 100
    if (pct !== undefined) {
      const ctx: NonNullable<BarModel['ctx']> = { pct }
      if (tokens !== undefined) ctx.tokens = tokens
      if (size !== undefined) ctx.window = size
      out.ctx = ctx
    }
  }

  const rl = obj(o['rate_limits'])
  if (rl !== undefined) {
    const known: Array<[string, string, number]> = [['five_hour', '5h', 300], ['seven_day', '7d', 10080]]
    for (const [key, label, minutes] of known) {
      const w = obj(rl[key])
      const pct = finite(w?.['used_percentage'])
      if (pct === undefined) continue
      const rw: RateWindow = { pct, label, windowMinutes: minutes }
      const at = epochIso(w?.['resets_at'])
      if (at !== undefined) rw.resetsAt = at
      out.windows.push(rw)
    }
    const spend = obj(rl['spend_limit'])
    if (spend !== undefined && finite(spend['used_percentage']) !== undefined) {
      out.monthPct = finite(spend['used_percentage'])
      const used = finite(spend['used_usd'])
      if (used !== undefined) out.monthUsd = used
    }
    out.hasRateLimits = out.windows.length > 0 || out.monthPct !== undefined
  }
  const costObj = obj(o['cost'])
  const cost = finite(costObj?.['total_cost_usd'])
  if (cost !== undefined) out.costUsd = cost
  const added = finite(costObj?.['total_lines_added'])
  const removed = finite(costObj?.['total_lines_removed'])
  if (added !== undefined || removed !== undefined) out.lines = { added: added ?? 0, removed: removed ?? 0 }
  const version = str(o['version'])
  if (version !== undefined) out.version = version
  return out
}

export interface GitInfo { git: GitState; toplevel?: string }

const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' }

export async function gitInfo(cwd: string, budgetMs = 300): Promise<GitInfo | undefined> {
  const opts = { cwd, timeoutMs: budgetMs, env: GIT_ENV }
  const [st, rp] = await Promise.all([
    run(['git', 'status', '--porcelain=v2', '--branch', '--show-stash'], opts),
    run(['git', 'rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir', '--show-toplevel'], opts),
  ])
  let status = st
  let stash: number | undefined
  if (status.code !== 0 && !status.timedOut && /show-stash/u.test(status.stderr)) {
    const [plain, list] = await Promise.all([
      run(['git', 'status', '--porcelain=v2', '--branch'], opts),
      run(['git', 'stash', 'list'], opts),
    ])
    status = plain
    if (list.code === 0) stash = list.stdout.split('\n').filter(l => l.trim() !== '').length
  }
  if (status.code !== 0 || status.timedOut) return undefined
  const [gitDir, commonDir, toplevel] = rp.code === 0 && !rp.timedOut ? rp.stdout.split('\n').map(s => s.trim()) : []
  const git = gitFromPorcelainV2(status.stdout, gitDir || undefined, commonDir || undefined)
  if (stash !== undefined) git.stash = stash
  const out: GitInfo = { git }
  if (toplevel) out.toplevel = toplevel
  return out
}

export function tildePath(p: string, homeDir = home()): string {
  const abs = resolve(p)
  const h = resolve(homeDir)
  if (abs === h) return '~'
  if (abs.startsWith(h + sep)) return `~${sep}${abs.slice(h.length + 1)}`
  return abs
}

export function dirLabel(cwd: string, info: GitInfo | undefined): string | undefined {
  const abs = resolve(cwd)
  if (info === undefined) return tildePath(abs)
  const top = info.toplevel
  if (top !== undefined && abs !== resolve(top)) {
    const rel = relative(resolve(top), abs)
    if (rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)) return info.git.worktree ? `${info.git.worktree}${sep}${rel}` : rel
  }
  if (info.git.worktree !== undefined) return tildePath(top ?? abs)
  return undefined
}

interface SlugCache { v: 1; slugs: Record<string, { slug: string, at: number }> }
const SLUG_TTL_MS = 60 * 60_000

function slugCacheFile(): string {
  return join(buracleHome(), 'cache', 'statusline-slugs.json')
}

export async function cachedProjectSlug(cwd: string, nowMs: number): Promise<string | undefined> {
  const key = resolve(cwd)
  const file = slugCacheFile()
  const r = readJsonSafeSync<SlugCache>(file)
  const cache: SlugCache = r.ok && r.value?.v === 1 && obj(r.value.slugs) !== undefined ? r.value : { v: 1, slugs: {} }
  const hit = cache.slugs[key]
  if (hit !== undefined && typeof hit.slug === 'string' && nowMs - hit.at < SLUG_TTL_MS && nowMs >= hit.at) return hit.slug
  let slug: string
  try { slug = await projectSlug(key) } catch { return hit?.slug }
  cache.slugs[key] = { slug, at: nowMs }
  const entries = Object.entries(cache.slugs).sort((a, b) => b[1].at - a[1].at).slice(0, 200)
  try { atomicWriteSync(file, JSON.stringify({ v: 1, slugs: Object.fromEntries(entries) }) + '\n') } catch {  }
  return slug
}

function isMemoryStatus(x: unknown): x is MemoryStatus {
  const s = obj(x)
  const counts = obj(s?.['counts'])
  return s !== undefined && s['v'] === 2 && typeof s['health'] === 'string' && counts !== undefined && typeof counts['project'] === 'number'
    && typeof counts['person'] === 'number' && Array.isArray(s['reasons']) && typeof s['upkeep'] === 'number'
}

export function readMemoryStatus(slug: string | undefined): MemoryStatus | undefined {
  const dir = join(memoryStateDir(), 'status')
  for (const name of slug !== undefined ? [slug, '_global'] : ['_global']) {
    if (!/^[A-Za-z0-9._-]+$/u.test(name)) continue
    const r = readJsonSafeSync<unknown>(join(dir, `${name}.json`))
    if (r.ok && isMemoryStatus(r.value)) return r.value
  }
  return undefined
}

export function planForSession(h: Harness, sid: string | undefined, roots: string[]): BarModel['plan'] | undefined {
  if (sid === undefined || !isValidSessionId(sid)) return undefined
  const p = loadState(h, sid).plan
  if (p === undefined) return undefined
  const plan: NonNullable<BarModel['plan']> = { title: p.slug, phase: p.phase, done: 0, total: 0 }
  const candidates = isAbsolute(p.path) ? [p.path] : roots.map(r => join(r, p.path))
  for (const file of candidates) {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { continue }
    const title = /^#\s+(.+?)\s*$/mu.exec(text)?.[1]
    if (title !== undefined) plan.title = title
    const boxes = [...text.matchAll(/^\s*[-*] \[([ xX])\] Task \d+/gmu)]
    const headings = [...text.matchAll(/^###\s+Task \d+/gmu)].length
    plan.done = boxes.filter(m => m[1] !== ' ').length
    plan.total = Math.max(headings, boxes.length)
    break
  }
  return plan
}

export function flowForSession(h: Harness, sid: string | undefined, nowMs: number, foldAfterSec: number = DEFAULT_FOLD_SEC, roots: readonly string[] = []): BandView | undefined {
  if (sid === undefined || !isValidSessionId(sid)) return undefined
  const input = bandInputFor(h, sid, nowMs, foldAfterSec)
  if (input.plan !== undefined && !isAbsolute(input.plan.path)) {
    let text: string | undefined
    for (const root of roots) {
      try { text = readFileSync(join(root, input.plan.path), 'utf8'); break } catch {  }
    }
    const plan = bandPlanOf(loadState(h, sid), text)
    if (plan !== undefined) input.plan = plan
  }
  const view = bandView(input)
  return view.visible ? view : undefined
}

export async function indexStatusFor(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<IndexStatus | undefined> {
  return indexStatusOf(await workspaceInfo(cwd, cfg, nowMs))
}

export function pendingUpdates(path = updatesFile()): number | undefined {
  const r = readJsonSafeSync<unknown>(path)
  const o = r.ok ? obj(r.value) : undefined
  if (o === undefined) return undefined
  const c = finite(o['count'])
  if (c !== undefined) return c
  for (const k of ['updates', 'available', 'items']) {
    const list = o[k]
    if (Array.isArray(list)) return list.filter(x => obj(x)?.['available'] !== false).length
  }
  return undefined
}

export function monthFromEntry(entry: UsageCacheEntry | undefined, nowMs: number): BarModel['month'] | undefined {
  if (entry === undefined || entry.month_key !== monthKeyOf(nowMs)) return undefined
  const m: NonNullable<BarModel['month']> = { tokens: entry.month.tokens, estimate: true }
  if (entry.month.usd !== undefined) m.usd = entry.month.usd
  if (entry.month_pct !== undefined) m.pct = entry.month_pct
  if (m.tokens <= 0 && m.usd === undefined && m.pct === undefined) return undefined
  return m
}

export const TELEMETRY_FRESH_MS = 60 * 60_000

export interface SessionView {
  sessionId?: string
  cwd?: string
  model?: string
  effort?: string
  ctx?: NonNullable<BarModel['ctx']>
  windows: RateWindow[]
  costUsd?: number
}

export function sessionView(h: Harness, opts: { sessionId?: string, cwd?: string, nowMs: number, entry?: UsageCacheEntry }): SessionView {
  let tel: Telemetry | undefined
  if (opts.sessionId !== undefined) tel = isValidSessionId(opts.sessionId) ? readTelemetry(h, opts.sessionId) : undefined
  else tel = latestTelemetry(h, opts.cwd !== undefined ? { cwd: opts.cwd } : {})
  if (tel !== undefined && opts.nowMs - tel.at > TELEMETRY_FRESH_MS) tel = undefined
  const latest = opts.entry?.latest
  const view: SessionView = { windows: liveWindows(tel?.windows, opts.nowMs) }
  if (view.windows.length === 0) view.windows = liveWindows(opts.entry?.windows, opts.nowMs)
  const sid = tel?.sessionId ?? opts.sessionId ?? latest?.sessionId
  if (sid !== undefined) view.sessionId = sid
  const cwd = tel?.cwd ?? latest?.cwd
  if (cwd !== undefined) view.cwd = cwd
  const model = tel?.model ?? latest?.model
  if (model !== undefined) view.model = model
  const effort = tel?.effort ?? latest?.effort
  if (effort !== undefined) view.effort = effort
  const ctx = tel?.ctx ?? (latest !== undefined && opts.nowMs - latest.at <= TELEMETRY_FRESH_MS ? latest.ctx : undefined)
  if (ctx !== undefined && Number.isFinite(ctx.pct)) view.ctx = ctx
  if (tel?.costUsd !== undefined) view.costUsd = tel.costUsd
  return view
}
