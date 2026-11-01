import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonicalBundle, ToolSpec } from '../../src/core/catalog'
import { runToolchain } from '../../src/engine/toolchain/index'
import * as paths from '../../src/engine/paths'
import { installPinnedTool, pinPlatform } from '../../src/engine/toolchain/system-download'
import { SYSTEM_TOOL_PINS, type PinnedAsset, type PinnedTool, type PinnedToolName } from '../../src/engine/toolchain/system-pins'
import { installAdvice, installSources, installTool } from '../../src/engine/toolchain/system'
import { readToolchainState } from '../../src/engine/toolchain/state'
import { IS_WINDOWS, launcherText } from '../helpers/fake-exe'
import { withSandbox } from '../helpers/sandbox'

const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64', 'win32-x64'] as const
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')
const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** A fetch that serves `files` by URL and counts the calls; anything else is a 404. */
function fakeFetch(files: Record<string, Uint8Array>): { fetch: (url: string) => Promise<Response>, calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    fetch: async (url: string) => {
      calls.push(url)
      const body = files[url]
      return body === undefined ? new Response('missing', { status: 404 }) : new Response(body, { status: 200, headers: { 'content-length': String(body.byteLength) } })
    },
  }
}

/** A program that prints `out` and exits `code`, written the way this platform runs it (a .cmd on Windows). */
function program(dir: string, out: string, code = 0): Uint8Array {
  mkdirSync(dir, { recursive: true })
  const script = join(dir, `p-${Math.random().toString(36).slice(2)}.mjs`)
  writeFileSync(script, `console.log(${JSON.stringify(out)}); process.exit(${code})\n`)
  return enc(launcherText(process.execPath, script))
}

const nodeCheck = { argv: ['node', '--version'], regex: 'v(\\d+\\.\\d+\\.\\d+)' }
const here = pinPlatform() as NonNullable<ReturnType<typeof pinPlatform>>
const binName = IS_WINDOWS ? 'node.cmd' : 'node'

function pins(asset: PinnedAsset, version = '26.13.0'): Readonly<Record<PinnedToolName, PinnedTool>> {
  return { ...SYSTEM_TOOL_PINS, node: { version, assets: { [here]: asset } } }
}

describe('the pin table', () => {
  test('four tools, five platforms each, every entry well formed', () => {
    expect(Object.keys(SYSTEM_TOOL_PINS).sort()).toEqual(['jq', 'node', 'rg', 'uv'])
    for (const [name, tool] of Object.entries(SYSTEM_TOOL_PINS)) {
      expect(tool.version).toMatch(/^\d+\.\d+(\.\d+)?$/)
      expect(Object.keys(tool.assets).sort()).toEqual([...PLATFORMS].sort())
      for (const [plat, a] of Object.entries(tool.assets)) {
        expect(a?.url).toStartWith('https://')
        expect(a?.sha256).toMatch(/^[0-9a-f]{64}$/)
        expect(['tar.gz', 'zip', 'bin']).toContain(a?.format as string)
        expect(a?.format === 'zip').toBe(plat === 'win32-x64' && name !== 'jq')
        expect(Object.keys(a?.bins ?? {})).toContain(name)
      }
    }
    expect(SYSTEM_TOOL_PINS.rg.assets['linux-x64']?.url).toContain('x86_64-unknown-linux-musl')
  })

  test('the platform key; an unknown one has none', () => {
    expect(pinPlatform('darwin', 'arm64')).toBe('darwin-arm64')
    expect(pinPlatform('win32', 'x64')).toBe('win32-x64')
    expect(pinPlatform('win32', 'arm64')).toBeUndefined()
    expect(pinPlatform('freebsd', 'x64')).toBeUndefined()
  })
})

