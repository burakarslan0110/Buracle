import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as installRun } from '../../../src/cli/commands/install'
import { run as uninstallRun } from '../../../src/cli/commands/uninstall'
import { cmHome } from '../../../src/engine/context-mode'
import { readJournal, readLedger, rollbackTxn, type Plan } from '../../../src/engine/txn'
import { readInstallRecord } from '../../../src/engine/update/install-core'
import { execUndos } from '../../../src/engine/update/uninstall'
import { fakeExe } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, makeRepo, memoryIO, withDeps } from './helpers'

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

interface Env { repo: string; tool: string; log: string; vault: string }

function setup(root: string, home: string): Env {
  const repo = makeRepo(root)
  const tool = fakeExe(join(root, 'bin', 'faketool'), `append(${JSON.stringify(join(root, 'tool.log'))}, argv.join(' '))\nif (argv[0] === 'fail') process.exit(3)`)
  const vault = join(home, 'Documents', 'Buracle')
  mkdirSync(vault, { recursive: true })
  writeFileSync(join(vault, 'note.md'), '# keep\n')
  return { repo, tool, log: join(root, 'tool.log'), vault }
}

function codexPlan(env: Env, home: string, extra: Plan['ops'] = []): Plan {
  return {
    id: 'codex',
    harness: 'codex',
    ops: [
      { kind: 'file', path: join(home, '.codex/hooks.json'), content: '{}\n', owner: 'codex' },
      { kind: 'file', path: join(home, '.codex/agents/review.toml'), content: 'x = 1\n', owner: 'codex' },
      { kind: 'json-merge', path: join(home, '.codex/settings.json'), set: { 'tui.status': 'buracle' }, owner: 'codex' },
      { kind: 'exec', argv: [env.tool, 'add', 'plugin'], undo: [env.tool, 'remove', 'plugin'], owner: 'codex' },
      ...extra,
    ],
  }
}

