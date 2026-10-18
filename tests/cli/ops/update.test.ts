import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkSummary, run as updateRun } from '../../../src/cli/commands/update'
import { run as procRun } from '../../../src/engine/proc'
import { readHealth } from '../../../src/engine/update/mcp'
import { readUpdatesCache, writeUpdatesCache } from '../../../src/engine/update/updates-cache'
import { npmUrl, pypiUrl, TESTED_WITH } from '../../../src/engine/update/updates'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { behindRemote, daysAgo, FAKE_MCP_MAIN as FAKE_MAIN, fakeAdapter, fakeCli, fakeFetch, git, makeRepo, memoryIO, withDeps, writeExe } from './helpers'

const NOW = Date.parse('2026-10-08T12:00:00Z')

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

const MCP_YAML = `# test servers
servers:
  alpha:
    description: Alpha
    transport: stdio
    package: { registry: npm, name: "@demo/alpha", version: 1.0.0 }   # pinned
    command: "{buracle}"
    args: ["serve-alpha", "{version}"]
    harnesses: [claude, codex]
    pin: hard
    critical: false
    routing: []
  beta:
    description: Beta
    transport: stdio
    package: { registry: pypi, name: beta-mcp, version: 0.6.2 }
    command: uvx
    args: ["beta-mcp=={version}"]
    harnesses: [claude]
    pin: soft
    pin_reason: waiting for Intel wheels
    critical: false
    routing: []
  gamma:
    description: Gamma
    transport: stdio
    package: { registry: npm, name: gamma-mcp, version: 2.0.0 }
    command: npx
    args: ["-y", "gamma-mcp@{version}"]
    harnesses: [claude]
    pin: hard
    critical: false
    routing: []
  web:
    description: Web
    transport: http
    url: https://mcp.example.test
    harnesses: [claude]
    pin: monitor
    critical: false
    routing: []
`

function registryRoutes() {
  return {
    [npmUrl('@demo/alpha')]: {
      'dist-tags': { latest: '1.2.0' },
      time: { '1.0.0': daysAgo(NOW, 60), '1.1.0': daysAgo(NOW, 10), '1.2.0': daysAgo(NOW, 1) },
      versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {} },
    },
    [pypiUrl('beta-mcp')]: {
      info: { version: '0.7.0' },
      releases: { '0.6.2': [{ upload_time_iso_8601: daysAgo(NOW, 90) }], '0.7.0': [{ upload_time_iso_8601: daysAgo(NOW, 20) }], '0.8.0': [{ upload_time_iso_8601: daysAgo(NOW, 9), yanked: true }] },
    },
    [npmUrl('gamma-mcp')]: {
      'dist-tags': { latest: '2.0.1' },
      time: { '2.0.0': daysAgo(NOW, 30), '2.0.1': daysAgo(NOW, 1) },
      versions: { '2.0.0': {}, '2.0.1': {} },
    },
  }
}

