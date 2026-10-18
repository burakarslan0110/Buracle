import type { BuracleConfig } from '../../../core/config'
import { defaultConfig } from '../../../core/config'
import type { BarModel, GitState, HookHealth, IndexStatus, RateWindow, Segment, StatusLayout } from '../../../core/status/model'
import { rows } from '../../../core/status/render'
import { barOneLine, type BarInfo } from '../../../core/status/bar'
import { barInfo } from '../../../usage/bar-info'
import type { MemoryStatus } from '../../../core/memory/status'
import { cachedProjectSlug, dirLabel, effectiveLayout, FALLBACK_LAYOUT, gitInfo, indexStatusFor, monthFromEntry, pendingUpdates, planForSession, readMemoryStatus } from '../../../usage/bar'
import { isStale, readUsageCache, spawnUsageRefresh } from '../../../usage/cache'
import { latestWindows, liveWindows } from '../../../usage/telemetry'
import { statusHealth } from '../../../engine/hook-health'
import * as paths from '../../../engine/paths'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { BandFeeder } from './band'
import { runtimeConfigCache, type MtimeCache, type RuntimeSnapshot } from './env'
import type { TuiModelInfo, TuiSessionMessage } from './types'

export function usageRefreshArgv(): string[] | undefined {
  const tail = ['usage', 'refresh', '--harness', 'opencode', '--background']
  const shim = paths.shimPath()
  if (existsSync(shim)) return [shim, ...tail]
  const main = join(paths.repoRoot(), 'src', 'cli', 'main.ts')
  const bun = typeof Bun !== 'undefined' ? Bun.which('bun') : null
  return bun !== null && existsSync(main) ? [bun, main, ...tail] : undefined
}

export interface ContextUsage { tokens: number; pct?: number; window?: number }

export function contextUsage(messages: ReadonlyArray<TuiSessionMessage>, models: ReadonlyArray<TuiModelInfo> | undefined, boundary?: string): ContextUsage | undefined {
  const boundaryIndex = boundary !== undefined ? messages.findIndex(m => m.id === boundary) : -1
  if (boundary !== undefined && boundaryIndex === -1) return undefined
  const end = boundaryIndex === -1 ? messages.length : boundaryIndex
  let compactionIndex = -1
  for (let i = 0; i < end; i++) {
    const m = messages[i]
    if (m !== undefined && m.type === 'compaction' && m.status === 'completed') compactionIndex = i
  }
  let last: TuiSessionMessage | undefined
  for (let i = end - 1; i > compactionIndex; i--) {
    const m = messages[i]
    if (m !== undefined && m.type === 'assistant' && m.tokens !== undefined) { last = m; break }
  }
  if (last?.tokens === undefined) return undefined
  const t = last.tokens
  const tokens = t.input + t.output + t.reasoning + t.cache.read + t.cache.write
  if (!(tokens > 0)) return undefined
  const model = last.model !== undefined ? models?.find(m => m.providerID === last.model?.providerID && m.id === last.model?.id) : undefined
  const window = model?.limit?.context
  const out: ContextUsage = { tokens }
  if (window !== undefined && window > 0) { out.window = window; out.pct = (tokens / window) * 100 }
  return out
}

export interface LiveInputs {
  sessionID?: string
  cwd: string
  model?: { providerID: string; modelID: string; variant?: string }
  ctx?: ContextUsage
  costUsd?: number
}

interface Cached<T> { at: number; value: T | undefined }

const TTL = { git: 5_000, usage: 30_000, mem: 30_000, plan: 10_000, updates: 60_000, footer: 60_000, index: 30_000, hooks: 30_000 }
const INDEX_BUDGET_MS = 1_000

