import type { ConsentKind } from './consent'
import { fold as foldText } from './text'

function fold(s: string): string {
  return foldText(s).replace(/'/gu, '')
}

function foldStem(s: string): string {
  return foldText(s).replace(/'[a-z]{1,5}(?![a-z0-9])/gu, '').replace(/'/gu, '')
}

function ownWords(text: string): string {
  return text
    .replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?(?:\n[ \t]*\2[^\n]*|$)/gu, '$1')
    .replace(/(^|\n)[ \t]*>[^\n]*/gu, '$1')
}

const APPROVAL = /^\s*(?:evet|yes|yep|yeah|tamam|tmm|olur|ok(?:ay)?|onay(?:la|liyorum|ladim)?|izin\s+ver(?:iyorum|dim)?|kabul(?:\s+ediyorum)?|devam(?:\s+et)?|yap(?:abilirsin)?|go\s+ahead|do\s+it|run\s+it|proceed|approved?|lgtm|sure|allowed?)(?![a-z0-9_-])/u
const CONFIRMS: ReadonlyArray<[RegExp, readonly ConsentKind[]]> = [
  [/^(?:delete|remove|rm)\s+(?:it|them)$|^(?:sil|silin|silebilirsin|kaldir|kaldirabilirsin)$/u, ['recursive-delete', 'branch-delete', 'db-destroy']],
  [/^(?:force[\s-]?push|push)\s+(?:it|them)$|^push(?:\s+et|la|layabilirsin)$/u, ['push', 'force-push']],
  [/^drop\s+(?:it|them)$|^drop(?:\s+et|la)$/u, ['db-destroy', 'discard-changes']],
  [/^(?:reset|rebase|amend|squash)\s+(?:it|them)$|^(?:reset|rebase|amend|squash)(?:\s+et|le|la)$/u, ['history-rewrite']],
  [/^(?:discard|throw\s+away)\s+(?:it|them)$|^at$/u, ['discard-changes']],
  [/^(?:publish|merge|release)\s+(?:it|them)$|^(?:publish|merge)(?:\s+et|le)$|^yayinla$/u, ['publish']],
]
const NEGATION = /\b(?:yapma|etme|silme|atma|pushlama|gonderme|dokunma|hayir|asla|iptal|vazgec|don'?t|do\s+not|never|nope|stop|cancel|without)\b|(?<![\w-])no(?![\w-])|\S(?:ma|me)(?:yin|yiniz)?\s*[.!]*\s*$/u
const QUESTION = /\?|\s(?:mi|mu|misin|musun|miyiz)\b/u

const TAIL = /(?:\s+(?:please|pls|lutfen|now|simdi|artik|hemen|too|as\s+well|again|tekrar|for\s+me|da|de|bakalim))+$/u
const MAX_CLAUSE = 1_000
const CLAUSE_SPLIT = /\n+|[;!?]+|(?<=\S)[.,](?=\s|$)|\s(?:and\s+then|and|then|after\s+that|ve\s+sonra|ve\s+ardindan|ve|sonra|ardindan|daha\s+sonra|sonrasinda)\s/u
export interface PromptReading {
  negated: boolean
  question: boolean
  approves: boolean
  confirms: ReadonlySet<ConsentKind>
}

// Reads the user's reply to a command H20 holds: a yes, the held operation's own verb ("delete it",
// "sil"), a negation or a question. Words outside a fence or a quote count.
export function readPrompt(text: string): PromptReading | undefined {
  if (typeof text !== 'string') return undefined
  const own = ownWords(text)
  const t = fold(own)
  if (t.trim() === '') return undefined
  const negated = NEGATION.test(t)
  const confirms = new Set<ConsentKind>()
  if (!negated) {
    const first = (foldStem(own).split(CLAUSE_SPLIT)[0] ?? '').trim().replace(TAIL, '').trim()
    for (const [pattern, ks] of CONFIRMS) if (first.length <= MAX_CLAUSE && pattern.test(first)) for (const k of ks) confirms.add(k)
  }
  return { negated, question: QUESTION.test(t), approves: APPROVAL.test(t), confirms }
}
