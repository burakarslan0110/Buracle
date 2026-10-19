import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { sha256 } from '../../src/engine/fsx'
import { CORTEXDB_ASSETS, cortexdbBinary, cortexdbBinPath, cortexdbDir, cortexdbPlatform, cortexdbStagingLeft, checkCortexdb, installCortexdb, installedCortexdbVersions, latestCortexdb } from '../../src/engine/toolchain/cortexdb'
import { withEnv, withSandbox } from '../helpers/sandbox'

const RELEASES = 'https://github.com/liliang-cn/cortexdb/releases'

// A GitHub release server: `latest` redirects to the newest tag, which serves the binary and its .sha256.
function releases(newest: string, bins: Record<string, Uint8Array>, opts: { publishedSha?: string } = {}) {
  const asset = CORTEXDB_ASSETS[cortexdbPlatform() as string] as string
  const downloads: string[] = []
  const fetch = async (url: string): Promise<Response> => {
    if (url === `${RELEASES}/latest/download/${asset}.sha256`) return new Response(null, { status: 302, headers: { location: `${RELEASES}/download/v${newest}/${asset}.sha256` } })
    const m = new RegExp(`/download/v([\\d.]+)/${asset.replace(/\./g, '\\.')}(\\.sha256)?$`).exec(url)
    const bytes = m?.[1] !== undefined ? bins[m[1]] : undefined
    if (m === null || bytes === undefined) return new Response('nope', { status: 404 })
    if (m[2] !== undefined) return new Response(`${opts.publishedSha ?? sha256(bytes)}  ${asset}\n`)
    downloads.push(m[1] as string)
    return new Response(bytes)
  }
  return { fetch, downloads }
}

const bin = (text: string) => new TextEncoder().encode(text)
const offline = async (): Promise<Response> => { throw new Error('getaddrinfo ENOTFOUND github.com') }
const supported = cortexdbPlatform() !== undefined