async function within(work: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([work, new Promise<void>(resolve => { timer = setTimeout(resolve, ms) })])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export interface StatusFeederOptions {
  now?: () => number
  spawnRefresh?: boolean
  memoryUi?: () => { port: number }
  config?: () => BuracleConfig
  band?: Pick<BandFeeder, 'view'>
  hooks?: (nowMs: number) => Promise<HookHealth>
}

export class StatusFeeder {
  private git: Cached<{ git?: GitState, dir?: string }> = { at: 0, value: undefined }
  private usage: Cached<{ windows: RateWindow[], month?: BarModel['month'], stale: boolean }> = { at: 0, value: undefined }
  private mem: Cached<MemoryStatus> = { at: 0, value: undefined }
  private plan: Cached<NonNullable<BarModel['plan']>> = { at: 0, value: undefined }
  private updates: Cached<number> = { at: 0, value: undefined }
  private footer: Cached<BarInfo> = { at: 0, value: undefined }
  private index: Cached<IndexStatus> = { at: 0, value: undefined }
  private hooks: Cached<HookHealth> = { at: 0, value: undefined }
  private keyCwd: string | undefined
  private keySession: string | undefined
  private busy = false
  private readonly band: Pick<BandFeeder, 'view'>
  private ownConfig: MtimeCache<RuntimeSnapshot> | undefined

  constructor(private readonly opts: StatusFeederOptions = {}) {
    this.band = opts.band ?? new BandFeeder(() => this.now())
  }

  barInfo(): BarInfo {
    return this.footer.value ?? {}
  }

  private now(): number { return (this.opts.now ?? Date.now)() }

  private config(): BuracleConfig {
    if (this.opts.config !== undefined) return this.opts.config()
    this.ownConfig ??= runtimeConfigCache(defaultConfig())
    return this.ownConfig.get().config
  }

  async refresh(cwd: string, sessionID: string | undefined): Promise<boolean> {
    if (this.busy) return false
    this.busy = true
    try {
      const now = this.now()
      if (cwd !== this.keyCwd) { this.keyCwd = cwd; this.git.at = 0; this.mem.at = 0; this.plan.at = 0; this.index = { at: 0, value: undefined } }
      if (sessionID !== this.keySession) { this.keySession = sessionID; this.plan.at = 0 }
      const due = (c: Cached<unknown>, ttl: number) => now - c.at >= ttl || now < c.at
      if (due(this.git, TTL.git)) {
        this.git.at = now
        try {
          const info = await gitInfo(cwd, 400)
          const v: { git?: GitState, dir?: string } = info !== undefined ? { git: info.git } : {}
          const d = dirLabel(cwd, info)
          if (d !== undefined) v.dir = d
          this.git.value = v
        } catch { this.git.value = undefined }
      }
      if (due(this.usage, TTL.usage)) {
        this.usage.at = now
        try {
          const entry = readUsageCache()?.harnesses.opencode
          const own = latestWindows('opencode', now)
          const v: { windows: RateWindow[], month?: BarModel['month'], stale: boolean } = { windows: own.length > 0 ? own : liveWindows(entry?.windows, now), stale: isStale(entry, now) }
          const month = monthFromEntry(entry, now)
          if (month !== undefined) v.month = month
          this.usage.value = v
          if (v.stale && this.opts.spawnRefresh !== false) {
            const argv = usageRefreshArgv()
            if (argv !== undefined) spawnUsageRefresh('opencode', { argv })
          }
        } catch { this.usage.value = undefined }
      }
      if (due(this.mem, TTL.mem)) {
        this.mem.at = now
        try { this.mem.value = readMemoryStatus(await cachedProjectSlug(cwd, now)) } catch { this.mem.value = undefined }
      }
      if (due(this.plan, TTL.plan)) {
        this.plan.at = now
        try { this.plan.value = planForSession('opencode', sessionID, [cwd]) } catch { this.plan.value = undefined }
      }
      if (due(this.updates, TTL.updates)) {
        this.updates.at = now
        try { this.updates.value = pendingUpdates() } catch { this.updates.value = undefined }
      }
      if (due(this.footer, TTL.footer) && this.opts.memoryUi !== undefined) {
        this.footer.at = now
        try { this.footer.value = await barInfo('opencode', { nowMs: now, memoryUi: this.opts.memoryUi() }) } catch { this.footer.value = undefined }
      }
      if (due(this.index, TTL.index)) {
        const entry = this.index
        entry.at = now
        const read = indexStatusFor(cwd, this.config(), now).then(v => { entry.value = v }, () => { entry.value = undefined })
        await within(read, INDEX_BUDGET_MS)
      }
      if (due(this.hooks, TTL.hooks)) {
        this.hooks.at = now
        try { this.hooks.value = await (this.opts.hooks ?? statusHealth)(now) } catch { this.hooks.value = undefined }
      }
      return true
    } finally {
      this.busy = false
    }
  }

  bar(live: LiveInputs): BarModel {
    const bar: BarModel = { harness: 'opencode', windows: this.usage.value?.windows ?? [] }
    if (live.model !== undefined) bar.model = live.model.modelID
    if (live.model?.variant !== undefined) bar.effort = live.model.variant
    if (live.ctx?.pct !== undefined) {
      const ctx: NonNullable<BarModel['ctx']> = { pct: live.ctx.pct, tokens: live.ctx.tokens }
      if (live.ctx.window !== undefined) ctx.window = live.ctx.window
      bar.ctx = ctx
    }
    if (live.costUsd !== undefined && live.costUsd > 0) bar.cost = { usd: live.costUsd }
    const month = this.usage.value?.month
    if (month !== undefined) bar.month = month
    const git = this.git.value
    if (git?.git !== undefined) bar.git = git.git
    if (git?.dir !== undefined) bar.dir = git.dir
    if (this.mem.value !== undefined) bar.mem = this.mem.value
    if (this.plan.value !== undefined) bar.plan = this.plan.value
    if (this.index.value !== undefined) bar.index = this.index.value
    if (this.updates.value !== undefined && this.updates.value > 0) bar.updates = this.updates.value
    if (this.hooks.value !== undefined) bar.hooks = this.hooks.value
    const cfg = this.config()
    if (!cfg.workflow.band) {
      const view = this.band.view(live.sessionID, cfg.workflow.foldAfterSec)
      if (view.visible) bar.flow = view
    }
    return bar
  }
}

export function layoutFor(baked: StatusLayout | undefined, cfg: BuracleConfig['statusline'] | undefined): StatusLayout {
  const base = baked ?? FALLBACK_LAYOUT
  return cfg !== undefined ? effectiveLayout(base, cfg) : base
}

export function barSegments(bar: BarModel, layout: StatusLayout, info: BarInfo, width: number, nowMs: number): Segment[] {
  return barOneLine(bar, info, layout, Math.max(10, width), nowMs)
}

export function statusSegments(bar: BarModel, layout: StatusLayout, width: number, nowMs: number): Segment[] {
  const single: StatusLayout = { ...layout, rows: [layout.rows.flat()] }
  return rows(bar, single, Math.max(10, width), nowMs).flat()
}
