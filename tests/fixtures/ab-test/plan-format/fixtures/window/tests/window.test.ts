import { expect, test } from 'bun:test'
import { FixedWindow } from '../src/window'

test('allows limit hits per key per window and refuses the next one', () => {
  const w = new FixedWindow(3, 1000)
  expect([w.hit('a', 0), w.hit('a', 10), w.hit('a', 20)]).toEqual([true, true, true])
  expect(w.hit('a', 30)).toBe(false)
  expect(w.hit('b', 30)).toBe(true)
  expect(w.hit('a', 1000)).toBe(true)
})

test('a limit of zero or less is an error', () => {
  expect(() => new FixedWindow(0, 1000)).toThrow('limit must be positive')
})
