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

const CLAUSE_SPLIT = /\n+|[;!?]+|(?<=\S)[.,](?=\s|$)|\s(?:and\s+then|and|then|after\s+that|ve\s+sonra|ve\s+ardindan|ve|sonra|ardindan|daha\s+sonra|sonrasinda)\s/u
const LEAD = /^(?:(?:please|pls|lutfen|ok(?:ay)?|tamam|tmm|evet|yes|yep|yeah|sure|alright|now|simdi|hadi|haydi|then|sonra|ardindan|also|ayrica|just|sadece|artik|bir\s+de|once|first|finally|son\s+olarak|go\s+ahead\s+and|feel\s+free\s+to|you\s+can|you\s+may|you(?:re|\s+are)?\s+allowed\s+to|you\s+have\s+my\s+permission\s+to|i\s+allow\s+you\s+to|can\s+you|could\s+you|would\s+you|kindly)(?![a-z0-9_-])[\s,:-]*)+/u
const EN_DO = /^(?:run|execute|do|perform|proceed\s+with|go\s+ahead\s+with|try)\s+(?:(?:a|an|the)\s+)?/u
const TAIL = /(?:\s+(?:please|pls|lutfen|now|simdi|artik|hemen|too|as\s+well|again|tekrar|for\s+me|da|de|bakalim))+$/u
const NARRATIVE = /(?:^|\s)(?:failed|fails|failing|error|errors|errored|broke|broken|crash\w*|hata\w*|verdi|veriyor|calismiyor|calismadi|patladi|bozuldu|why|neden|niye|nasil|nedir|ne|hangi|how|didnt|doesnt|wasnt|wont|cant|cannot|was|were|returned|gave|said|showed|output|logs?|happened|oldu|olmuyor)(?=\s|$)/u

const TR_DO = '(?:et|edin|ediniz|edelim|etsene|edebilirsin|edebilirsiniz|yap|yapin|yapiniz|yapalim|yapsana|yapabilirsin|yapabilirsiniz|calistir|calistirin|calistiralim|calistirsana|calistirabilirsin|calistirabilirsiniz|kos|kosun|kosalim|kosabilirsin|at|atin|atalim|atsana|atabilirsin|uygula|uygulayin|uygulayalim|uygulayabilirsin|gerceklestir|gerceklestirin|gerceklestirebilirsin)'
const TR_ALLOW = '(?:a|e|ya|ye)?\\s+izin\\s+ver(?:iyorum|iyoruz|dim|ebilirim)?'
const LOAN = '(?:la|le)(?:yabilirsin|yebilirsin|yabilirsiniz|yebilirsiniz|yin|yiniz|yalim|yelim|sana|sene)?'
const TR_DELETE = '(?:sil|silin|silelim|silebilirsin|silebilirsiniz|kaldir|kaldirin|kaldiralim|kaldirabilirsin)'
const PERMIT = '(?:\\s+(?:is|are)\\s+(?:ok|okay|fine|allowed|alright|approved))?'
const REF = '(?:(?:origin|upstream)(?:\\/[\\w./-]+)?|main|master|develop|trunk|head(?:~\\d*|\\^+)?|[0-9a-f]{7,40}|[\\w.-]+\\/[\\w./-]+)'
const TR_PUSH_OBJECT = '(?:origin\\S*|remote\\S*|uzak\\S*|depo\\S*|github\\S*|gitlab\\S*|bitbucket\\S*|main\\S*|master\\S*|develop\\S*|upstream\\S*|dal\\S*|branch\\S*|degisiklik\\S*|commit\\S*|kod\\S*|her\\s?sey\\S*|hepsi\\S*|bunlari|bunu|onu|onlari|sunu|feat\\S*|feature\\S*|fix\\S*|hotfix\\S*|release\\S*|[\\w.-]+\\/[\\w./-]+)'
const TR_PUBLISH_OBJECT = '(?:npm\\S*|paket\\S*|surum\\S*|versiyon\\S*|release\\S*|crate\\S*|imaj\\S*|image\\S*|kutuphane\\S*|modul\\S*|v?\\d[\\w.-]*)'

const re = (src: string): RegExp => new RegExp(src, 'u')
const TR_REQUEST_END = re(`(?:\\s+${TR_DO}|(?:commit|push)${LOAN})$`)
const MAX_CLAUSE = 1_000