describe('buracle update --check', () => {
  test('MCP pins: cooldown, held releases, soft pins and yanked PyPI releases; writes updates.json', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root, { 'canonical/mcp.yaml': MCP_YAML })
    const f = fakeFetch(registryRoutes())
    await withDeps({ repoRoot: () => repo, adapters: async () => [], fetch: f, now: () => NOW }, async () => {
      const io = memoryIO()
      expect(await updateRun(['mcp'], io)).toBe(0)
      expect(io.out()).toContain('2 update(s) available:')
      expect(io.out()).toMatch(/mcp\s+alpha\s+1\.0\.0\s+1\.1\.0\s+bump-pin\s+medium/)
      expect(io.out()).toMatch(/mcp\s+beta\s+0\.6\.2\s+0\.7\.0\s+review\s+high\s+pypi beta-mcp; soft pin kept on purpose: waiting for Intel wheels/)
      expect(io.out()).toContain('held back: mcp alpha 1.2.0 (released 1 day(s) ago; minimum age 3)')
      expect(io.out()).toContain('held back: mcp gamma 2.0.1')
      const cache = readUpdatesCache()
      expect(cache?.items.map(i => `${i.kind}:${i.id}:${i.latest}:${i.action}`)).toEqual(['mcp:alpha:1.1.0:bump-pin', 'mcp:beta:0.7.0:review'])
      expect(cache?.held.map(h => h.id)).toEqual(['alpha', 'gamma'])
      expect(f.calls.sort()).toEqual([npmUrl('@demo/alpha'), npmUrl('gamma-mcp'), pypiUrl('beta-mcp')].sort())
    })
  }))

  test('a registry failure is reported per item (exit 2) without hiding the other results', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root, { 'canonical/mcp.yaml': MCP_YAML })
    const routes: Record<string, unknown> = registryRoutes()
    routes[npmUrl('gamma-mcp')] = () => ({ ok: false, status: 0, error: 'timed out after 30000 ms' })
    await withDeps({ repoRoot: () => repo, adapters: async () => [], fetch: fakeFetch(routes), now: () => NOW }, async () => {
      const io = memoryIO({ json: true })
      expect(await updateRun(['mcp', '--json'], io)).toBe(2)
      const r = JSON.parse(io.out()) as { items: unknown[], errors: Array<{ kind: string, id: string, error: string }> }
      expect(r.items.length).toBe(2)
      expect(r.errors).toEqual([{ kind: 'mcp', id: 'gamma', error: 'npm gamma-mcp: timed out after 30000 ms' }])
    })
  }))

  test('harness CLIs, brew tools and Claude plugins/marketplaces', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const bin = join(root, 'bin')
    const log = join(root, 'calls.log')
    const market = join(root, 'markets', 'official')
    mkdirSync(join(market, '.claude-plugin'), { recursive: true })
    writeFileSync(join(market, '.claude-plugin', 'marketplace.json'), JSON.stringify({ name: 'claude-plugins-official', plugins: [{ name: 'pyright-lsp', version: '1.1.0' }, { name: 'gopls-lsp', version: '1.0.0' }] }))
    await behindRemote(root, market, 'market')
    writeExe(join(bin, 'claude'), `echo "$@" >> '${log}'
case "$*" in
  "plugin list --json") echo '[{"id":"pyright-lsp@claude-plugins-official","version":"1.0.0","scope":"user","enabled":true,"installPath":"/x"},{"id":"gopls-lsp@claude-plugins-official","version":"1.0.0","scope":"user","enabled":true,"installPath":"/y"},{"id":"buracle@buracle","version":"0.1.0","scope":"user","enabled":true,"installPath":"/z"}]' ;;
  "plugin marketplace list --json") echo '[{"name":"claude-plugins-official","source":"github","repo":"anthropics/claude-plugins-official","installLocation":"${market}"}]' ;;
esac`)
    writeExe(join(bin, 'brew'), `echo "$@" >> '${log}'
[ "$1" = "outdated" ] && echo '{"formulae":[{"name":"ripgrep","installed_versions":["14.1.0"],"current_version":"14.1.1","pinned":false},{"name":"wget","installed_versions":["1"],"current_version":"2"}],"casks":[]}'
exit 0`)
    const adapters = [
      fakeAdapter('claude', { version: '2.1.290' }),
      fakeAdapter('codex', { version: '0.160.0' }),
      fakeAdapter('opencode', { version: '2.0.20' }),
      fakeAdapter('omp', { version: '18.8.3' }),
    ]
    const [maj, min, patch] = TESTED_WITH.claude.tested.split('.').map(Number) as [number, number, number]
    const newer = `${maj}.${min}.${patch + 1}`
    const f = fakeFetch({
      [npmUrl('@anthropic-ai/claude-code')]: { 'dist-tags': { latest: newer }, time: { [newer]: daysAgo(NOW, 5) }, versions: { [newer]: {} } },
      [npmUrl('@openai/codex')]: { 'dist-tags': { latest: '0.161.0' }, time: { '0.161.0': daysAgo(NOW, 1) }, versions: { '0.161.0': {}, '0.162.0-alpha.1': {} } },
      'https://opencode.ai/update/api/latest/cli/npm': { version: '2.0.24', metadata: { package: '@opencode/cli' } },
      [npmUrl('@oh-my-pi/pi-coding-agent')]: { 'dist-tags': { latest: '18.8.3' }, time: {}, versions: { '18.8.3': {} } },
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => adapters, fetch: f, now: () => NOW }, async () => {
      await withEnv({ PATH: `${bin}:/usr/bin:/bin` }, async () => {
        const io = memoryIO({ json: true })
        expect(await updateRun(['harness', 'tools', 'plugins', '--json'], io)).toBe(0)
        const r = JSON.parse(io.out()) as { items: Array<{ kind: string, id: string, current: string, latest: string, action: string, risk: string, note?: string, command?: string[] }> }
        const byId = Object.fromEntries(r.items.map(i => [`${i.kind}:${i.id}`, i]))
        expect(Object.keys(byId).sort()).toEqual(['harness:claude', 'harness:codex', 'harness:opencode', 'plugins:marketplace:claude-plugins-official', 'plugins:pyright-lsp@claude-plugins-official', 'tools:rg'])
        expect(byId['harness:claude']).toMatchObject({ action: 'self-update', command: ['claude', 'update'], source: 'its own updater (claude update)', current: '2.1.290', latest: newer, risk: 'medium' })
        expect(byId['harness:claude']?.note).toContain('newer than the version Buracle was tested with')
        expect(byId['harness:claude']?.note).not.toContain('report only')
        expect(byId['harness:codex']).toMatchObject({ action: 'self-update', command: ['codex', 'update'], risk: 'high' })
        expect(byId['harness:codex']?.note).toContain('released 1 day(s) ago')
        expect(byId['harness:opencode']).toMatchObject({ latest: '2.0.24', command: ['opencode', 'upgrade'], risk: 'low' })
        expect(byId['tools:rg']).toMatchObject({ current: '14.1.0', latest: '14.1.1', command: ['brew', 'upgrade', 'ripgrep'] })
        expect(byId['plugins:pyright-lsp@claude-plugins-official']).toMatchObject({ current: '1.0.0', latest: '1.1.0', action: 'plugin-update' })
        expect(byId['plugins:marketplace:claude-plugins-official']).toMatchObject({ action: 'marketplace-update', command: ['claude', 'plugin', 'marketplace', 'update', 'claude-plugins-official'] })
      })
      expect(read(log).trim().split('\n').sort()).toEqual(['outdated --json=v2', 'plugin list --json', 'plugin marketplace list --json'])
    })
  }))

  test('self and git skill sources compare with their upstream; a kind left out keeps its cached items', () => withSandbox(async ({ root, buracleHome }) => {
    const repo = makeRepo(root)
    await behindRemote(root, repo, 'buracle')
    const skillsRemote = join(root, 'skills-src')
    mkdirSync(skillsRemote)
    writeFileSync(join(skillsRemote, 'README.md'), 'skills\n')
    const { bare } = await behindRemote(root, skillsRemote, 'skills')
    mkdirSync(buracleHome, { recursive: true })
    writeFileSync(join(buracleHome, 'config.yaml'), `skills:\n  sources:\n    - { name: buracle, path: canonical/skills }\n    - { name: mine, git: "${bare}" }\n`)
    writeUpdatesCache({ checked_at: '2026-10-01T00:00:00.000Z', kinds: ['tools'], items: [{ kind: 'tools', id: 'jq', current: '1.7', latest: '1.8', action: 'brew-upgrade', risk: 'medium' }], held: [], errors: [] })
    await withDeps({ repoRoot: () => repo, adapters: async () => [], now: () => NOW }, async () => {
      const io = memoryIO({ json: true })
      expect(await updateRun(['--check', 'self', 'skills', '--json'], io)).toBe(0)
      const r = JSON.parse(io.out()) as { items: Array<{ kind: string, id: string, action: string, note?: string }> }
      expect(r.items.map(i => `${i.kind}:${i.id}:${i.action}`)).toEqual(['self:buracle:ff-merge', 'skills:mine:clone'])
      expect(r.items[0]?.note).toContain('1 commit(s) behind origin/main')
      expect(readUpdatesCache()?.items.map(i => `${i.kind}:${i.id}`)).toEqual(['self:buracle', 'skills:mine', 'tools:jq'])
    })
  }))
})

