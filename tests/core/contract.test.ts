import { describe, expect, test } from 'bun:test'
import * as core from '../../src/core/index'
import type {
  BarModel, BuracleConfig, CatalogMcp, CatalogSkill, CheckerFacts, CheckerPlan, CompiledTriggers, DirScan, Finding, GitState, Harness, HookId, IndexStatus, Intent,
  McpHealth, MemItem, MemKind, MemLayer, MemRegion, MemoryStatus, Plan, PlanType, PreDecision, PricingTable, PromptRoute, PromptSignals, ReminderContext,
  ReminderResult, RouteOptions, RouteTextOptions, RoutingPolicy, Segment, SessionState, StatusLayout, StopDecision, StopInput, StopWhy,
  StartTextInput, TddEdit, TestCandidates, ToolCall, UsageLedger, WorkspaceInfo,
} from '../../src/core/index'

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
function assertType<T extends true>(_: T): void {  }

assertType<Equals<typeof core.defaultConfig, () => BuracleConfig>>(true)
assertType<Equals<typeof core.mergeConfig, (base: BuracleConfig, override: unknown) => BuracleConfig>>(true)
assertType<Equals<typeof core.validateConfig, (x: unknown) => { ok: true, config: BuracleConfig } | { ok: false, errors: string[] }>>(true)
assertType<Equals<BuracleConfig['harnesses'], Record<Harness, { enabled: boolean }>>>(true)
assertType<Equals<BuracleConfig['routing'], { strictness: 'enforce' | 'nudge' | 'off', skills: 'router' | 'off', reminders: boolean }>>(true)

const classify: (harness: Harness, tool: string, input: Record<string, unknown>, cwd: string) => Pick<ToolCall, 'kind' | 'command' | 'paths' | 'mcp'> = core.classifyTool
void classify
const parsePatch: (patch: string, cwd: string) => { paths: string[], added: Record<string, string> } = core.parseApplyPatch
void parsePatch
assertType<Equals<Parameters<typeof core.parseApplyPatch>, [patch: string, cwd: string, opts?: core.ToolPathOptions]>>(true)
assertType<Equals<ReturnType<typeof core.parseApplyPatch>, { paths: string[], added: Record<string, string> }>>(true)
assertType<Equals<HookId, 'H01' | 'H02' | 'H03' | 'H04' | 'H05' | 'H06' | 'H07' | 'H08' | 'H09' | 'H10' | 'H11' | 'H12' | 'H13' | 'H14' | 'H15' | 'H16' | 'H17' | 'H18' | 'H19' | 'H20' | 'H21' | 'H22' | 'H23' | 'H24' | 'H25' | 'H26' | 'H28'>>(true)
assertType<Equals<PreDecision, { action: 'allow', context?: string[] } | { action: 'deny', reason: string, hook: HookId }>>(true)
assertType<Equals<StopDecision, { action: 'allow' } | { action: 'block', reason: string, hook: HookId }>>(true)

assertType<Equals<typeof core.checkBash, (command: string, cfg: { extraDeny: string[] }) => { deny?: string }>>(true)
assertType<Equals<typeof core.checkWrite, (paths: string[], ctx: { cwd: string, home: string, vault: string, protect: string[] }) => { deny?: string }>>(true)
assertType<Equals<typeof core.routeTool, (call: ToolCall, policy: RoutingPolicy, health: McpHealth) => PreDecision>>(true)
assertType<Equals<typeof core.bashNudge, (command: string) => string | undefined>>(true)
assertType<Equals<typeof core.capabilityCard, (input: { policy: RoutingPolicy, mcp: CatalogMcp[], skills: CatalogSkill[], plugins: string[], harness: Harness, lsp?: string[] }) => string>>(true)
assertType<Equals<typeof core.checkQuestion, (state: SessionState, call: ToolCall, now: number) => { deny?: string, context?: string }>>(true)
assertType<Equals<typeof core.questionPause, (state: SessionState, call: ToolCall, now: number) => SessionState>>(true)
assertType<Equals<typeof core.questionAnswered, (response: unknown, depth?: number) => boolean>>(true)
assertType<Equals<typeof core.laneStateDenial, (command: string) => string | undefined>>(true)
assertType<Equals<typeof core.detectIntent, (text: string) => Intent>>(true)
assertType<Equals<Intent, 'pause' | 'resume' | 'stop' | 'history' | null>>(true)
assertType<Equals<typeof core.controlGuidance, (intent: Intent, opts: { hasPlan: boolean, interaction?: core.HeldInteraction }) => string | undefined>>(true)
assertType<Equals<keyof typeof core.CONTROL_GUIDANCE, 'pausePlan' | 'pause' | 'resume' | 'stop' | 'autoPause' | 'resultApproved'>>(true)
assertType<Equals<typeof core.promptInteraction, (state: SessionState, control: 'pause' | 'resume' | 'stop' | null, text: string, opts: { autoPause: boolean, now: number }) => core.PromptInteraction>>(true)
assertType<Equals<typeof core.stopGuardVerdict, (state: SessionState, input: StopInput, cfg: BuracleConfig['plan'], planCheck?: core.PlanDoc) => core.StopGuardResult>>(true)
assertType<Equals<core.PlanDoc, { exists: boolean, findings: Finding[], text?: string }>>(true)

