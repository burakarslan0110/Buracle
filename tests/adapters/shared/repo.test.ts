import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../../../src/engine/proc'
import { buracleRepoFor } from '../../../src/adapters/shared/repo'
import { withSandbox } from '../../helpers/sandbox'

async function repo(dir: string, name?: string): Promise<string> {
  mkdirSync(join(dir, 'src', 'deep'), { recursive: true })
  if (name !== undefined) writeFileSync(join(dir, 'package.json'), JSON.stringify({ name }))
  expect((await run(['git', 'init', '-q'], { cwd: dir })).code).toBe(0)
  return dir
}

describe('buracleRepoFor', () => {
  test('a git toplevel whose package.json is named "buracle" is the Buracle repo, from any subdirectory', () => withSandbox(async ({ root }) => {
    const r = await repo(join(root, 'checkout'), 'buracle')
    expect(await buracleRepoFor(r)).toBe(r)
    expect(await buracleRepoFor(join(r, 'src', 'deep'))).toBe(r)
  }), 20_000)

  test('another package is not, unless it is a known checkout (the running one or config.repo, ~ expanded)', () => withSandbox(async ({ root, home }) => {
    const r = await repo(join(home, 'code', 'app'), 'my-app')
    const noPkg = await repo(join(root, 'nopkg'))
    expect(await buracleRepoFor(r)).toBeUndefined()
    expect(await buracleRepoFor(noPkg)).toBeUndefined()
    expect(await buracleRepoFor(join(r, 'src'), { known: [r] })).toBe(r)
    expect(await buracleRepoFor(r, { known: ['~/code/app'], home })).toBe(r)
    expect(await buracleRepoFor(r, { known: [undefined, '', 'relative/app'] })).toBeUndefined()
  }), 20_000)

  test('the result keeps the spelling of cwd when it goes through a symlink', () => withSandbox(async ({ root }) => {
    const r = await repo(join(root, 'real-checkout'), 'buracle')
    const link = join(root, 'link')
    symlinkSync(r, link)
    expect(await buracleRepoFor(join(link, 'src'))).toBe(link)
  }), 20_000)

  test('outside git, relative or missing cwds and failing lookups give undefined', () => withSandbox(async ({ root }) => {
    mkdirSync(join(root, 'plain'))
    expect(await buracleRepoFor(join(root, 'plain'))).toBeUndefined()
    expect(await buracleRepoFor('relative/dir')).toBeUndefined()
    expect(await buracleRepoFor(join(root, 'missing'))).toBeUndefined()
    expect(await buracleRepoFor(root, { toplevel: async () => { throw new Error('git broke') } })).toBeUndefined()
    expect(await buracleRepoFor(root, { toplevel: async () => 'not/absolute' })).toBeUndefined()
  }), 20_000)
})
