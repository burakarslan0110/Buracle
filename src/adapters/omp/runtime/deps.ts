import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defaultConfig } from '../../../core/config'
import type { BandView } from '../../../core/flow/band'
import type { FlowSource } from '../../../core/flow/record'
import type { MemoryStatus } from '../../../core/memory/status'
import { memSegment } from '../../../core/memory/status'
import * as corePlan from '../../../core/plan/index'
import { normalizePlanText } from '../../../core/plan/capture'
import * as coreCompact from '../../../core/compact'
import { gitFromPorcelainV2, linesFromShortstat } from '../../../core/status/git'
import type { GitState } from '../../../core/status/model'
import * as coreStatus from '../../../core/status/render'
import { barLines, type BarInfo } from '../../../core/status/bar'
import { barInfo, liveMemoryUi } from '../../../usage/bar-info'
import { commonDir, gitDiffShortstat, gitStatusPorcelainV2, revParse } from '../../../engine/git'
import * as paths from '../../../engine/paths'
import { pendingUpdates } from '../../../usage/bar'
import { readUsageCache, spawnUsageRefresh } from '../../../usage/cache'
import type { UsageCacheEntry } from '../../../usage/types'
import { flowViewFor, recordFlowStart } from '../../../workflow/flow'
import { captureSessionPlan } from '../../../workflow/plan-native'
import { writeTelemetry } from '../../../workflow/session-store'
import type { Telemetry } from '../../../workflow/session-store'
import { ompConfigPath } from './config'
import { reviewerFenceFromEnv } from './companion-fence'
import { createMemoryBridge, readMemoryStatus } from './memory'
import { hostCli, hostDeps, TOOL_CALL_DEADLINE_MS, TOOL_RESULT_DEADLINE_MS, type EvalGuard, type HostDeps } from '../../shared/pi-family/inprocess-host'
import { ompAutosaveDir, STAGED_PLAN_MAX_AGE_MS, STAGED_PLAN_STALE_MS, USER_PLAN_MAX_AGE_MS, type PlanStore, type StagedPlan } from './plan-capture'
import type { OmpGenerated } from './types'
import { DEFAULT_BAND_LAYOUT, DEFAULT_SET_STATUS } from '../statusline'

export { TOOL_CALL_DEADLINE_MS, TOOL_RESULT_DEADLINE_MS }
export const STATUS_INTERVAL_MS = 30_000

export type TelemetryPatch = Omit<Telemetry, 'v' | 'harness' | 'sessionId'>

export type { EvalGuard }

export const CODE_EXECUTION_TOOLS: ReadonlySet<string> = new Set(['eval'])

export interface ExtensionDeps extends HostDeps {
  plan: Pick<typeof corePlan, 'stopGuardVerdict' | 'applyIntent' | 'validatePlan' | 'parsePlan' | 'promptInteraction' | 'answerReceipt'>
  compact: Pick<typeof coreCompact, 'compactInstructions' | 'handoffNote' | 'restoreContext'>
  memSegment: typeof memSegment
  status: Pick<typeof coreStatus, 'rows' | 'renderPlain'>
  bar?: { lines: typeof barLines, render: typeof coreStatus.renderPlainLines, info(nowMs: number): Promise<BarInfo> }
  state: HostDeps['state'] & { telemetry(sid: string, t: TelemetryPatch): void }
  flow: {
    start(sid: string, input: { workflow: string, title?: string, source: FlowSource }, now: number): boolean
    view(sid: string, now: number, foldAfterSec: number): BandView
  }
  plans: PlanStore
  gitState(cwd: string): Promise<GitState | undefined>
  listDir(path: string): string[]
  isFile(path: string): boolean
  memoryStatus(slug: string | undefined): MemoryStatus | undefined
  memoryUi(): { url: string } | undefined
  usage(): UsageCacheEntry | undefined
  updates(): number | undefined
  refreshUsage(): void
  columns(): number
  reviewerFence?(): string | undefined
  timings: HostDeps['timings'] & { statusIntervalMs: number }
}

function readText(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

interface PlanFile { path: string, mtimeMs: number }

function planFiles(dir: string): PlanFile[] {
  let names: string[]
  try { names = readdirSync(dir).filter(n => n.endsWith('.md')).sort() } catch { return [] }
  const out: PlanFile[] = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const st = statSync(path)
      if (st.isFile()) out.push({ path, mtimeMs: st.mtimeMs })
    } catch {  }
  }
  return out
}

export function sweepStaged(dir: string, nowMs: number): void {
  for (const f of planFiles(dir)) {
    if (nowMs - f.mtimeMs > STAGED_PLAN_STALE_MS) { try { rmSync(f.path, { force: true }) } catch {  } }
  }
}

