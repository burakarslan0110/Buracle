import { describe, expect, test } from 'bun:test'
import { SPOOL_LIMITS, spoolDigest, spoolFileMatches, spoolFileName, spoolIsEmptySession, spoolParse, spoolSanitize, type SpoolEntry } from '../../../src/core/memory/spool'

describe('spoolSanitize', () => {
  test('keeps contract fields, drops the rest, rejects invalid entries', () => {
    const { entry } = spoolSanitize({ ts: 1.6, ev: 'compact', tool: 'auto', excerpt: 'summary', kind: 'bash', cmd: 'ls', exit: 0, ms: 3.2, prompt: 'raw prompt!', output: 'raw output' })
    expect(entry).toEqual({ ts: 2, ev: 'compact', tool: 'auto', excerpt: 'summary' })
    expect(spoolSanitize({ ev: 'turn' }).entry).toBeUndefined()
    expect(spoolSanitize({ ts: 1, ev: 'weird' }).entry).toBeUndefined()
    expect(spoolSanitize('nope').entry).toBeUndefined()
  })

  test('a tool call is not a spool entry any more: the capture keeps prompts and turns, and git lists the files', () => {
    expect(spoolSanitize({ ts: 1, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'ls', exit: 0 }).entry).toBeUndefined()
    expect(spoolParse('{"ts":1,"ev":"tool","tool":"Edit","kind":"edit","paths":["/repo/a.ts"]}\n{"ts":2,"ev":"stop","excerpt":"bye"}\n')).toEqual([{ ts: 2, ev: 'stop', excerpt: 'bye' }])
  })

  test('keeps the user\'s prompt text redacted and clipped for the distillation, never tool output', () => {
    expect(spoolSanitize({ ts: 1, ev: 'prompt', excerpt: 'my prompt', tokens: 40 }).entry).toEqual({ ts: 1, ev: 'prompt', excerpt: 'my prompt', tokens: 40 })
    expect(spoolSanitize({ ts: 1, ev: 'prompt', excerpt: 'deploy with <private>hunter2</private> now' }).entry?.excerpt).toBe('deploy with [REDACTED:private] now')
    expect(spoolSanitize({ ts: 1, ev: 'prompt', excerpt: 'word '.repeat(500) }).entry?.excerpt?.length).toBe(SPOOL_LIMITS.promptExcerpt)
    expect(spoolSanitize({ ts: 1, ev: 'prompt-signal', signal: { kind: 'statement', key: 'said:x-y' }, excerpt: 'tool output' }).entry).toEqual({ ts: 1, ev: 'prompt-signal', signal: { kind: 'statement', key: 'said:x-y' } })
    expect(spoolSanitize({ ts: 1, ev: 'note', excerpt: 'm-20261008-abcd' }).entry?.excerpt).toBe('m-20261008-abcd')
  })

  test('redacts excerpts and reports it', () => {
    const r = spoolSanitize({ ts: 1, ev: 'turn', excerpt: 'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx1234 and token ghp_0123456789abcdefghijABCDEFGHIJ012345' })
    expect(r.entry?.excerpt).toBe('export OPENAI_API_KEY=[REDACTED:openai] and token [REDACTED:github]')
    expect(r.redactions).toEqual({ count: 2, kinds: ['github', 'openai'] })
  })

  test('caps excerpts (8,000 for compact entries) and paths', () => {
    const long = 'word '.repeat(5000)
    expect(spoolSanitize({ ts: 1, ev: 'turn', excerpt: long }).entry?.excerpt?.length).toBe(SPOOL_LIMITS.excerpt)
    expect(spoolSanitize({ ts: 1, ev: 'compact', excerpt: long }).entry?.excerpt?.length).toBe(SPOOL_LIMITS.compactExcerpt)
    const paths = Array.from({ length: 80 }, (_, i) => `/p/${i}`)
    expect(spoolSanitize({ ts: 1, ev: 'note', paths }).entry?.paths?.length).toBe(SPOOL_LIMITS.paths)
  })
})

