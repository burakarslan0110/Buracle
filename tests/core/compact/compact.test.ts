import { describe, expect, test } from 'bun:test'
import { COMPACT_MARKER, HANDOFF_GENERATED_BY, compactInstructions, compactInstructionsWith, handoffNote, handoffNoteLocal, restoreContext } from '../../../src/core/compact'
import { parseFrontmatter } from '../../../src/core/frontmatter'
import { parseNote } from '../../../src/core/memory/note'
import type { SessionState } from '../../../src/core/plan/state'
import { emptyState } from '../../../src/core/plan/state'

const NOW = Date.UTC(2026, 9, 7, 20, 50, 30)
function withPlan(over: Partial<NonNullable<SessionState['plan']>> = {}, rest: Partial<SessionState> = {}): SessionState {
  return { ...emptyState(), plan: { path: 'docs/plans/2026-10-07-rate-limit.md', slug: 'rate-limit', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1, ...over }, ...rest }
}

describe('compactInstructions', () => {
  test('keeps the harness base and appends the plan state to preserve', () => {
    const out = compactInstructions('Summarize the conversation.', withPlan())
    expect(out.startsWith('Summarize the conversation.\n\n' + COMPACT_MARKER)).toBe(true)
    expect(out).toContain('docs/plans/2026-10-07-rate-limit.md')
    expect(out).toContain('status IN_PROGRESS')
    expect(out).toContain('phase implement')
    expect(out).toContain("user's requests")
  })

  test('without a plan only the general preservation rules are added', () => {
    const out = compactInstructions(undefined, emptyState())
    expect(out.startsWith(COMPACT_MARKER)).toBe(true)
    expect(out).not.toContain('Active plan')
    expect(compactInstructions(undefined, withPlan({ status: 'VERIFIED' }))).not.toContain('Active plan')
  })

  test('a paused run keeps its pause and the open question', () => {
    const out = compactInstructions('', withPlan({}, { interaction: { state: 'paused', kind: 'decision', since: 1, reason: 'Redis or in-memory?' } }))
    expect(out).toContain('paused (decision)')
    expect(out).toContain('Redis or in-memory?')
  })

  test('is idempotent: a second call replaces the block instead of stacking it', () => {
    const once = compactInstructions('Base.', withPlan())
    const twice = compactInstructions(once, withPlan({ status: 'COMPLETE', phase: 'verify' }))
    expect(twice.split(COMPACT_MARKER).length).toBe(2)
    expect(twice.startsWith('Base.\n\n')).toBe(true)
    expect(twice).toContain('phase verify')
    expect(twice).not.toContain('phase implement')
  })

  test('keeps decisions with reasons, rejected approaches, verification results, touched paths and background work', () => {
    const out = compactInstructions(undefined, emptyState())
    expect(out).toContain('every decision with its reason')
    expect(out).toContain('tried and rejected, each with why it failed')
    expect(out).toContain('verification commands that ran and their results')
    expect(out).toContain('paths of the files changed')
    expect(out).toContain('never an unanswered question or an unfinished step')
    expect(/[çğıöşüÇĞİÖŞÜ]/.test(out)).toBe(false)
  })

  test('compactInstructionsWith adds the running workflow, the touched files and the background work', () => {
    const out = compactInstructionsWith('Base.', withPlan(), {
      flow: 'spec, phase Implement, step "parser tests"',
      touched: ['src/a.ts', 'src/b.ts', '  '],
      background: ['changes-review (subagent)'],
    })
    expect(out).toContain('- Running workflow: spec, phase Implement, step "parser tests". Continue it after compaction; `buracle flow status` shows where it stands.')
    expect(out).toContain('- Files changed so far (keep these paths and what changed in each): src/a.ts, src/b.ts.')
    expect(out).toContain('- Still running in the background (keep them and how to check on them): changes-review (subagent).')
    expect(compactInstructionsWith(out, withPlan(), {}).split(COMPACT_MARKER).length).toBe(2)
    expect(compactInstructionsWith(undefined, emptyState(), {})).toBe(compactInstructions(undefined, emptyState()))
  })
})