describe('cortexdb toolchain: the newest release', () => {
  test('every supported platform has a cortexdb-mcp asset', () => {
    for (const [plat, asset] of Object.entries(CORTEXDB_ASSETS)) {
      expect(plat).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/)
      expect(asset.startsWith('cortexdb-mcp-')).toBe(true)
    }
  })

  test.if(supported)('the newest version comes from where releases/latest redirects, with the sha256 that release published', async () => {
    const r = releases('2.134.0', { '2.134.0': bin('v2134') })
    expect(await latestCortexdb({ fetch: r.fetch })).toEqual({ version: '2.134.0', sha256: sha256(bin('v2134')) })
  })

  test.if(supported)('a fresh install takes the newest release, checks it against its published sha256 and records the hash; a second run downloads nothing', () => withSandbox(() => withEnv({ BURACLE_CORTEXDB_BIN: undefined }, async () => {
    const r = releases('2.134.0', { '2.134.0': bin('v2134') })
    const got = await installCortexdb({ fetch: r.fetch })
    expect(got).toEqual({ ok: true, path: cortexdbBinPath('2.134.0'), version: '2.134.0', changed: true })
    expect(checkCortexdb()).toMatchObject({ status: 'ok', version: '2.134.0', source: 'toolchain' })
    expect(await installCortexdb({ fetch: r.fetch })).toMatchObject({ ok: true, version: '2.134.0', changed: false })
    expect(r.downloads).toEqual(['2.134.0'])
  })))

  test.if(supported)('a binary that does not match the published sha256 is refused, and nothing is installed', () => withSandbox(() => withEnv({ BURACLE_CORTEXDB_BIN: undefined }, async () => {
    const r = releases('2.134.0', { '2.134.0': bin('tampered') }, { publishedSha: sha256(bin('v2134')) })
    const got = await installCortexdb({ fetch: r.fetch })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.error).toContain('does not match')
    expect(installedCortexdbVersions()).toEqual([])
    expect(cortexdbStagingLeft()).toBe(false)
    expect(checkCortexdb().status).toBe('missing')
  })))

  test.if(supported)('an upgrade backs up first, keeps the version before it and prunes older ones', () => withSandbox(() => withEnv({ BURACLE_CORTEXDB_BIN: undefined }, async () => {
    const switches: string[] = []
    const beforeSwitch = async (from: string, to: string) => { switches.push(`${from}->${to}`) }
    await installCortexdb({ fetch: releases('2.124.0', { '2.124.0': bin('v2124') }).fetch, beforeSwitch })
    expect(switches).toEqual([])
    await installCortexdb({ fetch: releases('2.134.0', { '2.134.0': bin('v2134') }).fetch, beforeSwitch })
    expect(switches).toEqual(['2.124.0->2.134.0'])
    expect(installedCortexdbVersions()).toEqual(['2.134.0', '2.124.0'])
    expect(cortexdbBinary()?.version).toBe('2.134.0')
    await installCortexdb({ fetch: releases('2.135.0', { '2.135.0': bin('v2135') }).fetch, beforeSwitch })
    expect(installedCortexdbVersions()).toEqual(['2.135.0', '2.134.0'])
    expect(readdirSync(cortexdbDir()).sort()).toEqual(['2.134.0', '2.135.0'])
  })))

  test.if(supported)('a new version that fails Buracle\'s check is not used: the installed one stays, and the newer one is named', () => withSandbox(() => withEnv({ BURACLE_CORTEXDB_BIN: undefined }, async () => {
    await installCortexdb({ fetch: releases('2.124.0', { '2.124.0': bin('v2124') }).fetch })
    let switched = false
    const got = await installCortexdb({
      fetch: releases('2.134.0', { '2.134.0': bin('v2134') }).fetch,
      check: async () => ({ ok: false, error: 'memory_search is gone' }),
      beforeSwitch: async () => { switched = true },
    })
    expect(got).toMatchObject({ ok: true, version: '2.124.0', changed: false, newer: '2.134.0' })
    if (got.ok) expect(got.note).toContain('memory_search is gone')
    expect(switched).toBe(false)
    expect(installedCortexdbVersions()).toEqual(['2.124.0'])
    expect(existsSync(join(cortexdbDir(), '2.134.0'))).toBe(false)
  })))

  test.if(supported)('without a network the installed version goes on; with none installed the error says why', () => withSandbox(() => withEnv({ BURACLE_CORTEXDB_BIN: undefined }, async () => {
    const none = await installCortexdb({ fetch: offline })
    expect(none.ok).toBe(false)
    if (!none.ok) expect(none.error).toContain('ENOTFOUND')
    await installCortexdb({ fetch: releases('2.124.0', { '2.124.0': bin('v2124') }).fetch })
    expect(await installCortexdb({ fetch: offline })).toMatchObject({ ok: true, version: '2.124.0', changed: false })
  })))

  test.if(supported)('an HTTP error on the binary is reported with its status', () => withSandbox(() => withEnv({ BURACLE_CORTEXDB_BIN: undefined }, async () => {
    const r = releases('2.134.0', {})
    const got = await installCortexdb({ fetch: async (url: string) => (url.endsWith('.sha256') && url.includes('latest') ? r.fetch(url) : url.endsWith('.sha256') ? new Response(`${'a'.repeat(64)}\n`) : new Response('nope', { status: 404 })) })
    expect(got.ok).toBe(false)
    if (!got.ok) expect(got.error).toContain('HTTP 404')
  })))

  test.if(supported)('a toolchain copy that no longer matches its recorded sha256 is damaged', () => withSandbox(() => withEnv({ BURACLE_CORTEXDB_BIN: undefined }, async () => {
    await installCortexdb({ fetch: releases('2.124.0', { '2.124.0': bin('v2124') }).fetch })
    writeFileSync(cortexdbBinPath('2.124.0'), 'not the binary')
    expect(checkCortexdb().status).toBe('damaged')
  })))

  test('BURACLE_CORTEXDB_BIN names the executable', () => withSandbox(async (sb) => {
    const p = join(sb.root, 'cdb')
    mkdirSync(sb.root, { recursive: true })
    writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 })
    await withEnv({ BURACLE_CORTEXDB_BIN: p }, async () => {
      expect(cortexdbBinary()).toEqual({ path: p, version: 'custom', source: 'env' })
      expect(checkCortexdb().status).toBe('ok')
    })
  }))
})
