import { describe, expect, test } from 'bun:test'
import { claudeVersionGate } from '../../helpers/claude-version'

describe('claude version gate of the real-binary checks', () => {
  const gate = (text: string) => claudeVersionGate(text, '2.1.290')

  test('the minimum runs without a note', () => {
    expect(gate('2.1.290 (Claude Code)')).toEqual({ runs: true, version: '2.1.290' })
  })

  test('every newer release runs without a note, also in another major', () => {
    expect(gate('2.1.301 (Claude Code)')).toEqual({ runs: true, version: '2.1.301' })
    expect(gate('2.4.0 (Claude Code)')).toEqual({ runs: true, version: '2.4.0' })
    expect(gate('3.0.0 (Claude Code)')).toEqual({ runs: true, version: '3.0.0' })
  })

  test('an older release or unreadable output skips with the reason', () => {
    expect(gate('2.1.289 (Claude Code)')).toMatchObject({ runs: false, note: expect.stringContaining('older than the supported minimum 2.1.290') })
    expect(gate('')).toMatchObject({ runs: false, version: '' })
  })
})
