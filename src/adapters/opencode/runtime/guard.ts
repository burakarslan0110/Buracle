import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { BuracleConfig } from '../../../core/config'
import type { HookId, StopDecision, StopInput } from '../../../core/events'
import type { SpoolEntry } from '../../../core/memory/spool'
import { detectSignals, questionAnswered } from '../../../core/policy/index'
import { answerReceipt, planProgressed, promptInteraction, routeAuditAllowed, stopGuardVerdict, validatePlan } from '../../../core/plan/index'
import type { PlanDoc, SessionState, StopGuardResult, StopWhy } from '../../../core/plan/index'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'
import { windowsVerbatim } from '../../../engine/platform'
import { shimArgv } from '../../../engine/shim'
import { loadState, updateState } from '../../../workflow/session-store'
import type { BackgroundJob } from './background'
import { waitsInBackground } from './background'
import type { LedgerStore } from './routing'
import { auditTurn } from './routing'
import type { PromptInput } from './types'

const HARNESS = 'opencode' as const

export const CONTINUE_MARK = 'buracle.continue'

export const HOOK_NAMES: Readonly<Partial<Record<HookId, string>>> = {
  H01: 'guard.bash', H02: 'guard.write', H03: 'route.tools', H08: 'plan.stop', H09: 'plan.question', H11: 'plan.validate', H20: 'consent.gate', H23: 'route.audit',
}

export function denyMessage(hook: HookId, reason: string): string {
  const name = HOOK_NAMES[hook]
  return `[Buracle ${hook}${name ? ` ${name}` : ''}] ${reason}`
}

export interface GuardChain {
  chain: number
  continuations: number[]
  noticed: boolean
}

interface GlobalRegistry { claimed: Map<string, number>; chains: Map<string, GuardChain>; maintAt?: number; profileWarned?: boolean }
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

export function shimNotify(title: string, message: string): void {
  const argv = shimArgv(['notify', 'info', title, message])
  if (argv === undefined) return
  try {
    const proc = Bun.spawn(argv, { stdio: ['ignore', 'ignore', 'ignore'], env: process.env, detached: true, windowsVerbatimArguments: windowsVerbatim(argv) })
    proc.unref()
  } catch (e) {
    log('warn', 'opencode: notify spawn failed', { error: e instanceof Error ? e.message : String(e) })
  }
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
  spool(sid: string, entries: SpoolEntry[]): void
  notify(title: string, message: string): void
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, data?: unknown): void
  readonly ledger: LedgerStore
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export function recordAnswer(sid: string, result: unknown, now: number): void {
  if (paths.isValidSessionId(sid) && questionAnswered(result)) updateState(HARNESS, sid, st => answerReceipt(st, now))
}

export function promptPlanInteraction(sid: string, words: string, opts: { autoPause: boolean, now: number }, logFn: (level: 'warn', msg: string, data?: unknown) => void): string | undefined {
  let control: 'pause' | 'resume' | 'stop' | null = null
  try { control = detectSignals(words).control } catch (err) { logFn('warn', 'detectSignals failed', { error: errText(err) }) }
  try {
    const before = loadState(HARNESS, sid)
    if (before.plan === undefined) return promptInteraction(before, control, words, opts).guidance
    let guidance: string | undefined
    updateState(HARNESS, sid, st => {
      const r = promptInteraction(st, control, words, opts)
      guidance = r.guidance
      return r.next
    })
    return guidance
  } catch (err) {
    logFn('warn', 'plan interaction failed', { error: errText(err) })
    return undefined
  }
}

export class StopGuard {
  constructor(private readonly host: StopGuardHost, private readonly settleMs: number) {}

  private planCheck(plan: NonNullable<SessionState['plan']>, cwd: string): PlanDoc {
    const abs = isAbsolute(plan.path) ? plan.path : resolve(cwd, plan.path)
    let text: string
    try { text = readFileSync(abs, 'utf8') } catch { return { exists: false, findings: [] } }
    if (plan.phase !== 'plan') return { exists: true, findings: [], text }
    try { return { exists: true, findings: validatePlan(text), text } } catch (e) {
      this.host.log('warn', 'validatePlan failed (H11 fail-open)', { error: errText(e) })
      return { exists: true, findings: [], text }
    }
  }

  private notice(sid: string, chain: GuardChain, message: string): void {
    if (chain.noticed) return
    chain.noticed = true
    this.say(sid, message)
  }

