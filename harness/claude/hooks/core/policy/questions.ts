import type { ToolCall } from '../events'
import type { SessionState } from '../plan/state'
import { fold, word } from './text'

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

const ROUTINE_TEXT = new RegExp(word([
  'devam (?:ede(?:yim|lim|bilir miyim|bilir miyiz|cek miyim|cek miyiz)|etme(?:mi|li mi(?:yim|yiz))|edilsin|etsem|mi)',
  'beklemeye devam', 'bekle(?:yeyim|yelim|meli mi(?:yim|yiz)|memi|sem)', 'surdur(?:eyim|elim)', 'ilerle(?:yeyim|yelim)',
  'gec(?:eyim|elim) mi', '(?:tekrar|sonra|biraz sonra|daha sonra) kontrol (?:edeyim|edelim)', 'hala bekle(?:yeyim|yelim)',
  '(?:should|shall|can|may) (?:i|we) (?:still )?(?:continue|proceed|keep going|keep waiting|wait|go ahead|carry on|move on|resume|check back|check again|keep monitoring|keep polling)',
  '(?:do|would) you (?:want|like) me to (?:continue|proceed|keep going|keep waiting|wait|go ahead|carry on|move on)',
  'want me to (?:continue|proceed|keep going|keep waiting)', '(?:ok|okay|alright|fine) (?:if i|to) (?:continue|proceed|keep (?:going|waiting))',
  'ready (?:for me )?to (?:continue|proceed)', '(?:let me know|tell me) (?:if|when|whether) (?:i should|to) (?:continue|proceed|keep)',
  'is it (?:ok|okay|fine|alright) (?:if i|to) (?:continue|proceed|keep)',
].join('|')))
const BARE_ROUTINE = /^(?:continue|proceed|keep (?:going|waiting)|wait longer|devam(?: edeyim)?|devam mi|beklemeye devam(?: edeyim)?|bekleyeyim mi)\s*\?*$/

const ROUTINE_OPTION = /^(?:yes|no|ok|okay|sure|continue|proceed|keep (?:going|waiting)|wait(?: longer| more)?|stop|abort|cancel|pause|check (?:later|again|back)|retry later|later|not now|yes,? (?:continue|proceed|keep (?:going|waiting))|no,? (?:stop|wait)|continue waiting|stop waiting|evet|hayir|tamam|olur|devam(?: et)?|evet,? devam(?: et)?|beklemeye devam(?: et)?|bekle|dur|durdur|iptal|vazgec|sonra|daha sonra|sonra kontrol et|tekrar kontrol et|simdilik dur)$/

const MATERIAL = new RegExp(word([
  'sil|silin|sileyim|silelim|silinsin|silmek|silme|silinecek|silmemi', 'delet[a-z]*', 'remov[a-z]*', 'kaldir[a-z]*', 'drop[a-z]*',
  'destroy[a-z]*', 'wip(?:e|es|ed|ing)', 'purg[a-z]*', 'eras[a-z]*', 'deploy[a-z]*', 'publish[a-z]*', 'releas[a-z]*', 'yayin[a-z]*', 'merg[a-z]*',
  'birlestir[a-z]*', 'push[a-z]*', 'commit[a-z]*', 'credential[a-z]*', 'sifre[a-z]*', 'parola[a-z]*', 'password[a-z]*', 'secret[a-z]*',
  'gizli', 'token[a-z]*', 'api key', 'anahtar[a-z]*', 'permission[a-z]*', 'izin[a-z]*', 'approv[a-z]*', 'onay[a-z]*', 'cost[a-z]*',
  'maliyet[a-z]*', 'ucret[a-z]*', 'fiyat[a-z]*', 'pric[a-z]*', 'pay', 'payment[a-z]*', 'odeme[a-z]*', 'quota', 'kota[a-z]*',
  'budget', 'butce[a-z]*', 'billing', 'fatura[a-z]*', 'credit[a-z]*', 'kredi[a-z]*', 'deadline', 'son tarih', 'prod', 'production',
  'canli', 'database', 'veritaban[a-z]*', 'migrat[a-z]*', 'fail[a-z]*', 'error[a-z]*', 'hata[a-z]*', 'basarisiz[a-z]*', 'broken',
  'bozul[a-z]*', 'manual[a-z]*', 'manuel', 'elle', 'by hand', 'your (?:input|decision|choice|call)', 'senin (?:karar[a-z]*|tercih[a-z]*|fikr[a-z]*)',
].join('|')))
const MONEY = /[$€₺£]\s?\d|\d\s?(?:usd|tl|eur|try|dolar)(?![a-z])/

