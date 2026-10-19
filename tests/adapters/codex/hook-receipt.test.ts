import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defaultConfig } from '../../../src/core/config'
import { flowEnd, flowStart } from '../../../src/core/flow/record'
import { handleCodexHook } from '../../../src/adapters/codex/hook'
import { readFlow, writeFlow } from '../../../src/workflow/flow'
import { withSandbox } from '../../helpers/sandbox'
import { ctx, deps, keys, NOW, payload, quiet, SID } from './hook-helpers'

function turnDeps(clock: { now: number }, notes: string[], health = { failures: 0, failClosed: 0 }) {
  return { ...deps(quiet), now: () => clock.now, notify: (title: string, message: string) => { notes.push(`${title}: ${message}`) }, hookHealth: async () => health }
}

async function hook(event: string, extra: Record<string, unknown>, d: ReturnType<typeof turnDeps>, c = ctx()): Promise<Record<string, unknown>> {
  const out = (await handleCodexHook(event, payload(event, extra), c, d)).stdout
  return out === '' ? {} : JSON.parse(out) as Record<string, unknown>
}

const PATCH = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-export const a = 1\n+export const a = 2\n*** End Patch\n'

describe('Codex turn receipt (PARITY-3)', () => {
  test('an unverified code change warns once at the Stop that ends the turn; a passing check after it silences the warning', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'proj')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(cwd, 'src', 'a.ts'), 'export const a = 2\n')
    const clock = { now: NOW }
    const notes: string[] = []
    const d = turnDeps(clock, notes)
    await hook('UserPromptSubmit', { cwd, prompt: 'change a' }, d)
    expect(keys(await hook('PostToolUse', { cwd, tool_name: 'apply_patch', tool_input: { command: PATCH }, tool_response: 'Success.' }, d))).not.toContain('systemMessage')
    const stop = await hook('Stop', { cwd, last_assistant_message: 'Done, it works now.' }, d)
    expect(keys(stop)).toEqual(['systemMessage'])
    expect(stop['systemMessage']).toBe('Buracle · 1 file (+1 −1) · ⚠ success claimed without evidence: no test or check ran after the change')
    expect(await hook('Stop', { cwd }, d)).toEqual({})

    await hook('UserPromptSubmit', { cwd, prompt: 'again' }, d)
    await hook('PostToolUse', { cwd, tool_name: 'apply_patch', tool_input: { command: PATCH }, tool_response: 'Success.' }, d)
    expect(await hook('PostToolUseMask', { cwd, tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_response: 'Process exited with code 0\n3 pass' }, d)).toEqual({})
    expect(await hook('Stop', { cwd }, d)).toEqual({})
    expect(notes).toEqual([])
  }))

  test('the third identical failing command raises a loop alarm as a systemMessage next to the masked output', () => withSandbox(async ({ root }) => {
    const d = turnDeps({ now: NOW }, [])
    await hook('UserPromptSubmit', { cwd: root, prompt: 'fix it' }, d)
    const fail = { cwd: root, tool_name: 'Bash', tool_input: { command: 'bun test' }, tool_response: 'Process exited with code 1\n2 fail' }
    expect(await hook('PostToolUseMask', fail, d)).toEqual({})
    expect(await hook('PostToolUseMask', fail, d)).toEqual({})
    const third = await hook('PostToolUseMask', fail, d)
    expect(keys(third)).toEqual(['systemMessage'])
    expect(third['systemMessage']).toBe('Buracle: the same command failed 3 times in a row: `bun test` (do not run it again as is; read the output and change your hypothesis)')
    const key = 'AKIA' + 'IOSFODNN7EXAMPLE'
    const masked = await hook('PostToolUseMask', { ...fail, tool_input: { command: 'cat .env' }, tool_response: `Process exited with code 0\nKEY=${key}` }, d)
    expect(keys(masked)).toEqual(['decision', 'reason', 'systemMessage'])
    expect(JSON.stringify(masked)).not.toContain(key)
    const sub = await hook('PostToolUseMask', { ...fail, agent_id: 'a1', agent_type: 'worker' }, d)
    expect(sub).toEqual({})
  }))

  test('an apply_patch that undoes and redoes the same change twice raises the flip-flop alarm with that PostToolUse', () => withSandbox(async ({ root }) => {
    const d = turnDeps({ now: NOW }, [])
    await hook('UserPromptSubmit', { cwd: root, prompt: 'tune it' }, d)
    const patch = (from: string, to: string) => `*** Begin Patch\n*** Update File: src/a.ts\n@@\n-${from}\n+${to}\n*** End Patch\n`
    const post = (from: string, to: string) => hook('PostToolUse', { cwd: root, tool_name: 'apply_patch', tool_input: { command: patch(from, to) }, tool_response: 'Success.' }, d)
    expect((await post('x = 1', 'x = 2'))['systemMessage']).toBeUndefined()
    expect((await post('x = 2', 'x = 1'))['systemMessage']).toBeUndefined()
    expect((await post('x = 1', 'x = 2'))['systemMessage']).toBe(`Buracle: ${join(root, 'src', 'a.ts')}: the same change was undone and redone twice (you may be going in circles; rethink the approach)`)
  }))

  test('a turn longer than workflow.notifyAfterSec sends one desktop notification; 0 turns it off',() => withSandbox(async ({ root }) => {
    const clock = { now: NOW }
    const notes: string[] = []
    const d = turnDeps(clock, notes)
    await hook('UserPromptSubmit', { cwd: root, prompt: 'long work' }, d)
    clock.now = NOW + 185_000
    await hook('Stop', { cwd: root }, d)
    expect(notes).toEqual(['Buracle: Turn finished after 3 min'])
    const off = defaultConfig()
    off.workflow.notifyAfterSec = 0
    await hook('UserPromptSubmit', { cwd: root, prompt: 'long work' }, d, ctx(off))
    clock.now += 600_000
    await hook('Stop', { cwd: root }, d, ctx(off))
    expect(notes).toHaveLength(1)
  }))
})