const OPERATIONS: ReadonlyArray<[ConsentKind, { test(clause: string): boolean }]> = [
  ['force-push', re(`^(?:a\\s+)?force[\\s-]?push(?:\\s+(?:it|this|that|them|everything|the\\s+(?:branch|changes|commits|fix)|(?:to|into|onto)\\s+(?:the\\s+)?(?!the\\s)[\\w./-]+(?:\\s+branch)?|origin(?:\\s+[\\w./-]+)?)){0,3}${PERMIT}$`)],
  ['force-push', re(`^push\\s+(?:-f|--force\\S*)(?:\\s+[\\w./:+-]+)*$`)],
  ['force-push', re(`(?:^|\\s)(?:force[\\s-]?push|zorla\\s+push)(?:\\s+${TR_DO}|${TR_ALLOW}|${LOAN})$`)],
  ['force-push', re(`(?:^|\\s)push\\s+(?:-f|--force\\S*)\\s+${TR_DO}$`)],
  ['push', re(`^push(?:\\s+(?:-u|--set-upstream))?(?:\\s+(?:it|this|that|them|everything|all|(?:(?:the|my|your|our|these|those|all(?:\\s+the)?|all\\s+my)\\s+)?(?:changes?|commits?|branch(?:es)?|work|code|fix(?:es)?|updates?|tags?|feature)))?(?:\\s+(?:(?:to|into|onto|up\\s+to)\\s+(?:the\\s+)?(?:remote|origin|upstream|github|gitlab|bitbucket|server|repo|repository|${REF})(?:\\s+branch)?|(?:origin|upstream)(?:\\s+[\\w./-]+)?))?${PERMIT}$`)],
  ['push', re(`^(?:${TR_PUSH_OBJECT}\\s+){0,3}push(?:\\s+${TR_DO}|${TR_ALLOW}|${LOAN})$`)],
  ['history-rewrite', re(`^(?:git\\s+)?rebase(?:\\s+(?:-i|--interactive|interactively))?(?:\\s+(?:it|this|that|(?:the|this|my)\\s+(?:feature\\s+)?branch|(?:the\\s+)?feat\\S*|(?:the|my|these)\\s+commits?))?(?:\\s+(?:on|onto|on\\s+top\\s+of|against|over|with)\\s+(?:the\\s+)?(?:latest\\s+)?${REF}(?:\\s+branch)?)?${PERMIT}$`)],
  ['history-rewrite', re(`^(?:a\\s+)?(?:hard\\s+reset|reset\\s+--hard|reset\\s+hard)(?:\\s+(?:it|everything|(?:the|this)\\s+(?:branch|repo)))?(?:\\s+(?:to\\s+)?(?:the\\s+)?(?:${REF}|(?:last|previous)\\s+commit))?${PERMIT}$`)],
  ['history-rewrite', re(`^reset\\s+(?:(?:the|this|my)\\s+)?(?:(?:branch|repo|repository|it|everything|head)\\s+)?(?:back\\s+)?to\\s+(?:the\\s+)?(?:${REF}|(?:last|previous)\\s+commit)$`)],
  ['history-rewrite', re(`^amend\\s+(?:(?:the|that|this|my)\\s+)?(?:(?:last|previous|latest)\\s+)?commit(?:\\s+message)?(?:\\s+.*)?$`)],
  ['history-rewrite', re(`^squash\\s+(?:(?:the|these|those|all|my|our)\\s+)*(?:(?:last\\s+)?\\d+\\s+)?commits?(?:\\s+(?:into\\s+one|together))?$`)],
  ['history-rewrite', re(`^rewrite\\s+(?:the\\s+)?(?:git\\s+)?history$`)],
  ['history-rewrite', re(`(?:^|\\s)(?:rebase|amend|squash)(?:\\s+${TR_DO}|${LOAN})$`)],
  ['history-rewrite', re(`(?:^|\\s)(?:hard\\s+reset|reset\\s+--hard|reset\\s+hard)(?:\\s+${TR_DO}|${LOAN})$`)],
  ['history-rewrite', re(`(?:^|\\s)gecmis\\S*\\s+(?:yeniden\\s+)?yaz(?:in|abilirsin)?$`)],
  ['discard-changes', re(`^(?:discard|throw\\s+away|revert|undo|wipe(?:\\s+out)?)\\s+(?:(?:all|the|my|your|our|any|local|uncommitted|unstaged|working[\\s-]tree|pending|current)\\s+)*changes(?:\\s+(?:in|to|on)\\s+\\S+)?$`)],
  ['discard-changes', re(`^(?:drop|clear)\\s+(?:the\\s+)?stash(?:es)?$`)],
  ['discard-changes', re(`^clean\\s+(?:the\\s+)?(?:working\\s+tree|worktree|untracked\\s+files)$`)],
  ['discard-changes', re(`^(?:\\S+\\s+){0,2}degisiklik\\S*\\s+(?:at|atin|atabilirsin|sil|silin|silebilirsin|geri\\s+al|geri\\s+alin|geri\\s+alabilirsin|discard\\s+${TR_DO})$`)],
  ['discard-changes', re(`(?:^|\\s)stash\\S*\\s+(?:sil|silin|temizle|drop\\s+${TR_DO}|dropla\\S*)$`)],
  ['discard-changes', re(`^abort\\s+(?:(?:the|this|current|ongoing|in-progress)\\s+)*(?:merge|rebase|cherry[\\s-]?pick|revert|am)$`)],
  ['discard-changes', re(`(?:^|\\s)(?:merge|rebase|cherry-pick|revert)\\S*\\s+abort\\s+${TR_DO}$`)],
  ['branch-delete', re(`^(?:delete|remove)\\s+(?:(?:the|this|that|old|local|remote|merged|stale|my)\\s+)*(?:[\\w./-]+\\s+)?(?:branch(?:es)?|tags?)(?:\\s+[\\w./-]+)?$`)],
  ['branch-delete', re(`(?:^|\\s)(?:dal|dali|dalini|dallari|dallarini|branch|branchi|branchini|branchleri|branchlerini|etiket|etiketi|etiketleri|tag|tagi|tagleri)\\s+${TR_DELETE}$`)],
  ['skip-hooks', re(`^(?:commit|push|merge)\\b.*(?:--no-verify|no[\\s-]verify)`)],
  ['skip-hooks', re(`^skip\\s+(?:the\\s+)?(?:git\\s+|pre-commit\\s+|commit\\s+)?hooks$`)],
  ['skip-hooks', { test: c => /(?:--no-verify|no[\s-]verify)/u.test(c) && TR_REQUEST_END.test(c) }],
  ['skip-hooks', re(`(?:^|\\s)hook(?:lar)?(?:i|lari)?\\s+atla(?:yabilirsin|yin|yalim)?$`)],
  ['publish', re(`^publish(?:\\s+(?:it|this|that|the\\s+(?:package|crate|module|library|release|image|new\\s+version|gem|wheel)|(?:to|on)\\s+(?:npm|crates\\.io|pypi|the\\s+registry|docker\\s+hub|ghcr)|v?\\d[\\w.-]*|(?:a\\s+)?(?:new\\s+)?(?:release|version))){0,3}${PERMIT}$`)],
  ['publish', re(`^(?:create|cut|make|ship|tag)\\s+(?:(?:a|the)\\s+)?(?:new\\s+)?(?:github\\s+|gh\\s+)?release(?:\\s+v?\\d[\\w.-]*)?$`)],
  ['publish', re(`^merge\\s+(?:(?:the|this|that|my|your)\\s+)?(?:pr|pull\\s+request|mr|merge\\s+request)(?:\\s+#?\\d+)?(?:\\s+(?:into|to)\\s+\\S+)?$`)],
  ['publish', re(`^push\\s+(?:the\\s+)?(?:docker\\s+|container\\s+)?image(?:\\s+to\\s+\\S+)?$`)],
  ['publish', re(`^(?:${TR_PUBLISH_OBJECT}\\s+){0,2}publish(?:\\s+${TR_DO}|${LOAN})$`)],
  ['publish', re(`^(?:${TR_PUBLISH_OBJECT}\\s+){1,2}yayinla(?:yabilirsin|yin|yalim|sana)?$`)],
  ['publish', re(`(?:^|\\s)(?:pr|pull\\s+request\\S*|mr|merge\\s+request\\S*)(?:\\s+#?\\d+)?\\s+merge(?:\\s+${TR_DO}|${LOAN})$`)],
  ['db-destroy', re(`^drop\\s+(?:(?:the|this|that)\\s+)?(?:[\\w.-]+\\s+)?(?:table|database|db|schema|collection)s?(?:\\s+[\\w.-]+)?$`)],
  ['db-destroy', re(`^truncate\\s+(?:(?:the|this)\\s+)?(?:[\\w.-]+\\s+)?table(?:\\s+[\\w.-]+)?$`)],
  ['db-destroy', re(`^(?:reset|wipe|nuke|destroy|delete|drop)\\s+(?:(?:the|this|that)\\s+)?(?:[\\w.-]+\\s+)?(?:database|db)$`)],
  ['db-destroy', re(`^(?:prisma\\s+)?migrate\\s+reset$`)],
  ['db-destroy', re(`(?:^|\\s)(?:veritaban\\S*|database\\S*|db|dbyi|dbleri)\\s+(?:sil|silin|sifirla|sifirlayin|sifirlayabilirsin|drop\\s+${TR_DO}|dropla\\S*)$`)],
  ['db-destroy', re(`(?:^|\\s)(?:tablo\\S*|table\\S*|sema\\S*|schema\\S*|koleksiyon\\S*|collection\\S*)\\s+(?:drop(?:\\s+${TR_DO}|${LOAN})|truncate\\s+${TR_DO})$`)],
  ['db-destroy', re(`(?:^|\\s)migrate\\s+reset\\s+${TR_DO}$`)],
]

