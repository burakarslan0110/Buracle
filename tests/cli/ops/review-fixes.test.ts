import { describe, expect, test } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { run as doctorRun } from '../../../src/cli/commands/doctor'
import { run as installRun } from '../../../src/cli/commands/install'
import { run as rollbackRun } from '../../../src/cli/commands/rollback'
import { run as uninstallRun } from '../../../src/cli/commands/uninstall'
import { main } from '../../../src/cli/router'
import { yamlParse } from '../../../src/engine/merge'
import { cleanupLedgerKey, listTxns, readLedger, type Plan } from '../../../src/engine/txn'
import { readInstallRecord } from '../../../src/engine/update/install-core'
import { sortOutUndos } from '../../../src/engine/update/uninstall'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, makeRepo, memoryIO, withDeps, writeExe } from './helpers'

const REPO = join(import.meta.dir, '..', '..', '..')

function read(p: string): string {
  return readFileSync(p, 'utf8')
}
function write(p: string, text: string): void {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}
function filePlan(h: 'claude' | 'codex' | 'opencode' | 'omp', home: string, files: Record<string, string>, extra: Plan['ops'] = []): Plan {
  return { id: h, harness: h, ops: [...Object.entries(files).map(([rel, content]) => ({ kind: 'file' as const, path: join(home, rel), content, owner: h })), ...extra] }
}

describe('I2: one transaction for the core plans, then one per harness', () => {
  test('a failing harness is rolled back alone (exit 2); the others and the core stay installed; one run id', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => filePlan('codex', home, { '.codex/AGENTS.md': 'codex\n' }) })
    const omp = fakeAdapter('omp', { plan: () => filePlan('omp', home, { '.omp/agent/AGENTS.md': 'omp\n' }, [{ kind: 'exec', argv: ['sh', '-c', 'echo boom >&2; exit 3'], owner: 'omp' }]) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex, omp], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], io)).toBe(2)
      const r = JSON.parse(io.out()) as { run: string, txns: Array<{ plan: string, txn: string, error?: string }>, errors: Array<{ source: string }>, steps: string[] }
      expect(r.txns.map(t => t.plan)).toEqual(['core', 'codex', 'omp'])
      expect(r.txns.find(t => t.plan === 'omp')?.error).toContain('rolled back')
      expect(r.errors.map(e => e.source)).toEqual(['omp'])
      expect(read(join(home, '.codex/AGENTS.md'))).toBe('codex\n')
      expect(existsSync(join(buracleHome, 'bin/buracle'))).toBe(true)
      expect(existsSync(join(home, '.omp/agent/AGENTS.md'))).toBe(false)
      expect(r.steps.some(s => s.startsWith('omp: its transaction failed'))).toBe(true)
      const journals = await listTxns()
      expect(new Set(journals.map(j => j.run))).toEqual(new Set([r.run]))
      expect(journals.map(j => j.status).sort()).toEqual(['committed', 'committed', 'rolled-back'])
      expect(Object.keys(readInstallRecord().record.plans).sort()).toEqual(['agents-skills', 'codex', 'core'])
    })
  }))

  test('a failing soft command is a warning (exit 2); the harness stays installed', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const claude = fakeAdapter('claude', { plan: () => filePlan('claude', home, { '.claude/rules/buracle/core.md': '# r\n' }, [{ kind: 'exec', argv: ['sh', '-c', 'echo "unable to reach github.com" >&2; exit 1'], owner: 'claude', soft: true }]) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO()
      expect(await installRun(['--yes'], io)).toBe(2)
      expect(io.err()).toContain('unable to reach github.com')
      expect(read(join(home, '.claude/rules/buracle/core.md'))).toBe('# r\n')
    })
  }))
})

