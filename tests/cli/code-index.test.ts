import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from '../../src/cli/router'
import { updateToolchainState } from '../../src/engine/toolchain/state'
import { indexLockFile } from '../../src/workflow/workspace'
import { fakeExe } from '../helpers/fake-exe'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { g, memIO } from '../workflow/fixture'

const REPO = join(import.meta.dir, '..', '..')

async function gitInit(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await g(dir, 'init', '-q')
}

function fakeTools(root: string): void {
  const bin = join(root, 'tools')
  // `codegraph init <flags> <dir>` builds its index in <dir>/.codegraph.
  const cg = fakeExe(join(bin, 'codegraph'), `import { join } from 'node:path'
if (argv[0] === 'init') {
  fs.mkdirSync(join(argv[2], '.codegraph'), { recursive: true })
  fs.writeFileSync(join(argv[2], '.codegraph', 'codegraph.db'), '')
}`)
  const sb = fakeExe(join(bin, 'semble'), '')
  updateToolchainState(s => {
    s.packages['npm:@colbymchenry/codegraph'] = { registry: 'npm', name: '@colbymchenry/codegraph', version: '1.6.2', dir: bin, bins: { codegraph: cg }, installed_at: 'x' }
    s.packages['pypi:semble'] = { registry: 'pypi', name: 'semble', version: '0.6.2', dir: bin, bins: { semble: sb }, installed_at: 'x' }
  }, new Date(0).toISOString())
}

interface IndexRun { code: number; out: string; err: string; json: <T = unknown>() => T }

async function index(...args: string[]): Promise<IndexRun> {
  const io = memIO()
  const code = await main(['index', ...args], io)
  return { code, out: io.out(), err: io.err(), json: <T = unknown>() => JSON.parse(io.out()) as T }
}

describe('buracle index status', () => {
  test('a project: its root, its record and the state of both indexes', () => withSandbox(async ({ root }) => {
    const repo = join(root, 'repo')
    await gitInit(repo)
    mkdirSync(join(repo, 'src'))
    const r = await index('status', '--cwd', join(repo, 'src'), '--json')
    expect(r.code).toBe(0)
    expect(r.json<unknown>()).toEqual({ ok: true, root: repo, record: null, state: { codegraph: { state: 'none' }, semble: { state: 'none' } } })
    const text = await index('status', '--cwd', repo)
    expect(text.out).toBe(`${repo}\n  codegraph not built yet\n  semble    not built yet\n`)
  }))

  test('a folder of projects lists each child project', () => withSandbox(async ({ root }) => {
    const parent = join(root, 'parent')
    await gitInit(join(parent, 'a'))
    await gitInit(join(parent, 'b'))
    const r = await index('status', '--cwd', parent, '--json')
    expect(r.code).toBe(0)
    const j = r.json<{ root: null, cwd: string, children: Array<{ root: string }> }>()
    expect(j.root).toBeNull()
    expect(j.cwd).toBe(parent)
    expect(j.children.map(c => c.root)).toEqual([join(parent, 'a'), join(parent, 'b')])
    expect((await index('status', '--cwd', parent)).out).toStartWith(`${parent} holds 2 projects:\n${join(parent, 'a')}\n`)
  }))

  test('the home folder is never indexed: status says so (exit 0), ensure refuses (exit 2)', () => withSandbox(async ({ home }) => {
    const s = await index('status', '--cwd', home, '--json')
    expect(s.code).toBe(0)
    expect(s.json<unknown>()).toEqual({ ok: false, cwd: home, excluded: 'your home folder', error: `${home} is your home folder: Buracle never indexes it` })
    const e = await index('ensure', '--cwd', home)
    expect(e.code).toBe(2)
    expect(e.err).toContain('is your home folder')
  }))
})

