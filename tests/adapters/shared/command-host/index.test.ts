import { describe, expect, test } from 'bun:test'
import { hookStep, NO_SESSION_ID, runFrame, workspaceReaders, type FrameSpec } from '../../../../src/adapters/shared/command-host/index'
import { QUIET, out } from '../../../../src/adapters/shared/claude-dialect'
import { withEnv } from '../../../helpers/sandbox'

function spec(calls: string[]): FrameSpec {
  return {
    harness: 'qwen', label: 'test', quiet: out({ quiet: true }), sessionIdOf: p => p['session_id'], cwdOf: p => (typeof p['cwd'] === 'string' ? p['cwd'] : '/cwd'),
    runnerSkips: ['SessionStart'],
    guards: async (_p, sid) => { calls.push(`guards:${sid}`); return out({ guards: true }) },
    event: async (ev, _p, sid, cwd) => { calls.push(`event:${ev}:${sid}:${cwd}`); return out({ ev }) },
  }
}

describe('runFrame', () => {
  test('a payload that is not a JSON object is answered quietly', async () => {
    const calls: string[] = []
    expect(await runFrame(spec(calls), 'Stop', '[1]')).toEqual(QUIET)
    expect(await runFrame(spec(calls), 'Stop', 'nope')).toEqual(QUIET)
    expect(calls).toEqual([])
  })

  test('a usable session id reaches the event with the payload cwd', async () => {
    const calls: string[] = []
    const r = await runFrame(spec(calls), 'Stop', JSON.stringify({ session_id: 'abc-123', cwd: '/w' }))
    expect(JSON.parse(r.stdout)).toEqual({ ev: 'Stop' })
    expect(calls).toEqual(['event:Stop:abc-123:/w'])
  })

  test('an unusable session id runs the guards alone, on the fixed id', async () => {
    const calls: string[] = []
    const bad = JSON.stringify({ session_id: '../x' })
    expect(JSON.parse((await runFrame(spec(calls), 'PreToolUse', bad)).stdout)).toEqual({ guards: true })
    expect(await runFrame(spec(calls), 'Stop', bad)).toEqual(QUIET)
    expect(calls).toEqual([`guards:${NO_SESSION_ID}`])
  })

  test("the memory runner's child gets the host's quiet answer at the skipped events only", async () => {
    const calls: string[] = []
    await withEnv({ BURACLE_MEMORY_RUNNER: '1' }, async () => {
      expect(JSON.parse((await runFrame(spec(calls), 'SessionStart', JSON.stringify({ session_id: 'abc' }))).stdout)).toEqual({ quiet: true })
      expect(JSON.parse((await runFrame(spec(calls), 'Stop', JSON.stringify({ session_id: 'abc' }))).stdout)).toEqual({ ev: 'Stop' })
    })
    expect(calls).toEqual(['event:Stop:abc:/cwd'])
  })
})

describe('hookStep', () => {
  test('answers the fallback when the step throws, and the value when it does not', async () => {
    const step = hookStep('test')
    expect(await step('ok', 'fb', () => 'v')).toBe('v')
    expect(await step('boom', 'fb', () => { throw new Error('x') })).toBe('fb')
  })
})

describe('workspaceReaders', () => {
  test('offers the three lookups every command hook needs', () => {
    expect(Object.keys(workspaceReaders).sort()).toEqual(['prepareWorkspace', 'refreshWorkspace', 'workspaceInfo'])
  })
})
