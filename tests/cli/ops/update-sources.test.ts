import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as updateRun } from '../../../src/cli/commands/update'
import type { OpsDeps } from '../../../src/engine/update/deps'
import { readHealth } from '../../../src/engine/update/mcp'
import { brewUpgradeCommand, npmUrl } from '../../../src/engine/update/updates'
import { skillsAdd } from '../../../src/workflow/skill-install'
import { fakeExe, IS_WINDOWS, narrowPath } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { behindRemote, daysAgo, fakeAdapter, fakeCli, fakeFetch, fakeMcpServer, git, makeRepo, memoryIO, noNetwork, withDeps } from './helpers'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const q = (v: unknown): string => JSON.stringify(v)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('harness updates go through the installer that installed them', () => {
  const CASK_API = 'https://formulae.brew.sh/api/cask/codex.json'

  function caskCodex(root: string, opts: { upgrades: boolean, tap?: string }): { bin: string, log: string, version: () => string, path: string } {
    const bin = join(root, 'bin')
    const log = join(root, 'calls.log')
    const state = join(root, 'codex.version')
    mkdirSync(root, { recursive: true })
    writeFileSync(state, '0.1.0')
    const real = fakeExe(join(root, 'brew', 'Caskroom', 'codex', '0.1.0', 'bin', 'codex'), `console.log('codex-cli ' + fs.readFileSync(${q(state)}, 'utf8'))`)
    mkdirSync(bin, { recursive: true })
    symlinkSync(real, join(bin, 'codex'))
    const info = { formulae: [], casks: [{ token: 'codex', tap: opts.tap ?? 'homebrew/cask', version: '0.164.0,a1b2' }] }
    fakeExe(join(bin, 'brew'), `append(${q(log)}, 'brew ' + argv.join(' ') + ' NO_AUTO_UPDATE=' + (process.env.HOMEBREW_NO_AUTO_UPDATE ?? ''))
const two = argv.slice(0, 2).join(' ')
if (two === 'info --json=v2') console.log(${q(q(info))})
if (two === 'upgrade --cask' && ${q(opts.upgrades)}) fs.writeFileSync(${q(state)}, '0.165.0')`)
    return { bin, log, version: () => read(state), path: join(bin, 'codex') }
  }

  // Homebrew casks exist only on macOS and Linux.
  test.skipIf(IS_WINDOWS)('a Homebrew cask install is checked against the Homebrew API and upgraded with brew; the version is measured again', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    const c = caskCodex(root, { upgrades: true })
    mkdirSync(join(buracleHome, 'cache'), { recursive: true })
    writeFileSync(join(buracleHome, 'cache', 'harness-versions.json'), JSON.stringify({ codex: { v: '0.1.0', at: NOW } }))
    const codex = fakeAdapter('codex', { version: c.version, path: c.path, doctor: () => [{ level: 'warn', check: 'codex.hooks', detail: 'one hook waits for /hooks' }] })
    const f = fakeFetch({ [CASK_API]: { token: 'codex', version: '0.165.0' } })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], fetch: f, now: () => NOW }, async () => {
      await withEnv({ PATH: narrowPath(c.bin) }, async () => {
        const io = memoryIO({ json: true })
        expect(await updateRun(['harness', '--json'], io)).toBe(0)
        const r = JSON.parse(io.out()) as { items: Array<Record<string, unknown>> }
        expect(r.items).toHaveLength(1)
        expect(r.items[0]).toMatchObject({ kind: 'harness', id: 'codex', current: '0.1.0', latest: '0.165.0', action: 'brew-upgrade', source: 'Homebrew cask codex', command: ['brew', 'upgrade', '--cask', 'codex'] })
        expect(String(r.items[0]?.['note'])).toContain('Homebrew gives no release date')
        expect(read(c.log)).toContain('brew info --json=v2 --cask codex NO_AUTO_UPDATE=1')
        expect(read(c.log)).not.toContain('upgrade')

        const apply = memoryIO()
        expect(await updateRun(['--yes', 'harness'], apply)).toBe(2)
        expect(apply.out()).toContain('applied  harness codex: brew upgrade --cask codex → 0.165.0')
        expect(apply.err()).toContain('warning: codex codex.hooks: one hook waits for /hooks')
        expect(read(c.log)).toContain('brew upgrade --cask codex NO_AUTO_UPDATE=\n')
        expect(codex.calls.filter(x => x === 'doctor')).toHaveLength(1)
      })
    })
    expect(JSON.parse(read(join(buracleHome, 'cache', 'harness-versions.json'))) as Record<string, unknown>).not.toHaveProperty('codex')
  }), 60_000)

  // Homebrew casks exist only on macOS and Linux.
  test.skipIf(IS_WINDOWS)('a brew upgrade that leaves the old version is a failure, and no doctor runs', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const c = caskCodex(root, { upgrades: false })
    const codex = fakeAdapter('codex', { version: c.version, path: c.path })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], fetch: fakeFetch({ [CASK_API]: { version: '0.165.0' } }), now: () => NOW }, async () => {
      await withEnv({ PATH: narrowPath(c.bin) }, async () => {
        const io = memoryIO()
        expect(await updateRun(['--yes', 'harness'], io)).toBe(1)
        expect(io.err()).toContain('failed   harness codex: still 0.1.0 after brew upgrade --cask codex')
        expect(codex.calls).not.toContain('doctor')
      })
    })
  }), 60_000)

  // Homebrew casks exist only on macOS and Linux.
  test.skipIf(IS_WINDOWS)('a formula from another tap uses the local brew data; an unreachable Homebrew API falls back to it too', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const c = caskCodex(root, { upgrades: true, tap: 'someone/tap' })
    const codex = fakeAdapter('codex', { version: c.version, path: c.path })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], fetch: noNetwork, now: () => NOW }, async () => {
      await withEnv({ PATH: narrowPath(c.bin) }, async () => {
        const io = memoryIO({ json: true })
        expect(await updateRun(['harness', '--json'], io)).toBe(0)
        const item = (JSON.parse(io.out()) as { items: Array<Record<string, unknown>> }).items[0]
        expect(item).toMatchObject({ latest: '0.164.0', source: 'Homebrew cask codex' })
        expect(String(item?.['note'])).toContain('Homebrew tap someone/tap, as of its last brew update')
      })
    })
    const official = caskCodex(join(root, 'second'), { upgrades: true })
    const again = fakeAdapter('codex', { version: official.version, path: official.path })
    await withDeps({ repoRoot: () => repo, adapters: async () => [again], fetch: fakeFetch({ [CASK_API]: () => ({ ok: false, status: 0, error: 'offline' }) }), now: () => NOW }, async () => {
      await withEnv({ PATH: narrowPath(official.bin) }, async () => {
        const io = memoryIO({ json: true })
        expect(await updateRun(['harness', '--json'], io)).toBe(0)
        const item = (JSON.parse(io.out()) as { items: Array<Record<string, unknown>> }).items[0]
        expect(item).toMatchObject({ latest: '0.164.0' })
        expect(String(item?.['note'])).toContain('Homebrew API unreachable (offline); version from the local brew data')
      })
    })
  }), 60_000)

  // Homebrew casks exist only on macOS and Linux.
  test.skipIf(IS_WINDOWS)('text from brew reaches the terminal without escape sequences: a tap name in the table note, an Error: line on stderr', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const c = caskCodex(root, { upgrades: true, tap: 'evil/\u001b[2Jtap' })
    const codex = fakeAdapter('codex', { version: c.version, path: c.path })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], fetch: noNetwork, now: () => NOW }, async () => {
      await withEnv({ PATH: narrowPath(c.bin) }, async () => {
        const io = memoryIO()
        expect(await updateRun(['harness'], io)).toBe(0)
        expect(io.out()).toContain('Homebrew tap evil/ [2Jtap')
        expect(io.out()).not.toContain('\u001b')
      })
    })
    const broken = join(root, 'broken')
    const real = fakeExe(join(broken, 'brew', 'Caskroom', 'codex', '0.1.0', 'bin', 'codex'), "console.log('codex-cli 0.1.0')")
    mkdirSync(join(broken, 'bin'), { recursive: true })
    symlinkSync(real, join(broken, 'bin', 'codex'))
    fakeExe(join(broken, 'bin', 'brew'), "process.stderr.write('Error: \\x1b[31mno such cask\\x1b[0m\\n')\nprocess.exit(1)")
    const again = fakeAdapter('codex', { version: '0.1.0', path: join(broken, 'bin', 'codex') })
    await withDeps({ repoRoot: () => repo, adapters: async () => [again], fetch: noNetwork, now: () => NOW }, async () => {
      await withEnv({ PATH: narrowPath(join(broken, 'bin')) }, async () => {
        const io = memoryIO()
        await updateRun(['harness'], io)
        expect(io.err()).toContain('no such cask')
        expect(io.err()).not.toContain('\u001b')
      })
    })
  }), 60_000)

  test('an npm global install is upgraded with npm into the same prefix, pinned to the checked version', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const prefix = join(root, 'node prefix')
    const state = join(root, 'codex.version')
    writeFileSync(state, '0.160.0')
    const real = fakeExe(join(prefix, 'lib', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), `console.log('codex-cli ' + fs.readFileSync(${q(state)}, 'utf8'))`)
    const bin = join(root, 'bin')
    const log = join(root, 'calls.log')
    mkdirSync(bin, { recursive: true })
    symlinkSync(real, join(bin, 'codex'))
    fakeExe(join(bin, 'npm'), `append(${q(log)}, 'npm ' + argv.join(' '))
fs.writeFileSync(${q(state)}, '0.161.0')`)
    const codex = fakeAdapter('codex', { version: () => read(state), path: join(bin, 'codex') })
    const f = fakeFetch({ [npmUrl('@openai/codex')]: { 'dist-tags': { latest: '0.161.0' }, time: { '0.161.0': daysAgo(NOW, 10) }, versions: { '0.161.0': {} } } })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], fetch: f, now: () => NOW }, async () => {
      await withEnv({ PATH: narrowPath(bin) }, async () => {
        const io = memoryIO()
        expect(await updateRun(['--yes', 'harness'], io)).toBe(0)
        expect(io.out()).toContain(`applied  harness codex: npm install -g --prefix ${prefix} @openai/codex@0.161.0 → 0.161.0`)
        expect(read(log)).toBe(`npm install -g --prefix ${prefix} @openai/codex@0.161.0\n`)
      })
    })
  }), 60_000)

  test('a harness\'s own updater: a newer version is applied, an unchanged one is skipped, a failing one fails', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const native = join(root, '.local', 'share', 'claude', 'versions', '2.1.290')
    const nativeExe = fakeExe(native, "console.log('2.1.290')")
    const bin = join(root, 'bin')
    mkdirSync(bin, { recursive: true })
    symlinkSync(nativeExe, join(bin, 'claude'))
    const state = join(root, 'claude.version')
    const behaviour = join(root, 'claude.update')
    fakeExe(join(root, 'tools', 'claude'), `if (argv[0] === 'update') {
  const mode = fs.readFileSync(${q(behaviour)}, 'utf8')
  if (mode === 'fail') { console.error('network down'); process.exit(1) }
  if (mode === 'bump') fs.writeFileSync(${q(state)}, '2.1.291')
}`)
    const claude = fakeAdapter('claude', { version: () => read(state), path: join(bin, 'claude') })
    const f = fakeFetch({ [npmUrl('@anthropic-ai/claude-code')]: { 'dist-tags': { latest: '2.1.293' }, time: { '2.1.293': daysAgo(NOW, 10) }, versions: { '2.1.293': {} } } })
    await withDeps({ repoRoot: () => repo, adapters: async () => [claude], fetch: f, now: () => NOW }, async () => {
      await withEnv({ PATH: narrowPath(join(root, 'tools')) }, async () => {
        const check = memoryIO({ json: true })
        writeFileSync(state, '2.1.290')
        expect(await updateRun(['harness', '--json'], check)).toBe(0)
        expect((JSON.parse(check.out()) as { items: unknown[] }).items[0]).toMatchObject({ action: 'self-update', command: ['claude', 'update'], source: 'native installer' })

        writeFileSync(behaviour, 'bump')
        const bumped = memoryIO()
        expect(await updateRun(['--yes', 'harness'], bumped)).toBe(0)
        expect(bumped.out()).toContain('applied  harness claude: claude update → 2.1.291; channel is behind the registry latest (2.1.293)')

        writeFileSync(state, '2.1.290')
        writeFileSync(behaviour, 'same')
        const same = memoryIO()
        expect(await updateRun(['--yes', 'harness'], same)).toBe(0)
        expect(same.out()).toContain('skipped  harness claude: claude update found nothing newer than 2.1.290 (registry latest 2.1.293)')

        writeFileSync(behaviour, 'fail')
        const failed = memoryIO()
        expect(await updateRun(['--yes', 'harness'], failed)).toBe(1)
        expect(failed.err()).toContain('failed   harness claude: claude update failed: network down')
      })
    })
  }), 60_000)
})