describe('F05: BURACLE_HOME must be a directory of its own; purge removes only Buracle\'s files', () => {
  test('HOME, a directory above HOME and shared directories are refused', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      for (const bh of [home, root, join(home, '.local'), join(home, '.config'), join(home, 'Library')]) {
        const io = memoryIO()
        expect(await withEnv({ BURACLE_HOME: bh }, () => installRun(['--yes'], io))).toBe(1)
        expect(io.err()).toContain('point BURACLE_HOME at a directory of its own')
      }
      expect(existsSync(join(home, 'bin'))).toBe(false)
      expect(existsSync(join(home, '.local/bin'))).toBe(false)
    })
  }))

  test('in a pre-existing directory, purge removes Buracle\'s files and keeps the user\'s', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const tools = join(home, 'tools')
    write(join(tools, 'bin', 'my-tool'), '#!/bin/sh\n')
    write(join(tools, 'state', 'someapp', 'history.db'), 'data')
    await withEnv({ BURACLE_HOME: tools }, () => withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      expect(existsSync(join(tools, 'bin', 'buracle'))).toBe(true)
      expect(existsSync(join(tools, '.buracle-home'))).toBe(false)
      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--purge-state', '--json'], io)).toBe(2)
      const r = JSON.parse(io.out()) as { purged: string[], purgeKept: string[] }
      expect(read(join(tools, 'bin', 'my-tool'))).toBe('#!/bin/sh\n')
      expect(read(join(tools, 'state', 'someapp', 'history.db'))).toBe('data')
      expect(existsSync(join(tools, 'bin', 'buracle'))).toBe(false)
      expect(existsSync(join(tools, 'state', 'owned.json'))).toBe(false)
      expect(existsSync(join(tools, 'journal'))).toBe(false)
      expect(r.purgeKept.some(k => k.includes('not Buracle\'s: my-tool'))).toBe(true)
    }))
  }))

  test('purge is refused outright for a shared BURACLE_HOME (an install made before this check)', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const local = join(home, '.local')
    write(join(local, 'bin', 'my-tool'), '#!/bin/sh\n')
    write(join(local, 'state', 'someapp', 'history.db'), 'data')
    write(join(local, 'state', 'owned.json'), '{}\n')
    await withEnv({ BURACLE_HOME: local }, () => withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--purge-state', '--json'], io)).toBe(2)
      const r = JSON.parse(io.out()) as { purged: string[], notes: string[] }
      expect(r.purged).toEqual([])
      expect(r.notes.some(n => n.startsWith('State was not purged: BURACLE_HOME (~/.local) is a directory other programs share'))).toBe(true)
      expect(read(join(local, 'bin', 'my-tool'))).toBe('#!/bin/sh\n')
      expect(read(join(local, 'state', 'someapp', 'history.db'))).toBe('data')
    }))
  }))

  test('a BURACLE_HOME Buracle created is marked and purged as a whole', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const bh = join(home, '.config', 'buracle')
    await withEnv({ BURACLE_HOME: bh }, () => withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      expect(existsSync(join(bh, '.buracle-home'))).toBe(true)
      expect(await uninstallRun(['--yes', '--purge-state'], memoryIO())).toBe(0)
      expect(readdirSync(bh).sort()).toEqual([])
    }))
  }))
})

