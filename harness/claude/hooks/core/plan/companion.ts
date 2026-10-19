import { COMPANION_SETTINGS, type CompanionSetting } from '../config'
import { HARNESSES, type Harness } from '../events'
import { REVIEW_CATEGORIES, REVIEW_MAX_FINDINGS, validateReviewJson, type ReviewAgent, type ReviewReport, type ReviewSeverity } from '../policy/review'
import { PLAN_HARNESS_LABEL } from './capture'
import { REVIEW_AGENT_OF, type ReviewRole } from './reviews'

export const COMPANION_ATTEMPTS = 2
export const COMPANION_TIMEOUT_MIN = 20
export const COMPANION_TIMEOUT_MAX_MIN = 120
export const COMPANION_WAIT_MAX_SEC = 600
export const COMPANION_RETRY_MIN_MS = 60_000
export const COMPANION_INPUT_MAX = 20_000
export const COMPANION_DIFF_MAX = 150_000
export const COMPANION_COMPUTED_LABELS: readonly string[] = ['plan_file', 'plan_path', 'goal', 'slug', 'base_ref', 'diff_range', 'worktree_path', 'changed_files']

export type ModelFamily = 'anthropic' | 'openai' | 'google'

export interface CompanionCandidate {
  harness: Harness
  enabled: boolean
  onPath: boolean
  recent: boolean
  held?: string
  used?: number
  family?: ModelFamily
}

export interface CompanionChoice { picks: Harness[], skipped: string[] }

export function companionSetting(x: unknown): CompanionSetting | undefined {
  if (typeof x !== 'string') return undefined
  const v = x.trim().toLowerCase()
  return (COMPANION_SETTINGS as readonly string[]).includes(v) ? v as CompanionSetting : undefined
}

export function modelFamily(model: string | undefined): ModelFamily | undefined {
  if (typeof model !== 'string' || model === '') return undefined
  if (/claude|anthropic|opus|sonnet|haiku/i.test(model)) return 'anthropic'
  if (/gpt|openai|codex|(^|[/:])o[1-9]\b/i.test(model)) return 'openai'
  if (/gemini|google/i.test(model)) return 'google'
  return undefined
}

function unusable(c: CompanionCandidate): string | undefined {
  if (!c.enabled) return `${c.harness} is switched off (harnesses.${c.harness}.enabled: false)`
  if (!c.onPath) return `${c.harness}: its command is not on PATH`
  return undefined
}

export function chooseCompanion(setting: CompanionSetting, caller: Harness, candidates: readonly CompanionCandidate[], callerFamily?: ModelFamily): CompanionChoice {
  if (setting === 'off') return { picks: [], skipped: ['plan.reviews.companion is off'] }
  const byHarness = new Map(candidates.map(c => [c.harness, c] as const))
  if (setting !== 'auto') {
    const c = byHarness.get(setting)
    if (c === undefined) return { picks: [], skipped: [`${setting}: not known on this machine`] }
    const why = unusable(c)
    return why !== undefined ? { picks: [], skipped: [why] } : { picks: [setting], skipped: c.held !== undefined ? [`${setting}: ${c.held} (tried anyway: it was named)`] : [] }
  }
  const skipped: string[] = []
  const usable: CompanionCandidate[] = []
  for (const h of HARNESSES) {
    if (h === caller) continue
    const c = byHarness.get(h)
    if (c === undefined) continue
    const why = unusable(c) ?? (c.held !== undefined ? `${h}: ${c.held}` : undefined)
    if (why !== undefined) skipped.push(why)
    else usable.push(c)
  }
  const familyRank = (c: CompanionCandidate): number => (c.family === undefined || callerFamily === undefined ? 1 : c.family === callerFamily ? 2 : 0)
  usable.sort((a, b) => familyRank(a) - familyRank(b) || Number(b.recent) - Number(a.recent) || (a.used ?? 101) - (b.used ?? 101) || HARNESSES.indexOf(a.harness) - HARNESSES.indexOf(b.harness))
  if (usable.length === 0 && skipped.length === 0) skipped.push(`no harness other than ${caller} is set up`)
  return { picks: usable.slice(0, COMPANION_ATTEMPTS).map(c => c.harness), skipped }
}

function labelOf(line: string): string | undefined {
  const m = /^\s*([a-z][a-z_]*)\s*:/.exec(line)
  return m?.[1]
}

export function companionInputs(raw: string | undefined, computed: ReadonlyArray<readonly [string, string]>): string {
  const own = new Set(computed.map(([k]) => k))
  const kept: string[] = []
  let dropping = false
  for (const line of (typeof raw === 'string' ? raw : '').replace(/\r\n?/g, '\n').split('\n')) {
    const label = labelOf(line)
    if (label !== undefined) dropping = COMPANION_COMPUTED_LABELS.includes(label) || own.has(label)
    if (dropping || /^\s*return only your json report\.?\s*$/i.test(line)) continue
    kept.push(line)
  }
  let text = kept.join('\n').trim()
  if (text.length > COMPANION_INPUT_MAX) text = `${text.slice(0, COMPANION_INPUT_MAX)}\n(the rest of the inputs was cut)`
  const lines = computed.filter(([, v]) => v.trim() !== '').map(([k, v]) => `${k}: ${v.replace(/\s*\n\s*/g, ' ').trim()}`)
  return [...lines, ...(text !== '' ? [text] : [])].join('\n')
}