describe('one update for the toolchain, the system tools, the plugins and the skills', () => {
  const LATEST_YAML = `servers:
  alpha:
    description: Alpha
    transport: stdio
    package: { registry: npm, name: "@demo/alpha", version: latest, bin: alpha }
    harnesses: [claude]
    pin: latest
    critical: false
    routing: []
  omega:
    description: Omega
    transport: stdio
    package: { registry: npm, name: omega-mcp, version: latest, bin: omega }
    harnesses: [claude]
    pin: latest
    critical: false
    routing: []
`

  function toolchainState(buracleHome: string, packages: Record<string, string>): void {
    mkdirSync(join(buracleHome, 'state'), { recursive: true })
    const entries = Object.fromEntries(Object.entries(packages).map(([key, version]) => {
      const [registry, ...rest] = key.split(':')
      const name = rest.join(':')
      return [key, { registry, name, version, dir: join(buracleHome, 'toolchain', name), bins: { [name.split('/').pop() as string]: join(buracleHome, 'toolchain', name, 'bin') }, installed_at: '2026-10-01T00:00:00.000Z' }]
    }))
    writeFileSync(join(buracleHome, 'state', 'toolchain.json'), JSON.stringify({ v: 1, updated_at: '2026-10-01T00:00:00.000Z', packages: entries, system: {} }))
  }

  function fakeToolchain(results: Record<string, { status: string, current?: string, detail?: string }>): { runToolchain: OpsDeps['runToolchain'], calls: string[][] } {
    const calls: string[][] = []
    return {
      calls,
      runToolchain: async (_bundle, opts) => {
        calls.push([...(opts.only ?? [])])
        const items = (opts.only ?? []).map(id => ({ id, group: id.startsWith('mcp:') ? 'mcp' : 'lsp', label: id.split(':')[1] ?? id, required: false, status: 'failed', detail: 'not faked', ...results[id] }))
        return { items, state: { v: 1, updated_at: '', packages: {}, system: {} }, changed: true } as unknown as Awaited<ReturnType<OpsDeps['runToolchain']>>
      },
    }
  }

  test('the tools kind checks the toolchain\'s own language servers against their registry; a package shared with an MCP server shows once, under mcp', () => withSandbox(async ({ root, buracleHome }) => {
    // A 3-day release wait (update.minReleaseAgeDays), so the 1-day-old 1.1.405 is held back; by default there is none.
    mkdirSync(buracleHome, { recursive: true })
    writeFileSync(join(buracleHome, 'config.yaml'), 'update:\n  minReleaseAgeDays: 3\n')
    const repo = makeRepo(root)
    toolchainState(buracleHome, { 'npm:pyright': '1.1.400', 'npm:@colbymchenry/codegraph': '1.0.0', 'npm:typescript-language-server': '5.0.0' })
    const f = fakeFetch({
      [npmUrl('pyright')]: { 'dist-tags': { latest: '1.1.405' }, time: { '1.1.400': daysAgo(NOW, 60), '1.1.404': daysAgo(NOW, 9), '1.1.405': daysAgo(NOW, 1) }, versions: { '1.1.400': {}, '1.1.404': {}, '1.1.405': {} } },
      [npmUrl('typescript-language-server')]: { 'dist-tags': { latest: '5.0.0' }, time: { '5.0.0': daysAgo(NOW, 60) }, versions: { '5.0.0': {} } },
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => [], fetch: f, now: () => NOW }, async () => {
      await withEnv({ PATH: narrowPath() }, async () => {
        const io = memoryIO({ json: true })
        expect(await updateRun(['tools', '--json'], io)).toBe(0)
        const r = JSON.parse(io.out()) as { items: Array<Record<string, unknown>>, held: Array<Record<string, unknown>> }
        expect(r.items).toEqual([{ kind: 'tools', id: 'pyright', current: '1.1.400', latest: '1.1.404', action: 'toolchain-upgrade', risk: 'low', source: 'npm pyright (Buracle toolchain)', publishedAt: daysAgo(NOW, 9) }])
        expect(r.held.map(h => `${h.id}:${h.version}`)).toEqual(['pyright:1.1.405'])
        expect(f.calls).not.toContain(npmUrl('@colbymchenry/codegraph'))
      })
    })
  }), 60_000)

  test('toolchain packages are upgraded in-process, one result per package; the handshake runs again for the MCP servers that moved', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root, { 'canonical/mcp.yaml': LATEST_YAML })
    toolchainState(buracleHome, { 'npm:@demo/alpha': '1.0.0', 'npm:omega-mcp': '2.0.0' })
    fakeMcpServer(join(buracleHome, 'bin', 'buracle'), '1.1.0')
    const f = fakeFetch({
      [npmUrl('@demo/alpha')]: { 'dist-tags': { latest: '1.1.0' }, time: { '1.1.0': daysAgo(NOW, 10) }, versions: { '1.0.0': {}, '1.1.0': {} } },
      [npmUrl('omega-mcp')]: { 'dist-tags': { latest: '2.1.0' }, time: { '2.1.0': daysAgo(NOW, 10) }, versions: { '2.0.0': {}, '2.1.0': {} } },
    })
    const tc = fakeToolchain({ 'mcp:alpha': { status: 'upgraded', current: '1.1.0', detail: '1.0.0 → 1.1.0' }, 'mcp:omega': { status: 'failed', detail: 'npm install failed: EACCES' } })
    const cli = fakeCli()
    await withDeps({ repoRoot: () => repo, adapters: async () => [], fetch: f, now: () => NOW, runToolchain: tc.runToolchain, runCli: cli.runCli }, async () => {
      await withEnv({ BURACLE_NO_TOOLCHAIN: undefined }, async () => {
        const io = memoryIO()
        expect(await updateRun(['--yes', 'mcp'], io)).toBe(2)
        expect(tc.calls).toEqual([['mcp:alpha', 'mcp:omega']])
        expect(cli.calls).toEqual([])
        expect(io.out()).toContain('applied  mcp alpha: toolchain 1.0.0 → 1.1.0')
        expect(io.err()).toContain('failed   mcp omega: npm install failed: EACCES')
        expect(io.out()).toContain('handshake alpha: ok, 2 tool(s), v1.1.0')
        expect(io.out()).not.toContain('handshake omega')
        expect(io.out()).not.toContain('canonical/mcp.yaml changed')
      })
    })
    expect(readHealth()?.mcp['alpha']).toMatchObject({ status: 'ok', toolNames: ['lookup', 'resolve'] })
  }), 150_000)

  test('BURACLE_NO_TOOLCHAIN=1 stops every toolchain change of the update', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root, { 'canonical/mcp.yaml': LATEST_YAML })
    toolchainState(buracleHome, { 'npm:@demo/alpha': '1.0.0' })
    const f = fakeFetch({
      [npmUrl('@demo/alpha')]: { 'dist-tags': { latest: '1.1.0' }, time: { '1.1.0': daysAgo(NOW, 10) }, versions: { '1.1.0': {} } },
      [npmUrl('omega-mcp')]: { 'dist-tags': { latest: '1.0.0' }, time: {}, versions: { '1.0.0': {} } },
    })
    const tc = fakeToolchain({})
    await withDeps({ repoRoot: () => repo, adapters: async () => [], fetch: f, now: () => NOW, runToolchain: tc.runToolchain }, async () => {
      await withEnv({ BURACLE_NO_TOOLCHAIN: '1' }, async () => {
        const io = memoryIO()
        expect(await updateRun(['--yes', 'mcp'], io)).toBe(2)
        expect(io.out()).toContain('skipped  mcp alpha: toolchain changes are switched off (BURACLE_NO_TOOLCHAIN=1)')
        expect(tc.calls).toEqual([])
      })
    })
  }), 60_000)

  test('brew tools are applied with the rest, by their catalog name', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const bin = join(root, 'bin')
    const log = join(root, 'calls.log')
    const outdated = { formulae: [{ name: 'ripgrep', installed_versions: ['14.1.0'], current_version: '14.1.1' }, { name: 'bun', full_name: 'oven-sh/bun/bun', installed_versions: ['1.4.2'], current_version: '1.4.3' }] }
    fakeExe(join(bin, 'brew'), `append(${q(log)}, 'brew ' + argv.join(' '))
if (argv[0] === 'outdated') console.log(${q(q(outdated))})`)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], now: () => NOW }, async () => {
      await withEnv({ PATH: narrowPath(bin) }, async () => {
        const io = memoryIO()
        expect(await updateRun(['--yes', 'tools'], io)).toBe(0)
        expect(io.out()).toContain('applied  tools rg: 14.1.0 → 14.1.1')
        expect(io.out()).toContain('applied  tools bun: 1.4.2 → 1.4.3')
        expect(read(log)).toContain('brew upgrade ripgrep\n')
        expect(read(log)).toContain('brew upgrade oven-sh/bun/bun\n')
      })
    })
    expect(brewUpgradeCommand('oven-sh/bun/bun')).toEqual(['brew', 'upgrade', 'oven-sh/bun/bun'])
    expect(brewUpgradeCommand('--greedy')).toBeUndefined()
    expect(brewUpgradeCommand('a/b/c/d')).toBeUndefined()
  }), 60_000)

  test('skills installed with `buracle skills add` are checked and updated with the rest', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const src = join(root, 'skill-src')
    const skill = (extra: string) => `---\nname: alpha\ndescription: alpha does one thing well. Use it when the user asks for alpha.\n${extra}---\n\n# alpha\n\nDo the thing.\n`
    mkdirSync(join(src, 'skills', 'alpha'), { recursive: true })
    writeFileSync(join(src, 'skills', 'alpha', 'SKILL.md'), skill(''))
    await git(src, 'init', '-q', '-b', 'main')
    await git(src, 'add', '-A')
    await git(src, 'commit', '-q', '-m', 'alpha')
    const ctx = { cwd: root, now: NOW, env: { ...process.env } }
    expect((await skillsAdd(`file://${src}`, { skill: ['alpha'] }, ctx)).code).toBe(0)
    writeFileSync(join(src, 'skills', 'alpha', 'SKILL.md'), skill('metadata:\n  version: "2"\n'))
    await git(src, 'add', '-A')
    await git(src, 'commit', '-q', '-m', 'alpha v2')
    await withDeps({ repoRoot: () => repo, adapters: async () => [], now: () => NOW }, async () => {
      const check = memoryIO({ json: true })
      expect(await updateRun(['skills', '--json'], check)).toBe(0)
      expect((JSON.parse(check.out()) as { items: Array<Record<string, unknown>> }).items).toMatchObject([{ kind: 'skills', id: 'alpha', action: 'skill-update', source: 'buracle skills add' }])
      const io = memoryIO()
      expect(await updateRun(['--yes', 'skills'], io)).toBe(0)
      expect(io.out()).toMatch(/applied {2}skills alpha: updated to [0-9a-f]{7}/)
    })
  }), 60_000)

  test('a skill kept at the root of its repository, or in a folder named otherwise, is updated too', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root)
    const skill = (name: string, extra: string) => `---\nname: ${name}\ndescription: ${name} does one thing well. Use it when the user asks for ${name}.\nlicense: MIT\n${extra}---\n\n# ${name}\n\nDo the thing.\n`
    const atRoot = join(root, 'humanizer-src')
    const renamed = join(root, 'taste-src')
    mkdirSync(atRoot, { recursive: true })
    mkdirSync(join(renamed, 'skills', 'taste-skill'), { recursive: true })
    writeFileSync(join(atRoot, 'SKILL.md'), skill('humanizer', ''))
    writeFileSync(join(atRoot, 'README.md'), 'humanizer\n')
    writeFileSync(join(renamed, 'skills', 'taste-skill', 'SKILL.md'), skill('design-taste', ''))
    for (const src of [atRoot, renamed]) {
      await git(src, 'init', '-q', '-b', 'main')
      await git(src, 'add', '-A')
      await git(src, 'commit', '-q', '-m', 'v1')
    }
    const ctx = { cwd: root, now: NOW, env: { ...process.env } }
    for (const src of [atRoot, renamed]) {
      const added = await skillsAdd(`file://${src}`, {}, ctx)
      expect(added.errors).toEqual([])
      expect(added.code).toBe(0)
      expect(added.lines.filter(l => l.includes('.git/'))).toEqual([])
    }
    writeFileSync(join(atRoot, 'SKILL.md'), skill('humanizer', 'metadata:\n  version: "2"\n'))
    writeFileSync(join(renamed, 'skills', 'taste-skill', 'SKILL.md'), skill('design-taste', 'metadata:\n  version: "2"\n'))
    for (const src of [atRoot, renamed]) {
      await git(src, 'add', '-A')
      await git(src, 'commit', '-q', '-m', 'v2')
    }
    await withDeps({ repoRoot: () => repo, adapters: async () => [], now: () => NOW }, async () => {
      const io = memoryIO()
      expect(await updateRun(['--yes', 'skills'], io)).toBe(0)
      expect(io.err()).toBe('')
      expect(io.out()).toMatch(/applied {2}skills design-taste: updated to [0-9a-f]{7}/)
      expect(io.out()).toMatch(/applied {2}skills humanizer: updated to [0-9a-f]{7}/)
    })
    for (const id of ['humanizer', 'design-taste']) expect(readFileSync(join(home, '.agents', 'skills', id, 'SKILL.md'), 'utf8')).toContain('version: "2"')
  }), 60_000)

  test('a new version that fails the lint is reported as needing --force, not as an update that then fails', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const src = join(root, 'alpha-src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'SKILL.md'), '---\nname: alpha\ndescription: alpha does one thing well. Use it when the user asks for alpha.\n---\n\n# alpha\n')
    await git(src, 'init', '-q', '-b', 'main')
    await git(src, 'add', '-A')
    await git(src, 'commit', '-q', '-m', 'v1')
    const ctx = { cwd: root, now: NOW, env: { ...process.env } }
    expect((await skillsAdd(`file://${src}`, {}, ctx)).code).toBe(0)
    writeFileSync(join(src, 'SKILL.md'), '---\nname: alpha\n---\n\n# alpha, now without a description\n')
    await git(src, 'add', '-A')
    await git(src, 'commit', '-q', '-m', 'v2')
    await withDeps({ repoRoot: () => repo, adapters: async () => [], now: () => NOW }, async () => {
      const check = memoryIO({ json: true })
      await updateRun(['skills', '--json'], check)
      expect((JSON.parse(check.out()) as { items: Array<Record<string, unknown>> }).items).toMatchObject([{ kind: 'skills', id: 'alpha', action: 'manual', source: 'buracle skills add', note: expect.stringContaining('`buracle skills update alpha --force`') }])
    })
  }), 60_000)

  test('the check never refreshes the Claude marketplaces; the apply refreshes them, then applies the plugin versions that showed up', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const bin = join(root, 'bin')
    const log = join(root, 'calls.log')
    const market = join(root, 'm')
    mkdirSync(join(market, '.claude-plugin'), { recursive: true })
    writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'pyright-lsp', version: '1.0.0' }] }))
    await behindRemote(root, market, 'market')
    const plugins = [{ id: 'pyright-lsp@official', version: '1.0.0', scope: 'user', enabled: true, installPath: '/x' }]
    const markets = [{ name: 'official', source: 'github', installLocation: market }]
    fakeExe(join(bin, 'claude'), `append(${q(log)}, 'claude ' + argv.join(' '))
const all = argv.join(' ')
if (all === 'plugin list --json') console.log(${q(q(plugins))})
if (all === 'plugin marketplace list --json') console.log(${q(q(markets))})
if (all === 'plugin marketplace update') fs.writeFileSync(${q(join(market, '.claude-plugin', 'marketplace.json'))}, '{"plugins":[{"name":"pyright-lsp","version":"1.2.0"}]}')
if (all === 'plugin update pyright-lsp@official --json') console.log('{"outcome":"ok","message":"Updated pyright-lsp to 1.2.0"}')`)
    const adapters = [fakeAdapter('claude', { version: '2.1.293' })]
    const f = fakeFetch({ [npmUrl('@anthropic-ai/claude-code')]: { 'dist-tags': { latest: '2.1.293' }, time: {}, versions: { '2.1.293': {} } } })
    await withDeps({ repoRoot: () => repo, adapters: async () => adapters, fetch: f, now: () => NOW }, async () => {
      await withEnv({ PATH: narrowPath(bin) }, async () => {
        const check = memoryIO({ json: true })
        expect(await updateRun(['plugins', '--json'], check)).toBe(0)
        expect(read(log)).not.toContain('marketplace update')
        const items = (JSON.parse(check.out()) as { items: Array<Record<string, unknown>> }).items
        expect(items.map(i => `${i.kind}:${i.id}`)).toEqual(['plugins:marketplace:official'])
        expect(String(items[0]?.['note'] ?? '')).toBe('')

        const io = memoryIO()
        expect(await updateRun(['--yes', 'plugins'], io)).toBe(0)
        expect(io.out()).toContain('applied  plugins marketplace:official: marketplace refreshed')
        expect(io.out()).toContain('applied  plugins pyright-lsp@official: Updated pyright-lsp to 1.2.0')
      })
    })
  }), 60_000)

  test('a checkout without an upstream is listed as not checked, never as up to date, and does not change the exit code', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], now: () => NOW }, async () => {
      const io = memoryIO()
      expect(await updateRun(['self'], io)).toBe(0)
      expect(io.out()).not.toContain('Everything checked is up to date')
      expect(io.out()).toContain('Not checked: self (the Buracle checkout is not a git repository)')
      const named = memoryIO()
      expect(await updateRun(['buracle'], named)).toBe(0)
      expect(named.out()).toContain('buracle: not checked')
      expect(named.out()).not.toContain('buracle: up to date')
    })
  }), 60_000)

  test('a name is known only when Buracle or Claude Code has it: a typo with @ and an object key such as constructor exit 1', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const cli = fakeCli()
    const run = async (argv: string[]) => argv.join(' ') === 'claude plugin list --json'
      ? { code: 0, stdout: JSON.stringify([{ id: 'helper@acme', version: '1.0.0' }]), stderr: '', timedOut: false }
      : argv.join(' ') === 'claude plugin marketplace list --json'
        ? { code: 0, stdout: JSON.stringify([{ name: 'acme' }]), stderr: '', timedOut: false }
        : { code: 0, stdout: '', stderr: '', timedOut: false }
    await withDeps({ repoRoot: () => repo, adapters: async () => [], runCli: cli.runCli, run, now: () => NOW }, async () => {
      for (const name of ['typo@market', 'marketplace:nope', 'constructor', '__proto__', 'toString']) {
        const io = memoryIO()
        expect({ name, code: await updateRun(['--check', name], io) }).toEqual({ name, code: 1 })
        expect(io.err()).toContain(`unknown kind or name ${name}`)
      }
      for (const name of ['helper@acme', 'marketplace:acme']) {
        const io = memoryIO()
        expect({ name, code: await updateRun(['--check', name], io) }).toEqual({ name, code: 0 })
        expect(io.err()).not.toContain('unknown kind or name')
      }
    })
    const absent = fakeAdapter('claude', { installed: false })
    await withDeps({ repoRoot: () => repo, adapters: async () => [absent], runCli: cli.runCli, run, now: () => NOW }, async () => {
      const io = memoryIO()
      expect(await updateRun(['--check', 'helper@acme'], io)).toBe(0)
      expect(io.out()).toContain('Not checked: plugins (Claude Code is not installed).')
      expect(io.out()).toContain('helper@acme: not checked')
      expect(io.out()).not.toContain('up to date')
    })
  }), 60_000)
})