describe('F09: uninstall takes the transaction lock before anything runs', () => {
  test('while another Buracle transaction holds the lock, no undo command runs', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const log = join(root, 'tool.log')
    const tool = writeExe(join(root, 'bin', 'tool'), `echo "$@" >> '${log}'`)
    const codex = fakeAdapter('codex', { plan: () => filePlan('codex', home, { '.codex/AGENTS.md': 'x\n' }, [{ kind: 'exec', argv: [tool, 'add'], undo: [tool, 'remove'], owner: 'codex' }]) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const holder = Bun.spawn([process.execPath, '-e', 'setTimeout(() => {}, 20000)'], { stdout: 'ignore', stderr: 'ignore' })
      try {
        await Bun.sleep(1100)
        const etime = Bun.spawnSync(['ps', '-o', 'etime=', '-p', String(holder.pid)]).stdout.toString().trim()
        const [mm, ss] = etime.split(':').slice(-2).map(Number)
        write(join(buracleHome, 'state', 'txn.lock'), JSON.stringify({ pid: holder.pid, startedAt: Date.now() - ((mm ?? 0) * 60 + (ss ?? 0)) * 1000 }) + '\n')
        const io = memoryIO()
        expect(await uninstallRun(['--yes'], io)).toBe(1)
        expect(io.err()).toContain('another Buracle transaction is running')
        expect(read(log)).toBe('add\n')
        expect(read(join(home, '.codex/AGENTS.md'))).toBe('x\n')
      } finally {
        holder.kill('SIGKILL')
        await holder.exited
      }
      expect(await uninstallRun(['--yes'], memoryIO())).toBe(0)
      expect(read(log)).toBe('add\nremove\n')
    })
  }), 30_000)
})

describe('F11: the user\'s own config.yaml keys stay after uninstall', () => {
  test('uninstall removes repo: only; a reinstall keeps the user\'s keys', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    write(join(buracleHome, 'config.yaml'), 'routing:\n  strictness: nudge\n')
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes', '--json'], memoryIO())).toBe(0)
      expect(yamlParse(read(join(buracleHome, 'config.yaml')))).toEqual({ routing: { strictness: 'nudge' }, repo })
      expect(await uninstallRun(['--yes'], memoryIO())).toBe(0)
      expect(yamlParse(read(join(buracleHome, 'config.yaml')))).toEqual({ routing: { strictness: 'nudge' } })
      expect(await readLedger()).toEqual({})
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      expect(yamlParse(read(join(buracleHome, 'config.yaml')))).toEqual({ routing: { strictness: 'nudge' }, repo })
    })
  }))
})

describe('F12: a lost ownership ledger', () => {
  test('is rebuilt from the journals: nothing is adopted, uninstall removes everything', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => filePlan('codex', home, { '.codex/rules/buracle.rules': 'r\n', '.codex/agents/a.toml': 'a\n' }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      unlinkSync(join(buracleHome, 'state', 'owned.json'))
      const io = memoryIO({ json: true })
      expect(await installRun(['--yes', '--json'], io)).toBe(0)
      const r = JSON.parse(io.out()) as { adopted: string[], warnings: string[] }
      expect(r.adopted).toEqual([])
      expect(r.warnings.some(w => w.includes('was missing; it was rebuilt from'))).toBe(true)
      const u = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--json'], u)).toBe(0)
      expect((JSON.parse(u.out()) as { adopted: string[] }).adopted).toEqual([])
      expect(existsSync(join(home, '.codex/rules/buracle.rules'))).toBe(false)
      expect(existsSync(join(buracleHome, 'bin/buracle'))).toBe(false)
    })
  }))

  test('without journals it warns; a yes to the question in a terminal re-owns values equal to Buracle\'s', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => filePlan('codex', home, { '.codex/rules/buracle.rules': 'r\n' }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      rmSync(join(buracleHome, 'state', 'owned.json'))
      rmSync(join(buracleHome, 'journal'), { recursive: true })
      const warned = memoryIO()
      expect(await installRun(['--yes', '--dry-run'], warned)).toBe(0)
      expect(warned.err()).toContain('run `buracle install` in a terminal and say yes when it asks')
      const asked: string[] = []
      await withDeps({ confirm: async q => { asked.push(q); return true } }, async () => {
        const io = memoryIO({ tty: true, json: true })
        expect(await installRun([], { ...io, flags: { json: false, verbose: false } })).toBe(0)
      })
      expect(asked[0]).toBe('The ownership ledger is gone; record the values that equal Buracle\'s as Buracle\'s own?')
      expect((await readLedger())[join(home, '.codex/rules/buracle.rules')]?.adopted).toBeUndefined()
      expect(await uninstallRun(['--yes'], memoryIO())).toBe(0)
      expect(existsSync(join(home, '.codex/rules/buracle.rules'))).toBe(false)
    })
  }))
})