describe('handoffNote', () => {
  const note = handoffNote({ state: withPlan(), project: 'buracle', harness: 'claude', sessionId: '3F2A9C1E-0000-4000-8000-000000000000', branch: 'main', now: NOW, todo: ['Finish task 3', '  ', 'Line\nbreak'] })

  test('slug and id follow the vault naming (UTC date, harness, short session)', () => {
    expect(note.slug).toBe('2026-10-07-2050-claude-3f2a9c')
    const { data } = parseFrontmatter(note.markdown)
    expect(data['id']).toBe('h-20261007-2050-claude-3f2a9c')
  })

  test('flat frontmatter with the vault schema fields and plan pointers', () => {
    const { data, hasFrontmatter } = parseFrontmatter(note.markdown)
    expect(hasFrontmatter).toBe(true)
    expect(data).toMatchObject({
      type: 'handoff', title: 'Handoff: buracle · rate-limit', status: 'active', scope: 'project', project: 'buracle',
      created: '2026-10-07T20:50:30+00:00', updated: '2026-10-07T20:50:30+00:00', harness: 'claude-code', session: '3F2A9C1E-0000-4000-8000-000000000000',
      branch: 'main', plan: 'docs/plans/2026-10-07-rate-limit.md', plan_status: 'IN_PROGRESS', plan_phase: 'implement', plan_type: 'Feature',
      stale_after: '2026-10-21', generated_by: 'process:buracle-handoff', review: 'ok',
    })
    expect(HANDOFF_GENERATED_BY).toBe('process:buracle-handoff')
    for (const v of Object.values(data)) expect(typeof v === 'object' && v !== null).toBe(false)
  })

  test('the frontmatter reads back with the title, description and type the handoff memory takes, for every harness and edge case', () => {
    const cases = [
      note,
      handoffNote({ state: emptyState(), project: '', harness: 'omp', sessionId: '::', now: NOW }),
      handoffNoteLocal({ state: withPlan(), project: 'Buracle Plugin', harness: 'codex', sessionId: 'abc', now: NOW }, 180),
      handoffNoteLocal({ state: withPlan({ status: 'VERIFIED' }), project: 'p', harness: 'opencode', sessionId: 's-1', branch: 'feat/x', now: NOW }, -300),
    ]
    for (const n of cases) {
      const { fm, body } = parseNote(n.markdown)
      expect({ slug: n.slug, type: fm['type'], title: typeof fm['title'], description: typeof fm['description'] }).toEqual({ slug: n.slug, type: 'handoff', title: 'string', description: 'string' })
      expect(String(fm['title'])).not.toBe('')
      expect(body.trim()).not.toBe('')
    }
  })

  test('handoffNoteLocal: created/updated carry the UTC offset; slug, id and stale_after follow the local date', () => {
    expect(handoffNote({ state: withPlan(), project: 'buracle', harness: 'claude', sessionId: 'abcdef12', now: NOW })).toEqual(handoffNoteLocal({ state: withPlan(), project: 'buracle', harness: 'claude', sessionId: 'abcdef12', now: NOW }, 0))
    const tr = handoffNoteLocal({ state: withPlan(), project: 'buracle', harness: 'claude', sessionId: 'abcdef12', now: NOW }, 180)
    expect(tr.slug).toBe('2026-10-07-2350-claude-abcdef')
    expect(parseFrontmatter(tr.markdown).data).toMatchObject({ id: 'h-20261007-2350-claude-abcdef', created: '2026-10-07T23:50:30+03:00', updated: '2026-10-07T23:50:30+03:00', stale_after: '2026-10-21' })
    const east = handoffNoteLocal({ state: withPlan(), project: 'buracle', harness: 'claude', sessionId: 'abcdef12', now: NOW }, 300)
    expect(east.slug).toBe('2026-10-08-0150-claude-abcdef')
    expect(parseFrontmatter(east.markdown).data).toMatchObject({ created: '2026-10-08T01:50:30+05:00', stale_after: '2026-10-22' })
    const west = handoffNoteLocal({ state: withPlan(), project: 'buracle', harness: 'claude', sessionId: 'abcdef12', now: NOW }, -420)
    expect(parseFrontmatter(west.markdown).data['created']).toBe('2026-10-07T13:50:30-07:00')
    for (const off of [Number.NaN, 24 * 60, -15 * 60]) {
      expect(handoffNoteLocal({ state: withPlan(), project: 'buracle', harness: 'claude', sessionId: 'abcdef12', now: NOW }, off).slug).toBe('2026-10-07-2050-claude-abcdef')
    }
  })

  test('the project becomes a vault slug', () => {
    const slugOf = (project: string) => parseFrontmatter(handoffNote({ state: emptyState(), project, harness: 'codex', sessionId: 's', now: NOW }).markdown).data['project']
    expect(slugOf('buracle')).toBe('buracle')
    expect(slugOf('Buracle Plugin')).toBe('buracle-plugin')
    expect(slugOf('Çalışma Alanı')).toBe('calisma-alani')
    expect(slugOf('  ')).toBe('unknown')
    expect(slugOf('!!!')).toBe('unknown')
  })

  test('the body lists the plan, the open todos (one line each) and how to resume', () => {
    expect(note.markdown).toContain('# Handoff: buracle · rate-limit')
    expect(note.markdown).toContain('- Path: `docs/plans/2026-10-07-rate-limit.md`')
    expect(note.markdown).toContain('- Interaction: running')
    expect(note.markdown).toContain('- [ ] Finish task 3')
    expect(note.markdown).toContain('- [ ] Line break')
    expect(note.markdown).toContain('buracle plan status --json')
    expect(note.markdown.includes('\r')).toBe(false)
  })

  test('without a plan or todos', () => {
    const n = handoffNote({ state: emptyState(), project: '', harness: 'omp', sessionId: '::', now: NOW })
    expect(n.slug).toBe('2026-10-07-2050-omp-nosess')
    expect(n.markdown).toContain('## Active plan\nNone.')
    expect(n.markdown).toContain('None recorded.')
    const { data } = parseFrontmatter(n.markdown)
    expect(data['project']).toBe('unknown')
    expect(data['plan']).toBeUndefined()
    expect(data['branch']).toBeUndefined()
  })

  test('is deterministic for the same input', () => {
    const a = handoffNote({ state: withPlan(), project: 'p', harness: 'codex', sessionId: 'abc', now: NOW })
    const b = handoffNote({ state: withPlan(), project: 'p', harness: 'codex', sessionId: 'abc', now: NOW })
    expect(a).toEqual(b)
  })
})

