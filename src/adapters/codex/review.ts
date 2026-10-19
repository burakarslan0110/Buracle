import type * as CoreNs from '../../core/index'
import { log } from '../../engine/log'

function rec(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}
}

export function extractJsonObject(text: string): unknown {
  const t = text.trim()
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(t)
  const candidates = [t, fence?.[1], t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1)]
  for (const c of candidates) {
    if (c === undefined || c.trim() === '') continue
    try { return JSON.parse(c) } catch {  }
  }
  return undefined
}

export function reviewReportErrors(text: string): string[] {
  const v = extractJsonObject(text)
  if (v === undefined) return ['the final message is not a JSON object']
  const r = rec(v)
  if (Object.keys(r).length === 0) return ['the final message is not a JSON object']
  const errors: string[] = []
  if (r['verdict'] !== 'pass' && r['verdict'] !== 'needs_changes') errors.push('verdict must be "pass" or "needs_changes"')
  if (typeof r['summary'] !== 'string' || r['summary'].trim() === '') errors.push('summary must be a non-empty string that starts with the reviewed path or goal')
  if (!Array.isArray(r['findings'])) errors.push('findings must be an array')
  let blocking = false
  if (Array.isArray(r['findings'])) {
    r['findings'].forEach((f, i) => {
      const x = rec(f)
      if (!['must_fix', 'should_fix', 'suggestion'].includes(String(x['severity']))) errors.push(`findings[${i}].severity must be must_fix, should_fix or suggestion`)
      if (x['severity'] === 'must_fix' || x['severity'] === 'should_fix') blocking = true
      for (const k of ['category', 'title', 'evidence', 'suggested_fix']) if (typeof x[k] !== 'string' || (x[k] as string).trim() === '') errors.push(`findings[${i}].${k} must be a non-empty string`)
      if (x['line'] !== undefined && typeof x['line'] !== 'number') errors.push(`findings[${i}].line must be a number`)
    })
  }
  if ((r['verdict'] === 'needs_changes') !== blocking && Array.isArray(r['findings']) && (r['verdict'] === 'pass' || r['verdict'] === 'needs_changes')) {
    errors.push('verdict must be needs_changes exactly when a finding is must_fix or should_fix')
  }
  if (r['truths'] !== undefined) {
    if (!Array.isArray(r['truths'])) errors.push('truths must be an array')
    else r['truths'].forEach((t, i) => {
      const x = rec(t)
      if (typeof x['truth'] !== 'string') errors.push(`truths[${i}].truth must be a string`)
      if (!['verified', 'failed', 'unverified'].includes(String(x['status']))) errors.push(`truths[${i}].status must be verified, failed or unverified`)
      if (typeof x['evidence'] !== 'string') errors.push(`truths[${i}].evidence must be a string`)
    })
  }
  const score = r['goal_score']
  if (score !== undefined && (typeof score !== 'number' || score < 0 || score > 100)) errors.push('goal_score must be a number from 0 to 100')
  return errors
}

export function reviewErrors(text: string, agent: string, validate: typeof CoreNs.validateReviewJson, subject: readonly string[] = []): string[] {
  try {
    const r = validate(text, { agent, subject })
    return r.ok ? [] : r.errors.length > 0 ? r.errors : ['invalid review report']
  } catch (e) {
    log('debug', 'codex hook: core validateReviewJson unavailable; using the local check', { error: e })
    return reviewReportErrors(text)
  }
}