describe('F13: items the user deleted', () => {
  test('stay deleted and are reported; a yes in a terminal puts them back; the shim is always restored', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => filePlan('codex', home, { '.codex/agents/browser.toml': 'b\n' }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      unlinkSync(join(home, '.codex/agents/browser.toml'))
      unlinkSync(join(buracleHome, 'bin/buracle'))
      const io = memoryIO()
      expect(await installRun(['--yes'], io)).toBe(2)
      expect(io.out()).toContain('removed since Buracle installed it; not re-creating it')
      expect(io.out()).toContain('1 Buracle item(s) you removed stay removed; run `buracle install` in a terminal to put them back.')
      expect(existsSync(join(home, '.codex/agents/browser.toml'))).toBe(false)
      expect(existsSync(join(buracleHome, 'bin/buracle'))).toBe(true)
      const asked: string[] = []
      let answer = false
      await withDeps({ confirm: async q => { asked.push(q); return answer } }, async () => {
        expect(await installRun([], memoryIO({ tty: true }))).toBe(2)
        expect(existsSync(join(home, '.codex/agents/browser.toml'))).toBe(false)
        answer = true
        expect(await installRun([], memoryIO({ tty: true }))).toBe(0)
      })
      expect(asked).toEqual(['Put back 1 Buracle item(s) you removed?', 'Put back 1 Buracle item(s) you removed?'])
      expect(read(join(home, '.codex/agents/browser.toml'))).toBe('b\n')
    })
  }))
})

describe('F18: a moved checkout', () => {
  test('the repoint-back undo is skipped (recorded as done); uninstall and purge complete', () => withSandbox(async ({ root, home, buracleHome }) => {
    const log = join(root, 'claude.log')
    const claudeBin = writeExe(join(root, 'bin', 'claude'), `echo "$@" >> '${log}'\nif [ "$3" = "add" ] && [ ! -e "$4" ]; then echo "Invalid marketplace source $4" >&2; exit 1; fi\nexit 0`)
    const repoA = makeRepo(join(root, 'a'))
    const repoB = makeRepo(join(root, 'b'))
    let repo = repoA
    let previous: string | undefined
    const claude = fakeAdapter('claude', {
      plan: () => filePlan('claude', home, { '.claude/rules/buracle/core.md': '# r\n' }, [{
        kind: 'exec', owner: 'claude',
        argv: [claudeBin, 'plugin', 'marketplace', 'add', repo],
        undo: previous !== undefined ? [claudeBin, 'plugin', 'marketplace', 'add', previous] : [claudeBin, 'plugin', 'marketplace', 'remove', 'buracle'],
      }]),
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      rmSync(repoA, { recursive: true })
      previous = repoA
      repo = repoB
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--purge-state', '--json'], io)).toBe(0)
      const r = JSON.parse(io.out()) as { undone: string[], undoFailed: unknown[], undoSkipped: Array<{ command: string }>, purged: string[] }
      expect(r.undoFailed).toEqual([])
      expect(r.undoSkipped.map(s => s.command)).toEqual([`${claudeBin} plugin marketplace add ${repoA}`])
      expect(r.undone).toEqual([`${claudeBin} plugin marketplace remove buracle`])
      expect(r.purged.length).toBeGreaterThan(0)
      expect(existsSync(join(buracleHome, 'state'))).toBe(false)
    })
  }))
})

