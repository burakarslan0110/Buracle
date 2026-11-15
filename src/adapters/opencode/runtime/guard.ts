import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { BuracleConfig } from '../../../core/config'
import type { HookId, StopDecision, StopInput } from '../../../core/events'
import type { SpoolEntry } from '../../../core/memory/spool'
import { RUNAWAY_PER_CHAIN, planProgressed } from '../../../core/plan/index'
import type { StopWhy } from '../../../core/plan/index'
import * as paths from '../../../engine/paths'
import { loadState } from '../../../workflow/session-store'
import { stop, type PipelineDeps } from '../../shared/pipeline/index'
import type { BackgroundJob } from './background'
import { waitsInBackground } from './background'
import type { PromptInput } from './types'

const HARNESS = 'opencode' as const

export const CONTINUE_MARK = 'buracle.continue'

export const HOOK_NAMES: Readonly<Partial<Record<HookId, string>>> = {
  H01: 'guard.bash', H02: 'guard.write', H03: 'route.tools', H08: 'plan.stop', H09: 'plan.question', H11: 'plan.validate', H20: 'consent.gate', H23: 'route.audit',
}

export interface GuardChain {
  chain: number
  continuations: number[]
  noticed: boolean
}

interface GlobalRegistry { claimed: Map<string, number>; chains: Map<string, GuardChain>; maintAt?: number }
export const REGISTRY_KEY = Symbol.for('buracle.opencode.registry')
const MAX_CHAINS = 500
const RATE_WINDOW_MS = 60_000
const RATE_MAX = 3

export function registry(): GlobalRegistry {
  const g = globalThis as unknown as Record<symbol, Partial<GlobalRegistry> | undefined>
  let r = g[REGISTRY_KEY]
  if (r === undefined || r === null || typeof r !== 'object') { r = {}; g[REGISTRY_KEY] = r }
  if (!(r.claimed instanceof Map)) r.claimed = new Map()
  if (!(r.chains instanceof Map)) r.chains = new Map()
  return r as GlobalRegistry
}

export function guardChain(sid: string): GuardChain {
  const chains = registry().chains
  let c = chains.get(sid)
  if (c === undefined) {
    c = { chain: 0, continuations: [], noticed: false }
    chains.set(sid, c)
    while (chains.size > MAX_CHAINS) {
      const first = chains.keys().next()
      if (first.done === true) break
      chains.delete(first.value)
    }
  }
  return c
}

export function resetChain(sid: string): void {
  const c = registry().chains.get(sid)
  if (c !== undefined) { c.chain = 0; c.noticed = false }
}

export function claimEvent(key: string): boolean {
  const claimed = registry().claimed
  if (claimed.has(key)) return false
  const now = Date.now()
  for (const [k, at] of claimed) if (now - at > 10 * 60_000) claimed.delete(k)
  claimed.set(key, now)
  return true
}

export function continuationText(decision: Extract<StopDecision, { action: 'block' }>): string {
  const what = decision.hook === 'H23' ? 'the Buracle routing check' : 'the Buracle stop guard'
  return `${decision.reason}\n\n(Automatic continuation from ${what}, ${decision.hook}${HOOK_NAMES[decision.hook] ? ` ${HOOK_NAMES[decision.hook]}` : ''}.)`
}

export const READ_ONLY_NOTICE = 'OpenCode runs the read-only plan agent, so the Buracle stop guard let the session stop. Switch back to the build agent (Tab) to continue the plan.'

export function runawayNotice(why: StopWhy | 'rate', plan: string): string {
  const what = why === 'runaway-plan' ? 'the plan-wide limit of automatic continuations'
    : why === 'rate' ? 'too many automatic continuations within a minute'
      : 'the limit of consecutive automatic continuations'
  return `OpenCode stopped although the plan ${plan} is not finished: ${what} was reached. Check the session, then continue it or run \`buracle plan pause\`.`
}

export interface StopSession {
  readonly running: boolean
  readonly gen: number
  readonly interrupts: number
  readonly failures: number
  readonly userPrompts: number
  readonly lastAssistantText?: string
  readonly agent?: string
  readonly background?: ReadonlyMap<string, BackgroundJob>
}

export interface StopSnapshot { gen: number, interrupts: number, failures: number, userPrompts: number }