describe('buracle index ensure / rebuild', () => {
  test('BURACLE_NO_TOOLCHAIN=1 (tests) builds nothing', () => withSandbox(async ({ root }) => {
    const repo = join(root, 'repo')
    await gitInit(repo)
    const r = await index('ensure', '--cwd', repo)
    expect(r.code).toBe(0)
    expect(r.err).toContain('nothing indexed')
    expect(existsSync(join(repo, '.codegraph'))).toBe(false)
  }))

  test('builds both indexes, then --if-due skips fresh ones; a folder of projects works child by child', () => withSandbox(async ({ root }) => {
    fakeTools(root)
    const repo = join(root, 'repo')
    await gitInit(repo)
    await withEnv({ BURACLE_INDEX_TEST: '1' }, async () => {
      const r = await index('ensure', '--cwd', repo, '--json')
      expect(r.code).toBe(0)
      expect(r.json<unknown>()).toMatchObject({ ok: true, root: repo, codegraph: { ok: true, mode: 'init' }, semble: { ok: true, mode: 'warm' } })
      expect(existsSync(join(repo, '.codegraph', 'codegraph.db'))).toBe(true)
      const again = await index('ensure', '--cwd', repo, '--if-due', '--json')
      expect(again.json<unknown>()).toEqual({ ok: true, root: repo, skipped: 'not due' })
      const st = await index('status', '--cwd', repo, '--json')
      expect(st.json<{ state: { codegraph: { state: string } } }>().state.codegraph.state).toBe('ready')

      const parent = join(root, 'parent')
      await gitInit(join(parent, 'a'))
      await gitInit(join(parent, 'b'))
      const kids = await index('ensure', '--cwd', parent, '--json')
      expect(kids.code).toBe(0)
      expect(kids.json<{ children: Array<{ root: string, codegraph: { ok: boolean } }> }>().children.map(c => [c.root, c.codegraph.ok])).toEqual([[join(parent, 'a'), true], [join(parent, 'b'), true]])
    })
  }))

  test('rebuild is refused while a codegraph server serves the project, unless --force', () => withSandbox(async ({ root }) => {
    fakeTools(root)
    const repo = join(root, 'repo')
    await gitInit(repo)
    mkdirSync(join(repo, '.codegraph'))
    writeFileSync(join(repo, '.codegraph', 'codegraph.db'), '')
    writeFileSync(join(repo, '.codegraph', 'writer.pid'), JSON.stringify({ pid: process.ppid, mode: 'daemon', startedAt: 1 }))
    await withEnv({ BURACLE_INDEX_TEST: '1' }, async () => {
      const refused = await index('rebuild', '--cwd', repo)
      expect(refused.code).toBe(2)
      expect(refused.err).toContain(`a codegraph server (pid ${process.ppid}) is serving ${repo}`)
      expect(refused.err).toContain('buracle index rebuild --force')
      const forced = await index('rebuild', '--cwd', repo, '--force', '--json')
      expect(forced.code).toBe(0)
      expect(forced.json<unknown>()).toMatchObject({ ok: true, codegraph: { ok: true, mode: 'rebuild' } })
    })
  }))

  test.skipIf(process.platform === 'win32')('Ctrl-C stops ensure together with the codegraph processes it started, releases the lock and exits 130', () => withSandbox(async ({ root }) => {
    fakeTools(root)
    const pids = join(root, 'pids')
    writeFileSync(join(root, 'tools', 'codegraph'), `#!/bin/sh\nif [ "$1" = init ]; then sleep 30 & echo "$$ $!" > '${pids}'; wait; fi\nexit 0\n`, { mode: 0o755 })
    const repo = join(root, 'repo')
    await gitInit(repo)
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    const p = Bun.spawn([process.execPath, join(REPO, 'src', 'cli', 'main.ts'), 'index', 'ensure', '--cwd', repo], { env: { ...process.env, BURACLE_INDEX_TEST: '1' }, stdout: 'pipe', stderr: 'pipe' })
    let started: number[] = []
    try {
      for (let i = 0; i < 200 && started.length < 2; i++) {
        await Bun.sleep(50)
        if (existsSync(pids)) started = readFileSync(pids, 'utf8').trim().split(' ').map(Number).filter(n => n > 0)
      }
      expect(started).toHaveLength(2)
      p.kill('SIGINT')
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()])
      expect(code).toBe(130)
      expect(err).toContain('buracle index: interrupted by SIGINT')
      for (let i = 0; i < 40 && started.some(alive); i++) await Bun.sleep(50)
      expect(started.filter(alive)).toEqual([])
      expect(existsSync(indexLockFile(repo))).toBe(false)
    } finally {
      for (const pid of started) if (alive(pid)) process.kill(pid, 'SIGKILL')
      if (p.exitCode === null) p.kill('SIGKILL')
    }
  }), 20_000)

  test('usage errors exit 1', () => withSandbox(async () => {
    expect((await index('compact')).code).toBe(1)
    expect((await index('ensure', '--bogus')).code).toBe(1)
  }))
})