export interface CompanionPromptInput {
  role: ReviewRole
  body: string
  caller: Harness
  target: Harness
  shell: boolean
  repo: string
  scratch: boolean
  inputs: string
  diff?: { text: string, truncated: boolean }
}

function workLine(o: CompanionPromptInput): string {
  if (!o.shell) return 'You have no shell in this run, so the diff is included below; read files with your read, grep and glob tools.'
  if (o.scratch) return `Your working folder is an empty scratch folder; the repository is \`${o.repo}\`. Pass absolute paths under it to the read, grep and glob tools, and run git as \`git -C "${o.repo}" ...\`.`
  return 'Your working folder is the repository. The only commands you run are read-only: `git diff`, `git log`, `git show`, `git status`, `git ls-files`, `git blame`, `git merge-base` and `rg`.'
}

export function companionPrompt(o: CompanionPromptInput): string {
  const agent = REVIEW_AGENT_OF[o.role]
  const out = [
    `You are a second-opinion reviewer running on ${PLAN_HARNESS_LABEL[o.target]}. A ${PLAN_HARNESS_LABEL[o.caller]} session asked for this review; its own ${agent} runs at the same time and both reports are weighed equally, so review independently and report what you find even if the other reviewer may find it too.`,
    '',
    'Rules for this run:',
    '- Read-only: never create, edit, move or delete files, never change git state, never install, build, test or start anything, and never write to memory.',
    '- Do not run `buracle` commands: the review scope below is already resolved.',
    `- ${workLine(o)}`,
    '- Try to disprove the work: trace inputs, retries, partial failures and the cases nobody tested. Cite real paths and line numbers you read. One strong finding beats several weak ones; when what you can read cannot settle a point, say so in the finding instead of guessing.',
    '- Your final message is the one JSON object the instructions below describe, and nothing else.',
    '',
    `Your instructions as ${agent} follow.`,
    '',
    '---',
    '',
    o.body.trim(),
    '',
    '---',
    '',
    '## Inputs',
    '',
    o.inputs.trim(),
  ]
  if (o.diff !== undefined && o.diff.text.trim() !== '') {
    const fence = '`'.repeat([...o.diff.text.matchAll(/`+/g)].reduce((n, m) => Math.max(n, m[0].length + 1), 3))
    out.push('', '## The diff', '', `${fence}diff`, o.diff.text.trimEnd(), fence)
    if (o.diff.truncated) out.push('', 'The diff is longer than this; it is cut here. Read the remaining changed files directly.')
  }
  out.push('', 'Return only your JSON report.', '')
  return out.join('\n')
}

function closingBrace(text: string, start: number): number {
  let depth = 0
  let inString = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') i++
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) return i }
  }
  return -1
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function dropEmpty(o: Record<string, unknown>, keys: readonly string[]): void {
  for (const k of keys) if (k in o && (o[k] === null || o[k] === '')) delete o[k]
}

export function normalizeReview(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...o }
  dropEmpty(out, ['truths', 'goal_score'])
  if (Array.isArray(out['findings'])) out['findings'] = out['findings'].map(f => {
    if (!isObj(f)) return f
    const g: Record<string, unknown> = { ...f }
    dropEmpty(g, ['file', 'line'])
    if (typeof g['line'] === 'string' && /^\d+$/.test(g['line'])) g['line'] = Number(g['line'])
    return g
  })
  return out
}

const SCAN_MAX = 400_000
const STARTS_MAX = 400

export function extractReview(text: string): string | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined
  const tail = text.length > SCAN_MAX ? text.slice(-SCAN_MAX) : text
  let tried = 0
  for (let i = tail.lastIndexOf('{'); i >= 0 && tried < STARTS_MAX; i = i > 0 ? tail.lastIndexOf('{', i - 1) : -1) {
    tried++
    const end = closingBrace(tail, i)
    if (end < 0) continue
    let parsed: unknown
    try { parsed = JSON.parse(tail.slice(i, end + 1)) } catch { continue }
    if (isObj(parsed) && 'verdict' in parsed && 'findings' in parsed) return JSON.stringify(normalizeReview(parsed))
  }
  return undefined
}

const SEVERITY_ALIASES: Readonly<Record<string, ReviewSeverity>> = {
  must_fix: 'must_fix', critical: 'must_fix', high: 'must_fix', blocker: 'must_fix',
  should_fix: 'should_fix', medium: 'should_fix', low: 'should_fix', major: 'should_fix',
  suggestion: 'suggestion', info: 'suggestion', nit: 'suggestion', minor: 'suggestion',
}
const SEVERITY_RANK: Readonly<Record<ReviewSeverity, number>> = { must_fix: 0, should_fix: 1, suggestion: 2 }
const FALLBACK_CATEGORY: Readonly<Record<ReviewAgent, string>> = { 'plan-build-review': 'risk', 'changes-review': 'correctness', 'goal-build-review': 'risky_assumption' }

function text(x: unknown): string | undefined {
  return typeof x === 'string' && x.trim() !== '' ? x.trim() : undefined
}

function lineOf(x: unknown): number | undefined {
  const n = typeof x === 'string' && /^\d+$/.test(x.trim()) ? Number(x.trim()) : x
  return typeof n === 'number' && Number.isInteger(n) && n >= 1 ? n : undefined
}

function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 3)}...` : t
}

export function repairReview(o: Record<string, unknown>, agent: ReviewAgent): Record<string, unknown> {
  const findings = (Array.isArray(o['findings']) ? o['findings'] : []).filter(isObj).map(f => {
    const severity = SEVERITY_ALIASES[String(f['severity'] ?? '').trim().toLowerCase()] ?? 'should_fix'
    const cat = text(f['category'])
    const title = oneLine(text(f['title']) ?? text(f['summary']) ?? 'Finding', 100)
    const g: Record<string, unknown> = {
      severity,
      category: cat !== undefined && REVIEW_CATEGORIES[agent].includes(cat) ? cat : FALLBACK_CATEGORY[agent],
      title,
      evidence: text(f['evidence']) ?? text(f['body']) ?? text(f['description']) ?? title,
      suggested_fix: text(f['suggested_fix']) ?? text(f['recommendation']) ?? text(f['fix']) ?? 'See the evidence.',
    }
    const file = text(f['file'])
    const line = lineOf(f['line'] ?? f['line_start'])
    if (file !== undefined) g['file'] = file
    if (line !== undefined) g['line'] = line
    return g
  })
  const truths = (Array.isArray(o['truths']) ? o['truths'] : []).filter(isObj).map(t => {
    const st = String(t['status'] ?? '').trim().toLowerCase()
    return { truth: text(t['truth']) ?? 'unnamed truth', status: st === 'verified' || st === 'failed' ? st : 'unverified', evidence: typeof t['evidence'] === 'string' ? t['evidence'] : '' }
  })
  const failed = truths.filter(t => t.status === 'failed')
  if (agent === 'changes-review' && failed.length > 0 && !findings.some(f => f['severity'] === 'must_fix')) {
    for (const t of failed) findings.push({ severity: 'must_fix', category: 'goal_gap', title: oneLine(`Failed truth: ${t.truth}`, 100), evidence: t.evidence || t.truth, suggested_fix: 'Make this truth hold, then re-run the checks that cover it.' })
  }
  findings.sort((a, b) => SEVERITY_RANK[a['severity'] as ReviewSeverity] - SEVERITY_RANK[b['severity'] as ReviewSeverity])
  const kept = findings.slice(0, REVIEW_MAX_FINDINGS)
  const out: Record<string, unknown> = {
    verdict: kept.some(f => f['severity'] !== 'suggestion') ? 'needs_changes' : 'pass',
    summary: text(o['summary']) ?? 'No summary was given.',
    findings: kept,
  }
  if (truths.length > 0 || agent === 'changes-review') out['truths'] = truths
  const score = o['goal_score']
  if (typeof score === 'number' && Number.isInteger(score) && score >= 0 && score <= 100) out['goal_score'] = score
  return out
}

export type AcceptedReview = { ok: true, report: ReviewReport, repaired: boolean } | { ok: false, errors: string[] }

export function acceptReview(answer: string, agent: ReviewAgent, subject: string): AcceptedReview {
  const raw = extractReview(answer)
  if (raw === undefined) return { ok: false, errors: ['the answer holds no JSON report (an object with verdict and findings)'] }
  const first = validateReviewJson(raw, { agent, subject })
  if (first.ok && first.review !== undefined) return { ok: true, report: first.review, repaired: false }
  const fixed = repairReview(JSON.parse(raw) as Record<string, unknown>, agent)
  let again = validateReviewJson(JSON.stringify(fixed), { agent, subject })
  if (!again.ok && again.errors.some(e => e.startsWith('`summary` must start'))) {
    fixed['summary'] = `${subject}: ${String(fixed['summary'])}`
    again = validateReviewJson(JSON.stringify(fixed), { agent, subject })
  }
  return again.ok && again.review !== undefined ? { ok: true, report: again.review, repaired: true } : { ok: false, errors: again.errors.length > 0 ? again.errors : first.errors }
}

export function claudeResultText(stdout: string): { ok: boolean, text: string } | undefined {
  let parsed: unknown
  try { parsed = JSON.parse(stdout.trim()) } catch { return undefined }
  if (!isObj(parsed) || typeof parsed['result'] !== 'string') return undefined
  return { ok: parsed['is_error'] !== true, text: parsed['result'] }
}
