import { describe, expect, test } from 'bun:test'
import { ICON, LOGO, LOGO_EYE, makeStyle, paintLogo } from '../../../src/cli/ui/style'

const color = makeStyle(3)
const EYE = '\u001b[38;2;217;119;6m'
const BRAND = '\u001b[38;2;139;92;246m'
const BRAND_END = '\u001b[38;2;217;70;239m'

describe('logo', () => {
  test('the art: six rows of 51 columns drawn only with blocks; the icon is the first letter, 8 by 6, with the eye in its bowl', () => {
    expect(LOGO).toHaveLength(6)
    for (const row of LOGO) {
      expect([...row]).toHaveLength(51)
      expect(row).toMatch(/^[█▀▄ ]+$/)
    }
    expect(ICON).toEqual(LOGO.map(r => r.slice(0, 8)))
    expect(ICON).toHaveLength(6)
    expect(LOGO_EYE.map(c => [...c])).toEqual([[3, 3], [3, 4], [4, 3], [4, 4]])
    for (const [r, c] of LOGO_EYE) expect([...ICON[r]!][c]).toBe('█')
  })

  test('the eye is amber and nothing else in the icon is; the stem starts violet and the last letter ends fuchsia', () => {
    const rows = paintLogo(color, ICON)
    const eye = rows.flatMap(r => [...r.matchAll(new RegExp(`${EYE.replace('[', '\\[')}(.)`, 'gu'))].map(m => m[1]))
    expect(eye).toEqual(['█', '█', '█', '█'])
    expect(rows[0]!.startsWith(`${BRAND}█`)).toBe(true)
    expect(paintLogo(color)[3]!.endsWith(`${BRAND_END}█\u001b[39m`)).toBe(true)
  })
})