describe('buracle update --yes', () => {
  test('bumps hard pins byte-minimally, rebuilds, reinstalls and re-runs the handshake of the bumped server', () => withSandbox(async ({ root, home }) => {
    const repo = makeRepo(root, { 'canonical/mcp.yaml': MCP_YAML, 'src/cli/main.ts': FAKE_MAIN })
    const cli = fakeCli()
    const codex = fakeAdapter('codex', { plan: () => ({ id: 'codex', harness: 'codex', ops: [{ kind: 'file', path: join(home, '.codex/marker'), content: 'x\n', owner: 'codex' }] }) })
    await withDeps({ repoRoot: () => repo, adapters: async () => [codex], fetch: fakeFetch(registryRoutes()), now: () => NOW, runCli: cli.runCli }, async () => {
      await withEnv({ PATH: '/usr/bin:/bin' }, async () => {
        const noYes = memoryIO()
        expect(await updateRun(['mcp'], noYes)).toBe(0)
        expect(noYes.out()).toContain('Apply with `buracle update --yes`')
        expect(read(join(repo, 'canonical/mcp.yaml'))).toBe(MCP_YAML)

        const io = memoryIO()
        const code = await updateRun(['--yes', 'mcp'], io)
        expect(io.out()).toContain('applied  mcp alpha: pin → 1.1.0')
        expect(io.out()).toContain('skipped  mcp beta: soft pin: bump it by hand after review')
        expect(io.out()).toContain('handshake alpha: ok, 2 tool(s), v1.1.0')
        expect(code).toBe(2)
      })
      expect(read(join(repo, 'canonical/mcp.yaml'))).toBe(MCP_YAML.replace('version: 1.0.0 }   # pinned', 'version: 1.1.0 }   # pinned'))
      expect(existsSync(join(repo, 'harness/.manifest.json'))).toBe(true)
      expect(read(join(home, '.codex/marker'))).toBe('x\n')
      expect(readHealth()?.mcp['alpha']).toMatchObject({ status: 'ok', version: '1.1.0', toolNames: ['lookup', 'resolve'] })
      expect(readUpdatesCache()?.items.map(i => `${i.kind}:${i.id}`)).toEqual(['mcp:beta'])
    })
  }))

  test('harness self-updates, plugin updates and brew upgrades in one apply', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const bin = join(root, 'bin')
    const log = join(root, 'calls.log')
    const codexVersion = join(root, 'codex.version')
    writeFileSync(codexVersion, '0.160.0')
    writeExe(join(bin, 'codex'), `echo "codex $@" >> '${log}'
[ "$1" = "update" ] && printf 0.161.0 > '${codexVersion}'
exit 0`)
    for (const name of ['opencode', 'omp']) writeExe(join(bin, name), `echo "${name} $@" >> '${log}'`)
    writeExe(join(bin, 'brew'), `echo "brew $@" >> '${log}'
[ "$1" = "outdated" ] && echo '{"formulae":[{"name":"ripgrep","installed_versions":["14.1.0"],"current_version":"14.1.1"}]}'
exit 0`)
    writeExe(join(bin, 'claude'), `echo "claude $@" >> '${log}'
case "$*" in
  "plugin list --json") echo '[{"id":"pyright-lsp@official","version":"1.0.0","scope":"user","enabled":true,"installPath":"/x"}]' ;;
  "plugin marketplace list --json") echo '[{"name":"official","source":"directory","path":"/m","installLocation":"${join(root, 'm')}"}]' ;;
  "plugin update pyright-lsp@official --json") echo 'Checking for updates…'; echo '{"command":"update","outcome":"ok","message":"Updated pyright-lsp to 1.1.0"}' ;;
esac`)
    mkdirSync(join(root, 'm', '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, 'm', '.claude-plugin', 'marketplace.json'), JSON.stringify({ plugins: [{ name: 'pyright-lsp', version: '1.1.0' }] }))
    const adapters = [fakeAdapter('claude', { version: '2.1.293' }), fakeAdapter('codex', { version: () => read(codexVersion) }), fakeAdapter('opencode', { version: '2.0.20' })]
    const f = fakeFetch({
      [npmUrl('@anthropic-ai/claude-code')]: { 'dist-tags': { latest: '2.1.293' }, time: {}, versions: { '2.1.293': {} } },
      [npmUrl('@openai/codex')]: { 'dist-tags': { latest: '0.161.0' }, time: { '0.161.0': daysAgo(NOW, 10) }, versions: { '0.161.0': {} } },
      'https://opencode.ai/update/api/latest/cli/npm': () => ({ ok: false, status: 503, error: 'HTTP 503' }),
    })
    await withDeps({ repoRoot: () => repo, adapters: async () => adapters, fetch: f, now: () => NOW, runCli: fakeCli().runCli }, async () => {
      await withEnv({ PATH: `${bin}:/usr/bin:/bin` }, async () => {
        const io = memoryIO()
        const code = await updateRun(['--yes', 'harness', 'plugins', 'tools'], io)
        expect(io.out()).toContain('applied  harness codex: codex update → 0.161.0')
        expect(io.out()).toContain('applied  plugins pyright-lsp@official: Updated pyright-lsp to 1.1.0')
        expect(io.out()).toContain('applied  tools rg: 14.1.0 → 14.1.1')
        expect(code).toBe(2)
        expect(read(log)).toContain('brew upgrade ripgrep\n')
        expect(read(log)).toContain('claude plugin marketplace update\n')
        expect(read(log)).toContain('codex update\n')
      })
    })
  }))

  test('the Homebrew tools apply with --yes like everything else, and the check points to --yes', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const bin = join(root, 'bin')
    const log = join(root, 'calls.log')
    writeExe(join(bin, 'brew'), `echo "brew $@" >> '${log}'
[ "$1" = "outdated" ] && echo '{"formulae":[{"name":"ripgrep","installed_versions":["14.1.0"],"current_version":"14.1.1"}]}'
exit 0`)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], now: () => NOW }, async () => {
      await withEnv({ PATH: `${bin}:/usr/bin:/bin` }, async () => {
        const check = memoryIO()
        expect(await updateRun(['tools'], check)).toBe(0)
        expect(check.out()).toContain('Apply with `buracle update --yes`')
        expect(readUpdatesCache()?.items.map(i => `${i.kind}:${i.id}`)).toEqual(['tools:rg'])

        const io = memoryIO()
        expect(await updateRun(['--yes', 'tools'], io)).toBe(0)
        expect(io.out()).toContain('applied  tools rg: 14.1.0 → 14.1.1')
        expect(read(log)).toContain('brew upgrade ripgrep\n')
        expect(readUpdatesCache()?.items).toEqual([])
      })
    })
  }))

  test('the check without a terminal points to --yes; --check alone prints no apply hint', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root, { 'canonical/mcp.yaml': MCP_YAML })
    await withDeps({ repoRoot: () => repo, adapters: async () => [], fetch: fakeFetch(registryRoutes()), now: () => NOW }, async () => {
      const io = memoryIO()
      expect(await updateRun(['mcp'], io)).toBe(0)
      expect(io.out()).toContain('Apply with `buracle update --yes` (name kinds or items to limit it).')
      const check = memoryIO()
      expect(await updateRun(['mcp', '--check'], check)).toBe(0)
      expect(check.out()).not.toContain('Apply with')
    })
  }))

  test('self with other kinds: self first and the install without the toolchain, then the rest by the new code in a child; a reverted self skips the rest', () => withSandbox(async ({ root }) => {
    for (const installFails of [false, true]) {
      const base = join(root, installFails ? 'fails' : 'works')
      mkdirSync(base, { recursive: true })
      const repo = makeRepo(base)
      await behindRemote(base, repo, 'buracle')
      const bin = join(base, 'bin')
      writeExe(join(bin, 'brew'), `[ "$1" = "outdated" ] && echo '{"formulae":[{"name":"ripgrep","installed_versions":["14.1.0"],"current_version":"14.1.1"}]}'
exit 0`)
      const spawned: Array<{ argv: string[], noToolchain: string | undefined }> = []
      await withDeps({
        repoRoot: () => repo, adapters: async () => [], now: () => NOW,
        run: async (argv, o) => {
          if (argv[1] !== join(repo, 'src', 'cli', 'main.ts')) return procRun(argv, o)
          spawned.push({ argv: argv.slice(2), noToolchain: o?.env?.['BURACLE_NO_TOOLCHAIN'] })
          if (argv[2] === 'install') return { code: installFails ? 1 : 0, stdout: installFails ? '' : 'installed\n', stderr: installFails ? 'the new runtime failed its check\n' : '', timedOut: false }
          return { code: 0, stdout: JSON.stringify({ ok: true, code: 0, applied: [{ kind: 'tools', id: 'rg', detail: '14.1.0 → 14.1.1' }], failed: [], skipped: [], harnessChecks: [] }), stderr: '', timedOut: false }
        },
      }, async () => {
        await withEnv({ PATH: `${bin}:/usr/bin:/bin`, BURACLE_NO_TOOLCHAIN: undefined }, async () => {
          const io = memoryIO()
          const code = await updateRun(['--yes', 'self', 'tools'], io)
          if (installFails) {
            expect(code).toBe(2)
            expect(spawned.map(s => s.argv[0])).toEqual(['install'])
            expect(io.out()).toContain('skipped  tools rg: self update was reverted')
          } else {
            expect(code).toBe(0)
            expect(spawned).toEqual([{ argv: ['install', '--yes'], noToolchain: '1' }, { argv: ['update', '--yes', '--json', 'tools'], noToolchain: undefined }])
            expect(io.out()).toMatch(/applied {2}self buracle: /)
            expect(io.out()).toContain('applied  tools rg: 14.1.0 → 14.1.1')
          }
        })
      })
    }
  }), 60_000)

  test('self: fast-forwards the checkout and runs the follow-up install with the new code', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    await behindRemote(root, repo, 'buracle')
    const spawned: string[][] = []
    await withDeps({
      repoRoot: () => repo,
      adapters: async () => [],
      now: () => NOW,
      run: async (argv, o) => {
        if (argv[1] === join(repo, 'src', 'cli', 'main.ts')) { spawned.push(argv); return { code: 0, stdout: 'synced\n', stderr: '', timedOut: false } }
        return procRun(argv, o)
      },
    }, async () => {
      const io = memoryIO()
      expect(await updateRun(['--yes', 'self'], io)).toBe(0)
      expect(io.out()).toMatch(/applied {2}self buracle: [0-9a-f]+ → [0-9a-f]+/)
      expect(io.out()).toContain('synced')
      expect(existsSync(join(repo, 'NEW.md'))).toBe(true)
      expect(spawned.map(a => a.slice(2))).toEqual([['install', '--yes']])
    })
  }))

  test('pricing goes through src/usage/pricing.ts with the injected fetcher', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root, { 'canonical/pricing.yaml': 'demo-model: { input: 1, output: 2 }\n' })
    const url = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
    const f = fakeFetch({ [url]: { 'demo-model': { input_cost_per_token: 0.000003, output_cost_per_token: 0.000006 } } })
    await withDeps({ repoRoot: () => repo, adapters: async () => [], fetch: f, now: () => NOW }, async () => {
      const io = memoryIO({ json: true })
      expect(await updateRun(['pricing', '--json'], io)).toBe(0)
      expect((JSON.parse(io.out()) as { items: unknown[] }).items).toEqual([{ kind: 'pricing', id: 'pricing.yaml', current: null, latest: null, action: 'refresh', risk: 'low', note: 'list prices changed upstream (LiteLLM)' }])
      expect(read(join(repo, 'canonical/pricing.yaml'))).toBe('demo-model: { input: 1, output: 2 }\n')
      const toolchainCalls: string[][] = []
      await withDeps({ runToolchain: async (_b, o) => { toolchainCalls.push([...(o.only ?? ['everything'])]); return undefined } }, async () => {
        await withEnv({ BURACLE_NO_TOOLCHAIN: undefined }, async () => {
          const io = memoryIO()
          expect(await updateRun(['--yes', 'pricing'], io)).toBe(0)
          expect(io.out()).toContain('Rebuilt and reinstalled')
        })
      })
      expect(toolchainCalls).toEqual([])
      expect(read(join(repo, 'canonical/pricing.yaml'))).toContain('demo-model: { input: 3, output: 6 }')
      expect(read(join(repo, 'canonical/pricing.yaml'))).toContain('# Fetched: 2026-10-08T12:00:00Z')
    })
  }))

  test('rejects bad arguments', async () => {
    const io = memoryIO()
    expect(await updateRun(['mcp', 'nope'], io)).toBe(1)
    expect(io.err()).toContain('unknown kind or name nope')
    expect(await updateRun(['--check', '--apply'], memoryIO())).toBe(1)
    expect(await updateRun(['--bogus'], memoryIO())).toBe(1)
  })

  async function behindWithDeps(root: string, repo: string): Promise<{ before: string }> {
    await behindRemote(root, repo, 'buracle')
    const other = join(root, 'buracle-other')
    writeFileSync(join(other, 'package.json'), '{"name":"buracle-test","version":"0.0.1","dependencies":{"yaml":"2.9.1"}}\n')
    await git(other, 'add', '-A')
    await git(other, 'commit', '-q', '-m', 'new dependency')
    await git(other, 'push', '-q')
    return { before: await git(repo, 'rev-parse', 'HEAD') }
  }

  test('self: a fast-forward that changes package.json runs bun install --frozen-lockfile in the checkout first (O4)', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    await behindWithDeps(root, repo)
    const calls: string[][] = []
    await withDeps({
      repoRoot: () => repo, adapters: async () => [], now: () => NOW,
      run: async (argv, o) => {
        if (argv[1] === 'install') { calls.push([...argv.slice(1), `cwd=${o?.cwd ?? ''}`]); return { code: 0, stdout: '', stderr: '', timedOut: false } }
        if (argv[1] === join(repo, 'src', 'cli', 'main.ts')) { calls.push(argv.slice(2)); return { code: 0, stdout: 'synced\n', stderr: '', timedOut: false } }
        return procRun(argv, o)
      },
    }, async () => {
      const io = memoryIO()
      expect(await updateRun(['--yes', 'self'], io)).toBe(0)
      expect(calls).toEqual([['install', '--frozen-lockfile', `cwd=${repo}`], ['install', '--yes']])
      expect(io.out()).toContain('(bun install --frozen-lockfile)')
    })
  }))

  test('self: when bun install fails after the fast-forward, the checkout moves back to its previous commit (O4)', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const { before } = await behindWithDeps(root, repo)
    await withDeps({
      repoRoot: () => repo, adapters: async () => [], now: () => NOW,
      run: async (argv, o) => {
        if (argv[1] === 'install') return { code: 1, stdout: '', stderr: 'error: lockfile had changes, but lockfile is frozen\n', timedOut: false }
        if (argv[1] === join(repo, 'src', 'cli', 'main.ts')) throw new Error('no sync may run after a failed bun install')
        return procRun(argv, o)
      },
    }, async () => {
      const io = memoryIO()
      expect(await updateRun(['--yes', 'self'], io)).toBe(1)
      expect(io.err()).toContain('bun install --frozen-lockfile failed: error: lockfile had changes')
      expect(io.err()).toContain('the checkout was moved back to')
      expect(await git(repo, 'rev-parse', 'HEAD')).toBe(before)
      expect(existsSync(join(repo, 'NEW.md'))).toBe(false)
    })
  }))

  test('self: when the follow-up install fails, the checkout moves back (clean tree) or stays and says how (local changes) (O4)', () => withSandbox(async ({ root }) => {
    for (const dirty of [false, true]) {
      const base = join(root, dirty ? 'dirty' : 'clean')
      mkdirSync(base, { recursive: true })
      const repo = makeRepo(base)
      await behindRemote(base, repo, 'buracle')
      const before = await git(repo, 'rev-parse', 'HEAD')
      await withDeps({
        repoRoot: () => repo, adapters: async () => [], now: () => NOW,
        run: async (argv, o) => {
          if (argv[1] === join(repo, 'src', 'cli', 'main.ts')) {
            if (dirty) writeFileSync(join(repo, 'package.json'), '{"name":"changed"}\n')
            return { code: 1, stdout: '', stderr: 'buracle install: the new runtime failed its check\n', timedOut: false }
          }
          return procRun(argv, o)
        },
      }, async () => {
        const io = memoryIO()
        expect(await updateRun(['--yes', 'self'], io)).toBe(2)
        expect(io.out()).toContain('so the hooks still run the previous runtime')
        if (dirty) {
          expect(io.out()).toContain('the checkout stays at the new commit because it has local changes')
          expect(await git(repo, 'rev-parse', 'HEAD')).not.toBe(before)
        } else {
          expect(io.out()).toContain('the checkout was moved back to')
          expect(await git(repo, 'rev-parse', 'HEAD')).toBe(before)
        }
      })
    }
  }), 60_000)
})