describe('spool files', () => {
  test('parse skips torn and invalid lines', () => {
    const text = '{"ts":1,"ev":"prompt"}\n{"ts":2,"ev":"turn","excerpt":"torn"\nnot json\n\n{"ts":3,"ev":"stop","excerpt":"bye"}\n'
    expect(spoolParse(text)).toEqual([{ ts: 1, ev: 'prompt' }, { ts: 3, ev: 'stop', excerpt: 'bye' }])
  })

  test('file names and matching', () => {
    expect(spoolFileName('claude', 'abc')).toBe('claude-abc.jsonl')
    expect(spoolFileName('claude', 'abc', 'turn/7')).toBe('claude-abc-turn_7.jsonl')
    expect(spoolFileMatches('claude-abc.jsonl', 'claude', 'abc')).toBe(true)
    expect(spoolFileMatches('claude-abc-t1.jsonl', 'claude', 'abc')).toBe(true)
    expect(spoolFileMatches('claude-abcd.jsonl', 'claude', 'abc')).toBe(false)
    expect(spoolFileMatches('codex-abc.jsonl', 'claude', 'abc')).toBe(false)
    expect(spoolFileMatches('claude-abc.json', 'claude', 'abc')).toBe(false)
  })
})

describe('spoolDigest', () => {
  test('derives the prompts, the turns, the compactions, the notes and the final message', () => {
    const entries: SpoolEntry[] = [
      { ts: 50, ev: 'stop', excerpt: 'final words' },
      { ts: 10, ev: 'prompt' },
      { ts: 40, ev: 'compact', tool: 'auto', excerpt: 'summary one' },
      { ts: 45, ev: 'turn', excerpt: 'older message', model: 'claude-opus-5-5', tokens: 100 },
      { ts: 46, ev: 'note', excerpt: 'm-20261008-abcd' },
    ]
    const d = spoolDigest(entries)
    expect(d.startedMs).toBe(10)
    expect(d.endedMs).toBe(50)
    expect(d.compactions).toEqual([{ ts: 40, trigger: 'auto', summary: 'summary one' }])
    expect(d.finalMessage).toBe('final words')
    expect(d.model).toBe('claude-opus-5-5')
    expect(d.tokens).toBe(100)
    expect(d.turns).toBe(1)
    expect(d.prompts).toBe(1)
    expect(d.notes).toEqual(['m-20261008-abcd'])
    expect(Object.keys(d).sort()).toEqual(['compactions', 'endedMs', 'finalMessage', 'model', 'notes', 'prompts', 'signals', 'startedMs', 'tokens', 'turns', 'userPrompts'])
  })

  test('the digest keeps the user\'s prompts in order, the newest 40 when there are more', () => {
    const entries: SpoolEntry[] = Array.from({ length: 45 }, (_, i) => ({ ts: 100 - i, ev: 'prompt', excerpt: `prompt ${100 - i}` }))
    const d = spoolDigest([...entries, { ts: 200, ev: 'prompt' }])
    expect(d.prompts).toBe(46)
    expect(d.userPrompts).toHaveLength(40)
    expect(d.userPrompts[0]).toEqual({ ts: 61, text: 'prompt 61' })
    expect(d.userPrompts.at(-1)).toEqual({ ts: 100, text: 'prompt 100' })
  })
})

describe('spoolIsEmptySession', () => {
  test('prompts and notes without a model turn are an empty session', () => {
    expect(spoolIsEmptySession(spoolDigest([]))).toBe(true)
    expect(spoolIsEmptySession(spoolDigest([{ ts: 1, ev: 'prompt' }, { ts: 2, ev: 'turn' }, { ts: 3, ev: 'note', paths: ['inbox/x.md'] }]))).toBe(true)
  })

  test('any model work is not', () => {
    const work: SpoolEntry[][] = [
      [{ ts: 1, ev: 'turn', excerpt: 'Answered.' }],
      [{ ts: 1, ev: 'stop', excerpt: 'Done.' }],
      [{ ts: 1, ev: 'turn', tokens: 120 }],
      [{ ts: 1, ev: 'compact', excerpt: 'summary' }],
    ]
    for (const w of work) expect([w, spoolIsEmptySession(spoolDigest(w))]).toEqual([w, false])
  })
})

