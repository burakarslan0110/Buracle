import { readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { BuracleConfig } from '../../../core/config'
import { defaultConfig } from '../../../core/config'
import type { BandView } from '../../../core/flow/band'
import type { FlowSource } from '../../../core/flow/record'
import type { MemoryStatus } from '../../../core/memory/status'
import { memSegment } from '../../../core/memory/status'
import * as corePolicy from '../../../core/policy/index'
import type { ConsentKind } from '../../../core/policy/consent'
import type { McpHealth } from '../../../core/policy/routing'
import type { UsageLedger } from '../../../core/policy/usage'
import type { WriteGuardContext } from '../../../core/policy/write-guard'
import * as corePlan from '../../../core/plan/index'
import type { SessionState } from '../../../core/plan/index'
import { normalizePlanText } from '../../../core/plan/capture'
import * as coreCompact from '../../../core/compact'
import * as coreCheckers from '../../../core/checkers'
import { gitFromPorcelainV2 } from '../../../core/status/git'
import type { GitState } from '../../../core/status/model'
import * as coreStatus from '../../../core/status/render'
import { barLines, type BarInfo } from '../../../core/status/bar'
import type { WorkspaceInfo } from '../../../core/workspace'
import { barInfo, liveMemoryUi } from '../../../usage/bar-info'
import { commonDir, currentBranch, gitStatusPorcelainV2, projectSlug, revParse } from '../../../engine/git'
import * as paths from '../../../engine/paths'
import { run } from '../../../engine/proc'
import { pendingUpdates } from '../../../usage/bar'
import { readUsageCache, spawnUsageRefresh } from '../../../usage/cache'
import type { UsageCacheEntry } from '../../../usage/types'
import { flowViewFor, recordFlowStart } from '../../../workflow/flow'
import { captureSessionPlan } from '../../../workflow/plan-native'
import { loadLedger, updateLedger } from '../../../workflow/ledger'
import { loadState, profileGuard, reviewSubjects, sessionMaint, updateState, writeTelemetry } from '../../../workflow/session-store'
import type { Telemetry } from '../../../workflow/session-store'
import { codegraphIndexPresent, refreshWorkspaceInfo, workspaceInfo } from '../../../workflow/workspace'
import { buracleRepoFor } from '../../opencode/runtime/adapter-rules'
import { recordDialogGrant } from '../../shared/consent-dialog'
import { reviewNotesNotice } from '../../shared/review-notes'
import { consentGate, consentGateAll, recordPromptGrants } from '../../shared/consent-store'
import { nodeCheckFs, type CheckFs } from '../../shared/checker-scan'
import { cmPrune } from '../../shared/context-mode/maint'
import { realWriteTarget } from '../../shared/realpath'
import { assetsAfterEdit, assetsContext, startLinkRun } from '../../shared/project-assets'
import { prepareWorkspace } from '../../shared/workspace-start'
import { spawnNotify } from '../../shared/turn-receipt'
import { liveConfig, mcpHealth, ompConfigPath, type LiveConfig } from './config'
import { reviewerFenceFromEnv } from './companion-fence'
import { defaultCmDeps, type CmDeps } from './context-mode'
import { buracleCli, createMemoryBridge, readMemoryStatus, type MemoryBridge } from './memory'
import { ompAutosaveDir, STAGED_PLAN_MAX_AGE_MS, STAGED_PLAN_STALE_MS, USER_PLAN_MAX_AGE_MS, type PlanStore, type StagedPlan } from './plan-capture'
import { createDepsReader } from './routing'
import type { OmpGenerated } from './types'
import { DEFAULT_BAND_LAYOUT, DEFAULT_SET_STATUS } from '../statusline'

export const TOOL_CALL_DEADLINE_MS = 3_000
export const TOOL_RESULT_DEADLINE_MS = 25_000
export const STATUS_INTERVAL_MS = 30_000

export type TelemetryPatch = Omit<Telemetry, 'v' | 'harness' | 'sessionId'>

export type EvalGuard = (code: string, language: string, ctx: WriteGuardContext, opts?: { extraDeny?: string[] }) => { deny?: string, hook?: 'H01' | 'H02' }

export const CODE_EXECUTION_TOOLS: ReadonlySet<string> = new Set(['eval'])

function coreEvalGuard(): EvalGuard | undefined {
  const fn = (corePolicy as unknown as Record<string, unknown>)['checkEval']
  return typeof fn === 'function' ? fn as EvalGuard : undefined
}

export interface ExtensionDeps {
  now(): number
  config(defaults: BuracleConfig): LiveConfig
  health(): McpHealth
  policy: Pick<typeof corePolicy, 'checkBash' | 'checkWrite' | 'routeTool' | 'capabilityCard' | 'checkQuestion' | 'detectIntent' | 'isGuardContinuation'>
  evalGuard?: EvalGuard | undefined
  realpath?: (p: string) => string | undefined
  plan: Pick<typeof corePlan, 'stopGuardVerdict' | 'applyIntent' | 'validatePlan' | 'parsePlan' | 'promptInteraction' | 'answerReceipt'>
  compact: Pick<typeof coreCompact, 'compactInstructions' | 'handoffNote' | 'restoreContext'>
  checkers: Pick<typeof coreCheckers, 'checkersFor' | 'findingsOf' | 'tddHint' | 'charsetFindings' | 'lengthNote'>
  checkFs?: CheckFs
  resolveChecker?: (argv: readonly string[]) => string[]
  memSegment: typeof memSegment
  status: Pick<typeof coreStatus, 'rows' | 'renderPlain'>
  bar?: { lines: typeof barLines, render: typeof coreStatus.renderPlainLines, info(nowMs: number, memoryUi: { port: number }): Promise<BarInfo> }
  state: {
    load(sid: string): SessionState
    update(sid: string, fn: (s: SessionState) => SessionState): SessionState
    telemetry(sid: string, t: TelemetryPatch): void
    subjects?(sid: string | undefined): string[]
  }
  ledger: {
    load(sid: string): UsageLedger
    update(sid: string, fn: (l: UsageLedger) => UsageLedger): UsageLedger
  }
  flow: {
    start(sid: string, input: { workflow: string, title?: string, source: FlowSource }, now: number): boolean
    view(sid: string, now: number, foldAfterSec: number): BandView
  }
  memory: MemoryBridge
  plans: PlanStore
  captureEnabled(): boolean
  buracleRepo(cwd: string, configured: string | undefined): string | undefined
  cli(): string[] | undefined
  notifyDesktop(title: string, message: string): void
  projectSlug(cwd: string): Promise<string>
  branch(cwd: string): Promise<string | undefined>
  gitState(cwd: string): Promise<GitState | undefined>
  run(argv: string[], opts: { cwd?: string, timeoutMs?: number, env?: Record<string, string> }): Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>
  readText(path: string): string | undefined
  listDir(path: string): string[]
  isFile(path: string): boolean
  memoryStatus(slug: string | undefined): MemoryStatus | undefined
  memoryUi(): { url: string } | undefined
  usage(): UsageCacheEntry | undefined
  updates(): number | undefined
  refreshUsage(): void
  prune(keep: ReadonlySet<string>, nowMs: number): string[]
  consentGate(sid: string, command: string, nowMs: number): string | undefined
  consentGateAll(sid: string, commands: readonly string[], nowMs: number): string | undefined
  cm: CmDeps
  recordGrants(sid: string, text: string, nowMs: number): void
  recordAskGrant(sid: string, kind: ConsentKind, answer: 'once' | 'session', nowMs: number): void
  prepareWorkspace(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<WorkspaceInfo>
  workspaceInfo(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<WorkspaceInfo>
  refreshWorkspace(info: WorkspaceInfo, cfg: BuracleConfig, nowMs: number): WorkspaceInfo
  projectDeps(root: string | undefined): string[] | undefined
  reviewNotes?(sid: string, o: { plan?: string, roots: ReadonlyArray<string | undefined>, now: number }): string | undefined
  projectAssets: {
    context(root: string | undefined): string
    link(root: string | undefined, nowMs: number): boolean
    afterEdit(root: string | undefined, files: readonly string[], nowMs: number): string | undefined
  }
  codegraphIndexed(root: string): boolean
  profileGuard(lc: LiveConfig): string | undefined
  columns(): number
  setEnv(name: string, value: string): void
  home(): string
  reviewerFence?(): string | undefined
  timings: { toolCallMs: number, toolResultMs: number, statusIntervalMs: number, maintDelayMs: number }
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
  const text = await gitStatusPorcelainV2(cwd)
  if (text === undefined) return undefined
  const [gitDir, common] = await Promise.all([revParse(cwd, '--absolute-git-dir'), commonDir(cwd)])
  return gitFromPorcelainV2(text, gitDir, common)
}

export function defaultDeps(): ExtensionDeps {
  const cli = () => buracleCli(paths.shimPath(), paths.repoRoot())
  return {
    now: () => Date.now(),
    config: liveConfig,
    health: mcpHealth,
    policy: corePolicy,
    evalGuard: coreEvalGuard(),
    realpath: realWriteTarget,
    plan: corePlan,
    compact: coreCompact,
    checkers: coreCheckers,
    checkFs: nodeCheckFs,
    memSegment,
    status: coreStatus,
    bar: {
      lines: barLines,
      render: coreStatus.renderPlainLines,
      info: (nowMs, memoryUi) => barInfo('omp', { nowMs, memoryUi }),
    },
    state: {
      load: sid => loadState('omp', sid),
      update: (sid, fn) => updateState('omp', sid, fn),
      telemetry: (sid, t) => writeTelemetry('omp', sid, t),
      subjects: sid => reviewSubjects('omp', sid),
    },
    ledger: {
      load: sid => loadLedger('omp', sid),
      update: (sid, fn) => updateLedger('omp', sid, fn),
    },
    flow: {
      start: (sid, input, now) => recordFlowStart('omp', sid, input, now),
      view: (sid, now, foldAfterSec) => flowViewFor('omp', sid, now, foldAfterSec),
    },
    memory: createMemoryBridge({ cli }),
    plans: ompPlanStore(),
    captureEnabled: () => process.env['BURACLE_NO_CAPTURE'] !== '1',
    buracleRepo: (cwd, configured) => buracleRepoFor(cwd, [configured !== undefined ? paths.expandHome(configured) : undefined]),
    cli,
    projectSlug,
    branch: currentBranch,
    gitState,
    run: (argv, opts) => run(argv, opts),
    readText,
    listDir: path => { try { return readdirSync(path) } catch { return [] } },
    isFile: path => { try { return statSync(path).isFile() } catch { return false } },
    memoryStatus: readMemoryStatus,
    memoryUi: () => liveMemoryUi(),
    usage: () => readUsageCache()?.harnesses.omp,
    updates: () => pendingUpdates(),
    refreshUsage: () => {
      const argv = cli()
      if (argv !== undefined) spawnUsageRefresh('omp', { argv: [...argv, 'usage', 'refresh', '--harness', 'omp', '--background'] })
    },
    prune: (keep, nowMs) => [...sessionMaint('omp', nowMs, { keep }).removed, ...cmPrune(nowMs).removed],
    notifyDesktop: (title, message) => { spawnNotify(cli(), title, message) },
    consentGate: (sid, command, nowMs) => consentGate('omp', sid, command, nowMs),
    consentGateAll: (sid, commands, nowMs) => consentGateAll('omp', sid, commands, nowMs),
    cm: defaultCmDeps(),
    recordGrants: (sid, text, nowMs) => { recordPromptGrants('omp', sid, text, nowMs) },
    recordAskGrant: (sid, kind, answer, nowMs) => { recordDialogGrant('omp', sid, kind, answer, nowMs) },
    prepareWorkspace: (cwd, cfg, nowMs) => prepareWorkspace(cwd, cfg, nowMs),
    workspaceInfo: (cwd, cfg, nowMs) => workspaceInfo(cwd, cfg, nowMs),
    refreshWorkspace: (info, cfg, nowMs) => refreshWorkspaceInfo(info, cfg, nowMs),
    projectDeps: createDepsReader(),
    reviewNotes: (sid, o) => reviewNotesNotice('omp', sid, o),
    projectAssets: {
      context: root => assetsContext(root, 'omp'),
      link: (root, nowMs) => startLinkRun(root, { nowMs }),
      afterEdit: (root, files, nowMs) => assetsAfterEdit(root, files, { nowMs }),
    },
    codegraphIndexed: root => codegraphIndexPresent(root),
    profileGuard: lc => profileGuard('omp', lc.resolved !== undefined ? { resolved: lc.resolved } : undefined, process.env),
    columns: () => (typeof process.stdout.columns === 'number' && process.stdout.columns > 0 ? process.stdout.columns : 120),
    setEnv: (name, value) => { process.env[name] = value },
    home: () => paths.home(),
    reviewerFence: reviewerFenceFromEnv,
    timings: { toolCallMs: TOOL_CALL_DEADLINE_MS, toolResultMs: TOOL_RESULT_DEADLINE_MS, statusIntervalMs: STATUS_INTERVAL_MS, maintDelayMs: 15_000 },
  }
}

export function emptyGenerated(): OmpGenerated {
  const setStatus: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(DEFAULT_SET_STATUS)) setStatus[k] = [...v]
  return {
    v: 1, buracleVersion: '0.0.0', testedWith: '', minOmp: '', config: defaultConfig(), routing: { strictness: 'enforce', categories: [] },
    mcp: [], mcpIds: [], skills: [], plugins: [], commands: [], status: { layout: DEFAULT_BAND_LAYOUT, setStatus },
  }
}
