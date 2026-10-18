import { describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const HAS_DOCS = existsSync(join(REPO, 'docs'))

const TURKISH_LETTERS = /[çğıöşüÇĞİÖŞÜ]/u

function files(dir: string, keep: (name: string) => boolean): string[] {
  const out: string[] = []
  let names: string[] = []
  try { names = readdirSync(dir).sort() } catch { return out }
  for (const n of names) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...files(p, keep))
    else if (keep(n)) out.push(p)
  }
  return out
}

function read(file: string): string {
  try { return readFileSync(file, 'utf8') } catch { return '' }
}

function contractDocs(): string[] {
  return [join(REPO, 'docs', 'dev', 'CONTRACTS.md'), ...files(join(REPO, 'docs', 'dev', 'contracts'), n => n.endsWith('.md'))]
}

function designDocs(): string[] {
  return [join(REPO, 'docs', 'DESIGN.md'), ...files(join(REPO, 'docs', 'design'), n => n.endsWith('.md'))]
}

function englishDocs(): string[] {
  return [
    join(REPO, 'README.md'), join(REPO, 'AGENTS.md'), join(REPO, 'docs', 'USAGE.md'), ...designDocs(),
    ...contractDocs(),
    ...files(join(REPO, 'docs', 'reference'), n => n.endsWith('.md')),
  ]
}

function linkedDocs(): string[] {
  return [join(REPO, 'README.md'), join(REPO, 'AGENTS.md'), join(REPO, 'docs', 'USAGE.md'), ...designDocs(), ...contractDocs()]
}

const CATEGORY_D_LINES: ReadonlyArray<{ file: string, re: RegExp }> = [
  { file: join('docs', 'dev', 'contracts', 'core.md'), re: /^export function (?:slugify|normalizeForSearch)\(/ },
  { file: 'README.md', re: /^<p align="center"><b>English<\/b> · <a href="README\.tr\.md">Türkçe<\/a><\/p>$/ },
]

function categoryD(file: string, line: string): number {
  return CATEGORY_D_LINES.findIndex(a => a.file === relative(REPO, file) && a.re.test(line))
}

function withoutFences(text: string): string[] {
  let fence: string | undefined
  return text.split('\n').map(line => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line)
    if (m && m[1] !== undefined) {
      if (fence === undefined) { fence = m[1]; return '' }
      if (line.trim().startsWith(fence)) { fence = undefined; return '' }
    }
    return fence === undefined ? line : ''
  })
}

