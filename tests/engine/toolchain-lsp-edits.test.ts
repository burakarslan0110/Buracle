import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolSpec } from '../../src/core/catalog'
import { type LspServer, lspServers } from '../../src/engine/toolchain/lsp'
import { askBridge, editDiagnostics, type LspBridgeEntry, liveBridges, lspBridgeDir, pickBridge, serveEditRequests } from '../../src/engine/toolchain/lsp-edits'
import { createLspBridge } from '../../src/engine/toolchain/lsp-mcp'
import { withSandbox } from '../helpers/sandbox'

const STUB = join(import.meta.dir, '..', 'fixtures', 'lsp', 'stub-lsp.ts')

function stubServer(): LspServer {
  const tool: ToolSpec = { name: 'stub-ls', check: ['stub-ls'], version_regex: '(x)', required: false, lsp: { id: 'stub', extensions: { '.ts': 'typescript' }, root_markers: ['tsconfig.json'] } }
  return lspServers({ tools: [tool] })[0] as LspServer
}

const entry = (over: Partial<LspBridgeEntry>): LspBridgeEntry => ({ pid: 1, ppid: 1, cwd: '/w', port: 1, token: 't', startedAt: 1, ...over })

describe('lsp bridge: diagnostics after an edit for the harness hooks', () => {
  test('the bridge registers itself for edit reports with a token; a dead registration is dropped', () => withSandbox(async ({ root }) => {
    const served = await serveEditRequests(async (file, waitMs) => ({ state: 'report', text: `${file} after ${waitMs} ms` }), { cwd: root, now: () => 42 })
    expect(served).toBeDefined()
    try {
      const file = join(lspBridgeDir(), `${process.pid}.json`)
      if (process.platform !== 'win32') expect((statSync(file).mode & 0o777).toString(8)).toBe('600')
      const [live] = liveBridges()
      expect(live).toMatchObject({ pid: process.pid, ppid: process.ppid, cwd: root, startedAt: 42 })
      expect(await askBridge(live!, join(root, 'a.ts'), 1234, 5000)).toEqual({ state: 'report', text: `${join(root, 'a.ts')} after 1234 ms` })
      expect(await askBridge({ ...live!, token: 'wrong' }, join(root, 'a.ts'), 1000, 5000)).toBeUndefined()
      expect(await askBridge(live!, 'relative.ts', 1000, 5000)).toEqual({ state: 'none' })
      writeFileSync(join(lspBridgeDir(), '999999999.json'), JSON.stringify(entry({ pid: 999_999_999 })))
      writeFileSync(join(lspBridgeDir(), 'junk.json'), '{')
      expect(liveBridges().map(b => b.pid)).toEqual([process.pid])
      expect(existsSync(join(lspBridgeDir(), '999999999.json'))).toBe(false)
    } finally {
      served?.close()
    }
    expect(existsSync(join(lspBridgeDir(), `${process.pid}.json`))).toBe(false)
    expect(liveBridges()).toEqual([])
  }))

  test('a hook picks the bridge of its own harness process first, then one started in the same folder, then the newest that covers the file', () => {
    const bridges = [entry({ pid: 10, ppid: 100, cwd: '/w', startedAt: 1 }), entry({ pid: 11, ppid: 200, cwd: '/w', startedAt: 5 }), entry({ pid: 12, ppid: 300, cwd: '/', startedAt: 9 }), entry({ pid: 13, ppid: 400, cwd: '/other', startedAt: 9 })]
    expect(pickBridge(bridges, '/w/a.ts', { cwd: '/w', parents: [100] })?.pid).toBe(10)
    expect(pickBridge(bridges, '/w/a.ts', { cwd: '/w', parents: [] })?.pid).toBe(11)
    expect(pickBridge(bridges, '/w/a.ts', { cwd: '/elsewhere', parents: [] })?.pid).toBe(12)
    expect(pickBridge(bridges, '/x/a.ts', { cwd: '/x', parents: [] })?.pid).toBe(12)
    expect(pickBridge(bridges.slice(0, 2), '/x/a.ts', { cwd: '/x', parents: [] })).toBeUndefined()
  })

  test('through a real bridge: the first edit starts the server, later edits come back with the problems only, a clean file adds nothing', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj)
    writeFileSync(join(proj, 'tsconfig.json'), '{}')
    const file = join(proj, 'a.ts')
    writeFileSync(file, 'const a = 1\n')
    const bridge = createLspBridge({ cwd: proj, servers: [stubServer()], launch: () => ({ argv: [process.execPath, STUB, 'slow'], source: 'path' }) })
    const served = await serveEditRequests((f, w) => bridge.afterEdit(f, w), { cwd: proj })
    try {
      const ask = (deadline = Date.now() + 20_000) => editDiagnostics([file, join(proj, 'notes.md')], { cwd: proj, deadlineMs: deadline, waitMs: 3000 })
      const [live] = liveBridges()
      expect(await askBridge(live!, file, 1000, 10_000)).toEqual({ state: 'starting' })
      await Bun.sleep(2000)
      expect(await ask()).toEqual([])
      writeFileSync(file, 'const a = 1\nlet b = 2 // ERROR: Type string is not assignable\n')
      utimesSync(file, new Date(), new Date(Date.now() + 5000))
      expect(await ask()).toEqual(['a.ts (stub): 1 error\n  2:14  error E1  Type string is not assignable [stub]'])
      expect(await ask(Date.now() + 1000)).toEqual([])
      expect(await askBridge(live!, join(proj, 'notes.md'), 1000, 5000)).toEqual({ state: 'none' })
      expect(readFileSync(join(lspBridgeDir(), `${process.pid}.json`), 'utf8')).toContain(`"cwd":${JSON.stringify(proj)}`)
    } finally {
      served?.close()
      await bridge.close()
    }
  }), 30_000)
})
