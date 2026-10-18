import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonicalBundle, McpServerSpec, ToolSpec } from '../../src/core/catalog'
import { runToolchain, type ToolchainItem } from '../../src/engine/toolchain/index'
import { fallbackNpmCache } from '../../src/engine/toolchain/launch'
import { npmPrefix } from '../../src/engine/toolchain/packages'
import { readToolchainState } from '../../src/engine/toolchain/state'
import { installTool } from '../../src/engine/toolchain/system'
import { opsDeps } from '../../src/engine/update/deps'
import type { FetchResult } from '../../src/engine/update/fetch'
import { run as rollbackCommand } from '../../src/cli/commands/rollback'
import { memoryIO } from '../cli/ops/helpers'
import { withEnv, withSandbox } from '../helpers/sandbox'

const DAY = 86_400_000
const NOW = Date.parse('2026-10-12T12:00:00Z')
const PKG = '@acme/srv'

function packument(): FetchResult {
  return {
    ok: true,
    status: 200,
    json: {
      'dist-tags': { latest: '1.2.0' },
      versions: { '1.0.0': {}, '1.1.0': {}, '1.2.0': {} },
      time: { '1.0.0': new Date(NOW - 100 * DAY).toISOString(), '1.1.0': new Date(NOW - 10 * DAY).toISOString(), '1.2.0': new Date(NOW - 1 * DAY).toISOString() },
    },
  }
}

const spec: McpServerSpec = { description: 'd', transport: 'stdio', package: { registry: 'npm', name: PKG, version: 'latest', bin: 'srv' }, harnesses: ['claude'], pin: 'latest', critical: true, routing: [] } as McpServerSpec
const bundle = { mcp: { servers: { srv: spec } }, tools: { tools: [] as ToolSpec[] } } as unknown as Pick<CanonicalBundle, 'mcp' | 'tools'>

interface FakeNpm {
  installs: string[]
  liveDuring: Array<string | undefined>
  failNext?: boolean
}

function installedVersion(prefix: string): string | undefined {
  try { return (JSON.parse(readFileSync(join(prefix, 'node_modules', '@acme', 'srv', 'package.json'), 'utf8')) as { version: string }).version } catch { return undefined }
}

async function withFakes<T>(root: string, fake: FakeNpm, fn: () => Promise<T>): Promise<T> {
  const bin = join(root, 'fakebin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\nexit 1\n')
  chmodSync(join(bin, 'npm'), 0o755)
  const saved = { run: opsDeps.run, fetch: opsDeps.fetch }
  opsDeps.fetch = async url => (url.includes('acme') ? packument() : { ok: false, status: 404, error: 'not found' })
  opsDeps.run = async (argv, opts) => {
    const at = argv.indexOf('--prefix')
    if (argv.includes('install') && at > 0) {
      const prefix = argv[at + 1] as string
      fake.liveDuring.push(installedVersion(npmPrefix(PKG)))
      const deps = (JSON.parse(readFileSync(join(prefix, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }).dependencies
      const version = deps[PKG] as string
      fake.installs.push(version)
      if (fake.failNext === true) {
        fake.failNext = false
        mkdirSync(join(prefix, 'node_modules', '@acme', 'srv'), { recursive: true })
        writeFileSync(join(prefix, 'node_modules', '@acme', 'srv', 'half.js'), '')
        return { code: 1, stdout: '', stderr: 'npm ERR! network', timedOut: false }
      }
      const dir = join(prefix, 'node_modules', '@acme', 'srv')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: PKG, version, bin: { srv: 'cli.js' } }))
      writeFileSync(join(dir, 'cli.js'), `console.log(${JSON.stringify(version)})\n`)
      void opts
      return { code: 0, stdout: '', stderr: '', timedOut: false }
    }
    return { code: 0, stdout: '', stderr: '', timedOut: false }
  }
  try {
    return await withEnv({ PATH: `${bin}:${process.env['PATH'] ?? ''}` }, fn)
  } finally {
    opsDeps.run = saved.run
    opsDeps.fetch = saved.fetch
  }
}

async function toolchain(opts: { upgrade?: boolean, nowMs?: number } = {}): Promise<ToolchainItem> {
  const r = await runToolchain(bundle, { install: true, upgrade: opts.upgrade ?? true, system: false, checkLatest: true, only: ['mcp'], nowMs: () => opts.nowMs ?? NOW })
  const item = r.items.find(i => i.id === 'mcp:srv')
  if (item === undefined) throw new Error('no item')
  return item
}

