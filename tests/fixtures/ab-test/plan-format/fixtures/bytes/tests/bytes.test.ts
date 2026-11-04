import { expect, test } from 'bun:test'
import { formatBytes } from '../src/bytes'

test('formats sizes with one decimal and binary units', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(999)).toBe('999 B')
  expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(1048576)).toBe('1.0 MB')
  expect(formatBytes(5368709120)).toBe('5.0 GB')
})

test('a negative size is an error', () => {
  expect(() => formatBytes(-1)).toThrow('negative size')
})
