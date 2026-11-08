import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { run as installRun } from '../../../src/cli/commands/install'
import { run as uninstallRun } from '../../../src/cli/commands/uninstall'
import { narrowPath } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, makeRepo, memoryIO, noNetwork, withDeps } from './helpers'

// omp installed with `bun add -g` lives in ~/.bun/bin, which no shell has on PATH. The install links it into ~/.local/bin;
// an install of one other harness must not take that link away again (it only looks at that harness).
describe('the link that makes a harness program runnable by name', () => {
  const setup = (home: string): string => {
    const bin = join(home, '.bun', 'bin', 'omp')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, '#!/bin/sh\n')
    chmodSync(bin, 0o755)
    return bin
  }

  test('a full install makes it, an install of another harness keeps it, and uninstall removes it', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const omp = setup(home)
    const link = join(home, '.local', 'bin', 'omp')
    await withDeps({ repoRoot: () => repo, adapters: async () => [fakeAdapter('omp', { path: omp }), fakeAdapter('codex')], runCli: fakeCli().runCli, fetch: noNetwork, loginPath: () => undefined }, async () => {
      await withEnv({ PATH: narrowPath(), SHELL: '/bin/zsh', ZDOTDIR: undefined }, async () => {
        expect(await installRun(['--yes'], memoryIO())).toBe(0)
        expect(readlinkSync(link)).toBe(omp)

        // `buracle install codex` does not look at omp at all: the link stays.
        expect(await installRun(['--yes', 'codex'], memoryIO())).toBe(0)
        expect(lstatSync(link).isSymbolicLink()).toBe(true)
        expect(readlinkSync(link)).toBe(omp)

        // A full install again changes nothing; uninstall takes the link out with the rest.
        expect(await installRun(['--yes'], memoryIO())).toBe(0)
        expect(readlinkSync(link)).toBe(omp)
        expect(await uninstallRun(['--yes', '--json'], memoryIO({ json: true }))).toBe(0)
        expect(existsSync(link)).toBe(false)
      })
    })
  }))

  test('a harness that is on PATH, or one whose adapter could not detect it this time, loses nothing', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const omp = setup(home)
    const link = join(home, '.local', 'bin', 'omp')
    const flaky = fakeAdapter('omp', { path: omp })
    await withDeps({ repoRoot: () => repo, adapters: async () => [flaky], runCli: fakeCli().runCli, fetch: noNetwork, loginPath: () => undefined }, async () => {
      await withEnv({ PATH: narrowPath(), SHELL: '/bin/zsh', ZDOTDIR: undefined }, async () => {
        expect(await installRun(['--yes'], memoryIO())).toBe(0)
        expect(readlinkSync(link)).toBe(omp)
        // The next run cannot find out what omp is (its detection throws): the link is kept, not pruned.
        flaky.detect = async () => { throw new Error('omp --version hung') }
        await installRun(['--yes'], memoryIO())
        expect(readlinkSync(link)).toBe(omp)
      })
    })
  }))
})
