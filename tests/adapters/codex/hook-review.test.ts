import { describe, expect, test } from 'bun:test'
import { saveState } from '../../../src/workflow/session-store'
import { handleCodexHook } from '../../../src/adapters/codex/hook'
import { withSandbox } from '../../helpers/sandbox'
import { ctx, deps, payload, plan, planState, quiet, SID } from './hook-helpers'

describe('SubagentStop: H19 subject binding', () => {
  test('H19 binds the report to the root session\'s bound plan (a subagent reports with the root session id)', () => withSandbox(async () => {
    saveState('codex', SID, planState({ plan: { ...plan, path: '/abs/repo/docs/plans/p.md' } }))
    const report = (summary: string) => JSON.stringify({ verdict: 'pass', summary, findings: [] })
    const ok = await handleCodexHook('SubagentStop', payload('SubagentStop', { agent_id: 'r1', agent_type: 'plan-build-review', last_assistant_message: report('docs/plans/p.md: ok') }), ctx(), deps(quiet))
    expect(ok.stdout).toBe('')
    const other = await handleCodexHook('SubagentStop', payload('SubagentStop', { agent_id: 'r2', agent_type: 'plan-build-review', stop_hook_active: false, last_assistant_message: report('docs/plans/q.md: ok') }), ctx(), deps(quiet))
    expect(JSON.parse(other.stdout).reason).toContain('must start with the reviewed path (/abs/repo/docs/plans/p.md)')
  }))

  test('H19 accepts the bound plan\'s absolute path when it has a space, bare or in backticks', () => withSandbox(async () => {
    const spaced = '/Users/me/Desktop/Buracle Plugin/buracle/docs/plans/p.md'
    saveState('codex', SID, planState({ plan: { ...plan, path: spaced } }))
    const report = (summary: string) => JSON.stringify({ verdict: 'pass', summary, findings: [] })
    for (const [id, summary] of [['r1', `${spaced}: ok`], ['r2', `\`${spaced}\`: ok`]] as const) {
      const r = await handleCodexHook('SubagentStop', payload('SubagentStop', { agent_id: id, agent_type: 'plan-build-review', last_assistant_message: report(summary) }), ctx(), deps(quiet))
      expect(r.stdout).toBe('')
    }
  }))
})
