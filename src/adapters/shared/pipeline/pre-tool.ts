import type { HookId, ToolCall } from '../../../core/events'
import type { BashGuardOptions } from '../../../core/policy/bash-guard'
import { mcpWritePaths } from '../../../core/policy/mcp-paths'
import type { McpHealth } from '../../../core/policy/routing'
import type { ReminderContext, ReminderResult } from '../../../core/policy/usage'
import type { WriteGuardContext } from '../../../core/policy/write-guard'
import { log } from '../../../engine/log'
import { updateLedger } from '../../../workflow/ledger'
import { loadState, updateState } from '../../../workflow/session-store'
import type { AdapterContext } from '../../registry'
import { consentGate } from '../consent-store'
import { earlyEdit } from '../plan-mode'
import { realWriteTarget } from '../realpath'
import { buracleRepoFor } from '../repo'
import { selfPaths } from '../self-paths'
import { CONFIG_PARSERS } from '../write-content'
import { mcpHealth, routingPolicy, workspaceFacts } from './health'
import { denyReason, guardFailed, readWorkspace, type PipelineDeps } from './types'

export interface PreToolInput {
  call: ToolCall
  now: number
  subagent: boolean
  /** Guards only (a payload without a session): stop after the denials. */
  guardsOnly?: boolean
  /** Whether the usage reminders (H24) count and judge this call; their verdict, where the harness ran them at an earlier event of the same call. */
  usage: boolean | UsageVerdict
  /** The files the call edits, for the early-edit note; absent when it is no edit. */
  edits?: readonly string[]
  /** A question tool that does not wait for the answer: the plan pauses instead. */
  asyncQuestion?: boolean
}

export interface UsageVerdict { deny?: string, context?: string }

export type PreToolDecision =
  /** `reason` is the finished text, `Buracle Stack Hxx: …`. */
  | { action: 'deny', reason: string, hook: HookId }
  | { action: 'allow', context: string[], held?: { command: string, reason: string } }

export interface WriteTargets {
  paths: string[]
  /** The text each file gets, as far as the call shows it. */
  contents(guard: WriteGuardContext): NonNullable<WriteGuardContext['contents']>
}

/** What the usage reminders judge: the call as they see it, whose ledger counts it, and the servers that are up. */
export interface UsagePlan extends Pick<ReminderContext, 'available' | 'edits' | 'pathRules'> { call: ToolCall, ledgerId: string }

export interface PreToolPorts {
  /** A shell denial only this harness has, after the bash guard. */
  shellDenial?(command: string): Promise<string | undefined>
  /** True when the harness can ask the user about a held command itself; the call then goes on. */
  holdConsent?(command: string, reason: string): Promise<boolean>
  /** The files the call writes; undefined when it writes none the guard reads from the call. */
  writeTargets(call: ToolCall): WriteTargets | { deny: string } | undefined
  /** The MCP servers the harness's own settings turn off; read only for the calls whose route depends on them. */
  nativeOff(): string[]
  usage(call: ToolCall, health: McpHealth): UsagePlan | undefined
  usageDone?(plan: UsagePlan): void | Promise<void>
}

type Guarded = Pick<PipelineDeps, 'ctx' | 'realpath'>

export function bashOptions(ctx: AdapterContext, cwd: string, realpath: (p: string) => string | undefined = realWriteTarget): BashGuardOptions {
  return {
    ...ctx.config.guards.bash, home: ctx.paths.home(), selfPaths: selfPaths(ctx.config.repo, ctx.paths), cwd,
    vault: ctx.paths.oldVaultRoot(), protect: ctx.config.guards.write.protect, realpath,
  }
}

function repoOf(d: Guarded & Pick<PipelineDeps, 'buracleRepo'>, cwd: string): Promise<string | undefined> {
  const { ctx } = d
  return d.buracleRepo !== undefined ? d.buracleRepo(cwd, ctx) : buracleRepoFor(cwd, { known: [ctx.repoRoot, ctx.config.repo], home: ctx.paths.home() })
}

export async function writeGuardContext(d: Guarded & Pick<PipelineDeps, 'step' | 'buracleRepo'>, cwd: string): Promise<WriteGuardContext> {
  const { ctx } = d
  const repo = await d.step('H02 buracleRepo', undefined as string | undefined, () => repoOf(d, cwd))
  return {
    cwd, home: ctx.paths.home(), vault: ctx.paths.oldVaultRoot(), protect: ctx.config.guards.write.protect, realpath: d.realpath ?? realWriteTarget,
    selfPaths: selfPaths(ctx.config.repo, ctx.paths), parsers: CONFIG_PARSERS, ...(repo !== undefined ? { buracleRepo: repo } : {}),
  }
}

/** The usage reminders (H24) for one call: count it in the ledger and judge it. */
export async function usageVerdict(input: Pick<PreToolInput, 'call'>, d: PipelineDeps & Pick<PreToolPorts, 'usage' | 'usageDone'>, health: McpHealth): Promise<UsageVerdict> {
  const plan = d.usage(input.call, health)
  if (plan === undefined) return {}
  const { call, ledgerId, ...rest } = plan
  const cfg = d.ctx.config.routing
  const context: ReminderContext = { strictness: cfg.strictness, reminders: cfg.reminders, policy: routingPolicy(d.ctx), facts: workspaceFacts(d.ctx, readWorkspace(d.ctx, d.harness, input.call.sessionId)), ...rest }
  let result: ReminderResult | undefined
  updateLedger(d.harness, ledgerId, l => {
    result = d.core.reminders(l, call, context)
    return result.next
  })
  if (result?.deny === undefined) await d.usageDone?.(plan)
  return { ...(result?.deny !== undefined ? { deny: result.deny.reason } : {}), ...(result?.context !== undefined ? { context: result.context } : {}) }
}

