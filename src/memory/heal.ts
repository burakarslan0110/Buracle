import { readFileSync } from 'node:fs'
import type { Harness } from '../core/events'
import { memIsSlug } from '../core/memory/note'
import { memReasonText, type MemoryStatus } from '../core/memory/status'
import { loadConfigSync } from '../engine/config'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { checkEmbedModel, installEmbedModel } from '../engine/toolchain/embed-model'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { cortexdbBinary, installCortexdb } from '../engine/toolchain/cortexdb'
import { writeHealth } from '../engine/update/mcp'
import { closeAllCortex } from './cortex'
import { distillPending, distillQueueState, pruneDistillQueue, type DistillResult } from './distill'
import { mcpHandshake } from './doctor'
import { appendJob } from './jobs'
import { healLockFile, healStateFile } from './layout'
import { tryLock } from './lock'
import type { ModelRunner } from './runner'
import { spawnCli } from './spawn'
import { latestSessionRecord } from './session-record'
import { computeStatus, readStatus, refreshStatus } from './status'
import { listAll, personRef, projectRef, withBrainLock } from './store'
import { sweep, syncCorePages } from './sweep'

export type HealTrigger = 'session-start' | 'session-end' | 'tick' | 'ui' | 'cli'
export type HealStepId = 'store' | 'embed' | 'brain' | 'mcp' | 'queue' | 'distill' | 'core' | 'sweep' | 'reflect' | 'verify'

export interface HealStep { step: HealStepId, ok: boolean, detail: string }

export interface HealRun {
  v: 1
  at: string
  trigger: HealTrigger
  project?: string
  ok: boolean
  before: { health: MemoryStatus['health'], reasons: string[] }
  after: { health: MemoryStatus['health'], reasons: string[] }
  steps: HealStep[]
  ms: number
}

interface HealState {
  v: 1
  runs: HealRun[]
  startedAt?: number
  cortexInstallAt?: number
  embedInstallAt?: number
  noProgress?: number
}

export const HEAL_EVERY_MS = 30 * 60_000
export const HEAL_BACKOFF_MAX_MS = 6 * 3600_000

export function healEveryMs(noProgress: number): number {
  return Math.min(HEAL_EVERY_MS * 2 ** Math.max(0, noProgress), HEAL_BACKOFF_MAX_MS)
}

export function healNoProgress(): number {
  return readState().noProgress ?? 0
}
const CORTEX_INSTALL_EVERY_MS = 6 * 3600_000
export const HEAL_DISTILL_RUNS = 6
const RUNS_KEPT = 10
const HEAL_LOCK_STALE_MS = 10 * 60_000

function readState(): HealState {
  const r = readJsonSafeSync<HealState>(healStateFile())
  const v = r.ok ? r.value : undefined
  return v !== null && typeof v === 'object' && v?.v === 1 && Array.isArray(v.runs) ? v : { v: 1, runs: [] }
}

function writeState(s: HealState): void {
  try { atomicWriteSync(healStateFile(), JSON.stringify(s, null, 2) + '\n') } catch (e) { log('warn', 'memory: the repair state was not written', { error: e }) }
}

export function healRuns(): HealRun[] {
  return [...readState().runs].reverse()
}

