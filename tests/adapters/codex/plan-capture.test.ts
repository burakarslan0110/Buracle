import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handleCodexHook } from '../../../src/adapters/codex/hook'
import { CODEX_FRESH_PLAN_PREFIX, codexPlanApproval, lastAssistantText, proposedPlanOf } from '../../../src/adapters/codex/plan-capture'
import { parsePlan } from '../../../src/core/plan/format'
import * as paths from '../../../src/engine/paths'
import { localDate } from '../../../src/workflow/plan-file'
import { loadState } from '../../../src/workflow/session-store'
import { withSandbox } from '../../helpers/sandbox'
import { NATIVE_PLAN_BODY, prepareNativePlan } from '../../workflow/fixture'
import { ctx, deps, NOW, payload, quiet, SID } from './hook-helpers'

const PLAN = '# Add a cache\n\n1. Cache the index\n2. Test it'
const PROPOSED = `Here is the plan.\n\n<proposed_plan>\n${PLAN}\n</proposed_plan>\n`
const SAVED = `${localDate(NOW)}-add-a-cache.md`

function contextOf(stdout: string): string {
  if (stdout === '') return ''
  const o = JSON.parse(stdout) as { hookSpecificOutput?: { additionalContext?: string } }
  return o.hookSpecificOutput?.additionalContext ?? ''
}

function app(root: string): string {
  const dir = join(root, 'app')
  mkdirSync(dir, { recursive: true })
  return dir
}

const stop = (cwd: string, last: string, extra: Record<string, unknown> = {}) =>
  handleCodexHook('Stop', payload('Stop', { cwd, last_assistant_message: last, stop_hook_active: false, ...extra }), ctx(), deps(quiet))
const prompt = (cwd: string, text: string, extra: Record<string, unknown> = {}) =>
  handleCodexHook('UserPromptSubmit', payload('UserPromptSubmit', { cwd, prompt: text, ...extra }), ctx(), deps(quiet))