  private say(sid: string, message: string): void {
    this.host.spool(sid, [{ ts: this.host.now(), ev: 'note', excerpt: message }])
    try { this.host.notify('Buracle stop guard', message) } catch (e) { this.host.log('warn', 'notice failed', { error: errText(e) }) }
  }

  private runaway(sid: string, chain: GuardChain, why: StopWhy | 'rate', plan: string): void {
    this.host.log('warn', 'stop guard released the session at a runaway cap', { sid, why, chain: chain.chain })
    this.notice(sid, chain, runawayNotice(why, plan))
  }

  private async continueSession(sid: string, decision: Extract<StopDecision, { action: 'block' }>, now: number): Promise<boolean> {
    try {
      await this.host.prompt({ sessionID: sid, text: continuationText(decision), delivery: 'queue', metadata: { [CONTINUE_MARK]: true, hook: decision.hook } })
      this.host.spool(sid, [{ ts: now, ev: 'stop', excerpt: `${decision.hook}: ${decision.reason}`.slice(0, 2000) }])
      return true
    } catch (e) {
      this.host.log('warn', 'continuation prompt failed', { sid, hook: decision.hook, error: errText(e) })
      return false
    }
  }

  private async routeAudit(sid: string, why: StopWhy, fresh: () => boolean, claim: string | undefined, claimed: boolean, now: number): Promise<void> {
    if (!routeAuditAllowed(why, this.host.cfg().routing.strictness) || !fresh()) return
    if (!claimed && claim !== undefined && !claimEvent(claim)) return
    const decision = auditTurn(this.host.ledger, sid)
    if (decision.action !== 'block' || !fresh()) return
    if (await this.continueSession(sid, decision, now)) this.host.log('info', 'routing check re-prompted the session', { sid })
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
    const state = cfg.plan.stopGuard ? loadState(HARNESS, sid) : undefined
    const plan = state?.plan
    if (state === undefined || plan === undefined) {
      chain.chain = 0
      await this.routeAudit(sid, cfg.plan.stopGuard ? 'no-plan' : 'disabled', fresh, claim, false, now)
      return
    }
    const cwd = this.host.cwd(sid)
    const doc = this.planCheck(plan, cwd)
    chain.continuations = chain.continuations.filter(t => now - t >= 0 && now - t < RATE_WINDOW_MS)
    if (planProgressed(state, doc.text)) { chain.chain = 0; chain.continuations = []; chain.noticed = false }
    const chainCap = Math.max(1, cfg.plan.runaway.perChain)
    if (chain.chain > chainCap || chain.continuations.length >= RATE_MAX) {
      this.runaway(sid, chain, chain.chain > chainCap ? 'runaway-chain' : 'rate', plan.path)
      return
    }
    if (claim !== undefined && !claimEvent(claim)) return
    const input: StopInput = { harness: HARNESS, sessionId: sid, cwd, hookActive: chain.chain > 0, now }
    const session = this.host.session(sid)
    if (session?.lastAssistantText !== undefined) input.lastMessage = session.lastAssistantText
    if (session?.agent === 'plan') input.readOnly = true
    if (waitsInBackground(session?.background, session?.lastAssistantText, now)) input.backgroundWait = true
    let result: StopGuardResult | undefined
    try {
      updateState(HARNESS, sid, cur => {
        const check = cur.plan === undefined ? undefined : cur.plan.path === plan.path && cur.plan.phase === plan.phase ? doc : this.planCheck(cur.plan, cwd)
        const r = stopGuardVerdict(cur, input, cfg.plan, check)
        result = r
        return r.next
      })
    } catch (e) {
      this.host.log('warn', 'stop guard failed (fail-open)', { error: errText(e) })
      return
    }
    const r = result as StopGuardResult | undefined
    if (r === undefined) return
    if (r.progressed === true) { chain.chain = 0; chain.continuations = [] }
    if (r.why === 'runaway-plan' || r.why === 'runaway-chain') this.runaway(sid, chain, r.why, plan.path)
    if (r.readOnlyNotice === true) this.say(sid, READ_ONLY_NOTICE)
    const decision = r.decision
    if (decision.action !== 'block') {
      await this.routeAudit(sid, r.why, fresh, claim, true, now)
      return
    }
    if (!fresh()) return
    chain.chain++
    chain.continuations.push(now)
    if (await this.continueSession(sid, decision, now)) {
      this.host.log('info', 'stop guard continued the session', { sid, hook: decision.hook, chain: chain.chain, why: r.why })
    }
  }
}
