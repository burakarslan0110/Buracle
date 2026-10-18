import { describe, expect, test } from 'bun:test'
import { memExclusion } from '../../../src/core/memory/project'

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
