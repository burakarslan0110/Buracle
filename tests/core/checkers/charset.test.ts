import { describe, expect, test } from 'bun:test'
import { CHARSET_MAX_FINDINGS, charsetFindings } from '../../../src/core/checkers'

const cp = (n: number): string => String.fromCodePoint(n)
const ZWSP = cp(0x200b)
const ZWJ = cp(0x200d)
const NBSP = cp(0xa0)
const NNBSP = cp(0x202f)
const RLO = cp(0x202e)

describe('charsetFindings', () => {
  test('flags what is likely accidental in code: typographic characters in code positions, invisible characters anywhere', () => {
    const text = [
      'const ok = "done ✅"',
      'const quote = “hello”',
      'const dash = 1 — 2',
      `const zw = "a${ZWSP}b"`,
      `const nb = 1${NBSP}+ 2`,
      `const bidi = "${RLO}evil"`,
      'const arrow = a → b',
      '// ★ stars',
    ].join('\n')
    const f = charsetFindings(text, '/repo/src/a.ts')
    expect(f.length).toBe(7)
    const all = f.join('\n')
    expect(all).not.toContain('U+2705')
    expect(all).not.toContain('U+2605')
    expect(all).toContain('added line 2, column 15: smart double quote “ (U+201C); use a plain "')
    expect(all).toContain('typographic dash or minus — (U+2014)')
    expect(all).toContain('added line 4, column 14: zero-width character (U+200B); remove it, or write it as an escape sequence if the text needs it')
    expect(all).toContain('non-breaking or unusual space (U+00A0); use a plain space')
    expect(all).toContain('bidirectional control character (U+202E)')
    expect(all).toContain('arrow symbol → (U+2192)')
  })

  test('keeps intentional Unicode in string literals, comments, JSX text and markup', () => {
    expect(charsetFindings('const msg = "Saving… — done ✅ → next"\nconst t = `Wait…`\n// see the “guide” — it’s short', '/repo/src/ui.ts')).toEqual([])
    expect(charsetFindings("label = 'Don’t stop…'  # “quoted” — ok", '/repo/app/ui.py')).toEqual([])
    expect(charsetFindings('return <p className="x">Loading… — please wait ✅</p>', '/repo/src/App.tsx')).toEqual([])
    expect(charsetFindings('<button>Save {name}…</button>', '/repo/src/App.jsx')).toEqual([])
    expect(charsetFindings('<p title="Saved…">Done — “really”</p>\n<!-- note → here -->', '/repo/index.html')).toEqual([])
    expect(charsetFindings('echo "Done ✅"\ncat <<EOF\nNext → step — go\nEOF', '/repo/run.sh')).toEqual([])
    expect(charsetFindings('let s = @"C:\\dir\\" + "…";', '/repo/App/A.cs')).toEqual([])
  })

  test('nested template literals and regex literals are read as strings, not code', () => {
    expect(charsetFindings('const a = `Plan: ${x}${t ? ` — ${t}` : \'\'}`', '/repo/src/a.ts')).toEqual([])
    expect(charsetFindings('const b = `${g.ahead > 0 ? ` ↑${g.ahead}` : \'\'}` + `x`\nconst c = d — e', '/repo/src/b.ts')).toHaveLength(1)
    expect(charsetFindings("const q = s.replace(/[’‘`]/g, \"'\")\nconst r = /[-–]/.test(x)", '/repo/src/c.ts')).toEqual([])
    expect(charsetFindings('expect(text).toMatch(/✔ bun/)', '/repo/tests/a.test.ts')).toEqual([])
    expect(charsetFindings('const n = a / b → c / d', '/repo/src/d.ts')).toHaveLength(1)
  })

  test('the edited file gives the context: a fragment inside an existing string or JSX text is not code', () => {
    const file = 'export const t = {\n  saving: "Saving your work… please wait",\n}\n'
    expect(charsetFindings('Saving your work… please wait', '/repo/src/i18n.ts', file)).toEqual([])
    expect(charsetFindings('Saving your work… please wait', '/repo/src/i18n.ts')).toHaveLength(1)
    const jsx = 'export const A = () => (\n  <p>\n    Loading…\n  </p>\n)\n'
    expect(charsetFindings('    Loading…', '/repo/src/A.tsx', jsx)).toEqual([])
    expect(charsetFindings('const x = a → b', '/repo/src/a.ts', 'const x = a → b\n')).toHaveLength(1)
  })

  test('invisible characters stay strict, but joiners inside emoji or words and typographic spaces of localized text are kept', () => {
    expect(charsetFindings(`const s = "x${ZWSP}y"`, '/repo/a.ts')).toHaveLength(1)
    expect(charsetFindings(`const s = "${RLO}x"`, '/repo/a.ts')).toHaveLength(1)
    expect(charsetFindings(`const family = "👨${ZWJ}👩"`, '/repo/a.ts')).toEqual([])
    expect(charsetFindings(`const s = "a${ZWJ}b"`, '/repo/a.ts')).toHaveLength(1)
    expect(charsetFindings(`const fr = "Bonjour${NNBSP}!"`, '/repo/a.ts')).toEqual([])
    expect(charsetFindings(`const n = "1${NBSP}000"`, '/repo/a.ts')).toEqual([])
    expect(charsetFindings(`const s = "a${NBSP}b"`, '/repo/a.ts')).toEqual([`added line 1, column 13: non-breaking or unusual space (U+00A0); use a plain space unless the text needs a non-breaking one`])
  })

  test('caps the list and summarizes the rest', () => {
    const f = charsetFindings('✅'.repeat(25), '/repo/a.py')
    expect(f.length).toBe(CHARSET_MAX_FINDINGS + 1)
    expect(f[f.length - 1]).toBe('… 15 more unusual characters in this edit')
  })

  test('Turkish and other letters, ASCII and legal signs are fine', () => {
    expect(charsetFindings('const msg = "Çalışma başarısız: dosya bulunamadı (İzmir, Ğ, ş, ö, ü)"\n// © 2026 Burak ® ™\nconst x = "日本語 ñ é"', '/repo/a.ts')).toEqual([])
    expect(charsetFindings('const çalışma = 1', '/repo/a.ts')).toEqual([])
  })

  test('code, data and markup files are checked; prose and tables are not', () => {
    for (const p of ['/repo/README.md', '/repo/notes.txt', '/repo/data.csv', '/repo/data.tsv', '/repo/LICENSE']) expect(charsetFindings(`“✅” ${ZWSP}`, p)).toEqual([])
    for (const p of ['/repo/a.py', '/repo/a.go', '/repo/a.sh', '/repo/a.tsx', '/repo/a.rs', '/repo/a.json', '/repo/a.toml', '/repo/a.css', '/repo/Dockerfile']) expect(charsetFindings('“', p).length).toBe(1)
    expect(charsetFindings('{ "title": "Café — “menu”" }', '/repo/fr.json')).toEqual([])
    expect(charsetFindings('{ “title”: 1 }', '/repo/a.json')).toHaveLength(2)
    expect(charsetFindings('title: Café — “menu”\nnote: "→ next"', '/repo/fr.yaml')).toEqual([])
    expect(charsetFindings(`title: a${ZWSP}b`, '/repo/a.yml')).toHaveLength(1)
    expect(charsetFindings('', '/repo/a.ts')).toEqual([])
    expect(charsetFindings('plain ascii only', '/repo/a.ts')).toEqual([])
  })
})
