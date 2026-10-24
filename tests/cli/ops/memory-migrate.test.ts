import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as installRun } from '../../../src/cli/commands/install'
import * as paths from '../../../src/engine/paths'
import { withSandbox } from '../../helpers/sandbox'
import { fakeCli, makeRepo, memoryIO, withDeps } from './helpers'

function legacyBrain(): void {
  mkdirSync(paths.brainDir(), { recursive: true })
  writeFileSync(join(paths.brainDir(), 'person.db'), '')
}

describe('install and the Buracle 0.5 brain files', () => {
  test('an install that finds them runs the migration and says so; one that finds none does not touch it', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const cli = fakeCli()
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: cli.runCli }, async () => {
      const clean = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], clean)).toBe(0)
      expect(cli.calls.some(c => c[0] === 'mem' && c[1] === 'migrate')).toBe(false)

      legacyBrain()
      const io = memoryIO({ json: true })
      await installRun(['--yes', '--json'], io)
      expect(cli.calls).toContainEqual(['mem', 'migrate', '--json'])
      const r = JSON.parse(io.out()) as { steps: string[] }
      expect(r.steps.some(s => s.startsWith('Folded the brain files of Buracle 0.5'))).toBe(true)
    })
  }))

  test('a migration that fails is a step that names the command to run, not a failed install', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const cli = fakeCli(argv => (argv[1] === 'migrate' ? { code: 1, stdout: '', stderr: 'person.db cannot be read\n' } : { code: 0, stdout: '', stderr: '' }))
    legacyBrain()
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: cli.runCli }, async () => {
      const io = memoryIO({ json: true })
      await installRun(['--yes', '--json'], io)
      const r = JSON.parse(io.out()) as { steps: string[] }
      expect(r.steps.some(s => s.includes('run `buracle mem migrate` (person.db cannot be read)'))).toBe(true)
    })
  }))
})