export interface StopGuardHost {
  disposed(): boolean
  now(): number
  cfg(): BuracleConfig
  session(sid: string): StopSession | undefined
  isRoot(sid: string): Promise<boolean>
  cwd(sid: string): string
  prompt(input: PromptInput): Promise<unknown>
  spool(sid: string, entries: SpoolEntry[]): Promise<void>
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void
  /** Show the user a notice in the session (the notice board the TUI plugin turns into a toast). */
  notify(sid: string, text: string, variant: 'info' | 'warning'): void
  /** What the shared pipeline's stop event needs for this session. */
  deps(sid: string): PipelineDeps
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function planText(path: string, cwd: string): string | undefined {
  try { return readFileSync(isAbsolute(path) ? path : resolve(cwd, path), 'utf8') } catch { return undefined }
}

/**
 * OpenCode has no hook that holds a stopping session, so the guard runs after the turn ended and continues the
 * session with a queued prompt. The verdict is the shared pipeline's; what stays here is the chain of
 * continuations OpenCode cannot report (`hookActive`), its rate limit, and the re-prompt.
 */
export class StopGuard {
  constructor(private readonly host: StopGuardHost, private readonly settleMs: number) {}

  private async say(sid: string, message: string, variant: 'info' | 'warning'): Promise<void> {
    this.host.notify(sid, message, variant)
    await this.host.spool(sid, [{ ts: this.host.now(), ev: 'note', excerpt: message }])
  }

  private async runaway(sid: string, chain: GuardChain, why: StopWhy | 'rate', plan: string): Promise<void> {
    this.host.log('warn', 'stop guard released the session at a runaway cap', { sid, why, chain: chain.chain })
    if (chain.noticed) return
    chain.noticed = true
    await this.say(sid, runawayNotice(why, plan), 'warning')
  }

  private async continueSession(sid: string, decision: Extract<StopDecision, { action: 'block' }>, now: number): Promise<boolean> {
    try {
      await this.host.prompt({ sessionID: sid, text: continuationText(decision), delivery: 'queue', metadata: { [CONTINUE_MARK]: true, hook: decision.hook } })
      await this.host.spool(sid, [{ ts: now, ev: 'stop', excerpt: `${decision.hook}: ${decision.reason}`.slice(0, 2000) }])
      return true
    } catch (e) {
      this.host.log('warn', 'continuation prompt failed', { sid, hook: decision.hook, error: errText(e) })
      return false
    }
  }

  async check(sid: string, at: StopSnapshot, claim?: string): Promise<void> {
    if (this.settleMs > 0) await new Promise(r => setTimeout(r, this.settleMs))
    if (this.host.disposed() || !paths.isValidSessionId(sid) || this.host.session(sid) === undefined) return
    if (!(await this.host.isRoot(sid))) return
    const fresh = (): boolean => {
      const s = this.host.session(sid)
      return s !== undefined && !this.host.disposed() && !s.running && s.gen === at.gen
        && s.interrupts === at.interrupts && s.failures === at.failures && s.userPrompts === at.userPrompts
    }
    if (!fresh()) return
    const cfg = this.host.cfg()
    const chain = guardChain(sid)
    const now = this.host.now()
    const cwd = this.host.cwd(sid)
    const state = cfg.plan.stopGuard ? loadState(HARNESS, sid) : undefined
    const plan = state?.plan
    if (state === undefined || plan === undefined) chain.chain = 0
    else {
      chain.continuations = chain.continuations.filter(t => now - t >= 0 && now - t < RATE_WINDOW_MS)
      if (planProgressed(state, planText(plan.path, cwd))) { chain.chain = 0; chain.continuations = []; chain.noticed = false }
      const chainCap = RUNAWAY_PER_CHAIN
      if (chain.chain > chainCap || chain.continuations.length >= RATE_MAX) {
        await this.runaway(sid, chain, chain.chain > chainCap ? 'runaway-chain' : 'rate', plan.path)
        return
      }
    }
    if (claim !== undefined && !claimEvent(claim)) return
    const session = this.host.session(sid)
    const input: StopInput = { harness: HARNESS, sessionId: sid, cwd, hookActive: chain.chain > 0, now }
    if (session?.lastAssistantText !== undefined) input.lastMessage = session.lastAssistantText
    if (waitsInBackground(session?.background, session?.lastAssistantText, now)) input.backgroundWait = true
    let readOnly = false
    const r = await stop(input, {
      ...this.host.deps(sid),
      readOnly: () => session?.agent === 'plan',
      stopNotice: result => { readOnly = result.readOnlyNotice === true; return undefined },
    })
    if (r.failed === true) return
    if (plan !== undefined && (r.why === 'runaway-plan' || r.why === 'runaway-chain')) await this.runaway(sid, chain, r.why, plan.path)
    if (readOnly) await this.say(sid, READ_ONLY_NOTICE, 'info')
    const decision = r.decision
    if (decision.action !== 'block' || !fresh()) return
    if (r.blockedBy === 'audit') {
      if (await this.continueSession(sid, decision, now)) this.host.log('info', 'routing check re-prompted the session', { sid })
      return
    }
    chain.chain++
    chain.continuations.push(now)
    if (await this.continueSession(sid, decision, now)) this.host.log('info', 'stop guard continued the session', { sid, hook: decision.hook, chain: chain.chain })
  }
}