describe('release cooldown (update.minReleaseAgeDays)', () => {
  test('a fresh install takes the newest release at least minReleaseAgeDays old, not the 1-day-old latest', () => withSandbox(async ({ root }) => {
    const fake: FakeNpm = { installs: [], liveDuring: [] }
    await withFakes(root, fake, async () => {
      const item = await toolchain()
      expect(item.status).toBe('installed')
      expect(item.current).toBe('1.1.0')
    })
    expect(fake.installs).toEqual(['1.1.0'])
    expect(readToolchainState().packages[`npm:${PKG}`]?.version).toBe('1.1.0')
  }))

  test('the configured minimum age applies (0 days takes the newest release)', () => withSandbox(async ({ root, buracleHome }) => {
    mkdirSync(buracleHome, { recursive: true })
    writeFileSync(join(buracleHome, 'config.yaml'), 'update:\n  minReleaseAgeDays: 0\n')
    const fake: FakeNpm = { installs: [], liveDuring: [] }
    await withFakes(root, fake, async () => {
      expect((await toolchain()).current).toBe('1.2.0')
    })
  }))

  test('an installed package is not upgraded to a release younger than the minimum age', () => withSandbox(async ({ root }) => {
    const fake: FakeNpm = { installs: [], liveDuring: [] }
    await withFakes(root, fake, async () => {
      await toolchain()
      const again = await toolchain()
      expect(again.status).toBe('ok')
      expect(again.current).toBe('1.1.0')
    })
    expect(fake.installs).toEqual(['1.1.0'])
  }))

  test('a system tool from npm (installTool) honors the minimum age too', () => withSandbox(async ({ root }) => {
    const fake: FakeNpm = { installs: [], liveDuring: [] }
    const tool: ToolSpec = { name: 'srv', check: ['srv', '--version'], version_regex: '(\\d+\\.\\d+\\.\\d+)', required: true, npm: PKG, bins: ['srv'] }
    await withFakes(root, fake, async () => {
      const r = await installTool(tool, NOW)
      expect(r.ok).toBe(true)
      expect(r.pkg?.version).toBe('1.1.0')
    })
    expect(fake.installs).toEqual(['1.1.0'])
  }))
})

describe('a tool the toolchain installed from npm without prefer: toolchain', () => {
  test('moves to the newest allowed release on the next install, like the toolchain\'s own packages (what `buracle update tools` applies)', () => withSandbox(async ({ root }) => {
    const fake: FakeNpm = { installs: [], liveDuring: [] }
    const tool: ToolSpec = { name: 'srv', check: ['srv', '--version'], version_regex: '(\\d+\\.\\d+\\.\\d+)', required: false, kind: 'cli', npm: PKG, bins: ['srv'] }
    const withTool = { mcp: { servers: {} }, tools: { tools: [tool] } } as unknown as Pick<CanonicalBundle, 'mcp' | 'tools'>
    const run = (nowMs: number) => runToolchain(withTool, { install: true, upgrade: true, system: false, checkLatest: true, only: ['tool:srv'], nowMs: () => nowMs })
    await withFakes(root, fake, async () => {
      const first = (await run(NOW - 8 * DAY)).items.find(i => i.id === 'tool:srv')
      expect(first).toMatchObject({ status: 'installed', current: '1.0.0' })
      const second = (await run(NOW)).items.find(i => i.id === 'tool:srv')
      expect(second).toMatchObject({ status: 'upgraded', current: '1.1.0' })
    })
    expect(fake.installs).toEqual(['1.0.0', '1.1.0'])
    expect(readToolchainState().packages[`npm:${PKG}`]).toMatchObject({ version: '1.1.0', links: ['srv'], previous: { version: '1.0.0' } })
  }))
})

describe('the npx fallback cache', () => {
  test('once the toolchain holds every npm package server, the fallback\'s download cache is dropped (its installed trees stay)', () => withSandbox(async ({ root }) => {
    const fake: FakeNpm = { installs: [], liveDuring: [] }
    const cacache = join(fallbackNpmCache(), '_cacache', 'content-v2', 'blob')
    const npx = join(fallbackNpmCache(), '_npx', '0123abcd', 'package.json')
    for (const f of [cacache, npx]) { mkdirSync(join(f, '..'), { recursive: true }); writeFileSync(f, 'x') }
    await withFakes(root, fake, async () => {
      fake.failNext = true
      await toolchain()
      expect(existsSync(cacache)).toBe(true)
      await toolchain()
    })
    expect(existsSync(join(fallbackNpmCache(), '_cacache'))).toBe(false)
    expect(existsSync(npx)).toBe(true)
  }))
})