export function healRunning(): boolean {
  try {
    const info = JSON.parse(readFileSync(healLockFile(), 'utf8')) as { pid?: unknown }
    if (typeof info.pid !== 'number') return false
    try { process.kill(info.pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
  } catch {
    return false
  }
}

export interface HealOptions {
  slug?: string
  trigger: HealTrigger
  nowMs?: number
  harness?: Harness
  model?: string
  maxDistillRuns?: number
  deps?: {
    installCortex?: () => Promise<{ ok: boolean, detail: string }>
    installEmbed?: () => Promise<{ ok: boolean, detail: string }>
    mcpCheck?: () => Promise<{ ok: boolean, detail: string }>
    distillRunner?: ModelRunner
    reflectRunner?: ModelRunner
  }
}

export type HealResult = HealRun | { skipped: 'busy', detail: string }

async function installCortexDefault(): Promise<{ ok: boolean, detail: string }> {
  const r = await installCortexdb()
  return r.ok ? { ok: true, detail: 'installed' } : { ok: false, detail: r.error }
}

async function installEmbedDefault(): Promise<{ ok: boolean, detail: string }> {
  const r = await installEmbedModel()
  return r.ok ? { ok: true, detail: 'installed' } : { ok: false, detail: r.error }
}

function distillLine(results: readonly DistillResult[], left: number): string {
  const ran = results.filter(r => r.ran).length
  const lent = results.filter(r => r.ran && r.ranBy !== undefined && r.ranBy !== r.harness).length
  const dead = results.filter(r => r.skipped === 'no-session-memory' || r.skipped === 'nothing-to-distill').length
  const failed = results.filter(r => r.skipped === 'runner-failed')
  const parts = [`distilled ${ran}${lent > 0 ? ` (${lent} through another harness)` : ''}`]
  if (dead > 0) parts.push(`dropped ${dead} with nothing to distill`)
  const kept = results.filter(r => r.skipped === 'excluded').length
  if (kept > 0) parts.push(`dropped ${kept} of projects memory.exclude keeps out`)
  if (failed.length > 0) parts.push(`${failed.length} failed (${failed[0]?.detail ?? 'the model did not answer'})`)
  parts.push(`${left} left in the queue`)
  return parts.join('; ')
}

export async function healBrain(opts: HealOptions): Promise<HealResult> {
  const now = opts.nowMs ?? Date.now()
  const slug = opts.slug !== undefined && memIsSlug(opts.slug) ? opts.slug : undefined
  const cfg = loadConfigSync().config
  const automatic = opts.trigger === 'session-start' || opts.trigger === 'session-end' || opts.trigger === 'tick'
  const release = tryLock(healLockFile(), HEAL_LOCK_STALE_MS, { heartbeat: true })
  if (!release) return { skipped: 'busy', detail: 'another repair is running' }
  const t0 = Date.now()
  const steps: HealStep[] = []
  const step = (s: HealStep): void => { steps.push(s) }
  const state = readState()
  try {
    const before = await computeStatus({ ...(slug !== undefined ? { slug } : {}), nowMs: now })
    const has = (r: string): boolean => before.reasons.includes(r)

    if (!before.store.ok) {
      if (!cfg.toolchain.autoInstall) step({ step: 'store', ok: false, detail: 'CortexDB is missing and toolchain.autoInstall is off, so `buracle install` skips it; run: buracle config set toolchain.autoInstall true, then buracle install' })
      else if (state.cortexInstallAt !== undefined && now - state.cortexInstallAt < CORTEX_INSTALL_EVERY_MS) step({ step: 'store', ok: false, detail: 'CortexDB is missing; the last install attempt was under 6 hours ago (run: buracle install)' })
      else {
        state.cortexInstallAt = now
        const r = await (opts.deps?.installCortex ?? installCortexDefault)()
        const ok = r.ok && cortexdbBinary() !== undefined
        step({ step: 'store', ok, detail: ok ? 'CortexDB installed again' : `CortexDB could not be installed: ${r.detail}` })
      }
      if (cortexdbBinary() === undefined) return await finish(before)
    }

    if (has('embed_missing')) {
      if (!cfg.toolchain.autoInstall) step({ step: 'embed', ok: false, detail: 'the embedding model is missing and toolchain.autoInstall is off, so `buracle install` skips it; run: buracle config set toolchain.autoInstall true, then buracle install' })
      else if (state.embedInstallAt !== undefined && now - state.embedInstallAt < CORTEX_INSTALL_EVERY_MS) step({ step: 'embed', ok: false, detail: 'the embedding model is missing; the last download attempt was under 6 hours ago (run: buracle install)' })
      else {
        state.embedInstallAt = now
        const r = await (opts.deps?.installEmbed ?? installEmbedDefault)()
        const ok = r.ok && checkEmbedModel().status === 'ok'
        step({ step: 'embed', ok, detail: ok ? 'the embedding model was downloaded; the search is by meaning and words again' : `the embedding model could not be downloaded: ${r.detail}` })
      }
    }

    if (has('brain_unreadable')) {
      await closeAllCortex()
      try {
        if (slug !== undefined) await listAll(projectRef(slug))
        await listAll(personRef())
        step({ step: 'brain', ok: true, detail: 'the CortexDB children were restarted and the brains read again' })
      } catch (e) {
        step({ step: 'brain', ok: false, detail: `the brain still cannot be read (${e instanceof Error ? e.message : String(e)}); run: buracle mem doctor` })
      }
    }

    if (has('mcp_down')) {
      const r = await (opts.deps?.mcpCheck ?? (() => mcpHandshake(paths.home())))()
      if (r.ok) {
        try { writeHealth({ mcp: { 'buracle-memory': { status: 'ok', transport: 'stdio', checked_at: new Date(now).toISOString(), ms: 0 } } }, new Date(now).toISOString()) } catch (e) { log('warn', 'memory: the MCP health was not recorded', { error: e }) }
        step({ step: 'mcp', ok: true, detail: `the buracle-memory server answers (${r.detail}); a harness reconnects it at its next start (/mcp in Claude Code)` })
      } else {
        step({ step: 'mcp', ok: false, detail: `the buracle-memory server does not start: ${r.detail}; run: buracle doctor` })
      }
    }

    const queue = distillQueueState()
    if (queue.pending > 0) {
      const dropped = pruneDistillQueue({ nowMs: now })
      if (dropped > 0) step({ step: 'queue', ok: true, detail: `dropped ${dropped} queued session(s) older than two weeks (their session memories stay)` })
      if (queue.pending - dropped > 0) {
        const results = await distillPending({ auto: true, nowMs: now, maxRuns: opts.maxDistillRuns ?? HEAL_DISTILL_RUNS, trigger: 'heal', ...(opts.deps?.distillRunner !== undefined ? { runner: opts.deps.distillRunner } : {}) })
        const after = distillQueueState({ nowMs: now })
        const waits = after.held > 0 ? [`${after.held} wait for a harness with usage headroom (${after.why ?? 'none has room'}${after.until !== undefined ? `; the first window resets ${after.until}` : ''})`] : []
        step({
          step: 'distill',
          ok: !results.some(r => r.skipped === 'runner-failed'),
          detail: [distillLine(results, after.pending), ...waits].join('; '),
        })
      }
    }

    if (has('core_missing') && slug !== undefined) {
      try {
        const ids = await withBrainLock(projectRef(slug), () => syncCorePages(slug, now))
        step({ step: 'core', ok: true, detail: ids.length > 0 ? `core pages written again: ${ids.join(', ')}` : 'the core pages are all there' })
      } catch (e) {
        step({ step: 'core', ok: false, detail: `the core pages were not written: ${e instanceof Error ? e.message : String(e)}` })
      }
    }

    if (has('upkeep_high') || has('captures_high')) {
      try {
        const r = await sweep({ ...(slug !== undefined ? { slug } : {}), nowMs: now, trigger: 'heal' })
        const pruned = r.layers.reduce((n, l) => n + l.pruned.length, 0)
        const upkeep = r.layers.reduce((n, l) => n + l.upkeep, 0)
        step({ step: 'sweep', ok: r.layers.every(l => l.skipped === undefined || l.skipped === 'no memory yet'), detail: `deleted ${pruned} that ran out; ${upkeep} upkeep item(s) left` })
      } catch (e) {
        step({ step: 'sweep', ok: false, detail: `the sweep failed: ${e instanceof Error ? e.message : String(e)}` })
      }
      const { reflectBrain } = await import('./reflect')
      const rec = opts.harness === undefined ? latestSessionRecord(slug) : undefined
      const harness = opts.harness ?? rec?.harness
      const model = opts.model ?? (rec !== undefined ? (await import('./runner')).sessionModel(rec.harness, rec.sid) : undefined)
      const via = { ...(harness !== undefined ? { harness } : {}), ...(model !== undefined ? { model } : {}), ...(opts.deps?.reflectRunner !== undefined ? { runner: opts.deps.reflectRunner } : {}) }
      const trigger = automatic ? 'heal' as const : 'manual' as const
      const lines: string[] = []
      let ok = true
      for (const ref of [...(slug !== undefined ? [projectRef(slug)] : []), personRef()]) {
        const r = await reflectBrain(ref, { trigger, nowMs: now, ...via })
        const name = ref.layer === 'person' ? 'person' : `project ${slug ?? ''}`
        if (r.skipped === 'runner-failed') ok = false
        lines.push(r.skipped !== undefined ? `${name}: ${r.skipped}${r.detail !== undefined ? ` (${r.detail})` : ''}` : `${name}: applied ${r.applied.length}`)
      }
      step({ step: 'reflect', ok, detail: lines.join('; ') })
      if (slug !== undefined) {
        try {
          const { maybeStartVerify } = await import('./verify-start')
          const started = maybeStartVerify({ slug, nowMs: now, trigger: 'heal', ...(harness !== undefined ? { harness } : {}) })
          step({ step: 'verify', ok: true, detail: started ? 'the verifier was started in the background' : 'the verifier did not start (nothing to check, its interval, or it is off)' })
        } catch (e) {
          step({ step: 'verify', ok: false, detail: `the verifier did not start: ${e instanceof Error ? e.message : String(e)}` })
        }
      }
    }
    return await finish(before)
  } catch (e) {
    log('warn', 'memory: the repair failed', { slug, error: e })
    step({ step: 'store', ok: false, detail: `the repair stopped: ${e instanceof Error ? e.message : String(e)}` })
    return await finish(undefined)
  } finally {
    release()
  }

  async function finish(before: MemoryStatus | undefined): Promise<HealRun> {
    const after = await refreshStatus({ ...(slug !== undefined ? { slug } : {}), nowMs: now })
    if (slug !== undefined) await refreshStatus({ nowMs: now })
    const runRec: HealRun = {
      v: 1, at: new Date(now).toISOString(), trigger: opts.trigger, ...(slug !== undefined ? { project: slug } : {}),
      ok: steps.every(s => s.ok),
      before: { health: before?.health ?? 'error', reasons: before?.reasons ?? [] },
      after: { health: after?.health ?? 'error', reasons: after?.reasons ?? [] },
      steps, ms: Date.now() - t0,
    }
    const s = readState()
    s.runs = [...s.runs, runRec].slice(-RUNS_KEPT)
    const stuck = before !== undefined && before.health !== 'ok' && runRec.after.health !== 'ok' && before.reasons.length > 0 && before.reasons.every(r => runRec.after.reasons.includes(r))
    s.noProgress = stuck ? (s.noProgress ?? 0) + 1 : 0
    if (state.cortexInstallAt !== undefined) s.cortexInstallAt = state.cortexInstallAt
    if (state.embedInstallAt !== undefined) s.embedInstallAt = state.embedInstallAt
    delete s.startedAt
    writeState(s)
    const failedSteps = steps.filter(x => !x.ok)
    appendJob({
      job: 'heal', trigger: opts.trigger, outcome: failedSteps.length === 0 ? 'ran' : 'failed', ...(failedSteps.length > 0 ? { reason: failedSteps[0]?.step ?? 'step' } : {}),
      detail: `${runRec.before.health} (${runRec.before.reasons.join(', ') || 'no reason'}) -> ${runRec.after.health}; ${steps.map(x => `${x.step}${x.ok ? '' : ' failed'}`).join(', ') || 'nothing to do'}`,
      ...(slug !== undefined ? { project: slug } : {}), ...(opts.harness !== undefined ? { harness: opts.harness } : {}), ms: runRec.ms,
    })
    return runRec
  }
}

export function healPending(nowMs = Date.now()): boolean {
  if (healRunning()) return true
  const s = readState()
  const last = s.runs[s.runs.length - 1]
  return s.startedAt !== undefined && nowMs - s.startedAt < 2 * 60_000 && (last === undefined || Date.parse(last.at) < s.startedAt)
}

export function startHeal(opts: { slug?: string, nowMs: number, trigger: HealTrigger, harness?: Harness, sid?: string }): boolean {
  if (process.env['BURACLE_NO_AUTOSTART'] === '1' || healPending(opts.nowMs)) return false
  const slug = opts.slug !== undefined && memIsSlug(opts.slug) ? opts.slug : undefined
  writeState({ ...readState(), startedAt: opts.nowMs })
  const pid = spawnCli(['mem', 'heal', '--quiet', '--trigger', opts.trigger, ...(slug !== undefined ? ['--project', slug] : []), ...(opts.harness !== undefined ? ['--harness', opts.harness] : []), ...(opts.sid !== undefined ? ['--session', opts.sid] : [])])
  return pid !== undefined
}

export function maybeStartHeal(opts: { slug?: string, nowMs: number, trigger: 'session-start' | 'session-end' | 'tick', harness?: Harness, sid?: string, storeProblem?: 'cortexdb_missing' | 'brain_unreadable' }): boolean {
  if (process.env['BURACLE_NO_AUTOSTART'] === '1') return false
  const slug = opts.slug !== undefined && memIsSlug(opts.slug) ? opts.slug : undefined
  const scope = { ...(slug !== undefined ? { project: slug } : {}), ...(opts.harness !== undefined ? { harness: opts.harness } : {}), ...(opts.sid !== undefined ? { sid: opts.sid } : {}) }
  try {
    const s = readStatus(slug)
    const why = opts.storeProblem ?? (s !== undefined && s.health !== 'ok' ? s.reasons.join(', ') || s.health : undefined)
    if (why === undefined) return false
    const state = readState()
    const last = state.runs[state.runs.length - 1]
    const lastMs = Math.max(state.startedAt ?? 0, last !== undefined ? Date.parse(last.at) : 0)
    if (healRunning()) return false
    if (opts.nowMs - lastMs < healEveryMs(state.noProgress ?? 0)) return false
    const { storeProblem: _p, ...rest } = opts
    const started = startHeal({ ...rest, ...(slug !== undefined ? { slug } : {}) })
    appendJob(started
      ? { job: 'heal', trigger: opts.trigger, outcome: 'ran', reason: 'started', detail: `started in the background for: ${why}`, ...scope }
      : { job: 'heal', trigger: opts.trigger, outcome: 'failed', reason: 'not-started', detail: `needed for ${why}, but the background job did not start`, ...scope }, opts.nowMs)
    return started
  } catch (e) {
    log('warn', 'memory: cannot start the repair', { slug: opts.slug, error: e })
    appendJob({ job: 'heal', trigger: opts.trigger, outcome: 'failed', reason: 'error', detail: e instanceof Error ? e.message : String(e), ...scope }, opts.nowMs)
    return false
  }
}

export function healAdvice(s: MemoryStatus): Array<{ code: string, level: 'warn' | 'error', detail: string, auto: boolean, fix?: string }> {
  return s.reasons.map(code => {
    switch (code) {
      case 'cortexdb_missing': return { code, level: 'error' as const, detail: 'CortexDB is not installed, so the brain cannot be read', auto: true, fix: 'buracle install' }
      case 'brain_unreadable': return { code, level: 'error' as const, detail: 'a brain file could not be read', auto: true, fix: 'buracle mem doctor' }
      case 'embed_missing': return { code, level: 'warn' as const, detail: 'the embedding model is not downloaded, so the search is by words only; the repair downloads it', auto: true, fix: 'buracle install' }
      case 'mcp_down': return { code, level: 'error' as const, detail: 'the buracle-memory MCP server did not start', auto: true, fix: 'buracle doctor' }
      case 'upkeep_high': return { code, level: 'warn' as const, detail: `${s.upkeep} memories wait for upkeep; the repair sweeps, reflects (files captures, merges flagged duplicates) and starts the verifier (checks claims against the code); what they cannot settle (contradicted claims, missing sources, claims the verifier could not decide) needs an agent`, auto: true, fix: 'memory_status lists each item with what to do' }
      case 'captures_high': return { code, level: 'warn' as const, detail: `${s.captures} captures wait to be filed`, auto: true, fix: 'memory_update with move: {kind, layer}' }
      case 'core_missing': return { code, level: 'warn' as const, detail: 'a core page of the project is missing; the repair writes it again', auto: true, fix: 'buracle mem sweep --project <slug>' }
      case 'distill_backlog': return { code, level: 'warn' as const, detail: `${memReasonText(code, s).replace('queue ', '')} finished sessions wait to be distilled`, auto: true, fix: 'buracle mem heal' }
      default: return { code, level: 'warn' as const, detail: code, auto: false }
    }
  })
}

export function healthLine(s: MemoryStatus | undefined): string | undefined {
  if (s === undefined || s.health === 'ok' || s.reasons.length === 0) return undefined
  const what = s.reasons.map(r => memReasonText(r, s)).join(', ')
  const n = healNoProgress()
  const stuck = n >= 2 ? ` The repair ran ${n} times without progress and backs off (the next one waits up to ${Math.round(healEveryMs(n) / 60_000)} min); \`buracle mem doctor\` names what it cannot fix.` : ''
  return `Memory health: ${s.health} (${what}). Buracle repairs this in the background (\`buracle mem heal\` runs it now).${stuck}`
}
