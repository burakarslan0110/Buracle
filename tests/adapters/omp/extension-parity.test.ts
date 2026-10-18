import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createBuracleExtension, type ExtensionDeps } from '../../../src/adapters/omp/runtime/extension'
import type { OmpToolCallResult } from '../../../src/adapters/omp/runtime/types'
import { defaultConfig, type BuracleConfig } from '../../../src/core/config'
import { handoffNote } from '../../../src/core/compact'
import * as paths from '../../../src/engine/paths'
import { withSandbox, type Sandbox } from '../../helpers/sandbox'
import { fakeCtx, fakePi, testDeps, testGenerated } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4b'
const AWS_KEY = 'AKIA' + 'IOSFODNN7EXAMPLE'

function liveConfig(over: (c: BuracleConfig) => BuracleConfig = c => c): ExtensionDeps['config'] {
  return () => ({ config: over(defaultConfig()), vault: '/nonexistent-vault', shim: '/nonexistent/buracle', source: 'defaults' })
}

function setup(sb: Sandbox, overrides: Partial<ExtensionDeps> = {}, ctxOpts: Partial<Parameters<typeof fakeCtx>[0]> = {}) {
  const cwd = join(sb.root, 'work')
  mkdirSync(cwd, { recursive: true })
  const t = testDeps({ config: liveConfig(), ...overrides })
  const fp = fakePi()
  createBuracleExtension(testGenerated(), t.deps)(fp.pi)
  const ctx = fakeCtx({ cwd, sid: SID, ...ctxOpts })
  return { ...t, fp, ctx, cwd }
}

const result = (toolName: string, input: Record<string, unknown>, text: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'tool_result', toolCallId: `c-${toolName}`, toolName, input, content: [{ type: 'text', text }], isError: false, ...extra })

describe('omp extension: tool output masking (guards.redact, Claude mod parity)', () => {
  test('shell, read, search and MCP output reaches the model with its secrets masked; the user gets a notice', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    for (const [tool, input] of [['bash', { command: 'cat .env' }], ['read', { path: '.env' }], ['grep', { pattern: 'KEY' }], ['mcp__context7_query_docs', { q: 'x' }], ['eval', { code: 'print(1)' }]] as const) {
      const r = await fp.emit('tool_result', result(tool, input, `aws key: ${AWS_KEY}\nother line`), ctx) as { content?: Array<{ type: string, text?: string }> } | undefined
      const text = r?.content?.map(b => b.text ?? '').join('\n') ?? ''
      expect({ tool, leaked: text.includes(AWS_KEY), kept: text.includes('other line') }).toEqual({ tool, leaked: false, kept: true })
    }
    const notices = ctx.uiCalls.filter(c => c.method === 'notify').map(c => String(c.args[0]))
    expect(notices.filter(n => /secret value hidden from the model/.test(n)).length).toBe(5)
  }))

  test('non-text blocks stay as they are; an error result is masked too', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb)
    const image = { type: 'image', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB', mimeType: 'image/png' }
    const r = await fp.emit('tool_result', { ...result('bash', { command: 'x' }, `token ${AWS_KEY}`), isError: true, content: [{ type: 'text', text: `token ${AWS_KEY}` }, image] }, ctx) as { content?: unknown[] }
    expect(r.content?.[1]).toEqual(image)
    expect(JSON.stringify(r.content)).not.toContain(AWS_KEY)
  }))

  test('guards.redact: false, edits and output without secrets are left alone', () => withSandbox(async sb => {
    const off = setup(sb, { config: liveConfig(c => ({ ...c, guards: { ...c.guards, redact: false } })) })
    expect(await off.fp.emit('tool_result', result('bash', { command: 'cat .env' }, `aws key: ${AWS_KEY}`), off.ctx)).toBeUndefined()
    const on = setup(sb)
    expect(await on.fp.emit('tool_result', result('bash', { command: 'ls' }, 'a.txt\nb.txt and nothing secret here'), on.ctx)).toBeUndefined()
    expect(await on.fp.emit('tool_result', result('fetch', { url: 'https://example.com' }, `aws key: ${AWS_KEY}`), on.ctx)).toBeUndefined()
  }))
})

describe('omp extension: open todos in the H06 handoff note (Claude parity)', () => {
  test('the todo tool\'s remaining items go into the handoff note, also without a plan', () => withSandbox(async sb => {
    const seen: Array<string[] | undefined> = []
    const { fp, ctx, memory } = setup(sb, {
      compact: {
        compactInstructions: () => 'Keep the open todo items.',
        handoffNote: input => { seen.push(input.todo); return handoffNote(input) },
        restoreContext: () => undefined,
      },
    })
    const todoText = 'Remaining items (2):\n  - Write the parser test [in_progress] (Build)\n  - Update the docs [pending] (Build)'
    await fp.emit('tool_result', result('todo', { ops: [] }, todoText), ctx)
    const r = await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID }, ctx) as { preserveData?: Record<string, unknown> } | undefined
    expect(seen).toEqual([['Write the parser test', 'Update the docs']])
    expect(memory.handoffs.length).toBe(1)
    expect(memory.handoffs[0]?.markdown).toContain('- [ ] Write the parser test')
    expect((r?.preserveData?.['buracle'] as Record<string, unknown> | undefined)?.['handoff']).toBe(`handoff-${memory.handoffs[0]?.slug}`)
    await fp.emit('tool_result', result('todo', { ops: [] }, 'Remaining items: none.'), ctx)
    expect(await fp.emit('session.compacting', { type: 'session.compacting', sessionId: SID }, ctx)).toBeUndefined()
    expect(memory.handoffs.length).toBe(2)
    expect(memory.handoffs[1]?.markdown).toContain('None recorded.')
    expect(memory.compactions).toEqual([SID, SID])
  }))
})

