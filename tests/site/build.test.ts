import { afterAll, describe, expect, test } from 'bun:test'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { buildSite, SiteBuildError, type HomeData, type UiData } from '../../site/build'
import { escapeHtml } from '../../site/templates/layout'
import { HARNESSES, harnessProfile, type Harness } from '../../src/core/harness'
import { makeSandboxDirs } from '../helpers/sandbox'

// The site generator (site/build.ts) driven through its public entry with the fixture docs under
// tests/fixtures/site/ and the real landing data (site/content/<lang>/home.json and ui.json).

const REPO = join(import.meta.dir, '..', '..')
const FIXTURES = join(REPO, 'tests', 'fixtures', 'site')
const SITE = 'https://stack.buracle.dev'
const LANGS = ['en', 'tr'] as const

const sandbox = makeSandboxDirs('buracle-site-')
afterAll(() => rmSync(sandbox.root, { recursive: true, force: true }))
let counter = 0
const fresh = (name: string): string => join(sandbox.root, `${name}-${++counter}`)

/** A content folder: the fixture docs plus the real landing data, so the real home.json and ui.json are built too. */
function contentDir(): string {
  const dir = fresh('content')
  cpSync(join(FIXTURES, 'content'), dir, { recursive: true })
  for (const lang of LANGS) {
    for (const f of ['home.json', 'ui.json']) cpSync(join(REPO, 'site', 'content', lang, f), join(dir, lang, f))
  }
  return dir
}

const EMPTY_MEDIA = join(sandbox.root, 'no-media')
mkdirSync(EMPTY_MEDIA, { recursive: true })

function files(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(dir, p).split(sep).join('/'))
    }
  }
  walk(dir)
  return out
}

const read = (dir: string, path: string): string => readFileSync(join(dir, path), 'utf8')

async function build(opts: { content?: string, media?: string } = {}): Promise<string> {
  const out = fresh('out')
  await buildSite({ out, content: opts.content ?? contentDir(), media: opts.media ?? EMPTY_MEDIA })
  return out
}

async function failure(mutate: (content: string) => void): Promise<string> {
  const content = contentDir()
  mutate(content)
  try {
    await buildSite({ out: fresh('out'), content, media: EMPTY_MEDIA })
  } catch (e) {
    expect(e).toBeInstanceOf(SiteBuildError)
    return (e as Error).message
  }
  throw new Error('the build passed although it should have failed')
}

const OUT = await build()
const WITH_MEDIA = await build({ media: join(FIXTURES, 'media') })

