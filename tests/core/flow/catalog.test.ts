import { describe, expect, test } from 'bun:test'
import { FLOW_CATALOG, FLOW_WORKFLOWS, flowPhaseLabel, flowPhaseProblem, isTopLevelFlow, workflowOfPrompt, workflowOfSkill } from '../../../src/core/flow/catalog'

const TABLE: Record<string, string> = {
  'plan-build': 'plan: Plan · approve: Approve · implement: Implement · verify: Verify',
  'goal-build': 'goal: Goal · contract: Contract · build: Build · judge: Judge · verify: Verify · handback: Hand back',
  bugfix: 'investigate: Investigate · red: RED · fix: Fix · prove: Prove · gate: Quality gate · finish: Finish',
  requirements: 'understand: Understand · research: Research · ideate: Ideate · clarify: Clarify · propose: Propose · converge: Converge · write: Write · handoff: Hand off',
  research: 'frame: Frame · recall: Recall · plan: Plan · gather: Gather · verify: Verify · write: Write',
  inspect: 'frame: Frame · locate: Locate · trace: Trace · challenge: Challenge · report: Report',
  'dead-code': 'collect: Collect · check: Check · classify: Classify · plan: Plan · report: Report',
  'project-rules': 'inventory: Inventory · discover: Discover · verify: Verify · audit: Audit · write: Write · validate: Validate · sync: Sync · report: Report',
  'new-skill': 'capture: Capture · overlap: Overlap · design: Design · write: Write · evals: Evals · lint: Lint · test: Test · publish: Publish',
  'ab-test': 'frame: Frame · cases: Cases · budget: Budget · arms: Arms · smoke: Smoke · run: Run · score: Score · report: Report',
}

describe('flow catalog', () => {
  test('holds exactly the workflows and phases of the contract, in order', () => {
    expect([...FLOW_WORKFLOWS].sort()).toEqual(Object.keys(TABLE).sort())
    for (const [id, row] of Object.entries(TABLE)) {
      const want = row.split(' · ').map(pair => { const [pid, label] = pair.split(': ') as [string, string]; return { id: pid, label } })
      expect(FLOW_CATALOG[id]?.phases.map(p => ({ id: p.id, label: p.label }))).toEqual(want)
    }
  })

  test('short labels fit narrow layouts and labels are English text', () => {
    for (const def of Object.values(FLOW_CATALOG)) {
      for (const p of def.phases) {
        expect(p.short.length).toBeLessThanOrEqual(6)
        expect(p.short.length).toBeGreaterThan(0)
        expect(/^[A-Za-z ]+$/.test(p.label)).toBe(true)
      }
    }
  })

  test('only the person starts the explicit workflows; the model-invocable ones may nest', () => {
    for (const id of ['plan-build', 'goal-build', 'bugfix', 'requirements', 'inspect', 'dead-code']) expect(isTopLevelFlow(id)).toBe(true)
    for (const id of ['research', 'project-rules', 'new-skill', 'ab-test', 'my-own-skill']) expect(isTopLevelFlow(id)).toBe(false)
  })

  test('phase ids are checked against the catalogued workflow; other workflows take any kebab id', () => {
    expect(flowPhaseProblem('plan-build', 'implement')).toBeUndefined()
    expect(flowPhaseProblem('plan-build', 'judge')).toContain('plan, approve, implement, verify')
    expect(flowPhaseProblem('my-skill', 'anything-goes')).toBeUndefined()
    expect(flowPhaseProblem('my-skill', 'Not Kebab')).toContain('not a phase id')
    expect(flowPhaseLabel('bugfix', 'gate')).toBe('Quality gate')
    expect(flowPhaseLabel('my-skill', 'draft')).toBe('draft')
  })

  test("a slash command or Skill tool call names a workflow only with Buracle's prefix", () => {
    expect(workflowOfSkill('buracle:plan-build')).toBe('plan-build')
    expect(workflowOfSkill('/buracle:project-rules')).toBe('project-rules')
    expect(workflowOfSkill('plan-build')).toBeUndefined()
    expect(workflowOfSkill('buracle:memory')).toBeUndefined()
    expect(workflowOfSkill('other:spec')).toBeUndefined()
  })

  test('a prompt that opens with a workflow command, typed or in the transcript form', () => {
    expect(workflowOfPrompt('/buracle:plan-build add rate limiting\nmore')).toEqual({ workflow: 'plan-build', args: 'add rate limiting' })
    expect(workflowOfPrompt('  /buracle:bugfix')).toEqual({ workflow: 'bugfix', args: '' })
    expect(workflowOfPrompt('<command-message>buracle:research</command-message>\n<command-name>/buracle:research</command-name>\n<command-args>queue libs</command-args>'))
      .toEqual({ workflow: 'research', args: 'queue libs' })
    expect(workflowOfPrompt('why did /buracle:plan-build stop?')).toBeUndefined()
    expect(workflowOfPrompt('/buracle:specs')).toBeUndefined()
    expect(workflowOfPrompt('/plan-build x')).toBeUndefined()
  })
})