describe('buracle uninstall', () => {
  test('folders Buracle created are removed once empty; folders the user had or filled stay', () => withSandbox(async ({ root, home }) => {
    const env = setup(root, home)
    mkdirSync(join(home, '.codex'), { recursive: true })
    const plan: Plan = {
      id: 'codex',
      harness: 'codex',
      ops: [
        { kind: 'file', path: join(home, '.codex/agents/review.toml'), content: 'x = 1\n', owner: 'codex' },
        { kind: 'file', path: join(home, '.claude/rules/buracle/always/core.md'), content: '# core\n', owner: 'codex' },
        { kind: 'file', path: join(home, '.config/thing/buracle.md'), content: '# b\n', owner: 'codex' },
      ],
    }
    const codex = fakeAdapter('codex', { plan: () => plan })
    await withDeps({ repoRoot: () => env.repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      writeFileSync(join(home, '.config/thing/mine.md'), 'mine\n')
      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--json'], io)).toBe(0)
      const res = JSON.parse(io.out()) as { prunedDirs: string[] }
      for (const d of ['.codex/agents', '.claude', '.local/bin', '.local']) expect(existsSync(join(home, d))).toBe(false)
      expect(existsSync(join(home, '.codex'))).toBe(true)
      expect(read(join(home, '.config/thing/mine.md'))).toBe('mine\n')
      expect(read(join(env.vault, 'note.md'))).toBe('# keep\n')
      expect(res.prunedDirs).toContain('~/.claude/rules/buracle/always')
      expect(res.prunedDirs).toContain('~/.codex/agents')
      expect(res.prunedDirs).not.toContain('~/.codex')
      expect(res.prunedDirs.some(d => d.startsWith('~/.config'))).toBe(false)
    })
  }))

  test('removes what Buracle wrote, undoes its commands once, keeps user data and the vault', () => withSandbox(async ({ root, home, buracleHome }) => {
    const env = setup(root, home)
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex/settings.json'), '{"theme":"dark"}\n')
    const codex = fakeAdapter('codex', { plan: () => codexPlan(env, home) })
    await withDeps({ repoRoot: () => env.repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      expect(read(env.log)).toBe('add plugin\n')
      expect(existsSync(join(buracleHome, 'bin/buracle'))).toBe(true)

      const io = memoryIO()
      expect(await uninstallRun(['--yes'], io)).toBe(0)
      expect(read(env.log)).toBe('add plugin\nremove plugin\n')
      for (const p of ['.codex/hooks.json', '.codex/agents/review.toml', '.buracle/bin/buracle', '.local/bin/buracle']) expect(existsSync(join(home, p))).toBe(false)
      expect(JSON.parse(read(join(home, '.codex/settings.json')))).toEqual({ theme: 'dark' })
      expect(read(join(env.vault, 'note.md'))).toBe('# keep\n')
      expect(io.out()).toContain('Undid 1 command(s):')
      expect(io.out()).toContain('The memory at ~/.buracle/brain was not touched, nor the old vault at ~/Documents/Buracle.')
      expect(Object.keys(await readLedger())).toEqual([])
      expect(readInstallRecord().record.plans).toEqual({})

      const again = memoryIO()
      expect(await uninstallRun(['--yes'], again)).toBe(0)
      expect(again.out()).toContain('Nothing owned by Buracle needed removing.')
      expect(read(env.log)).toBe('add plugin\nremove plugin\n')
    })
  }))

  test('user-changed items are kept (exit 2); adopted values stay and are listed; vault entries are never removed', () => withSandbox(async ({ root, home }) => {
    const env = setup(root, home)
    mkdirSync(join(home, '.codex'), { recursive: true })
    writeFileSync(join(home, '.codex/adopted.txt'), 'same\n')
    const codex = fakeAdapter('codex', {
      plan: () => codexPlan(env, home, [
        { kind: 'file', path: join(home, '.codex/adopted.txt'), content: 'same\n', owner: 'codex' },
        { kind: 'file', path: join(env.vault, 'Buracle.base'), content: 'views: []\n', owner: 'codex' },
      ]),
    })
    await withDeps({ repoRoot: () => env.repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      writeFileSync(join(home, '.codex/hooks.json'), '{"mine":true}\n')
      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--json'], io)).toBe(2)
      const r = JSON.parse(io.out()) as { kept: Array<{ path: string }>, adopted: string[], protected: string[] }
      expect(r.kept.map(k => k.path)).toEqual([join(home, '.codex/hooks.json')])
      expect(read(join(home, '.codex/hooks.json'))).toBe('{"mine":true}\n')
      expect(r.adopted).toEqual(['~/.codex/adopted.txt'])
      expect(read(join(home, '.codex/adopted.txt'))).toBe('same\n')
      expect(r.protected).toEqual(['~/Documents/Buracle/Buracle.base'])
      expect(read(join(env.vault, 'Buracle.base'))).toBe('views: []\n')
    })
  }))

  test('--dry-run and a missing --yes change nothing', () => withSandbox(async ({ root, home }) => {
    const env = setup(root, home)
    const codex = fakeAdapter('codex', { plan: () => codexPlan(env, home) })
    await withDeps({ repoRoot: () => env.repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const dry = memoryIO()
      expect(await uninstallRun(['--dry-run'], dry)).toBe(0)
      expect(dry.out()).toContain('--- ~/.codex/hooks.json')
      expect(dry.out()).toContain(`  - ${env.tool} remove plugin`)
      const noYes = memoryIO()
      expect(await uninstallRun([], noYes)).toBe(2)
      expect(noYes.out()).toContain('Re-run with --yes')
      expect(existsSync(join(home, '.codex/hooks.json'))).toBe(true)
      expect(read(env.log)).toBe('add plugin\n')
    })
  }))

  test('--purge-state removes Buracle state but keeps config.yaml and the vault; a failed undo blocks the purge', () => withSandbox(async ({ root, home, buracleHome }) => {
    const env = setup(root, home)
    let failUndo = true
    const codex = fakeAdapter('codex', {
      plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'exec', argv: [env.tool, 'add', 'x'], undo: failUndo ? [env.tool, 'fail', 'x'] : [env.tool, 'remove', 'x'], owner: 'codex' }] }),
    })
    await withDeps({ repoRoot: () => env.repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const blocked = memoryIO()
      expect(await uninstallRun(['--yes', '--purge-state'], blocked)).toBe(2)
      expect(blocked.out()).toContain('Undo commands that failed')
      expect(blocked.out()).toContain('State was not purged')
      expect(existsSync(join(buracleHome, 'journal'))).toBe(true)
      const again = memoryIO()
      expect(await uninstallRun(['--yes', '--purge-state'], again)).toBe(2)
      expect(again.out()).toContain('in a terminal it asks whether to purge anyway')

      failUndo = false
      writeFileSync(join(buracleHome, 'config.yaml'), 'vault: ~/Documents/Buracle\nrouting: { strictness: nudge }\n')
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const io = memoryIO()
      expect(await uninstallRun(['--yes', '--purge-state'], io)).toBe(0)
      for (const d of ['state', 'journal', 'backups', 'bin']) expect(existsSync(join(buracleHome, d))).toBe(false)
      expect(existsSync(join(buracleHome, 'config.yaml'))).toBe(true)
      expect(read(join(env.vault, 'note.md'))).toBe('# keep\n')
    })
  }))

  test('--purge-state also removes Context Mode\'s storage; in a BURACLE_HOME that held other files before, only its known folders go', () => withSandbox(async ({ root, home, buracleHome }) => {
    const env = setup(root, home)
    const codex = fakeAdapter('codex', { plan: () => codexPlan(env, home) })
    const put = (p: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x') }
    await withDeps({ repoRoot: () => env.repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      for (const f of ['codex/app-0123456789ab/sessions/s.db', 'codex/app-0123456789ab/content/c.db', 'probe/sessions/stats-pid-1.json', 'sentinel/ready']) put(join(cmHome(), f))
      expect(cmHome()).toBe(join(buracleHome, 'context-mode'))
      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--purge-state', '--json'], io)).toBe(0)
      expect((JSON.parse(io.out()) as { purged: string[] }).purged).toContain('~/.buracle/context-mode')
      expect(existsSync(cmHome())).toBe(false)

      const tools = join(home, 'tools')
      put(join(tools, 'bin', 'my-tool'))
      await withEnv({ BURACLE_HOME: tools }, async () => {
        expect(await installRun(['--yes'], memoryIO())).toBe(0)
        for (const f of ['omp/app-0123456789ab/sessions/s.db', 'claude/x-0123456789ab/sessions/s.db', 'sentinel/ready', 'tmp/in-1-abc.json', 'notes.txt']) put(join(cmHome(), f))
        mkdirSync(join(cmHome(), 'claude-config-empty'), { recursive: true })
        const shared = memoryIO({ json: true })
        expect(await uninstallRun(['--yes', '--purge-state', '--json'], shared)).toBe(2)
        expect(readdirSync(cmHome())).toEqual(['notes.txt'])
        expect((JSON.parse(shared.out()) as { purgeKept: string[] }).purgeKept).toContain('~/tools/context-mode (not Buracle\'s: notes.txt)')
      })
    })
  }))

  test('--purge-state removes the frozen runtimes, their staging copies and the status caches; in a shared BURACLE_HOME only those entries go', () => withSandbox(async ({ root, home, buracleHome }) => {
    const env = setup(root, home)
    const codex = fakeAdapter('codex', { plan: () => codexPlan(env, home) })
    const put = (p: string) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, 'x') }
    const buracleOwn = (h: string) => [
      join(h, 'runtime', '0123456789abcdef', 'src', 'cli', 'main.ts'), join(h, 'runtime', '.staging-123-abc', 'package.json'),
      join(h, 'cache', 'hook-health.json'), join(h, 'cache', 'runtime-drift.json'),
      join(h, 'cache', 'claude-plan.json'), join(h, 'cache', 'harness-versions.json'), join(h, 'cache', 'skills', 'x', 'SKILL.md'), join(h, 'cache', 'npm', '_cacache', 'x'),
    ]
    await withDeps({ repoRoot: () => env.repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      for (const f of buracleOwn(buracleHome)) put(f)
      expect(await uninstallRun(['--yes', '--purge-state'], memoryIO())).toBe(0)
      expect(existsSync(join(buracleHome, 'runtime'))).toBe(false)
      expect(existsSync(join(buracleHome, 'cache'))).toBe(false)

      const tools = join(home, 'tools')
      put(join(tools, 'bin', 'my-tool'))
      await withEnv({ BURACLE_HOME: tools }, async () => {
        expect(await installRun(['--yes'], memoryIO())).toBe(0)
        for (const f of buracleOwn(tools)) put(f)
        put(join(tools, 'runtime', 'my-notes.txt'))
        put(join(tools, 'cache', 'other.json'))
        const io = memoryIO({ json: true })
        expect(await uninstallRun(['--yes', '--purge-state', '--json'], io)).toBe(2)
        expect(readdirSync(join(tools, 'runtime'))).toEqual(['my-notes.txt'])
        expect(readdirSync(join(tools, 'cache'))).toEqual(['other.json'])
        const kept = (JSON.parse(io.out()) as { purgeKept: string[] }).purgeKept
        expect(kept).toContain('~/tools/runtime (not Buracle\'s: my-notes.txt)')
        expect(kept).toContain('~/tools/cache (not Buracle\'s: other.json)')
      })
    })
  }))

  test('exec undo is derived from committed journals, newest run first, once per command', () => {
    const j = (txn: string, status: 'committed' | 'rolled-back', execs: Array<{ argv: string[], undo?: string[], ran: boolean, undone?: boolean }>, plan = 'codex') => ({ v: 1 as const, txn, status, startedAt: '', plans: [{ id: plan, harness: 'codex', ops: 1 }], files: [], createdDirs: [], execs, ledger: [] })
    const undos = execUndos([
      j('20260101T000000000Z-aaaaaa', 'committed', [{ argv: ['a'], undo: ['un-a'], ran: true }, { argv: ['b'], undo: ['un-b'], ran: true }, { argv: ['g'], undo: ['un-g'], ran: true }]),
      j('20260102T000000000Z-bbbbbb', 'committed', [{ argv: ['a'], undo: ['un-a2'], ran: true }, { argv: ['c'], ran: true }]),
      j('20260103T000000000Z-cccccc', 'rolled-back', [{ argv: ['d'], undo: ['un-d'], ran: true }]),
      j('20260104T000000000Z-dddddd', 'committed', [{ argv: ['e'], undo: ['un-e'], ran: true, undone: true }, { argv: ['f'], undo: ['un-f'], ran: false }]),
      j('20260105T000000000Z-eeeeee', 'committed', [{ argv: ['g'], undo: ['un-g'], ran: true, undone: true }]),
      j('20260106T000000000Z-ffffff', 'committed', [{ argv: ['un-a2'], undo: ['a'], ran: true }], 'uninstall-omp'),
    ], { v: 1, plans: {}, execUndone: { '["b"]': '20260101T000000000Z-aaaaaa' } })
    expect(undos).toEqual([{ argv: ['a'], undo: ['un-a2'], txn: '20260102T000000000Z-bbbbbb', owner: 'codex' }])
  })

  test('an adapter\'s uninstallPlan runs first; the install command it undoes is marked undone and never runs twice', () => withSandbox(async ({ root, home }) => {
    const env = setup(root, home)
    const config = join(home, '.omp/agent/config.yml')
    const moved = fakeExe(join(root, 'moved-bin', 'faketool'), `append(${JSON.stringify(env.log)}, argv.join(' '))`)
    let installTxn = ''
    const omp = fakeAdapter('omp', {
      plan: () => ({
        id: 'omp',
        harness: 'omp',
        ops: [
          { kind: 'yaml-merge', path: config, set: { 'memory.backend': 'off' }, owner: 'omp' },
          { kind: 'exec', argv: [env.tool, 'link', 'omp'], undo: [env.tool, 'unlink', 'omp'], owner: 'omp' },
        ],
      }),
      uninstall: () => ({
        id: 'omp-uninstall',
        harness: 'omp',
        ops: [
          { kind: 'remove', path: `${config}#memory.backend`, owner: 'omp' },
          { kind: 'exec', argv: [moved, 'unlink', 'omp'], owner: 'omp' },
        ],
      }),
    })
    await withDeps({ repoRoot: () => env.repo, adapters: async () => [omp], runCli: fakeCli().runCli }, async () => {
      const inst = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], inst)).toBe(0)
      installTxn = (JSON.parse(inst.out()) as { txns: Array<{ plan: string, txn: string }> }).txns.find(t => t.plan === 'omp')?.txn ?? ''
      expect(read(env.log)).toBe('link omp\n')

      const dry = memoryIO({ json: true })
      expect(await uninstallRun(['--dry-run', '--json'], dry)).toBe(0)
      const preview = JSON.parse(dry.out()) as { pendingUndos: string[], harnesses: string[], diff: string }
      expect(preview.harnesses).toEqual(['omp'])
      expect(preview.pendingUndos).toEqual([`${moved} unlink omp`])
      expect(preview.diff).toContain(`# exec: ${moved} unlink omp`)

      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--json'], io)).toBe(0)
      const r = JSON.parse(io.out()) as { harnesses: string[], undone: string[] }
      expect(r.harnesses).toEqual(['omp'])
      expect(r.undone).toEqual([`${moved} unlink omp`])
      expect(read(env.log)).toBe('link omp\nunlink omp\n')
      expect(existsSync(config)).toBe(false)
      expect(Object.keys(await readLedger())).toEqual([])
      expect((await readJournal(installTxn)).execs.map(e => e.undone === true)).toEqual([true])

      const before = omp.calls.filter(c => c === 'uninstallPlan').length
      const again = memoryIO()
      expect(await uninstallRun(['--yes'], again)).toBe(0)
      expect(again.out()).toContain('Nothing owned by Buracle needed removing.')
      expect(omp.calls.filter(c => c === 'uninstallPlan').length).toBe(before)
      expect(read(env.log)).toBe('link omp\nunlink omp\n')
      const rb = await rollbackTxn(installTxn)
      expect(rb.undone).toEqual([])
      expect(read(env.log)).toBe('link omp\nunlink omp\n')
    })
  }))

  test('a failing adapter uninstallPlan is a warning: the generic removal and the journal undo still clean up', () => withSandbox(async ({ root, home }) => {
    const env = setup(root, home)
    const omp = fakeAdapter('omp', {
      plan: () => ({ id: 'omp', harness: 'omp', ops: [{ kind: 'exec', argv: [env.tool, 'link', 'omp'], undo: [env.tool, 'unlink', 'omp'], owner: 'omp' }, { kind: 'file', path: join(home, '.omp/agent/AGENTS.md'), content: 'x\n', owner: 'omp' }] }),
      uninstall: () => { throw new Error('omp is not on PATH') },
    })
    await withDeps({ repoRoot: () => env.repo, adapters: async () => [omp], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const io = memoryIO()
      expect(await uninstallRun(['--yes'], io)).toBe(2)
      expect(io.err()).toContain('warning: omp: its uninstall plan failed (omp is not on PATH)')
      expect(read(env.log)).toBe('link omp\nunlink omp\n')
      expect(existsSync(join(home, '.omp/agent/AGENTS.md'))).toBe(false)
    })
  }))

  test('the core plan\'s path rules are removed with their now-empty directories; a rule the user edited stays', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root, {
      'canonical/rules/paths/python.md': '---\npaths: ["**/*.py"]\n---\n# Python\n\nRun the formatter.\n',
      'canonical/rules/paths/go.md': '---\npaths: ["**/*.go"]\n---\n# Go\n\nRun go vet.\n',
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      expect(existsSync(join(buracleHome, 'rules/paths/python.md'))).toBe(true)
      expect(await uninstallRun(['--yes'], memoryIO())).toBe(0)
      expect(existsSync(join(buracleHome, 'rules'))).toBe(false)

      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      writeFileSync(join(buracleHome, 'rules/paths/go.md'), '# my own go notes\n')
      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--json'], io)).toBe(2)
      expect((JSON.parse(io.out()) as { kept: Array<{ path: string }> }).kept.map(k => k.path)).toEqual([join(buracleHome, 'rules/paths/go.md')])
      expect(read(join(buracleHome, 'rules/paths/go.md'))).toBe('# my own go notes\n')
      expect(existsSync(join(buracleHome, 'rules/paths/python.md'))).toBe(false)
    })
  }))

  test('HOME problems are refused before anything happens', () => withSandbox(async ({ root }) => {
    await withDeps({ repoRoot: () => makeRepo(root) }, async () => {
      const io = memoryIO()
      expect(await withEnv({ HOME: 'not/absolute' }, () => uninstallRun(['--yes'], io))).toBe(1)
      expect(io.err()).toContain('HOME must be an absolute path')
    })
  }))
})
