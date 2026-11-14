import type { PromptDecision, PromptInput } from '../../../core/events'
import { spoolPromptExcerpt } from '../../../core/memory/spool'
import type { PromptSignals } from '../../../core/policy/intents'
import { PROMPT_CONTEXT_MAX_CHARS, type PromptRoute } from '../../../core/policy/skill-router'
import { updateLedger } from '../../../workflow/ledger'
import { loadState, updateState } from '../../../workflow/session-store'
import { recordPromptGrants } from '../consent-store'
import { readOnlyStart, startedWorkflow } from '../plan-mode'
import { reviewNotesNotice } from '../review-notes'
import { captureOff, fitParts, readWorkspace, saveWorkspace, spool, type PipelineDeps } from './types'

export interface PromptPorts {
  /**
   * The skills and MCP categories the prompt asks for, with the routing note. `deferred` says the harness hands the
   * prompt to the model later (a queue) and records the route in the ledger itself when it does.
   */
  routePrompt(signals: PromptSignals): Promise<{ route: PromptRoute, text?: string, deferred?: boolean } | undefined>
  /** After the route reached the ledger. */
  promptRouted?(route: PromptRoute): void | Promise<void>
  /** A step only this harness has, after the consent grants; a text it returns is context. */
  granted?(): Promise<string | undefined | void>
  /** A workflow the prompt starts by a typed command, besides the routed ones. */
  typedWorkflow?: string
  /** Whether the session is read-only (plan mode); asked only when the answer matters. */
  readOnly(): boolean | Promise<boolean>
  contextWarning(): string | undefined | Promise<string | undefined>
}

export interface PromptResult extends PromptDecision {
  /** The prompt is the stop guard's own continuation, not the user's. */
  continuation: boolean
  /** The user wrote it: intents, grants and routing ran. */
  user: boolean
}

const NO_SIGNALS: PromptSignals = { control: null, recall: false, write: false }

function interaction(input: PromptInput, control: PromptSignals['control'], d: PipelineDeps): string | undefined {
  const { harness: H, sessionId: sid, text: prompt } = input
  const opts = { now: input.now }
  const before = loadState(H, sid)
  if (before.plan === undefined) return d.core.promptInteraction(before, control, prompt, opts).guidance
  let guidance: string | undefined
  updateState(H, sid, s => {
    const r = d.core.promptInteraction(s, control, prompt, opts)
    guidance = r.guidance
    return r.next
  })
  return guidance
}

function workspaceNotice(sid: string, now: number, d: PipelineDeps): string | undefined {
  const prev = readWorkspace(d.ctx, d.harness, sid)
  if (prev === undefined || d.workspace.refreshWorkspace === undefined) return undefined
  const next = d.workspace.refreshWorkspace(prev, d.ctx, now)
  if (JSON.stringify(next) !== JSON.stringify(prev)) saveWorkspace(d.ctx, d.harness, sid, next)
  return d.core.workspaceNotice(prev, next)
}

/**
 * prompt: the user's intents and the plan interaction (H10), review notes, consent grants (H20), skill and MCP
 * routing (H22, H24), the read-only start note, the workspace notice (H21), the context warning (H05), then the
 * spool, the session record and the memory UI (H14).
 */
export async function prompt(input: PromptInput, d: PipelineDeps & PromptPorts): Promise<PromptResult> {
  const { harness: H, sessionId: sid, cwd, text, now } = input
  const opt = <T>(name: string, fn: () => T | Promise<T>) => d.step(name, undefined as T | undefined, fn)
  const continuation = await d.step('H10 isGuardContinuation', false, () => d.core.isGuardContinuation(text))
  const user = !continuation && input.userText !== false
  const parts: Array<string | undefined | void> = []
  if (user) {
    const signals = await d.step('H10 detectSignals', NO_SIGNALS, () => d.core.detectSignals(text))
    parts.push(await opt('H10 intents', () => interaction(input, signals.control, d)))
    parts.push(await opt('H10 review notes', () => {
      const ws = readWorkspace(d.ctx, H, sid)
      return reviewNotesNotice(H, sid, { plan: loadState(H, sid).plan?.path, roots: [ws?.root, ws?.cwd, cwd], now })
    }))
    await d.step('H20 grants', undefined, () => { recordPromptGrants(H, sid, text, now) })
    parts.push(await d.granted?.())
    const candidates: Array<string | undefined> = [d.typedWorkflow]
    const route = await opt('H22 route.prompt', async () => {
      const routed = await d.routePrompt(signals)
      if (routed === undefined) return undefined
      candidates.push(...routed.route.invoked, ...routed.route.load)
      if (routed.deferred !== true) await d.step('H24 ledger prompt', undefined, () => { updateLedger(H, sid, l => d.core.ledgerPrompt(l, routed.route, now)) })
      await d.promptRouted?.(routed.route)
      return routed.text
    })
    parts.push(await opt('H10 read-only start', async () => (startedWorkflow(candidates) !== undefined && await d.readOnly() ? readOnlyStart(H, true, candidates) : undefined)), route)
  }
  parts.push(await opt('H21 workspace notice', () => workspaceNotice(sid, now, d)), await opt('H05 context warning', () => d.contextWarning()))
  if (!continuation) {
    const excerpt = user ? spoolPromptExcerpt(text) : undefined
    await spool(d, sid, [{ ts: now, ev: 'prompt', ...(excerpt !== undefined ? { excerpt } : {}) }])
    if (!captureOff(d)) await d.step('session record touch', undefined, async () => { (await d.memory('promptSeen'))?.(H, sid, { nowMs: now }) })
  }
  await d.step('H14 memory UI', undefined, () => d.ui.seen(H, sid, now))
  return { continuation, user, context: fitParts(parts.filter((s): s is string => typeof s === 'string'), PROMPT_CONTEXT_MAX_CHARS) }
}
