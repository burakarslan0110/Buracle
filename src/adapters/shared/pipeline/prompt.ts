import type { PromptDecision, PromptInput } from '../../../core/events'
import { spoolPromptExcerpt } from '../../../core/memory/spool'
import type { PromptSignals } from '../../../core/policy/intents'
import type { PromptRoute } from '../../../core/policy/skill-router'
import { updateLedger } from '../../../workflow/ledger'
import { loadState, updateState } from '../../../workflow/session-store'
import { recordPromptGrants } from '../consent-store'
import type { PipelineDeps } from './types'

export interface PromptPorts {
  /** The notice of review notes left for this session's plan or folders. */
  reviewNotes(): string | undefined
  /** The skills and MCP categories the prompt asks for, with the routing note. */
  routePrompt(signals: PromptSignals): Promise<{ route: PromptRoute, text?: string } | undefined>
  /** After the route reached the ledger. */
  promptRouted?(route: PromptRoute): void | Promise<void>
  /** The note for a file-writing workflow started in a read-only (plan mode) turn. */
  readOnlyStart(invoked: readonly string[]): string | undefined
  contextWarning(): string | undefined | Promise<string | undefined>
}

export interface PromptParts { guidance?: string, notes?: string, planMode?: string, route?: string, workspace?: string, warning?: string }

export interface PromptResult extends PromptDecision {
  /** The prompt is the stop guard's own continuation, not the user's. */
  continuation: boolean
  /** The user wrote it: intents, grants and routing ran. */
  user: boolean
  parts: PromptParts
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
  const refresh = d.workspace.refresh
  const prev = d.workspace.read(sid)
  if (prev === undefined || refresh === undefined) return undefined
  const next = refresh(prev, now)
  if (JSON.stringify(next) !== JSON.stringify(prev)) d.workspace.save(sid, next)
  return d.core.workspaceNotice(prev, next)
}

/**
 * prompt: the user's intents and the plan interaction (H10), review notes, consent grants (H20), skill and MCP
 * routing (H22, H24), the read-only start note, the workspace notice (H21), the context warning (H05), then the
 * spool, the session record and the memory UI (H14).
 */
export async function prompt(input: PromptInput, d: PipelineDeps & PromptPorts): Promise<PromptResult> {
  const { harness: H, sessionId: sid, text, now } = input
  const parts: PromptParts = {}
  const set = (key: keyof PromptParts, value: string | undefined) => { if (value !== undefined) parts[key] = value }
  const continuation = await d.step('H10 isGuardContinuation', false, () => d.core.isGuardContinuation(text))
  const user = !continuation && input.userText !== false
  if (user) {
    await d.at?.('prompt.user')
    const signals = await d.step('H10 detectSignals', NO_SIGNALS, () => d.core.detectSignals(text))
    set('guidance', await d.step('H10 intents', undefined as string | undefined, () => interaction(input, signals.control, d)))
    set('notes', await d.step('H10 review notes', undefined as string | undefined, () => d.reviewNotes()))
    await d.step('H20 grants', undefined, () => { recordPromptGrants(H, sid, text, now) })
    await d.at?.('prompt.granted')
    const invoked: string[] = []
    set('route', await d.step('H22 route.prompt', undefined as string | undefined, async () => {
      const routed = await d.routePrompt(signals)
      if (routed === undefined) return undefined
      invoked.push(...routed.route.invoked, ...routed.route.load)
      await d.step('H24 ledger prompt', undefined, () => { updateLedger(H, sid, l => d.core.ledgerPrompt(l, routed.route, now)) })
      await d.promptRouted?.(routed.route)
      return routed.text
    }))
    set('planMode', await d.step('H10 read-only start', undefined as string | undefined, () => d.readOnlyStart(invoked)))
    await d.at?.('prompt.routed')
  }
  if (d.workspace.refresh !== undefined) set('workspace', await d.step('H21 workspace notice', undefined as string | undefined, () => workspaceNotice(sid, now, d)))
  set('warning', await d.step('H05 context warning', undefined as string | undefined, () => d.contextWarning()))
  if (!continuation) {
    await d.at?.('prompt.record')
    const excerpt = user ? spoolPromptExcerpt(text) : undefined
    await d.spool(sid, [{ ts: now, ev: 'prompt', ...(excerpt !== undefined ? { excerpt } : {}) }])
    if (!d.captureOff) await d.step('session record touch', undefined, async () => { (await d.memory('promptSeen'))?.(H, sid, { nowMs: now }) })
  }
  await d.step('H14 memory UI', undefined, () => d.ui.seen(H, sid, now))
  const order: Array<keyof PromptParts> = ['guidance', 'notes', 'planMode', 'route', 'workspace', 'warning']
  return { continuation, user, parts, context: order.flatMap(k => (parts[k] !== undefined ? [parts[k] as string] : [])) }
}
