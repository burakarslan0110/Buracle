import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { CORTEXDB_ASSETS, cortexdbBinary, cortexdbBinPath, cortexdbPlatform, cortexdbStagingLeft, checkCortexdb, installCortexdb } from '../../src/engine/toolchain/cortexdb'
import { withEnv, withSandbox } from '../helpers/sandbox'

describe('cortexdb toolchain', () => {
  test('every supported platform has an asset and a 64-hex sha256', () => {
    for (const [plat, a] of Object.entries(CORTEXDB_ASSETS)) {
      expect(plat).toMatch(/^(darwin|linux|win32)-(arm64|x64)$/)
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(a.asset.startsWith('cortexdb-mcp-')).toBe(true)
    }
  })

  test('a download with the wrong bytes is refused and nothing is installed', async () => {
    await withSandbox(async () => {
      await withEnv({ BURACLE_CORTEXDB_BIN: undefined }, async () => {
        if (cortexdbPlatform() === undefined) return
        const r = await installCortexdb({ fetch: async () => new Response(new Uint8Array([1, 2, 3])) })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error).toContain('does not match the pinned')
        expect(existsSync(cortexdbBinPath())).toBe(false)
        expect(cortexdbStagingLeft()).toBe(false)
        expect(checkCortexdb().status).toBe('missing')
      })
    })
  })

  test('an HTTP error is reported with its status', async () => {
    await withSandbox(async () => {
      await withEnv({ BURACLE_CORTEXDB_BIN: undefined }, async () => {
        if (cortexdbPlatform() === undefined) return
        const r = await installCortexdb({ fetch: async () => new Response('nope', { status: 404 }) })
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.error).toContain('HTTP 404')
      })
    })
  })

  test('a toolchain copy that does not verify is damaged', async () => {
    await withSandbox(async () => {
      await withEnv({ BURACLE_CORTEXDB_BIN: undefined }, async () => {
        if (cortexdbPlatform() === undefined) return
        const { mkdirSync } = await import('node:fs')
        mkdirSync(join(cortexdbBinPath(), '..'), { recursive: true })
        writeFileSync(cortexdbBinPath(), 'not the binary')
        expect(checkCortexdb().status).toBe('damaged')
      })
    })
  })

  test('BURACLE_CORTEXDB_BIN names the executable', async () => {
    await withSandbox(async (sb) => {
      const p = join(sb.root, 'cdb')
      writeFileSync(p, '#!/bin/sh\n', { mode: 0o755 })
      await withEnv({ BURACLE_CORTEXDB_BIN: p }, async () => {
        expect(cortexdbBinary()).toEqual({ path: p, version: 'custom', source: 'env' })
        expect(checkCortexdb().status).toBe('ok')
      })
    })
  })
})
