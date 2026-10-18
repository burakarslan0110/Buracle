import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lockTestHooks } from '../../src/engine/lockfile'
import { defaultConfig, type BuracleConfig } from '../../src/core/config'
import { updateToolchainState } from '../../src/engine/toolchain/state'
import { prepareWorkspace } from '../../src/adapters/shared/workspace-start'
import {
  caseInsensitivePaths, codegraphDataDir, excludedReason, excludedRoot, indexDue, indexLockFile, indexLockHolder, indexRecordFile, indexTag,
  projectIndex, projectRootFor, pruneIndexStates, readIndexRecord, refreshWorkspaceInfo, resolveWorkspace, spawnIndexIfDue, startIndexRun, workspaceInfo,
  workspaceOptions,
} from '../../src/workflow/workspace'
import { codegraphLiveWriter, codegraphStartGate, ensureIndexes, ensureWorkspace, excludeLocally, indexChecks } from '../../src/workflow/workspace-index'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { g, makeRepo } from './fixture'

const MIN = 60_000

async function gitInit(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await g(dir, 'init', '-q')
}

function fakeTools(root: string): void {
  const bin = join(root, 'tools')
  mkdirSync(bin, { recursive: true })
  const cg = join(bin, 'codegraph')
  const sb = join(bin, 'semble')
  writeFileSync(cg, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(sb, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  updateToolchainState(s => {
    s.packages['npm:@colbymchenry/codegraph'] = { registry: 'npm', name: '@colbymchenry/codegraph', version: '1.6.2', dir: bin, bins: { codegraph: cg }, installed_at: 'x' }
    s.packages['pypi:semble'] = { registry: 'pypi', name: 'semble', version: '0.6.2', dir: bin, bins: { semble: sb }, installed_at: 'x' }
  }, new Date(0).toISOString())
}

interface Call { tool: 'codegraph' | 'semble', args: string[] }
type Reply = { code?: number, stdout?: string, stderr?: string } | undefined

function fakeRunner(reply: (c: Call) => Reply = () => undefined) {
  const calls: Call[] = []
  const runner = async (argv: string[]) => {
    const c: Call = { tool: (argv[0] ?? '').endsWith('semble') ? 'semble' : 'codegraph', args: argv.slice(1) }
    calls.push(c)
    return { code: 0, stdout: '', stderr: '', timedOut: false, ...reply(c) }
  }
  return { calls, runner }
}

const cfgWith = (index: Partial<BuracleConfig['index']> = {}): BuracleConfig => {
  const c = defaultConfig()
  return { ...c, index: { ...c.index, ...index } }
}

function writeDb(root: string, content = ''): void {
  mkdirSync(join(root, '.codegraph'), { recursive: true })
  writeFileSync(join(root, '.codegraph', 'codegraph.db'), content)
}

function holdLock(root: string, pid: number, at: number): void {
  mkdirSync(join(indexLockFile(root), '..'), { recursive: true })
  writeFileSync(indexLockFile(root), JSON.stringify({ pid, at }))
}

function deadPid(): number {
  return Bun.spawnSync(['true']).pid
}

describe('projectRootFor and resolveWorkspace', () => {
  test('a git repository is indexed from its top level; a manifest folder outside git counts too', async () => {
    await withSandbox(async ({ root, home }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      mkdirSync(join(repo, 'src', 'deep'), { recursive: true })
      const vault = join(home, 'Documents', 'Buracle')
      expect(await projectRootFor(join(repo, 'src', 'deep'), vault)).toBe(repo)
      const plain = join(root, 'plain')
      mkdirSync(plain)
      expect(await projectRootFor(plain, vault)).toBeUndefined()
      writeFileSync(join(plain, 'package.json'), '{}')
      expect(await projectRootFor(plain, vault)).toBe(plain)
    })
  })

  test('the home folder, its parents, the vault and ~/.buracle are never projects', async () => {
    await withSandbox(async ({ root, home, buracleHome }) => {
      const vault = join(home, 'Documents', 'Buracle')
      expect(excludedRoot(home, vault)).toBe(true)
      expect(excludedReason(root, vault)).toBe('a parent of your home folder')
      expect(excludedRoot(join(vault, 'projects'), vault)).toBe(true)
      expect(excludedRoot(join(buracleHome, 'toolchain'), vault)).toBe(true)
      writeFileSync(join(home, 'package.json'), '{}')
      expect(await projectRootFor(home, vault)).toBeUndefined()
    })
  })

  test('outside git: the nearest manifest folder upwards, an outer workspace marker, .NET and Xcode markers', async () => {
    await withSandbox(async ({ root, home }) => {
      const vault = join(home, 'Documents', 'Buracle')
      const proj = join(root, 'proj')
      mkdirSync(join(proj, 'src', 'deep'), { recursive: true })
      writeFileSync(join(proj, 'pyproject.toml'), '')
      expect(await projectRootFor(join(proj, 'src', 'deep'), vault)).toBe(proj)
      const mono = join(root, 'mono')
      mkdirSync(join(mono, 'packages', 'a', 'src'), { recursive: true })
      writeFileSync(join(mono, 'pnpm-workspace.yaml'), 'packages: [packages/*]\n')
      writeFileSync(join(mono, 'packages', 'a', 'package.json'), '{}')
      expect(await projectRootFor(join(mono, 'packages', 'a', 'src'), vault)).toBe(mono)
      const dotnet = join(root, 'dotnet')
      mkdirSync(join(dotnet, 'src'), { recursive: true })
      writeFileSync(join(dotnet, 'App.sln'), '')
      expect(await projectRootFor(join(dotnet, 'src'), vault)).toBe(dotnet)
    })
  })

  test('a marker counts only as a regular file with the exact name: a folder called workspace never makes its parent the root', async () => {
    await withSandbox(async ({ root, home }) => {
      const vault = join(home, 'Documents', 'Buracle')
      const dev = join(root, 'dev')
      mkdirSync(join(dev, 'proj', 'src'), { recursive: true })
      writeFileSync(join(dev, 'proj', 'package.json'), '{}')
      mkdirSync(join(dev, 'workspace'))
      expect(await projectRootFor(join(dev, 'proj', 'src'), vault)).toBe(join(dev, 'proj'))
      const dev2 = join(root, 'dev2')
      mkdirSync(join(dev2, 'app'), { recursive: true })
      writeFileSync(join(dev2, 'app', 'go.mod'), 'module app\n')
      mkdirSync(join(dev2, 'WORKSPACE'))
      mkdirSync(join(dev2, 'package.json'))
      writeFileSync(join(dev2, 'nx.JSON'), '{}')
      expect(await projectRootFor(join(dev2, 'app'), vault)).toBe(join(dev2, 'app'))
      expect(await projectRootFor(dev2, vault)).toBeUndefined()
      const bazel = join(root, 'bazel')
      mkdirSync(join(bazel, 'svc'), { recursive: true })
      writeFileSync(join(bazel, 'svc', 'go.mod'), 'module svc\n')
      writeFileSync(join(bazel, 'WORKSPACE'), '')
      expect(await projectRootFor(join(bazel, 'svc'), vault)).toBe(bazel)
    })
  })

  test('a folder of repositories stays a folder of projects when one repository is called workspace', async () => {
    await withSandbox(async ({ root }) => {
      const parent = join(root, 'repos')
      for (const n of ['api', 'web', 'workspace']) await gitInit(join(parent, n))
      const t = await resolveWorkspace(parent, workspaceOptions(defaultConfig()))
      expect(t).toEqual({ cwd: parent, children: [join(parent, 'api'), join(parent, 'web'), join(parent, 'workspace')] })
    })
  })

  test('the upward search stops below the home folder; a dotfiles repository at home is no project', async () => {
    await withSandbox(async ({ home }) => {
      const vault = join(home, 'Documents', 'Buracle')
      writeFileSync(join(home, 'Makefile'), 'all:\n')
      mkdirSync(join(home, 'notes', 'today'), { recursive: true })
      expect(await projectRootFor(join(home, 'notes', 'today'), vault)).toBeUndefined()
      await gitInit(home)
      const parent = join(home, 'code', 'parent')
      await gitInit(join(parent, 'a'))
      await gitInit(join(parent, 'b'))
      const t = await resolveWorkspace(parent, workspaceOptions(defaultConfig()))
      expect(t.root).toBeUndefined()
      expect(t.children).toEqual([join(parent, 'a'), join(parent, 'b')])
    })
  })

  test('a folder that only holds projects lists them; loose files, hidden folders and node_modules do not count', async () => {
    await withSandbox(async ({ root }) => {
      const parent = join(root, 'parent')
      await gitInit(join(parent, 'a'))
      mkdirSync(join(parent, 'b'), { recursive: true })
      writeFileSync(join(parent, 'b', 'go.mod'), 'module b\n')
      await gitInit(join(parent, '.hidden'))
      await gitInit(join(parent, 'node_modules'))
      writeFileSync(join(parent, 'notes.txt'), 'x')
      const t = await resolveWorkspace(parent, workspaceOptions(defaultConfig()))
      expect(t).toEqual({ cwd: parent, children: [join(parent, 'a'), join(parent, 'b')] })
      expect((await resolveWorkspace(parent, workspaceOptions(cfgWith({ children: false })))).children).toEqual([])
      mkdirSync(join(parent, 'c'), { recursive: true })
      expect(await resolveWorkspace(parent, workspaceOptions(defaultConfig()))).toEqual({ cwd: parent, children: [] })
    })
  })

  test('index.maxChildren keeps the most recently active child projects', async () => {
    await withSandbox(async ({ root }) => {
      const parent = join(root, 'parent')
      for (const n of ['old', 'mid', 'new']) await gitInit(join(parent, n))
      const at = (n: string, s: number) => {
        for (const p of [join(parent, n), join(parent, n, '.git'), join(parent, n, '.git', 'HEAD')]) utimesSync(p, s, s)
      }
      at('old', 1_000_000); at('mid', 2_000_000); at('new', 3_000_000)
      const t = await resolveWorkspace(parent, workspaceOptions(cfgWith({ maxChildren: 2 })))
      expect(t.children).toEqual([join(parent, 'mid'), join(parent, 'new')])
    })
  })

  test('index.exclude: excluded child projects are skipped, an excluded folder is reported', async () => {
    await withSandbox(async ({ root, home }) => {
      const parent = join(root, 'parent')
      for (const n of ['app', 'Vendor Kit', 'api-legacy']) await gitInit(join(parent, n))
      const cfg = cfgWith({ exclude: [join(parent, 'Vendor Kit'), `${parent}/*-legacy`] })
      expect((await resolveWorkspace(parent, workspaceOptions(cfg))).children).toEqual([join(parent, 'app')])
      const other = join(root, 'other')
      await gitInit(join(other, 'app'))
      mkdirSync(join(other, 'Vendor Kit'), { recursive: true })
      expect((await resolveWorkspace(other, workspaceOptions(cfgWith({ exclude: ['Vendor Kit'] })))).children).toEqual([join(other, 'app')])
      const inside = await resolveWorkspace(join(parent, 'Vendor Kit'), workspaceOptions(cfg))
      expect(inside).toEqual({ cwd: join(parent, 'Vendor Kit'), children: [], excluded: `excluded by index.exclude (${join(parent, 'Vendor Kit')})` })
      mkdirSync(join(home, 'work', 'scratch'), { recursive: true })
      await gitInit(join(home, 'work', 'scratch', 'x'))
      const byName = await resolveWorkspace(join(home, 'work', 'scratch', 'x'), workspaceOptions(cfgWith({ exclude: ['scratch'] })))
      expect(byName.excluded).toBe('excluded by index.exclude (scratch)')
      const tilde = await resolveWorkspace(join(home, 'work', 'scratch', 'x'), workspaceOptions(cfgWith({ exclude: ['~/work'] })))
      expect(tilde.excluded).toBe('excluded by index.exclude (~/work)')
    })
  })

  test('home spelled in another case is still home on macOS and Windows', async () => {
    await withSandbox(async ({ home }) => {
      const vault = join(home, 'Documents', 'Buracle')
      const swapped = home.replace(/home$/, 'HOME')
      await withEnv({ BURACLE_PLATFORM: 'win32' }, async () => {
        expect(caseInsensitivePaths()).toBe(true)
        expect(excludedReason(swapped, vault)).toBe('your home folder')
      })
      await withEnv({ BURACLE_PLATFORM: 'linux' }, async () => { expect(caseInsensitivePaths()).toBe(false) })
    })
  })
})

describe('index records, locks and states', () => {
  test('none until built; a codegraph database found on disk counts as ready; a record says when', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      const idx = defaultConfig().index
      expect(projectIndex(repo, idx, 1_000)).toEqual({ codegraph: { state: 'none' }, semble: { state: 'none' } })
      writeDb(repo)
      expect(projectIndex(repo, idx, 1_000).codegraph).toEqual({ state: 'ready' })
      expect(projectIndex(repo, { ...idx, codegraph: false }, 1_000).codegraph).toEqual({ state: 'off' })
    })
  })

  test('a live lock holder means building (where no usable index exists); a dead or stale holder does not', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      writeDb(repo)
      const idx = defaultConfig().index
      holdLock(repo, process.pid, 5_000)
      expect(indexLockHolder(repo, 6_000)).toEqual({ pid: process.pid, at: 5_000 })
      expect(projectIndex(repo, idx, 6_000)).toEqual({ codegraph: { state: 'ready' }, semble: { state: 'building', since: 5_000 } })
      expect(indexLockHolder(repo, 5_000 + 119 * MIN)).toEqual({ pid: process.pid, at: 5_000 })
      expect(indexLockHolder(repo, 5_000 + 121 * MIN)).toBeUndefined()
      holdLock(repo, deadPid(), 5_000)
      expect(indexLockHolder(repo, 6_000)).toBeUndefined()
    })
  })

  test('codegraph keeps its index in CODEGRAPH_DIR when that is a plain folder name', async () => {
    await withSandbox(async ({ root }) => {
      expect(codegraphDataDir(root, {})).toBe('.codegraph')
      expect(codegraphDataDir(root, { CODEGRAPH_DIR: '.codegraph-win' })).toBe('.codegraph-win')
      expect(codegraphDataDir(root, { CODEGRAPH_DIR: '../elsewhere' })).toBe('.codegraph')
      expect(codegraphDataDir(root, { CODEGRAPH_DIR: '/abs' })).toBe('.codegraph')
    })
  })

  test('a live codegraph server is read from writer.pid', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      writeDb(repo)
      expect(codegraphLiveWriter(repo)).toBeUndefined()
      writeFileSync(join(repo, '.codegraph', 'writer.pid'), JSON.stringify({ pid: process.ppid, mode: 'daemon', startedAt: 1 }) + '\n')
      expect(codegraphLiveWriter(repo)).toEqual({ pid: process.ppid, mode: 'daemon' })
      writeFileSync(join(repo, '.codegraph', 'writer.pid'), JSON.stringify({ pid: deadPid(), mode: 'direct' }) + '\n')
      expect(codegraphLiveWriter(repo)).toBeUndefined()
      writeFileSync(join(repo, '.codegraph', 'writer.pid'), 'not json')
      expect(codegraphLiveWriter(repo)).toBeUndefined()
    })
  })
})