export function recentPlans(dir: string, nowMs: number, maxAgeMs: number): Array<StagedPlan & PlanFile> {
  const out: Array<StagedPlan & PlanFile> = []
  for (const f of planFiles(dir)) {
    if (nowMs - f.mtimeMs > maxAgeMs) continue
    try { out.push({ ...f, text: readFileSync(f.path, 'utf8') }) } catch {  }
  }
  return out
}

export function stagedPlans(dir: string, nowMs: number): StagedPlan[] {
  sweepStaged(dir, nowMs)
  return recentPlans(dir, nowMs, STAGED_PLAN_MAX_AGE_MS)
}

export function ompPlanStore(): PlanStore {
  const taken = new Set<string>()
  const savedTexts = new Set<string>()
  return {
    save: async (plan, cwd, nowMs, sid) => {
      const saved = await captureSessionPlan({ plan, cwd, now: nowMs, harness: 'omp', sid })
      if (saved !== undefined) savedTexts.add(normalizePlanText(plan))
      return saved
    },
    staged: nowMs => stagedPlans(paths.ompPlanStagingDir(), nowMs),
    autosaved: (cwd, nowMs) => {
      const dir = ompAutosaveDir(readText(ompConfigPath(paths.ompAgentDir())), cwd, paths.home())
      if (dir === undefined || resolve(dir) === resolve(paths.ompPlanStagingDir())) return []
      const out: StagedPlan[] = []
      for (const f of recentPlans(dir, nowMs, USER_PLAN_MAX_AGE_MS)) {
        const key = `${f.mtimeMs}:${f.path}`
        if (taken.has(key)) continue
        taken.add(key)
        if (!savedTexts.has(normalizePlanText(f.text))) out.push({ path: f.path, text: f.text })
      }
      return out
    },
    sweep: nowMs => sweepStaged(paths.ompPlanStagingDir(), nowMs),
    drop: path => { try { rmSync(path, { force: true }) } catch {  } },
  }
}

async function gitState(cwd: string): Promise<GitState | undefined> {
  const [text, diff] = await Promise.all([gitStatusPorcelainV2(cwd), gitDiffShortstat(cwd)])
  if (text === undefined) return undefined
  const [gitDir, common] = await Promise.all([revParse(cwd, '--absolute-git-dir'), commonDir(cwd)])
  const state = gitFromPorcelainV2(text, gitDir, common)
  const lines = diff === undefined ? undefined : linesFromShortstat(diff)
  if (lines !== undefined) state.lines = lines
  return state
}

export function defaultDeps(): ExtensionDeps {
  const base = hostDeps('omp')
  return {
    ...base,
    plan: corePlan,
    compact: coreCompact,
    memSegment,
    status: coreStatus,
    bar: {
      lines: barLines,
      render: coreStatus.renderPlainLines,
      info: nowMs => barInfo('omp', { nowMs }),
    },
    state: { ...base.state, telemetry: (sid, t) => writeTelemetry('omp', sid, t) },
    flow: {
      start: (sid, input, now) => recordFlowStart('omp', sid, input, now),
      view: (sid, now, foldAfterSec) => flowViewFor('omp', sid, now, foldAfterSec),
    },
    memory: createMemoryBridge({ cli: hostCli }),
    plans: ompPlanStore(),
    gitState,
    listDir: path => { try { return readdirSync(path) } catch { return [] } },
    isFile: path => { try { return statSync(path).isFile() } catch { return false } },
    memoryStatus: readMemoryStatus,
    memoryUi: () => liveMemoryUi(),
    usage: () => readUsageCache()?.harnesses.omp,
    updates: () => pendingUpdates(),
    refreshUsage: () => {
      const argv = hostCli()
      if (argv !== undefined) spawnUsageRefresh('omp', { argv: [...argv, 'usage', 'refresh', '--harness', 'omp', '--background'] })
    },
    columns: () => (typeof process.stdout.columns === 'number' && process.stdout.columns > 0 ? process.stdout.columns : 120),
    reviewerFence: reviewerFenceFromEnv,
    timings: { ...base.timings, statusIntervalMs: STATUS_INTERVAL_MS },
  }
}

export function emptyGenerated(): OmpGenerated {
  const setStatus: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(DEFAULT_SET_STATUS)) setStatus[k] = [...v]
  return {
    v: 1, buracleVersion: '0.0.0', config: defaultConfig(), routing: { strictness: 'enforce', categories: [] },
    mcp: [], mcpIds: [], skills: [], plugins: [], commands: [], status: { layout: DEFAULT_BAND_LAYOUT, setStatus },
  }
}
