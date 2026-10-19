import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as configRun, setConfigValue } from '../../../src/cli/commands/config'
import { run as installRun } from '../../../src/cli/commands/install'
import { run as rollbackRun } from '../../../src/cli/commands/rollback'
import { listTxns } from '../../../src/engine/txn'
import { withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, makeRepo, memoryIO, withDeps } from './helpers'

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('buracle rollback', () => {
  test('rolls back the newest transaction, lists transactions, and reports paths changed since', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    let content = 'v1\n'
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: join(home, '.codex/a.txt'), content, owner: 'codex' }, { kind: 'file', path: join(home, '.codex/b.txt'), content, owner: 'codex' }] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      content = 'v2\n'
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const [newest, first] = await listTxns()

      const list = memoryIO()
      expect(await rollbackRun(['--list'], list)).toBe(0)
      expect(list.out()).toContain(newest?.txn as string)
      expect(list.out()).toContain(first?.txn as string)
      expect(list.out()).toMatch(/TXN\s+STATUS\s+STARTED/)

      writeFileSync(join(home, '.codex/b.txt'), 'edited\n')
      const io = memoryIO()
      expect(await rollbackRun([], io)).toBe(2)
      expect(io.out()).toContain(`Rolled back ${newest?.txn}`)
      expect(read(join(home, '.codex/a.txt'))).toBe('v1\n')
      expect(read(join(home, '.codex/b.txt'))).toBe('edited\n')
      expect(io.out()).toContain('~/.codex/b.txt: changed after the transaction; left as is')

      const j = memoryIO()
      expect(await rollbackRun([first?.txn as string, '--json'], j)).toBe(2)
      expect(JSON.parse(j.out())).toMatchObject({ ok: false, code: 2, txn: first?.txn, skipped: [{ path: join(home, '.codex/b.txt') }] })
      expect(existsSync(join(home, '.codex/a.txt'))).toBe(false)
      expect(read(join(home, '.codex/b.txt'))).toBe('edited\n')

      const again = memoryIO()
      expect(await rollbackRun([first?.txn as string], again)).toBe(1)
      expect(again.err()).toContain('already rolled back')
      expect(await rollbackRun(['../evil'], memoryIO())).toBe(1)
    })
  }))
})