describe('spoolSanitize bounds the redaction work', () => {
  test('a 200 KB excerpt is capped quickly and still redacted before the cut', () => {
    const big = `echo ${'0123456789abcdef'.repeat(12_500)} | xxd -r -p`
    const t = performance.now()
    const r = spoolSanitize({ ts: 1, ev: 'turn', excerpt: big })
    expect(performance.now() - t).toBeLessThan(200)
    expect(r.entry?.excerpt).toHaveLength(SPOOL_LIMITS.excerpt)
    const secret = spoolSanitize({ ts: 1, ev: 'turn', excerpt: `${'a '.repeat(295)}ghp_0123456789abcdefghijABCDEFGHIJ012345 ${'b'.repeat(100_000)}` })
    expect(secret.entry?.excerpt).not.toContain('ghp_0123')
    expect(secret.redactions).toEqual({ count: 1, kinds: ['github'] })
  })

  test('CLI passwords in a quoted command never reach the session note', () => {
    const entries = ['mysql -u root -pKedi2024xyz app_db', 'curl -u admin:Kedi2024xyz https://api.local/x', 'sshpass -p Kedi2024xyz ssh deploy@host']
      .map((cmd, i) => spoolSanitize({ ts: i + 1, ev: 'stop', excerpt: `I ran: ${cmd}` }).entry as SpoolEntry)
    expect(entries).toHaveLength(3)
    for (const e of entries) expect(e.excerpt).not.toContain('Kedi2024xyz')
  })
})

describe('prompt-signal entries', () => {
  test('a valid statement is kept (quote redacted and capped), an invalid one drops the entry', () => {
    const r = spoolSanitize({ ts: 1, ev: 'prompt-signal', signal: { kind: 'statement', key: 'said:deploy-fridays', polarity: -1, text: 'Never deploy on Fridays', quote: `never deploy with ghp_${'a'.repeat(36)} on Fridays ${'x'.repeat(300)}` } })
    expect(r.entry?.signal).toMatchObject({ kind: 'statement', key: 'said:deploy-fridays', polarity: -1, text: 'Never deploy on Fridays' })
    expect(r.entry?.signal?.quote).toHaveLength(160)
    expect(r.entry?.signal?.quote).not.toContain('ghp_aaaa')
    expect(r.redactions.count).toBe(1)
    expect(spoolSanitize({ ts: 1, ev: 'prompt-signal', signal: { kind: 'nope', key: 'x' } }).entry).toBeUndefined()
    expect(spoolSanitize({ ts: 1, ev: 'prompt-signal', signal: { kind: 'statement', key: 'Bad Key' } }).entry).toBeUndefined()
    expect(spoolSanitize({ ts: 1, ev: 'prompt-signal' }).entry).toBeUndefined()
  })

  test('only statements are signals: the old usage and style kinds and the old `signal` event are dropped', () => {
    expect(spoolSanitize({ ts: 1, ev: 'prompt-signal', signal: { kind: 'usage', key: 'usage.mcp=x' } }).entry).toBeUndefined()
    expect(spoolSanitize({ ts: 1, ev: 'prompt-signal', signal: { kind: 'style', key: 'style.prompt_language=en' } }).entry).toBeUndefined()
    expect(spoolSanitize({ ts: 1, ev: 'signal', signal: { kind: 'statement', key: 'said:deploy-fridays' } }).entry).toBeUndefined()
    expect(spoolParse(`${JSON.stringify({ ts: 1, ev: 'signal', signal: { kind: 'statement', key: 'said:deploy-fridays' } })}\n`)).toEqual([])
    expect(spoolSanitize({ ts: 1, ev: 'turn', signal: { kind: 'statement', key: 'said:x-y' } }).entry).toEqual({ ts: 1, ev: 'turn' })
  })

  test('the digest collects statements; statements alone are an empty session', () => {
    const statement = { kind: 'statement', key: 'said:deploy-fridays', polarity: -1, text: 'Never deploy on Fridays' } as const
    const d = spoolDigest([{ ts: 3, ev: 'prompt-signal', signal: statement }])
    expect(d.signals).toEqual([{ ts: 3, signal: statement }])
    expect(spoolIsEmptySession(spoolDigest([{ ts: 1, ev: 'prompt-signal', signal: { kind: 'statement', key: 'communication.emoji=never' } }]))).toBe(true)
  })
})
