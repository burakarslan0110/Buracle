import { memQueryWords } from './query'
import { memOneLine, normalizeForSearch, redactClip } from './text'

// The deterministic reading of what a user says about how they want to work ("always", "never", "from now on",
// a reply-language request, ...). The prompt hook (H26) only appends the result to the spool; the session-end
// finalizer turns each statement into a person-layer preference memory. No model is involved.

export type ProfileCategory = 'communication' | 'autonomy' | 'engineering' | 'workflow' | 'quality' | 'avoid' | 'other'

export interface PromptSignal {
  kind: 'statement'
  key: string
  polarity?: 1 | -1
  category?: ProfileCategory
  text?: string
  quote?: string
}

export const PROFILE_CATEGORIES: readonly ProfileCategory[] = ['communication', 'autonomy', 'engineering', 'workflow', 'quality', 'avoid', 'other']

export const PROFILE_QUOTE_MAX = 160
const KEY_RE = /^[a-z][a-z0-9_.:=+#/-]{0,119}$/

const WORD_EDGE = String.raw`(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))`

function uw(re: RegExp): RegExp {
  return new RegExp(re.source.split('\\b').join(WORD_EDGE), re.flags.includes('u') ? re.flags : `${re.flags}u`)
}

function clipText(s: string, scrub?: (s: string, max: number) => string): string {
  const one = memOneLine(s)
  return scrub ? scrub(one, PROFILE_QUOTE_MAX) : redactClip(one, PROFILE_QUOTE_MAX).text
}

export function sanitizePromptSignal(x: unknown, scrub?: (s: string, max: number) => string): PromptSignal | undefined {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) return undefined
  const o = x as Record<string, unknown>
  const key = o['key']
  if (o['kind'] !== 'statement') return undefined
  if (typeof key !== 'string' || !KEY_RE.test(key)) return undefined
  const s: PromptSignal = { kind: 'statement', key }
  if (o['polarity'] === -1) s.polarity = -1
  const c = o['category']
  if (typeof c === 'string' && (PROFILE_CATEGORIES as readonly string[]).includes(c)) s.category = c as ProfileCategory
  if (typeof o['text'] === 'string' && o['text'].trim() !== '') s.text = clipText(o['text'], scrub)
  if (typeof o['quote'] === 'string' && o['quote'].trim() !== '') s.quote = clipText(o['quote'], scrub)
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

/** The mutually exclusive group a canonical key belongs to ("communication.reply_language"), if any. */
export function signalGroup(key: string): string | undefined {
  return EXCLUSIVE_GROUPS.find(g => key.startsWith(`${g}=`))
}

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

function statementOf(sentence: string): PromptSignal | undefined {
  if (sentence.length < 8 || sentence.length > 400 || NOT_A_RULE.test(sentence)) return undefined
  const lead = TRIGGER_LEAD.test(sentence)
  if (!lead && !(TRIGGER_ANY.test(sentence) && ADDRESSED.test(sentence))) return undefined
  if (!ruleShaped(sentence)) return undefined
  const quote = { quote: sentence }
  const known = CANONICAL.filter(c => c.test.test(sentence) && !(c.unless?.test(sentence) ?? false))
  const affirmed = known.find(c => !negatesClaim(sentence, c))
  if (affirmed) return { kind: 'statement', key: affirmed.key, category: affirmed.category, text: affirmed.text, ...quote }
  const opposite = known.find(c => c.opposite?.test.test(sentence))
  if (opposite?.opposite) return { kind: 'statement', key: opposite.key, polarity: -1, category: opposite.category, text: opposite.opposite.text, ...quote }
  const polarity: 1 | -1 = known.length > 0 || NEGATIVE.test(sentence) ? -1 : 1
  const signature = profileSignature(sentence)
  if (signature === '') return undefined
  const cleaned = capitalize(sentence.replace(STRIP_LEAD, '').replace(/^[\s,:-]+/, '').replace(PERSONAL_LEAD, (_m, prefer: string | undefined) => (prefer !== undefined ? 'Prefer ' : '')).replace(/[\s.!]+$/, ''))
  const s: PromptSignal = { kind: 'statement', key: `said:${signature}`, category: profileCategory(cleaned, polarity), text: cleaned, quote: sentence }
  if (polarity === -1) s.polarity = -1
  return s
}

export function promptSignals(text: string): PromptSignal[] {
  const t = redactClip(text, 4000).text.trim()
  if (t === '' || t.startsWith('<')) return []
  const cmd = /^(?:\/(?:buracle:)?|\$)([a-z][a-z0-9-]{1,40})(?=\s|$)/.exec(t)
  const body = cmd ? t.slice(cmd[0].length).trim() : t
  const out: PromptSignal[] = []
  for (const sentence of sentencesOf(body).slice(0, 40)) {
    const s = statementOf(sentence)
    if (s && !out.some(o => o.key === s.key)) out.push(s)
  }
  return out.slice(0, 12).map(s => sanitizePromptSignal(s) as PromptSignal)
}

