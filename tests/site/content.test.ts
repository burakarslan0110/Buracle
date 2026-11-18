import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildSite } from '../../site/build'
import { HOST_LIMITS } from '../../src/adapters/shared/host-limits'
import { makeSandboxDirs } from '../helpers/sandbox'

// The real docs under site/content/<lang>/<slug>.md (written apart from the generator): they build without a broken
// link or a missing twin, and the harness page lists every host limit Buracle Stack records. Skipped until the docs
// exist in the checkout.

const CONTENT = join(import.meta.dir, '..', '..', 'site', 'content')
const SLUGS = ['install', 'workflows', 'flows', 'memory', 'console', 'guards', 'tools', 'harnesses', 'commands', 'update', 'credits'] as const
const HAS_DOCS = existsSync(join(CONTENT, 'en', 'harnesses.md')) && existsSync(join(CONTENT, 'tr', 'harnesses.md'))
const HEADINGS = { en: '## Host limits', tr: '## Harness sınırları' } as const

const sandbox = makeSandboxDirs('buracle-site-content-')
afterAll(() => rmSync(sandbox.root, { recursive: true, force: true }))

/** The first-column ids of the one table under `heading`, up to the next `## ` heading. */
function tableIds(markdown: string, heading: string): string[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n')
  const start = lines.findIndex(l => l.trim() === heading)
  if (start === -1) return []
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  const rows = lines.slice(start + 1, end === -1 ? undefined : end).filter(l => l.trim().startsWith('|'))
  return rows.slice(2).map(r => /^\|\s*`([^`]+)`\s*\|/.exec(r.trim())?.[1] ?? `(row without an id: ${r.trim()})`)
}

describe.skipIf(!HAS_DOCS)('site content: the real docs', () => {
  test('every contract page exists in both languages', () => {
    for (const lang of ['en', 'tr'] as const) {
      for (const slug of SLUGS) expect({ page: `${lang}/${slug}.md`, present: existsSync(join(CONTENT, lang, `${slug}.md`)) }).toEqual({ page: `${lang}/${slug}.md`, present: true })
    }
  })

  test('the site builds from site/content with no broken link and no missing twin', async () => {
    const media = join(sandbox.root, 'no-media')
    mkdirSync(media, { recursive: true })
    const r = await buildSite({ out: join(sandbox.root, 'out'), content: CONTENT, media })
    for (const slug of SLUGS) {
      expect(r.pages).toContain(`/${slug}/`)
      expect(r.pages).toContain(`/tr/${slug}/`)
    }
  })

  test('the host limits table lists every record that is not native, once, in both languages', () => {
    const expected = HOST_LIMITS.filter(l => l.kind !== 'native').map(l => l.id).sort()
    for (const lang of ['en', 'tr'] as const) {
      const ids = tableIds(readFileSync(join(CONTENT, lang, 'harnesses.md'), 'utf8'), HEADINGS[lang])
      expect({ lang, ids: [...ids].sort() }).toEqual({ lang, ids: expected })
    }
  })
})

describe('site content: the host limits table reader', () => {
  test('reads the first column of the table under the heading and stops at the next ## heading', () => {
    const md = '## Host limits\n\nIntro.\n\n| Id | Harness |\n|---|---|\n| `codex.a` | Codex |\n| `pi.b` | Pi |\n\n## Next\n\n| `x.c` | X |\n'
    expect(tableIds(md, '## Host limits')).toEqual(['codex.a', 'pi.b'])
    expect(tableIds(md, '## Missing')).toEqual([])
  })
})