describe('reviewers in flight survive the compaction on every harness (the records in session state)', () => {
  const PLAN = 'docs/plans/2026-10-07-rate-limit.md'
  const reviews: NonNullable<SessionState['reviews']> = [
    { role: 'changes', plan: PLAN, state: 'running', startedAt: 5, handle: 'agent-a1', provider: 'codex' },
    { role: 'plan', plan: PLAN, state: 'collected', startedAt: 1, collectedAt: 2, verdict: 'pass', fingerprint: 'f' },
    { role: 'goal', plan: 'docs/builds/other.md', state: 'running', startedAt: 3 },
  ]
  const state = withPlan({ phase: 'verify', status: 'COMPLETE' }, { reviews })

  test('the compaction instructions, the handoff note and the restore text name the running reviewer of this plan with its handle', () => {
    const line = 'changes-review (handle agent-a1, codex)'
    const compact = compactInstructions(undefined, state)
    expect(compact).toContain(`Reviewers launched in the background and not collected yet: ${line}.`)
    expect(compact).toContain('instead of launching a new one')
    expect(compact).not.toContain('goal-build-review')
    expect(compact).not.toContain('plan-build-review')
    expect(handoffNote({ state, project: 'buracle', harness: 'opencode', sessionId: 's', now: NOW }).markdown).toContain(line)
    const restored = restoreContext(state) as string
    expect(restored).toContain(line)
    expect(restored).toContain('buracle plan review done --role <role> --verdict <verdict>')
  })

  test('a second opinion still running on another harness gets its own sentence with the collect command', () => {
    const second: NonNullable<SessionState['reviews']> = [...reviews, { role: 'changes', plan: PLAN, state: 'running', startedAt: 6, handle: 'cmp-changes-1a2b3c4d', provider: 'opencode', companion: true }]
    const s = withPlan({ phase: 'verify', status: 'COMPLETE' }, { reviews: second })
    const compact = compactInstructions(undefined, s)
    expect(compact).toContain('Reviewers launched in the background and not collected yet: changes-review (handle agent-a1, codex).')
    expect(compact).toContain('Second opinions running on another harness and not collected yet: changes-review second opinion on opencode (job cmp-changes-1a2b3c4d). Collect each with `buracle plan review companion collect --role <role>` instead of starting it again.')
    expect(restoreContext(s) as string).toContain('changes-review second opinion on opencode (job cmp-changes-1a2b3c4d)')
    const onlySecond = withPlan({ phase: 'verify', status: 'COMPLETE' }, { reviews: second.slice(1) })
    expect(compactInstructions(undefined, onlySecond)).not.toContain('Reviewers launched in the background')
    expect(compactInstructions(undefined, onlySecond)).toContain('Second opinions running on another harness')
  })

  test('a plan lane\'s reviewer recorded through --lane is named too, also when the lead has no plan of its own', () => {
    const laneReviews: NonNullable<SessionState['laneReviews']> = [{ lane: 'billing', role: 'changes', startedAt: 7, handle: 'agent-b2' }]
    const line = 'changes-review for lane billing (handle agent-b2)'
    const leadOnly: SessionState = { ...emptyState(), laneReviews }
    expect(compactInstructions(undefined, leadOnly)).toContain(`not collected yet: ${line}.`)
    expect(compactInstructions(undefined, leadOnly)).toContain('(plus `--lane <slug>` for a lane\'s reviewer)')
    expect(handoffNote({ state: leadOnly, project: 'buracle', harness: 'omp', sessionId: 's', now: NOW }).markdown).toContain(line)
    expect(restoreContext(leadOnly)).toContain(line)
    const both = restoreContext(withPlan({ phase: 'verify', status: 'COMPLETE' }, { reviews, laneReviews })) as string
    expect(both).toContain('changes-review (handle agent-a1, codex); changes-review for lane billing (handle agent-b2)')
    expect(restoreContext(emptyState())).toBeUndefined()
  })

  test('nothing in flight, or no active plan: no reviewer line', () => {
    expect(compactInstructions(undefined, withPlan({}, { reviews: [reviews[1] as NonNullable<SessionState['reviews']>[number]] }))).not.toContain('Reviewers launched')
    expect(compactInstructions(undefined, withPlan({ status: 'VERIFIED' }, { reviews }))).not.toContain('Reviewers launched')
  })
})

