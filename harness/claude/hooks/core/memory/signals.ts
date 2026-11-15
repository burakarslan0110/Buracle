// The categories a person-layer preference is filed under, and the word list that guesses one from a title.

export type ProfileCategory = 'communication' | 'autonomy' | 'engineering' | 'workflow' | 'quality' | 'avoid' | 'other'

export const PROFILE_CATEGORIES: readonly ProfileCategory[] = ['communication', 'autonomy', 'engineering', 'workflow', 'quality', 'avoid', 'other']

const WORD_EDGE = String.raw`(?:(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_])|(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_]))`

function uw(re: RegExp): RegExp {
  return new RegExp(re.source.split('\\b').join(WORD_EDGE), re.flags.includes('u') ? re.flags : `${re.flags}u`)
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