assertType<Equals<typeof core.detectSignals, (text: string) => PromptSignals>>(true)
assertType<Equals<PromptSignals, { control: 'pause' | 'resume' | 'stop' | null; recall: boolean; write: boolean }>>(true)
const compile: (skills: CatalogSkill[], policy: RoutingPolicy) => CompiledTriggers = core.compileTriggers
void compile
assertType<Equals<typeof core.routePrompt, (text: string, t: CompiledTriggers, o: RouteOptions) => PromptRoute>>(true)
assertType<Equals<RouteOptions, { harness: Harness; loaded: readonly string[]; available: readonly string[]; deps?: readonly string[] }>>(true)
assertType<Equals<typeof core.routeText, (r: PromptRoute, h: Harness, policy: RoutingPolicy, opts?: RouteTextOptions) => string | undefined>>(true)
assertType<Equals<Pick<PromptRoute, 'invoked' | 'load' | 'candidates' | 'categories'>, { invoked: string[]; load: string[]; candidates: string[]; categories: string[] }>>(true)
assertType<Equals<typeof core.ledgerPrompt, (l: UsageLedger, route: PromptRoute, now: number) => UsageLedger>>(true)
assertType<Equals<typeof core.ledgerCall, (l: UsageLedger, call: ToolCall) => UsageLedger>>(true)
assertType<Equals<typeof core.reminders, (l: UsageLedger, call: ToolCall, ctx: ReminderContext) => ReminderResult>>(true)
assertType<Equals<ReminderResult, { context?: string; deny?: { reason: string; key: string }; next: UsageLedger }>>(true)
assertType<Equals<typeof core.turnAudit, (l: UsageLedger) => StopDecision>>(true)
assertType<Equals<typeof core.ledgerAudited, (l: UsageLedger, decision?: StopDecision) => UsageLedger>>(true)
assertType<Equals<typeof core.changedExports, (oldText: string, newText: string, file: string) => string[]>>(true)
assertType<Equals<typeof core.importedPackages, (text: string, file: string) => string[]>>(true)
assertType<Equals<typeof core.parseManifestDeps, (name: string, text: string) => string[]>>(true)
const skillOf: (call: ToolCall, harness: Harness) => string | undefined = core.skillOf
void skillOf

assertType<Equals<typeof core.parsePlan, (markdown: string) => Plan>>(true)
assertType<Equals<typeof core.validatePlan, (markdown: string, opts?: { strict?: boolean }) => Finding[]>>(true)
assertType<Equals<typeof core.planSkeleton, (opts: { type: PlanType, title: string, created: string }) => string>>(true)
assertType<Equals<typeof core.emptyState, () => SessionState>>(true)
assertType<Equals<typeof core.stopVerdict, (state: SessionState, input: StopInput, cfg: BuracleConfig['plan']) => { decision: StopDecision, next: SessionState }>>(true)
assertType<Equals<typeof core.planValidateVerdict, (state: SessionState, planExists: boolean, findings: Finding[]) => StopDecision>>(true)
assertType<Equals<typeof core.applyIntent, (state: SessionState, intent: Intent, now: number) => SessionState>>(true)
assertType<Equals<typeof core.routeAuditAllowed, (why: StopWhy | undefined, strictness: 'enforce' | 'nudge' | 'off') => boolean>>(true)
assertType<Equals<typeof core.ROUTE_AUDIT_AFTER, readonly StopWhy[]>>(true)
const autoPauseReason: string = core.AUTO_PAUSE_REASON
void autoPauseReason

