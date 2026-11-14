import { describe, expect, test } from 'bun:test'
import { memLookupProject, type MemProjectsCache } from '../../../src/core/memory/project'
import { memQueryWords, memTitleSimilarity } from '../../../src/core/memory/query'

describe('FTS query building', () => {
  test('normalizes Turkish, drops stopwords, prefixes words of 4+ characters', () => {
    expect(memQueryWords('Hafıza ve KARAR için')).toEqual(['hafiza', 'karar'])
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
})