describe('install sources with a download', () => {
  const node: ToolSpec = { name: 'node', check: ['node', '--version'], version_regex: 'v(\\d+\\.\\d+\\.\\d+)', required: true, brew: 'node', winget: 'OpenJS.NodeJS.LTS', scoop: 'nodejs-lts' }
  test('a package manager comes first; without one the pinned download is the source', () => {
    expect(installSources(node, 'linux', () => false, 'x64').map(s => s.kind)).toEqual(['download'])
    expect(installSources(node, 'linux', c => c === 'brew', 'x64').map(s => s.kind)).toEqual(['brew', 'download'])
    expect(installSources(node, 'darwin', () => false, 'arm64').map(s => s.label)).toEqual([`node ${SYSTEM_TOOL_PINS.node.version} download (Buracle toolchain)`])
    expect(installSources(node, 'win32', c => c === 'winget', 'x64').map(s => s.kind)).toEqual(['winget', 'download'])
  })

  test('no pin for the platform: no download source; the advice stays the package manager command', () => {
    expect(installSources(node, 'win32', () => false, 'arm64')).toEqual([])
    expect(installAdvice(node, 'win32', () => false)).toBe('winget install --id OpenJS.NodeJS.LTS -e --scope user')
  })
})

describe('installing a pinned tool', () => {
  test('a matching download is unpacked, checked and recorded; the program runs', () => withSandbox(async ({ root }) => {
    const bytes = program(join(root, 'scripts'), 'v26.13.0')
    const url = 'https://example.test/node'
    const f = fakeFetch({ [url]: bytes })
    const r = await installPinnedTool('node', { fetch: f.fetch, pins: pins({ url, sha256: sha(bytes), format: 'bin', bins: { node: binName } }), check: nodeCheck })
    expect(r).toMatchObject({ ok: true, version: '26.13.0', check: '26.13.0' })
    const bin = join(paths.systemToolsDir(), 'node', binName)
    expect(existsSync(bin)).toBe(true)
    if (!IS_WINDOWS) expect(statSync(bin).mode & 0o111).not.toBe(0)
    expect(readdirSync(paths.systemToolsDir())).toEqual(['node'])
  }))

  test('a sha256 mismatch writes nothing and names both hashes', () => withSandbox(async ({ root }) => {
    const bytes = program(join(root, 'scripts'), 'v26.13.0')
    const url = 'https://example.test/node'
    const want = 'a'.repeat(64)
    const r = await installPinnedTool('node', { fetch: fakeFetch({ [url]: bytes }).fetch, pins: pins({ url, sha256: want, format: 'bin', bins: { node: binName } }), check: nodeCheck })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      // The cause first: a terminal cuts the Tools line, the log keeps both hashes.
      expect(r.error.startsWith('node 26.13.0: sha256 mismatch')).toBe(true)
      expect(r.error).toContain(want)
      expect(r.error).toContain(sha(bytes))
    }
    expect(existsSync(paths.systemToolsDir()) ? readdirSync(paths.systemToolsDir()) : []).toEqual([])
  }))

  test('a program that fails its check is not kept', () => withSandbox(async ({ root }) => {
    const bytes = program(join(root, 'scripts'), 'Error: GLIBC_2.28 not found', 1)
    const url = 'https://example.test/node'
    const r = await installPinnedTool('node', { fetch: fakeFetch({ [url]: bytes }).fetch, pins: pins({ url, sha256: sha(bytes), format: 'bin', bins: { node: binName } }), check: nodeCheck })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('node --version')
    expect(existsSync(join(paths.systemToolsDir(), 'node'))).toBe(false)
  }))

  test('HTTP 404, a timeout and an oversized answer fail with their reason', () => withSandbox(async () => {
    const asset: PinnedAsset = { url: 'https://example.test/none', sha256: 'b'.repeat(64), format: 'bin', bins: { node: binName } }
    const notFound = await installPinnedTool('node', { fetch: fakeFetch({}).fetch, pins: pins(asset), check: nodeCheck })
    expect(notFound.ok ? '' : notFound.error).toContain('HTTP 404')
    const slow = await installPinnedTool('node', { fetch: async () => { throw new DOMException('The operation timed out.', 'TimeoutError') }, pins: pins(asset), check: nodeCheck })
    expect(slow.ok ? '' : slow.error).toContain('timed out')
    const big = await installPinnedTool('node', { fetch: async () => new Response('x', { headers: { 'content-length': String(500 * 1024 * 1024) } }), pins: pins(asset), check: nodeCheck, maxBytes: 200 * 1024 * 1024 })
    expect(big.ok ? '' : big.error).toContain('bytes')
  }))

  test('an answer without content-length stops being read once it passes the size limit', () => withSandbox(async () => {
    const asset: PinnedAsset = { url: 'https://example.test/endless', sha256: 'b'.repeat(64), format: 'bin', bins: { node: binName } }
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(64 * 1024)) } })
    const r = await installPinnedTool('node', { fetch: async () => new Response(endless), pins: pins(asset), check: nodeCheck, maxBytes: 1024 * 1024 })
    expect(r.ok ? '' : r.error).toContain('more than the 1048576 bytes')
    // 1 MiB in 64 KiB chunks is 16 reads; a few more may be queued, never the endless rest.
    expect(pulled).toBeLessThan(40)
  }))

  test('a platform without a pin downloads nothing', () => withSandbox(async () => {
    const f = fakeFetch({})
    const r = await installPinnedTool('node', { fetch: f.fetch, os: 'win32', arch: 'arm64', check: nodeCheck })
    expect(r.ok ? '' : r.error).toBe('no download for win32-arm64')
    expect(f.calls).toEqual([])
  }))

  test('a Windows zip is unpacked with the system tar', () => withSandbox(async () => {
    const bytes = enc('PK fake zip')
    const url = 'https://example.test/node.zip'
    const ran: string[][] = []
    const run = async (argv: string[]) => {
      ran.push(argv)
      if (argv[1] === '-tf') return { code: 0, stdout: 'node-v26.13.0-win-x64/\nnode-v26.13.0-win-x64/node.exe\n', stderr: '' }
      if (argv[1] === '-xf') {
        const dest = argv[argv.indexOf('-C') + 1] as string
        mkdirSync(join(dest, 'node-v26.13.0-win-x64'), { recursive: true })
        writeFileSync(join(dest, 'node-v26.13.0-win-x64', 'node.exe'), 'MZ')
        return { code: 0, stdout: '', stderr: '' }
      }
      return { code: 0, stdout: 'v26.13.0\n', stderr: '' }
    }
    const r = await installPinnedTool('node', { fetch: fakeFetch({ [url]: bytes }).fetch, pins: pins({ url, sha256: sha(bytes), format: 'zip', bins: { node: 'node.exe' } }), check: nodeCheck, run })
    expect(r).toMatchObject({ ok: true })
    expect(ran.filter(a => a[0]?.endsWith('tar') || a[0]?.endsWith('tar.exe')).map(a => a[1])).toEqual(['-tf', '-xf'])
    expect(existsSync(join(paths.systemToolsDir(), 'node', 'node.exe'))).toBe(true)
  }))
})

