// OpenCode's `todowrite` tool (behind `experimental.todo`) replaces the whole list on every call:
// `{ todos: [{ content, status: pending | in_progress | completed | cancelled }] }`.
export const OPENCODE_TODO_TOOL = 'todowrite'

const OPEN = new Set(['pending', 'in_progress'])

/** The open items of a todowrite call's input, in order; undefined when the input is not a todo list. */
export function openTodosOf(input: unknown): string[] | undefined {
  const list = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>)['todos'] : undefined
  if (!Array.isArray(list)) return undefined
  const out: string[] = []
  for (const t of list) {
    if (t === null || typeof t !== 'object') continue
    const { content, status } = t as Record<string, unknown>
    if (typeof content === 'string' && content.trim() !== '' && typeof status === 'string' && OPEN.has(status)) out.push(content.trim())
  }
  return out
}
