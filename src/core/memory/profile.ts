import { memQueryWords, memTitleSimilarity } from './query'
import type { SpoolDigest } from './spool'
import { memOneLine, normalizeForSearch, redactClip } from './text'

export type ProfileSignalKind = 'statement' | 'correction' | 'confirmation' | 'usage' | 'environment' | 'style' | 'inference'
export type ProfileCategory = 'communication' | 'autonomy' | 'engineering' | 'workflow' | 'quality' | 'avoid' | 'other'

export interface ProfileSignal {
  kind: ProfileSignalKind
  key: string
  polarity?: 1 | -1
  weight?: number
  category?: ProfileCategory
  text?: string
  quote?: string
}

export const PROFILE_WEIGHTS: Readonly<Record<ProfileSignalKind, number>> = {
  statement: 3, correction: 2, confirmation: 1, style: 1, usage: 0.5, environment: 0.5, inference: 1.5,
}

export const PROFILE_CATEGORIES: readonly ProfileCategory[] = ['communication', 'autonomy', 'engineering', 'workflow', 'quality', 'avoid', 'other']
const KINDS: readonly ProfileSignalKind[] = ['statement', 'correction', 'confirmation', 'usage', 'environment', 'style']

export const PROFILE_QUOTE_MAX = 160
const KEY_RE = /^[a-z][a-z0-9_.:=+#/-]{0,119}$/

const WORD_EDGE = String.raw`(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))`

function uw(re: RegExp): RegExp {
  return new RegExp(re.source.split('\\b').join(WORD_EDGE), re.flags.includes('u') ? re.flags : `${re.flags}u`)
}

export const PROFILE_WORKFLOWS: readonly string[] = [
  'plan-build', 'goal-build', 'bugfix', 'requirements', 'research', 'inspect', 'dead-code', 'project-rules', 'new-skill', 'ab-test',
]

export const PROFILE_MCP_SERVERS: readonly string[] = ['context7', 'codegraph', 'context-mode', 'web-search', 'web-fetch', 'grep', 'semble', 'chrome-devtools', 'buracle-memory']

function clipText(s: string, scrub?: (s: string, max: number) => string): string {
  const one = memOneLine(s)
  return scrub ? scrub(one, PROFILE_QUOTE_MAX) : redactClip(one, PROFILE_QUOTE_MAX).text
}

export function profileSanitizeSignal(x: unknown, scrub?: (s: string, max: number) => string): ProfileSignal | undefined {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return undefined
  const o = x as Record<string, unknown>
  const kind = o['kind']
  const key = o['key']
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) return undefined
  if (typeof key !== 'string' || !KEY_RE.test(key)) return undefined
  const s: ProfileSignal = { kind: kind as ProfileSignalKind, key }
  if (o['polarity'] === -1) s.polarity = -1
  const w = o['weight']
  if (typeof w === 'number' && Number.isFinite(w)) s.weight = Math.max(0, Math.min(5, w))
  const c = o['category']
  if (typeof c === 'string' && (PROFILE_CATEGORIES as readonly string[]).includes(c)) s.category = c as ProfileCategory
  if (typeof o['text'] === 'string' && o['text'].trim() !== '') s.text = clipText(o['text'], scrub)
  if (typeof o['quote'] === 'string' && o['quote'].trim() !== '' && kind === 'statement') s.quote = clipText(o['quote'], scrub)
  return s
}

const TR_WORDS = new Set([
  've', 'bir', 'bu', 'şu', 'için', 'icin', 'ile', 'değil', 'degil', 'mi', 'mı', 'mu', 'mü', 'ne', 'ama', 'çok', 'cok', 'olarak',
  'gibi', 'daha', 'şimdi', 'simdi', 'lütfen', 'lutfen', 'neden', 'nasıl', 'nasil', 'evet', 'hayır', 'hayir', 'tamam', 'de', 'da',
  'ki', 'var', 'yok', 'sonra', 'önce', 'once', 'her', 'hep', 'bunu', 'şunu', 'olsun', 'misin', 'mısın', 'musun', 'müsün', 'şey',
  'yap', 'yapma', 'yapalım', 'yapalim', 'kontrol', 'artık', 'artik', 'bana', 'sen', 'ben', 'biz', 'onu', 'burada', 'şöyle',
])
const EN_WORDS = new Set([
  'the', 'and', 'is', 'are', 'to', 'of', 'in', 'it', 'that', 'this', 'for', 'with', 'please', 'can', 'you', 'what', 'how', 'why',
  'do', 'does', 'not', 'be', 'on', 'we', 'i', 'my', 'should', 'would', 'could', 'will', 'make', 'use', 'from', 'then', 'now',
  'let', "let's", 'just', 'also', 'there', 'here', 'when', 'which', 'your', 'me', 'have', 'has', 'was', 'were', 'an', 'a',
])

