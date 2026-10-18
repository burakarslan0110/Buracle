import type { ConsentNeed } from '../../../core/policy/consent'
import { ALLOW_ONCE, ALLOW_SESSION, CONSENT_OPTIONS, consentQuestion, pendingConsent, recordDialogGrants } from '../../shared/consent-dialog'
import { asRecord } from './util'

const HARNESS = 'opencode' as const

export function questionHint(need: ConsentNeed): string {
  return `To ask right away, call the \`question\` tool with one question whose text is exactly ${JSON.stringify(consentQuestion(need))} and the options ${CONSENT_OPTIONS.map(o => `"${o}"`).join(', ')}; Buracle records the user's pick, and after an allow you run the command again.`
}

function offersConsentOptions(q: Record<string, unknown>): boolean {
  const labels = Array.isArray(q['options']) ? q['options'].map(o => asRecord(o)['label']) : []
  return labels.length === CONSENT_OPTIONS.length && CONSENT_OPTIONS.every(o => labels.includes(o))
}

export function questionGrant(sid: string, input: unknown, result: { output?: unknown, metadata?: Record<string, unknown> }, now: number): 'once' | 'session' | undefined {
  const held = pendingConsent(HARNESS, sid)
  const questions = asRecord(input)['questions']
  const answers = asRecord(result.metadata)['answers'] ?? asRecord(result.output)['answers']
  if (held === undefined || !Array.isArray(questions) || !Array.isArray(answers)) return undefined
  const text = consentQuestion(held.need)
  for (const [i, raw] of questions.entries()) {
    const q = asRecord(raw)
    const picked: unknown = answers[i]
    if (q['question'] !== text || q['multiple'] === true || !offersConsentOptions(q) || !Array.isArray(picked) || picked.length !== 1) continue
    const answer = picked[0] === ALLOW_SESSION ? 'session' : picked[0] === ALLOW_ONCE ? 'once' : undefined
    if (answer === undefined) continue
    recordDialogGrants(HARNESS, sid, held.kinds, answer, now)
    return answer
  }
  return undefined
}
