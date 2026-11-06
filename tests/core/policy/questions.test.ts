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

// H09 reads no question wording: every question passes, and while an approved plan runs unpaused it
// carries the reminder to pause first. Whether a question is routine is the agent's call (its rules).
const QUESTIONS: Array<[string, string[]]> = [
  ['Should I continue?', []],
  ['Should I keep waiting for the build?', ['Keep waiting', 'Stop']],
  ['Devam edeyim mi?', ['Evet', 'Hayır']],
  ['Soll ich weitermachen?', ['Ja', 'Nein']],
  ['Which approach should I take?', ['Fixed window (recommended)', 'Sliding window']],
  ['Should I proceed with deleting the old table?', ['Yes', 'No']],
  ['Do you approve the plan?', ['Approve', 'Request changes']],
]

describe('checkQuestion: running approved plan', () => {
  for (const [question, options] of QUESTIONS) {
    test(`never denies, and adds the pause reminder: ${question}`, () => {
      expect(checkQuestion(running(), ask([{ question, options }]), 10)).toEqual({ context: QUESTION_PAUSE_NOTE })
    })
  }

  test('a batch of questions passes with one reminder, on every harness question tool', () => {
    const batch = ask([{ question: 'Should I continue?', options: ['Yes', 'No'] }, { question: 'Which database?', options: ['Postgres', 'SQLite'] }])
    expect(checkQuestion(running(), batch, 10)).toEqual({ context: QUESTION_PAUSE_NOTE })
    for (const h of ['claude', 'codex', 'opencode', 'omp'] as const) {
      expect(checkQuestion(running(), ask([{ question: 'Should I continue?' }], h), 10)).toEqual({ context: QUESTION_PAUSE_NOTE })
    }
  })

  test('omp string options and a single-question shape are understood', () => {
    const call: ToolCall = { harness: 'omp', sessionId: 's', cwd: '/r', tool: 'ask', kind: 'ask_user', paths: [], input: { question: 'Devam edeyim mi?', options: ['Evet', 'Hayır'] } }
    expect(checkQuestion(running(), call, 1)).toEqual({ context: QUESTION_PAUSE_NOTE })
  })
})

describe('checkQuestion: when there is nothing to add', () => {
  const q = ask([{ question: 'Should I keep waiting?', options: ['Keep waiting', 'Stop'] }])

  test('a paused plan of any kind: the pause already holds the run', () => {
    for (const kind of ['decision', 'discussion', 'manual'] as const) expect(checkQuestion(running({}, { state: 'paused', kind, since: 1 }), q, 10)).toEqual({})
    expect(checkQuestion(running({}, { state: 'paused', since: 1 }), q, 10)).toEqual({})
    expect(checkQuestion(running({}, { state: 'running', since: 1 }), q, 10)).toEqual({ context: QUESTION_PAUSE_NOTE })
  })

  test('no plan, or a plan that is neither approved and running nor being verified', () => {
    expect(checkQuestion(emptyState(), q, 10)).toEqual({})
    for (const status of ['PENDING', 'VERIFIED', 'SAVED'] as const) expect(checkQuestion(running({ status }), q, 10)).toEqual({})
    for (const status of ['APPROVED', 'COMPLETE'] as const) expect(checkQuestion(running({ status }), q, 10)).toEqual({ context: QUESTION_PAUSE_NOTE })
  })

  test('phase plan or done', () => {
    expect(checkQuestion(running({ phase: 'plan' }), q, 10)).toEqual({})
    expect(checkQuestion(running({ phase: 'done' }), q, 10)).toEqual({})
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
