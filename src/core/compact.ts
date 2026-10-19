import type { Harness } from './events'
import type { SessionState } from './plan/state'
import { emptyState } from './plan/state'
import { renderYamlBlock } from './frontmatter'
import { memIsoLocal, memLocalDate, memLocalParts, memNoteHarness } from './memory/note'
import { slugify } from './memory/text'
import { laneReviewLabel, laneReviewsInFlight, reviewLabel, reviewsInFlight } from './plan/reviews'

export const COMPACT_MARKER = 'Buracle — keep through compaction:'

function activePlan(state: SessionState): NonNullable<SessionState['plan']> | undefined {
  const p = state?.plan
  if (!p || p.status === 'VERIFIED' || p.status === 'SAVED' || p.phase === 'done') return undefined
  return p
}

function interactionLine(state: SessionState): string | undefined {
  const it = state?.interaction
  if (!it || it.state !== 'paused') return undefined
  const why = it.reason ? `: "${oneLine(it.reason, 200)}"` : ''
  return `The run is paused (${it.kind ?? 'discussion'})${why}; keep that state and the open question, and wait for the user before resuming.`
}

function reviewsLine(state: SessionState): string | undefined {
  const running = activePlan(state) !== undefined ? reviewsInFlight(state) : []
  const own = running.filter(r => r.companion !== true).map(reviewLabel)
  const second = running.filter(r => r.companion === true).map(reviewLabel)
  const lanes = laneReviewsInFlight(state).map(laneReviewLabel)
  const out: string[] = []
  if (own.length + lanes.length > 0) out.push(`Reviewers launched in the background and not collected yet: ${[...own, ...lanes].join('; ')}. Collect each report (wait for it, or read it through the agent tool that launched it) instead of launching a new one; \`buracle plan review done --role <role> --verdict <verdict>\`${lanes.length > 0 ? ' (plus `--lane <slug>` for a lane\'s reviewer)' : ''} records it.`)
  if (second.length > 0) out.push(`Second opinions running on another harness and not collected yet: ${second.join('; ')}. Collect each with \`buracle plan review companion collect --role <role>\` instead of starting it again.`)
  return out.length > 0 ? out.join(' ') : undefined
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

export interface CompactExtra {
  flow?: string
  touched?: readonly string[]
  background?: readonly string[]
}

export function compactInstructions(base: string | undefined, state: SessionState): string {
  return compactInstructionsWith(base, state, {})
}

function list(items: readonly string[] | undefined, max: number): string[] {
  return (Array.isArray(items) ? items : []).filter(x => typeof x === 'string' && x.trim() !== '').slice(0, max).map(x => oneLine(x, 200))
}

export function compactInstructionsWith(base: string | undefined, state: SessionState, extra: CompactExtra): string {
  let head = typeof base === 'string' ? base : ''
  const at = head.indexOf(COMPACT_MARKER)
  if (at >= 0) head = head.slice(0, at)
  head = head.replace(/\s+$/, '')
  const lines = [COMPACT_MARKER]
  const p = activePlan(state)
  if (p) {
    lines.push(`- Active plan: ${p.path} (type ${p.type}, status ${p.status}, phase ${p.phase}). Keep this path verbatim; the file holds progress as ticked "- [x] Task N done" lines and must be re-read after compaction.`)
    lines.push('- Keep which task is in progress, what is left of it, and every deviation from the plan with its reason.')
  }
  const flow = typeof extra?.flow === 'string' ? oneLine(extra.flow, 240) : ''
  if (flow !== '') lines.push(`- Running workflow: ${flow}. Continue it after compaction; \`buracle flow status\` shows where it stands.`)
  const paused = interactionLine(state)
  if (paused) lines.push(`- ${paused}`)
  lines.push("- Keep the user's requests and corrections in their own words and language, and every decision with its reason.")
  lines.push('- Keep the approaches that were tried and rejected, each with why it failed, so they are not tried again.')
  lines.push('- Keep the verification commands that ran and their results (pass or fail, with the key output lines), and the commands that failed with their key error lines.')
  const touched = list(extra?.touched, 30)
  lines.push(touched.length > 0
    ? `- Files changed so far (keep these paths and what changed in each): ${touched.join(', ')}.`
    : '- Keep the paths of the files changed and what changed in each.')
  const background = list(extra?.background, 10)
  if (background.length > 0) lines.push(`- Still running in the background (keep them and how to check on them): ${background.join('; ')}.`)
  const reviews = reviewsLine(state)
  if (reviews !== undefined) lines.push(`- ${reviews} Keep each handle verbatim.`)
  lines.push('- Keep the open todo items. Drop tool output that has already been acted on, but never an unanswered question or an unfinished step.')
  const block = lines.join('\n')
  return head === '' ? block : `${head}\n\n${block}`
}

export function compactPrompt(): string {
  return [
    'Compact this conversation into a handoff summary so that another agent can continue the work in a fresh context. That agent sees only your summary, the files on disk and its tools; it has not seen this conversation.',
    'Write short Markdown sections: the goal and what the user asked for; what is done; what is in progress and the exact next step; what is still open, unanswered questions to the user included.',
    `${compactInstructionsWith(undefined, emptyState(), {})}\n- If a plan file is active (under docs/plans/ or docs/builds/), keep its path verbatim and which task is in progress; the file holds the real progress and is re-read after compaction.`,
  ].join('\n\n')
}

function pad(n: number, w = 2): string { return String(n).padStart(w, '0') }

const MAX_OFFSET_MIN = 14 * 60

function offsetOf(offsetMin: number | undefined): number {
  return typeof offsetMin === 'number' && Number.isFinite(offsetMin) && Math.abs(offsetMin) <= MAX_OFFSET_MIN ? Math.trunc(offsetMin) : 0
}

function stamp(now: number, offsetMin: number): { date: string, compact: string, hm: string, iso: string, plus14: string } {
  const ms = Number.isFinite(now) ? now : 0
  const p = memLocalParts(ms, offsetMin)
  const date = `${p.y}-${pad(p.mo)}-${pad(p.d)}`
  return { date, compact: date.replace(/-/g, ''), hm: `${pad(p.h)}${pad(p.mi)}`, iso: memIsoLocal(ms, offsetMin), plus14: memLocalDate(ms + 14 * 86_400_000, offsetMin) }
}

function sessionTag(sessionId: string): string {
  const t = (typeof sessionId === 'string' ? sessionId : '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 6)
  return t === '' ? 'nosess' : t
}

function projectSlugOf(project: unknown): string {
  const p = typeof project === 'string' ? project.trim() : ''
  if (p === '') return 'unknown'
  if (/^[a-z0-9][a-z0-9-]{0,79}$/.test(p)) return p
  const s = slugify(p)
  return s === 'note' && !/note/i.test(p) ? 'unknown' : s
}

export const HANDOFF_GENERATED_BY = 'process:buracle-handoff'

export interface HandoffNoteInput { state: SessionState, project: string, harness: Harness, sessionId: string, branch?: string, now: number, todo?: string[] }

export function handoffNote(input: { state: SessionState, project: string, harness: Harness, sessionId: string, branch?: string, now: number, todo?: string[] }): { slug: string, markdown: string } {
  return handoffNoteLocal(input, 0)
}

export function handoffNoteLocal(input: HandoffNoteInput, offsetMin: number): { slug: string, markdown: string } {
  const t = stamp(input.now, offsetOf(offsetMin))
  const tag = sessionTag(input.sessionId)
  const slug = `${t.date}-${t.hm}-${input.harness}-${tag}`
  const p = activePlan(input.state)
  const project = projectSlugOf(input.project)
  const title = `Handoff: ${project}${p ? ` · ${p.slug}` : ''}`
  const fm: Record<string, unknown> = {
    id: `h-${t.compact}-${t.hm}-${input.harness}-${tag}`,
    type: 'handoff',
    title,
    description: p ? `Plan ${p.slug} at ${p.status} (${p.phase}) when the context was compacted.` : 'Session state when the context was compacted.',
    status: 'active',
    scope: 'project',
    project,
    created: t.iso,
    updated: t.iso,
    harness: memNoteHarness(input.harness),
    ...(typeof input.sessionId === 'string' && input.sessionId !== '' ? { session: input.sessionId } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(p ? { plan: p.path, plan_status: p.status, plan_phase: p.phase, plan_type: p.type } : {}),
    stale_after: t.plus14,
    generated_by: HANDOFF_GENERATED_BY,
    review: 'ok',
  }
  const todos = (Array.isArray(input.todo) ? input.todo : []).filter(x => typeof x === 'string' && x.trim() !== '').slice(0, 30).map(x => `- [ ] ${oneLine(x, 200)}`)
  const body: string[] = [`# ${title}`, '', '## Active plan']
  if (p) {
    body.push(`- Path: \`${p.path}\``)
    body.push(`- Type ${p.type} · status ${p.status} · phase ${p.phase}`)
    const it = input.state.interaction
    body.push(`- Interaction: ${it?.state === 'paused' ? `paused (${it.kind ?? 'discussion'})${it.reason ? `: ${oneLine(it.reason, 200)}` : ''}` : 'running'}`)
  } else {
    body.push('None.')
  }
  const reviews = reviewsLine(input.state)
  if (reviews !== undefined) body.push(`- ${reviews}`)
  body.push('', '## Open todos', ...(todos.length > 0 ? todos : ['None recorded.']))
  body.push('', '## Resume')
  body.push(p
    ? 'Re-read the plan file and continue with its first unticked task; `buracle plan status --json` shows the live state.'
    : 'Continue from the open todos above.')
  const markdown = `---\n${renderYamlBlock(fm, ['id', 'type', 'title', 'description', 'status', 'scope', 'project', 'created', 'updated', 'harness', 'session', 'branch', 'plan', 'plan_status', 'plan_phase', 'plan_type', 'stale_after', 'generated_by', 'review'])}\n---\n${body.join('\n')}\n`
  return { slug, markdown }
}

export const RESTORE_TODOS_MAX = 10
export const RESTORE_RECORD_MAX_MS = 24 * 3_600_000

export function restoreContext(state: SessionState, handoffPath?: string, todos?: readonly string[]): string | undefined {
  const p = activePlan(state)
  const hasHandoff = typeof handoffPath === 'string' && handoffPath.trim() !== ''
  const open = hasHandoff ? [] : list(todos, RESTORE_TODOS_MAX)
  const reviews = reviewsLine(state)
  if (!p && !hasHandoff && open.length === 0 && reviews === undefined) return undefined
  const lines = ['Buracle: the context was compacted.']
  if (p) {
    lines.push(`Active plan: ${p.path} (type ${p.type}, status ${p.status}, phase ${p.phase}). Re-read the whole plan file and the workflow's phase reference now: the ticked "- [x] Task N done" lines are the real progress.`)
    const paused = interactionLine(state)
    lines.push(paused ?? 'Then continue with the first unticked task without asking whether to continue.')
  }
  if (reviews !== undefined) lines.push(reviews)
  if (hasHandoff) lines.push(`Handoff memory with the open todos and state at compaction time: ${(handoffPath as string).trim()} (read it with memory_get).`)
  else if (open.length > 0) lines.push('Open todos at compaction time (no handoff memory was written):', ...open.map(t => `- ${t}`))
  return lines.join('\n')
}