describe('omp extension: H20 consent question in the TUI (Claude mod parity)', () => {
  const quietPolicy = (over: Partial<ExtensionDeps['policy']> = {}): ExtensionDeps['policy'] => ({
    checkBash: () => ({}), checkWrite: () => ({}), routeTool: () => ({ action: 'allow' }), capabilityCard: () => '',
    checkQuestion: () => ({}), detectIntent: () => null, isGuardContinuation: () => false, ...over,
  })
  const push = (id: string) => ({ type: 'tool_call', toolCallId: id, toolName: 'bash', input: { command: 'git push origin main' } })
  const consentFile = () => join(paths.sessionDir('omp', SID), 'consent.json')

  test('"Allow once" lets this call run and records nothing that outlives it', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { policy: quietPolicy() })
    const asked: Array<{ title: string, options: string[] }> = []
    ctx.ui.select = async (title: string, options: string[]) => { asked.push({ title, options }); return 'Allow once' }
    expect(await fp.emit('tool_call', push('1'), ctx)).toBeUndefined()
    expect(asked.length).toBe(1)
    expect(asked[0]?.title).toContain('git push origin main')
    expect(asked[0]?.options).toEqual(['Allow once', 'Allow for this session', 'Refuse'])
    expect(await fp.emit('tool_call', push('2'), ctx)).toBeUndefined()
    expect(asked.length).toBe(2)
  }))

  test('"Allow for this session" asks once; "Refuse" denies with the refusal', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { policy: quietPolicy() })
    let answer = 'Allow for this session'
    let asked = 0
    ctx.ui.select = async () => { asked++; return answer }
    expect(await fp.emit('tool_call', push('1'), ctx)).toBeUndefined()
    expect(await fp.emit('tool_call', push('2'), ctx)).toBeUndefined()
    expect(asked).toBe(1)
    const grants = JSON.parse(readFileSync(consentFile(), 'utf8')) as { grants: Array<{ kind: string, source: string }> }
    expect(grants.grants.map(g => [g.kind, g.source])).toEqual([['push', 'ask']])

    const other = setup(sb, { policy: quietPolicy() }, { sid: '01a118a8-8d01-740c-9360-f4f796699f4c' })
    answer = 'Refuse'
    other.ctx.ui.select = async () => answer
    const r = await other.fp.emit('tool_call', push('3'), other.ctx) as OmpToolCallResult
    expect(r.block).toBe(true)
    expect(r.reason).toMatch(/^Buracle H20: the user refused `git push origin main` in the consent dialog/)
  }))

  test('without a dialog (print and RPC mode, a subagent, no select) the deny with the question stays', () => withSandbox(async sb => {
    for (const ctxOpts of [{ mode: 'print' as const }, { mode: 'rpc' as const }, { kind: 'sub' as const, name: 'worker' }]) {
      const { fp, ctx } = setup(sb, { policy: quietPolicy() }, ctxOpts)
      let asked = 0
      ctx.ui.select = async () => { asked++; return 'Allow once' }
      const r = await fp.emit('tool_call', push('1'), ctx) as OmpToolCallResult
      expect({ ctxOpts, block: r.block, asked }).toEqual({ ctxOpts, block: true, asked: 0 })
      expect(r.reason).toMatch(/^Buracle H20: this command/)
    }
    const { fp, ctx } = setup(sb, { policy: quietPolicy() })
    ctx.ui.select = async () => { throw new Error('dialog closed') }
    const r = await fp.emit('tool_call', push('9'), ctx) as OmpToolCallResult
    expect(r.block).toBe(true)
    expect(r.reason).toMatch(/^Buracle H20: this command/)
    expect(existsSync(consentFile())).toBe(true)
  }))

  test('only confirm(): yes allows once', () => withSandbox(async sb => {
    const { fp, ctx } = setup(sb, { policy: quietPolicy() })
    ctx.ui.confirm = async () => true
    expect(await fp.emit('tool_call', push('1'), ctx)).toBeUndefined()
    ctx.ui.confirm = async () => false
    const r = await fp.emit('tool_call', push('2'), ctx) as OmpToolCallResult
    expect(r.reason).toMatch(/refused/)
  }))
})
