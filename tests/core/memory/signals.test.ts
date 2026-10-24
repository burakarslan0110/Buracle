import { describe, expect, test } from 'bun:test'
import {
  profileCategory, profilePromptLanguage, profileSignature, PROFILE_QUOTE_MAX, promptSignals, sanitizePromptSignal, signalGroup,
} from '../../../src/core/memory/signals'

// The contract of the prompt hook (H26): which sentences a user says count as a standing statement about how they
// want to work, and what the spool keeps of them. Nothing else a prompt says becomes a signal.

const keys = (text: string) => promptSignals(text).map(s => s.key)
const statement = (text: string) => promptSignals(text)[0]

describe('promptSignals: explicit statements', () => {
  test('standing rules in English and Turkish become statements with a short quote', () => {
    expect(promptSignals('From now on, always run the tests before you commit.')).toEqual([
      { kind: 'statement', key: 'quality.tests=always', category: 'quality', text: 'Write and run tests for every change', quote: 'From now on, always run the tests before you commit.' },
    ])
    expect(promptSignals('Bundan sonra her zaman Türkçe yanıt ver lütfen.')).toEqual([
      { kind: 'statement', key: 'communication.reply_language=tr', category: 'communication', text: 'Reply in Turkish', quote: 'Bundan sonra her zaman Türkçe yanıt ver lütfen.' },
    ])
    expect(statement('Her zaman kısa cevap ver.')).toMatchObject({ key: 'communication.length=short', category: 'communication' })
  })

  test('reply-language requests map to one key per language', () => {
    expect(statement('Always reply in English.')).toMatchObject({ key: 'communication.reply_language=en', text: 'Reply in English' })
    expect(statement('Always reply in Turkish.')).toMatchObject({ key: 'communication.reply_language=tr', text: 'Reply in Turkish' })
    expect(statement('Bundan sonra her zaman İngilizce yanıt ver.')).toMatchObject({ key: 'communication.reply_language=en' })
  })

  test('"don\'t use emojis" is the no-emoji preference once it is said as a standing rule', () => {
    for (const text of ["From now on don't use emojis.", 'Never use emojis.', 'Asla emoji kullanma.']) {
      expect({ text, signal: statement(text) }).toMatchObject({ text, signal: { key: 'communication.emoji=never', text: 'No emojis in replies or files' } })
    }
    expect(statement('Never use emojis.')?.polarity).toBeUndefined()
  })

  test('a rule that is not a known preference keeps its own wording under a word-order-free key', () => {
    const a = statement('Never push without asking me.')
    const b = statement('Please, without asking, never push.')
    expect(a).toMatchObject({ polarity: -1, category: 'avoid', text: 'Never push without asking me' })
    expect(a?.key).toMatch(/^said:/)
    expect(a?.key).toBe(b?.key)
    expect(statement('I prefer pnpm over npm for this repo.')).toMatchObject({ text: 'Prefer pnpm over npm for this repo', category: 'engineering' })
  })

  test('"without asking" is autonomy only when nothing forbids the action', () => {
    expect(keys('From now on just fix lint errors without asking.')).toContain('autonomy.ask=never')
    expect(keys('asla sormadan push etme')).not.toContain('autonomy.ask=never')
    expect(keys("From now on don't ask me, just fix it.")).toEqual(['autonomy.ask=never'])
  })

  test('standing rules in their usual shapes count', () => {
    const rules = [
      'Whenever you change the schema, run the migrations.',
      'Every time you finish a task, update the changelog.',
      'Bundan sonra testleri hep sen çalıştır.',
      'Bundan sonra bun kullanalım.',
      'Unutma, commit mesajları İngilizce olsun.',
      'From now on use bun instead of npm.',
      'Going forward we should squash merge.',
      'You should always run the linter.',
      "I don't want emojis in commits, please.",
      'Always fix lint errors before committing.',
      'Never ignore a failing test.',
      'Her zaman kısa cevap ver.',
      'Artık her değişiklikte testleri çalıştırmalısın.',
    ]
    for (const text of rules) expect({ text, rule: promptSignals(text).length > 0 }).toEqual({ text, rule: true })
  })

  test('questions, bug reports, thanks and status remarks are never rules, whatever trigger word they carry', () => {
    const notRules = [
      'Artık çalışıyor, teşekkürler.',
      'Artık bu hata çıkmıyor.',
      'Her zaman aynı hatayı veriyor.',
      'Bundan sonra ne yapacağız?',
      'Bundan sonra bunu mu yapalım',
      'Every time I run the build it crashes.',
      'Whenever I open the page, the console shows an error.',
      'Whenever you click save, it throws.',
      'Why does it always fail on CI?',
      'Can you always add the tests',
      'Thanks, from now on it works.',
      'From now on, the tests are green.',
      'You always forget the tests.',
      'Never had this problem before.',
      'Always the same error!',
      'Never works on the first try.',
      'Going forward the build is faster.',
      'Unutma, dün de aynı şey olmuştu.',
      'The tests always fail on CI.',
    ]
    for (const text of notRules) expect({ text, statements: promptSignals(text) }).toEqual({ text, statements: [] })
  })

  test('"never mind", envelopes and empty text give nothing', () => {
    expect(promptSignals('Never mind, skip it.')).toEqual([])
    expect(promptSignals('nevermind, always the same')).toEqual([])
    expect(promptSignals('<task-notification>always do x</task-notification>')).toEqual([])
    expect(promptSignals('   ')).toEqual([])
    expect(promptSignals('')).toEqual([])
  })

  test('only statements are signals: workflow commands, corrections, confirmations and the prompt language leave nothing', () => {
    for (const text of [
      '/plan-build add a login page', '/buracle:bugfix the flaky test', '$research which queue to use', '/clear',
      'Hayır, yanlış. Öyle değil.', 'No, that is wrong, use the other table.', 'evet tamam, devam', 'LGTM, ship it',
      'Bu projede testleri çalıştır', 'Please explain how the cache works',
    ]) expect({ text, signals: promptSignals(text) }).toEqual({ text, signals: [] })
  })

  test('a leading command is not part of the sentence: the statement after it still counts', () => {
    expect(statement('/buracle:bugfix from now on never push to main')).toMatchObject({ polarity: -1, text: 'Never push to main' })
    expect(statement('$research always cite sources')).toMatchObject({ text: 'Always cite sources' })
  })

  test('several sentences give several statements, the same statement is kept once, and a prompt gives at most 12', () => {
    expect(keys('Always reply in English. Never use emojis. The build is red.')).toEqual(['communication.reply_language=en', 'communication.emoji=never'])
    expect(promptSignals('Always use bun. Always use bun.')).toHaveLength(1)
    expect(keys('Never push\nAlways use bun')).toHaveLength(2)
    const many = Array.from({ length: 20 }, (_, i) => `Always use tool${i} for step${i}.`).join(' ')
    expect(promptSignals(many)).toHaveLength(12)
  })

  test('every statement is already in its sanitized form', () => {
    for (const text of ['From now on, never write tests for throwaway scripts.', 'Always reply in Turkish, never in English.', 'Never reply in Turkish.', 'I prefer pnpm over npm for this repo.']) {
      for (const s of promptSignals(text)) {
        expect(s.kind).toBe('statement')
        expect(sanitizePromptSignal(s)).toEqual(s)
      }
    }
  })
})

