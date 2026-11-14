import type { HookId, ToolCall } from '../../../core/events'
import type { BashGuardOptions } from '../../../core/policy/bash-guard'
import { mcpWritePaths } from '../../../core/policy/mcp-paths'
import type { McpHealth, RoutingPolicy } from '../../../core/policy/routing'
import type { ReminderContext, ReminderResult } from '../../../core/policy/usage'
import type { WriteGuardContext } from '../../../core/policy/write-guard'
import { updateLedger } from '../../../workflow/ledger'
import { loadState, updateState } from '../../../workflow/session-store'
import { consentGate } from '../consent-store'
import type { EarlyEdit } from '../plan-mode'
import type { PipelineDeps } from './types'

/** Which guard or gate decided; the adapter words the denial from it. */
export type PreToolSource = 'bash' | 'shell' | 'lane' | 'consent' | 'write' | 'mcpWrite' | 'route' | 'root' | 'usage'

export interface PreToolInput {
  call: ToolCall
  now: number
  subagent: boolean
  /** Guards only (a payload without a session): stop after the denials. */
  guardsOnly?: boolean
  /** The steps this call goes through; a harness picks them by tool name or by kind. */
  checks: { bash?: boolean, write?: boolean, mcpWrite?: boolean, question?: boolean, route?: boolean, usage?: boolean }
  /** A question tool that does not wait for the answer: the plan pauses instead. */
  asyncQuestion?: boolean
}

export interface PreToolParts { question?: string, route: string[], usage?: string, early?: string }

export type PreToolDecision =
  /** `error` is set when the guard itself failed: the call is denied (fail closed) and the adapter logs it. */
  | { action: 'deny', reason: string, hook: HookId, source: PreToolSource, error?: unknown }
  | { action: 'allow', context: string[], parts: PreToolParts, held?: { command: string, reason: string } }

export interface WriteTargets {
  paths: string[]
  /** The text each file gets, as far as the call shows it. */
  contents(guard: WriteGuardContext): NonNullable<WriteGuardContext['contents']>
}

export interface UsagePlan { call: ToolCall, ledgerId: string, context: ReminderContext }

export interface PreToolPorts {
  bashOptions(cwd: string): BashGuardOptions
  /** The lane guard: a subagent's command must not touch another lane's state. */
  laneDenial(command: string): string | undefined
  /** A shell denial only this harness has, after the bash guard. */
  shellDenial?(command: string): Promise<string | undefined>
  /** True when the harness can ask the user about a held command itself; the call then goes on. */
  holdConsent?(command: string, reason: string): Promise<boolean>
  writeTargets(call: ToolCall): WriteTargets | { deny: string }
  writeGuardContext(cwd: string): Promise<WriteGuardContext>
  routingPolicy(): RoutingPolicy
  mcpHealth(call: ToolCall): () => McpHealth
  /** A check before the reminders that denies or notes on its own. */
  rootCheck?(call: ToolCall): { deny?: string, context?: string }
  usage(call: ToolCall, health: () => McpHealth): UsagePlan | undefined
  usageDone?(plan: UsagePlan): void | Promise<void>
  /** The note for an edit made before the plan is approved; absent when the call is no edit. */
  earlyEdit?(): EarlyEdit | undefined
}

function deny(hook: HookId, reason: string, source: PreToolSource, error?: unknown): PreToolDecision {
  return { action: 'deny', reason, hook, source, ...(error !== undefined ? { error } : {}) }
}

function contextOf(parts: PreToolParts): string[] {
  return [parts.question, ...parts.route, parts.usage, parts.early].filter((s): s is string => s !== undefined)
}

interface UsageOutcome { deny?: string, source?: 'root' | 'usage', context?: string }

async function usageStep(input: PreToolInput, d: PipelineDeps & PreToolPorts, health: () => McpHealth): Promise<UsageOutcome> {
  const { call } = input
  const root = d.rootCheck?.(call) ?? {}
  if (root.deny !== undefined) return { deny: root.deny, source: 'root' }
  if (root.context !== undefined) {
    updateLedger(d.harness, call.sessionId, l => d.core.ledgerCall(l, call))
    return { context: root.context }
  }
  const plan = d.usage(call, health)
  if (plan === undefined) return {}
  let result: ReminderResult | undefined
  updateLedger(d.harness, plan.ledgerId, l => {
    result = d.core.reminders(l, plan.call, plan.context)
    return result.next
  })
  if (result?.deny === undefined) await d.usageDone?.(plan)
  return {
    ...(result?.deny !== undefined ? { deny: result.deny.reason.replace(/^Buracle:\s*/, ''), source: 'usage' as const } : {}),
    ...(result?.context !== undefined ? { context: result.context } : {}),
  }
}