describe('buracle update [<kind>|<name>…] [--check] [--yes]', () => {
  const harnessRoutes = () => fakeFetch({ [npmUrl('@openai/codex')]: { 'dist-tags': { latest: '0.161.0' }, time: { '0.161.0': daysAgo(NOW, 10) }, versions: { '0.161.0': {} } } })

  test('the removed flags say what replaces them', async () => {
    const run = async (argv: string[]) => { const io = memoryIO(); return { code: await updateRun(argv, io), err: io.err(), out: io.out() } }
    expect(await run(['--apply'])).toEqual({ code: 1, out: '', err: 'buracle update: --apply was removed; run `buracle update` in a terminal, or `buracle update --yes`\n' })
    expect((await run(['--apply-tools', '--yes'])).err).toBe('buracle update: --apply-tools was removed; the Homebrew tools are part of every update now: `buracle update --yes` or `buracle update tools`\n')
    expect((await run(['--only', 'mcp'])).err).toBe('buracle update: --only was removed; name the kinds or items instead: `buracle update mcp tools`\n')
    expect((await run(['--only=mcp,tools'])).code).toBe(1)
    const both = await run(['--check', '--yes'])
    expect(both.code).toBe(1)
    expect(both.err).toContain('--check and --yes are mutually exclusive')
  })

  test('kinds and item names limit the check; an unknown name is an error; a known current one is up to date', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root, { 'canonical/mcp.yaml': MCP_YAML })
    const f = fakeFetch(registryRoutes())
    await withDeps({ repoRoot: () => repo, adapters: async () => [fakeAdapter('codex', { version: '0.161.0' })], fetch: f, now: () => NOW }, async () => {
      const kind = memoryIO({ json: true })
      expect(await updateRun(['mcp', '--json'], kind)).toBe(0)
      expect((JSON.parse(kind.out()) as { kinds: string[], items: Array<{ id: string }> })).toMatchObject({ kinds: ['mcp'], items: [{ id: 'alpha' }, { id: 'beta' }] })

      const one = memoryIO({ json: true })
      expect(await updateRun(['beta', '--json'], one)).toBe(0)
      expect((JSON.parse(one.out()) as { kinds: string[], items: Array<{ id: string }> })).toMatchObject({ kinds: ['mcp'], items: [{ id: 'beta' }] })
      expect(readUpdatesCache()?.items.map(i => i.id)).toEqual(['alpha', 'beta'])

      const current = memoryIO()
      await withDeps({ fetch: harnessRoutes() }, async () => { expect(await updateRun(['codex'], current)).toBe(0) })
      expect(current.out()).toContain('codex: up to date')

      const unknown = memoryIO()
      expect(await updateRun(['frobnicate'], unknown)).toBe(1)
      expect(unknown.err()).toContain('buracle update: unknown kind or name frobnicate (kinds: self, skills, mcp, plugins, harness, tools, pricing; names: a harness, an MCP server, a tool, a skill or a plugin)')
    })
  }))

  test('in a terminal it checks, shows the list and applies at once; without a terminal it only checks unless --yes', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const bin = join(root, 'bin')
    const log = join(root, 'calls.log')
    writeExe(join(bin, 'brew'), `echo "brew $@" >> '${log}'
[ "$1" = "outdated" ] && echo '{"formulae":[{"name":"ripgrep","installed_versions":["14.1.0"],"current_version":"14.1.1"}]}'
exit 0`)
    const asked: string[] = []
    await withDeps({ repoRoot: () => repo, adapters: async () => [], now: () => NOW, confirm: async q => { asked.push(q); return false } }, async () => {
      await withEnv({ PATH: `${bin}:/usr/bin:/bin` }, async () => {
        const piped = memoryIO()
        expect(await updateRun(['tools'], piped)).toBe(0)
        expect(piped.out()).toContain('tools  rg')
        expect(piped.out()).toContain('Apply with `buracle update --yes` (name kinds or items to limit it).')
        expect(read(log)).not.toContain('upgrade')

        const checkOnly = memoryIO({ tty: true })
        expect(await updateRun(['tools', '--check'], checkOnly)).toBe(0)
        expect(read(log)).not.toContain('upgrade')

        const tty = memoryIO({ tty: true })
        expect(await updateRun(['tools'], tty)).toBe(0)
        expect(tty.out()).toContain('tools  rg')
        expect(tty.out()).toContain('applied  tools rg: 14.1.0 → 14.1.1')
        expect(read(log)).toContain('brew upgrade ripgrep')
        expect(asked).toEqual([])
      })
    })
  }))
})