describe('F18: which undo commands a full uninstall needs', () => {
  test('a newer undo that re-runs an older command, or restores a path that is gone, is not run', () => withSandbox(async ({ root }) => {
    const gone = join(root, 'old-checkout')
    const here = join(root, 'checkout')
    mkdirSync(here)
    const r = sortOutUndos([
      { argv: ['/bin/claude', 'plugin', 'marketplace', 'add', here], undo: ['/usr/local/bin/claude', 'plugin', 'marketplace', 'add', gone], txn: 't2' },
      { argv: ['/bin/claude', 'plugin', 'marketplace', 'add', gone], undo: ['/bin/claude', 'plugin', 'marketplace', 'remove', 'buracle'], txn: 't1' },
      { argv: ['/bin/omp', 'plugin', 'link', here], undo: ['/bin/omp', 'plugin', 'link', join(root, 'also-gone')], txn: 't0' },
      { argv: ['/bin/x', 'add', here], undo: ['/bin/x', 'add', root], txn: 't0' },
    ])
    expect(r.run.map(u => u.txn)).toEqual(['t1', 't0'])
    expect(r.run[1]?.argv[0]).toBe('/bin/x')
    expect(r.obsolete.map(o => o.reason)).toEqual([
      expect.stringContaining('superseded'),
      `${join(root, 'also-gone')} no longer exists; nothing to put back`,
    ])
  }))
})

describe('F19: a config symlinked outside HOME', () => {
  test('uninstall removes everything else and keeps that file (exit 2)', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: [
      { kind: 'toml-tables', path: join(home, '.codex/config.toml'), tables: { 'mcp_servers.c7': { command: 'npx' } }, owner: 'codex' },
      { kind: 'file', path: join(home, '.codex/agents/a.toml'), content: 'a\n', owner: 'codex' },
    ] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const ext = join(root, 'dotfiles', 'config.toml')
      mkdirSync(dirname(ext), { recursive: true })
      renameSync(join(home, '.codex/config.toml'), ext)
      symlinkSync(ext, join(home, '.codex/config.toml'))
      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--json'], io)).toBe(2)
      const r = JSON.parse(io.out()) as { kept: Array<{ detail: string }> }
      expect(r.kept.map(k => k.detail).join('\n')).toContain('outside HOME')
      expect(existsSync(join(home, '.codex/agents/a.toml'))).toBe(false)
      expect(read(ext)).toContain('[mcp_servers.c7]')
    })
  }))
})

describe('F21: rollback without an id', () => {
  test('undoes the whole newest install run, and refuses to pick an uninstall', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => filePlan('codex', home, { '.codex/AGENTS.md': 'x\n' }) })
    const omp = fakeAdapter('omp', { plan: () => filePlan('omp', home, { '.omp/agent/AGENTS.md': 'y\n' }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex, omp], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const io = memoryIO({ json: true })
      expect(await rollbackRun(['--json'], io)).toBe(0)
      expect((JSON.parse(io.out()) as { txns: string[] }).txns).toHaveLength(3)
      expect(existsSync(join(home, '.codex/AGENTS.md'))).toBe(false)
      expect(existsSync(join(home, '.omp/agent/AGENTS.md'))).toBe(false)
      expect(existsSync(join(buracleHome, 'bin/buracle'))).toBe(false)

      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      expect(await uninstallRun(['--yes'], memoryIO())).toBe(0)
      const refused = memoryIO()
      expect(await rollbackRun([], refused)).toBe(1)
      expect(refused.err()).toContain('was made by `buracle uninstall`')
      expect(refused.err()).toContain('buracle install')
      expect(existsSync(join(home, '.codex/AGENTS.md'))).toBe(false)
    })
  }))
})

