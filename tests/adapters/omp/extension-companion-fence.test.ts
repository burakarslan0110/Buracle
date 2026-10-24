import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { reviewerFenceFromEnv } from '../../../src/adapters/omp/runtime/companion-fence'
import { createBuracleExtension, defaultDeps } from '../../../src/adapters/omp/runtime/extension'
import { checkBash } from '../../../src/core/policy/bash-guard'
import { checkWrite } from '../../../src/core/policy/write-guard'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeCtx, fakePi, testDeps, testGenerated } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4d'
type Verdict = { block?: boolean, reason?: string } | undefined

function setup(cwd: string, fence: string | undefined, active: string[] = []) {
  mkdirSync(cwd, { recursive: true })
  const policy = { ...testDeps().deps.policy!, checkBash, checkWrite, routeTool: () => ({ action: 'allow' as const }) }
  const t = testDeps({ policy, evalGuard: defaultDeps().evalGuard, consentGate: () => undefined, reviewerFence: () => fence })
  const fp = fakePi()
  const tools = { active: [...active], set: [] as string[][] }
  fp.pi.getActiveTools = () => [...tools.active]
  fp.pi.setActiveTools = names => { tools.set.push(names); tools.active = [...names] }
  createBuracleExtension(testGenerated(), t.deps)(fp.pi)
  const ctx = fakeCtx({ cwd, sid: SID, mode: 'print' })
  const call = async (toolName: string, input: Record<string, unknown>) => await fp.emit('tool_call', { type: 'tool_call', toolCallId: 'x', toolName, input }, ctx) as Verdict
  const start = () => fp.emit('before_agent_start', { type: 'before_agent_start', prompt: 'review', systemPrompt: [] }, ctx)
  return { call, start, tools }
}

const FENCE = /^Buracle H01: this run is a read-only second opinion \(plan-build-review\) and /

describe('omp: the second-opinion fence (BURACLE_REVIEWER_AGENT in the child)', () => {
  test('MCP tools of other servers, their xd:// devices, file writes and the shell are blocked; read tools and the three review servers pass', () => withSandbox(async ({ root }) => {
    const { call } = setup(join(root, 'work'), 'plan-build-review')
    for (const [tool, input] of [
      ['mcp__memtest_memory_write', {}],
      ['mcp__buracle_memory_memory_write', { title: 'x' }],
      ['write', { path: 'xd://mcp__memtest_memory_write', content: '{}' }],
      ['write', { path: join(root, 'work', 'pwned.txt'), content: 'x' }],
      ['bash', { command: 'git diff' }],
      ['edit', { path: 'a.ts', old_string: 'a', new_string: 'b' }],
    ] as const) {
      const r = await call(tool, input)
      expect({ tool, block: r?.block, reason: r?.reason }).toEqual({ tool, block: true, reason: expect.stringMatching(FENCE) })
    }
    for (const [tool, input] of [
      ['read', { path: join(root, 'work', 'a.ts') }],
      ['grep', { pattern: 'x', path: join(root, 'work') }],
      ['mcp__codegraph_codegraph_explore', { query: 'x' }],
      ['write', { path: 'xd://mcp__semble_search', content: '{}' }],
    ] as const) {
      const r = await call(tool, input)
      expect({ tool, fenced: FENCE.test(r?.reason ?? '') }).toEqual({ tool, fenced: false })
    }
  }))

  test('before the review starts, the tools the fence would block are taken out of the model\'s list (write stays for the allowed devices)', () => withSandbox(({ root }) => withEnv({ BURACLE_MEMORY_RUNNER: '1' }, async () => {
    const { start, tools } = setup(join(root, 'work'), 'plan-build-review', ['read', 'grep', 'glob', 'write', 'mcp__memtest_memory_write', 'mcp__codegraph_codegraph_explore'])
    await start()
    expect(tools.set).toEqual([['read', 'grep', 'glob', 'write', 'mcp__codegraph_codegraph_explore']])
  })))

  test('without the marker nothing is fenced or hidden, and the env reader accepts only review agent names', () => withSandbox(async ({ root }) => {
    const { call, start, tools } = setup(join(root, 'work'), undefined, ['read', 'mcp__memtest_memory_write'])
    expect(await call('mcp__memtest_memory_write', {})).toBeUndefined()
    await withEnv({ BURACLE_MEMORY_RUNNER: '1' }, async () => { await start() })
    expect(tools.set).toEqual([])
    await withEnv({ BURACLE_REVIEWER_AGENT: 'changes-review' }, async () => { expect(reviewerFenceFromEnv()).toBe('changes-review') })
    await withEnv({ BURACLE_REVIEWER_AGENT: 'build' }, async () => { expect(reviewerFenceFromEnv()).toBeUndefined() })
    await withEnv({ BURACLE_REVIEWER_AGENT: undefined }, async () => { expect(reviewerFenceFromEnv()).toBeUndefined() })
  }))
})