export function profilePromptLanguage(text: string): 'tr' | 'en' | undefined {
  const words = text.replace(/İ/g, 'i').toLowerCase().split(/[^\p{L}']+/u).filter(w => w !== '')
  if (words.length < 3) return undefined
  let tr = 0
  let en = 0
  for (const w of words) {
    if (TR_WORDS.has(w)) tr++
    if (EN_WORDS.has(w)) en++
  }
  if (/[ğışİŞĞ]/.test(text)) tr += 2
  if (tr === en) return undefined
  return tr > en ? 'tr' : 'en'
}

const TRIGGER_LEAD = uw(/^(?:please\s+|lütfen\s+|lutfen\s+)?(?:always|never|from now on|going forward|in (?:the )?future|every time|whenever|her zaman|daima|asla|hiçbir zaman|hicbir zaman|hiç bir zaman|bundan sonra|bundan böyle|bundan boyle|artık|artik|sakın|sakin|unutma|aklında tut|aklinda tut)\b/i)
const TRIGGER_ANY = uw(/\b(?:always|never|from now on|going forward|i(?:'d| would)? prefer|i (?:want|need) you to|i (?:don'?t|do not) (?:want|like)|(?:don'?t|do not) ever|stop (?:doing|using|adding|writing|asking)|remember (?:that|to)|keep in mind|make sure (?:to|you))\b|(?:^|\s)(?:her zaman|daima|asla|hiçbir zaman|hicbir zaman|bundan sonra|bundan böyle|tercih ederim|tercihim|istemiyorum|bir daha)(?=[\s.,!?]|$)/i)
const ADDRESSED = uw(/\b(?:you|your|please|we|let'?s|i want|i prefer|i'd like|i like)\b|(?:^|\s)(?:lütfen|lutfen|sen|senden|istiyorum|tercih)/i)
const NEGATIVE = uw(/\b(?:never|don'?t|do not|stop|avoid|no more|without)\b|(?:^|\s)(?:asla|hiçbir zaman|hicbir zaman|sakın|sakin|istemiyorum|bir daha|yapma|etme|kullanma|ekleme|yazma|sorma|değiştirme|degistirme|silme|koyma)(?=[\s.,!?]|$)/i)
const NOT_A_RULE = uw(/^(?:never ?mind|nevermind)\b/i)
const STRIP_LEAD = uw(/^(?:(?:please|lütfen|lutfen|ok(?:ay)?|so|and|also|but)[\s,]+)*(?:from now on|going forward|in (?:the )?future|bundan sonra|bundan böyle|bundan boyle|artık|artik)[\s,:-]*/i)

const PERSONAL_LEAD = /^(?:i(?:'d| would)? (prefer) |i (?:want|need) you to |i(?:'d| would) like you to )/i

const QUESTION_LEAD = uw(/^(?:(?:please|ok(?:ay)?|so|and|but)[\s,]+)*(?:what|why|how|where|who|which|whose|is (?:it|this|that|there)|are (?:you|we|they|there)|do (?:you|we|i|they)|does|did|can (?:you|we|i)|could (?:you|we|i)|would (?:you|we)|will (?:you|we)|should (?:i|we)|shall (?:i|we))\b/i)
const TR_QUESTION = uw(/(?:^|\s)(?:m[ıiuü](?:y[ıiuü]m|s[ıiuü]n|y[ıiuü]z|s[ıiuü]n[ıiuü]z|d[ıiuü]r|yd[ıiuü]|ym[ıiuü][şs])?|neden|niye|nas[ıi]l|nerede|hangi)(?=[\s.,!?]|$)/i)
const THANKS = uw(/\b(?:thanks|thank you|thx|cheers)\b|(?:^|\s)(?:te[şs]ekk[üu]r(?:ler|ederim)?|sa[ğg] ?ol(?:un)?|eyvallah|eline sa[ğg]l[ıi]k)(?=[\s.,!?]|$)/i)
const DIRECTIVE = uw(/\b(?:i (?:want|need) you to|i(?:'d| would) like you to|i(?:'d| would)? prefer|i (?:don'?t|do not) (?:want|like)|make sure|keep in mind|remember (?:to|that)|(?:you|we) (?:should|must|need to|have to|ought to)|(?:you|we)(?:'ll| will) (?:always|never)|let'?s)\b/i)
const RULE_LEAD = uw(/^(?:(?:please|lütfen|lutfen|ok(?:ay)?|so|and|also|but|just|simply|then|from now on|going forward|in (?:the )?future|from here on|bundan sonra|bundan böyle|bundan boyle|artık|artik|bir daha|unutma|aklında tut|aklinda tut|sakın|sakin|her zaman|daima|hep|asla|hiçbir zaman|hicbir zaman|hiç bir zaman)\b[\s,]*)+/i)
const CONDITION_LEAD = uw(/^(?:whenever|every ?time|each time|when|if|once|after|before|as soon as|her seferinde|ne zaman)\b/i)
const EN_NOT_IMPERATIVE = new Set([
  'i', "i'm", "i've", "i'd", "i'll", 'it', "it's", 'its', 'this', 'that', 'these', 'those', 'the', 'a', 'an', 'there', "there's",
  'he', 'she', 'they', 'we', 'you', "you're", "we're", "they're", 'my', 'our', 'your', 'his', 'her', 'their', 'everything',
  'nothing', 'something', 'someone', 'everyone', 'all', 'some', 'any', 'now', 'still', 'yes', 'no', 'ok', 'okay', 'thanks',
  'same', 'one', 'had', 'has', 'have', 'was', 'were', 'is', 'are', 'am', 'be', 'been', 'seen', 'got', 'gotten', 'did', 'done',
  'went', 'gone', 'came', 'made', 'said', 'can', 'could', 'would', 'should', 'will', 'might', 'must', 'may', 'when', 'if', 'what',
  'why', 'how', 'where', 'which', 'who', 'with', 'without', 'for', 'in', 'on', 'at', 'by', 'of', 'to', 'from', 'after', 'before',
  'during', 'because', 'since', 'until', 'unless', 'even', 'as', 'like', 'about', 'again', 'today', 'yesterday', 'here', 'too',
  'very', 'really', 'quite', 'not', 'ever', 'only',
])
const EN_FILLERS = new Set(['please', 'just', 'simply', 'also', 'ever', 'kindly', 'then', 'so', 'and', 'but', 'ok', 'okay'])
const TR_RULE_WORDS = new Set([
  'istiyorum', 'istemiyorum', 'isterim', 'istemem', 'ederim', 'lazim', 'gerek', 'gerekir', 'gerekiyor', 'sart', 'zorunlu',
])
const TR_IMPERATIVE_STEMS = new Set([
  'kullan', 'yaz', 'yap', 'calistir', 'ekle', 'sor', 'et', 'ver', 'tut', 'koy', 'oku', 'basla', 'baslat', 'bekle', 'soyle',
  'yanitla', 'cevapla', 'acikla', 'duzelt', 'sil', 'degistir', 'guncelle', 'gonder', 'at', 'al', 'bak', 'uygula', 'ozetle',
  'goster', 'anlat', 'kisalt', 'bitir', 'olustur', 'cevir', 'sec', 'kaldir', 'tasi', 'ayir', 'birlestir', 'dene', 'dogrula',
  'incele', 'arastir', 'belgele', 'hazirla', 'dusun', 'birak', 'kapat', 'ac', 'sakla', 'kur', 'yukle', 'derle', 'kos', 'gec',
  'ol', 'dur', 'durdur', 'onayla', 'iste', 'sorgula', 'commitle', 'pushla', 'yolla', 'kontrol', 'test',
])
const TR_IMPERATIVE_ENDING = /(?:m[ae](?:yin(?:iz)?)?|m[ae]l[ie](?:sin(?:iz)?|yiz|dir)?|s[iu]n(?:lar)?|[ae]lim|y[ae]lim)$/
const TR_TRAILING = /(?:\s+(?:lütfen|lutfen|please|tamam|ok))+$/i

function foldTurkish(s: string): string {
  return s.replace(/İ/g, 'i').toLowerCase().replace(/ç/g, 'c').replace(/ğ/g, 'g').replace(/ı/g, 'i').replace(/ö/g, 'o').replace(/ş/g, 's').replace(/ü/g, 'u')
}

function enImperativeStart(clause: string): boolean {
  const words = clause.toLowerCase().replace(/\u2019/g, "'").split(/\s+/).map(w => w.replace(/^[^a-z']+|[^a-z']+$/g, '')).filter(w => w !== '')
  let i = 0
  while (i < words.length && EN_FILLERS.has(words[i] as string)) i++
  if (words[i] === 'always' || words[i] === 'never') {
    i++
    while (i < words.length && EN_FILLERS.has(words[i] as string)) i++
  }
  const w = words[i]
  if (w === undefined) return false
  if (w === "don't" || w === 'dont' || (w === 'do' && words[i + 1] === 'not')) return true
  if (EN_NOT_IMPERATIVE.has(w) || !/^[a-z][a-z'-]*$/.test(w) || /(?:ed|ing)$/.test(w)) return false
  return !(w.endsWith('s') && !/(?:ss|us|is)$/.test(w))
}

function trImperativeEnd(clause: string): boolean {
  const words = foldTurkish(clause.replace(TR_TRAILING, '')).split(/\s+/).map(w => w.replace(/^[^a-z']+|[^a-z']+$/g, '')).filter(w => w !== '')
  const last = (words.at(-1) ?? '').replace(/^.*'/, '')
  if (last.length < 2) return false
  if (TR_RULE_WORDS.has(last) || TR_IMPERATIVE_STEMS.has(last)) return true
  for (const stem of TR_IMPERATIVE_STEMS) if (stem.length >= 3 && /^(?:y?[iu]n(?:[iu]z)?)$/.test(last.slice(stem.length)) && last.startsWith(stem)) return true
  return last.length >= 4 && TR_IMPERATIVE_ENDING.test(last)
}

function ruleShaped(sentence: string): boolean {
  const s = sentence.trim()
  if (/\?\s*$/.test(s) || QUESTION_LEAD.test(s) || TR_QUESTION.test(s)) return false
  if (DIRECTIVE.test(s)) return true
  const lang = profilePromptLanguage(s)
  const turkish = lang === 'tr' || (lang === undefined && /[çğıöşüİ]/i.test(s))
  for (const raw of s.replace(/[.!]+$/, '').split(/[,;:]/)) {
    const clause = raw.trim().replace(RULE_LEAD, '').trim()
    if (clause === '' || CONDITION_LEAD.test(clause) || THANKS.test(clause)) continue
    if (turkish ? trImperativeEnd(clause) : enImperativeStart(clause)) return true
  }
  return false
}

const SIGNATURE_STOP = new Set([
  'always', 'never', 'from', 'now', 'going', 'forward', 'future', 'every', 'time', 'whenever', 'please', 'prefer', 'want', 'need',
  'dont', "don't", 'not', 'ever', 'stop', 'remember', 'keep', 'mind', 'make', 'sure', 'you', 'your', 'zaman', 'daima', 'asla',
  'hicbir', 'bundan', 'sonra', 'boyle', 'artik', 'sakin', 'unutma', 'lutfen', 'tercih', 'ederim', 'istemiyorum', 'bir', 'daha',
  'her', 'icin', 'the', 'and', 'that', 'this', 'with', 'should', 'would',
])

interface Canonical {
  key: string
  text: string
  category: ProfileCategory
  test: RegExp
  unless?: RegExp
  prohibition?: true
  opposite?: { text: string, test: RegExp }
}

function negatedReply(en: string, tr: string): RegExp {
  return uw(new RegExp([
    String.raw`\b(?:never|don'?t|dont|do not|no longer|stop|avoid)(?:,?\s+ever)?,?\s+(?:reply|respond|answer|talk|speak)(?:ing)?(?:\s+(?:to\s+)?me)?\s+in\s+${en}\b`,
    String.raw`${tr}\s+(?:yan[ıi]t|cevap)\s+(?:verme|istemiyorum)\b`,
  ].join('|'), 'i'))
}

const CANONICAL: readonly Canonical[] = [
  {
    key: 'communication.reply_language=tr', text: 'Reply in Turkish', category: 'communication', test: uw(/\b(?:reply|respond|answer|write|talk|speak|explain)\b[^.!?\n]{0,40}\bturkish\b|t[üu]rk[çc]e\s+(?:yan[ıi]t|cevap|yaz|konu[şs]|a[çc][ıi]kla)/i),
    opposite: { text: 'Do not reply in Turkish', test: negatedReply('turkish', 't[üu]rk[çc]e') },
  },
  {
    key: 'communication.reply_language=en', text: 'Reply in English', category: 'communication', test: uw(/\b(?:reply|respond|answer|talk|speak|explain)\b[^.!?\n]{0,40}\benglish\b|[İIi]ngilizce\s+(?:yan[ıi]t|cevap|konu[şs]|a[çc][ıi]kla)/i),
    opposite: { text: 'Do not reply in English', test: negatedReply('english', '[İIi]ngilizce') },
  },
  { key: 'communication.emoji=never', text: 'No emojis in replies or files', category: 'communication', prohibition: true, test: uw(/\b(?:no|without|don'?t use|do not use|never use|stop using)\s+emojis?\b|emoji\s+(?:kullanma|koyma|ekleme)|emojisiz/i) },
  { key: 'communication.length=short', text: 'Keep answers short and to the point', category: 'communication', test: uw(/\b(?:short|concise|brief|terse)\s+(?:answers|replies|responses)\b|\bbe (?:concise|brief)\b|k[ıi]sa\s+(?:yan[ıi]t|cevap|tut)/i) },
  { key: 'autonomy.ask=never', text: 'Work autonomously; do not stop to ask for confirmation', category: 'autonomy', prohibition: true, test: uw(/\b(?:don'?t|do not|no need to|stop)\s+ask(?:ing)?(?:\s+me)?\b|\bbana\s+sorma\b|\bsormana gerek yok\b|\bonay\s+(?:bekleme|isteme)\b/i) },
  { key: 'autonomy.ask=never', text: 'Work autonomously; do not stop to ask for confirmation', category: 'autonomy', test: uw(/\bwithout asking\b|\bsormadan\b/i), unless: uw(/\b(?:never|don'?t|do not|asla|hi[çc]bir zaman|etme|yapma)\b/i) },
  { key: 'autonomy.ask=first', text: 'Ask before acting on anything significant', category: 'autonomy', test: uw(/\b(?:ask|check with)\s+(?:me\s+)?(?:first|before)\b|[öo]nce\s+(?:bana\s+)?sor\b/i) },
  { key: 'quality.tests=always', text: 'Write and run tests for every change', category: 'quality', test: uw(/\b(?:write|add|run)\s+(?:the\s+)?tests?\b|\btdd\b|test(?:leri)?\s+(?:yaz|[çc]al[ıi][şs]t[ıi]r|ko[şs])/i) },
]

const TR_NEGATIVE_VERBS = String.raw`istemiyorum|yapma|etme|kullanma|ekleme|yazma|sorma|de[ğg]i[şs]tirme|silme|koyma|verme|[çc]al[ıi][şs]t[ıi]rma|ko[şs]ma`
const TR_NEGATIVE_VERB = uw(new RegExp(String.raw`(?:^|\s)(?:${TR_NEGATIVE_VERBS})(?=[\s.,!?;:]|$)`, 'i'))
const CANON_NEGATOR = uw(new RegExp(String.raw`\b(?:never|don'?t|dont|do not|does not|doesn'?t|should not|shouldn'?t|must not|mustn'?t|no longer|no more|no need to|avoid|(?:stop|quit)\s+\p{L}+ing)\b|(?<!\bor\s)\bnot\b|(?:^|\s)(?:asla|hi[çc]\s?bir\s+zaman|sak[ıi]n|${TR_NEGATIVE_VERBS})(?=[\s.,!?;:]|$)`, 'iu'))
const LEAD_NEGATOR = uw(/^(?:(?:please|lütfen|lutfen|from now on|going forward|bundan sonra|artık|artik|and|so|also)[\s,]+)*(?:i\s+)?(?:never|don'?t|dont|do not|asla|hi[çc]\s?bir\s+zaman|sak[ıi]n)\b/i)
const DOUBLE_NEGATIVE = uw(/\b(?:never|don'?t|dont|do not|no longer)\s+(?:ever\s+)?(?:stop|quit)\b/i)
const CLAUSE_STOPS = [',', ';', ':']
const WORD_CHAR = /[\p{L}\p{N}_']/u

function negatesClaim(sentence: string, c: Canonical): boolean {
  if (c.prohibition) return DOUBLE_NEGATIVE.test(sentence)
  if (LEAD_NEGATOR.test(sentence)) return true
  const m = c.test.exec(sentence)
  if (!m) return false
  let end = m.index + m[0].length
  while (end < sentence.length && WORD_CHAR.test(sentence.charAt(end))) end++
  const start = Math.max(...CLAUSE_STOPS.map(ch => sentence.lastIndexOf(ch, m.index))) + 1
  const stops = CLAUSE_STOPS.map(ch => sentence.indexOf(ch, end)).filter(i => i >= 0)
  const stop = stops.length > 0 ? Math.min(...stops) : sentence.length
  return CANON_NEGATOR.test(sentence.slice(start, end)) || TR_NEGATIVE_VERB.test(sentence.slice(end, stop))
}

const EXCLUSIVE_GROUPS: readonly string[] = ['communication.reply_language', 'autonomy.ask']

export const PROFILE_INFER_PREFIX = 'infer:'

const PERSONAL_PREFIXES: readonly string[] = ['communication.', 'autonomy.', 'style.', PROFILE_INFER_PREFIX]

const CATEGORY_WORDS: ReadonlyArray<[ProfileCategory, RegExp]> = [
  ['communication', uw(/\b(?:reply|replies|respond|answer|answers|language|english|turkish|emojis?|tone|concise|short|brief|explain|explanations?|format|markdown|tables?|summary|summaries|wording|verbose)\b|\b(?:t[üu]rk[çc]e|ingilizce|yan[ıi]t|cevap|a[çc][ıi]kla|k[ıi]sa|uzun|tablo|[öo]zet|dil)/i)],
  ['autonomy', uw(/\b(?:ask|asking|approval|approve|permission|confirm|confirmation|autonomous|autonomously|check[- ]in|wait|interrupt)\b|\b(?:sor|sorma|sormadan|sormak|sorar|onay[\p{L}]*|izin[\p{L}]*|otonom[\p{L}]*|bekle[\p{L}]*)\b/iu)],
  ['quality', uw(/\b(?:tests?|tdd|verify|verification|lint|typecheck|type-check|review|coverage|quality|regression|evidence)\b|\b(?:do[ğg]rula|kalite|kan[ıi]t)/i)],
  ['workflow', uw(/\b(?:plan|plans|spec|workflow|workflows|commits?|branch|branches|worktrees?|pull request|prs?|push|merge|release|deploy|skills?|mcp)\b|\b(?:dal[ıi]?|birle[şs]tir)\b/i)],
  ['engineering', uw(/\b(?:bun|npm|pnpm|yarn|typescript|javascript|python|go|rust|library|libraries|dependenc(?:y|ies)|framework|code|api|architecture|database|sql|docker|runtime|package)\b|\b(?:k[üu]t[üu]phane|ba[ğg][ıi]ml[ıi]l[ıi]k|kod|mimari)/i)],
]

export function profileCategory(text: string, polarity: 1 | -1 = 1): ProfileCategory {
  if (polarity === -1) return 'avoid'
  for (const [cat, re] of CATEGORY_WORDS) if (re.test(text)) return cat
  return 'other'
}

function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(s => s !== '')
}

function capitalize(s: string): string {
  return s === '' ? s : s.charAt(0).toUpperCase() + s.slice(1)
}

export function profileSignature(text: string): string {
  const words = memQueryWords(text).map(w => normalizeForSearch(w).replace(/[^a-z0-9]/g, '')).filter(w => w.length >= 3 && !SIGNATURE_STOP.has(w))
  return [...new Set(words.map(w => (w.length > 8 ? w.slice(0, 8) : w)))].sort().slice(0, 6).join('-')
}

function statementOf(sentence: string, statements: boolean): ProfileSignal | undefined {
  if (sentence.length < 8 || sentence.length > 400 || NOT_A_RULE.test(sentence)) return undefined
  const lead = TRIGGER_LEAD.test(sentence)
  if (!lead && !(TRIGGER_ANY.test(sentence) && ADDRESSED.test(sentence))) return undefined
  if (!ruleShaped(sentence)) return undefined
  const quote = statements ? { quote: sentence } : {}
  const known = CANONICAL.filter(c => c.test.test(sentence) && !(c.unless?.test(sentence) ?? false))
  const affirmed = known.find(c => !negatesClaim(sentence, c))
  if (affirmed) return { kind: 'statement', key: affirmed.key, category: affirmed.category, text: affirmed.text, ...quote }
  const opposite = known.find(c => c.opposite?.test.test(sentence))
  if (opposite?.opposite) return { kind: 'statement', key: opposite.key, polarity: -1, category: opposite.category, text: opposite.opposite.text, ...quote }
  const polarity: 1 | -1 = known.length > 0 || NEGATIVE.test(sentence) ? -1 : 1
  const signature = profileSignature(sentence)
  if (signature === '') return undefined
  const cleaned = capitalize(sentence.replace(STRIP_LEAD, '').replace(/^[\s,:-]+/, '').replace(PERSONAL_LEAD, (_m, prefer: string | undefined) => (prefer !== undefined ? 'Prefer ' : '')).replace(/[\s.!]+$/, ''))
  const s: ProfileSignal = { kind: 'statement', key: `said:${signature}`, category: profileCategory(cleaned, polarity) }
  if (polarity === -1) s.polarity = -1
  if (statements) { s.text = cleaned; s.quote = sentence }
  return s
}

const CORRECTION = uw(/^(?:no\b|nope\b|wrong\b|that'?s (?:wrong|not (?:right|it|what i))|not like that|undo\b|revert\b|you (?:broke|missed)|hay[ıi]r\b|yanl[ıi][şs]\b|[öo]yle de[ğg]il|bu de[ğg]il|geri al\b|olmad[ıi]\b)/i)
const CONFIRMATION = uw(/^(?:yes\b|yep\b|ok(?:ay)?\b|perfect\b|great\b|looks good|lgtm\b|thanks?\b|thank you|nice\b|exactly\b|evet\b|tamam\b|olur\b|harika\b|s[üu]per\b|m[üu]kemmel\b|te[şs]ekk[üu]rler\b|onayl[ıi]yorum\b|onay\b|g[üu]zel\b)/i)

export function profileSignalsFromPrompt(text: string, opts: { statements?: boolean } = {}): ProfileSignal[] {
  const t = redactClip(text, 4000).text.trim()
  if (t === '' || t.startsWith('<')) return []
  const statements = opts.statements !== false
  const out: ProfileSignal[] = []
  const cmd = /^(?:\/(?:buracle:)?|\$)([a-z][a-z0-9-]{1,40})(?=\s|$)/.exec(t)
  if (cmd && PROFILE_WORKFLOWS.includes(cmd[1] as string)) out.push({ kind: 'usage', key: `usage.workflow=${cmd[1]}`, category: 'workflow', text: cmd[1] as string })
  const body = cmd ? t.slice(cmd[0].length).trim() : t
  const lang = profilePromptLanguage(body)
  if (lang !== undefined) out.push({ kind: 'style', key: `style.prompt_language=${lang}`, category: 'communication' })
  for (const sentence of sentencesOf(body).slice(0, 40)) {
    const s = statementOf(sentence, statements)
    if (s && !out.some(o => o.key === s.key)) out.push(s)
  }
  const head = body.split('\n')[0] ?? ''
  if (CORRECTION.test(head)) out.push({ kind: 'correction', key: 'feedback.correction', category: 'autonomy' })
  else if (CONFIRMATION.test(head)) out.push({ kind: 'confirmation', key: 'feedback.confirmation', category: 'autonomy' })
  return out.slice(0, 12).map(s => profileSanitizeSignal(s) as ProfileSignal)
}

export function profileUsageSignal(what: 'workflow' | 'skill' | 'mcp' | 'command', id: string): ProfileSignal | undefined {
  const v = id.toLowerCase().replace(/^\/?(?:buracle:)?/, '').replace(/[^a-z0-9._-]/g, '').slice(0, 60)
  if (v === '') return undefined
  return { kind: 'usage', key: `usage.${what}=${v}`, category: 'workflow', text: v }
}

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript', cts: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript',
  cjs: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', swift: 'Swift', rb: 'Ruby',
  php: 'PHP', cs: 'C#', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', hpp: 'C++', m: 'Objective-C', scala: 'Scala', ex: 'Elixir',
  exs: 'Elixir', sh: 'Shell', bash: 'Shell', zsh: 'Shell', ps1: 'PowerShell', lua: 'Lua', dart: 'Dart', vue: 'Vue', svelte: 'Svelte',
  sql: 'SQL', zig: 'Zig', hs: 'Haskell', clj: 'Clojure', r: 'R', jl: 'Julia',
}

export function profileLanguageOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? LANGUAGES[base.slice(dot + 1).toLowerCase()] : undefined
}

const TEST_RUNNERS: ReadonlyArray<[RegExp, string]> = [
  [/^bun test\b/, 'bun test'], [/^(?:npx |bunx |pnpm exec |pnpm dlx )?vitest\b/, 'vitest'], [/^(?:npx |bunx )?jest\b/, 'jest'],
  [/^(?:python3? -m )?pytest\b/, 'pytest'], [/^go test\b/, 'go test'], [/^cargo test\b/, 'cargo test'], [/^deno test\b/, 'deno test'],
  [/^npm (?:run )?test\b/, 'npm test'], [/^pnpm (?:run )?test\b/, 'pnpm test'], [/^yarn (?:run )?test\b/, 'yarn test'],
  [/^rspec\b/, 'rspec'], [/^phpunit\b/, 'phpunit'], [/^mix test\b/, 'mix test'], [/^dotnet test\b/, 'dotnet test'],
  [/^(?:\.\/)?gradlew? test\b/, 'gradle test'], [/^mvn test\b/, 'mvn test'], [/^swift test\b/, 'swift test'],
]
const PACKAGE_MANAGERS: ReadonlyArray<[RegExp, string]> = [
  [/^bun (?:install|add|remove|i)\b/, 'bun'], [/^npm (?:install|i|ci|uninstall)\b/, 'npm'], [/^pnpm (?:install|add|i|remove)\b/, 'pnpm'],
  [/^yarn (?:add|install|remove)\b/, 'yarn'], [/^uv (?:add|sync|pip|remove)\b/, 'uv'], [/^pip3? install\b/, 'pip'],
  [/^poetry (?:add|install)\b/, 'poetry'], [/^cargo (?:add|install)\b/, 'cargo'], [/^go (?:get|mod)\b/, 'go modules'],
  [/^bundle (?:install|add)\b/, 'bundler'], [/^composer (?:require|install)\b/, 'composer'],
]

function mcpServerOf(tool: string, servers: readonly string[]): string | undefined {
  const t = tool.toLowerCase()
  for (const s of [...servers].sort((a, b) => b.length - a.length)) {
    const variants = [s, s.replace(/[^a-z0-9_]/g, '_')]
    for (const v of variants) {
      if (t.startsWith(`mcp__${v}__`) || t.startsWith(`mcp__${v}_`) || t.startsWith(`${v}_`) || new RegExp(`^mcp__plugin_[a-z0-9-]+_${v.replace(/[-_]/g, '[-_]')}__`).test(t)) return s
    }
  }
  return undefined
}

export function profileSignalsFromDigest(digest: SpoolDigest, opts: { harness?: string, servers?: readonly string[] } = {}): ProfileSignal[] {
  const out = new Map<string, ProfileSignal>()
  const add = (s: ProfileSignal) => { if (!out.has(s.key)) out.set(s.key, s) }
  for (const f of digest.files) {
    const lang = profileLanguageOf(f)
    if (lang !== undefined) add({ kind: 'environment', key: `env.language=${lang.toLowerCase().replace(/[^a-z0-9+#]/g, '')}`, category: 'engineering', text: lang })
  }
  for (const head of Object.keys(digest.commandHeads ?? {})) {
    for (const [re, name] of TEST_RUNNERS) if (re.test(head)) add({ kind: 'environment', key: `env.test_runner=${name.replace(/\s+/g, '-')}`, category: 'engineering', text: name })
    for (const [re, name] of PACKAGE_MANAGERS) if (re.test(head)) add({ kind: 'environment', key: `env.package_manager=${name.replace(/\s+/g, '-')}`, category: 'engineering', text: name })
  }
  const servers = opts.servers ?? PROFILE_MCP_SERVERS
  for (const tool of Object.keys(digest.toolCounts ?? {})) {
    const server = mcpServerOf(tool, servers)
    if (server !== undefined) add({ kind: 'usage', key: `usage.mcp=${server}`, category: 'workflow', text: server })
  }
  if (opts.harness !== undefined && /^[a-z][a-z0-9-]{0,30}$/.test(opts.harness)) add({ kind: 'usage', key: `usage.harness=${opts.harness}`, category: 'workflow', text: opts.harness })
  return [...out.values()]
}

export interface ProfileEvidence {
  kind: ProfileSignalKind
  key: string
  polarity: 1 | -1
  weight: number
  category?: ProfileCategory
  text?: string
  quote?: string
  events: number
  ts: number
  source: string
  project?: string
  harness?: string
  link?: string
}

export function profileSessionEvidence(signals: ReadonlyArray<{ ts: number, signal: ProfileSignal }>, ctx: { source: string, project?: string, harness?: string }): ProfileEvidence[] {
  const out = new Map<string, ProfileEvidence>()
  for (const { ts, signal } of [...signals].sort((a, b) => a.ts - b.ts)) {
    const polarity = signal.polarity === -1 ? -1 : 1
    const k = `${signal.kind}\0${signal.key}\0${polarity}`
    const prev = out.get(k)
    if (prev) {
      prev.events++
      prev.ts = Math.max(prev.ts, ts)
      if (signal.text !== undefined) prev.text = signal.text
      if (signal.quote !== undefined) prev.quote = signal.quote
      continue
    }
    const e: ProfileEvidence = { kind: signal.kind, key: signal.key, polarity, weight: signal.weight ?? PROFILE_WEIGHTS[signal.kind], events: 1, ts, source: ctx.source }
    if (signal.category !== undefined) e.category = signal.category
    if (signal.text !== undefined) e.text = signal.text
    if (signal.quote !== undefined) e.quote = signal.quote
    if (ctx.project !== undefined) e.project = ctx.project
    if (ctx.harness !== undefined) e.harness = ctx.harness
    out.set(k, e)
  }
  return [...out.values()]
}

export type ProfileConfidence = 'low' | 'medium' | 'high'

export interface ProfileClaim {
  key: string
  text: string
  category: ProfileCategory
  kind: ProfileSignalKind
  support: number
  counter: number
  p: number
  events: number
  sessions: number
  projects: string[]
  harnesses: string[]
  firstSeen: number
  lastSeen: number
  confidence: ProfileConfidence
  explicit: boolean
  inferred: boolean
  local: boolean
  hypothesis: boolean
  contested: boolean
  polarity: 1 | -1
  quote?: string
  links: string[]
}

const DAY = 86_400_000
const KIND_RANK: Readonly<Record<ProfileSignalKind, number>> = { statement: 6, correction: 5, confirmation: 4, inference: 3, style: 3, usage: 2, environment: 1 }

export function profileAggregate(evidence: readonly ProfileEvidence[], nowMs: number, opts: { halfLifeDays?: number } = {}): ProfileClaim[] {
  const half = (opts.halfLifeDays ?? 90) * DAY
  const groups = new Map<string, ProfileEvidence[]>()
  for (const e of evidence) groups.set(e.key, [...(groups.get(e.key) ?? []), e])
  const claims: ProfileClaim[] = []
  for (const [key, list] of groups) {
    const decay = (ts: number) => 0.5 ** (Math.max(0, nowMs - ts) / half)
    let support = 0
    let counter = 0
    for (const e of list) {
      const w = e.weight * Math.min(e.events, 3) * decay(e.ts)
      if (e.polarity === 1) support += w
      else counter += w
    }
    const statements = list.filter(e => e.kind === 'statement').sort((a, b) => b.ts - a.ts)
    const explicit = statements.length > 0
    const newest = statements[0] ?? [...list].sort((a, b) => b.ts - a.ts)[0] as ProfileEvidence
    const polarity: 1 | -1 = explicit ? newest.polarity : support >= counter ? 1 : -1
    if (explicit) {
      support = 0
      counter = 0
      for (const e of statements) {
        const w = e.weight * Math.min(e.events, 3) * decay(e.ts)
        if (e.polarity === polarity) support += w
        else counter += w
      }
    }
    const p = (support + 1) / (support + counter + 2)
    const events = list.reduce((n, e) => n + e.events, 0)
    const sessions = new Set(list.map(e => e.source)).size
    const projects = [...new Set(list.map(e => e.project).filter((x): x is string => x !== undefined))].sort()
    const harnesses = [...new Set(list.map(e => e.harness).filter((x): x is string => x !== undefined))].sort()
    const kind = [...list].sort((a, b) => KIND_RANK[b.kind] - KIND_RANK[a.kind])[0]?.kind ?? 'usage'
    let confidence: ProfileConfidence = 'low'
    if (explicit) {
      const fresh = list.some(e => e.source.startsWith('note:')) ? 1 : decay(newest.ts)
      confidence = fresh >= 0.5 ? 'high' : fresh >= 0.25 ? 'medium' : 'low'
    } else if (events >= 5 && sessions >= 2 && p >= 0.9) confidence = 'high'
    else if (events >= 3 && sessions >= 2 && p >= 0.8) confidence = 'medium'
    const contested = !explicit && sessions >= 2 && p < 0.6
    const text = newest.text ?? list.find(e => e.text !== undefined)?.text ?? key
    const category = newest.category ?? profileCategory(text, polarity)
    const c: ProfileClaim = {
      key, text, category: explicit && polarity === -1 && category !== 'communication' ? 'avoid' : category, kind,
      support: Math.round(support * 100) / 100, counter: Math.round(counter * 100) / 100, p: Math.round(p * 1000) / 1000,
      events, sessions, projects, harnesses,
      firstSeen: Math.min(...list.map(e => e.ts)), lastSeen: Math.max(...list.map(e => e.ts)),
      confidence, explicit, inferred: list.every(e => e.kind === 'inference'), local: projects.length === 1 && list.every(e => e.project !== undefined) && !PERSONAL_PREFIXES.some(p => key.startsWith(p)),
      hypothesis: confidence === 'low' || contested, contested, polarity,
      links: [...new Set(list.map(e => e.link).filter((x): x is string => x !== undefined))],
    }
    const quote = newest.quote
    if (quote !== undefined) c.quote = quote
    claims.push(c)
  }
  for (const group of EXCLUSIVE_GROUPS) {
    const members = claims.filter(c => c.key.startsWith(`${group}=`) && c.explicit && c.polarity === 1)
    if (members.length < 2) continue
    const winner = members.reduce((a, b) => (b.lastSeen > a.lastSeen ? b : a))
    for (const m of members) if (m !== winner) claims.splice(claims.indexOf(m), 1)
  }
  const notes = claims.filter(c => c.key.startsWith('note:'))
  for (const c of [...claims]) {
    if (!c.key.startsWith('said:')) continue
    const twin = notes.find(n => n.polarity === c.polarity && memTitleSimilarity(n.text, c.text) >= 0.6)
    if (!twin) continue
    twin.events += c.events
    twin.sessions += c.sessions
    twin.lastSeen = Math.max(twin.lastSeen, c.lastSeen)
    twin.projects = [...new Set([...twin.projects, ...c.projects])].sort()
    twin.local = twin.local && c.local && twin.projects.length === 1
    claims.splice(claims.indexOf(c), 1)
  }
  return claims.sort((a, b) => Number(b.explicit) - Number(a.explicit) || b.sessions - a.sessions || b.lastSeen - a.lastSeen || a.key.localeCompare(b.key))
}

function bulletText(s: string): string {
  return memOneLine(s).replace(/<!--/g, '<!-').replace(/^[-*]\s+/, '')
}

const HARNESS_NAMES: Readonly<Record<string, string>> = { claude: 'Claude Code', 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'OpenCode', omp: 'Oh My Pi' }
const PLURAL = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function groupedLines(claims: readonly ProfileClaim[]): Array<{ category: ProfileCategory, line: string, confidence: ProfileConfidence }> {
  const out: Array<{ category: ProfileCategory, line: string, confidence: ProfileConfidence }> = []
  const family = (prefix: string) => claims.filter(c => c.key.startsWith(prefix) && c.sessions >= 2).sort((a, b) => b.sessions - a.sessions || a.text.localeCompare(b.text))
  const best = (list: readonly ProfileClaim[]): ProfileConfidence => (list.some(c => c.confidence === 'high') ? 'high' : list.some(c => c.confidence === 'medium') ? 'medium' : 'low')
  const describe = (c: ProfileClaim, showProjects: boolean) => `${c.text} (${PLURAL(c.sessions, 'session')}${showProjects && c.projects.length > 1 ? `, ${PLURAL(c.projects.length, 'project')}` : ''})`
  const push = (category: ProfileCategory, list: ProfileClaim[], lead: string, showProjects = false, max = 5) => {
    if (list.length === 0) return
    out.push({ category, line: `${lead} ${list.slice(0, max).map(c => describe(c, showProjects)).join(', ')}`, confidence: best(list) })
  }
  const languages = claims.filter(c => c.key.startsWith('style.prompt_language='))
  const total = languages.reduce((n, c) => n + c.events, 0)
  const top = [...languages].sort((a, b) => b.events - a.events)[0]
  if (top && total >= 5 && top.events / total >= 0.6) {
    const name = top.key.endsWith('=tr') ? 'Turkish' : 'English'
    out.push({ category: 'communication', line: `Writes to the agents mostly in ${name} (${Math.round((100 * top.events) / total)}% of ${PLURAL(total, 'prompt')})`, confidence: top.events >= 10 ? 'high' : 'medium' })
  }
  push('workflow', family('usage.workflow=').map(c => ({ ...c, text: `/${c.text.replace(/^\//, '')}` })), 'Workflows used most:')
  push('workflow', family('usage.skill='), 'Skills used most:')
  push('workflow', family('usage.mcp='), 'MCP servers used most:')
  const harness = claims.filter(c => c.key.startsWith('usage.harness='))
  const hTotal = harness.reduce((n, c) => n + c.sessions, 0)
  if (hTotal >= 2) {
    const parts = [...harness].sort((a, b) => b.sessions - a.sessions).map(c => `${HARNESS_NAMES[c.text] ?? c.text} (${Math.round((100 * c.sessions) / hTotal)}%)`)
    out.push({ category: 'workflow', line: `Works in ${parts.join(', ')} of ${PLURAL(hTotal, 'session')}`, confidence: hTotal >= 5 ? 'high' : 'medium' })
  }
  push('engineering', family('env.language='), 'Languages:', true)
  push('engineering', family('env.test_runner='), 'Test runners:', true)
  push('engineering', family('env.package_manager='), 'Package managers:', true)
  return out
}

const GROUPED_PREFIXES = ['style.prompt_language=', 'usage.', 'env.']

export interface ProfileFact {
  key: string
  text: string
  category: ProfileCategory
  confidence: ProfileConfidence
  hypothesis: boolean
  explicit: boolean
  inferred?: boolean
  why?: string
  rank: number
  events: number
  sessions: number
  lastSeen: number
  project?: string
}

export function profileFacts(claims: readonly ProfileClaim[]): ProfileFact[] {
  const out: ProfileFact[] = []
  const individual = claims.filter(c => !GROUPED_PREFIXES.some(p => c.key.startsWith(p)) && !c.key.startsWith('feedback.') && c.text !== c.key)
  for (const c of individual) {
    const f: ProfileFact = {
      key: c.key, text: bulletText(c.text), category: c.category, confidence: c.confidence, hypothesis: c.hypothesis, explicit: c.explicit,
      rank: c.local && c.projects.length === 1 ? 3 : c.hypothesis ? 4 : c.explicit ? 0 : 1, events: c.events, sessions: c.sessions, lastSeen: c.lastSeen,
    }
    if (c.inferred) {
      f.inferred = true
      if (c.quote !== undefined) f.why = c.quote
    }
    if (c.local && c.projects.length === 1) f.project = c.projects[0] as string
    out.push(f)
  }
  const families: Array<[string, string]> = [
    ['Writes to the agents', 'group:prompt-language'], ['Workflows used most', 'group:workflows'], ['Skills used most', 'group:skills'],
    ['MCP servers used most', 'group:mcp'], ['Works in', 'group:harnesses'], ['Languages', 'group:languages'],
    ['Test runners', 'group:test-runners'], ['Package managers', 'group:package-managers'],
  ]
  for (const g of groupedLines(claims)) {
    const key = families.find(([lead]) => g.line.startsWith(lead))?.[1] ?? `group:${g.line.slice(0, 20)}`
    out.push({ key, text: g.line, category: g.category, confidence: g.confidence, hypothesis: g.confidence === 'low', explicit: false, rank: 2, events: 0, sessions: 0, lastSeen: 0 })
  }
  const corrections = claims.find(c => c.key === 'feedback.correction')
  const confirmations = claims.find(c => c.key === 'feedback.confirmation')
  if (corrections || confirmations) {
    const parts = [corrections ? `${PLURAL(corrections.events, 'correction')} in ${PLURAL(corrections.sessions, 'session')}` : undefined, confirmations ? `${PLURAL(confirmations.events, 'confirmation')} in ${PLURAL(confirmations.sessions, 'session')}` : undefined].filter(Boolean)
    out.push({ key: 'group:feedback', text: `Feedback so far: ${parts.join('; ')}`, category: 'other', confidence: 'low', hypothesis: true, explicit: false, rank: 5, events: 0, sessions: 0, lastSeen: 0 })
  }
  return out
}

export interface ProfileInference {
  text: string
  category?: ProfileCategory
  why?: string
  same?: string
  against?: string
}

export const PROFILE_INFERENCES_MAX = 3

export function profileInferenceEvidence(inferences: readonly ProfileInference[], ctx: { ts: number, source: string, project?: string, harness?: string, known: ReadonlyArray<{ key: string, text: string }> }): ProfileEvidence[] {
  const inferred = ctx.known.filter(k => k.key.startsWith(PROFILE_INFER_PREFIX))
  const other = ctx.known.filter(k => !k.key.startsWith(PROFILE_INFER_PREFIX))
  const out = new Map<string, ProfileEvidence>()
  for (const inf of inferences.slice(0, PROFILE_INFERENCES_MAX)) {
    const text = clipText(inf.text)
    if (text.length < 8) continue
    const against = inf.against !== undefined ? inferred.find(k => k.key === inf.against) : undefined
    const same = against === undefined ? inferred.find(k => k.key === inf.same) ?? inferred.find(k => memTitleSimilarity(k.text, text) >= 0.6) : undefined
    if (against === undefined && same === undefined && other.some(k => memTitleSimilarity(k.text, text) >= 0.6)) continue
    const target = against ?? same
    const sig = profileSignature(text)
    if (target === undefined && sig === '') continue
    const key = target?.key ?? `${PROFILE_INFER_PREFIX}${sig}`.slice(0, 120)
    if (out.has(key)) continue
    const e: ProfileEvidence = {
      kind: 'inference', key, polarity: against !== undefined ? -1 : 1, weight: PROFILE_WEIGHTS.inference, events: 1, ts: ctx.ts, source: ctx.source,
      category: inf.category ?? profileCategory(text), text: against?.text ?? text,
    }
    if (inf.why !== undefined && inf.why.trim() !== '') e.quote = clipText(inf.why)
    if (ctx.project !== undefined) e.project = ctx.project
    if (ctx.harness !== undefined) e.harness = ctx.harness
    out.set(key, e)
  }
  return [...out.values()]
}