describe('update progress on a terminal', () => {
  const finished = (err: string): string[] => err.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map(l => l.trim()).filter(l => /^[✔▲✖ℹ-] /.test(l) || l.startsWith('── '))

  test('each kind shows its check, each part its update; the end is a tally, not the same lines again', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const bin = join(root, 'bin')
    const log = join(root, 'calls.log')
    writeExe(join(bin, 'brew'), `echo "brew $@" >> '${log}'
[ "$1" = "outdated" ] && echo '{"formulae":[{"name":"ripgrep","installed_versions":["14.1.0"],"current_version":"14.1.1"}]}'
exit 0`)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], now: () => NOW, confirm: async () => { throw new Error('update must not ask') } }, async () => {
      await withEnv({ PATH: `${bin}:/usr/bin:/bin` }, async () => {
        const io = memoryIO({ tty: true, liveErr: true })
        expect(await updateRun(['tools'], io)).toBe(0)
        expect(finished(io.err())).toEqual(['ℹ Tools: 1 update', expect.stringMatching(/^── Updating /), '✔ rg: 14.1.0 → 14.1.1'])
        expect(io.err().replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')).toContain('Tools: checking')
        expect(io.out()).toBe('\n1 updated · 0 skipped · 0 failed\n')
        expect(read(log)).toContain('brew upgrade ripgrep')

        const check = memoryIO({ tty: true, liveErr: true })
        expect(await updateRun(['tools', '--check'], check)).toBe(0)
        expect(finished(check.err())).toEqual(['ℹ Tools: 1 update'])
        expect(check.out()).toContain('tools  rg')
      })
    })
  }))

  test('a part that fails shows in red where it ran, and the exit code says so', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root)
    const bin = join(root, 'bin')
    writeExe(join(bin, 'brew'), `[ "$1" = "outdated" ] && echo '{"formulae":[{"name":"ripgrep","installed_versions":["14.1.0"],"current_version":"14.1.1"}]}'
[ "$1" = "upgrade" ] && { echo "Error: ripgrep is pinned" >&2; exit 1; }
exit 0`)
    await withDeps({ repoRoot: () => repo, adapters: async () => [], now: () => NOW }, async () => {
      await withEnv({ PATH: `${bin}:/usr/bin:/bin` }, async () => {
        const io = memoryIO({ tty: true, liveErr: true })
        expect(await updateRun(['tools'], io)).toBe(1)
        expect(finished(io.err()).at(-1)).toBe('✖ rg: brew upgrade ripgrep failed: Error: ripgrep is pinned')
        expect(io.out()).toBe('\n0 updated · 0 skipped · 1 failed\n')
        expect(io.err()).not.toContain('failed   tools rg')
      })
    })
  }))
})

