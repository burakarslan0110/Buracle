import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ANSI16, PALETTE, TAGLINE } from '../../../src/cli/ui/style'

const ROOT = join(import.meta.dir, '../../..')

// The brand values come from the 1.0 brand guide; every surface (terminal, install script, web UI, README) is held to
// them here, so a change to one copy without the others fails.
const rgb = (h: string) => ({ r: Number.parseInt(h.slice(1, 3), 16), g: Number.parseInt(h.slice(3, 5), 16), b: Number.parseInt(h.slice(5, 7), 16) })

describe('brand palette', () => {
  test('the terminal palette holds the three brand roles', () => {
    expect(PALETTE.brand).toEqual(rgb('#8B5CF6'))
    expect(PALETTE.brandEnd).toEqual(rgb('#D946EF'))
    expect(PALETTE.eye).toEqual(rgb('#D97706'))
  })

  test('each brand role has its 16-color code: magenta, bright magenta, yellow', () => {
    expect(ANSI16).toEqual({ brand: 35, brandEnd: 95, eye: 33 })
  })

  test('the old roles are gone', () => {
    for (const old of ['violet', 'indigo', 'sky', 'cyan', 'white']) expect(Object.keys(PALETTE)).not.toContain(old)
  })
})

// The web UI's brand: one value per token and theme. A theme block is the text from its selector to its closing brace.
const BRAND_TOKENS = {
  dark: { '--accent': '#c4b5fd', '--accent-rgb': '196, 181, 253', '--focus': '#c4b5fd', '--brand-from': '#a78bfa', '--brand-to': '#e879f9', '--brand-eye': '#fbbf24', '--brand-eye-person': '#fda4af' },
  light: { '--accent': '#6d28d9', '--accent-rgb': '109, 40, 217', '--focus': '#6d28d9', '--brand-from': '#6d28d9', '--brand-to': '#a21caf', '--brand-eye': '#b45309', '--brand-eye-person': '#e11d48' },
} as const

function tokenBlocks(css: string): Record<'dark' | 'light', Map<string, string>> {
  const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  const read = (body: string) => new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(m => [m[1]!, m[2]!.trim()]))
  const dark = blocks.find(b => b[1]!.includes(':root') && !b[1]!.includes('light'))
  const light = blocks.find(b => b[1]!.includes('light'))
  if (dark === undefined || light === undefined) throw new Error('tokens.css: no dark or light block')
  return { dark: read(dark[2]!), light: read(light[2]!) }
}

describe('tagline', () => {
  test('one tagline, and the package description opens with it; neither names a harness, so a new one changes nothing', () => {
    expect(TAGLINE).toBe('One engineering setup, one memory, every coding agent')
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { description?: unknown }
    expect(typeof pkg.description).toBe('string')
    expect(String(pkg.description).startsWith(`${TAGLINE}:`)).toBe(true)
    for (const h of ['Claude Code', 'Codex', 'OpenCode', 'Oh My Pi']) {
      expect(TAGLINE).not.toContain(h)
      expect(String(pkg.description)).not.toContain(h)
    }
  })
})

describe('README', () => {
  const readme = (name: string) => readFileSync(join(ROOT, name), 'utf8')
  const headings = (text: string) => text.split('\n').filter(l => /^#{2,4} /.test(l)).map(l => l.replace(/[^#].*$/, ''))

  test('the README opens with the tagline and the install command, and its badges wear the brand', () => {
    const text = readme('README.md')
    const top = text.split('\n').slice(0, 25).join('\n')
    expect(top).toContain(`### ${TAGLINE}\n`)
    expect(top).toContain('curl -fsSL https://github.com/burakarslan0110/buracle/releases/latest/download/install.sh | bash')
    for (const c of ['color=6D28D9', 'license-MIT-A21CAF', '1.4-B45309']) expect(top).toContain(c)
  })

  test('README.tr.md has the same headings, at the same levels and in the same order, and the Turkish tagline', () => {
    expect(headings(readme('README.tr.md'))).toEqual(headings(readme('README.md')))
    expect(readme('README.tr.md')).toContain('### Tek mühendislik kurulumu, tek hafıza, bütün kodlama ajanların\n')
  })
})

describe('web brand', () => {
  test('tokens.css carries the brand colors in both themes', () => {
    const blocks = tokenBlocks(readFileSync(join(ROOT, 'src/memory/ui/tokens.css'), 'utf8'))
    for (const theme of ['dark', 'light'] as const) {
      for (const [token, value] of Object.entries(BRAND_TOKENS[theme])) expect({ theme, token, value: blocks[theme].get(token) }).toEqual({ theme, token, value })
    }
  })

  test('the README wordmark images and the favicon use the same brand colors as the page', async () => {
    const logo = await import(join(ROOT, 'src/memory/ui/logo.js')) as { WORDMARK_THEMES: unknown, markTile(): string }
    expect(logo.WORDMARK_THEMES).toEqual({
      dark: { from: BRAND_TOKENS.dark['--brand-from'], to: BRAND_TOKENS.dark['--brand-to'], eye: BRAND_TOKENS.dark['--brand-eye'] },
      light: { from: BRAND_TOKENS.light['--brand-from'], to: BRAND_TOKENS.light['--brand-to'], eye: BRAND_TOKENS.light['--brand-eye'] },
    })
    const tile = logo.markTile()
    expect(tile).toContain(`fill="${BRAND_TOKENS.dark['--brand-from']}"`)
    expect(tile).toContain(`fill="${BRAND_TOKENS.dark['--brand-eye']}"`)
  })
})