describe('site build: pages', () => {
  test('writes the landing page and every docs page in both languages, at the contract URLs', () => {
    const all = files(OUT)
    for (const p of ['index.html', 'tr/index.html', 'install/index.html', 'workflows/index.html', 'harnesses/index.html',
      'tr/install/index.html', 'tr/workflows/index.html', 'tr/harnesses/index.html', '404.html', 'sitemap.xml', 'robots.txt', 'CNAME', 'install.sh']) {
      expect({ p, present: all.includes(p) }).toEqual({ p, present: true })
    }
    expect(read(OUT, 'index.html')).toContain('<html lang="en"')
    expect(read(OUT, 'tr/index.html')).toContain('<html lang="tr"')
    expect(read(OUT, 'tr/install/index.html')).toContain('<html lang="tr"')
  })

  test('the landing page carries the copy of home.json and the install command', () => {
    const en = JSON.parse(read(join(REPO, 'site', 'content'), 'en/home.json')) as { hero: { title: string, command: string } }
    const tr = JSON.parse(read(join(REPO, 'site', 'content'), 'tr/home.json')) as { hero: { title: string } }
    const html = read(OUT, 'index.html')
    expect(html).toContain(`<h1 id="hero-title">${en.hero.title}</h1>`)
    expect(html).toContain('curl -fsSL https://stack.buracle.dev/install.sh | bash')
    expect(en.hero.command).toBe('curl -fsSL https://stack.buracle.dev/install.sh | bash')
    expect(read(OUT, 'tr/index.html')).toContain(`<h1 id="hero-title">${tr.hero.title}</h1>`)
  })

  test('the landing page tells the story in the order of the brief, each section once', () => {
    for (const page of ['index.html', 'tr/index.html']) {
      const html = read(OUT, page)
      const at = ['class="hero"', 'class="numbers"', 'class="memory"', 'class="loops"', 'class="tools"', 'id="close-title"', 'class="oss"'].map(m => html.indexOf(m))
      expect({ page, missing: at.filter(i => i === -1).length }).toEqual({ page, missing: 0 })
      expect([...at].sort((a, b) => a - b)).toEqual(at)
    }
  })

  test('the workflow tabs are a tablist whose tabs name their panels, the first one selected', () => {
    const html = read(OUT, 'index.html')
    const loops = html.slice(html.indexOf('class="loops"'), html.indexOf('class="tools"'))
    const tabs = [...loops.matchAll(/<button class="tab" type="button" role="tab" id="([^"]+)" aria-controls="([^"]+)" aria-selected="(true|false)" tabindex="(0|-1)">/g)]
    expect(tabs.map(t => [t[3], t[4]])).toEqual([['true', '0'], ['false', '-1'], ['false', '-1'], ['false', '-1']])
    for (const t of tabs) expect(loops).toContain(`role="tabpanel" id="${t[2]}" aria-labelledby="${t[1]}"`)
    expect(loops).toContain('role="tablist"')
  })

  test('every logo comes from SOURCES.json and is served from its own file on the light site (Qwen Code stays blue)', () => {
    const html = read(OUT, 'index.html')
    const sources = JSON.parse(read(join(REPO, 'site', 'assets', 'logos'), 'SOURCES.json')) as Array<{ id: string, name: string, kind: string, logoFile?: string | null }>
    for (const s of sources.filter(x => typeof x.logoFile === 'string')) {
      expect({ id: s.id, ondark: existsSync(join(OUT, 'assets/logos', (s.logoFile as string).replace(/\.svg$/, '-mono-ondark.svg'))) }).toEqual({ id: s.id, ondark: false })
    }
    expect(html).toContain('/assets/logos/qwen-code.svg')
    expect(html).not.toContain('-ondark.svg')
    // The open source band lists every project that is not a harness, by name, linked to its repository.
    const band = html.slice(html.indexOf('class="oss"'))
    for (const s of sources.filter(x => x.kind !== 'harness')) expect(band).toContain(`<span>${escapeHtml(s.kind === 'lsp' ? s.name : s.name.split(' (')[0] as string)}</span>`)
    expect(band).toContain('href="https://github.com/upstash/context7"')
  })

  test('the open source band links the credits page only when the docs have one', async () => {
    expect(read(OUT, 'index.html')).not.toContain('href="/credits/"')
    const content = contentDir()
    for (const [lang, title] of [['en', 'Open source'], ['tr', 'Açık kaynak']] as const) {
      writeFileSync(join(content, lang, 'credits.md'), `---\ntitle: ${title}\ndescription: The projects Buracle Stack builds on.\norder: 11\n---\n\n## Context7\n\nLibrary docs.\n`)
    }
    const out = await build({ content })
    expect(read(out, 'index.html')).toContain('<a class="go" href="/credits/">')
    expect(read(out, 'tr/index.html')).toContain('<a class="go" href="/tr/credits/">')
  })

  test('a landing source id that SOURCES.json does not list stops the build', async () => {
    const msg = await failure(c => writeFileSync(join(c, 'en', 'home.json'), read(c, 'en/home.json').replace('"source": "semble"', '"source": "no-such-logo"')))
    expect(msg).toContain('no-such-logo')
  })

  test('a docs page prints its title, its description and the rendered Markdown', () => {
    const html = read(OUT, 'install/index.html')
    expect(html).toContain('<h1>Install</h1>')
    expect(html).toContain('<title>Install | Buracle Stack</title>')
    expect(html).toContain('<meta name="description" content="Install Buracle Stack with one command and check the result.">')
    expect(html).toContain('<table>')
    expect(html).toContain('<blockquote>')
    expect(html).toContain('class="language-sh"')
  })
})

