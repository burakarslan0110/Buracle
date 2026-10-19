import { describe, expect, test } from 'bun:test'
import { formatBytes, formatPct, formatResetIn, formatTokens, formatUsd, gauge, sanitizeText, stripEmoji, textWidth, truncateToWidth } from '../../../src/core/status/format'

describe('textWidth', () => {
  test('ASCII, Turkish letters and box drawing count one column', () => {
    expect(textWidth('ctx 37%')).toBe(7)
    expect(textWidth('ığüşöçİĞÜŞÖÇ')).toBe(12)
    expect(textWidth('⎇ main ↑2 ✚3 …1 ⚑2 │ ▓▓░░ ⇡ ↺')).toBe(29)
  })

  test('emoji presentation and wide characters count two, joiners and marks zero', () => {
    expect(textWidth('🧠')).toBe(2)
    expect(textWidth('🧠 mem')).toBe(6)
    expect(textWidth('⚠')).toBe(1)
    expect(textWidth('⚠️')).toBe(2)
    expect(textWidth('漢字')).toBe(4)
    expect(textWidth('é')).toBe(1)
    expect(textWidth('👩‍💻')).toBe(4)
    expect(textWidth('a\u001b[31mb')).toBe(6)
  })
})

describe('truncateToWidth', () => {
  test('cuts by columns and ends with an ellipsis', () => {
    expect(truncateToWidth('spec/very-long-branch-name', 10)).toBe('spec/very…')
    expect(truncateToWidth('short', 10)).toBe('short')
    expect(truncateToWidth('🧠🧠🧠', 5)).toBe('🧠🧠…')
    expect(truncateToWidth('abc', 1)).toBe('…')
    expect(truncateToWidth('abc', 0)).toBe('')
    expect(truncateToWidth('ab cd ef', 4)).toBe('ab…')
  })
})

describe('numbers', () => {
  test('formatTokens', () => {
    expect([0, 950, 1000, 1234, 12_345, 370_000, 999_499, 999_500, 1_000_000, 1_234_567, 9_949_999, 38_000_000, 999_000_000, 2_500_000_000]
      .map(formatTokens)).toEqual(['0', '950', '1k', '1.2k', '12k', '370k', '999k', '1M', '1M', '1.2M', '9.9M', '38M', '999M', '2.5B'])
    expect(formatTokens(Number.NaN)).toBe('?')
    expect(formatTokens(-5)).toBe('0')
  })

  test('formatBytes: binary units (1 KB = 1024 B), one decimal below 10, at most three digits', () => {
    const KB = 1024
    const MB = 1024 * KB
    const GB = 1024 * MB
    expect([0, 1, 950, 999, 1000, 1024, 1229, 10 * KB, 38 * KB, 999 * KB, 1000 * KB, 1.2 * MB, 9.94 * MB, 9.96 * MB, 120 * MB, 2.5 * GB, 999 * GB, 5000 * GB].map(formatBytes))
      .toEqual(['0 B', '1 B', '950 B', '999 B', '1 KB', '1 KB', '1.2 KB', '10 KB', '38 KB', '999 KB', '1 MB', '1.2 MB', '9.9 MB', '10 MB', '120 MB', '2.5 GB', '999 GB', '4.9 TB'])
    expect(formatBytes(2 * MB)).toBe('2 MB')
    expect([formatBytes(Number.NaN), formatBytes(Number.POSITIVE_INFINITY), formatBytes(-5)]).toEqual(['?', '?', '0 B'])
  })

  test('formatUsd', () => {
    expect([0, 0.004, 0.42, 4.2, 12.345, 99.994, 100, 212.4, 1234.5].map(formatUsd)).toEqual(['$0.00', '$0.00', '$0.42', '$4.20', '$12.35', '$99.99', '$100', '$212', '$1235'])
  })

  test('formatPct and gauge', () => {
    expect(formatPct(36.6)).toBe('37')
    expect(formatPct(104.4)).toBe('104')
    expect(formatPct(-1)).toBe('0')
    expect(gauge(0)).toBe('░░░░░░')
    expect(gauge(37)).toBe('▓▓░░░░')
    expect(gauge(50)).toBe('▓▓▓░░░')
    expect(gauge(100)).toBe('▓▓▓▓▓▓')
    expect(gauge(250)).toBe('▓▓▓▓▓▓')
  })
})

describe('formatResetIn (English units)', () => {
  const now = Date.parse('2026-10-08T09:00:00.000Z')
  test('below a day: m / h', () => {
    expect(formatResetIn(now + 45 * 60_000, now)).toBe('45m')
    expect(formatResetIn(now + 30_000, now)).toBe('1m')
    expect(formatResetIn(now + 80 * 60_000, now)).toBe('1h20m')
    expect(formatResetIn(now + 3 * 3600_000, now)).toBe('3h')
    expect(formatResetIn(now + (23 * 60 + 59) * 60_000, now)).toBe('23h59m')
    expect(formatResetIn(now - 1, now)).toBe('0m')
  })

  test('below a week: local weekday and time; beyond: month and day', () => {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    const in3d = now + 3 * 86_400_000 + 17 * 60_000
    const d = new Date(in3d)
    expect(formatResetIn(in3d, now)).toBe(`${days[d.getDay()]} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`)
    const in20d = now + 20 * 86_400_000
    const e = new Date(in20d)
    expect(formatResetIn(in20d, now)).toBe(`${months[e.getMonth()]} ${e.getDate()}`)
    for (let i = 0; i < 400; i += 13) expect(formatResetIn(now + i * 86_400_000 / 4, now)).toMatch(/^[\x20-\x7e]+$/)
  })
})

describe('text hygiene', () => {
  test('sanitizeText replaces control characters', () => {
    expect(sanitizeText('ok\u001b[31mred\u0007\n')).toBe('ok [31mred  ')
  })
  test('stripEmoji removes emoji but keeps status symbols', () => {
    expect(stripEmoji('🧠 buracle 142+37g · idx ✓ · git 6✎')).toBe('buracle 142+37g · idx ✓ · git 6✎')
    expect(stripEmoji('⚠ inbox_high ⬆2 ⎇ main')).toBe('⚠ inbox_high ⬆2 ⎇ main')
    expect(stripEmoji('👩‍💻 dev ⚠️ x')).toBe('dev x')
  })
})