assertType<Equals<typeof core.compactInstructions, (base: string | undefined, state: SessionState) => string>>(true)
assertType<Equals<typeof core.handoffNote, (input: { state: SessionState, project: string, harness: Harness, sessionId: string, branch?: string, now: number, todo?: string[] }) => { slug: string, markdown: string }>>(true)
assertType<Equals<typeof core.restoreContext, (state: SessionState, handoffPath?: string, todos?: readonly string[]) => string | undefined>>(true)

assertType<Equals<typeof core.checkersFor, (path: string, facts: CheckerFacts, cfg: BuracleConfig['checkers']) => CheckerPlan[]>>(true)
assertType<Equals<typeof core.checkerFacts, (scans: readonly DirScan[], cwd: string) => CheckerFacts>>(true)
assertType<Equals<typeof core.checkerDirs, (file: string, root: string | undefined, home?: string) => string[]>>(true)
assertType<Equals<typeof core.missingToolNote, (plan: CheckerPlan) => string | undefined>>(true)
assertType<Equals<typeof core.missingToolKey, (plan: CheckerPlan) => string>>(true)
assertType<Equals<typeof core.findingsOf, (plan: CheckerPlan, result: { code: number, stdout: string, stderr: string } | null) => string | undefined>>(true)
assertType<Equals<typeof core.tddHint, (path: string, candidates: readonly string[] | TestCandidates, edit?: TddEdit) => string | undefined>>(true)
assertType<Equals<typeof core.charsetFindings, (addedText: string, path: string, fileText?: string) => string[]>>(true)
assertType<Equals<typeof core.lengthNote, (lineCount: number) => string | undefined>>(true)

assertType<Equals<typeof core.gitFromPorcelainV2, (text: string, gitDir?: string, commonDir?: string) => GitState>>(true)
assertType<Equals<typeof core.pace, (usedPct: number, resetsAtIso: string | undefined, windowMinutes: number, nowMs: number) => 'over' | 'under' | 'even'>>(true)
assertType<Equals<typeof core.windowLabel, (minutes: number) => string>>(true)
assertType<Equals<typeof core.rows, (bar: BarModel, layout: StatusLayout, width: number, nowMs: number) => Segment[][]>>(true)
assertType<Equals<typeof core.renderAnsi, (rows: Segment[][]) => string>>(true)
assertType<Equals<typeof core.renderPlain, (rows: Segment[][]) => string>>(true)
assertType<Equals<typeof core.indexStatusOf, (info: WorkspaceInfo) => IndexStatus | undefined>>(true)

assertType<Equals<typeof core.parseNote, (markdown: string) => { fm: Record<string, unknown>, body: string }>>(true)
assertType<Equals<typeof core.slugify, (title: string) => string>>(true)
assertType<Equals<typeof core.normalizeForSearch, (text: string) => string>>(true)
assertType<Equals<typeof core.redact, (text: string) => { text: string; count: number; kinds: string[] }>>(true)
assertType<Equals<typeof core.memSegment, (s: MemoryStatus | undefined, nowMs: number, style: 'compact' | 'wide') => Segment>>(true)
assertType<Equals<typeof core.fromCortex, (raw: unknown, layer: MemLayer) => MemItem | undefined>>(true)
assertType<Equals<typeof core.toCortexSave, (item: MemItem, keep?: Readonly<Record<string, unknown>>, nowMs?: number) => Record<string, unknown>>>(true)
assertType<Equals<typeof core.cortexQuery, (query: string, topK: number) => Record<string, unknown>>>(true)
assertType<Equals<typeof core.regionOf, (kind: MemKind) => MemRegion>>(true)
assertType<Equals<typeof core.isLive, (item: MemItem, nowMs: number) => boolean>>(true)
assertType<Equals<typeof core.brainStartText, (input: StartTextInput) => string>>(true)
assertType<Equals<typeof core.memLocked, (i: Pick<MemItem, 'origin' | 'pinned'>) => boolean>>(true)
assertType<Equals<typeof core.memProtected, (i: Pick<MemItem, 'origin' | 'pinned' | 'review'>) => boolean>>(true)
assertType<Equals<typeof core.promptSignals, (text: string) => core.PromptSignal[]>>(true)
assertType<Equals<MemLayer, 'project' | 'person'>>(true)
assertType<Equals<MemoryStatus['v'], 3>>(true)

