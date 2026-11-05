import { describe, expect, test } from 'bun:test'
import { memEmptyProjects, memExclusion, memLookupProject, memNonProjectReason } from '../../../src/core/memory/project'

const ENV = { home: '/Users/me', caseInsensitive: false }

describe('memExclusion', () => {
  test('paths, ~, globs and bare names match a folder or anything inside it', () => {
    const dirs = ['/Users/me/clients/acme/app']
    expect(memExclusion({ dirs }, ['/Users/me/clients'], ENV)).toBe('excluded by memory.exclude (/Users/me/clients)')
    expect(memExclusion({ dirs }, ['~/clients/acme'], ENV)).toBe('excluded by memory.exclude (~/clients/acme)')
    expect(memExclusion({ dirs }, ['acme'], ENV)).toBe('excluded by memory.exclude (acme)')
    expect(memExclusion({ dirs }, ['/Users/me/*/acme'], ENV)).toBe('excluded by memory.exclude (/Users/me/*/acme)')
    expect(memExclusion({ dirs }, ['/Users/me/work', 'other', ' '], ENV)).toBeUndefined()
    expect(memExclusion({ dirs: ['/Users/me/x'] }, ['~'], ENV)).toBe('excluded by memory.exclude (~)')
  })

  test('owner/repo matches the remote without case, with * and ? globs; the first matching pattern is named', () => {
    const t = { dirs: ['/w/app'], ownerRepo: 'Acme/App' }
    expect(memExclusion(t, ['acme/app'], ENV)).toBe('excluded by memory.exclude (acme/app)')
    expect(memExclusion(t, ['ACME/*'], ENV)).toBe('excluded by memory.exclude (ACME/*)')
    expect(memExclusion(t, ['*/ap?'], ENV)).toBe('excluded by memory.exclude (*/ap?)')
    expect(memExclusion(t, ['acme/app.js', 'acme/a.p'], ENV)).toBeUndefined()
    expect(memExclusion(t, ['nope/x', 'acme/*'], ENV)).toBe('excluded by memory.exclude (acme/*)')
    expect(memExclusion({ dirs: ['/w/app'] }, ['acme/app'], ENV)).toBeUndefined()
  })
})

describe('project roots and the folders that are never a project', () => {
  const env = { home: '/Users/me', vault: '/Users/me/Documents/Buracle', buracleHome: '/Users/me/.buracle', claudeDir: '/Users/me/.claude', tempRoots: ['/private/tmp'] }

  test('a session folder below a root maps to its project; a sibling or another case does not', () => {
    const cache = memEmptyProjects()
    cache.projects['app'] = { slug: 'app', scope: 'project', roots: ['/Users/me/code/app'] }
    cache.projects['notes'] = { slug: 'notes', scope: 'adhoc', roots: ['/Users/me/notes'] }
    for (const cwd of ['/Users/me/code/app', '/Users/me/code/app/src', '/Users/me/code/app/']) expect({ cwd, slug: memLookupProject(cache, cwd)?.slug }).toEqual({ cwd, slug: 'app' })
    expect(memLookupProject(cache, '/Users/me/code/app2')).toBeUndefined()
    expect(memLookupProject(cache, '/users/me/code/app')).toBeUndefined()
    expect(memLookupProject(cache, '/Users/me/notes')?.slug).toBe('notes')
    expect(memLookupProject(cache, '/Users/me/notes/x')).toBeUndefined()
  })

  test('the root, the home folder, the vault, Buracle\'s state, job, scratchpad and temp folders are refused', () => {
    const cases: Array<[string, string]> = [
      ['/', 'the filesystem root'], ['/Users/me', 'your home folder'], ['/Users/me/Documents/Buracle/x', 'inside the memory vault'],
      ['/Users/me/.buracle/brain', "inside Buracle's state folder"], ['/Users/me/.claude/jobs/j1', 'a Claude Code job folder'],
      ['/x/Scratchpad/y', 'a scratchpad folder'], ['/private/tmp/buracle-x', 'a temporary folder'],
    ]
    for (const [dir, why] of cases) expect({ dir, why: memNonProjectReason(dir, env) }).toEqual({ dir, why })
    expect(memNonProjectReason('/Users/me/code/app', env)).toBeUndefined()
  })
})