describe('the update summary never calls a failed check up to date (L2)', () => {
  test('checkSummary names the kinds whose check failed', () => {
    const err = (kind: string) => ({ kind: kind as never, error: 'HTTP 500' })
    expect(checkSummary(['self', 'harness'], { items: [], errors: [] })).toBe('Everything checked is up to date (self, harness).')
    expect(checkSummary(['self', 'harness'], { items: [], errors: [err('harness')] })).toBe('Up to date: self. Not checked (the check failed; errors below): harness.')
    expect(checkSummary(['harness'], { items: [], errors: [err('harness')] })).toBe('No check succeeded. Not checked (the check failed; errors below): harness.')
    expect(checkSummary(['self', 'harness'], { items: [{} as never], errors: [err('harness')] })).toBe('Not checked (the check failed; errors below): harness.\n1 update(s) available:')
  })

  test('buracle update --check with a failing release feed prints no "everything is up to date"', () => withSandbox(async ({ root }) => {
    const repo = makeRepo(root, { 'canonical/mcp.yaml': MCP_YAML })
    const fail = () => ({ ok: false, status: 500, error: 'HTTP 500' })
    const routes: Record<string, unknown> = { [npmUrl('@demo/alpha')]: fail, [pypiUrl('beta-mcp')]: fail, [npmUrl('gamma-mcp')]: fail }
    await withDeps({ repoRoot: () => repo, adapters: async () => [], fetch: fakeFetch(routes), now: () => NOW }, async () => {
      const io = memoryIO()
      expect(await updateRun(['skills', 'mcp'], io)).toBe(2)
      expect(io.out()).not.toContain('Everything checked is up to date')
      expect(io.out()).toContain('Up to date: skills. Not checked (the check failed; errors below): mcp.')
      expect(io.err()).toContain('error: mcp alpha: npm @demo/alpha: HTTP 500')
    })
  }))
})
