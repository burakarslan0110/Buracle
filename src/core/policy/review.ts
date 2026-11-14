export type ReviewAgent = 'plan-build-review' | 'changes-review' | 'goal-build-review'
export type ReviewSeverity = 'must_fix' | 'should_fix' | 'suggestion'

export interface ReviewFinding { severity: ReviewSeverity; category: string; title: string; file?: string; line?: number; evidence: string; suggested_fix: string }
export interface ReviewTruth { truth: string; status: 'verified' | 'failed' | 'unverified'; evidence: string }
export interface ReviewReport { verdict: 'pass' | 'needs_changes'; summary: string; findings: ReviewFinding[]; truths?: ReviewTruth[]; goal_score?: number }

export const REVIEW_CATEGORIES: Readonly<Record<ReviewAgent, readonly string[]>> = {
  'plan-build-review': ['requirement_gap', 'scope_creep', 'risky_assumption', 'missing_task', 'missing_test', 'weak_dod', 'task_order', 'risk', 'format', 'review_input'],
  'changes-review': ['plan_deviation', 'incomplete_task', 'correctness', 'regression_risk', 'error_handling', 'security', 'data_integrity', 'test_gap', 'test_quality', 'docs_drift', 'goal_gap', 'needs_runtime_check', 'performance', 'over_engineering', 'maintainability', 'review_input'],
  'goal-build-review': ['criterion_not_binary', 'criterion_unobservable', 'criterion_describes_work', 'criterion_bundled', 'criterion_subjective', 'criterion_fakeable', 'outcome_uncovered', 'no_end_to_end_check', 'oracle_mismatch', 'false_pass_uncaught', 'reference_unobtainable', 'no_measurable_criterion', 'goal_unclear', 'scope_creep', 'task_gap', 'task_order', 'task_too_large', 'contract_size', 'risky_assumption', 'format', 'review_input'],
}

export const REVIEW_MAX_FINDINGS = 15
const SEVERITY_ORDER: readonly ReviewSeverity[] = ['must_fix', 'should_fix', 'suggestion']
const TOP_KEYS = ['verdict', 'summary', 'findings', 'truths', 'goal_score']
const FINDING_KEYS = ['severity', 'category', 'title', 'file', 'line', 'evidence', 'suggested_fix']
const TRUTH_KEYS = ['truth', 'status', 'evidence']

function agentOf(x: string | undefined): ReviewAgent | undefined {
  if (typeof x !== 'string') return undefined
  const id = x.trim().replace(/^.*:/, '')
  return id in REVIEW_CATEGORIES ? id as ReviewAgent : undefined
}

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

function nonEmpty(x: unknown): x is string {
  return typeof x === 'string' && x.trim() !== ''
}

function subjectsOf(subject: string | readonly string[] | undefined): string[] {
  const list = typeof subject === 'string' ? [subject] : Array.isArray(subject) ? subject : []
  return list.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim())
}

