import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { KEPT_EXIT } from '../../../src/adapters/claude/check'
import { run as installRun } from '../../../src/cli/commands/install'
import { run as uninstallRun } from '../../../src/cli/commands/uninstall'
import { applyPlans, rollbackTxn, UNDO_KEPT_EXIT, undoKeptOnPurpose } from '../../../src/engine/txn'
import { withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, makeRepo, memoryIO, withDeps, writeExe } from './helpers'

function keptScript(repo: string, log: string): string {
  return writeExe(join(repo, 'src', 'adapters', 'claude', 'check.ts'), `echo run >> "${log}"
echo "kept the testmk marketplace: your plugins userplug@testmk come from it" >&2
exit ${UNDO_KEPT_EXIT}`)
}

describe('undo commands that keep their target on purpose', () => {
  test('the protocol: exit 3 from a Buracle helper script only', () => {
    expect(KEPT_EXIT).toBe(UNDO_KEPT_EXIT)
    expect(undoKeptOnPurpose(['/opt/homebrew/bin/bun', '/r/src/adapters/claude/check.ts', '--claude', 'claude', 'remove-marketplace', 'm'], 3)).toBe(true)
    expect(undoKeptOnPurpose(['/opt/homebrew/bin/bun', '/r/src/adapters/claude/check.ts', 'remove-marketplace', 'm'], 1)).toBe(false)
    expect(undoKeptOnPurpose(['claude', 'plugin', 'marketplace', 'remove', 'm'], 3)).toBe(false)
  })

  test('uninstall settles and reports it once (exit 0, no undo failure, purge allowed)', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const log = join(root, 'undo.log')
    const script = keptScript(repo, log)
    const claude = fakeAdapter('claude', {
      plan: () => ({ id: 'claude', harness: 'claude', ops: [
        { kind: 'file', path: join(home, '.claude', 'rules', 'buracle', 'core.md'), content: '# r\n', owner: 'claude' },
        { kind: 'exec', argv: ['/bin/sh', '-c', 'exit 0'], undo: [script, 'remove-marketplace', 'testmk'], owner: 'claude', soft: true },
      ] }),
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--purge-state', '--yes', '--json'], io)).toBe(0)
      const r = JSON.parse(io.out()) as { undoFailed: unknown[], undoSkipped: Array<{ command: string, detail: string }>, purged: string[] }
      expect(r.undoFailed).toEqual([])
      expect(r.undoSkipped.map(s => s.detail)).toEqual(['kept the testmk marketplace: your plugins userplug@testmk come from it'])
      expect(r.purged.length).toBeGreaterThan(0)
      expect(existsSync(join(buracleHome, 'state'))).toBe(false)
      expect(readFileSync(log, 'utf8')).toBe('run\n')
    })
  }))

  test('a rollback settles it with a warning instead of an error', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const log = join(root, 'undo.log')
    const script = keptScript(repo, log)
    const r = await applyPlans([{ id: 'claude', harness: 'claude', ops: [
      { kind: 'file', path: join(home, '.claude', 'rules', 'buracle', 'core.md'), content: '# r\n', owner: 'claude' },
      { kind: 'exec', argv: ['/bin/sh', '-c', 'exit 0'], undo: [script, 'remove-marketplace', 'testmk'], owner: 'claude' },
    ] }])
    const back = await rollbackTxn(r.txn)
    expect(back.errors).toEqual([])
    expect(back.warnings.some(w => w.startsWith('kept on purpose:') && w.includes('userplug@testmk'))).toBe(true)
    expect(existsSync(join(home, '.claude', 'rules', 'buracle', 'core.md'))).toBe(false)
  }))
})