function slug(heading: string): string {
  return heading
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/`/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')
}

function anchors(text: string): Set<string> {
  const out = new Set<string>()
  const seen = new Map<string, number>()
  for (const line of withoutFences(text)) {
    const h = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (!h || h[1] === undefined) continue
    const base = slug(h[1])
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    out.add(n === 0 ? base : `${base}-${n}`)
  }
  return out
}

function links(text: string): Array<{ line: number, target: string }> {
  const out: Array<{ line: number, target: string }> = []
  withoutFences(text).forEach((raw, i) => {
    const line = raw.replace(/``[^`]*``|`[^`]*`/g, '')
    for (const m of line.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) if (m[1] !== undefined) out.push({ line: i + 1, target: m[1] })
  })
  return out
}

const NAMED_ELSEWHERE: ReadonlySet<string> = new Set([
  'docs/plans/', 'docs/builds/', 'docs/prd/', 'harness/claude/.claude-plugin/types/', 'harness/claude/tsconfig.json',
])

function namedPaths(text: string): Array<{ line: number, path: string }> {
  const out: Array<{ line: number, path: string }> = []
  withoutFences(text).forEach((line, i) => {
    for (const m of line.matchAll(/`((?:src|tests|canonical|harness|docs)\/[A-Za-z0-9_./-]+)`/g)) {
      if (m[1] !== undefined) out.push({ line: i + 1, path: m[1] })
    }
  })
  return out
}

function brokenLinks(file: string): string[] {
  const text = read(file)
  const own = anchors(text)
  const out: string[] = []
  for (const { line, target } of links(text)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue
    const [path = '', anchor] = target.split('#', 2)
    const where = `${relative(REPO, file)}:${line}: ${target}`
    if (path === '') {
      if (anchor !== undefined && !own.has(anchor)) out.push(`${where} (no such heading)`)
      continue
    }
    const dest = join(dirname(file), decodeURIComponent(path))
    if (!existsSync(dest)) { out.push(`${where} (no such file)`); continue }
    if (anchor !== undefined && dest.endsWith('.md') && !anchors(read(dest)).has(anchor)) out.push(`${where} (no such heading in ${relative(REPO, dest)})`)
  }
  return out
}

describe.skipIf(!HAS_DOCS)('doc lint: the design index', () => {
  test('DESIGN.md names every numbered section of docs/design/ once, with a link to the file that holds it, and keeps none of them inline', () => {
    const design = join(REPO, 'docs', 'DESIGN.md')
    const sections = new Map<string, string>()
    for (const file of files(join(REPO, 'docs', 'design'), n => n.endsWith('.md'))) {
      for (const line of withoutFences(read(file))) {
        const h = /^#{2,3} (\d+(?:\.\d+)?)\.? /.exec(line)
        if (h?.[1] === undefined) continue
        expect(sections.has(h[1])).toBe(false)
        sections.set(h[1], `${relative(dirname(design), file)}#${slug(line.replace(/^#+\s+/, ''))}`)
      }
    }
    expect(sections.has('4.5')).toBe(true)
    expect(sections.has('7.19')).toBe(true)
    expect(sections.has('11.5')).toBe(true)
    const rows = new Map<string, string>()
    for (const line of withoutFences(read(design))) {
      const r = /^\| §(\d+(?:\.\d+)?) \| \[[^\]]*\]\(([^)\s]+)\) \|/.exec(line)
      if (r?.[1] !== undefined && r[2] !== undefined) rows.set(r[1], r[2])
    }
    expect([...rows].sort()).toEqual([...sections].sort())
    const moved = [...sections.keys()].filter(k => !k.includes('.'))
    expect(moved.sort()).toEqual(['11', '4', '7'])
    for (const n of moved) expect(withoutFences(read(design)).filter(l => new RegExp(`^### ${n}\\.\\d`).test(l))).toEqual([])
  })
})