describe('promptSignals: negation', () => {
  test('a negated reply-language rule never becomes the rule it negates; it maps to its explicit opposite', () => {
    for (const text of ['Never reply in Turkish.', 'Never, ever reply in Turkish.', "Please don't ever respond in Turkish.", 'Asla Türkçe yanıt verme.', 'Bundan sonra Türkçe cevap verme.', 'Bundan sonra Türkçe cevap istemiyorum.']) {
      expect({ text, signal: statement(text) }).toMatchObject({ text, signal: { key: 'communication.reply_language=tr', polarity: -1, category: 'communication', text: 'Do not reply in Turkish' } })
    }
    expect(statement("Please don't ever reply in English.")).toMatchObject({ key: 'communication.reply_language=en', polarity: -1, text: 'Do not reply in English' })
    expect(statement('Bundan sonra İngilizce yanıt verme.')).toMatchObject({ key: 'communication.reply_language=en', polarity: -1, text: 'Do not reply in English' })
  })

  test('a negated rule with a narrower scope keeps the user\'s own words with negative polarity', () => {
    const tests = statement('From now on, never write tests for throwaway scripts.')
    expect(tests).toMatchObject({ polarity: -1, category: 'avoid', text: 'Never write tests for throwaway scripts' })
    expect(tests?.key).toMatch(/^said:/)
    const ask = statement('Never ask me before running the tests.')
    expect(ask).toMatchObject({ polarity: -1, category: 'avoid', text: 'Never ask me before running the tests' })
    expect(ask?.key).toMatch(/^said:/)
    const tr = statement('Bundan sonra testleri çalıştırma.')
    expect(tr).toMatchObject({ polarity: -1, category: 'avoid' })
    expect(tr?.key).toMatch(/^said:/)
    const comments = statement('Always write code comments in English, never in Turkish.')
    expect(comments?.key).toMatch(/^said:/)
    expect(comments?.polarity).toBe(-1)
  })

  test('a contrast keeps the claim it affirms', () => {
    const tr = statement('Always reply in Turkish, never in English.')
    expect(tr).toMatchObject({ key: 'communication.reply_language=tr', text: 'Reply in Turkish' })
    expect(tr?.polarity).toBeUndefined()
    expect(statement('From now on reply in English, never in Turkish.')).toMatchObject({ key: 'communication.reply_language=en', text: 'Reply in English' })
    expect(statement('Her zaman Türkçe yanıt ver, İngilizce yazma.')).toMatchObject({ key: 'communication.reply_language=tr', text: 'Reply in Turkish' })
    expect(statement('Always run the tests so we do not break main.')).toMatchObject({ key: 'quality.tests=always' })
    expect(statement('Always run the tests, even if it is not required.')).toMatchObject({ key: 'quality.tests=always' })
  })

  test('a double negative does not flip into a prohibition', () => {
    const twice = statement('Never stop asking me before you push.')
    expect(twice).toMatchObject({ polarity: -1, text: 'Never stop asking me before you push' })
    expect(twice?.key).toMatch(/^said:/)
  })
})

