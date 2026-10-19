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

describe('Windows paths: project roots and the folders that are never a project', () => {
  const env = { home: 'C:\\Users\\Me', vault: 'C:\\Users\\Me\\Documents\\Buracle', buracleHome: 'C:\\Users\\Me\\.buracle', claudeDir: 'C:\\Users\\Me\\.claude', tempRoots: ['C:\\Users\\Me\\AppData\\Local\\Temp'] }

  test('a session folder below a root, in either separator and any case, maps to its project', () => {
    const cache = memEmptyProjects()
    cache.projects['app'] = { slug: 'app', scope: 'project', roots: ['C:\\Users\\Me\\code\\app'] }
    cache.projects['notes'] = { slug: 'notes', scope: 'adhoc', roots: ['C:\\Users\\Me\\notes'] }
    for (const cwd of ['C:\\Users\\Me\\code\\app', 'C:\\Users\\Me\\code\\app\\src', 'c:/users/me/code/app/src', 'C:\\Users\\Me\\code\\app\\']) expect({ cwd, slug: memLookupProject(cache, cwd)?.slug }).toEqual({ cwd, slug: 'app' })
    expect(memLookupProject(cache, 'C:\\Users\\Me\\code\\app2')).toBeUndefined()
    expect(memLookupProject(cache, 'c:\\users\\me\\notes')?.slug).toBe('notes')
    expect(memLookupProject(cache, 'C:\\Users\\Me\\notes\\x')).toBeUndefined()
  })

  test('the drive root, the home folder, the vault, Buracle\'s state, job, scratchpad and temp folders are refused', () => {
    const cases: Array<[string, string]> = [
      ['C:\\', 'the filesystem root'], ['\\\\srv\\share', 'the filesystem root'], ['c:\\users\\me', 'your home folder'], ['C:\\Users\\Me\\Documents\\Buracle\\x', 'inside the memory vault'],
      ['C:\\Users\\Me\\.buracle\\brain', "inside Buracle's state folder"], ['C:/Users/Me/.claude/jobs/j1', 'a Claude Code job folder'],
      ['C:\\x\\Scratchpad\\y', 'a scratchpad folder'], ['C:\\Users\\Me\\AppData\\Local\\Temp\\buracle-x', 'a temporary folder'],
    ]
    for (const [dir, why] of cases) expect({ dir, why: memNonProjectReason(dir, env) }).toEqual({ dir, why })
    expect(memNonProjectReason('C:\\Users\\Me\\code\\app', env)).toBeUndefined()
  })
})
