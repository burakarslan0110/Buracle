import { describe, expect, test } from 'bun:test'
import {
  profileCategory, profileSignature, PROFILE_QUOTE_MAX, promptSignals, sanitizePromptSignal, signalGroup,
} from '../../../src/core/memory/signals'

// The prompt hook (H26) reads no statements from word lists any more (PRD follow-up 2026-11-06): a lasting
// preference, in any language, is written by the agent at once, or proposed by the session-end model call
// with the user's own words. promptSignals keeps its contract and gives nothing.

describe('promptSignals: no word lists', () => {
  test('standing rules in any language give no signal', () => {
    for (const t of ['Always run the tests before you commit.', 'Bundan sonra her zaman Türkçe yanıt ver.', 'Never use emojis.', 'Schreib Commit-Nachrichten ab jetzt immer auf Deutsch.', 'refactor the parser', '']) {
      expect({ t, signals: promptSignals(t) }).toEqual({ t, signals: [] })
    }
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
})

describe('profile helpers', () => {
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