describe('D3: a running harness during uninstall', () => {
  test('its uninstall plan refuses (HARNESS_BUSY): that harness is left alone (exit 2) and state is not purged', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', {
      plan: () => filePlan('codex', home, { '.codex/AGENTS.md': 'x\n' }),
      uninstall: (ctx) => {
        if ((ctx as { force?: boolean }).force !== true) throw Object.assign(new Error('Codex is running (pid 7).'), { code: 'HARNESS_BUSY' })
        return { id: 'codex-uninstall', harness: 'codex', ops: [] }
      },
    })
    const omp = fakeAdapter('omp', { plan: () => filePlan('omp', home, { '.omp/agent/AGENTS.md': 'y\n' }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex, omp], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--purge-state', '--json'], io)).toBe(2)
      const r = JSON.parse(io.out()) as { busy: string[], notes: string[] }
      expect(r.busy).toEqual(['codex'])
      expect(r.notes.some(n => n.includes('Codex is running (pid 7).') && n.includes('quit it'))).toBe(true)
      expect(read(join(home, '.codex/AGENTS.md'))).toBe('x\n')
      expect(existsSync(join(home, '.omp/agent/AGENTS.md'))).toBe(false)
      expect(existsSync(join(buracleHome, 'state', 'owned.json'))).toBe(true)
      expect(await uninstallRun(['--yes', '--force'], memoryIO())).toBe(1)
      const asked: string[] = []
      await withDeps({ confirm: async q => { asked.push(q); return true } }, async () => {
        expect(await uninstallRun([], memoryIO({ tty: true }))).toBe(0)
      })
      expect(asked[0]).toBe('codex is running; change its config anyway?')
      expect(existsSync(join(home, '.codex/AGENTS.md'))).toBe(false)
    })
  }))

  test('a yes to the running harness does not answer the purge question: after a failed step it is still asked, and a no keeps the state', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', {
      plan: () => filePlan('codex', home, { '.codex/AGENTS.md': 'x\n' }),
      uninstall: (ctx) => {
        if ((ctx as { force?: boolean }).force !== true) throw Object.assign(new Error('Codex is running (pid 7).'), { code: 'HARNESS_BUSY' })
        return { id: 'codex-uninstall', harness: 'codex', ops: [] }
      },
    })
    const omp = fakeAdapter('omp', {
      plan: () => ({ id: 'omp', harness: 'omp', ops: [{ kind: 'exec', argv: [process.execPath, '-e', '0'], undo: [process.execPath, '-e', 'process.exit(3)'], owner: 'omp' }] }),
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex, omp], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const asked: string[] = []
      await withDeps({ confirm: async q => { asked.push(q); return !q.startsWith('Delete state') } }, async () => {
        await uninstallRun(['--purge-state'], memoryIO({ tty: true }))
      })
      expect(asked[0]).toBe('codex is running; change its config anyway?')
      expect(asked.some(q => /^Delete state even though \d+ step\(s\) failed\?$/.test(q))).toBe(true)
      expect(existsSync(join(buracleHome, 'state', 'owned.json'))).toBe(true)
    })
  }))
})

describe('I3: empty leftovers of harness commands', () => {
  test('a cleanup key absent before the first install goes once its command\'s undo emptied it', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const settings = join(home, '.claude', 'settings.json')
    write(settings, '{\n  "model": "opus"\n}\n')
    const edit = (fn: string) => [process.execPath, '-e', `const fs=require('fs');const p=${JSON.stringify(settings)};const s=JSON.parse(fs.readFileSync(p,'utf8'));fs.writeFileSync(p,JSON.stringify((${fn}),null,2)+'\\n')`]
    const claude = fakeAdapter('claude', {
      plan: () => ({
        id: 'claude', harness: 'claude',
        ops: [
          { kind: 'json-merge', path: settings, set: { statusLine: { type: 'command', command: 'x' } }, owner: 'claude' },
          { kind: 'exec', argv: edit('({...s, enabledPlugins: {"buracle@buracle": true}})'), undo: edit('({...s, enabledPlugins: {}})'), owner: 'claude' },
        ],
        cleanupKeys: [{ path: settings, pointer: 'enabledPlugins' }, { path: settings, pointer: 'extraKnownMarketplaces' }],
      }),
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      expect((await readLedger())[cleanupLedgerKey(settings, 'enabledPlugins')]?.absentBefore).toBe(true)
      expect(readInstallRecord().record.plans['claude']?.keys).toContain(cleanupLedgerKey(settings, 'enabledPlugins'))
      expect(await uninstallRun(['--yes'], memoryIO())).toBe(0)
      expect(read(settings)).toBe('{\n  "model": "opus"\n}\n')
    })
  }))
})

