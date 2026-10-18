import { describe, expect, test } from 'bun:test'
import { SPOOL_LIMITS, spoolCommandHeads, spoolDigest, spoolFileMatches, spoolFileName, spoolIsEmptySession, spoolIsTestCommand, spoolParse, spoolSanitize, type SpoolEntry } from '../../../src/core/memory/spool'

describe('spoolSanitize', () => {
  test('keeps contract fields, drops the rest, rejects invalid entries', () => {
    const { entry } = spoolSanitize({ ts: 1.6, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'ls', exit: 0, ms: 3.2, prompt: 'raw prompt!', output: 'raw output' })
    expect(entry).toEqual({ ts: 2, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'ls', exit: 0, ms: 3 })
    expect(spoolSanitize({ ev: 'tool' }).entry).toBeUndefined()
    expect(spoolSanitize({ ts: 1, ev: 'weird' }).entry).toBeUndefined()
    expect(spoolSanitize('nope').entry).toBeUndefined()
    expect(spoolSanitize({ ts: 1, ev: 'tool', kind: 'telepathy' }).entry).toEqual({ ts: 1, ev: 'tool' })
  })

  test('keeps the user\'s prompt text redacted and clipped for the distillation, never tool output', () => {
    expect(spoolSanitize({ ts: 1, ev: 'prompt', excerpt: 'my prompt', tokens: 40 }).entry).toEqual({ ts: 1, ev: 'prompt', excerpt: 'my prompt', tokens: 40 })
    expect(spoolSanitize({ ts: 1, ev: 'prompt', excerpt: 'deploy with <private>hunter2</private> now' }).entry?.excerpt).toBe('deploy with [REDACTED:private] now')
    expect(spoolSanitize({ ts: 1, ev: 'prompt', excerpt: 'word '.repeat(500) }).entry?.excerpt?.length).toBe(SPOOL_LIMITS.promptExcerpt)
    expect(spoolSanitize({ ts: 1, ev: 'tool', tool: 'Bash', excerpt: 'tool output' }).entry).toEqual({ ts: 1, ev: 'tool', tool: 'Bash' })
    expect(spoolSanitize({ ts: 1, ev: 'note', excerpt: 'm-20261008-abcd' }).entry?.excerpt).toBe('m-20261008-abcd')
  })

  test('redacts commands and excerpts and reports it', () => {
    const r = spoolSanitize({ ts: 1, ev: 'turn', cmd: 'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx1234', excerpt: 'token ghp_0123456789abcdefghijABCDEFGHIJ012345' })
    expect(r.entry?.cmd).toBe('export OPENAI_API_KEY=[REDACTED:openai]')
    expect(r.entry?.excerpt).toBe('token [REDACTED:github]')
    expect(r.redactions).toEqual({ count: 2, kinds: ['github', 'openai'] })
  })

  test('caps excerpts (8,000 for compact entries), commands and paths', () => {
    const long = 'word '.repeat(5000)
    expect(spoolSanitize({ ts: 1, ev: 'turn', excerpt: long }).entry?.excerpt?.length).toBe(SPOOL_LIMITS.excerpt)
    expect(spoolSanitize({ ts: 1, ev: 'compact', excerpt: long }).entry?.excerpt?.length).toBe(SPOOL_LIMITS.compactExcerpt)
    expect(spoolSanitize({ ts: 1, ev: 'tool', cmd: long }).entry?.cmd?.length).toBe(SPOOL_LIMITS.cmd)
    const paths = Array.from({ length: 80 }, (_, i) => `/p/${i}`)
    expect(spoolSanitize({ ts: 1, ev: 'tool', paths }).entry?.paths?.length).toBe(SPOOL_LIMITS.paths)
  })
})

