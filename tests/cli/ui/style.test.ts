import { describe, expect, test } from 'bun:test'
import { banner, ICON, LOGO, LOGO_EYE, makeStyle, paintLogo, stripAnsi, visibleWidth } from '../../../src/cli/ui/style'

const color = makeStyle(3)
const plain = (s: string) => stripAnsi(s).split('\n')
const CYAN = '\u001b[38;2;34;211;238m'
const VIOLET = '\u001b[38;2;139;92;246m'

describe('logo', () => {
  test('the art: six rows of equal width drawn only with blocks, the icon is the first letter, the eye sits inside it', () => {
    expect(LOGO).toHaveLength(6)
    const width = [...LOGO[0]!].length
    for (const row of LOGO) {
      expect([...row]).toHaveLength(width)
      expect(row).toMatch(/^[█▀▄ ]+$/)
    }
    expect(ICON).toEqual(LOGO.map(r => r.slice(0, 8)))
    for (const [r, c] of LOGO_EYE) expect('▀▄').toContain([...ICON[r]!][c]!)
  })

  test('a wide terminal gets the wordmark, then the version, the tagline and the harnesses', () => {
    const lines = plain(banner(color, { version: '0.4.0', columns: 120 }))
    expect(lines.slice(0, 6)).toEqual(LOGO.map(r => `  ${r.trimEnd()}`))
    expect(lines[6]).toBe('  v0.4.0  ·  everything your coding agents need, in one place  ·  Claude Code · Codex · OpenCode · Oh My Pi')
    expect(lines).toHaveLength(7)
  })

  test('the harnesses are left out when they would wrap; every line fits the terminal', () => {
    const lines = plain(banner(color, { version: '0.4.0', columns: 70 }))
    expect(lines[6]).toBe('  v0.4.0  ·  everything your coding agents need, in one place')
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(70)
  })

  test('below the wordmark\'s width the icon stands with the name, the version and the tagline beside it', () => {
    const lines = plain(banner(color, { version: '0.4.0', columns: 50 }))
    expect(lines).toHaveLength(6)
    lines.forEach((l, i) => expect(l.startsWith(`  ${ICON[i]!.trimEnd()}`)).toBe(true))
    expect(lines[2]).toEndWith('   buracle')
    expect(lines[3]).toEndWith('   v0.4.0')
    expect(lines[4]).toEndWith('   everything your coding agents need,')
    expect(lines[5]).toEndWith('   in one place')
    for (const l of lines) expect(visibleWidth(l)).toBeLessThanOrEqual(50)
  })

  test('a very narrow terminal, or one without color, gets one line', () => {
    expect(plain(banner(color, { version: '0.4.0', columns: 40 }))).toEqual(['◉ buracle v0.4.0'])
    expect(banner(makeStyle(0), { version: '0.4.0', columns: 100 })).toBe('◉ buracle v0.4.0 · everything your coding agents need, in one place')
  })

  test('the eye is cyan and nothing else in the icon is; the stem starts violet', () => {
    const rows = paintLogo(color, ICON)
    const cyan = rows.flatMap(r => [...r.matchAll(new RegExp(`${CYAN.replace('[', '\\[')}(.)`, 'gu'))].map(m => m[1]))
    expect(cyan).toEqual(['▄', '▄', '▀', '▀'])
    expect(rows[0]!.startsWith(`${VIOLET}█`)).toBe(true)
    expect(paintLogo(color)[3]!.endsWith(`${CYAN}█\u001b[39m`)).toBe(true)
  })
})