describe('ensureIndexes', () => {
  test('first run: codegraph init and a health check, semble warm-ups for code and all content; then sync; records and the throttle', async () => {
    await withSandbox(async ({ root }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      const { calls, runner } = fakeRunner()
      let t = 1_000_000
      const now = () => t
      const first = await ensureIndexes(repo, { codegraph: true, semble: true, runner }, now)
      expect(first.codegraph).toMatchObject({ ok: true, mode: 'init' })
      expect(first.semble).toMatchObject({ ok: true, mode: 'warm' })
      expect(calls.filter(c => c.tool === 'codegraph').map(c => c.args)).toEqual([['init', '-y', repo], ['status', '--json', repo]])
      expect(calls.filter(c => c.tool === 'semble').map(c => c.args)).toEqual([
        ['search', 'buracle warm-up', repo, '-k', '1', '--max-snippet-lines', '0'],
        ['search', 'buracle warm-up', repo, '-k', '1', '--max-snippet-lines', '0', '--content', 'all'],
      ])
      const idx = defaultConfig().index
      expect(indexDue(repo, idx, t + MIN)).toBe(false)
      expect(indexDue(repo, idx, t + idx.minIntervalMin * MIN + 1)).toBe(true)
      writeDb(repo)
      t += 3_600_000
      calls.length = 0
      const second = await ensureIndexes(repo, { codegraph: true, semble: false, runner, liveWriter: () => undefined }, now)
      expect(second.codegraph?.mode).toBe('sync')
      expect(calls[0]?.args).toEqual(['sync', '-q', repo])
      expect(readIndexRecord(repo)?.semble?.ok).toBe(true)
      expect(readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.codegraph/')
    })
  })

  test('references an interrupted run left pending are resolved by another sync; a recommended rebuild runs', async () => {
    await withSandbox(async ({ root }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      writeDb(repo)
      const status = (index: Record<string, unknown>) => ({ stdout: `${JSON.stringify({ initialized: true, index })}\n` })
      const pending = fakeRunner(c => (c.args[0] === 'status' ? status({ state: 'complete', pendingRefs: 43428, reindexRecommended: false }) : undefined))
      const r = await ensureIndexes(repo, { codegraph: true, semble: false, runner: pending.runner, liveWriter: () => undefined }, () => 5_000)
      expect(pending.calls.map(c => c.args[0])).toEqual(['sync', 'status', 'sync'])
      expect(r.codegraph).toMatchObject({ ok: true, mode: 'sync', note: 'resolved 43428 pending references' })
      const stale = fakeRunner(c => (c.args[0] === 'status' ? status({ state: 'complete', pendingRefs: 0, reindexRecommended: true }) : undefined))
      const s = await ensureIndexes(repo, { codegraph: true, semble: false, runner: stale.runner, liveWriter: () => undefined }, () => 6_000)
      expect(stale.calls.map(c => c.args.slice(0, 2))).toEqual([['sync', '-q'], ['status', '--json'], ['index', '-q']])
      expect(s.codegraph?.note).toBe('rebuilt: codegraph recommends a rebuild')
      const truncated = fakeRunner(c => (c.args[0] === 'status' ? status({ state: 'indexing', pendingRefs: 0 }) : c.args[0] === 'index' ? { code: 1, stderr: 'killed' } : undefined))
      const tr = await ensureIndexes(repo, { codegraph: true, semble: false, runner: truncated.runner, liveWriter: () => undefined }, () => 7_000)
      expect(tr.codegraph).toMatchObject({ ok: false, error: 'rebuild (an interrupted run left it truncated) failed: killed' })
    })
  })

  test('while a live codegraph server owns the index, the sync is skipped and recorded as ok', async () => {
    await withSandbox(async ({ root }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      writeDb(repo)
      const live = fakeRunner()
      const r = await ensureIndexes(repo, { codegraph: true, semble: false, runner: live.runner, liveWriter: () => ({ pid: 4242, mode: 'daemon' }) }, () => 5_000)
      expect(live.calls).toEqual([{ tool: 'codegraph', args: ['status', '--json', repo] }])
      expect(r.codegraph).toMatchObject({ ok: true, mode: 'sync', note: 'skipped: a live codegraph server (pid 4242) keeps the index fresh' })
      let seen = 0
      const raced = fakeRunner(c => (c.args[0] === 'sync' ? { code: 1 } : undefined))
      const s = await ensureIndexes(repo, { codegraph: true, semble: false, runner: raced.runner, liveWriter: () => (seen++ === 0 ? undefined : { pid: 77, mode: 'direct' }) }, () => 6_000)
      expect(s.codegraph).toMatchObject({ ok: true, note: 'skipped: a codegraph server (pid 77) took the index over' })
    })
  })

  test('a failed run is recorded and retried after a wait that grows with each failure', async () => {
    await withSandbox(async ({ root }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      const { runner } = fakeRunner(() => ({ code: 1, stderr: 'boom' }))
      const idx = defaultConfig().index
      const r = await ensureIndexes(repo, { codegraph: true, semble: true, runner }, () => 5_000)
      expect(r.codegraph).toMatchObject({ ok: false, error: 'boom', failures: 1 })
      expect(r.semble).toMatchObject({ ok: false, error: 'boom', failures: 1 })
      expect(indexDue(repo, idx, 6_000)).toBe(false)
      expect(indexDue(repo, idx, 5_000 + 10 * MIN)).toBe(true)
      const again = await ensureIndexes(repo, { codegraph: true, semble: true, runner }, () => 5_000 + 10 * MIN)
      expect(again.codegraph?.failures).toBe(2)
      expect(indexDue(repo, idx, 5_000 + 24 * MIN)).toBe(false)
      expect(indexDue(repo, idx, 5_000 + 25 * MIN)).toBe(true)
      const ok = await ensureIndexes(repo, { codegraph: true, semble: true, runner: fakeRunner().runner }, () => 5_000 + 30 * MIN)
      expect(ok.codegraph?.failures).toBeUndefined()
      expect(projectIndex(repo, idx, 5_000 + 31 * MIN).codegraph).toEqual({ state: 'ready', at: 5_000 + 30 * MIN })
    })
  })

  test('semble: a failed all-content warm-up fails the record', async () => {
    await withSandbox(async ({ root }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      const { runner } = fakeRunner(c => (c.args.includes('--content') ? { code: 2, stderr: 'no model' } : undefined))
      const r = await ensureIndexes(repo, { codegraph: false, semble: true, runner }, () => 5_000)
      expect(r.semble).toMatchObject({ ok: false, error: 'all content: no model' })
    })
  })

  test('a project another live index run holds is skipped; the lock of a dead run is taken over', async () => {
    await withSandbox(async ({ root }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      holdLock(repo, process.ppid, 5_000)
      const { calls, runner } = fakeRunner()
      expect(await ensureIndexes(repo, { codegraph: true, semble: true, runner }, () => 6_000)).toEqual({ root: repo, skipped: 'another Buracle process is indexing this project' })
      expect(calls).toEqual([])
      expect(readIndexRecord(repo)).toBeUndefined()
      holdLock(repo, deadPid(), 5_000)
      const r = await ensureIndexes(repo, { codegraph: true, semble: true, runner }, () => 6_000)
      expect(r.codegraph?.ok).toBe(true)
      expect(indexLockHolder(repo, 6_000)).toBeUndefined()
    })
  })

  test('O11: a dead run\'s lock that another process broke and took meanwhile is left to it', async () => {
    await withSandbox(async ({ root }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      holdLock(repo, deadPid(), 5_000)
      const fresh = JSON.stringify({ pid: process.ppid, at: 5_500, token: 'other' })
      lockTestHooks.beforeBreak = path => { unlinkSync(path); writeFileSync(path, fresh) }
      const { calls, runner } = fakeRunner()
      try {
        expect(await ensureIndexes(repo, { codegraph: true, semble: true, runner }, () => 6_000)).toEqual({ root: repo, skipped: 'another Buracle process is indexing this project' })
      } finally {
        delete lockTestHooks.beforeBreak
      }
      expect(calls).toEqual([])
      expect(readFileSync(indexLockFile(repo), 'utf8')).toBe(fresh)
    })
  })

  test('force rebuilds an existing index (codegraph index) and initializes a missing one', async () => {
    await withSandbox(async ({ root }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      const fresh = fakeRunner()
      await ensureIndexes(repo, { codegraph: true, semble: false, force: true, runner: fresh.runner }, () => 5_000)
      expect(fresh.calls[0]?.args).toEqual(['init', '-y', repo])
      writeDb(repo)
      const again = fakeRunner()
      const r = await ensureIndexes(repo, { codegraph: true, semble: false, force: true, runner: again.runner }, () => 6_000)
      expect(again.calls.map(c => c.args)).toEqual([['index', '-q', repo]])
      expect(r.codegraph).toMatchObject({ ok: true, mode: 'rebuild' })
    })
  })

  test('a damaged index is moved out of the repository, kept once under Buracle\'s state, and built again', async () => {
    await withSandbox(async ({ root, buracleHome }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      const db = join(repo, '.codegraph', 'codegraph.db')
      const status = { stdout: `${JSON.stringify({ initialized: true, index: { state: 'complete', pendingRefs: 0 } })}\n` }
      writeDb(repo, 'not a database at all')
      const foreign = fakeRunner(c => (c.args[0] === 'sync' ? { code: 1 } : c.args[0] === 'status' ? status : undefined))
      const r = await ensureIndexes(repo, { codegraph: true, semble: false, runner: foreign.runner, liveWriter: () => undefined }, () => 5_000)
      expect(foreign.calls.map(c => c.args[0])).toEqual(['sync', 'init', 'status'])
      const corrupt = join(buracleHome, 'state', 'index', 'corrupt')
      const copies = readdirSync(corrupt)
      expect(copies).toEqual([`${indexTag(repo)}-5000`])
      expect(readFileSync(join(corrupt, copies[0] ?? '', 'codegraph.db'), 'utf8')).toBe('not a database at all')
      expect(existsSync(db)).toBe(false)
      expect(r.codegraph).toMatchObject({ ok: true, mode: 'rebuild', note: `recovered an index that was not a SQLite database (the old one is in ${join(corrupt, copies[0] ?? '')})` })
      expect((await indexChecks(repo, defaultConfig(), 6_000)).find(c => c.check === 'index.codegraph')?.detail).toContain('(recovered an index that was not a SQLite database')

      writeDb(repo, 'SQLite format 3\u0000 and then garbage')
      const malformed = fakeRunner(c => (c.args[0] === 'sync' ? { code: 1 } : c.args[0] === 'status' && c.args.length === 3 && existsSync(db) ? { code: 1, stderr: 'Failed to get status: database disk image is malformed' } : c.args[0] === 'status' ? status : undefined))
      const m = await ensureIndexes(repo, { codegraph: true, semble: false, runner: malformed.runner, liveWriter: () => undefined }, () => 7_000)
      expect(malformed.calls.map(c => c.args[0])).toEqual(['sync', 'status', 'init', 'status'])
      expect(m.codegraph).toMatchObject({ ok: true, mode: 'rebuild' })
      expect(m.codegraph?.note).toStartWith('recovered an index that was corrupt')
      expect(readdirSync(corrupt)).toEqual([`${indexTag(repo)}-7000`])
    })
  })

  test('a damaged index a live codegraph server holds is left alone until rebuild --force; a plain failure is not treated as damage', async () => {
    await withSandbox(async ({ root, buracleHome }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      const db = join(repo, '.codegraph', 'codegraph.db')
      writeDb(repo, 'garbage')
      const held = fakeRunner()
      const r = await ensureIndexes(repo, { codegraph: true, semble: false, runner: held.runner, liveWriter: () => ({ pid: 4242, mode: 'daemon' }) }, () => 5_000)
      expect(held.calls).toEqual([])
      expect(r.codegraph).toMatchObject({ ok: false, mode: 'rebuild' })
      expect(r.codegraph?.error).toContain('a codegraph server (pid 4242) holds it')
      expect(r.codegraph?.error).toContain('buracle index rebuild --force')
      expect(existsSync(db)).toBe(true)
      writeDb(repo, 'SQLite format 3\u0000 and then garbage')
      const heldMalformed = fakeRunner(c => (c.args[0] === 'status' ? { code: 1, stderr: 'Failed to get status: database disk image is malformed' } : undefined))
      const hm = await ensureIndexes(repo, { codegraph: true, semble: false, runner: heldMalformed.runner, liveWriter: () => ({ pid: 4242, mode: 'daemon' }) }, () => 5_500)
      expect(heldMalformed.calls.map(c => c.args[0])).toEqual(['status'])
      expect(hm.codegraph).toMatchObject({ ok: false, mode: 'rebuild' })
      expect(hm.codegraph?.error).toContain('the codegraph index is corrupt, but a codegraph server (pid 4242) holds it')
      expect(hm.codegraph?.error).toContain('buracle index rebuild --force')
      expect(readFileSync(db, 'utf8')).toBe('SQLite format 3\u0000 and then garbage')
      writeDb(repo, 'garbage')
      const forced = fakeRunner(c => (c.args[0] === 'index' ? { code: 1, stdout: 'CodeGraph not initialized' } : undefined))
      const f = await ensureIndexes(repo, { codegraph: true, semble: false, force: true, runner: forced.runner, liveWriter: () => ({ pid: 4242, mode: 'daemon' }) }, () => 6_000)
      expect(forced.calls.map(c => c.args[0])).toEqual(['index', 'init', 'status'])
      expect(f.codegraph).toMatchObject({ ok: true, mode: 'rebuild' })
      expect(existsSync(db)).toBe(false)

      writeDb(repo, 'SQLite format 3\u0000')
      const plain = fakeRunner(c => (c.args[0] === 'sync' ? { code: 1, stderr: 'boom' } : c.args[0] === 'status' ? { stdout: `${JSON.stringify({ initialized: true })}\n` } : undefined))
      const p = await ensureIndexes(repo, { codegraph: true, semble: false, runner: plain.runner, liveWriter: () => undefined }, () => 7_000)
      expect(p.codegraph).toMatchObject({ ok: false, mode: 'sync', error: 'boom' })
      expect(existsSync(db)).toBe(true)
      expect(readdirSync(join(buracleHome, 'state', 'index', 'corrupt'))).toHaveLength(1)
    })
  })

  test('an abort stops the run: no further tool starts, the interrupted tool keeps its previous record, the lock is released', async () => {
    await withSandbox(async ({ root }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      writeDb(repo)
      await ensureIndexes(repo, { codegraph: true, semble: true, runner: fakeRunner().runner, liveWriter: () => undefined }, () => 1_000)
      const before = readIndexRecord(repo)
      const abort = new AbortController()
      const seen: Array<AbortSignal | undefined> = []
      const calls: string[][] = []
      const runner = async (argv: string[], o: { signal?: AbortSignal }) => {
        calls.push(argv.slice(1))
        seen.push(o.signal)
        abort.abort()
        return { code: 143, stdout: '', stderr: '', timedOut: false, aborted: true }
      }
      const r = await ensureIndexes(repo, { codegraph: true, semble: true, runner, liveWriter: () => undefined, signal: abort.signal }, () => 9_000)
      expect(calls).toEqual([['sync', '-q', repo]])
      expect(seen).toEqual([abort.signal])
      expect(r).toEqual({ root: repo, skipped: 'interrupted' })
      expect(readIndexRecord(repo)).toEqual(before)
      expect(existsSync(indexLockFile(repo))).toBe(false)
      const rest = await ensureWorkspace({ cwd: repo, root: repo, children: [] }, cfgWith(), { runner: fakeRunner().runner, signal: abort.signal })
      expect(rest).toEqual([{ root: repo, skipped: 'interrupted' }])
    })
  })

  test('old copies of damaged indexes are pruned after 14 days with the stale index states', async () => {
    await withSandbox(async ({ buracleHome }) => {
      const corrupt = join(buracleHome, 'state', 'index', 'corrupt')
      const day = 86_400_000
      for (const name of ['0123456789abcdef-1000', `fedcba9876543210-${20 * day}`, 'notes']) mkdirSync(join(corrupt, name), { recursive: true })
      const removed = pruneIndexStates(15 * day)
      expect(removed).toEqual([join(corrupt, '0123456789abcdef-1000')])
      expect(readdirSync(corrupt).sort()).toEqual(['fedcba9876543210-1728000000', 'notes'])
    })
  })

  test('if-due (the session-start run) runs only the indexes that are due', async () => {
    await withSandbox(async ({ root }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      await ensureIndexes(repo, { codegraph: false, semble: true, runner: fakeRunner().runner }, () => 1_000)
      const target = await resolveWorkspace(repo, workspaceOptions(defaultConfig()))
      const { calls, runner } = fakeRunner()
      const [r] = await ensureWorkspace(target, defaultConfig(), { ifDue: true, runner, nowMs: () => 2_000 })
      expect(calls.map(c => c.tool)).toEqual(['codegraph', 'codegraph'])
      expect(r).toMatchObject({ root: repo, codegraph: { ok: true, mode: 'init' } })
      expect(r?.semble).toBeUndefined()
      expect(await ensureWorkspace(target, defaultConfig(), { ifDue: true, runner, nowMs: () => 3_000 })).toEqual([{ root: repo, skipped: 'not due' }])
    })
  })

  test('excludeLocally adds the pattern once', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      expect(await excludeLocally(repo, '/.codegraph/')).toBe(true)
      expect(await excludeLocally(repo, '/.codegraph/')).toBe(true)
      const text = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
      expect(text.split('\n').filter(l => l === '/.codegraph/')).toHaveLength(1)
    })
  })
})