describe('buracle config', () => {
  test('get prints plain scalars, JSON for lists, and exits 1 for unknown keys', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo }, async () => {
      const io = memoryIO()
      expect(await configRun(['get', 'plan.stopGuard'], io)).toBe(0)
      expect(io.out()).toBe('true\n')
      const s = memoryIO()
      expect(await configRun(['get', 'routing.strictness'], s)).toBe(0)
      expect(s.out()).toBe('enforce\n')
      const j = memoryIO()
      expect(await configRun(['get', 'routing.strictness', '--json'], j)).toBe(0)
      expect(j.out()).toBe('"enforce"\n')
      const l = memoryIO()
      expect(await configRun(['get', 'checkers.languages'], l)).toBe(0)
      expect(JSON.parse(l.out())).toEqual(['python', 'typescript', 'javascript', 'go', 'shell', 'dotnet'])
      const r = memoryIO()
      expect(await configRun(['get', 'repo'], r)).toBe(0)
      expect(r.out()).toBe(`${repo}\n`)
      const u = memoryIO()
      expect(await configRun(['get', 'nope.missing'], u)).toBe(1)
      expect(u.err()).toContain('unknown key: nope.missing')
      expect(u.out()).toBe('')
      const all = memoryIO()
      expect(await configRun(['get', '--json'], all)).toBe(0)
      expect(JSON.parse(all.out())).toMatchObject({ version: 1, routing: { strictness: 'enforce' } })
    })
  }))

  test('set validates, keeps comments, refreshes the runtime snapshot; unset restores the default', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    mkdirSync(buracleHome, { recursive: true })
    const file = join(buracleHome, 'config.yaml')
    writeFileSync(file, '# my settings\nrouting:\n  strictness: enforce   # strict by default\n')
    await withDeps({ repoRoot: () => repo }, async () => {
      const io = memoryIO()
      expect(await configRun(['set', 'routing.strictness', 'nudge'], io)).toBe(0)
      expect(read(file)).toBe('# my settings\nrouting:\n  strictness: nudge   # strict by default\n')
      const snap = JSON.parse(read(join(buracleHome, 'state/runtime-config.json'))) as { config: { routing: { strictness: string } } }
      expect(snap.config.routing.strictness).toBe('nudge')

      expect(await configRun(['set', 'harnesses.codex.enabled', 'false'], memoryIO())).toBe(0)
      const g = memoryIO()
      await configRun(['get', 'harnesses.codex.enabled'], g)
      expect(g.out()).toBe('false\n')

      const bad = memoryIO()
      expect(await configRun(['set', 'routing.strictness', 'loose'], bad)).toBe(1)
      expect(bad.err()).toContain('routing.strictness: expected one of enforce | nudge | off')
      const cross = memoryIO()
      expect(await configRun(['set', 'context.warnPct', '99'], cross)).toBe(1)
      expect(cross.err()).toContain('must be lower than context.criticalPct')
      const unknown = memoryIO()
      expect(await configRun(['set', 'nope.missing', '1'], unknown)).toBe(1)
      expect(read(file)).toContain('strictness: nudge')

      expect(await configRun(['set', 'plan.worktreeDir', '2026'], memoryIO())).toBe(0)
      const w = memoryIO()
      await configRun(['get', 'plan.worktreeDir', '--json'], w)
      expect(w.out()).toBe('"2026"\n')

      expect(await configRun(['unset', 'routing.strictness'], memoryIO())).toBe(0)
      const d = memoryIO()
      await configRun(['get', 'routing.strictness'], d)
      expect(d.out()).toBe('enforce\n')

      const p = memoryIO()
      expect(await configRun(['path'], p)).toBe(0)
      expect(p.out()).toBe(`${file}\n`)
    })
  }))

  test('set and unset of a key the install writes into the harnesses say to run `buracle install` (plain and JSON)', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo }, async () => {
      const hint = 'run `buracle install` to apply it to the harnesses'
      const plain = memoryIO()
      expect(await configRun(['set', 'permissions.bypass', 'false'], plain)).toBe(0)
      expect(plain.out()).toContain('permissions.bypass = false')
      expect(plain.out()).toContain(`Next: ${hint}.\n`)
      const j = memoryIO()
      expect(await configRun(['set', 'effort.codex', 'high', '--json'], j)).toBe(0)
      expect(JSON.parse(j.out())).toMatchObject({ ok: true, key: 'effort.codex', value: 'high', changed: true, sync: true, hint })
      for (const [key, value] of [['harnesses.omp.enabled', 'false'], ['routing.strictness', 'nudge'], ['agents.teams', 'false']] as const) {
        const io = memoryIO()
        expect(await configRun(['set', key, value], io)).toBe(0)
        expect(io.out()).toContain(hint)
      }
      const same = memoryIO()
      expect(await configRun(['set', 'permissions.bypass', 'false'], same)).toBe(0)
      expect(same.out()).toBe('permissions.bypass is already false\n')
      for (const [key, value] of [['statusline.emoji', 'false'], ['routing.reminders', 'false']] as const) {
        const io = memoryIO()
        expect(await configRun(['set', key, value], io)).toBe(0)
        expect(io.out()).not.toContain('buracle install')
        const jj = memoryIO()
        expect(await configRun(['unset', key, '--json'], jj)).toBe(0)
        expect(JSON.parse(jj.out())).toEqual({ ok: true, key, changed: true })
      }
      const u = memoryIO()
      expect(await configRun(['unset', 'effort.codex'], u)).toBe(0)
      expect(u.out()).toContain(`Next: ${hint}.\n`)
      const uj = memoryIO()
      expect(await configRun(['unset', 'permissions.bypass', '--json'], uj)).toBe(0)
      expect(JSON.parse(uj.out())).toEqual({ ok: true, key: 'permissions.bypass', changed: true, sync: true, hint })
      const none = memoryIO()
      expect(await configRun(['unset', 'permissions.bypass'], none)).toBe(0)
      expect(none.out()).not.toContain('buracle install')
    })
  }))

  test('set creates config.yaml when missing; pre-existing invalid values do not block other keys', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo }, async () => {
      expect(await setConfigValue('vault', '~/Obsidian/Buracle')).toEqual({ ok: true, changed: true })
      expect(read(join(buracleHome, 'config.yaml'))).toBe('vault: ~/Obsidian/Buracle\n')
      writeFileSync(join(buracleHome, 'config.yaml'), 'vault: ~/Obsidian/Buracle\nplan:\n  stopGuard: maybe\n')
      expect(await configRun(['set', 'statusline.emoji', 'false'], memoryIO())).toBe(0)
      expect(read(join(buracleHome, 'config.yaml'))).toContain('emoji: false')
      expect(await configRun(['frobnicate'], memoryIO())).toBe(1)
    })
  }))
})
