import { memQueryWords } from './query'
import { memOneLine, normalizeForSearch, redactClip } from './text'

// The prompt signals of H26 and the helpers the person brain uses to file preferences. Since PRD follow-up
// 2026-11-06 no word list reads statements from the user's prompt: a lasting preference, in any language, is
// written by the agent at once (memory rule), or proposed by the session-end model call with the user's own
// words. The signal type and its sanitizer stay for spools written before that change.

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

const SIGNATURE_STOP = new Set([
  'always', 'never', 'from', 'now', 'going', 'forward', 'future', 'every', 'time', 'whenever', 'please', 'prefer', 'want', 'need',
  'dont', "don't", 'not', 'ever', 'stop', 'remember', 'keep', 'mind', 'make', 'sure', 'you', 'your', 'zaman', 'daima', 'asla',
  'hicbir', 'bundan', 'sonra', 'boyle', 'artik', 'sakin', 'unutma', 'lutfen', 'tercih', 'ederim', 'istemiyorum', 'bir', 'daha',
  'her', 'icin', 'the', 'and', 'that', 'this', 'with', 'should', 'would',
])

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

export function profileSignature(text: string): string {
  const words = memQueryWords(text).map(w => normalizeForSearch(w).replace(/[^a-z0-9]/g, '')).filter(w => w.length >= 3 && !SIGNATURE_STOP.has(w))
  return [...new Set(words.map(w => (w.length > 8 ? w.slice(0, 8) : w)))].sort().slice(0, 6).join('-')
}

/** H26's signals from a prompt: none. The contract stays for the hooks that still call it. */
export function promptSignals(text: string): PromptSignal[] {
  void text
  return []
}
