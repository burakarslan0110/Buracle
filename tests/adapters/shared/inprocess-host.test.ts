import { describe, expect, test } from 'bun:test'
import { defaultConfig } from '../../../src/core/config'
import { createMemoryBridge } from '../../../src/adapters/shared/pi-family/memory'
import { contextBlock, createInProcessHost, hostDeps, type BaseMemo } from '../../../src/adapters/shared/pi-family/inprocess-host'
import { withSandbox } from '../../helpers/sandbox'

function make(id: 'pi' | 'omp') {
  const deps = { ...hostDeps(id), memory: createMemoryBridge({ harness: id, cli: () => undefined }) }
  const data = { buracleVersion: '0.0.0', config: defaultConfig(), routing: { strictness: 'enforce' as const, categories: [] }, mcp: [], mcpIds: [], skills: [] }
  return createInProcessHost<BaseMemo>({
    harness: id, data, deps, pi: { sendMessage: () => undefined }, noticeType: 'buracle.notice',
    configuredRepo: () => undefined, nativeOff: { label: 'off', read: () => [] },
  })
}

describe('in-process host', () => {
  test('a prompt waits in the queue and is delivered once, then repeated for the same prompt', async () => {
    await withSandbox(async () => {
      const host = make('pi')
      const m = host.memo('s1')
      host.enqueue(m, ['before', 'after'], undefined)
      expect(m.queued?.length).toBe(1)
      expect(host.deliver('s1', 'hello')).toBe('before\n\nafter')
      expect(m.queued).toBeUndefined()
      expect(host.deliver('s1', 'hello')).toBe('before\n\nafter')
      expect(host.deliver('s1', 'other')).toBeUndefined()
    })
  })

  test('the queue keeps the last 16 prompts', async () => {
    await withSandbox(async () => {
      const host = make('omp')
      const m = host.memo('s2')
      for (let i = 0; i < 20; i++) host.enqueue(m, [`n${i}`], undefined)
      expect(m.queued?.length).toBe(16)
      expect(m.queued?.[0]?.before).toEqual(['n4'])
    })
  })

  test('the session start waits only briefly and the memo is per session', async () => {
    await withSandbox(async () => {
      const host = make('pi')
      expect(host.memo('a')).not.toBe(host.memo('b'))
      await host.started(undefined)
      await host.started('a')
      expect(host.enter('a')).toBeUndefined()
      expect(host.enter('b')).toBe('a')
      expect(host.current()).toBe('b')
    })
  })

  test('the context block wraps its parts', () => {
    expect(contextBlock([])).toBe('')
    expect(contextBlock(['x'])).toBe('<buracle-context>\n\nx\n\n</buracle-context>')
  })
})