const FOLDER_DELETE: readonly RegExp[] = [
  re(`^(?:delete|remove)\\s+(?:(?:the|this|that|whole|entire|old)\\s+)*(?:([\\w./~-]+)\\s+)?(?:folder|directory|dir)(?:\\s+([\\w./~-]+))?$`),
  re(`(?:^|\\s)(?:([\\w./~-]+)\\s+)?(?:klasor|dizin|folder|directory)\\S*\\s+${TR_DELETE}$`),
]

const LITERAL = /^(?:sudo\s+)?(?:git|npm|pnpm|yarn|bun|bunx|npx|cargo|gh|docker|podman|rm|dropdb|prisma|rails|rake|bin\/rails|psql|mysql|mariadb|sqlite3?|duckdb|mongosh|find|xargs)(?![a-z0-9_-])/u
const LITERAL_VERB = re(`^(.*?)(?:\\s+(?:${TR_DO}|${TR_DELETE})|${TR_ALLOW})$`)
const SUBORDINATE = /(?:^|\s)(?:\S+(?:madan|meden|dikten|dukten|diktan|duktan)|once|before|after|without|until|unless|if|when|while|eger|iken)(?=\s|$)/u
function plainCommandLine(literal: string): boolean {
  const plain = literal.split(/\s+/u).slice(1).filter(w => !/^[-+:~./]|[/.:~=@+]|\d/u.test(w))
  return plain.length <= 3
}

