import { expect, test } from 'bun:test'
import { parseDuration } from '../src/duration'

test('reads hours, minutes and seconds into seconds', () => {
  expect(parseDuration('1h30m')).toBe(5400)
  expect(parseDuration('45s')).toBe(45)
  expect(parseDuration('2h')).toBe(7200)
  expect(parseDuration('1h1m1s')).toBe(3661)
})

test('anything else is an error', () => {
  for (const bad of ['', '10', '1x', 'h1', '1h30']) expect(() => parseDuration(bad)).toThrow('invalid duration')
})
