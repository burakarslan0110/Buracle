import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { KEPT_EXIT } from '../../../src/adapters/claude/check'
import { run as installRun } from '../../../src/cli/commands/install'
import { run as uninstallRun } from '../../../src/cli/commands/uninstall'
import { applyPlans, rollbackTxn, UNDO_KEPT_EXIT, undoKeptOnPurpose } from '../../../src/engine/txn'
import { withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, makeRepo, memoryIO, withDeps } from './helpers'

// A stand-in for the adapter's check.ts helper, run the way the product runs it: Bun on the script.
function keptUndo(repo: string, log: string): string[] {
  const script = join(repo, 'src', 'adapters', 'claude', 'check.ts')
  mkdirSync(dirname(script), { recursive: true })
  writeFileSync(script, `import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(log)}, 'run\\n')
console.error('kept the testmk marketplace: your plugins userplug@testmk come from it')
process.exit(${UNDO_KEPT_EXIT})
`)
  return [process.execPath, script, 'remove-marketplace', 'testmk']
}

const NOOP = [process.execPath, '-e', '0']

describe('undo commands that keep their target on purpose', () => {
  test('the protocol: exit 3 from a Buracle helper script only', () => {
    expect(KEPT_EXIT).toBe(UNDO_KEPT_EXIT)
    expect(undoKeptOnPurpose(['/opt/homebrew/bin/bun', '/r/src/adapters/claude/check.ts', '--claude', 'claude', 'remove-marketplace', 'm'], 3)).toBe(true)
    expect(undoKeptOnPurpose(['/opt/homebrew/bin/bun', '/r/src/adapters/claude/check.ts', 'remove-marketplace', 'm'], 1)).toBe(false)
    expect(undoKeptOnPurpose(['claude', 'plugin', 'marketplace', 'remove', 'm'], 3)).toBe(false)
    expect(undoKeptOnPurpose(['C:\\b\\bun.exe', 'C:\\r\\src\\adapters\\claude\\check.ts', 'remove-marketplace', 'm'], 3)).toBe(true)
  })

  test('uninstall settles and reports it once (exit 0, no undo failure, purge allowed)', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const log = join(root, 'undo.log')
    const undo = keptUndo(repo, log)
    const claude = fakeAdapter('claude', {
      plan: () => ({ id: 'claude', harness: 'claude', ops: [
        { kind: 'file', path: join(home, '.claude', 'rules', 'buracle', 'core.md'), content: '# r\n', owner: 'claude' },
        { kind: 'exec', argv: NOOP, undo, owner: 'claude', soft: true },
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
    const undo = keptUndo(repo, log)
    const r = await applyPlans([{ id: 'claude', harness: 'claude', ops: [
      { kind: 'file', path: join(home, '.claude', 'rules', 'buracle', 'core.md'), content: '# r\n', owner: 'claude' },
      { kind: 'exec', argv: NOOP, undo, owner: 'claude' },
    ] }])
    const back = await rollbackTxn(r.txn)
    expect(back.errors).toEqual([])
    expect(back.warnings.some(w => w.startsWith('kept on purpose:') && w.includes('userplug@testmk'))).toBe(true)
    expect(existsSync(join(home, '.claude', 'rules', 'buracle', 'core.md'))).toBe(false)
  }))
})