function clauseKinds(raw: string, classify: (command: string) => ConsentKind | undefined): ConsentKind[] {
  if (raw.length > MAX_CLAUSE) return []
  let c = raw.trim().replace(LEAD, '').replace(TAIL, '').trim()
  if (c === '') return []
  const out: ConsentKind[] = []
  const asked = EN_DO.test(c)
  if (asked) c = c.replace(EN_DO, '').trim()
  if (LITERAL.test(c)) {
    const m = LITERAL_VERB.exec(c)
    const literal = m !== null ? (m[1] as string).trim() : c
    if (!SUBORDINATE.test(literal) && (m !== null || asked || (!NARRATIVE.test(c) && plainCommandLine(literal)))) {
      const kind = classify(literal)
      if (kind !== undefined) out.push(kind)
    }
    return out
  }
  if (NARRATIVE.test(c)) return out
  for (const [kind, pattern] of OPERATIONS) if (pattern.test(c) && !out.includes(kind)) out.push(kind)
  for (const pattern of FOLDER_DELETE) {
    const f = pattern.exec(c)
    if (f === null) continue
    const name = f[1] ?? f[2]
    if ((name === undefined || classify(`rm -rf ${name}`) !== undefined) && !out.includes('recursive-delete')) out.push('recursive-delete')
  }
  return out
}

export interface PromptReading {
  negated: boolean
  question: boolean
  permits: boolean
  approves: boolean
  confirms: ReadonlySet<ConsentKind>
  kinds: ReadonlySet<ConsentKind>
}

export function readPrompt(text: string, classify: (command: string) => ConsentKind | undefined): PromptReading | undefined {
  if (typeof text !== 'string') return undefined
  const own = ownWords(text)
  const t = fold(own)
  if (t.trim() === '') return undefined
  const negated = NEGATION.test(t)
  const kinds = new Set<ConsentKind>()
  const confirms = new Set<ConsentKind>()
  if (!negated) {
    const clauses = foldStem(own).split(CLAUSE_SPLIT)
    for (const clause of clauses) for (const k of clauseKinds(clause, classify)) kinds.add(k)
    const first = (clauses[0] ?? '').trim().replace(TAIL, '').trim()
    for (const [pattern, ks] of CONFIRMS) if (first.length <= MAX_CLAUSE && pattern.test(first)) for (const k of ks) confirms.add(k)
  }
  return { negated, question: QUESTION.test(t), permits: /\bizin\b|\ballowed\b/u.test(t), approves: APPROVAL.test(t), confirms, kinds }
}