describe.skipIf(IS_WINDOWS)('unpacking a tarball', () => {
  test('the single top folder is stripped and the program keeps its exec bit', () => withSandbox(async ({ root }) => {
    const launcher = new TextDecoder().decode(program(join(root, 'scripts'), 'v26.13.0'))
    const tar = new Bun.Archive({ 'node-v26.13.0-darwin-arm64/bin/node': launcher, 'node-v26.13.0-darwin-arm64/README.md': 'hi' }, { compress: 'gzip' })
    const bytes = new Uint8Array(await (await tar.blob()).arrayBuffer())
    const url = 'https://example.test/node.tar.gz'
    const r = await installPinnedTool('node', { fetch: fakeFetch({ [url]: bytes }).fetch, pins: pins({ url, sha256: sha(bytes), format: 'tar.gz', bins: { node: 'bin/node' } }), check: nodeCheck })
    expect(r).toMatchObject({ ok: true, check: '26.13.0' })
    expect(statSync(join(paths.systemToolsDir(), 'node', 'bin', 'node')).mode & 0o111).not.toBe(0)
    expect(existsSync(join(paths.systemToolsDir(), 'node', 'README.md'))).toBe(true)
  }))

  test('an entry that climbs out of the folder is refused', () => withSandbox(async () => {
    const tar = new Bun.Archive({ 'top/../../evil': 'x', 'top/bin/node': '#!/bin/sh\necho v1.0.0\n' }, { compress: 'gzip' })
    const bytes = new Uint8Array(await (await tar.blob()).arrayBuffer())
    const url = 'https://example.test/node.tar.gz'
    const r = await installPinnedTool('node', { fetch: fakeFetch({ [url]: bytes }).fetch, pins: pins({ url, sha256: sha(bytes), format: 'tar.gz', bins: { node: 'bin/node' } }), check: nodeCheck })
    expect(r.ok ? '' : r.error).toContain('outside')
    expect(existsSync(join(paths.toolchainDir(), '..', 'evil'))).toBe(false)
  }))
})

