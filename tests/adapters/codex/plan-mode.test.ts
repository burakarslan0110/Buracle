import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleCodexHook } from '../../../src/adapters/codex/hook'
import { loadState, saveState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'
import { ctx, deps, payload, plan, planState, quiet, SID } from './hook-helpers'

const additional = (stdout: string): string => (stdout === '' ? '' : String(JSON.parse(stdout).hookSpecificOutput?.additionalContext ?? ''))

describe('Codex: read-only plan mode and edits before approval', () => {
  test('a workflow started in the Plan collaboration mode (read from the rollout) gets the leave-plan-mode notice', () => withSandbox(async ({ root }) => {
    const rollout = join(root, 'rollout.jsonl')
    const turn = (mode: string) => JSON.stringify({ type: 'turn_context', payload: { cwd: root, collaboration_mode: { mode, settings: {} } } })
    writeFileSync(rollout, `${turn('plan')}\n`)
    const prompt = (text: string) => payload('UserPromptSubmit', { prompt: text, transcript_path: rollout, cwd: root })
    expect(additional((await handleCodexHook('UserPromptSubmit', prompt('$plan-build add rate limits'), ctx(), deps(quiet))).stdout)).toContain("plan-build was started while the session is in Codex's Plan mode")
    expect(additional((await handleCodexHook('UserPromptSubmit', prompt('what is a token bucket?'), ctx(), deps(quiet))).stdout)).not.toContain('was started while')
    writeFileSync(rollout, `${turn('plan')}\n${turn('default')}\n`)
    expect(additional((await handleCodexHook('UserPromptSubmit', prompt('$plan-build add rate limits'), ctx(), deps(quiet))).stdout)).not.toContain('was started while')
  }))

  test('the Plan mode is still recognised after a turn whose tool output fills more than 512 KiB of the rollout', () => withSandbox(async ({ root }) => {
    const rollout = join(root, 'rollout.jsonl')
    const turn = JSON.stringify({ type: 'turn_context', payload: { cwd: root, collaboration_mode: { mode: 'plan', settings: {} } } })
    const output = (i: number) => JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: `call_${i}`, output: 'x'.repeat(10_000) } })
    writeFileSync(rollout, `${[turn, ...Array.from({ length: 60 }, (_, i) => output(i))].join('\n')}\n`)
    const prompt = payload('UserPromptSubmit', { prompt: '$plan-build add rate limits', transcript_path: rollout, cwd: root })
    expect(additional((await handleCodexHook('UserPromptSubmit', prompt, ctx(), deps(quiet))).stdout)).toContain("plan-build was started while the session is in Codex's Plan mode")
  }))

  test('the first apply_patch of another file while the plan waits for approval gets one note', () => withSandbox(async () => {
    saveState('codex', SID, planState({ plan: { ...plan, path: '/work/app/docs/plans/p.md', status: 'PENDING', phase: 'plan' } }))
    const patch = (file: string) => payload('PreToolUse', { tool_name: 'apply_patch', tool_input: { command: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n` } })
    expect(additional((await handleCodexHook('PreToolUse', patch('docs/plans/p.md'), ctx(), deps(quiet))).stdout)).not.toContain('plan phase')
    const first = additional((await handleCodexHook('PreToolUse', patch('src/app.ts'), ctx(), deps(quiet))).stdout)
    expect(first).toContain('this edit changes /work/app/src/app.ts while the plan /work/app/docs/plans/p.md is still in its plan phase')
    expect(loadState('codex', SID).guard.earlyEditNoted).toBe(true)
    expect(additional((await handleCodexHook('PreToolUse', patch('src/other.ts'), ctx(), deps(quiet))).stdout)).not.toContain('plan phase')
  }))
})
