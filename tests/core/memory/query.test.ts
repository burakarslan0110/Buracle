import { describe, expect, test } from 'bun:test'
import { memLookupProject, type MemProjectsCache } from '../../../src/core/memory/project'
import { memFtsQuery, memNoteSimilarity, memQueryWords, memTitleSimilarity, memTrigramQuery } from '../../../src/core/memory/query'

describe('FTS query building', () => {
  test('normalizes Turkish, drops stopwords, prefixes words of 4+ characters', () => {
    expect(memQueryWords('Hafıza ve KARAR için')).toEqual(['hafiza', 'karar'])
    expect(memFtsQuery('hafıza karar db', 'and')).toBe('"hafiza"* AND "karar"* AND "db"')
    expect(memFtsQuery('kararlarını', 'or')).toBe('"kararlarini"* OR "karar"*')
    expect(memFtsQuery('   ', 'and')).toBeUndefined()
    expect(memFtsQuery('ve', 'and')).toBe('"ve"')
  })

  test('quotes FTS syntax away', () => {
    const q = memFtsQuery('x1"y2 OR c3* NEAR(z9)', 'and') as string
    expect(q).toBe('"x1" AND "y2" AND "c3" AND "near"* AND "z9"')
  })

  test('trigram terms need 3+ characters', () => {
    expect(memTrigramQuery('hafız ab kararlar')).toBe('"hafiz" OR "kararlar"')
    expect(memTrigramQuery('ab')).toBeUndefined()
  })

  test('title similarity', () => {
    expect(memTitleSimilarity('Use FTS5 as the default index', 'use fts5 as the default index')).toBe(1)
    expect(memTitleSimilarity('Use SQLite FTS5 as the default memory index', 'Use SQLite FTS5 as the default index for memory')).toBeGreaterThanOrEqual(0.6)
    expect(memTitleSimilarity('Use FTS5 for search', 'Codex hooks time out after 3 seconds')).toBeLessThan(0.2)
  })
})

describe('memLookupProject', () => {
  const cache: MemProjectsCache = {
    v: 1,
    projects: {
      buracle: { slug: 'buracle', scope: 'project', roots: ['/Users/me/code/buracle', '/Users/me/code/buracle-wt/feat'] },
      nested: { slug: 'nested', scope: 'project', roots: ['/Users/me/code/buracle/vendor/nested'] },
      notes: { slug: 'notes-1a2b3c', scope: 'adhoc', roots: ['/Users/me/notes'] },
    },
  }

  test('longest root wins; worktrees resolve to the same project', () => {
    expect(memLookupProject(cache, '/Users/me/code/buracle/src')?.slug).toBe('buracle')
    expect(memLookupProject(cache, '/Users/me/code/buracle-wt/feat')?.slug).toBe('buracle')
    expect(memLookupProject(cache, '/Users/me/code/buracle/vendor/nested/x')?.slug).toBe('nested')
    expect(memLookupProject(cache, '/Users/me/code/buracle2')).toBeUndefined()
  })

  test('folders outside git match only exactly', () => {
    expect(memLookupProject(cache, '/Users/me/notes')?.slug).toBe('notes-1a2b3c')
    expect(memLookupProject(cache, '/Users/me/notes/sub')).toBeUndefined()
    expect(memLookupProject(undefined, '/x')).toBeUndefined()
  })
})

describe('stemmed query terms (finding M3)', () => {
  test('a word also matches through its stem, in both passes', () => {
    expect(memFtsQuery('hataları', 'and')).toBe('"hatalari"* OR "hata"*')
    expect(memFtsQuery('hataları', 'or')).toBe('"hatalari"* OR "hata"*')
    expect(memFtsQuery('caching tests', 'and')).toBe('("caching"* OR "cach"*) AND ("tests"* OR "test"*)')
    expect(memFtsQuery('caching tests', 'or')).toBe('"caching"* OR "cach"* OR "tests"* OR "test"*')
    expect(memFtsQuery('kitabı', 'and')).toBe('"kitabi"* OR "kitab"* OR "kitap"*')
    expect(memFtsQuery('güncelleme', 'or')).toBe('"guncelleme"* OR "gunce"*')
    expect(memFtsQuery('güncelleme', 'and')).toBe('"guncelleme"*')
  })
})

describe('duplicate detection similarity (finding M6)', () => {
  const same: Array<[string, string]> = [
    ['Index rebuilds drop cached tokens', 'Rebuilding the index drops the token cache'],
    ['Failing tests block merges', 'A failing test blocks the merge'],
    ['Policies apply to every worktree', 'Policy applies to worktrees'],
    ['Session notes link their commits', 'Each session note links the commit'],
    ['Hafıza araması Türkçe ekleri bulmuyor', 'Türkçe ekler hafıza aramasında bulunmuyor'],
    ['Kod incelemeleri testleri kapsamalı', 'Kod incelemesi testi kapsamalı'],
    ['Hook timeouts kill long tests', 'Long tests are killed by the hook timeout'],
  ]
  for (const [a, b] of same) {
    test(`restated: ${a}`, () => expect(memTitleSimilarity(a, b)).toBeGreaterThanOrEqual(0.6))
  }

  const different: Array<[string, string]> = [
    ['Use FTS5 for search', 'Codex hooks time out after 3 seconds'],
    ['Tests must not hit the network', 'Network tests are flaky on CI'],
    ['Do not commit .env files', 'Commit the lockfile with every dependency change'],
    ['Index the vault when a session starts', 'Archive stale inbox notes after 120 days'],
    ['Token budget for the injected index is 6 KB', 'Rotate the GitHub token every 90 days'],
  ]
  for (const [a, b] of different) {
    test(`different: ${a}`, () => expect(memTitleSimilarity(a, b)).toBeLessThan(0.6))
  }

  test('a restated claim with another title is caught through its description; equal descriptions alone are not a duplicate', () => {
    const a = { title: 'Codex hooks time out after 3 seconds', description: 'Codex kills a hook that runs longer than 3 seconds; keep hook work short' }
    const b = { title: 'Keep Codex hook handlers under three seconds', description: 'A Codex hook that runs longer than 3 seconds is killed, so keep the work short' }
    expect(memTitleSimilarity(a.title, b.title)).toBeLessThan(0.6)
    expect(memNoteSimilarity(a, b)).toBeGreaterThanOrEqual(0.6)
    const generic = 'Decided in the planning session'
    expect(memNoteSimilarity({ title: 'Ship the web UI on port 4747', description: generic }, { title: 'Archive handoffs after two weeks', description: generic })).toBeLessThan(0.6)
    expect(memNoteSimilarity({ title: 'Use FTS5', description: 'one' }, { title: 'use fts5', description: 'two words' })).toBe(1)
    expect(memNoteSimilarity({ title: 'Hook timeouts kill long tests', description: 'x' }, { title: 'Long tests are killed by the hook timeout', description: 'y' })).toBeGreaterThanOrEqual(0.6)
    expect(memNoteSimilarity({ title: 'Use FTS5 for search' }, { title: 'Use FTS5 for search', description: 'x' })).toBe(1)
    const c = { title: 'Rotate the GitHub token every 90 days', description: 'GitHub tokens expire; rotate them before the deadline' }
    const d = { title: 'Token budget for the injected index is 6 KB', description: 'The injected index stays under 6 KB of tokens' }
    expect(memNoteSimilarity(c, d)).toBeLessThan(0.3)
  })
})
