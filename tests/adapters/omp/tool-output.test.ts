import { describe, expect, test } from 'bun:test'
import { ompTodos, openTodosOf } from '../../../src/adapters/omp/runtime/tool-output'

const LIST = 'Remaining items (2):\n  - Write the tests [in_progress] (Build)\n  - Ship it [pending] (Release)\nOverall: 1/3 done, 2 open.'

function todoResult(text: string, over: Partial<Parameters<typeof openTodosOf>[0]> = {}): Parameters<typeof openTodosOf>[0] {
  return { toolName: 'todo', input: { op: 'update' }, isError: false, content: [{ type: 'text', text }], ...over }
}

describe('omp todo output: the checklist the `todo` tool prints', () => {
  test('ompTodos reads the items after the Remaining items line, with their status, and stops at the summary line', () => {
    expect(ompTodos(LIST)).toEqual([{ content: 'Write the tests', status: 'in_progress' }, { content: 'Ship it', status: 'pending' }])
    expect(ompTodos('Remaining items (1):\n  - Fix the build [completed]\n')).toEqual([{ content: 'Fix the build', status: 'completed' }])
  })

  test('ompTodos: "none" is an empty list; text without the list is undefined', () => {
    expect(ompTodos('Remaining items: none.\nOverall: 3/3 done, 0 open.')).toEqual([])
    expect(ompTodos('Todo list is empty.')).toBeUndefined()
    expect(ompTodos('')).toBeUndefined()
  })

  test('openTodosOf keeps the open items of a todo result as text, in order, without the done ones', () => {
    const text = 'Remaining items (4):\n  - Write the tests [in_progress]\n  - Old item [completed]\n  - Dropped [abandoned] (scope)\n  - Ship it [pending]\n'
    expect(openTodosOf(todoResult(text))).toEqual(['Write the tests', 'Ship it'])
    expect(openTodosOf(todoResult('Remaining items: none.'))).toEqual([])
  })

  test('openTodosOf answers undefined for other tools, failed calls and results without the list', () => {
    expect(openTodosOf(todoResult(LIST, { toolName: 'bash' }))).toBeUndefined()
    expect(openTodosOf(todoResult(LIST, { isError: true }))).toBeUndefined()
    expect(openTodosOf(todoResult('Todo list is empty.'))).toBeUndefined()
    expect(openTodosOf({ toolName: 'todo', input: {}, isError: false, content: [] })).toBeUndefined()
  })

  test('openTodosOf joins the text blocks, masks secrets, clips an item to 200 characters and keeps at most 30 items', () => {
    const key = 'AKIAIOSFODNN7EXAMPLE'
    const long = 'x'.repeat(260)
    const many = Array.from({ length: 35 }, (_, i) => `  - Item ${i + 1} [pending]`).join('\n')
    const got = openTodosOf({
      toolName: 'todo', input: {}, isError: false,
      content: [{ type: 'text', text: 'Remaining items (37):' }, { type: 'text', text: `  - Rotate ${key} now [pending]\n  - ${long} [pending]\n${many}` }],
    })
    expect(got).toHaveLength(30)
    expect(got?.[0]).not.toContain(key)
    expect(got?.[0]).toStartWith('Rotate ')
    expect(got?.[1]).toHaveLength(200)
    expect(got?.[1]).toEndWith('…')
    expect(got?.[2]).toBe('Item 1')
    expect(got?.[29]).toBe('Item 28')
  })
})