describe('I8: commands that run the shim must find it', () => {
  test('install and doctor report a hook command that runs a shim that does not exist', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const bh = join(home, '.config', 'buracle')
    const hooks = join(home, '.codex', 'hooks.json')
    let command = '"$HOME/.buracle/bin/buracle" hook codex PreToolUse'
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: hooks, content: JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command }] }] } }) + '\n', owner: 'codex' }] }) })
    await withEnv({ BURACLE_HOME: bh }, () => withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO()
      expect(await installRun(['--yes'], io)).toBe(2)
      expect(io.err()).toContain('~/.codex/hooks.json runs $HOME/.buracle/bin/buracle')
      expect(io.err()).toContain('which does not exist')
      const doc = memoryIO({ json: true })
      expect(await doctorRun(['config', '--json'], doc)).toBe(1)
      const checks = (JSON.parse(doc.out()) as { checks: Array<{ check: string, level: string }> }).checks
      expect(checks.some(c => c.check === 'shim-refs' && c.level === 'error')).toBe(true)
      command = '"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" hook codex PreToolUse'
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const ok = memoryIO({ json: true })
      await doctorRun(['config', '--json'], ok)
      const after = (JSON.parse(ok.out()) as { checks: Array<{ check: string, level: string }> }).checks
      expect(after.filter(c => c.check === 'shim-refs').map(c => c.level)).toEqual(['ok'])
    }))
  }))
})

describe('I8: the Claude plugin files that start the shim (final verification)', () => {
  test('${CLAUDE_PLUGIN_ROOT} in the plugin\'s hooks is the plugin directory; its launcher must reach the shim', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    for (const rel of ['harness/claude/.mcp.json', 'harness/claude/hooks/hooks.json', 'harness/claude/bin/buracle', 'harness/claude/bin/buracle.ts']) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true })
      copyFileSync(join(REPO, rel), join(repo, rel))
      chmodSync(join(repo, rel), 0o755)
    }
    const claude = fakeAdapter('claude', { plan: () => filePlan('claude', home, { '.claude/rules/buracle/core.md': '# r\n' }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude], runCli: fakeCli().runCli }, async () => {
      const io = memoryIO()
      expect(await installRun(['--yes'], io)).toBe(0)
      expect(io.err()).not.toContain('CLAUDE_PLUGIN_ROOT')
      const doc = memoryIO({ json: true })
      await doctorRun(['config', '--json'], doc)
      const checks = (JSON.parse(doc.out()) as { checks: Array<{ check: string, level: string, detail: string }> }).checks
      expect(checks.filter(c => c.check === 'shim-refs').map(c => c.level)).toEqual(['ok'])
      rmSync(join(buracleHome, 'bin', 'buracle'))
      const gone = memoryIO({ json: true })
      expect(await doctorRun(['config', '--json'], gone)).toBe(1)
      const refs = (JSON.parse(gone.out()) as { checks: Array<{ check: string, level: string, detail: string }> }).checks.filter(c => c.check === 'shim-refs')
      expect(refs.length).toBeGreaterThan(0)
      expect(refs.every(c => c.level === 'error')).toBe(true)
      expect(refs.some(c => c.detail.includes('hooks.json'))).toBe(false)
      expect(refs.some(c => c.detail.includes(join('claude', 'bin', 'buracle')))).toBe(true)
      expect(refs.some(c => c.detail.includes('not set here'))).toBe(false)
    })
  }))
})

