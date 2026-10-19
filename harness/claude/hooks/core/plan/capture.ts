import type { Harness } from '../events'
import { planSkeleton } from './format'

export const PLAN_HARNESS_LABEL: Readonly<Record<Harness, string>> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', omp: 'Oh My Pi' }

export const PLAN_TITLE_MAX = 120

export function normalizePlanText(plan: string): string {
  return plan.replace(/\r\n?/g, '\n').trim()
}

export function planTitleOf(plan: string): string {
  const text = normalizePlanText(plan)
  const heading = /^#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(text)?.[1]
  const first = text.split('\n').find(l => l.trim() !== '')
  const raw = heading ?? first ?? ''
  const title = raw.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').replace(/^#+\s*/, '').replace(/\*\*|__|`/g, '').replace(/\s+/g, ' ').trim()
  return title.slice(0, PLAN_TITLE_MAX).trim() || 'Plan'
}

const STRUCTURE_LINE = /^[ \t]*(?:#{1,6}[ \t]+\S|[-*+][ \t]+\S|\d+[.)][ \t]+\S)/

export function looksLikePlan(text: string): boolean {
  const t = normalizePlanText(text)
  if (t.length < 40) return false
  return t.split('\n').filter(l => STRUCTURE_LINE.test(l)).length >= 3
}

export type PlanCaptureVia = 'hook' | 'cli'

export interface CapturedPlanOptions {
  created: string
  harness: Harness
  approved: boolean
  title?: string
  via?: PlanCaptureVia
}

export function capturedPlanNote(harness: Harness, approved: boolean, via: PlanCaptureVia = 'hook'): string {
  const label = PLAN_HARNESS_LABEL[harness]
  const quoted = 'the plan text is quoted under Captured Plan.'
  if (via === 'cli') return `Saved with \`buracle plan capture\` (${label})${approved ? '' : ' as a draft, not marked approved'}; ${quoted}`
  if (approved) return `Approved in ${label} plan mode and saved by Buracle (H12); ${quoted}`
  if (harness === 'opencode') return `Saved by Buracle (H12) when the session left ${label}'s plan agent. ${label} has no approval step, so this plan is not marked approved; ${quoted}`
  return `Saved by Buracle (H12) from ${label} plan mode as a draft, not marked approved; ${quoted}`
}

export function capturedPlanMarkdown(plan: string, o: CapturedPlanOptions): string {
  const text = normalizePlanText(plan)
  const title = (o.title ?? planTitleOf(text)).replace(/\s+/g, ' ').trim().slice(0, PLAN_TITLE_MAX) || 'Plan'
  let head = planSkeleton({ type: 'Plan', title, created: o.created }).replace(/\r\n?/g, '\n')
  head = head.replace(/^status:.*$/m, 'status: SAVED').replace(/^approved:.*$/m, `approved: ${o.approved ? 'true' : 'false'}`)
  head = head.replace(/^(iterations: \d+)$/m, `$1\nharness: ${o.harness}`)
  head = head.replace(/<!--\s*The approved plan text\.?\s*-->/, capturedPlanNote(o.harness, o.approved, o.via))
  const quoted = text.split('\n').map(line => (line.trim() === '' ? '>' : `> ${line}`)).join('\n')
  return `${head.replace(/\s+$/, '')}\n\n## Captured Plan\n\n${quoted}\n`
}
