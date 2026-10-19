import type { Harness } from '../events'
import { normalizePlanText, PLAN_HARNESS_LABEL } from './capture'
import type { SessionState } from './state'

export interface NativeBinding { path: string; sha: string; at: number }

export const NATIVE_PLAN_ENTER: Readonly<Record<Harness, string>> = {
  claude: 'call the EnterPlanMode tool (load it with tool search when it is deferred)',
  codex: 'ask the user to switch to Plan mode with `/plan`, then to say "continue", and end the turn',
  opencode: 'ask the user to switch to the plan agent (Tab), then to say "continue", and end the turn',
  omp: 'ask the user to turn on plan mode with `/plan` (or alt+shift+p), then to say "continue", and end the turn',
}

function isBinding(x: unknown): x is NativeBinding {
  if (x === null || typeof x !== 'object') return false
  const b = x as Record<string, unknown>
  return typeof b['path'] === 'string' && b['path'] !== '' && typeof b['sha'] === 'string' && /^[0-9a-f]{64}$/.test(b['sha']) && typeof b['at'] === 'number'
}

export function nativeBinding(state: SessionState): NativeBinding | undefined {
  const b = (state as { native?: unknown } | undefined)?.native
  const p = state?.plan
  if (!isBinding(b) || p === undefined || b.path !== p.path) return undefined
  if (p.type !== 'Feature' || p.phase !== 'plan' || p.status !== 'PENDING' || state.approvals?.planApprovedAt !== undefined) return undefined
  return b
}

export function withNativeBinding(state: SessionState, b: NativeBinding): SessionState {
  return { ...state, native: { path: b.path, sha: b.sha, at: b.at } }
}

export function withoutNativeBinding(state: SessionState): SessionState {
  if ((state as { native?: unknown }).native === undefined) return state
  const { native: _drop, ...rest } = state
  return rest
}

const FRONTMATTER = /^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/

function splitHead(text: string): { head: string, body: string } | undefined {
  const m = FRONTMATTER.exec(text)
  if (m === null) return undefined
  const head = m[0].endsWith('\n') ? m[0] : `${m[0]}\n`
  return { head, body: text.slice(m[0].length) }
}

const H1 = /^#[ \t]+\S.*$/m

function planBody(approved: string, registeredBody: string): string | undefined {
  let body = normalizePlanText(approved)
  const own = splitHead(`${body}\n`)
  if (own !== undefined) body = own.body.trim()
  if (body === '') return undefined
  if (/^#[ \t]+\S/.test(body)) return body
  const h1 = H1.exec(body)
  if (h1 !== null && !/^#{2,6}[ \t]+\S/m.test(body.slice(0, h1.index))) return body.slice(h1.index)
  const title = H1.exec(registeredBody)?.[0]
  return title !== undefined ? `${title.trim()}\n\n${body}` : body
}

export function nativePlanText(registered: string, approved: string): string | undefined {
  const reg = splitHead(registered.replace(/\r\n?/g, '\n'))
  if (reg === undefined) return undefined
  const body = planBody(approved, reg.body)
  return body === undefined ? undefined : `${reg.head}${body}\n`
}

export interface NativeFillNote { path: string; harness: Harness; approved: boolean; errors: number; staleReview: boolean }

export function nativeFilledNote(n: NativeFillNote): string {
  const label = PLAN_HARNESS_LABEL[n.harness]
  const validate = `\`buracle plan validate ${n.path} --strict\``
  const head = n.approved
    ? `Buracle: the plan the user approved in ${label} plan mode was written into the registered plan ${n.path} (H12, plan.nativePlanMode); its frontmatter was kept and it is marked approved.`
    : `Buracle: the plan from ${label}'s plan agent was written into the registered plan ${n.path} (H12, plan.nativePlanMode); its frontmatter was kept. ${label} has no approval step, so it is not approved yet.`
  const next = n.approved
    ? `Next, in plan-build's plan phase: run ${validate} until it exits 0, run the plan review on this text, then the on-approval steps. Ask the user again only when the review or a fix changes tasks or behavior (\`buracle plan set approved false\` first).`
    : `Next, in plan-build's plan phase: run ${validate} until it exits 0, run the plan review on this text, then ask the user to approve it (the approval gate).`
  const errors = n.errors > 0 ? ` The validator reports ${n.errors} error${n.errors === 1 ? '' : 's'} in it now.` : ''
  const stale = n.staleReview ? ' The plan review collected earlier does not match this text: run it again.' : ''
  return `${head} ${next}${errors}${stale}`
}

export function nativeConflictNote(registered: string, saved: string | undefined, harness: Harness): string {
  const label = PLAN_HARNESS_LABEL[harness]
  const kept = saved !== undefined ? `saved the plan from ${label} plan mode to ${saved} instead` : `could not save the plan from ${label} plan mode`
  return `Buracle: the registered plan ${registered} changed after \`buracle plan prepare-native\`, so Buracle left it as it is and ${kept} (H12, plan.nativePlanMode). Merge the plan into ${registered}, then ask the user to approve the merged plan before implementing.`
}
