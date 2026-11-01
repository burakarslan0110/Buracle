import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as installRun } from '../../../src/cli/commands/install'
import { run as uninstallRun } from '../../../src/cli/commands/uninstall'
import * as paths from '../../../src/engine/paths'
import { VAULT_PRE_COMMIT_MARKER } from '../../../src/engine/update/uninstall'
import { git } from '../../memory/helpers'
import { IS_WINDOWS, narrowPath } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeAdapter, fakeCli, makeRepo, memoryIO, withDeps } from './helpers'

function put(p: string, text = 'x'): void {
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

async function fakeUi(root: string): Promise<{ proc: ReturnType<typeof Bun.spawn> }> {
  const script = join(root, 'fake-ui.ts')
  put(script, [
    "const [recordFile] = process.argv.slice(2)",
    "const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: req => new URL(req.url).pathname === '/healthz'",
    "  ? Response.json({ ok: true, app: 'buracle-memory-ui', version: '0.1.0', vault: '', pid: process.pid })",
    "  : new Response('not found', { status: 404 }) })",
    "await Bun.write(recordFile, JSON.stringify({ v: 1, pid: process.pid, port: server.port, host: '127.0.0.1', url: `http://127.0.0.1:${server.port}`, startedAt: new Date().toISOString(), version: '0.1.0', vault: '' }) + '\\n')",
    "process.on('SIGTERM', () => { server.stop(true); process.exit(0) })",
    "console.log('ready')",
  ].join('\n') + '\n')
  mkdirSync(paths.stateDir(), { recursive: true })
  const proc = Bun.spawn([process.execPath, script, paths.memoryUiStateFile()], { env: { ...process.env }, stdin: 'ignore', stdout: 'pipe', stderr: 'inherit' })
  const reader = proc.stdout.getReader()
  const first = await reader.read()
  reader.releaseLock()
  if (!new TextDecoder().decode(first.value ?? new Uint8Array()).includes('ready')) throw new Error('the fake UI did not start')
  return { proc }
}

describe('uninstall leftovers (O8)', () => {
  test('--purge-state removes the toolchain (and its state); without it the toolchain stays and the result says where', () => withSandbox(async ({ root, home, buracleHome }) => {
    const repo = makeRepo(root)
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: join(home, '.codex/a.txt'), content: 'a\n', owner: 'codex' }] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      put(join(paths.toolchainDir(), 'npm', 'srv', 'node_modules', 'srv', 'package.json'), '{}')
      put(join(paths.toolchainDir(), 'uv', 'tools', 'semble', 'pyvenv.cfg'))
      put(paths.toolchainStateFile(), '{"v":1,"packages":{},"system":{}}\n')
      const plain = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--json'], plain)).toBe(0)
      expect(existsSync(join(paths.toolchainDir(), 'npm'))).toBe(true)
      expect((JSON.parse(plain.out()) as { notes: string[] }).notes.some(n => n.includes('~/.buracle/toolchain') && n.includes('--purge-state'))).toBe(true)

      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const io = memoryIO({ json: true })
      expect(await uninstallRun(['--yes', '--purge-state', '--json'], io)).toBe(0)
      expect((JSON.parse(io.out()) as { purged: string[] }).purged).toContain('~/.buracle/toolchain')
      expect(existsSync(paths.toolchainDir())).toBe(false)
      expect(existsSync(paths.toolchainStateFile())).toBe(false)
      expect(existsSync(buracleHome)).toBe(true)

      const tools = join(home, 'tools')
      put(join(tools, 'bin', 'my-tool'))
      await withEnv({ BURACLE_HOME: tools }, async () => {
        expect(await installRun(['--yes'], memoryIO())).toBe(0)
        put(join(paths.toolchainDir(), 'npm', 'srv', 'package.json'), '{}')
        put(join(paths.toolchainDir(), 'mine.txt'))
        const shared = memoryIO({ json: true })
        expect(await uninstallRun(['--yes', '--purge-state', '--json'], shared)).toBe(2)
        expect(existsSync(join(paths.toolchainDir(), 'npm'))).toBe(false)
        expect(existsSync(join(paths.toolchainDir(), 'mine.txt'))).toBe(true)
      })
    })
  }))

  test.skipIf(IS_WINDOWS)('a plain uninstall takes out the PATH block the install added and the system tools it downloaded; the npm and uv packages stay', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      await withEnv({ PATH: narrowPath(), SHELL: '/bin/zsh', ZDOTDIR: undefined }, async () => {
        put(join(home, '.zshrc'), 'alias ll="ls -l"\n')
        expect(await installRun(['--yes'], memoryIO())).toBe(0)
        expect(readFileSync(join(home, '.zshrc'), 'utf8')).toContain('# >>> buracle >>>')
        put(join(paths.systemToolsDir(), 'node', 'bin', 'node'), '#!/bin/sh\n')
        put(join(paths.toolchainDir(), 'npm', 'srv', 'package.json'), '{}')
        put(paths.toolchainStateFile(), JSON.stringify({ v: 1, packages: {}, system: { node: { via: 'download', version: '26.13.0', installed_at: 't' }, gh: { via: 'brew', installed_at: 't' } } }) + '\n')
        const io = memoryIO({ json: true })
        expect(await uninstallRun(['--yes', '--json'], io)).toBe(0)
        expect(readFileSync(join(home, '.zshrc'), 'utf8')).toBe('alias ll="ls -l"\n')
        expect(existsSync(paths.systemToolsDir())).toBe(false)
        expect(existsSync(join(paths.toolchainDir(), 'npm', 'srv', 'package.json'))).toBe(true)
        expect(Object.keys((JSON.parse(readFileSync(paths.toolchainStateFile(), 'utf8')) as { system: object }).system)).toEqual(['gh'])
        const notes = (JSON.parse(io.out()) as { notes: string[] }).notes
        expect(notes).toContain('Removed the PATH lines Buracle added to ~/.zshrc.')
        expect(notes.some(n => n.startsWith('Removed the system tools Buracle downloaded (node)'))).toBe(true)
      })
    })
  }))

  test('--purge-state in a shared BURACLE_HOME also removes the UI session records, the UI start marker, the PATH record and the install logs', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const tools = join(home, 'tools')
    put(join(tools, 'bin', 'my-tool'))
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: fakeCli().runCli }, async () => {
      await withEnv({ BURACLE_HOME: tools, PATH: narrowPath(join(home, '.local', 'bin')) }, async () => {
        expect(await installRun(['--yes'], memoryIO())).toBe(0)
        put(join(paths.stateDir(), 'ui-sessions', 'claude-s1'), '')
        put(join(paths.stateDir(), 'memory-ui.spawn'), '1')
        put(paths.shellPathStateFile(), '{"v":1,"file":"/nowhere/.zshrc"}\n')
        put(paths.installLogFile(new Date('2026-11-01T10:00:00Z')), 'log\n')
        put(join(paths.systemToolsDir(), 'jq', 'jq'))
        await uninstallRun(['--yes', '--purge-state', '--json'], memoryIO({ json: true }))
        expect(existsSync(join(paths.stateDir(), 'ui-sessions'))).toBe(false)
        expect(existsSync(join(paths.stateDir(), 'memory-ui.spawn'))).toBe(false)
        expect(existsSync(paths.shellPathStateFile())).toBe(false)
        expect(existsSync(paths.installLogFile(new Date('2026-11-01T10:00:00Z')))).toBe(false)
        expect(existsSync(paths.systemToolsDir())).toBe(false)
        expect(existsSync(join(tools, 'bin', 'my-tool'))).toBe(true)
      })
    })
  }))

  test('the memory web UI is stopped; the old vault pre-commit hook an older Buracle installed is removed, one the user wrote stays', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const vault = join(home, 'Documents', 'Buracle')
    mkdirSync(vault, { recursive: true })
    git(vault, 'init', '-q')
    const hook = join(vault, '.git', 'hooks', 'pre-commit')
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: join(home, '.codex/a.txt'), content: 'a\n', owner: 'codex' }] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      put(hook, `#!/bin/sh\n${VAULT_PRE_COMMIT_MARKER}\nexit 1\n`)
      chmodSync(hook, 0o755)
      const ui = await fakeUi(root)
      try {
        const io = memoryIO()
        expect(await uninstallRun(['--yes'], io)).toBe(0)
        await ui.proc.exited
        expect(alive(ui.proc.pid)).toBe(false)
        expect(io.out()).toContain('Stopped the memory web UI')
        expect(existsSync(hook)).toBe(false)
        expect(io.out()).toContain('Removed the old vault\'s pre-commit hook')
        expect(existsSync(join(vault, '.git'))).toBe(true)
      } finally {
        ui.proc.kill()
      }

      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      put(hook, '#!/bin/sh\nexit 0\n')
      chmodSync(hook, 0o755)
      expect(await uninstallRun(['--yes'], memoryIO())).toBe(0)
      expect(readFileSync(hook, 'utf8')).toBe('#!/bin/sh\nexit 0\n')
    })
  }), 30_000)

  test('project files outside the ledger are listed with how to remove them, and left alone', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const project = join(root, 'project')
    mkdirSync(project, { recursive: true })
    git(project, 'init', '-q')
    put(join(project, '.codegraph', 'codegraph.db'))
    put(join(project, '.sembleignore'), '# >>> buracle (managed by the buracle CLI; edit outside this block)\n/.worktrees/\n# <<< buracle\n')
    put(join(project, '.git', 'info', 'exclude'), '# >>> buracle (managed by the buracle CLI; edit outside this block)\n/.claude/skills/x\n# <<< buracle\n')
    put(join(project, '.agents', 'skills', 'x', 'SKILL.md'), '# x\n')
    mkdirSync(join(project, '.claude', 'skills'), { recursive: true })
    symlinkSync(join('..', '..', '.agents', 'skills', 'x'), join(project, '.claude', 'skills', 'x'))
    put(join(paths.indexStateDir(), '0123456789abcdef.json'), JSON.stringify({ v: 1, root: project }) + '\n')
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: join(home, '.codex/a.txt'), content: 'a\n', owner: 'codex' }] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], runCli: fakeCli().runCli }, async () => {
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      const io = memoryIO()
      expect(await uninstallRun(['--yes', '--purge-state'], io)).toBe(0)
      const out = io.out()
      expect(out).toContain('Left in your projects')
      for (const rel of ['.codegraph', '.sembleignore', join('.git', 'info', 'exclude'), join('.claude', 'skills', 'x')]) expect(out).toContain(join(project, rel))
      const json = memoryIO({ json: true })
      expect(await installRun(['--yes'], memoryIO())).toBe(0)
      put(join(paths.indexStateDir(), '0123456789abcdef.json'), JSON.stringify({ v: 1, root: project }) + '\n')
      expect(await uninstallRun(['--yes', '--json'], json)).toBe(0)
      const left = (JSON.parse(json.out()) as { projectLeftovers: Array<{ path: string, remove: string }> }).projectLeftovers
      expect(left.map(l => l.path).sort()).toEqual([join(project, '.claude', 'skills', 'x'), join(project, '.codegraph'), join(project, '.git', 'info', 'exclude'), join(project, '.sembleignore')].sort())
    })
    expect(existsSync(join(project, '.codegraph', 'codegraph.db'))).toBe(true)
    expect(readFileSync(join(project, '.sembleignore'), 'utf8')).toContain('# >>> buracle')
    expect(existsSync(join(project, '.claude', 'skills', 'x'))).toBe(true)
  }), 30_000)
})