describe('Codex workflow and health notices (PARITY-9)', () => {
  test('a workflow that ends is announced once, at the next Stop or prompt; workflow.codexNotices false keeps it quiet', () => withSandbox(async ({ root }) => {
    const d = turnDeps({ now: NOW }, [])
    writeFlow('codex', SID, flowStart(undefined, { workflow: 'plan-build', title: 'Add login', source: 'prompt' }, NOW - 60_000).record)
    expect(await hook('Stop', { cwd: root }, d)).toEqual({})
    writeFlow('codex', SID, flowEnd(readFlow('codex', SID), 'failed', NOW - 1_000).record)
    const quietCfg = defaultConfig()
    quietCfg.workflow.codexNotices = false
    expect(await hook('Stop', { cwd: root }, d, ctx(quietCfg))).toEqual({})
    const stop = await hook('Stop', { cwd: root }, d)
    expect(keys(stop)).toEqual(['systemMessage'])
    expect(stop['systemMessage']).toContain('Buracle workflow: plan-build (Add login)')
    expect(stop['systemMessage']).toContain('failed')
    expect(keys(await hook('UserPromptSubmit', { cwd: root, prompt: 'next' }, d))).not.toContain('systemMessage')
  }))

  test('SessionStart warns once when the hooks segment would be red or yellow', () => withSandbox(async ({ root }) => {
    const failing = turnDeps({ now: NOW }, [], { failures: 2, failClosed: 1 })
    const start = await hook('SessionStart', { cwd: root, source: 'startup' }, failing)
    expect(start['systemMessage']).toBe('Buracle: 2 Buracle hook runs failed in the last 24 h (1 denied a call); run `buracle doctor codex`. The tmux status line (`buracle statusline codex`) shows this too.')
    expect((await hook('SessionStart', { cwd: root, source: 'compact' }, failing))['systemMessage']).toBeUndefined()
    const behind = await hook('SessionStart', { cwd: root, source: 'resume' }, turnDeps({ now: NOW }, [], { failures: 0, failClosed: 0, runtimeBehind: true } as never))
    expect(behind['systemMessage']).toBe('Buracle: the installed Buracle runtime is behind the checkout; run `buracle install`. The tmux status line (`buracle statusline codex`) shows this too.')
    expect((await hook('SessionStart', { cwd: root, source: 'startup' }, turnDeps({ now: NOW }, [])))['systemMessage']).toBeUndefined()
  }))
})
