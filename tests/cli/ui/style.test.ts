import { describe, expect, test } from 'bun:test'
import { ICON, LOGO, LOGO_EYE, makeStyle, paintLogo } from '../../../src/cli/ui/style'

const color = makeStyle(3)
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

  test('the eye is cyan and nothing else in the icon is; the stem starts violet', () => {
    const rows = paintLogo(color, ICON)
    const cyan = rows.flatMap(r => [...r.matchAll(new RegExp(`${CYAN.replace('[', '\\[')}(.)`, 'gu'))].map(m => m[1]))
    expect(cyan).toEqual(['▄', '▄', '▀', '▀'])
    expect(rows[0]!.startsWith(`${VIOLET}█`)).toBe(true)
    expect(paintLogo(color)[3]!.endsWith(`${CYAN}█\u001b[39m`)).toBe(true)
  })
})