describe('promptSignals: privacy', () => {
  test('secrets and private text never survive into a quote or a text', () => {
    const s = promptSignals('From now on always use this key: sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 <private>my secret plan</private>')
    expect(s).toHaveLength(1)
    const json = JSON.stringify(s)
    expect(json).not.toContain('sk-ant-abcdef')
    expect(json).not.toContain('my secret plan')
    expect(s[0]?.quote).toContain('[REDACTED')
  })

  test('the quote and the text are clipped to PROFILE_QUOTE_MAX', () => {
    const s = statement(`From now on never deploy on ${'Fridays '.repeat(30)}ok.`)
    expect(s?.quote).toHaveLength(PROFILE_QUOTE_MAX)
    expect(s?.text?.length).toBeLessThanOrEqual(PROFILE_QUOTE_MAX)
    expect(PROFILE_QUOTE_MAX).toBe(160)
  })

  test('a sentence of more than 400 characters is not a statement', () => {
    expect(promptSignals(`From now on never deploy on ${'Fridays '.repeat(80)}ok.`)).toEqual([])
  })
})

describe('sanitizePromptSignal', () => {
  test('keeps the contract fields only and clips the wording to one short line', () => {
    const s = sanitizePromptSignal({ kind: 'statement', key: 'said:a-b', polarity: -1, weight: 99, category: 'avoid', text: 'x'.repeat(500), quote: 'line one\nline two', extra: 1 })
    expect(s).toEqual({ kind: 'statement', key: 'said:a-b', polarity: -1, category: 'avoid', text: s?.text, quote: 'line one line two' })
    expect(s?.text).toHaveLength(PROFILE_QUOTE_MAX)
    expect(sanitizePromptSignal({ kind: 'statement', key: 'communication.emoji=never' })).toEqual({ kind: 'statement', key: 'communication.emoji=never' })
  })

  test('rejects anything that is not a statement with a well-formed key', () => {
    for (const bad of [
      undefined, null, 'statement', 42, [], [{ kind: 'statement', key: 'said:a-b' }],
      { kind: 'telepathy', key: 'x' }, { kind: 'usage', key: 'usage.mcp=x' }, { kind: 'style', key: 'style.prompt_language=en' },
      { kind: 'correction', key: 'feedback.correction' }, { key: 'said:a-b' },
      { kind: 'statement' }, { kind: 'statement', key: 42 }, { kind: 'statement', key: 'Bad Key' }, { kind: 'statement', key: '' },
      { kind: 'statement', key: 'x'.repeat(121) },
    ]) expect({ bad, out: sanitizePromptSignal(bad) }).toEqual({ bad, out: undefined })
  })

  test('only polarity -1, a known category and non-blank wording are kept', () => {
    const s = sanitizePromptSignal({ kind: 'statement', key: 'said:a-b', polarity: 1, category: 'sometimes', text: '   ', quote: '' })
    expect(s).toEqual({ kind: 'statement', key: 'said:a-b' })
    expect(sanitizePromptSignal({ kind: 'statement', key: 'said:a-b', polarity: 0 })).not.toHaveProperty('polarity')
    expect(sanitizePromptSignal({ kind: 'statement', key: 'said:a-b', category: 'workflow' })?.category).toBe('workflow')
  })

  test('the scrubber the spool passes sees both pieces of wording', () => {
    const seen: Array<[string, number]> = []
    const out = sanitizePromptSignal({ kind: 'statement', key: 'said:a-b', text: 'Never  deploy', quote: 'never deploy\nfriday' }, (s, max) => { seen.push([s, max]); return s.toUpperCase() })
    expect(out).toMatchObject({ text: 'NEVER DEPLOY', quote: 'NEVER DEPLOY FRIDAY' })
    expect(seen.map(([, max]) => max)).toEqual([PROFILE_QUOTE_MAX, PROFILE_QUOTE_MAX])
  })
})