describe('starting the background run', () => {
  test('one detached run per due project; nothing when it is fresh or another run holds it', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      const cfg = defaultConfig()
      const spawned: Array<{ argv: string[], cwd: string }> = []
      const spawn = (argv: string[], cwd: string) => { spawned.push({ argv, cwd }) }
      const target = await resolveWorkspace(repo, workspaceOptions(cfg))
      expect(startIndexRun(target, cfg, 1_000, ['buracle'], spawn)).toEqual([repo])
      expect(spawned).toEqual([{ argv: ['buracle', 'index', 'ensure', '--cwd', repo, '--if-due', '--quiet'], cwd: repo }])
      expect(startIndexRun(target, cfg, 1_000, undefined, spawn)).toEqual([])
      holdLock(repo, process.pid, 1_000)
      expect(startIndexRun(target, cfg, 1_000, ['buracle'], spawn)).toEqual([])
      rmSync(indexLockFile(repo))
      await ensureIndexes(repo, { codegraph: false, semble: true, runner: fakeRunner().runner }, () => 1_000)
      expect(startIndexRun(target, cfgWith({ codegraph: false }), 2_000, ['buracle'], spawn)).toEqual([])
      expect(spawned).toHaveLength(1)
    })
  })

  test('index records of roots that no longer exist (a removed worktree) are pruned when a run starts; live ones and held locks stay', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      const gone = join(root, 'wt-gone')
      const busy = join(root, 'wt-busy')
      await gitInit(repo)
      for (const r of [repo, gone, busy]) {
        mkdirSync(join(indexRecordFile(r), '..'), { recursive: true })
        writeFileSync(indexRecordFile(r), JSON.stringify({ v: 1, root: r, semble: { at: 1, ok: true } }) + '\n')
      }
      writeFileSync(indexLockFile(gone), JSON.stringify({ pid: deadPid(), at: 1 }))
      holdLock(busy, process.pid, 1_000)
      expect(pruneIndexStates(1_000)).toEqual([indexRecordFile(gone)])
      expect(existsSync(indexRecordFile(gone))).toBe(false)
      expect(existsSync(indexLockFile(gone))).toBe(false)
      expect(existsSync(indexRecordFile(busy))).toBe(true)
      expect(existsSync(indexRecordFile(repo))).toBe(true)
      writeFileSync(indexRecordFile(gone), JSON.stringify({ v: 1, root: gone }) + '\n')
      const target = await resolveWorkspace(repo, workspaceOptions(defaultConfig()))
      expect(startIndexRun(target, defaultConfig(), 10 * 24 * 60 * MIN, ['buracle'], () => {})).toEqual([repo])
      expect(existsSync(indexRecordFile(gone))).toBe(false)
    })
  })

  test('a folder of projects: one run for the due child projects, started in that folder', async () => {
    await withSandbox(async ({ root }) => {
      const parent = join(root, 'parent')
      for (const n of ['a', 'b']) await gitInit(join(parent, n))
      const cfg = cfgWith({ codegraph: false })
      fakeTools(root)
      await ensureIndexes(join(parent, 'a'), { codegraph: false, semble: true, runner: fakeRunner().runner }, () => 1_000)
      const spawned: string[][] = []
      const target = await resolveWorkspace(parent, workspaceOptions(cfg))
      expect(startIndexRun(target, cfg, 2_000, ['buracle'], argv => { spawned.push(argv) })).toEqual([join(parent, 'b')])
      expect(spawned).toEqual([['buracle', 'index', 'ensure', '--cwd', parent, '--if-due', '--quiet']])
    })
  })

  test('spawnIndexIfDue honors BURACLE_NO_AUTOSTART and index.auto', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      mkdirSync(join(repo, 'src'))
      const spawned: string[][] = []
      const spawn = (argv: string[]) => { spawned.push(argv) }
      expect(await spawnIndexIfDue(repo, defaultConfig(), 1_000, ['buracle'], spawn)).toBeUndefined()
      await withEnv({ BURACLE_NO_AUTOSTART: undefined }, async () => {
        expect(await spawnIndexIfDue(repo, cfgWith({ auto: false }), 1_000, ['buracle'], spawn)).toBeUndefined()
        expect(await spawnIndexIfDue(join(repo, 'src'), defaultConfig(), 1_000, ['buracle'], spawn)).toBe(repo)
      })
      expect(spawned).toHaveLength(1)
    })
  })
})