describe('staged upgrades and the previous prefix', () => {
  test('an upgrade installs into a staging prefix; the live prefix keeps the old version until the swap; one previous prefix is kept', () => withSandbox(async ({ root }) => {
    const fake: FakeNpm = { installs: [], liveDuring: [] }
    await withFakes(root, fake, async () => {
      await toolchain({ nowMs: NOW - 8 * DAY })
      expect(installedVersion(npmPrefix(PKG))).toBe('1.0.0')
      const up = await toolchain()
      expect(up.status).toBe('upgraded')
      expect(up.detail).toBe('1.0.0 → 1.1.0; 1.2.0 held back (released 1 day(s) ago, minimum age 3)')
    })
    expect(fake.installs).toEqual(['1.0.0', '1.1.0'])
    expect(fake.liveDuring).toEqual([undefined, '1.0.0'])
    expect(installedVersion(npmPrefix(PKG))).toBe('1.1.0')
    expect(installedVersion(`${npmPrefix(PKG)}.previous`)).toBe('1.0.0')
    const pkg = readToolchainState().packages[`npm:${PKG}`]
    expect(pkg?.version).toBe('1.1.0')
    expect(pkg?.previous?.version).toBe('1.0.0')
    expect(pkg?.bins['srv']).toBe(join(npmPrefix(PKG), 'node_modules', '@acme', 'srv', 'cli.js'))
    expect(existsSync(`${npmPrefix(PKG)}.staging`)).toBe(false)
  }))

  test('a failed upgrade leaves the live prefix exactly as it was and says so', () => withSandbox(async ({ root }) => {
    const fake: FakeNpm = { installs: [], liveDuring: [] }
    await withFakes(root, fake, async () => {
      await toolchain({ nowMs: NOW - 8 * DAY })
      fake.failNext = true
      const up = await toolchain()
      expect(up.status).toBe('outdated')
      expect(up.detail).toContain('1.0.0 kept')
    })
    expect(installedVersion(npmPrefix(PKG))).toBe('1.0.0')
    expect(existsSync(join(npmPrefix(PKG), 'node_modules', '@acme', 'srv', 'half.js'))).toBe(false)
    expect(existsSync(`${npmPrefix(PKG)}.staging`)).toBe(false)
    expect(readToolchainState().packages[`npm:${PKG}`]?.version).toBe('1.0.0')
  }))

  test('`buracle rollback toolchain` swaps the previous prefix back, and the next install does not take the rolled-back version again', () => withSandbox(async ({ root }) => {
    const fake: FakeNpm = { installs: [], liveDuring: [] }
    await withFakes(root, fake, async () => {
      await toolchain({ nowMs: NOW - 8 * DAY })
      await toolchain()
      const io = memoryIO()
      expect(await rollbackCommand(['toolchain'], io)).toBe(0)
      expect(io.out()).toContain(`rolled back ${PKG}: 1.1.0 → 1.0.0`)
      expect(installedVersion(npmPrefix(PKG))).toBe('1.0.0')
      expect(installedVersion(`${npmPrefix(PKG)}.previous`)).toBe('1.1.0')
      const pkg = readToolchainState().packages[`npm:${PKG}`]
      expect(pkg?.version).toBe('1.0.0')
      expect(pkg?.bins['srv']).toBe(join(npmPrefix(PKG), 'node_modules', '@acme', 'srv', 'cli.js'))
      const again = await toolchain()
      expect(again.status).toBe('ok')
      expect(again.current).toBe('1.0.0')
    })
    expect(fake.installs).toEqual(['1.0.0', '1.1.0'])
  }))

  test('rollback without a previous copy says so and changes nothing', () => withSandbox(async ({ root }) => {
    const fake: FakeNpm = { installs: [], liveDuring: [] }
    await withFakes(root, fake, async () => {
      await toolchain()
      const io = memoryIO()
      expect(await rollbackCommand(['toolchain'], io)).toBe(1)
      expect(io.err()).toContain('no previous version')
    })
    expect(installedVersion(npmPrefix(PKG))).toBe('1.1.0')
  }))
})