describe('signalGroup', () => {
  test('the reply languages are one group and the ask preferences another; everything else is its own', () => {
    expect(signalGroup('communication.reply_language=tr')).toBe('communication.reply_language')
    expect(signalGroup('communication.reply_language=en')).toBe('communication.reply_language')
    expect(signalGroup('autonomy.ask=never')).toBe('autonomy.ask')
    expect(signalGroup('autonomy.ask=first')).toBe('autonomy.ask')
    expect(signalGroup('communication.emoji=never')).toBeUndefined()
    expect(signalGroup('quality.tests=always')).toBeUndefined()
    expect(signalGroup('said:push-never')).toBeUndefined()
    expect(signalGroup('communication.reply_language')).toBeUndefined()
  })

  test('the keys promptSignals gives for opposite requests land in the same group', () => {
    const group = (text: string) => signalGroup(statement(text)?.key ?? '')
    expect(group('Always reply in Turkish.')).toBe(group('Always reply in English.'))
    expect(group('Never reply in Turkish.')).toBe('communication.reply_language')
  })
})

describe('profile helpers', () => {
  test('the prompt language needs a few words; capital I is English', () => {
    expect(profilePromptLanguage('Bu projede testleri her zaman çalıştır')).toBe('tr')
    expect(profilePromptLanguage('I WANT YOU TO RUN THE TESTS')).toBe('en')
    expect(profilePromptLanguage('ok go')).toBeUndefined()
  })

  test('a negative statement is always "avoid"; otherwise the category follows the topic', () => {
    expect(profileCategory('Never deploy on Fridays', -1)).toBe('avoid')
    expect(profileCategory('Reply in a concise tone')).toBe('communication')
    expect(profileCategory('Run the tests and verify the result')).toBe('quality')
    expect(profileCategory('Banana')).toBe('other')
  })

  test('the signature ignores word order, filler and trigger words', () => {
    expect(profileSignature('Never push without asking me')).toBe(profileSignature('Please, without asking, never push'))
    expect(profileSignature('always never please')).toBe('')
  })
})
