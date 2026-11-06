import type { ToolCall } from '../events'
import type { SessionState } from '../plan/state'

interface Question { text: string; options: string[]; details: string[] }

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x.trim() !== '' ? x : undefined
}

function optionsOf(x: unknown): { options: string[], details: string[] } {
  const options: string[] = []
  const details: string[] = []
  if (!Array.isArray(x)) return { options, details }
  for (const o of x) {
    if (typeof o === 'string') { options.push(o); continue }
    if (o !== null && typeof o === 'object') {
      const rec = o as Record<string, unknown>
      const label = str(rec['label']) ?? str(rec['value']) ?? str(rec['text'])
      if (label !== undefined) options.push(label)
      const d = str(rec['description'])
      if (d !== undefined) details.push(d)
    }
  }
  return { options, details }
}

function questionsOf(input: Record<string, unknown>): Question[] {
  const out: Question[] = []
  const qs = input['questions']
  if (Array.isArray(qs)) {
    for (const q of qs) {
      if (typeof q === 'string') { out.push({ text: q, options: [], details: [] }); continue }
      if (q === null || typeof q !== 'object') continue
      const rec = q as Record<string, unknown>
      const text = str(rec['question']) ?? str(rec['prompt']) ?? str(rec['text']) ?? str(rec['header']) ?? ''
      const { options, details } = optionsOf(rec['options'])
      const header = str(rec['header'])
      out.push({ text, options, details: header !== undefined && header !== text ? [...details, header] : details })
    }
    return out
  }
  const text = str(input['question']) ?? str(input['prompt']) ?? str(input['message']) ?? str(input['text'])
  if (text !== undefined) {
    const { options, details } = optionsOf(input['options'] ?? input['choices'])
    out.push({ text, options, details })
  }
  return out
}

export const QUESTION_PAUSE_NOTE = 'Buracle H09: the plan is running, not paused. If the answer to this question may come in a later turn, run `buracle plan pause --kind decision --reason "<question>"` first; after the answer, run `buracle plan resume`.'
export const ASYNC_QUESTION_PAUSED = 'Buracle H09: this question returns before the user answers, so Buracle recorded a decision pause for it. The answer arrives as the user\'s next message: act on it and run `buracle plan resume`.'

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`
}

type Plan = NonNullable<SessionState['plan']>

function guarded(plan: Plan | undefined): plan is Plan {
  if (plan === undefined) return false
  if (plan.status !== 'APPROVED' && plan.status !== 'IN_PROGRESS' && plan.status !== 'COMPLETE') return false
  return plan.phase === 'implement' || plan.phase === 'verify'
}

// H09 reads no question wording (PRD follow-up 2026-11-06): whether a question is routine is the
// agent's call, under its rules. While an approved plan runs unpaused, a question carries the reminder
// to pause first, so an answer that comes in a later turn finds the run paused.
export function checkQuestion(state: SessionState, call: ToolCall, now: number): { deny?: string, context?: string } {
  void now
  if (!call || call.kind !== 'ask_user') return {}
  if (!guarded(state?.plan)) return {}
  const input = call.input !== null && typeof call.input === 'object' ? call.input : {}
  if (questionsOf(input).length === 0) return {}
  if (state.interaction?.state === 'paused') return {}
  return { context: QUESTION_PAUSE_NOTE }
}

export function questionPause(state: SessionState, call: ToolCall, now: number): SessionState {
  if (!call || call.kind !== 'ask_user' || !guarded(state?.plan) || state.interaction?.state === 'paused') return state
  const input = call.input !== null && typeof call.input === 'object' ? call.input : {}
  const first = questionsOf(input).find(q => q.text.trim() !== '')
  return { ...state, interaction: { state: 'paused', kind: 'decision', since: now, reason: first !== undefined ? clip(first.text, 200) : 'a question to the user' } }
}

const CANCELLED = /^(?:(?:the )?user (?:cancel+ed|declined|dismissed|skipped|did not (?:select|answer)|chose to chat)|ask tool was cancel+ed|cancel+ed|dismissed|declined|no answer|\(no answer\))/i

function noneAnswered(t: string): boolean {
  if (t.startsWith('User has answered your questions:')) {
    const values = [...t.matchAll(/"="([\s\S]*?)"(?=, "|\. You can now|$)/g)].map(m => m[1])
    return values.length > 0 && values.every(v => v === 'Unanswered')
  }
  if (t.startsWith('User answers:')) {
    const lines = t.split('\n').slice(1).filter(l => l.trim() !== '')
    return lines.length > 0 && lines.every(l => /: (?:\(cancelled\)|\[\])$/.test(l.trim()))
  }
  return false
}

function hasAnswer(x: unknown, depth = 0): boolean {
  if (depth > 4) return false
  if (typeof x === 'string') return x.trim() !== ''
  if (typeof x === 'number' || typeof x === 'boolean') return true
  if (Array.isArray(x)) return x.some(v => hasAnswer(v, depth + 1))
  if (x !== null && typeof x === 'object') return Object.values(x as Record<string, unknown>).some(v => hasAnswer(v, depth + 1))
  return false
}

export function questionAnswered(response: unknown, depth = 0): boolean {
  if (depth > 3) return false
  let r = response
  if (typeof r === 'string') {
    const t = r.trim()
    if (t === '') return false
    if (!/^[[{]/.test(t)) return !CANCELLED.test(t) && !noneAnswered(t)
    try { r = JSON.parse(t) as unknown } catch { return !CANCELLED.test(t) }
  }
  if (Array.isArray(r)) return r.some(b => questionAnswered(b !== null && typeof b === 'object' && typeof (b as Record<string, unknown>)['text'] === 'string' ? (b as Record<string, unknown>)['text'] : b, depth + 1))
  if (r === null || typeof r !== 'object') return false
  const rec = r as Record<string, unknown>
  if ('answers' in rec) return hasAnswer(rec['answers'])
  if (rec['accepted'] === true) return false
  for (const k of ['content', 'output', 'text', 'answer', 'result']) if (rec[k] !== undefined) return questionAnswered(rec[k], depth + 1)
  return false
}