/**
 * preTool: the guards (H01 bash, the lane guard, H20 consent, H02 write), then the question check (H09), tool
 * routing (H03), the usage reminders (H24) and the early-edit note (H03). The first denial ends it.
 */
export async function preTool(input: PreToolInput, d: PipelineDeps & PreToolPorts): Promise<PreToolDecision> {
  const { call, now, checks } = input
  const sid = call.sessionId
  const H = d.harness
  let held: { command: string, reason: string } | undefined
  if (checks.bash === true && call.command !== undefined) {
    const command = call.command
    let verdict: { deny?: string }
    try {
      verdict = d.core.checkBash(command, d.bashOptions(call.cwd))
    } catch (e) {
      return deny('H01', '', 'bash', e)
    }
    if (verdict.deny !== undefined && verdict.deny !== '') return deny('H01', verdict.deny, 'bash')
    const shell = await d.shellDenial?.(command)
    if (shell !== undefined) return deny('H01', shell, 'shell')
    const lane = input.subagent ? await d.step('H01 lane guard', undefined as string | undefined, () => d.laneDenial(command)) : undefined
    if (lane !== undefined) return deny('H01', lane, 'lane')
    const consent = await d.step('H20 consent', undefined as string | undefined, () => consentGate(H, sid, command, now, d.core.consentVerdict))
    if (consent !== undefined) {
      if (d.holdConsent === undefined || !await d.holdConsent(command, consent)) return deny('H20', consent, 'consent')
      held = { command, reason: consent }
    }
  }
  if (checks.write === true) {
    try {
      const t = d.writeTargets(call)
      if ('deny' in t) return deny('H02', t.deny, 'write')
      if (t.paths.length > 0) {
        const guard = await d.writeGuardContext(call.cwd)
        const contents = t.contents(guard)
        const full: WriteGuardContext = Object.keys(contents).length > 0 ? { ...guard, contents } : guard
        const verdict = d.core.checkWrite(t.paths, full)
        if (verdict.deny !== undefined && verdict.deny !== '') return deny('H02', verdict.deny, 'write')
      }
    } catch (e) {
      return deny('H02', '', 'write', e)
    }
  }
  if (checks.mcpWrite === true) {
    try {
      const targets = mcpWritePaths(call.tool, call.input, call.mcp)
      if (targets.length > 0) {
        const verdict = d.core.checkWrite(targets, await d.writeGuardContext(call.cwd))
        if (verdict.deny !== undefined && verdict.deny !== '') return deny('H02', verdict.deny, 'mcpWrite')
      }
    } catch (e) {
      return deny('H02', '', 'mcpWrite', e)
    }
  }
  const parts: PreToolParts = { route: [] }
  if (input.guardsOnly === true) return { action: 'allow', context: [], parts }
  if (checks.question === true) {
    const r = await d.step('H09 checkQuestion', {} as { context?: string }, () => d.core.checkQuestion(loadState(H, sid), call, now))
    if (!input.subagent) {
      const paused = input.asyncQuestion === true && r.context !== undefined
        ? await d.step('H09 async question pause', false, () => {
          let changed = false
          updateState(H, sid, s => { const next = d.core.questionPause(s, call, now); changed = next !== s; return next })
          return changed
        })
        : false
      const text = paused ? d.core.ASYNC_QUESTION_PAUSED : r.context
      if (text !== undefined) parts.question = text
    }
  }
  const health = d.mcpHealth(call)
  if (checks.route === true) {
    const r = await d.step('H03 routing', undefined as ReturnType<PipelineDeps['core']['routeTool']> | undefined, () => d.core.routeTool(call, d.routingPolicy(), health()))
    if (r?.action === 'deny') return deny(r.hook, r.reason, 'route')
    if (r?.action === 'allow' && r.context) parts.route = [...r.context]
  }
  if (checks.usage === true) {
    const usage = await d.step('H24 usage', {} as UsageOutcome, () => usageStep(input, d, health))
    if (usage.deny !== undefined) return deny('H03', usage.deny, usage.source ?? 'usage')
    if (usage.context !== undefined) parts.usage = usage.context
  }
  if (d.earlyEdit !== undefined) {
    const note = d.earlyEdit
    const early = await d.step('H03 early edit', undefined as EarlyEdit | undefined, () => note())
    if (early !== undefined) {
      parts.early = early.note
      await d.step('H03 early edit mark', undefined, () => { early.commit() })
    }
  }
  return { action: 'allow', context: contextOf(parts), parts, ...(held !== undefined ? { held } : {}) }
}