describe('what a session start reports', () => {
  test('prepareWorkspace returns the root and its index state; under BURACLE_NO_AUTOSTART nothing starts', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      mkdirSync(join(repo, 'src'), { recursive: true })
      const info = await prepareWorkspace(join(repo, 'src'), defaultConfig(), 1_000)
      expect(info).toEqual({ cwd: join(repo, 'src'), root: repo, children: [], index: { codegraph: { state: 'none' }, semble: { state: 'none' } } })
      expect(indexLockHolder(repo, 1_000)).toBeUndefined()
    })
  })

  test('a folder of projects and the home folder', async () => {
    await withSandbox(async ({ root, home }) => {
      const parent = join(root, 'parent')
      await gitInit(join(parent, 'a'))
      writeDb(join(parent, 'a'))
      const info = await workspaceInfo(parent, defaultConfig(), 1_000)
      expect(info).toEqual({
        cwd: parent, children: [join(parent, 'a')], index: { codegraph: { state: 'none' }, semble: { state: 'none' } },
        childIndex: { [join(parent, 'a')]: { codegraph: { state: 'ready' }, semble: { state: 'none' } } },
      })
      const atHome = await prepareWorkspace(home, cfgWith({ semble: false }), 1_000)
      expect(atHome).toEqual({ cwd: home, children: [], excluded: 'your home folder', index: { codegraph: { state: 'none' }, semble: { state: 'off' } } })
    })
  })

  test('refreshWorkspaceInfo reads the states again without resolving the folder again', async () => {
    await withSandbox(async ({ root }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      const before = await workspaceInfo(repo, defaultConfig(), 1_000)
      expect(before.index.semble).toEqual({ state: 'none' })
      await ensureIndexes(repo, { codegraph: false, semble: true, runner: fakeRunner().runner }, () => 2_000)
      expect(refreshWorkspaceInfo(before, defaultConfig(), 3_000).index.semble).toEqual({ state: 'ready', at: 2_000 })
    })
  })

  test('indexChecks: doctor rows per tool, and for folders without a project', async () => {
    await withSandbox(async ({ root, home }) => {
      fakeTools(root)
      const repo = join(root, 'repo')
      await gitInit(repo)
      await ensureIndexes(repo, { codegraph: true, semble: false, runner: fakeRunner().runner }, () => 1_000)
      const rows = await indexChecks(repo, defaultConfig(), 1_000 + 5 * MIN)
      expect(rows).toEqual([
        { level: 'ok', check: 'index.codegraph', detail: `${repo}: ready (refreshed 5m ago)` },
        { level: 'warn', check: 'index.semble', detail: `${repo}: not built yet` },
      ])
      expect(await indexChecks(home, cfgWith({ auto: false }), 1_000)).toEqual([
        { level: 'info', check: 'index.auto', detail: 'off: session starts build no code indexes (`buracle index ensure` builds them by hand)' },
        { level: 'info', check: 'index', detail: `${home} is your home folder: nothing is indexed here` },
      ])
    })
  })
})