const ROUTINE_ALTERNATIVE = /\b(?:or|ya da|veya|yoksa) (?:should i |shall i )?(?:stop|wait|not|abort|cancel|pause|keep waiting|check (?:back )?later|dur(?:ayim|alim)?|bekle(?:yeyim|yelim)?|hayir)\b/g
const ALTERNATIVE = /\b(?:or|ya da|veya|yoksa)\b/

function cleanLabel(s: string): string {
  return fold(s).replace(/\((?:recommended|onerilen|tavsiye edilen)\)/g, '').replace(/[.!?:;"'()[\]]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function isRoutine(q: Question): boolean {
  const text = fold(q.text)
  if (text === '') return false
  const all = [text, ...q.options.map(fold), ...q.details.map(fold)].join(' \n ')
  MATERIAL.lastIndex = 0
  if (MATERIAL.test(all) || MONEY.test(all)) return false
  ROUTINE_TEXT.lastIndex = 0
  if (!ROUTINE_TEXT.test(text) && !BARE_ROUTINE.test(text)) return false
  if (ALTERNATIVE.test(text.replace(ROUTINE_ALTERNATIVE, ' '))) return false
  return q.options.every(o => ROUTINE_OPTION.test(cleanLabel(o)))
}

const REASON = 'A routine "should I continue / keep waiting?" question is not allowed while an approved plan runs: keep working and poll long jobs yourself, or for a real decision run `buracle plan pause --kind decision --reason "<question>"` first and then ask.'
const HELD = 'The plan is held for the user, so no keep-waiting question is needed: say where things stand and end the turn; the user resumes the plan.'

export const QUESTION_PAUSE_NOTE = 'Buracle H09: the plan is running, not paused. If the answer to this question may come in a later turn, run `buracle plan pause --kind decision --reason "<question>"` first; after the answer, run `buracle plan resume`.'
export const ASYNC_QUESTION_PAUSED = 'Buracle H09: this question returns before the user answers, so Buracle recorded a decision pause for it. The answer arrives as the user\'s next message: act on it and run `buracle plan resume`.'

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length <= max ? t : `${t.slice(0, max - 3).trimEnd()}...`
}

function mixedReason(routine: readonly Question[]): string {
  const named = routine.slice(0, 2).map(q => `"${clip(q.text, 80)}"`).join(' and ')
  return `A routine "should I continue / keep waiting?" question is not allowed while an approved plan runs: drop ${named} and ask the remaining question${routine.length === 1 ? '' : 's'} again.`
}

type Plan = NonNullable<SessionState['plan']>

function guarded(plan: Plan | undefined): plan is Plan {
  if (plan === undefined) return false
  if (plan.status !== 'APPROVED' && plan.status !== 'IN_PROGRESS' && plan.status !== 'COMPLETE') return false
  return plan.phase === 'implement' || plan.phase === 'verify'
}

export function checkQuestion(state: SessionState, call: ToolCall, now: number): { deny?: string, context?: string } {
  void now
  if (!call || call.kind !== 'ask_user') return {}
  if (!guarded(state?.plan)) return {}
  const input = call.input !== null && typeof call.input === 'object' ? call.input : {}
  const qs = questionsOf(input)
  if (qs.length === 0) return {}
  const routine = qs.filter(isRoutine)
  const i = state.interaction
  if (i?.state === 'paused') {
    if (i.kind === 'decision' || routine.length === 0) return {}
    return { deny: routine.length === qs.length ? HELD : mixedReason(routine) }
  }
  if (routine.length === qs.length) return { deny: REASON }
  if (routine.length > 0) return { deny: mixedReason(routine) }
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
