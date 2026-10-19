import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGO, LOGO_EYE } from '../../src/cli/ui/style'

const UI_DIR = join(import.meta.dir, '../../src/memory/ui')
const BRAND_DIR = join(import.meta.dir, '../../assets')

interface Paths { body: string, eye: string, width: number, height: number }
interface LogoModule {
  LOGO: string[]
  EYE: number[][]
  MARK: string[]
  pixelPaths(rows: string[], opts?: { dx?: number, dy?: number, scale?: number }): Paths
  markTile(): string
  WORDMARK_THEMES: Record<string, { from: string, to: string, eye: string }>
  wordmarkSvg(theme: string): string
}

const logo = await import(join(UI_DIR, 'logo.js')) as LogoModule

function area(d: string): number {
  return [...d.matchAll(/h(\d+)v(\d+)h-/g)].reduce((n, m) => n + Number(m[1]) * Number(m[2]), 0)
}

describe('web logo', () => {
  test('the page draws the same art and eye as the terminal', () => {
    expect(logo.LOGO).toEqual([...LOGO])
    expect(logo.EYE).toEqual(LOGO_EYE.map(c => [...c]))
    expect(logo.MARK).toEqual(LOGO.map(r => r.slice(0, 8)))
  })

  test('the pixel paths cover every lit half block once: a full block is two pixels, a half block one; the eye is four', () => {
    const lit = LOGO.join('').split('').reduce((n, ch) => n + (ch === '█' ? 2 : ch === '▀' || ch === '▄' ? 1 : 0), 0)
    const p = logo.pixelPaths(logo.LOGO)
    expect(area(p.eye)).toBe(4)
    expect(area(p.body) + area(p.eye)).toBe(lit)
    expect([p.width, p.height]).toEqual([[...LOGO[0]!].length, LOGO.length * 2])
    const scaled = logo.pixelPaths(logo.LOGO, { scale: 2 })
    expect(area(scaled.body) + area(scaled.eye)).toBe(lit * 4)
  })

  test('favicon.svg is the mark on its tile, as markTile() makes it', () => {
    const svg = readFileSync(join(UI_DIR, 'favicon.svg'), 'utf8')
    expect(svg).toBe(logo.markTile())
    expect(svg).toContain('viewBox="0 0 32 32"')
    const xs = [...svg.matchAll(/M(\d+) (\d+)h(\d+)/g)].flatMap(m => [Number(m[1]), Number(m[1]) + Number(m[3])])
    const ys = [...svg.matchAll(/M\d+ (\d+)h\d+v(\d+)/g)].flatMap(m => [Number(m[1]), Number(m[1]) + Number(m[2])])
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([8, 24, 4, 28])
  })

  test('the README\'s wordmark images are wordmarkSvg() for a dark and a light page, with the whole art in them', () => {
    expect(Object.keys(logo.WORDMARK_THEMES).sort()).toEqual(['dark', 'light'])
    const lit = LOGO.join('').split('').reduce((n, ch) => n + (ch === '█' ? 2 : ch === '▀' || ch === '▄' ? 1 : 0), 0)
    for (const theme of ['dark', 'light']) {
      const svg = readFileSync(join(BRAND_DIR, `buracle-${theme}.svg`), 'utf8')
      expect(svg).toBe(logo.wordmarkSvg(theme))
      expect(area(svg)).toBe(lit)
      const colors = logo.WORDMARK_THEMES[theme]
      for (const c of [colors?.from, colors?.to, colors?.eye]) expect(svg).toContain(`"${c}"`)
    }
  })
})