describe('restoreContext', () => {
  test('points at the active plan and the handoff note', () => {
    const out = restoreContext(withPlan(), '/vault/projects/buracle/handoffs/2026-10-07-2050-claude-3f2a9c.md') as string
    expect(out).toContain('docs/plans/2026-10-07-rate-limit.md')
    expect(out).toContain('Re-read the whole plan file')
    expect(out).toContain('without asking whether to continue')
    expect(out).toContain('handoffs/2026-10-07-2050-claude-3f2a9c.md')
  })

  test('a paused run is restored as paused', () => {
    const out = restoreContext(withPlan({}, { interaction: { state: 'paused', kind: 'manual', since: 1, reason: 'create the API key' } })) as string
    expect(out).toContain('paused (manual)')
    expect(out).not.toContain('without asking whether to continue')
  })

  test('undefined when nothing applies; handoff alone still points', () => {
    expect(restoreContext(emptyState())).toBeUndefined()
    expect(restoreContext(withPlan({ status: 'VERIFIED' }))).toBeUndefined()
    expect(restoreContext(emptyState(), '  ')).toBeUndefined()
    expect(restoreContext(emptyState(), 'h.md')).toContain('h.md')
  })

  test('open todos are inlined only when there is no handoff memory to point at, at most ten', () => {
    const todos = Array.from({ length: 12 }, (_, i) => `step ${i + 1}`)
    const inlined = restoreContext(emptyState(), undefined, ['  ', ...todos]) as string
    expect(inlined.split('\n')).toEqual(['Buracle: the context was compacted.', 'Open todos at compaction time (no handoff memory was written):', ...todos.slice(0, 10).map(t => `- ${t}`)])
    const withPlanToo = restoreContext(withPlan(), undefined, ['step 1']) as string
    expect(withPlanToo).toContain('Re-read the whole plan file')
    expect(withPlanToo).toContain('- step 1')
    const pointer = restoreContext(emptyState(), 'handoff-x', ['step 1']) as string
    expect(pointer).toContain('handoff-x')
    expect(pointer).not.toContain('step 1')
    expect(restoreContext(emptyState(), undefined, [])).toBeUndefined()
  })
})