/**
 * preTool: the guards (H01 bash, the subagent guard, H20 consent, H02 write), then tool routing (H03), the question
 * check (H09), the usage reminders (H24) and the early-edit note (H03). The first denial ends it. The call's kind
 * picks the steps; a guard that cannot run denies (fail closed).
 */
export async function preTool(input: PreToolInput, d: PipelineDeps & PreToolPorts): Promise<PreToolDecision> {
  const { call, now } = input
  const sid = call.sessionId
  const H = d.harness
  const deny = (hook: HookId, reason: string): PreToolDecision => ({ action: 'deny', reason: denyReason(hook, reason), hook })
  const failed = (hook: 'H01' | 'H02', error: unknown, mcp = false): PreToolDecision => {
    log('error', `${H} hook PreToolUse: ${hook} ${hook === 'H01' ? 'bash' : 'write'} guard failed${mcp ? ' for an MCP call' : ''}; denying (fail closed)`, { sid, tool: call.tool, error })
    return { action: 'deny', reason: guardFailed(hook, error), hook }
  }
  let held: { command: string, reason: string } | undefined
  if (call.kind === 'bash' && call.command !== undefined) {
    const command = call.command
    let verdict: { deny?: string }
    try {
      const repo = await repoOf(d, call.cwd)
      verdict = d.core.checkBash(command, { ...bashOptions(d.ctx, call.cwd, d.realpath), ...(repo !== undefined ? { buracleRepo: repo } : {}) })
    } catch (e) {
      return failed('H01', e)
    }
    if (verdict.deny !== undefined && verdict.deny !== '') return deny('H01', verdict.deny)
    const shell = await d.shellDenial?.(command)
    if (shell !== undefined) return deny('H01', shell)
    const guarded = input.subagent ? await d.step('H01 subagent guard', undefined as string | undefined, () => d.core.subagentStateDenial(command)) : undefined
    if (guarded !== undefined) return { action: 'deny', reason: guarded, hook: 'H01' }
    const consent = await d.step('H20 consent', undefined as string | undefined, () => consentGate(H, sid, command, now, d.core.consentVerdict))
    if (consent !== undefined) {
      if (d.holdConsent === undefined || !await d.holdConsent(command, consent)) return deny('H20', consent)
      held = { command, reason: consent }
    }
  }
  try {
    const t = d.writeTargets(call)
    if (t !== undefined && 'deny' in t) return deny('H02', t.deny)
    if (t !== undefined && t.paths.length > 0) {
      const guard = await writeGuardContext(d, call.cwd)
      const contents = t.contents(guard)
      const verdict = d.core.checkWrite(t.paths, Object.keys(contents).length > 0 ? { ...guard, contents } : guard)
      if (verdict.deny !== undefined && verdict.deny !== '') return deny('H02', verdict.deny)
    }
  } catch (e) {
    return failed('H02', e)
  }
  try {
    const targets = mcpWritePaths(call.tool, call.input, call.mcp)
    if (targets.length > 0) {
      const verdict = d.core.checkWrite(targets, await writeGuardContext(d, call.cwd))
      if (verdict.deny !== undefined && verdict.deny !== '') return deny('H02', verdict.deny)
    }
  } catch (e) {
    return failed('H02', e, true)
  }
  if (input.guardsOnly === true) return { action: 'allow', context: [] }
  let health: McpHealth | undefined
  const healthOf = (): McpHealth => (health ??= mcpHealth(d.ctx, H, now, { sid, nativeOff: call.kind === 'web_search' || call.kind === 'web_fetch' ? d.nativeOff() : [] }))
  const routed = await d.step('H03 routing', undefined as ReturnType<PipelineDeps['core']['routeTool']> | undefined, () => d.core.routeTool(call, routingPolicy(d.ctx), healthOf()))
  if (routed?.action === 'deny') return deny(routed.hook, routed.reason)
  const context: Array<string | undefined> = routed?.action === 'allow' && routed.context ? [...routed.context] : []
  if (call.kind === 'ask_user') {
    const r = await d.step('H09 checkQuestion', {} as { context?: string }, () => d.core.checkQuestion(loadState(H, sid), call, now))
    const paused = !input.subagent && input.asyncQuestion === true && r.context !== undefined && await d.step('H09 async question pause', false, () => {
      let changed = false
      updateState(H, sid, s => { const next = d.core.questionPause(s, call, now); changed = next !== s; return next })
      return changed
    })
    if (!input.subagent) context.push(paused ? d.core.ASYNC_QUESTION_PAUSED : r.context)
  }
  if (input.usage !== false) {
    const ran = input.usage
    const usage = ran !== true ? ran : await d.step('H24 usage', {} as UsageVerdict, () => usageVerdict(input, d, healthOf()))
    if (usage.deny !== undefined) return deny('H03', usage.deny)
    context.push(usage.context)
  }
  const early = input.edits !== undefined ? await d.step('H03 early edit', undefined, () => earlyEdit(H, sid, input.edits ?? [], call.cwd, d.ctx.config.plan.planApproval)) : undefined
  if (early !== undefined) {
    context.push(early.note)
    await d.step('H03 early edit mark', undefined, () => { early.commit() })
  }
  return { action: 'allow', context: context.filter((s): s is string => s !== undefined), ...(held !== undefined ? { held } : {}) }
}