describe('doc lint: language and links', () => {
  test('the README, AGENTS.md, the usage guide, the design, the contract and the generated reference are English', () => {
    const docs = englishDocs()
    if (HAS_DOCS) {
      expect(docs.length).toBeGreaterThanOrEqual(14)
      for (const f of [join('docs', 'DESIGN.md'), join('docs', 'design', 'memory.md'), join('docs', 'dev', 'CONTRACTS.md'), join('docs', 'dev', 'contracts', 'core.md'), join('docs', 'dev', 'contracts', 'engine.md'), join('docs', 'dev', 'contracts', 'adapters.md')]) {
        expect(docs.map(d => relative(REPO, d))).toContain(f)
      }
    }
    const hits: string[] = []
    const allowed = new Set<number>()
    for (const file of docs) {
      read(file).split('\n').forEach((line, i) => {
        if (!TURKISH_LETTERS.test(line)) return
        const a = categoryD(file, line)
        if (a >= 0) allowed.add(a)
        else hits.push(`${relative(REPO, file)}:${i + 1}: ${line.slice(0, 100)}`)
      })
    }
    expect(hits).toEqual([])
    expect(CATEGORY_D_LINES.filter((a, i) => !allowed.has(i) && (HAS_DOCS || !a.file.startsWith('docs/'))).map(a => `${a.file}: ${a.re.source}`)).toEqual([])
    expect(categoryD(join(REPO, 'docs', 'USAGE.md'), 'export function slugify(title: string): string // ı')).toBe(-1)
  })

  test('every link and anchor in the README, AGENTS.md, the usage guide, the design and the contract resolves', () => {
    const broken = linkedDocs().flatMap(brokenLinks)
    expect(broken).toEqual([])
    if (!HAS_DOCS) return
    const usage = read(join(REPO, 'docs', 'USAGE.md'))
    const sections = withoutFences(usage).flatMap(l => (/^## \d+\. /.test(l) ? [slug(l.slice(3))] : []))
    expect(sections.length).toBeGreaterThanOrEqual(11)
    const toc = new Set(links(usage).flatMap(l => (l.target.startsWith('#') ? [l.target.slice(1)] : [])))
    expect(sections.filter(s => !toc.has(s))).toEqual([])
  })

  test.skipIf(!HAS_DOCS)('the contract index names every numbered section of the split contract once, in the file that holds it', () => {
    const index = join(REPO, 'docs', 'dev', 'CONTRACTS.md')
    const sections = new Map<string, string>()
    for (const file of contractDocs()) {
      for (const line of withoutFences(read(file))) {
        const h = /^#{2,3} (\d+(?:\.\d+)?)\.? /.exec(line)
        if (!h || h[1] === undefined) continue
        expect(sections.has(h[1])).toBe(false)
        sections.set(h[1], `${file === index ? '' : relative(dirname(index), file)}#${slug(line.replace(/^#+\s+/, ''))}`)
      }
    }
    for (const n of ['0', '4', '5', '5.11', '6.2', '7.2', '8', '8.6', '9', '10.1', '12.2']) expect(sections.has(n)).toBe(true)
    const rows = new Map<string, string>()
    for (const line of withoutFences(read(index))) {
      const r = /^\| §(\d+(?:\.\d+)?) \| \[[^\]]*\]\(([^)\s]+)\) \|/.exec(line)
      if (r && r[1] !== undefined && r[2] !== undefined) {
        expect(rows.has(r[1])).toBe(false)
        rows.set(r[1], r[2])
      }
    }
    expect([...rows.keys()].sort()).toEqual([...sections.keys()].sort())
    for (const [n, target] of rows) expect(`§${n} ${target}`).toBe(`§${n} ${sections.get(n)}`)
  })

  test('every repository path the README, AGENTS.md, the usage guide, the design and the contract name exists', () => {
    const missing: string[] = []
    const named = new Set<string>()
    for (const file of linkedDocs()) {
      for (const { line, path } of namedPaths(read(file))) {
        named.add(path)
        if (!HAS_DOCS && path.startsWith('docs/')) continue
        if (!NAMED_ELSEWHERE.has(path) && !existsSync(join(REPO, path))) missing.push(`${relative(REPO, file)}:${line}: ${path}`)
      }
    }
    expect(missing).toEqual([])
    if (HAS_DOCS) {
      expect(named.size).toBeGreaterThanOrEqual(80)
      expect([...NAMED_ELSEWHERE].filter(p => !named.has(p))).toEqual([])
    }
    expect(namedPaths('`src/a.ts` `src/<h>/x` `tests/**/*.test.ts` `src/b.ts:12` `src`\n```\n`docs/c.md`\n```\n').map(p => p.path)).toEqual(['src/a.ts'])
  })

  test('the link checker knows GitHub heading ids and catches broken links', () => {
    expect(slug('5. Memory (the Obsidian vault)')).toBe('5-memory-the-obsidian-vault')
    expect(slug('7. MCP servers, language servers and strict routing')).toBe('7-mcp-servers-language-servers-and-strict-routing')
    expect(slug('`buracle flow`: live progress')).toBe('buracle-flow-live-progress')
    expect([...anchors('# A\n## B\n```\n# not a heading\n```\n## B\n')]).toEqual(['a', 'b', 'b-1'])
    expect(links('[x](#a) `[y](#b)` [z](reference/cli.md#buracle-flow)\n```\n[w](#c)\n```\n').map(l => l.target)).toEqual(['#a', 'reference/cli.md#buracle-flow'])
  })
})