// The network a broken gate would reach: every fetch is recorded and answered 404, so a test never leaves the machine.
async function withNoNetwork<T>(fn: (calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = []
  const saved = globalThis.fetch
  globalThis.fetch = Object.assign(async (input: string | URL | Request) => {
    calls.push(String(input instanceof Request ? input.url : input))
    return new Response('blocked in tests', { status: 404 })
  }, { preconnect: saved.preconnect }) as typeof fetch
  try { return await fn(calls) } finally { globalThis.fetch = saved }
}

describe('toolchain.system: false keeps the pinned download from running', () => {
  const jq: ToolSpec = { name: 'jq', check: ['buracle-test-no-such-jq', '--version'], version_regex: 'jq-(\\d+\\.\\d+(?:\\.\\d+)?)', required: true }

  test('installTool with download: false fetches nothing and installs nothing', () => withSandbox(() => withNoNetwork(async calls => {
    const r = await installTool(jq, Date.parse('2026-11-01T00:00:00Z'), { download: false, have: () => false })
    expect(r.ok).toBe(false)
    expect(calls).toEqual([])
    expect(existsSync(paths.systemToolsDir())).toBe(false)
  })))

  test('runToolchain with system: false leaves a missing jq missing, with no download', () => withSandbox(() => withNoNetwork(async calls => {
    const bundle = { mcp: { servers: {} }, tools: { tools: [jq] } } as unknown as Pick<CanonicalBundle, 'mcp' | 'tools'>
    const r = await runToolchain(bundle, { install: true, upgrade: false, system: false, checkLatest: false, nowMs: () => Date.parse('2026-11-01T00:00:00Z') })
    const item = r.items.find(i => i.label === 'jq')
    expect(item?.status).toBe('missing')
    expect(calls.filter(u => !u.includes('cortexdb'))).toEqual([])
    expect(existsSync(paths.systemToolsDir())).toBe(false)
    expect(readToolchainState().system['jq']).toBeUndefined()
  })))
})

describe('the toolchain records a downloaded tool', () => {
  test('installTool with the download source records via: download and the program path', () => withSandbox(async ({ root }) => {
    const bytes = program(join(root, 'scripts'), 'v26.13.0')
    const url = 'https://example.test/node'
    const node: ToolSpec = { name: 'node', check: ['node', '--version'], version_regex: 'v(\\d+\\.\\d+\\.\\d+)', required: true }
    const r = await installTool(node, Date.parse('2026-11-01T00:00:00Z'), { download: { fetch: fakeFetch({ [url]: bytes }).fetch, pins: pins({ url, sha256: sha(bytes), format: 'bin', bins: { node: binName } }) }, have: () => false })
    expect(r).toMatchObject({ ok: true, source: { kind: 'download' }, record: { via: 'download', version: '26.13.0', path: join(paths.systemToolsDir(), 'node', binName) } })
    expect(readToolchainState().system).toEqual({})
  }))
})
