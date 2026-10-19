import { describe, expect, test } from 'bun:test'
import type { ToolCall } from '../../../src/core/events'
import { classifyTool } from '../../../src/core/events'
import { ASYNC_QUESTION_PAUSED, QUESTION_PAUSE_NOTE, checkQuestion, questionAnswered, questionPause } from '../../../src/core/policy/questions'
import type { SessionState } from '../../../src/core/plan/state'
import { emptyState } from '../../../src/core/plan/state'

function running(over: Partial<NonNullable<SessionState['plan']>> = {}, interaction?: SessionState['interaction']): SessionState {
  return {
    ...emptyState(),
    plan: { path: 'docs/plans/2026-10-08-x.md', slug: 'x', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: 1, ...over },
    ...(interaction ? { interaction } : {}),
  }
}

function ask(questions: Array<{ question: string, options?: Array<string | { label: string, description?: string }> }>, harness: ToolCall['harness'] = 'claude'): ToolCall {
  const tool = { claude: 'AskUserQuestion', codex: 'request_user_input', opencode: 'question', omp: 'ask' }[harness]
  const input: Record<string, unknown> = {
    questions: questions.map((q, i) => ({ id: `q${i}`, header: 'Q', question: q.question, options: (q.options ?? []).map(o => (typeof o === 'string' ? { label: o, description: '' } : o)) })),
  }
  return { harness, sessionId: 's', cwd: '/r', tool, input, ...classifyTool(harness, tool, input, '/r') }
}

const ROUTINE: Array<[string, string[]]> = [
  ['Should I continue?', []],
  ['Should I keep waiting for the build?', ['Keep waiting', 'Stop']],
  ['The test suite is still running. Shall I proceed?', ['Yes', 'No']],
  ['Do you want me to continue with Task 3?', ['Yes, continue', 'No, stop']],
  ['Would you like me to keep going?', []],
  ['Is it ok if I continue?', ['Continue (Recommended)', 'Pause']],
  ['Let me know if I should proceed.', []],
  ['Continue?', ['Continue', 'Stop']],
  ['Should I keep waiting or stop?', ['Keep waiting', 'Stop']],
  ['Devam edeyim mi?', ['Evet', 'Hayır']],
  ['Build hâlâ çalışıyor, beklemeye devam edeyim mi?', ['Beklemeye devam et', 'Dur']],
  ['Testler sürüyor. Bekleyeyim mi?', []],
  ['Bir sonraki göreve geçeyim mi?', ['Evet', 'Hayır']],
  ['Devam etmemi ister misin?', ['Devam', 'İptal']],
  ['Sürdüreyim mi?', []],
]

const GENUINE: Array<[string, string[]]> = [
  ['Should I continue with Redis or switch to the in-memory store?', ['Redis', 'In-memory store']],
  ['Which approach should I take?', ['Fixed window (recommended)', 'Sliding window']],
  ['Should I continue?', ['Continue with approach A', 'Switch to approach B']],
  ['Should I proceed with deleting the old table?', ['Yes', 'No']],
  ['Should I continue and push to origin?', ['Yes', 'No']],
  ['The deploy is still running; keep waiting?', ['Keep waiting', 'Stop']],
  ['Tests fail for an unrelated reason. Should I continue?', ['Continue', 'Stop']],
  ['Should I continue? This will cost about $40 in API usage.', ['Yes', 'No']],
  ['Devam edeyim mi, yoksa önce migration mı yazayım?', ['Devam', 'Önce migration']],
  ['Eski dosyaları sileyim mi?', ['Evet', 'Hayır']],
  ['API anahtarını nereye koyayım?', []],
  ['Commit mesajı ne olsun?', []],
  ['Do you approve the plan?', ['Approve', 'Request changes']],
]

