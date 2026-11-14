import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { run as updateRun } from '../../../src/cli/commands/update'
import type { OpsDeps } from '../../../src/engine/update/deps'
import { readHealth } from '../../../src/engine/update/mcp'
import { brewUpgradeCommand, npmUrl } from '../../../src/engine/update/updates'
import { skillsAdd } from '../../../src/workflow/skill-install'
import { fakeExe, narrowPath } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { daysAgo, fakeCli, fakeFetch, fakeMcpServer, git, makeRepo, memoryIO, withDeps } from './helpers'

const NOW = Date.parse('2026-10-08T12:00:00Z')
const q = (v: unknown): string => JSON.stringify(v)

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('one update for the toolchain, the system tools and the skills', () => {
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
})
