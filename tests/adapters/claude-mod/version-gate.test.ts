import { describe, expect, test } from 'bun:test'
import { claudeVersionGate } from '../../helpers/claude-version'

describe('claude version gate of the real-binary checks', () => {
  const gate = (text: string) => claudeVersionGate(text, '2.1.296', '2.1.290')

  test('the tested version runs without a note', () => {
    expect(gate('2.1.296 (Claude Code)')).toEqual({ runs: true, version: '2.1.296' })
  })

  test('a release between the minimum and the tested one runs', () => {
    expect(gate('2.1.290 (Claude Code)')).toEqual({ runs: true, version: '2.1.290' })
  })

  test('a newer release in the same major runs and carries a note', () => {
    const g = gate('2.1.301 (Claude Code)')
    expect(g.runs).toBe(true)
    expect(g.note).toContain('newer than the tested 2.1.296')
    expect(gate('2.4.0 (Claude Code)').runs).toBe(true)
  })

  test('an older release, another major or unreadable output skips with the reason', () => {
    expect(gate('2.1.289 (Claude Code)')).toMatchObject({ runs: false, note: expect.stringContaining('older than the supported minimum') })
    expect(gate('3.0.0 (Claude Code)')).toMatchObject({ runs: false, note: expect.stringContaining('outside the tested major') })
    expect(gate('')).toMatchObject({ runs: false, version: '' })
  })
})