describe('checkQuestion: running approved plan', () => {
  for (const [question, options] of ROUTINE) {
    test(`denies routine: ${question}`, () => {
      const r = checkQuestion(running(), ask([{ question, options }]), 10)
      expect(r.deny).toBeDefined()
      expect(r.deny).toContain('buracle plan pause --kind decision')
    })
  }
  for (const [question, options] of GENUINE) {
    test(`allows genuine, with the pause reminder: ${question}`, () => {
      expect(checkQuestion(running(), ask([{ question, options }]), 10)).toEqual({ context: QUESTION_PAUSE_NOTE })
    })
  }

  test('a mixed batch is denied with the routine items named, so the agent asks the rest again', () => {
    const mixed = ask([{ question: 'Should I continue?', options: ['Yes', 'No'] }, { question: 'Which database?', options: ['Postgres', 'SQLite'] }])
    const r = checkQuestion(running(), mixed, 10)
    expect(r.deny).toContain('drop "Should I continue?" and ask the remaining question again')
    const all = ask([{ question: 'Should I continue?' }, { question: 'Keep waiting?', options: ['Keep waiting', 'Stop'] }])
    expect(checkQuestion(running(), all, 10).deny).toContain('buracle plan pause --kind decision')
  })

  test('works for every harness question tool', () => {
    for (const h of ['claude', 'codex', 'opencode', 'omp'] as const) {
      expect(checkQuestion(running(), ask([{ question: 'Should I continue?' }], h), 10).deny).toBeDefined()
    }
  })

  test('omp string options and a single-question shape are understood', () => {
    const call: ToolCall = { harness: 'omp', sessionId: 's', cwd: '/r', tool: 'ask', kind: 'ask_user', paths: [], input: { question: 'Devam edeyim mi?', options: ['Evet', 'Hayır'] } }
    expect(checkQuestion(running(), call, 1).deny).toBeDefined()
    const omp: ToolCall = { ...call, input: { questions: [{ question: 'Devam edeyim mi?', options: [{ label: 'Evet' }, { label: 'Hayır' }] }] } }
    expect(checkQuestion(running(), omp, 1).deny).toBeDefined()
  })
})

describe('checkQuestion: when questions always pass', () => {
  const routine = ask([{ question: 'Should I keep waiting?', options: ['Keep waiting', 'Stop'] }])

  test('a decision pause lets every question through; a user or manual hold denies only the routine ones', () => {
    const genuine = ask([{ question: 'Which database?', options: ['Postgres', 'SQLite'] }])
    expect(checkQuestion(running({}, { state: 'paused', kind: 'decision', since: 1 }), routine, 10)).toEqual({})
    for (const kind of ['discussion', 'manual'] as const) {
      expect(checkQuestion(running({}, { state: 'paused', kind, since: 1 }), routine, 10).deny).toContain('The plan is held for the user')
      expect(checkQuestion(running({}, { state: 'paused', kind, since: 1 }), genuine, 10)).toEqual({})
    }
    expect(checkQuestion(running({}, { state: 'paused', since: 1 }), routine, 10).deny).toContain('held for the user')
    expect(checkQuestion(running({}, { state: 'running', since: 1 }), routine, 10).deny).toBeDefined()
  })

  test('no plan, or a plan that is neither approved and running nor being verified', () => {
    expect(checkQuestion(emptyState(), routine, 10)).toEqual({})
    for (const status of ['PENDING', 'VERIFIED', 'SAVED'] as const) expect(checkQuestion(running({ status }), routine, 10)).toEqual({})
    for (const status of ['APPROVED', 'COMPLETE'] as const) expect(checkQuestion(running({ status }), routine, 10).deny).toBeDefined()
    expect(checkQuestion(running({ status: 'COMPLETE', phase: 'verify' }), routine, 10).deny).toBeDefined()
  })

  test('real verify questions (the merge, the result review, a failing gap) still pass at COMPLETE', () => {
    for (const question of ['Squash-merge into main and remove the worktree?', 'Do you approve this verified result?', 'SC-2 still fails after three iterations. How should I proceed?']) {
      expect(checkQuestion(running({ status: 'COMPLETE', phase: 'verify' }), ask([{ question, options: ['Yes', 'No'] }]), 10).deny).toBeUndefined()
    }
  })

  test('phase plan or done', () => {
    expect(checkQuestion(running({ phase: 'plan' }), routine, 10)).toEqual({})
    expect(checkQuestion(running({ phase: 'done' }), routine, 10)).toEqual({})
    expect(checkQuestion(running({ phase: 'verify' }), routine, 10).deny).toBeDefined()
  })

  test('other tools and empty question lists', () => {
    const bash: ToolCall = { harness: 'claude', sessionId: 's', cwd: '/r', tool: 'Bash', kind: 'bash', paths: [], input: { command: 'echo should I continue?' } }
    expect(checkQuestion(running(), bash, 1)).toEqual({})
    expect(checkQuestion(running(), ask([]), 1)).toEqual({})
    expect(checkQuestion(running(), { ...ask([]), input: null as unknown as Record<string, unknown> }, 1)).toEqual({})
  })
})