const LEADING_WRAPPERS = /^[\s`'"*_([]+/
const PATH_END = /^(?:$|[\s`'"*:,;)\]]|[._](?=$|[\s`'"*:,;)\]]))/
const PATH_PREFIX = /^(?:[A-Za-z]:\/|[/~.]|[^\s/]+\/)/

function pathTails(want: string): string[] {
  const segs = want.split('/').filter(x => x !== '' && x !== '.')
  const tails = segs.map((_, i) => segs.slice(i).join('/'))
  return want.startsWith('/') ? [want, ...tails] : tails
}

function startsWithSubject(text: string, subject: string): boolean {
  const want = subject.replace(/\\/g, '/').replace(/^\.\//, '')
  if (pathTails(want).some(p => text.startsWith(p) && PATH_END.test(text.slice(p.length)))) return true
  const tail = want.replace(/^\/+/, '')
  for (let i = text.indexOf(`/${tail}`); i >= 0; i = text.indexOf(`/${tail}`, i + 1)) {
    const prefix = text.slice(0, i + 1)
    if (/[`'"*]|:\s/.test(prefix) || !PATH_PREFIX.test(prefix)) return false
    if (PATH_END.test(text.slice(i + 1 + tail.length))) return true
  }
  return false
}

function summaryStartsRight(summary: string, subjects: readonly string[]): boolean {
  const s = summary.trim()
  if (subjects.length > 0) {
    const text = s.replace(LEADING_WRAPPERS, '').replace(/\\/g, '/')
    return /^goal\b/i.test(text) || subjects.some(want => startsWithSubject(text, want))
  }
  if (/^goal\b/i.test(s)) return true
  const first = (s.split(/\s/)[0] ?? '').replace(/[:,;.]+$/, '')
  return /[/\\]/.test(first) || /\.[A-Za-z0-9]{1,8}$/.test(first)
}

export function validateReviewJson(text: string, opts?: { agent?: string, subject?: string | readonly string[] }): { ok: boolean, errors: string[], review?: ReviewReport } {
  const errors: string[] = []
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, errors: ['the final message is empty; return one JSON object'] }
  let body = text.trim()
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(body)
  if (fence) {
    errors.push('the JSON object is wrapped in a Markdown fence; return the bare object')
    body = (fence[1] as string).trim()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    const start = body.indexOf('{')
    const end = body.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        parsed = JSON.parse(body.slice(start, end + 1))
        errors.push('text surrounds the JSON object; return only the object')
      } catch {  }
    }
    if (parsed === undefined) return { ok: false, errors: [...errors, 'the final message is not valid JSON'] }
  }
  if (!isObj(parsed)) return { ok: false, errors: [...errors, 'expected one JSON object'] }
  const agent = agentOf(opts?.agent)
  const allowed = agent ? REVIEW_CATEGORIES[agent] : [...new Set(Object.values(REVIEW_CATEGORIES).flat())]
  const r = parsed

  for (const k of Object.keys(r)) if (!TOP_KEYS.includes(k)) errors.push(`unknown field \`${k}\``)
  const verdict = r['verdict']
  if (verdict !== 'pass' && verdict !== 'needs_changes') errors.push('`verdict` must be "pass" or "needs_changes"')
  const summary = r['summary']
  if (!nonEmpty(summary)) errors.push('`summary` must be a non-empty string')
  else {
    const subjects = subjectsOf(opts?.subject)
    if (!summaryStartsRight(summary, subjects)) {
      errors.push(subjects.length > 0 ? `\`summary\` must start with the reviewed path (${subjects.join(' or ')}) or "goal"` : '`summary` must start with the reviewed file path or "goal"')
    }
  }

  const findings = r['findings']
  let blocking = 0
  let mustFix = 0
  if (!Array.isArray(findings)) errors.push('`findings` must be a list (use [] when there is nothing to report)')
  else {
    if (findings.length > REVIEW_MAX_FINDINGS) errors.push(`report at most ${REVIEW_MAX_FINDINGS} findings (got ${findings.length}); keep the most severe`)
    let lastRank = 0
    findings.forEach((f, i) => {
      const at = `findings[${i}]`
      if (!isObj(f)) { errors.push(`${at} must be an object`); return }
      for (const k of Object.keys(f)) if (!FINDING_KEYS.includes(k)) errors.push(`${at}: unknown field \`${k}\``)
      const sev = f['severity']
      const rank = SEVERITY_ORDER.indexOf(sev as ReviewSeverity)
      if (rank < 0) errors.push(`${at}.severity must be must_fix, should_fix or suggestion`)
      else {
        if (rank < lastRank) errors.push(`${at}: sort findings by severity (must_fix, then should_fix, then suggestion)`)
        lastRank = Math.max(lastRank, rank)
        if (rank <= 1) blocking++
        if (rank === 0) mustFix++
      }
      const cat = f['category']
      if (!nonEmpty(cat)) errors.push(`${at}.category must be a non-empty string`)
      else if (!allowed.includes(cat)) errors.push(`${at}.category ${JSON.stringify(cat)} is not one of ${agent ? `${agent}'s` : 'the review'} categories`)
      const title = f['title']
      if (!nonEmpty(title)) errors.push(`${at}.title must be a non-empty string`)
      else if (title.length > 100 || title.includes('\n')) errors.push(`${at}.title must be one line of at most 100 characters`)
      if (!nonEmpty(f['evidence'])) errors.push(`${at}.evidence must be a non-empty string`)
      if (!nonEmpty(f['suggested_fix'])) errors.push(`${at}.suggested_fix must be a non-empty string`)
      if ('file' in f && !nonEmpty(f['file'])) errors.push(`${at}.file must be a non-empty string when present (omit it otherwise)`)
      if ('line' in f && !(typeof f['line'] === 'number' && Number.isInteger(f['line']) && (f['line'] as number) >= 1)) errors.push(`${at}.line must be a positive whole number when present (omit it otherwise)`)
    })
    if (verdict === 'pass' && blocking > 0) errors.push('`verdict` is "pass" but there are must_fix or should_fix findings; it must be "needs_changes"')
    if (verdict === 'needs_changes' && blocking === 0) errors.push('`verdict` is "needs_changes" but no finding is must_fix or should_fix; it must be "pass"')
  }

  const truths = r['truths']
  if (truths !== undefined) {
    if (!Array.isArray(truths)) errors.push('`truths` must be a list when present (omit it otherwise)')
    else {
      let failed = 0
      truths.forEach((t, i) => {
        const at = `truths[${i}]`
        if (!isObj(t)) { errors.push(`${at} must be an object`); return }
        for (const k of Object.keys(t)) if (!TRUTH_KEYS.includes(k)) errors.push(`${at}: unknown field \`${k}\``)
        if (!nonEmpty(t['truth'])) errors.push(`${at}.truth must be a non-empty string`)
        const st = t['status']
        if (st !== 'verified' && st !== 'failed' && st !== 'unverified') errors.push(`${at}.status must be verified, failed or unverified`)
        if (st === 'failed') failed++
        if (typeof t['evidence'] !== 'string') errors.push(`${at}.evidence must be a string`)
      })
      if (agent === 'changes-review' && failed > 0 && mustFix === 0) errors.push('a failed truth must be backed by a must_fix finding (the cause, or a goal_gap)')
    }
  } else if (agent === 'changes-review') {
    errors.push('changes-review must include `truths`')
  }

  if ('goal_score' in r) {
    const g = r['goal_score']
    if (!(typeof g === 'number' && Number.isInteger(g) && g >= 0 && g <= 100)) errors.push('`goal_score` must be a whole number from 0 to 100 when present (omit it otherwise)')
  }

  const ok = errors.length === 0
  return ok ? { ok, errors, review: r as unknown as ReviewReport } : { ok, errors }
}
