import { describe, expect, test } from 'bun:test'
import { memIsoLocal, memIsSlug, memLocalDate, memLocalTime, memNoteHarness, memParseTime, parseNote } from '../../../src/core/memory/note'

describe('slugs', () => {
  test('only lowercase letters, digits and dashes, never a path', () => {
    expect(memIsSlug('my-app2')).toBe(true)
    for (const bad of ['', '..', 'a/b', 'My-App', '-x', 'a'.repeat(81), 3]) expect(memIsSlug(bad)).toBe(false)
  })
})

describe('parseNote', () => {
  test('splits flat frontmatter and keeps nested metadata blocks', () => {
    const { fm, body } = parseNote('---\ntitle: "Handoff: demo"\nmetadata:\n  type: user\n---\n# Body\r\ntext\n')
    expect(fm['title']).toBe('Handoff: demo')
    expect(fm['metadata']).toEqual({ type: 'user' })
    expect(body).toBe('# Body\ntext\n')
  })

  test('a note without frontmatter parses as an empty map', () => {
    expect(parseNote('just text')).toEqual({ fm: {}, body: 'just text' })
  })
})

describe('time', () => {
  const t = Date.parse('2026-10-07T20:50:00Z')
  test('local ISO strings carry the offset; date and time follow it', () => {
    expect(memIsoLocal(t, 180)).toBe('2026-10-07T23:50:00+03:00')
    expect(memIsoLocal(t, -90)).toBe('2026-10-07T19:20:00-01:30')
    expect(memLocalDate(t, 240)).toBe('2026-10-08')
    expect(memLocalTime(t, 180)).toBe('23:50')
  })

  test('memParseTime reads ISO dates and refuses the rest', () => {
    expect(memParseTime('2026-10-07T20:50:00Z')).toBe(t)
    expect(memParseTime('nope')).toBeUndefined()
    expect(memParseTime(5)).toBeUndefined()
  })

  test('claude is claude-code at note level; the others keep their ids', () => {
    expect(memNoteHarness('claude')).toBe('claude-code')
    expect(memNoteHarness('codex')).toBe('codex')
  })
})
