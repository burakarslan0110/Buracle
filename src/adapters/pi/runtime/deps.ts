import { readFileSync } from 'node:fs'
import type { BuracleConfig } from '../../../core/config'
import { defaultConfig } from '../../../core/config'
import * as coreCheckers from '../../../core/checkers'
import * as coreCompact from '../../../core/compact'
import type { ConsentKind } from '../../../core/policy/consent'
import * as corePolicy from '../../../core/policy/index'
import type { McpHealth } from '../../../core/policy/routing'
import type { UsageLedger } from '../../../core/policy/usage'
import type { WriteGuardContext } from '../../../core/policy/write-guard'
import * as corePlan from '../../../core/plan/index'
import type { SessionState } from '../../../core/plan/index'
import { indexSettings, type WorkspaceInfo } from '../../../core/workspace'
import { currentBranch, projectSlug } from '../../../engine/git'
import * as paths from '../../../engine/paths'
import { run } from '../../../engine/proc'
import { loadLedger, updateLedger } from '../../../workflow/ledger'
import { loadState, reviewSubjects, sessionMaint, updateState } from '../../../workflow/session-store'
import { refreshWorkspaceInfo, workspaceInfo } from '../../../workflow/workspace'
import { nodeCheckFs, type CheckFs } from '../../shared/checker-scan'
import { recordDialogGrant } from '../../shared/consent-dialog'
import { liveConfig, mcpHealth, type LiveConfig } from '../../shared/pi-family/config'
import { buracleCli, createMemoryBridge, type MemoryBridge } from '../../shared/pi-family/memory'
import { createDepsReader } from '../../shared/pi-family/routing'
import type { AssetsSpawner } from '../../shared/project-assets'
import { realWriteTarget } from '../../shared/realpath'
import { buracleRepoFor } from '../../shared/repo-cache'
import { prepareWorkspace } from '../../shared/workspace-start'
import type { PiGenerated } from './types'

export const TOOL_CALL_DEADLINE_MS = 3_000
export const TOOL_RESULT_DEADLINE_MS = 25_000

export type EvalGuard = (code: string, language: string, ctx: WriteGuardContext, opts?: { extraDeny?: string[] }) => { deny?: string, hook?: 'H01' | 'H02' }

/** Pi's `codemode` tool runs a script (`code`): the one tool whose input is a program. */
export const CODE_EXECUTION_TOOLS: ReadonlySet<string> = new Set(['codemode'])

function coreEvalGuard(): EvalGuard | undefined {
  const fn = (corePolicy as unknown as Record<string, unknown>)['checkEval']
  return typeof fn === 'function' ? fn as EvalGuard : undefined
}

/** What the extension takes from outside, so a test can replace any of it. */
export interface PiDeps {
  now(): number
  config(defaults: BuracleConfig): LiveConfig
  health(): McpHealth
  policy: Pick<typeof corePolicy, 'checkBash' | 'checkWrite' | 'routeTool' | 'capabilityCard' | 'checkQuestion' | 'detectIntent' | 'isGuardContinuation'>
  evalGuard?: EvalGuard | undefined
  realpath?: (p: string) => string | undefined
  plan: Pick<typeof corePlan, 'stopGuardVerdict' | 'promptInteraction' | 'answerReceipt' | 'validatePlan'>
  compact: Pick<typeof coreCompact, 'handoffNote' | 'restoreContext'>
  checkers: Pick<typeof coreCheckers, 'checkersFor' | 'findingsOf'>
  checkFs?: CheckFs
  resolveChecker?: (argv: readonly string[]) => string[]
  state: { load(sid: string): SessionState, update(sid: string, fn: (s: SessionState) => SessionState): SessionState, subjects?(sid: string | undefined): string[] }
  ledger: { load(sid: string): UsageLedger, update(sid: string, fn: (l: UsageLedger) => UsageLedger): UsageLedger }
  memory: MemoryBridge
  captureEnabled(): boolean
  buracleRepo(cwd: string, configured: string | undefined): string | undefined
  cli(): string[] | undefined
  projectSlug(cwd: string): Promise<string>
  branch(cwd: string): Promise<string | undefined>
  run(argv: string[], opts: { cwd?: string, timeoutMs?: number, env?: Record<string, string> }): Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>
  readText(path: string): string | undefined
  prune(keep: ReadonlySet<string>, nowMs: number): string[]
  recordAskGrant(sid: string, kind: ConsentKind, answer: 'once' | 'session', nowMs: number): void
  prepareWorkspace(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<WorkspaceInfo>
  workspaceInfo(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<WorkspaceInfo>
  refreshWorkspace(info: WorkspaceInfo, cfg: BuracleConfig, nowMs: number): WorkspaceInfo
  projectDeps(root: string | undefined): string[] | undefined
  assetsSpawn?: AssetsSpawner
  setEnv(name: string, value: string): void
  home(): string
  timings: { toolCallMs: number, toolResultMs: number, maintDelayMs: number }
}

export function defaultDeps(): PiDeps {
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
    state: {
      load: sid => loadState('pi', sid),
      update: (sid, fn) => updateState('pi', sid, fn),
      subjects: sid => reviewSubjects('pi', sid),
    },
    ledger: { load: sid => loadLedger('pi', sid), update: (sid, fn) => updateLedger('pi', sid, fn) },
    memory: createMemoryBridge({ harness: 'pi', cli }),
    captureEnabled: () => process.env['BURACLE_NO_CAPTURE'] !== '1',
    buracleRepo: (cwd, configured) => buracleRepoFor(cwd, [configured !== undefined ? paths.expandHome(configured) : undefined]),
    cli,
    projectSlug,
    branch: currentBranch,
    run: (argv, opts) => run(argv, opts),
    readText: path => { try { return readFileSync(path, 'utf8') } catch { return undefined } },
    prune: (keep, nowMs) => sessionMaint('pi', nowMs, { keep }).removed,
    recordAskGrant: (sid, kind, answer, nowMs) => { recordDialogGrant('pi', sid, kind, answer, nowMs) },
    prepareWorkspace: (cwd, cfg, nowMs) => prepareWorkspace(cwd, indexSettings(cfg), nowMs),
    workspaceInfo: (cwd, cfg, nowMs) => workspaceInfo(cwd, indexSettings(cfg), nowMs),
    refreshWorkspace: (info, cfg, nowMs) => refreshWorkspaceInfo(info, indexSettings(cfg), nowMs),
    projectDeps: createDepsReader(),
    setEnv: (name, value) => { process.env[name] = value },
    home: () => paths.home(),
    timings: { toolCallMs: TOOL_CALL_DEADLINE_MS, toolResultMs: TOOL_RESULT_DEADLINE_MS, maintDelayMs: 15_000 },
  }
}

export function emptyGenerated(): PiGenerated {
  return { v: 1, buracleVersion: '0.0.0', config: defaultConfig(), routing: { strictness: 'enforce', categories: [] }, mcp: [], mcpIds: [], skills: [] }
}
