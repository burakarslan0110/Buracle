import { describe, expect, test } from 'bun:test'
import { PACE_BAND, WINDOW_MINUTES, pace, windowLabel } from '../../../src/core/status/model'

describe('windowLabel', () => {
  test('known windows within ±5%', () => {
    expect(windowLabel(300)).toBe('5h')
    expect(windowLabel(285)).toBe('5h')
    expect(windowLabel(315)).toBe('5h')
    expect(windowLabel(1440)).toBe('1d')
    expect(windowLabel(10080)).toBe('7d')
    expect(windowLabel(10500)).toBe('7d')
    expect(windowLabel(43200)).toBe('30d')
    expect(windowLabel(44640)).toBe('30d')
    expect(windowLabel(525600)).toBe('365d')
    for (const [label, minutes] of Object.entries(WINDOW_MINUTES)) expect(windowLabel(minutes)).toBe(label)
  })

  test('outside the bands: a compact duration that never collides with a band label', () => {
    expect(windowLabel(284)).toBe('284m')
    expect(windowLabel(316)).toBe('316m')
    expect(windowLabel(45)).toBe('45m')
    expect(windowLabel(60)).toBe('1h')
    expect(windowLabel(120)).toBe('2h')
    expect(windowLabel(1500)).toBe('1d')
    expect(windowLabel(1560)).toBe('26h')
    expect(windowLabel(2000)).toBe('33h')
    expect(windowLabel(2880)).toBe('2d')
    expect(windowLabel(20160)).toBe('14d')
  })

  test('invalid input', () => {
    expect(windowLabel(0)).toBe('?')
    expect(windowLabel(-5)).toBe('?')
    expect(windowLabel(Number.NaN)).toBe('?')
  })
})

describe('pace', () => {
  const now = Date.parse('2026-10-08T09:00:00.000Z')
  const resetIn = (minutes: number) => new Date(now + minutes * 60_000).toISOString()

  test('usage against elapsed share of the window, with a ±5 point band', () => {
    expect(pace(50, resetIn(150), 300, now)).toBe('even')
    expect(pace(50 + PACE_BAND, resetIn(150), 300, now)).toBe('even')
    expect(pace(55.1, resetIn(150), 300, now)).toBe('over')
    expect(pace(44.9, resetIn(150), 300, now)).toBe('under')
    expect(pace(42, resetIn(210), 300, now)).toBe('over')
    expect(pace(18, resetIn(5040), 10080, now)).toBe('under')
  })

  test('elapsed is clamped to the window', () => {
    expect(pace(6, resetIn(400), 300, now)).toBe('over')
    expect(pace(95, resetIn(-10), 300, now)).toBe('even')
    expect(pace(80, resetIn(-10), 300, now)).toBe('under')
  })

  test('unknown or invalid inputs are even', () => {
    expect(pace(90, undefined, 300, now)).toBe('even')
    expect(pace(90, 'not a date', 300, now)).toBe('even')
    expect(pace(90, resetIn(10), 0, now)).toBe('even')
    expect(pace(Number.NaN, resetIn(10), 300, now)).toBe('even')
  })
})
