import { describe, expect, test } from 'bun:test'
import { clean, commandHeader, footerLine, headerHeight, headerKind, headerLines, sectionHeading, statusLine, type Summary } from '../../../src/cli/ui/frame'
import { ICON, LOGO, makeStyle, stripAnsi, visibleWidth, type Style } from '../../../src/cli/ui/style'

const color = makeStyle(3, { unicode: true })
const plain = makeStyle(0, { unicode: false })
const ALL_GOOD: Summary = { updates: 0, problems: 0 }
const head = (st: Style, columns: number, rows: number, summary: Summary = ALL_GOOD): string[] =>
  headerLines(st, { version: '0.8.0', columns, rows, summary }).map(stripAnsi)
const TITLE = '  ◉ buracle v0.8.0 · One engineering setup, one memory, every coding agent'
const STATUS = '  ✔ All good · no update check yet'

describe('header sizes', () => {
  test('the size depends only on the terminal size and the color level', () => {
    expect(headerKind(55, 20, 3)).toBe('logo')
    expect(headerKind(120, 40, 1)).toBe('logo')
    expect(headerKind(54, 20, 3)).toBe('icon')
    expect(headerKind(43, 20, 2)).toBe('icon')
    expect(headerKind(42, 24, 3)).toBe('wordmark')
    expect(headerKind(55, 19, 3)).toBe('wordmark')
    expect(headerKind(40, 10, 3)).toBe('wordmark')
    expect(headerKind(120, 40, 0)).toBe('wordmark')
  })

  test('the full logo at 55 by 20 and up: the logo rows, the version with the tagline when it fits, then the status', () => {
    expect(head(color, 55, 20)).toEqual(['', ...LOGO.map(l => `  ${l}`.trimEnd()), '  v0.8.0', '', STATUS, ''])
    expect(head(color, 80, 24)).toEqual(['', ...LOGO.map(l => `  ${l}`.trimEnd()), '  v0.8.0  ·  One engineering setup, one memory, every coding agent', '', STATUS, ''])
    expect(head(color, 120, 40)[7]).toBe('  v0.8.0  ·  One engineering setup, one memory, every coding agent  ·  Claude Code · Codex · OpenCode · Oh My Pi')
  })

  test('the icon with the name, the version and the tagline beside it at 43 to 54 columns', () => {
    for (const columns of [43, 50, 54]) {
      const raw = headerLines(color, { version: '0.8.0', columns, rows: 20, summary: ALL_GOOD })
      const lines = raw.map(stripAnsi)
      expect(lines).toHaveLength(10)
      expect(lines.slice(1, 7).map(l => l.slice(0, 10).trimEnd())).toEqual(ICON.map(l => `  ${l}`.trimEnd()))
      expect(lines[3]?.slice(13)).toBe('buracle')
      expect(lines[4]?.slice(13)).toBe('v0.8.0')
      expect(lines.slice(5, 7).map(l => l.slice(13)).join(' ').trim()).toBe('One engineering setup, one memory, every coding agent')
      expect(lines.slice(7)).toEqual(['', STATUS, ''])
      for (const l of raw) expect(visibleWidth(l)).toBeLessThanOrEqual(columns - 1)
    }
  })

  test('the one-line wordmark below 20 rows or 43 columns, with fewer empty lines in a low window', () => {
    expect(head(color, 80, 19)).toEqual(['', TITLE, '', STATUS, ''])
    expect(head(color, 80, 16)).toEqual(['', TITLE, '', STATUS, ''])
    expect(head(color, 80, 15)).toEqual([TITLE, STATUS, ''])
    expect(head(color, 80, 12)).toEqual([TITLE, STATUS, ''])
    expect(head(color, 80, 11)).toEqual([TITLE, STATUS])
    expect(head(color, 42, 24)).toEqual(['', '  ◉ buracle v0.8.0', '', STATUS, ''])
    expect(head(color, 40, 10)).toEqual(['  ◉ buracle v0.8.0', STATUS])
  })

  test('at color level 0 the header is the wordmark line with no escape code, no Unicode symbol and no block', () => {
    for (const [columns, rows] of [[120, 40], [55, 20], [50, 20], [40, 10]] as const) {
      const out = headerLines(plain, { version: '0.8.0', columns, rows, summary: { updates: 1, problems: 2 } }).join('\n')
      expect(out).not.toContain('\u001b')
      for (const sym of ['✔', '▲', '✖', 'ℹ', '◉', '█', '▀', '▄']) expect(out).not.toContain(sym)
      expect(out).toContain('buracle v0.8.0')
    }
    expect(head(plain, 120, 40, { updates: 1, problems: 2 })).toEqual(['', '  buracle v0.8.0 · One engineering setup, one memory, every coding agent', '', '  ! 1 update waiting · 2 problems · no update check yet', ''])
  })

  test('headerHeight, which key handling uses without a style, equals the lines headerLines gives at every size and level', () => {
    for (const level of [0, 1, 2, 3] as const) {
      for (const columns of [40, 42, 43, 50, 54, 55, 62, 63, 80, 120]) {
        for (const rows of [10, 11, 12, 15, 16, 19, 20, 24, 40]) {
          const st = makeStyle(level, { unicode: level > 0 })
          expect({ columns, rows, level, n: headerLines(st, { version: '0.8.0', columns, rows, summary: ALL_GOOD }).length })
            .toEqual({ columns, rows, level, n: headerHeight(columns, rows, level) })
        }
      }
    }
  })

  test('every header line fits the width at every size from 40 by 10, and external text is sanitized', () => {
    const odd: Summary = { updates: 12, problems: 3, checkedAt: '48\u001b]0;owned\u0007 min ago', working: 'verifying\u001b[2J 3 parts' }
    for (const st of [plain, makeStyle(1), makeStyle(2), color]) {
      for (const [columns, rows] of [[40, 10], [42, 18], [43, 20], [50, 12], [54, 20], [55, 20], [62, 20], [63, 20], [80, 24], [100, 30], [120, 40]] as const) {
        const lines = headerLines(st, { version: '0.8.0\u001b[2J', columns, rows, summary: odd })
        for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(columns - 1)
        expect(lines.join('\n').replace(/\u001b\[[0-9;]*m/g, '')).not.toContain('\u001b')
      }
    }
  })
})

describe('status line', () => {
  const status = (summary: Summary, width = 79) => stripAnsi(statusLine(plain, summary, width))
  test('all good, the counts that wait, and when updates were last checked', () => {
    expect(status(ALL_GOOD)).toBe('  + All good · no update check yet')
    expect(status({ updates: 0, problems: 0, checkedAt: '5 min ago' })).toBe('  + All good · updates checked 5 min ago')
    expect(status({ updates: 1, problems: 0, checkedAt: 'just now' })).toBe('  i 1 update waiting · updates checked just now')
    expect(status({ updates: 2, problems: 1 })).toBe('  ! 2 updates waiting · 1 problem · no update check yet')
    expect(status({ updates: 0, problems: 3 })).toBe('  ! 3 problems · no update check yet')
  })

  test('what is being verified right now takes the place of the time of the last check', () => {
    expect(status({ updates: 0, problems: 0, checkedAt: '5 min ago', working: 'verifying 3 parts · checking for updates' })).toBe('  + All good · verifying 3 parts · checking for updates')
    expect(status({ updates: 1, problems: 0, working: 'checking for updates' })).toBe('  i 1 update waiting · checking for updates')
  })

  test('the time of the check goes first when the line is too narrow', () => {
    expect(status({ updates: 2, problems: 1, checkedAt: '5 min ago' }, 39)).toBe('  ! 2 updates waiting · 1 problem')
  })
})

describe('key-hint footer', () => {
  const hints = [{ key: '↑↓', word: 'move', drop: 2 }, { key: 'enter', word: 'choose' }, { key: 'o', word: 'full output', drop: 1 }, { key: 'q', word: 'quit' }]
  test('key and word pairs joined by a middle dot, at the shared margin', () => {
    expect(stripAnsi(footerLine(color, hints, 79))).toBe('  ↑↓ move · enter choose · o full output · q quit')
  })

  test('hints drop in their order until the line fits, and the line never gets wider than the width', () => {
    expect(stripAnsi(footerLine(color, hints, 34))).toBe('  ↑↓ move · enter choose · q quit')
    expect(stripAnsi(footerLine(color, hints, 26))).toBe('  enter choose · q quit')
    for (const w of [1, 5, 10, 20, 40]) expect(visibleWidth(footerLine(color, hints, w))).toBeLessThanOrEqual(w)
  })
})

describe('command output', () => {
  test('one header line: the wordmark, the version and the command name', () => {
    expect(stripAnsi(commandHeader(color, '0.8.0', 'doctor'))).toBe('  ◉ buracle v0.8.0 · doctor')
    expect(commandHeader(plain, '0.8.0', 'install preview')).toBe('  buracle v0.8.0 · install preview')
    expect(commandHeader(plain, '0.8.0\u001b[2J', 'x')).not.toContain('\u001b')
  })

  test('a section heading starts at the shared margin and fits the width, at most 72 columns', () => {
    expect(stripAnsi(sectionHeading(color, 'Harnesses', 79))).toBe(`  ── Harnesses ${'─'.repeat(72 - 2 - 2 - 1 - 9 - 1)}`)
    expect(sectionHeading(plain, 'Result', 39)).toBe(`  -- Result ${'-'.repeat(39 - 2 - 2 - 1 - 6 - 1)}`)
    for (const w of [8, 20, 39, 72, 120]) expect(visibleWidth(sectionHeading(color, 'MCP servers', w))).toBeLessThanOrEqual(Math.min(w, 72))
  })
})

describe('clean', () => {
  test('control characters, escape sequences and bidi controls never pass; surrounding space goes', () => {
    expect(clean(undefined)).toBe('')
    const out = clean('  a\u001b[2Jb\u202ec  ')
    expect(out).not.toMatch(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/)
    expect(out.startsWith('a') && out.endsWith('bc')).toBe(true)
    expect(clean('İstanbul ılık')).toBe('İstanbul ılık')
  })
})