describe('questionPause (Codex request_user_input_async) and questionAnswered (the H08 receipt)', () => {
  test('records a decision pause named after the first question, only while an approved plan runs unpaused', () => {
    const call = ask([{ question: 'Use Redis or the in-memory store?', options: ['Redis', 'In-memory'] }], 'codex')
    expect(questionPause(running(), call, 42).interaction).toEqual({ state: 'paused', kind: 'decision', since: 42, reason: 'Use Redis or the in-memory store?' })
    const paused = running({}, { state: 'paused', kind: 'manual', since: 1 })
    expect(questionPause(paused, call, 42)).toBe(paused)
    const planning = running({ phase: 'plan', status: 'PENDING' })
    expect(questionPause(planning, call, 42)).toBe(planning)
    expect(ASYNC_QUESTION_PAUSED).toContain('buracle plan resume')
  })

  test('reads an answer from each harness question tool, and no answer from a cancel or an async acknowledgement', () => {
    expect(questionAnswered({ questions: [], answers: { 'Which framework?': 'React' } })).toBe(true)
    expect(questionAnswered({ answers: {} })).toBe(false)
    expect(questionAnswered('{"answers":{"q0":{"answers":["Redis"]}}}')).toBe(true)
    expect(questionAnswered('{"accepted":true}')).toBe(false)
    expect(questionAnswered({ output: 'User has answered your questions: "Which DB?"="Postgres".', metadata: {} })).toBe(true)
    expect(questionAnswered([{ type: 'text', text: 'User selected: Redis' }])).toBe(true)
    expect(questionAnswered([{ type: 'text', text: 'User cancelled the selection' }])).toBe(false)
  })

  test('questionAnswered: a declined, dismissed or empty answer is no answer (omp 18.10.1 and OpenCode 2.0.30 result strings)', () => {
    expect(questionAnswered([{ type: 'text', text: 'User chose to chat about this instead of answering.\n\nQuestions asked:\nWhich DB?' }])).toBe(false)
    expect(questionAnswered([{ type: 'text', text: 'User did not select any options' }])).toBe(false)
    expect(questionAnswered([{ type: 'text', text: 'User answers:\ndb: (cancelled)\nflags: []' }])).toBe(false)
    expect(questionAnswered([{ type: 'text', text: 'User answers:\ndb: (cancelled)\nflags: [cache, logs]' }])).toBe(true)
    expect(questionAnswered([{ type: 'text', text: 'User answers:\ndb: (cancelled) (note: ask me tomorrow)' }])).toBe(true)
    expect(questionAnswered([{ type: 'text', text: 'User selected: Postgres\nUser added note: keep it small' }])).toBe(true)
    expect(questionAnswered({ output: 'User has answered your questions: "Which DB?"="Unanswered". You can now continue with the user\'s answers in mind.' })).toBe(false)
    expect(questionAnswered({ output: 'User has answered your questions: "Which DB?"="Unanswered", "Which cache?"="Unanswered". You can now continue with the user\'s answers in mind.' })).toBe(false)
    expect(questionAnswered({ output: 'User has answered your questions: "Which DB?"="Unanswered", "Which cache?"="Redis, LRU". You can now continue with the user\'s answers in mind.' })).toBe(true)
    expect(questionAnswered('The user dismissed this question')).toBe(false)
    expect(questionAnswered('Ask tool was cancelled by the user')).toBe(false)
    expect(questionAnswered('')).toBe(false)
    expect(questionAnswered(undefined)).toBe(false)
  })
})