assertType<Equals<typeof core.priceOf, (model: string, tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }, table: PricingTable) => number | undefined>>(true)

describe('core exports', () => {
  test('every contracted function is exported from src/core/index.ts', () => {
    const fns = [
      'defaultConfig', 'mergeConfig', 'validateConfig', 'classifyTool', 'parseApplyPatch',
      'checkBash', 'checkWrite', 'routeTool', 'bashNudge', 'capabilityCard', 'checkQuestion', 'detectIntent',
      'parsePlan', 'validatePlan', 'planSkeleton', 'emptyState', 'stopVerdict', 'planValidateVerdict', 'applyIntent',
      'compactInstructions', 'handoffNote', 'restoreContext', 'compactPrompt', 'validateNotices', 'pendingNotices', 'noticeTexts', 'isCorruptIndexError',
      'checkersFor', 'findingsOf', 'tddHint', 'charsetFindings', 'lengthNote', 'checkerFacts', 'checkerDirs', 'missingToolNote', 'missingToolKey',
      'gitFromPorcelainV2', 'pace', 'windowLabel', 'rows', 'renderAnsi', 'renderPlain',
      'parseNote', 'slugify', 'normalizeForSearch', 'redact', 'memSegment',
      'fromCortex', 'toCortexSave', 'cortexQuery', 'regionOf', 'isLive', 'brainStartText', 'memLocked', 'memProtected', 'ttlSeconds', 'promptSignals', 'sanitizePromptSignal', 'memHealth',
      'priceOf',
      'realpathQueries', 'checkEval', 'catastrophicCommandRules', 'scanCode', 'redactClip',
      'compileTriggers', 'routePrompt', 'routeText', 'parseSkillTriggers', 'validateSkillTriggers', 'detectSignals', 'isUserText',
      'emptyLedger', 'parseLedger', 'ledgerPrompt', 'ledgerCall', 'skillOf', 'reminders', 'turnAudit', 'ledgerAudited',
      'changedExports', 'importedPackages', 'parseManifestDeps', 'patchEdits', 'patchDeletes', 'isDocsUrl',
      'controlGuidance', 'routeAuditAllowed', 'mcpHealthOf', 'ledgerMcpResult', 'sessionMcpHealth', 'rootProblem', 'rootCheckText',
      'visitShellCommands', 'selfProtectedArea', 'selfProtectionText', 'indexStatusOf',
      'ruleGlobs', 'pathRuleIndex', 'projectRelative', 'matchPathRules', 'ruleText', 'ruleFileId', 'pathRuleNote',
      'promptInteraction', 'answerReceipt', 'approveResult', 'dropResultApproval', 'resumePlan', 'planProgressed', 'needsResultApproval', 'planObjective',
      'objectiveLine', 'backgroundWait', 'finiteRunner', 'questionPause', 'questionAnswered', 'laneStateDenial', 'pausedReply', 'isResultApproval', 'isResultReview',
      'isRunawayDecision', 'resultReviewable', 'isHandback', 'isModelSwitch', 'resumableDecision', 'tickedTasks',
    ]
    const exported = core as unknown as Record<string, unknown>
    for (const f of fns) expect({ f, type: typeof exported[f] }).toEqual({ f, type: 'function' })
  })

  test('every contracted constant is exported from src/core/index.ts', () => {
    const exported = core as unknown as Record<string, unknown>
    expect(exported['ROUTE_AUDIT_AFTER']).toEqual(['finished', 'no-plan', 'disabled'])
    expect(typeof exported['AUTO_PAUSE_REASON']).toBe('string')
    expect(Object.keys(exported['CONTROL_GUIDANCE'] as object).sort()).toEqual(['autoPause', 'pause', 'pausePlan', 'resultApproved', 'resume', 'stop'])
    expect(exported['RESULT_REVIEW_REASON']).toBe('result review')
    expect(exported['RUNAWAY_REASON']).toBe('runaway: continue, pivot or abandon?')
    expect(exported['HANDBACK_REASON']).toBe('build hand-back:')
    expect(exported['MODEL_SWITCH_REASON']).toBe('model switch:')
    expect(typeof exported['MCP_SESSION_DOWN_ERRORS']).toBe('number')
    expect(exported['PATH_RULE_TEXT_MAX_CHARS']).toBe(7000)
  })
})
