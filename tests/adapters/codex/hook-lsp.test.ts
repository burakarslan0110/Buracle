import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ToolSpec } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'
import { defaultDeps, handleCodexHook } from '../../../src/adapters/codex/hook'
import { lspServers } from '../../../src/engine/toolchain/lsp'
import { serveEditRequests } from '../../../src/engine/toolchain/lsp-edits'
import { createLspBridge } from '../../../src/engine/toolchain/lsp-mcp'
import { withSandbox } from '../../helpers/sandbox'
import { ctx, deps, NOW, payload, quiet } from './hook-helpers'

const STUB = join(import.meta.dir, '..', '..', 'fixtures', 'lsp', 'stub-lsp.ts')
const PATCH = '*** Begin Patch\n*** Update File: main.go\n@@\n-package main\n+package main\n*** End Patch\n'

describe('Codex PostToolUse: language-server diagnostics after apply_patch (H04)', () => {
  test('the hook asks the running bridge about the patched files and adds what it reports; checkers.enabled: false turns it off', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'main.go'), 'package main\n')
    const asked: Array<{ files: readonly string[], cwd: string, deadlineMs: number }> = []
    const d = { ...deps({ ...quiet, checkersFor: () => [] }), lspEdits: async (files: readonly string[], o: { cwd: string, deadlineMs: number }) => { asked.push({ files, cwd: o.cwd, deadlineMs: o.deadlineMs }); return ['main.go (gopls): 1 error\n  2:5  error UndeclaredName  undefined: Foo [compiler]'] } }
    const post = async (config = defaultConfig()) => (await handleCodexHook('PostToolUse', payload('PostToolUse', { cwd, tool_name: 'apply_patch', tool_input: { command: PATCH }, tool_response: 'Success.' }), ctx(config), d)).stdout
    const text: string = JSON.parse(await post()).hookSpecificOutput.additionalContext
    expect(text).toContain('Buracle language server diagnostics after apply_patch:\n\nmain.go (gopls): 1 error\n  2:5  error UndeclaredName  undefined: Foo [compiler]')
    expect(asked).toEqual([{ files: [join(cwd, 'main.go')], cwd, deadlineMs: NOW + 40_000 }])
    const off = defaultConfig()
    expect(await post({ ...off, checkers: { ...off.checkers, enabled: false } })).toBe('')
    expect(asked.length).toBe(1)
  }))

  test('end to end: a bridge serving its language server answers the hook through the edit channel', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(cwd)
    writeFileSync(join(cwd, 'go.mod'), 'module demo\n')
    writeFileSync(join(cwd, 'main.go'), 'package main\nvar x = 1 // ERROR: declared and not used: x\n')
    const tool: ToolSpec = { name: 'gopls', check: ['gopls'], version_regex: '(x)', required: false, lsp: { id: 'gopls', extensions: { '.go': 'go' }, root_markers: ['go.mod'] } }
    const bridge = createLspBridge({ cwd, servers: lspServers({ tools: [tool] }), launch: () => ({ argv: [process.execPath, STUB, 'push'], source: 'path' }) })
    const served = await serveEditRequests((f, w) => bridge.afterEdit(f, w), { cwd })
    try {
      await bridge.callTool('symbols', { file: 'main.go' })
      const d = { ...deps({ ...quiet, checkersFor: () => [] }), now: () => Date.now(), lspEdits: defaultDeps().lspEdits }
      const r = await handleCodexHook('PostToolUse', payload('PostToolUse', { cwd, tool_name: 'apply_patch', tool_input: { command: PATCH }, tool_response: 'Success.' }), ctx(), d)
      expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain('Buracle language server diagnostics after apply_patch:\n\nmain.go (gopls): 1 error\n  2:14  error E1  declared and not used: x [stub]')
    } finally {
      served?.close()
      await bridge.close()
    }
  }), 30_000)
})