describe('site build: links and headings', () => {
  test('a link to another page becomes its URL in the page language, anchors kept', () => {
    const en = read(OUT, 'install/index.html')
    expect(en).toContain('href="/harnesses/"')
    expect(en).toContain('href="/harnesses/#host-limits"')
    expect(en).toContain('href="/workflows/"')
    expect(en).not.toMatch(/href="(?!https:)[^"]*\.md[#"]/)
    expect(en).toContain('href="https://github.com/burakarslan0110/Buracle-Stack/edit/dev/site/content/en/install.md"')
    const tr = read(OUT, 'tr/install/index.html')
    expect(tr).toContain('href="/tr/harnesses/#harness-sınırları"')
    expect(read(OUT, 'workflows/index.html')).toContain('href="/install/#requirements"')
  })

  test('heading ids follow GitHub: lower case, punctuation dropped, Unicode letters kept, repeats numbered', () => {
    const en = read(OUT, 'install/index.html')
    expect(en).toContain('<h2 id="requirements">')
    expect(en).toContain('<h3 id="after-the-install">')
    expect(en).toContain('<h2 id="whats-new-beta">')
    expect(en).toContain('<h2 id="requirements-1">')
    expect(read(OUT, 'tr/harnesses/index.html')).toContain('<h2 id="harness-sınırları">')
    // GitHub lower-cases İ to i plus a combining dot; a link written without the dot still finds the heading.
    expect(read(OUT, 'tr/workflows/index.html')).toContain('<h2 id="i̇ş-akışları">')
    expect(read(OUT, 'tr/install/index.html')).toContain('href="/tr/workflows/#i̇ş-akışları"')
  })

  test('"On this page" lists the h2 and h3 headings of the page', () => {
    const html = read(OUT, 'install/index.html')
    const toc = html.slice(html.indexOf('class="toc"'), html.indexOf('</nav>', html.indexOf('class="toc"')))
    expect(toc).toContain('On this page')
    for (const id of ['requirements', 'after-the-install', 'whats-new-beta', 'requirements-1']) expect(toc).toContain(`href="#${id}"`)
    expect(read(OUT, 'tr/install/index.html')).toContain('Bu sayfada')
  })

  test('previous and next follow the order of the front matter, and the sidebar lists every page', () => {
    const middle = read(OUT, 'workflows/index.html')
    const pager = middle.slice(middle.indexOf('class="pager"'), middle.indexOf('</nav>', middle.indexOf('class="pager"')))
    expect(pager).toContain('href="/install/"')
    expect(pager).toContain('href="/harnesses/"')
    const first = read(OUT, 'install/index.html')
    expect(first.slice(first.indexOf('class="pager"'), first.indexOf('</nav>', first.indexOf('class="pager"')))).not.toContain('rel="prev"')
    const side = first.slice(first.indexOf('class="sidebar"'), first.indexOf('</nav>', first.indexOf('class="sidebar"')))
    expect([...side.matchAll(/href="(\/[^"]*)"/g)].map(m => m[1])).toEqual(['/install/', '/workflows/', '/harnesses/', '/flows/'])
    expect(side).toContain('aria-current="page"')
  })

  test('every page links its twin, with hreflang alternates, a canonical URL and Open Graph tags', () => {
    const pairs: Array<[string, string, string]> = [['index.html', '/', '/tr/'], ['install/index.html', '/install/', '/tr/install/']]
    for (const [file, en, tr] of pairs) {
      for (const [page, self, twin, lang] of [[file, en, tr, 'en'], [`tr/${file}`, tr, en, 'tr']] as const) {
        const html = read(OUT, page)
        expect(html).toContain(`<link rel="canonical" href="${SITE}${self}">`)
        expect(html).toContain(`<link rel="alternate" hreflang="en" href="${SITE}${en}">`)
        expect(html).toContain(`<link rel="alternate" hreflang="tr" href="${SITE}${tr}">`)
        expect(html).toContain(`<link rel="alternate" hreflang="x-default" href="${SITE}${en}">`)
        expect(html).toContain(`<meta property="og:url" content="${SITE}${self}">`)
        expect(html).toContain(`<meta property="og:locale" content="${lang === 'en' ? 'en_US' : 'tr_TR'}">`)
        expect(html).toMatch(/<meta property="og:image" content="https:\/\/stack\.buracle\.dev\/[^"]+">/)
        expect(html).toMatch(new RegExp(`<a [^>]*href="${twin.replace(/\//g, '\\/')}"[^>]*hreflang="${lang === 'en' ? 'tr' : 'en'}"`))
      }
    }
  })

  test('the share image is the poster when the media folder has it', () => {
    expect(read(WITH_MEDIA, 'index.html')).toContain(`<meta property="og:image" content="${SITE}/media/poster-en.jpg">`)
    expect(read(WITH_MEDIA, 'tr/index.html')).toContain(`<meta property="og:image" content="${SITE}/media/poster-en.jpg">`)
  })

  test('every root-relative href and src in every page names a file the build wrote', () => {
    for (const out of [OUT, WITH_MEDIA]) {
      const all = new Set(files(out))
      for (const page of [...all].filter(p => p.endsWith('.html'))) {
        for (const m of read(out, page).matchAll(/(?:href|src|poster)="(\/[^"#?]*)/g)) {
          const url = m[1] as string
          const target = url.endsWith('/') ? `${url.slice(1)}index.html` : url.slice(1)
          expect({ page, url, ok: all.has(target) }).toEqual({ page, url, ok: true })
        }
      }
    }
  })
})

describe('site build: files', () => {
  test('CNAME names the custom domain and install.sh is the install script byte for byte', () => {
    expect(read(OUT, 'CNAME')).toBe('stack.buracle.dev\n')
    expect(Buffer.compare(readFileSync(join(OUT, 'install.sh')), readFileSync(join(REPO, 'scripts', 'install.sh')))).toBe(0)
  })

  test('the wordmark files the pages show are copied byte for byte', () => {
    for (const f of ['buracle-dark.svg', 'buracle-light.svg']) {
      expect(Buffer.compare(readFileSync(join(OUT, 'assets', f)), readFileSync(join(REPO, 'assets', f)))).toBe(0)
    }
  })

  test('404.html, sitemap.xml and robots.txt', () => {
    const notFound = read(OUT, '404.html')
    expect(notFound).toContain('Page not found')
    expect(notFound).toContain('Sayfa bulunamadı')
    expect(notFound).toContain('<meta name="robots" content="noindex">')
    const sitemap = read(OUT, 'sitemap.xml')
    for (const path of ['/', '/tr/', '/install/', '/tr/install/', '/workflows/', '/tr/workflows/', '/harnesses/', '/tr/harnesses/']) {
      expect(sitemap).toContain(`<loc>${SITE}${path}</loc>`)
    }
    expect(sitemap).toContain(`<xhtml:link rel="alternate" hreflang="tr" href="${SITE}/tr/install/"/>`)
    expect(sitemap).not.toContain('404')
    expect(read(OUT, 'robots.txt')).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`)
  })

  test('the video plays the film with its poster in both languages when the media is there, and is left out when it is not', () => {
    // The film comes right after the hero, before the memory.
    const withFilm = read(WITH_MEDIA, 'index.html')
    expect(withFilm.indexOf('class="film-sec"')).toBeGreaterThan(withFilm.indexOf('class="hero"'))
    expect(withFilm.indexOf('class="film-sec"')).toBeLessThan(withFilm.indexOf('class="memory"'))
    expect(read(WITH_MEDIA, 'index.html')).toMatch(/<video [^>]*poster="\/media\/poster-en\.jpg"[^>]*>\s*<source src="\/media\/buracle-stack-en\.mp4" type="video\/mp4">/)
    expect(read(WITH_MEDIA, 'tr/index.html')).toMatch(/<video [^>]*poster="\/media\/poster-en\.jpg"[^>]*>\s*<source src="\/media\/buracle-stack-en\.mp4" type="video\/mp4">/)
    for (const f of ['buracle-stack-en.mp4', 'poster-en.jpg']) {
      expect(Buffer.compare(readFileSync(join(WITH_MEDIA, 'media', f)), readFileSync(join(FIXTURES, 'media', f)))).toBe(0)
    }
    expect(read(OUT, 'index.html')).not.toContain('<video')
    expect(existsSync(join(OUT, 'media'))).toBe(false)
  })

  test('two builds of the same input are identical', async () => {
    const content = contentDir()
    const a = fresh('a')
    const b = fresh('b')
    await buildSite({ out: a, content, media: join(FIXTURES, 'media') })
    await buildSite({ out: b, content, media: join(FIXTURES, 'media') })
    expect(files(a)).toEqual(files(b))
    for (const f of files(a)) expect({ f, same: Buffer.compare(readFileSync(join(a, f)), readFileSync(join(b, f))) === 0 }).toEqual({ f, same: true })
  })

  test('a rebuild clears what the last build left, but never a folder the build did not write', async () => {
    const out = fresh('out')
    await buildSite({ out, content: contentDir(), media: join(FIXTURES, 'media') })
    await buildSite({ out, content: contentDir(), media: EMPTY_MEDIA })
    expect(existsSync(join(out, 'media'))).toBe(false)
    const foreign = fresh('foreign')
    mkdirSync(foreign)
    writeFileSync(join(foreign, 'notes.txt'), 'mine')
    await expect(buildSite({ out: foreign, content: contentDir(), media: EMPTY_MEDIA })).rejects.toThrow(/not a site build/)
    expect(read(foreign, 'notes.txt')).toBe('mine')
  })
})

describe('site build: it fails loudly', () => {
  test('on a link to a page that does not exist', async () => {
    const msg = await failure(c => writeFileSync(join(c, 'en', 'workflows.md'), read(c, 'en/workflows.md').replace('(install.md#requirements)', '(missing.md)')))
    expect(msg).toContain('en/workflows.md')
    expect(msg).toContain('missing.md')
  })

  test('on a link to a heading that does not exist', async () => {
    const msg = await failure(c => writeFileSync(join(c, 'tr', 'install.md'), read(c, 'tr/install.md').replace('#harness-sınırları', '#yok')))
    expect(msg).toContain('tr/install.md')
    expect(msg).toContain('harnesses.md#yok')
  })

  test('on a same-page anchor that does not exist', async () => {
    const msg = await failure(c => writeFileSync(join(c, 'en', 'install.md'), read(c, 'en/install.md').replace('(#requirements)', '(#nowhere)')))
    expect(msg).toContain('#nowhere')
  })

  test('on a page missing in one language', async () => {
    const msg = await failure(c => rmSync(join(c, 'tr', 'workflows.md')))
    expect(msg).toContain('workflows')
    expect(msg).toMatch(/tr\/workflows\.md/)
  })

  test('on front matter without a title, a description or a numeric order', async () => {
    const msg = await failure(c => writeFileSync(join(c, 'en', 'harnesses.md'), read(c, 'en/harnesses.md').replace('order: 3\n', 'order: three\n').replace(/^title: .*\n/m, '')))
    expect(msg).toContain('en/harnesses.md')
    expect(msg).toContain('title')
    expect(msg).toContain('order')
  })

  test('on a level-one heading, which the template prints from the title', async () => {
    const msg = await failure(c => writeFileSync(join(c, 'en', 'harnesses.md'), read(c, 'en/harnesses.md').replace('## Next', '# Next')))
    expect(msg).toContain('en/harnesses.md')
  })
})

describe('site build: the landing data matches the product', () => {
  // The build checked both files against the shapes of HomeData and UiData above (OUT was built from them).
  const homes = Object.fromEntries(LANGS.map(l => [l, JSON.parse(read(join(REPO, 'site', 'content'), `${l}/home.json`)) as HomeData])) as Record<typeof LANGS[number], HomeData>
  const uis = Object.fromEntries(LANGS.map(l => [l, JSON.parse(read(join(REPO, 'site', 'content'), `${l}/ui.json`)) as UiData])) as Record<typeof LANGS[number], UiData>

  const shape = (v: unknown): unknown => Array.isArray(v) ? v.map(shape) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v

  test('home.json and ui.json have the same keys in both languages', () => {
    expect(shape(homes.tr)).toEqual(shape(homes.en))
    expect(shape(uis.tr)).toEqual(shape(uis.en))
  })

  test('the harness cards follow the profiles: order, config folder, workflow command and the files each adapter writes', () => {
    const adapterText = (id: string): string => {
      const dir = join(REPO, 'src', 'adapters', id)
      const texts = files(dir).filter(f => f.endsWith('.ts')).map(f => readFileSync(join(dir, f), 'utf8'))
      return [...texts, readFileSync(join(REPO, 'src', 'core', 'harness', `${id}.ts`), 'utf8')].join('\n')
    }
    for (const l of LANGS) expect(homes[l].harnesses.map(h => h.id)).toEqual([...HARNESSES])
    for (const h of homes.en.harnesses) {
      const profile = harnessProfile(h.id as Harness)
      expect({ id: h.id, invoke: h.invoke }).toEqual({ id: h.id, invoke: profile.skills.mention('plan-build', true) })
      expect({ id: h.id, folder: h.folder }).toEqual({ id: h.id, folder: `~/${profile.configDir.under}` })
      const text = adapterText(h.id)
      for (const f of h.files) expect({ id: h.id, f, written: text.includes(f.replace(/\/$/, '')) }).toEqual({ id: h.id, f, written: true })
    }
    for (const l of LANGS) expect(homes[l].harnesses.map(h => [h.id, h.folder, h.files, h.invoke])).toEqual(homes.en.harnesses.map(h => [h.id, h.folder, h.files, h.invoke]))
  })

  test('the tools section lists the nine MCP servers of canonical/mcp.yaml', () => {
    const yaml = readFileSync(join(REPO, 'canonical', 'mcp.yaml'), 'utf8')
    const servers = [...yaml.slice(yaml.indexOf('servers:')).matchAll(/^ {2}([a-z0-9-]+):\s*$/gm)].map(m => m[1] as string).sort()
    expect(servers).toHaveLength(9)
    for (const l of LANGS) expect(homes[l].tools.servers.map(x => x.id).sort()).toEqual(servers)
  })

  test('the loop phases and the way back agree in both languages', () => {
    for (const [i, loop] of homes.en.loops.items.entries()) {
      const tr = homes.tr.loops.items[i]
      expect({ command: tr?.command, phases: tr?.phases.length, gates: tr?.phases.map(p => p.gate === true), back: tr?.loopBack && [tr.loopBack.from, tr.loopBack.to] })
        .toEqual({ command: loop.command, phases: loop.phases.length, gates: loop.phases.map(p => p.gate === true), back: loop.loopBack && [loop.loopBack.from, loop.loopBack.to] })
    }
  })

  test('the copy uses no em or en dashes', () => {
    const strings = (v: unknown): string[] => typeof v === 'string' ? [v] : Array.isArray(v) ? v.flatMap(strings) : v !== null && typeof v === 'object' ? Object.values(v).flatMap(strings) : []
    for (const l of LANGS) expect([...strings(homes[l]), ...strings(uis[l])].filter(s => /[–—]/.test(s))).toEqual([])
  })
})

describe('site build: the command line', () => {
  test('bun site/build.ts --out --content builds, and a broken link exits non-zero with the reason', () => {
    const out = fresh('cli')
    const ok = Bun.spawnSync(['bun', join(REPO, 'site', 'build.ts'), '--out', out, '--content', contentDir(), '--media', EMPTY_MEDIA], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
    expect({ code: ok.exitCode, err: ok.stderr.toString() }).toEqual({ code: 0, err: '' })
    expect(existsSync(join(out, 'index.html'))).toBe(true)
    const broken = contentDir()
    writeFileSync(join(broken, 'en', 'install.md'), read(broken, 'en/install.md').replace('(harnesses.md)', '(gone.md)'))
    const bad = Bun.spawnSync(['bun', join(REPO, 'site', 'build.ts'), '--out', fresh('cli'), '--content', broken, '--media', EMPTY_MEDIA], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' })
    expect(bad.exitCode).toBe(1)
    expect(bad.stderr.toString()).toContain('gone.md')
  })
})