describe('spool files', () => {
  test('parse skips torn and invalid lines', () => {
    const text = '{"ts":1,"ev":"prompt"}\n{"ts":2,"ev":"tool","tool":"Bash"\nnot json\n\n{"ts":3,"ev":"stop","excerpt":"bye"}\n'
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
  test('derives files, commands, tests, failures, compactions and the final message', () => {
    const entries: SpoolEntry[] = [
      { ts: 50, ev: 'stop', excerpt: 'final words' },
      { ts: 10, ev: 'prompt' },
      { ts: 20, ev: 'tool', tool: 'Edit', kind: 'edit', paths: ['/repo/src/a.ts'] },
      { ts: 21, ev: 'tool', tool: 'Write', kind: 'write', paths: ['/repo/src/b.ts', '/repo/src/a.ts'] },
      { ts: 22, ev: 'tool', tool: 'Read', kind: 'read', paths: ['/repo/README.md'] },
      { ts: 30, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'bun test tests/x.test.ts', exit: 1 },
      { ts: 31, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'bun test', exit: 0 },
      { ts: 32, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'git commit -m "x"', exit: 0 },
      { ts: 33, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'make lint', exit: 2 },
      { ts: 40, ev: 'compact', tool: 'auto', excerpt: 'summary one' },
      { ts: 45, ev: 'turn', excerpt: 'older message', model: 'claude-opus-5-5', tokens: 100 },
      { ts: 46, ev: 'note', excerpt: 'm-20261008-abcd' },
    ]
    const d = spoolDigest(entries, '/repo')
    expect(d.startedMs).toBe(10)
    expect(d.endedMs).toBe(50)
    expect(d.files).toEqual(['src/b.ts', 'src/a.ts'])
    expect(d.commands).toBe(4)
    expect(d.tests).toEqual({ runs: 2, failures: 1 })
    expect(d.failures).toEqual([{ cmd: 'bun test tests/x.test.ts', exit: 1 }, { cmd: 'make lint', exit: 2 }])
    expect(d.gitCommits).toBe(1)
    expect(d.compactions).toEqual([{ ts: 40, trigger: 'auto', summary: 'summary one' }])
    expect(d.finalMessage).toBe('final words')
    expect(d.model).toBe('claude-opus-5-5')
    expect(d.tokens).toBe(100)
    expect(d.turns).toBe(1)
    expect(d.prompts).toBe(1)
    expect(d.notes).toEqual(['m-20261008-abcd'])
  })

  test('recognizes common test runners', () => {
    for (const c of ['bun test', 'npm test', 'npm run test', 'pnpm test', 'pytest -q', 'python -m pytest', 'go test ./...', 'cargo test', 'cd x && bun test']) expect(spoolIsTestCommand(c)).toBe(true)
    for (const c of ['bun run build', 'git status', 'echo test', 'ls tests']) expect(spoolIsTestCommand(c)).toBe(false)
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
  test('prompts and command notes without a model turn are an empty session', () => {
    expect(spoolIsEmptySession(spoolDigest([]))).toBe(true)
    expect(spoolIsEmptySession(spoolDigest([{ ts: 1, ev: 'prompt' }, { ts: 2, ev: 'turn' }, { ts: 3, ev: 'note', paths: ['inbox/x.md'] }]))).toBe(true)
  })

  test('any model work is not', () => {
    const work: SpoolEntry[][] = [
      [{ ts: 1, ev: 'turn', excerpt: 'Answered.' }],
      [{ ts: 1, ev: 'stop', excerpt: 'Done.' }],
      [{ ts: 1, ev: 'turn', tokens: 120 }],
      [{ ts: 1, ev: 'tool', kind: 'read', tool: 'Read' }],
      [{ ts: 1, ev: 'tool', kind: 'bash', cmd: 'ls', exit: 0 }],
      [{ ts: 1, ev: 'compact', excerpt: 'summary' }],
    ]
    for (const w of work) expect([w, spoolIsEmptySession(spoolDigest(w))]).toEqual([w, false])
  })
})

describe('spoolSanitize bounds the redaction work', () => {
  test('a 200 KB command is capped quickly and still redacted before the cut', () => {
    const big = `echo ${'0123456789abcdef'.repeat(12_500)} | xxd -r -p`
    const t = performance.now()
    const r = spoolSanitize({ ts: 1, ev: 'tool', kind: 'bash', cmd: big })
    expect(performance.now() - t).toBeLessThan(200)
    expect(r.entry?.cmd).toHaveLength(SPOOL_LIMITS.cmd)
    const secret = spoolSanitize({ ts: 1, ev: 'tool', kind: 'bash', cmd: `${'a '.repeat(295)}ghp_0123456789abcdefghijABCDEFGHIJ012345 ${'b'.repeat(100_000)}` })
    expect(secret.entry?.cmd).not.toContain('ghp_0123')
    expect(secret.redactions).toEqual({ count: 1, kinds: ['github'] })
  })

  test('CLI passwords in a failed command never reach the session note', () => {
    const entries = ['mysql -u root -pKedi2024xyz app_db', 'curl -u admin:Kedi2024xyz https://api.local/x', 'sshpass -p Kedi2024xyz ssh deploy@host']
      .map((cmd, i) => spoolSanitize({ ts: i + 1, ev: 'tool', kind: 'bash', cmd, exit: 1 }).entry as SpoolEntry)
    const d = spoolDigest(entries)
    expect(d.failures).toHaveLength(3)
    for (const f of d.failures) expect(f.cmd).not.toContain('Kedi2024xyz')
  })
})

describe('signal entries', () => {
  test('a valid signal is kept (quote redacted and capped), an invalid one drops the entry', () => {
    const r = spoolSanitize({ ts: 1, ev: 'signal', signal: { kind: 'statement', key: 'said:deploy-fridays', polarity: -1, text: 'Never deploy on Fridays', quote: `never deploy with ghp_${'a'.repeat(36)} on Fridays ${'x'.repeat(300)}` } })
    expect(r.entry?.signal).toMatchObject({ kind: 'statement', key: 'said:deploy-fridays', polarity: -1, text: 'Never deploy on Fridays' })
    expect(r.entry?.signal?.quote).toHaveLength(160)
    expect(r.entry?.signal?.quote).not.toContain('ghp_aaaa')
    expect(r.redactions.count).toBe(1)
    expect(spoolSanitize({ ts: 1, ev: 'signal', signal: { kind: 'nope', key: 'x' } }).entry).toBeUndefined()
    expect(spoolSanitize({ ts: 1, ev: 'signal' }).entry).toBeUndefined()
    expect(spoolSanitize({ ts: 1, ev: 'tool', signal: { kind: 'usage', key: 'usage.mcp=x' } }).entry).toEqual({ ts: 1, ev: 'tool' })
  })

  test('the digest collects signals, tool counts, command heads and the last test result; signals alone are an empty session', () => {
    const d = spoolDigest([
      { ts: 3, ev: 'signal', signal: { kind: 'usage', key: 'usage.workflow=plan-build' } },
      { ts: 1, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'cd x && FOO=1 bun test; sudo npm i -g y', exit: 1 },
      { ts: 2, ev: 'tool', tool: 'mcp__semble__search', kind: 'mcp' },
      { ts: 4, ev: 'tool', tool: '__proto__', kind: 'other' },
    ])
    expect(d.signals).toEqual([{ ts: 3, signal: { kind: 'usage', key: 'usage.workflow=plan-build' } }])
    expect(d.toolCounts).toEqual({ Bash: 1, 'mcp__semble__search': 1 })
    expect(d.commandHeads).toEqual({ 'cd x': 1, 'bun test': 1, 'npm i': 1 })
    expect(d.lastTestExit).toBe(1)
    expect(spoolIsEmptySession(spoolDigest([{ ts: 1, ev: 'signal', signal: { kind: 'style', key: 'style.prompt_language=en' } }]))).toBe(true)
    expect(spoolCommandHeads('git -C repo commit -m x | tee log')).toEqual(['git -c', 'tee log'])
  })
})
