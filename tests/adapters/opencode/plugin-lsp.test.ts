import { beforeEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolSpec } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import { lspEditNotes } from '../../../src/adapters/opencode/runtime/checks'
import { BuracleRuntime, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import type { ToolExecuteAfter } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import { lspServers } from '../../../src/engine/toolchain/lsp'
import { serveEditRequests } from '../../../src/engine/toolchain/lsp-edits'
import { createLspBridge } from '../../../src/engine/toolchain/lsp-mcp'
import { withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'

const SID = 'ses_test01'
const STUB = join(import.meta.dir, '..', '..', 'fixtures', 'lsp', 'stub-lsp.ts')

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

function noProject(cwd: string): WorkspaceInfo {
  return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } }
}

async function runtime(dir: string, over: Partial<PluginDeps> = {}) {
  const f = fakeServerContext(dir)
  const deps: PluginDeps = {
    baked: testBaked(), memory: fakeMemory(), settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: () => true, maint: () => ({ removed: [] }), notify: () => undefined,
    workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd), ...over,
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  return f
}

async function write(f: Awaited<ReturnType<typeof runtime>>, id: string, path: string, content: string): Promise<string> {
  await f.trigger('tool.execute.before', { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input: { path, content } })
  const after: ToolExecuteAfter = { tool: 'write', sessionID: SID, agent: 'build', messageID: 'msg_1', id, input: { path, content }, status: 'completed', result: { output: {}, content: [{ type: 'text', text: 'Wrote' }] } }
  await f.trigger('tool.execute.after', after)
  return after.status === 'completed' ? (after.result.content as unknown as Array<{ text: string }>).map(c => c.text).join('\n') : ''
}

describe('opencode server plugin: language-server diagnostics after an edit (H04)', () => {
  test('an edit asks the running bridge about the edited file and the tool result carries what it reports', () => withSandbox(async ({ root }) => {
    const asked: Array<{ files: readonly string[], cwd: string }> = []
    const f = await runtime(root, { lspEdits: async (files, o) => { asked.push({ files, cwd: o.cwd }); return ['main.go (gopls): 1 error\n  2:5  error UndeclaredName  undefined: Foo [compiler]'] } })
    writeFileSync(join(root, 'main.go'), 'package main\n')
    const text = await write(f, 'call_1', 'main.go', 'package main\n')
    expect(text).toContain('Buracle language server diagnostics (H04):\n\nmain.go (gopls): 1 error\n  2:5  error UndeclaredName  undefined: Foo [compiler]')
    expect(asked).toEqual([{ files: [join(root, 'main.go')], cwd: root }])
  }))

  test('the switch and a failing bridge: checkers.enabled false asks nothing, an error adds nothing', async () => {
    const logged: string[] = []
    const off = { ...defaultConfig().checkers, enabled: false }
    let calls = 0
    const ask = async () => { calls += 1; return ['x'] }
    expect(await lspEditNotes(['/w/a.go'], off, { cwd: '/w', ask, log: () => undefined })).toEqual([])
    expect(calls).toBe(0)
    expect(await lspEditNotes([], defaultConfig().checkers, { cwd: '/w', ask, log: () => undefined })).toEqual([])
    expect(await lspEditNotes(['/w/a.go'], defaultConfig().checkers, { cwd: '/w', ask: async () => { throw new Error('boom') }, log: (_l, msg) => { logged.push(msg) } })).toEqual([])
    expect(logged).toEqual(['H04 language server failed'])
  })

  test('end to end: a bridge serving its language server answers the plugin through the edit channel', () => withSandbox(async ({ root }) => {
    writeFileSync(join(root, 'go.mod'), 'module demo\n')
    writeFileSync(join(root, 'main.go'), 'package main\n')
    const tool: ToolSpec = { name: 'gopls', check: ['gopls'], version_regex: '(x)', required: false, lsp: { id: 'gopls', extensions: { '.go': 'go' }, root_markers: ['go.mod'] } }
    const bridge = createLspBridge({ cwd: root, servers: lspServers({ tools: [tool] }), launch: () => ({ argv: [process.execPath, STUB, 'push'], source: 'path' }) })
    const served = await serveEditRequests((file, w) => bridge.afterEdit(file, w), { cwd: root })
    try {
      await bridge.callTool('symbols', { file: 'main.go' })
      const f = await runtime(root)
      const body = 'package main\nvar x = 1 // ERROR: declared and not used: x\n'
      writeFileSync(join(root, 'main.go'), body)
      expect(await write(f, 'call_1', 'main.go', body)).toContain('Buracle language server diagnostics (H04):\n\nmain.go (gopls): 1 error\n  2:14  error E1  declared and not used: x [stub]')
    } finally {
      served?.close()
      await bridge.close()
    }
  }), 30_000)
})