describe('WF-06: a hand edit of config.yaml reaches the runtime snapshot', () => {
  test('hook, statusline, install and config refresh runtime-config.json; resolved.* is kept', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const snapFile = join(buracleHome, 'state', 'runtime-config.json')
      const before = JSON.parse(read(snapFile)) as { config: { plan: { stopGuard: boolean } }, resolved: Record<string, string> }
      expect(before.config.plan.stopGuard).toBe(true)
      await Bun.sleep(20)
      const cfg = join(buracleHome, 'config.yaml')
      writeFileSync(cfg, `${read(cfg)}plan:\n  stopGuard: false\n`)
      const io = memoryIO()
      expect(await main(['config', 'get', 'plan.stopGuard'], io)).toBe(0)
      expect(io.out()).toBe('false\n')
      const after = JSON.parse(read(snapFile)) as { config: { plan: { stopGuard: boolean } }, resolved: Record<string, string> }
      expect(after.config.plan.stopGuard).toBe(false)
      expect(after.resolved).toEqual(before.resolved)
      await Bun.sleep(20)
      writeFileSync(cfg, 'plan: [unclosed\n')
      await main(['hook', 'claude', 'Nope'], { ...memoryIO(), stdin: { isTTY: false, text: async () => '{}' } })
      expect((JSON.parse(read(snapFile)) as { config: { plan: { stopGuard: boolean } } }).config.plan.stopGuard).toBe(false)
    })
  }))
})

describe('F06: Ctrl-C during `buracle install`', () => {
  test('rolls back the running harness transaction, keeps the committed ones, exits 130', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const marker = join(root, 'registered')
    const script = join(root, 'scripts', 'install.ts')
    write(script, [
      `import { opsDeps } from ${JSON.stringify(join(REPO, 'src/engine/update/deps.ts'))}`,
      `import { main } from ${JSON.stringify(join(REPO, 'src/cli/router.ts'))}`,
      `const home = ${JSON.stringify(home)}`,
      `const fake = (h, ops) => ({ harness: h, detect: async () => ({ installed: true, version: '1.0.0' }), build: async () => [], doctor: async () => [], installPlan: async () => ({ id: h, harness: h, ops }) })`,
      `opsDeps.repoRoot = () => ${JSON.stringify(repo)}`,
      `opsDeps.runCli = async () => ({ code: 0, stdout: '', stderr: '' })`,
      `opsDeps.adapters = async () => [`,
      `  fake('codex', [{ kind: 'file', path: home + '/.codex/AGENTS.md', content: 'x\\n', owner: 'codex' }]),`,
      `  fake('omp', [{ kind: 'file', path: home + '/.omp/agent/AGENTS.md', content: 'y\\n', owner: 'omp' }, { kind: 'exec', argv: ['sh', '-c', ${JSON.stringify(`touch '${marker}'; sleep 30`)}], undo: ['rm', '-f', ${JSON.stringify(marker)}], owner: 'omp' }]),`,
      `]`,
      `const out = { write: () => {} }`,
      `process.exit(await main(['install', '--yes'], { stdout: out, stderr: out, stdin: { isTTY: false, text: async () => '' } }))`,
    ].join('\n'))
    const child = Bun.spawn([process.execPath, script], { env: { ...process.env }, stdout: 'ignore', stderr: 'ignore' })
    for (let i = 0; i < 300 && !existsSync(marker); i++) await Bun.sleep(50)
    expect(existsSync(marker)).toBe(true)
    await Bun.sleep(300)
    child.kill('SIGINT')
    expect(await child.exited).toBe(130)
    expect(read(join(home, '.codex/AGENTS.md'))).toBe('x\n')
    expect(existsSync(join(home, '.omp/agent/AGENTS.md'))).toBe(false)
    expect(existsSync(marker)).toBe(false)
    const statuses = (await listTxns()).map(j => j.status).sort()
    expect(statuses).toEqual(['committed', 'committed', 'rolled-back'])
    expect(readInstallRecord().record.plans['omp']).toBeUndefined()
    expect(readInstallRecord().record.plans['codex']).toBeDefined()
  }), 60_000)
})