describe('codegraph MCP start gate', () => {
  test('no wait without a project, with an index in place, or with codegraph indexing off', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      expect(await codegraphStartGate(join(root, 'nothing-here'), { cfg: defaultConfig(), argv: undefined })).toEqual({ outcome: 'no-project', waitedMs: 0 })
      expect(await codegraphStartGate(repo, { cfg: cfgWith({ codegraph: false }) })).toEqual({ outcome: 'off', waitedMs: 0 })
      expect(await codegraphStartGate(repo, { cfg: defaultConfig(), argv: undefined })).toEqual({ root: repo, outcome: 'idle', waitedMs: 0 })
      writeDb(repo)
      expect(await codegraphStartGate(repo, { cfg: defaultConfig() })).toEqual({ root: repo, outcome: 'present', waitedMs: 0 })
    })
  })

  test('waits while a Buracle run builds the index, then starts the server', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      let t = 10_000
      holdLock(repo, process.pid, t)
      let polls = 0
      const sleep = async (ms: number) => {
        t += ms
        if (++polls === 8) { writeDb(repo); rmSync(indexLockFile(repo)) }
      }
      const r = await codegraphStartGate(repo, { cfg: defaultConfig(), nowMs: () => t, sleep, argv: undefined })
      expect(r).toEqual({ root: repo, outcome: 'ready', waitedMs: 8 * 250 })
    })
  })

  test('starts the server as soon as the codegraph index exists, while the run still warms semble', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      let t = 10_000
      holdLock(repo, process.pid, t)
      let polls = 0
      const sleep = async (ms: number) => {
        t += ms
        if (++polls === 3) writeDb(repo)
      }
      const r = await codegraphStartGate(repo, { cfg: defaultConfig(), nowMs: () => t, sleep, argv: undefined })
      expect(r).toEqual({ root: repo, outcome: 'ready', waitedMs: 3 * 250 })
      expect(indexLockHolder(repo, t)).toEqual({ pid: process.pid, at: 10_000 })
    })
  })

  test('starts the due run itself; gives up after 4 s; never waits for a run that did not take the lock', async () => {
    await withSandbox(async ({ root }) => {
      const repo = join(root, 'repo')
      await gitInit(repo)
      let t = 0
      const sleep = async (ms: number) => { t += ms }
      const spawned: string[][] = []
      await withEnv({ BURACLE_NO_AUTOSTART: undefined }, async () => {
        const quiet = await codegraphStartGate(repo, { cfg: defaultConfig(), nowMs: () => t, sleep, argv: ['buracle'], spawn: argv => { spawned.push(argv) } })
        expect(spawned).toEqual([['buracle', 'index', 'ensure', '--cwd', repo, '--if-due', '--quiet']])
        expect(quiet).toEqual({ root: repo, outcome: 'failed', waitedMs: 3_000 })
      })
      t = 0
      holdLock(repo, process.pid, 0)
      const stuck = await codegraphStartGate(repo, { cfg: defaultConfig(), nowMs: () => t, sleep, argv: undefined })
      expect(stuck).toEqual({ root: repo, outcome: 'timeout', waitedMs: 4_000 })
    })
  })
})

describe('worktrees and records', () => {
  test('an index run in a worktree records it on its own (not as the main checkout)', async () => {
    await withSandbox(async ({ root }) => {
      const repo = await makeRepo(root)
      const wt = join(repo, '.worktrees', 'feature')
      await g(repo, 'worktree', 'add', '-q', '-b', 'plan-build/feature', wt)
      expect(await projectRootFor(join(wt, 'src'), join(root, 'vault'))).toBe(wt)
      expect(indexRecordFile(wt)).not.toBe(indexRecordFile(repo))
    })
  })
})
