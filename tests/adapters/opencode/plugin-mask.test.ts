import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BuracleRuntime, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import type { ToolExecuteAfter } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import type { BuracleConfig } from '../../../src/core/config'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import * as paths from '../../../src/engine/paths'
import { withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'

const SID = 'ses_mask01'
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

function noProject(cwd: string): WorkspaceInfo {
  return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } }
}

function writeRuntimeConfig(patch: (c: BuracleConfig) => BuracleConfig): void {
  const file = paths.runtimeConfigFile()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ v: 1, config: patch(structuredClone(testBaked().defaults)), resolved: {} }))
}

async function runtime(dir: string) {
  const f = fakeServerContext(dir)
  const deps: PluginDeps = {
    baked: testBaked(), memory: fakeMemory(), settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: () => true, maint: () => ({ removed: [] }), notify: () => undefined,
    workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd),
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  return { f, rt }
}

function after(tool: string, input: Record<string, unknown>, result: { output?: unknown, content?: unknown }): ToolExecuteAfter {
  return { tool, sessionID: SID, agent: 'build', messageID: 'msg_1', id: `call_${tool}`, input, status: 'completed', result } as ToolExecuteAfter
}

const json = (x: unknown): string => JSON.stringify(x)

describe('opencode server plugin: tool output masking (guards.redact)', () => {
  test('shell, read, grep, MCP and Code Mode results reach the model with their secrets masked', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const cases: Array<[string, Record<string, unknown>]> = [
      ['shell', { command: 'cat .env' }], ['read', { filePath: '.env' }], ['grep', { pattern: 'KEY' }],
      ['context7_query-docs', { query: 'x' }], ['execute', { code: 'x' }],
    ]
    for (const [tool, input] of cases) {
      const e = after(tool, input, { output: { output: `key=${AWS_KEY}\nok`, exit: 0 }, content: [{ type: 'text', text: `key=${AWS_KEY}\nok` }] })
      await f.trigger('tool.execute.after', e)
      const r = e.status === 'completed' ? e.result : undefined
      expect({ tool, leaked: json(r).includes(AWS_KEY), kept: json(r?.content).includes('ok') }).toEqual({ tool, leaked: false, kept: true })
    }
    const s = after('shell', { command: 'env' }, { content: `TOKEN ${AWS_KEY}` })
    await f.trigger('tool.execute.after', s)
    expect(json(s.status === 'completed' ? s.result : undefined)).not.toContain(AWS_KEY)
    const o = after('read', { filePath: 'a' }, { output: { text: `x ${AWS_KEY}` } })
    await f.trigger('tool.execute.after', o)
    expect(json(o.status === 'completed' ? o.result : undefined)).not.toContain(AWS_KEY)
  }))

  test('edits, web fetches, guards.redact: false and clean output are left alone', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const write = after('write', { filePath: join(root, 'a.txt'), content: AWS_KEY }, { output: {}, content: [{ type: 'text', text: `Wrote ${AWS_KEY}` }] })
    await f.trigger('tool.execute.after', write)
    expect(json(write.status === 'completed' ? write.result.content : undefined)).toContain(AWS_KEY)
    const fetch = after('webfetch', { url: 'https://example.com' }, { content: [{ type: 'text', text: AWS_KEY }] })
    await f.trigger('tool.execute.after', fetch)
    expect(json(fetch.status === 'completed' ? fetch.result.content : undefined)).toContain(AWS_KEY)
    const clean = after('shell', { command: 'ls' }, { output: { output: 'a b', exit: 0 }, content: [{ type: 'text', text: 'a b' }] })
    const before = json(clean)
    await f.trigger('tool.execute.after', clean)
    expect(json(clean)).toBe(before)

    writeRuntimeConfig(c => ({ ...c, guards: { ...c.guards, redact: false } }))
    const off = await runtime(root)
    const e = after('shell', { command: 'cat .env' }, { content: [{ type: 'text', text: AWS_KEY }] })
    await off.f.trigger('tool.execute.after', e)
    expect(json(e.status === 'completed' ? e.result.content : undefined)).toContain(AWS_KEY)
  }))

  test('a file part (an image) stays as it is', () => withSandbox(async ({ root }) => {
    const { f } = await runtime(root)
    const file = { type: 'file', mime: 'image/png', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' }
    const e = after('read', { filePath: 'a.png' }, { content: [{ type: 'text', text: `key ${AWS_KEY}` }, file] })
    await f.trigger('tool.execute.after', e)
    const content = (e.status === 'completed' ? e.result.content : undefined) as unknown[]
    expect(content[1]).toEqual(file)
    expect(json(content)).not.toContain(AWS_KEY)
  }))
})