function rolloutLine(text: string): string {
  return JSON.stringify({ timestamp: '2026-10-08T12:00:00Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }], phase: 'final_answer' } })
}

describe('Codex H12: an approved <proposed_plan> is saved to docs/plans/', () => {
  test('Stop keeps the block (also through a Buracle continuation); Codex\'s "Implement the plan." saves it once, as approved, naming Codex', () => withSandbox(async ({ root }) => {
    const cwd = app(root)
    await stop(cwd, PROPOSED)
    expect(existsSync(join(paths.sessionDir('codex', SID), 'proposed-plan.json'))).toBe(true)
    await stop(cwd, 'Continuing as Buracle asked.', { stop_hook_active: true })
    expect(existsSync(join(paths.sessionDir('codex', SID), 'proposed-plan.json'))).toBe(true)
    const r = await prompt(cwd, 'Implement the plan.')
    expect(contextOf(r.stdout)).toContain(`docs/plans/${SAVED} (H12)`)
    const text = readFileSync(join(cwd, 'docs', 'plans', SAVED), 'utf8')
    expect(parsePlan(text).header).toMatchObject({ status: 'SAVED', approved: true, type: 'Plan' })
    expect(text).toContain('harness: codex')
    expect(text).toContain('> 2. Test it')
    expect(text).not.toContain('Here is the plan.')
    expect(contextOf((await prompt(cwd, 'Implement the plan.')).stdout)).not.toContain('(H12)')
    expect(readdirSync(join(cwd, 'docs', 'plans'))).toEqual([SAVED])
  }))

  test('in plan mode Codex strips the block from last_assistant_message: the rollout\'s last assistant message still has it', () => withSandbox(async ({ root }) => {
    const cwd = app(root)
    const rollout = join(root, 'rollout.jsonl')
    writeFileSync(rollout, [rolloutLine('An older answer.'), JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'Here is the plan.' } }), rolloutLine(PROPOSED), ''].join('\n'))
    await stop(cwd, 'Here is the plan.', { transcript_path: rollout })
    expect(existsSync(join(paths.sessionDir('codex', SID), 'proposed-plan.json'))).toBe(false)
    expect(contextOf((await prompt(cwd, 'Implement the plan.', { transcript_path: rollout })).stdout)).toContain('(H12)')
    expect(existsSync(join(cwd, 'docs', 'plans', SAVED))).toBe(true)
  }))

  test('the fresh-thread choice carries the plan in its prompt; any other prompt drops the kept plan; a subagent is ignored', () => withSandbox(async ({ root }) => {
    const cwd = app(root)
    expect(contextOf((await prompt(cwd, `${CODEX_FRESH_PLAN_PREFIX}\n\n${PLAN}\n`)).stdout)).toContain('(H12)')
    expect(existsSync(join(cwd, 'docs', 'plans', SAVED))).toBe(true)
    await stop(cwd, PROPOSED)
    expect(contextOf((await prompt(cwd, 'make the cache bigger')).stdout)).not.toContain('(H12)')
    expect(contextOf((await prompt(cwd, 'Implement the plan.')).stdout)).not.toContain('(H12)')
    await handleCodexHook('Stop', payload('Stop', { cwd, last_assistant_message: PROPOSED, agent_id: 'child', agent_type: 'worker' }), ctx(), deps(quiet))
    expect(existsSync(join(paths.sessionDir('codex', SID), 'proposed-plan.json'))).toBe(false)
    expect(readdirSync(join(cwd, 'docs', 'plans'))).toEqual([SAVED])
  }))

  test('plan.nativePlanMode: "Implement the plan." approves the prepared plan-build plan and fills the registered file; no SAVED copy', () => withSandbox(async ({ root }) => {
    const cwd = app(root)
    const path = await prepareNativePlan(cwd, 'codex', SID)
    await stop(cwd, `Here is the plan.\n\n<proposed_plan>\n${NATIVE_PLAN_BODY.trim()}\n</proposed_plan>\n`)
    const said = contextOf((await prompt(cwd, 'Implement the plan.')).stdout)
    expect(said).toContain('the plan the user approved in Codex plan mode was written into the registered plan')
    const text = readFileSync(path, 'utf8')
    expect(parsePlan(text).header).toMatchObject({ type: 'Feature', status: 'PENDING', approved: true })
    expect(parsePlan(text).title).toBe('Add a cache')
    expect(text).not.toContain('Here is the plan.')
    expect(readdirSync(join(cwd, 'docs', 'plans'))).toEqual([path.split('/').at(-1) as string])
    expect(loadState('codex', SID).native).toBeUndefined()
  }))

  test('the host text is parsed exactly: tags on their own lines, the last block wins, only Codex\'s own approval prompts count', () => {
    expect(proposedPlanOf(`<proposed_plan>\nfirst\n</proposed_plan>\ntext\n<proposed_plan>\n${PLAN}\n</proposed_plan>`)).toBe(PLAN)
    expect(proposedPlanOf('inline <proposed_plan>x</proposed_plan>')).toBeUndefined()
    expect(proposedPlanOf('<proposed_plan>\n  \n</proposed_plan>')).toBeUndefined()
    expect(codexPlanApproval('Implement the plan.')).toEqual({ kind: 'implement' })
    expect(codexPlanApproval(' Implement the plan.\n')).toEqual({ kind: 'implement' })
    expect(codexPlanApproval('Implement the plan. Also add docs.')).toBeUndefined()
    expect(codexPlanApproval(`${CODEX_FRESH_PLAN_PREFIX}\r\n\r\n${PLAN}`)).toEqual({ kind: 'fresh', plan: PLAN })
    expect(codexPlanApproval(CODEX_FRESH_PLAN_PREFIX)).toBeUndefined()
    expect(lastAssistantText([rolloutLine('a'), JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'u' }] } })].join('\n'))).toBe('a')
    expect(lastAssistantText('not json\n')).toBeUndefined()
  })
})
