#!/usr/bin/env bun
// The GitHub Pages site at https://stack.buracle.dev: a landing page and the usage docs in English (/) and Turkish
// (/tr/), rendered from site/content with Bun's own Markdown parser and no dependency.
//
//   bun site/build.ts [--out <dir>] [--content <dir>] [--media <dir>]
//
// Defaults: site/dist, site/content and site/media. The output is the same for the same input (no timestamps,
// sorted reads), and the build stops with every problem listed when a link or a heading it points to is missing, or
// when a page exists in one language only.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { docsPage } from './templates/docs'
import { copyButton, escapeHtml } from './templates/layout'
import { landingPage } from './templates/landing'
import { notFoundPage } from './templates/notfound'
import { isHarness } from '../src/core/harness'
import { REPO_URL, SITE_URL, type DocPage, type Heading, type HomeData, type Lang, type LandingExtras, type Logo, type LogoSource, type Media, type PageContext, type UiData } from './templates/types'

export type { DocPage, HomeData, UiData } from './templates/types'

const SITE_DIR = import.meta.dir
const REPO = dirname(SITE_DIR)
export const LANGS: readonly Lang[] = ['en', 'tr']
const DOMAIN = new URL(SITE_URL).host
const FRONT_KEYS = ['title', 'description', 'order'] as const
const RESERVED = new Set(['tr', 'en', 'assets', 'media', 'index', '404'])

export interface SiteBuildOptions {
  /** The output folder; cleared first when it holds an earlier site build. */
  out: string
  /** The content folder with `<lang>/home.json`, `<lang>/ui.json` and `<lang>/<slug>.md`. Default site/content. */
  content?: string
  /** The folder whose files are copied to /media/ (the launch video and its posters). Default site/media. */
  media?: string
}

export interface SiteBuildResult {
  /** Every file written, relative to the output folder, sorted. */
  files: string[]
  /** The site paths of the HTML pages (`/`, `/install/`, `/tr/`…), sorted. */
  pages: string[]
}

/** The build found problems in the content: the message lists every one. */
export class SiteBuildError extends Error {
  readonly problems: readonly string[]
  constructor(problems: readonly string[]) {
    super(`the site build found ${problems.length} ${problems.length === 1 ? 'problem' : 'problems'}:\n${problems.map(p => `  - ${p}`).join('\n')}`)
    this.name = 'SiteBuildError'
    this.problems = problems
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Text helpers

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_m, e: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'" })[e] ?? _m)
}

function textOf(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ''))
}

/** GitHub's heading slug: lower case, every character but letters, marks, numbers, `_`, `-` and spaces dropped, spaces to `-`. */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '').replace(/ /g, '-')
}

/** A looser key for anchors: `#iş-akışları` finds GitHub's `i̇ş-akışları` (İ lower-cases to i and a combining dot). */
function anchorKey(id: string): string {
  return id.normalize('NFC').replace(/̇/g, '').toLowerCase()
}

function safeDecode(s: string): string {
  try { return decodeURIComponent(s) } catch { return s }
}

// ---------------------------------------------------------------------------------------------------------------
// Data checks: the JSON files are input from disk, so every field is checked before a template reads it.

type Leaf = 'string' | 'number' | 'boolean'
/** A field's shape: a leaf type, a list of one shape, or an object whose keys may end in `?` (optional). */
type Shape = Leaf | `${Leaf}?` | readonly [Shape] | { readonly [k: string]: Shape }

const LINK = { text: 'string', href: 'string' } as const

const HOME_SHAPE: Shape = {
  title: 'string',
  description: 'string',
  hero: { eyebrow: 'string', title: 'string', lede: 'string', installLabel: 'string', command: 'string', docs: LINK, film: 'string', orbitLabel: 'string', pick: 'string', invoke: 'string' },
  harnesses: [{ id: 'string', name: 'string', source: 'string', folder: 'string', files: ['string'], plugs: 'string', invoke: 'string' }],
  numbers: { label: 'string', items: [{ value: 'number', label: 'string' }] },
  video: { eyebrow: 'string', label: 'string', src: 'string', poster: 'string' },
  memory: {
    eyebrow: 'string', title: 'string', body: ['string'], example: 'string', label: 'string', listLabel: 'string',
    project: { name: 'string', sub: 'string' }, person: { name: 'string', sub: 'string' },
    card: { kind: 'string', origin: 'string', explicit: 'string', inferred: 'string', cites: 'string', written: 'string', recalled: 'string' },
    memories: [{ id: 'string', kind: 'string', layer: 'string', title: 'string', origin: 'string', written: 'string', recalled: 'string', 'files?': ['string'] }],
  },
  loops: {
    eyebrow: 'string', title: 'string', sub: 'string', tabsLabel: 'string', when: 'string', phasesLabel: 'string', example: 'string', footnote: 'string', cases: LINK,
    items: [{ command: 'string', when: 'string', phases: [{ name: 'string', 'detail?': 'string', 'gate?': 'boolean' }], 'loopBack?': { from: 'number', to: 'number', text: 'string' }, example: 'string' }],
  },
  tools: {
    eyebrow: 'string', title: 'string', sub: 'string', routerLabel: 'string', ask: 'string',
    servers: [{ id: 'string', 'source?': 'string', by: 'string', adds: 'string', q: 'string' }],
    stripLabel: 'string', strip: [{ source: 'string', name: 'string' }],
    guards: { title: 'string', items: [{ verdict: 'string', tool: 'string', command: 'string', label: 'string' }] },
  },
  close: { title: 'string', command: 'string' },
  credits: { title: 'string', body: 'string', link: 'string' },
}

const UI_SHAPE: Shape = {
  lang: 'string', locale: 'string', name: 'string', siteName: 'string', skip: 'string', home: 'string',
  nav: { label: 'string', docs: 'string', github: 'string' },
  language: { label: 'string', hint: 'string' },
  copy: 'string', copied: 'string', copyFailed: 'string', copyLabel: 'string',
  motion: { pause: 'string', play: 'string' },
  docs: { label: 'string', menu: 'string', onThisPage: 'string', edit: 'string', pager: 'string', prev: 'string', next: 'string', table: 'string', code: 'string' },
  footer: { label: 'string', license: 'string', source: 'string', issues: 'string', releases: 'string', maker: 'string', role: 'string' },
  notFound: { title: 'string', body: 'string', home: 'string', docs: 'string' },
}

function check(value: unknown, shape: Shape, where: string, problems: string[]): void {
  if (typeof shape === 'string') {
    const optional = shape.endsWith('?')
    const type = optional ? shape.slice(0, -1) : shape
    if (value === undefined && optional) return
    if (typeof value !== type || (type === 'string' && (value as string).trim() === '')) problems.push(`${where}: expected a non-empty ${type}`)
    return
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value) || value.length === 0) { problems.push(`${where}: expected a non-empty list`); return }
    value.forEach((v, i) => check(v, shape[0] as Shape, `${where}[${i}]`, problems))
    return
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { problems.push(`${where}: expected an object`); return }
  const obj = value as Record<string, unknown>
  const keys = new Set<string>()
  for (const [raw, s] of Object.entries(shape as Record<string, Shape>)) {
    const optional = raw.endsWith('?')
    const k = optional ? raw.slice(0, -1) : raw
    keys.add(k)
    if (optional && obj[k] === undefined) continue
    check(obj[k], s, `${where}.${k}`, problems)
  }
  for (const k of Object.keys(obj)) if (!keys.has(k)) problems.push(`${where}.${k}: unknown key`)
}

function readJson(file: string, label: string, problems: string[]): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  } catch (e) {
    problems.push(`${label}: ${e instanceof Error ? e.message : String(e)}`)
    return undefined
  }
}

function loadHome(content: string, lang: Lang, problems: string[]): HomeData | undefined {
  const label = `${lang}/home.json`
  const data = readJson(join(content, lang, 'home.json'), label, problems)
  if (data === undefined) return undefined
  const before = problems.length
  check(data, HOME_SHAPE, label, problems)
  if (problems.length > before) return undefined
  const home = data as HomeData
  const ids = home.harnesses.map(h => h.id)
  if (new Set(ids).size !== ids.length) problems.push(`${label}.harnesses: an id is listed twice`)
  for (const [i, id] of ids.entries()) if (!isHarness(id)) problems.push(`${label}.harnesses[${i}].id: "${id}" is not a harness of src/core/harness`)
  const memIds = new Set(home.memory.memories.map(m => m.id))
  if (memIds.size !== home.memory.memories.length) problems.push(`${label}.memory.memories: an id is listed twice`)
  for (const [i, m] of home.memory.memories.entries()) {
    if (m.layer !== 'project' && m.layer !== 'person') problems.push(`${label}.memory.memories[${i}].layer: project or person`)
    if (m.origin !== 'explicit' && m.origin !== 'inferred') problems.push(`${label}.memory.memories[${i}].origin: explicit or inferred`)
    for (const k of ['written', 'recalled'] as const) if (!ids.includes(m[k])) problems.push(`${label}.memory.memories[${i}].${k}: "${m[k]}" is not a harness id of harnesses`)
  }
  for (const side of ['project', 'person'] as const) if (!home.memory.memories.some(m => m.layer === side)) problems.push(`${label}.memory.memories: no memory in the ${side} brain`)
  for (const [i, loop] of home.loops.items.entries()) {
    const b = loop.loopBack
    if (b !== undefined && (!Number.isInteger(b.from) || !Number.isInteger(b.to) || b.to < 0 || b.to >= b.from || b.from >= loop.phases.length)) {
      problems.push(`${label}.loops.items[${i}].loopBack: "to" must come before "from", both phases of the loop`)
    }
  }
  for (const [i, n] of home.numbers.items.entries()) if (!Number.isInteger(n.value) || n.value < 0) problems.push(`${label}.numbers.items[${i}].value: a whole number`)
  for (const [i, g] of home.tools.guards.items.entries()) {
    if (g.verdict !== 'deny' && g.verdict !== 'ask') problems.push(`${label}.tools.guards.items[${i}].verdict: deny or ask`)
    if (g.tool !== 'shell' && g.tool !== 'write') problems.push(`${label}.tools.guards.items[${i}].tool: shell or write`)
  }
  for (const f of [home.video.src, home.video.poster]) {
    if (!/^[\w.-]+$/.test(f)) problems.push(`${label}: "${f}" must be a plain file name`)
  }
  return problems.length > before ? undefined : home
}

function loadUi(content: string, lang: Lang, problems: string[]): UiData | undefined {
  const label = `${lang}/ui.json`
  const data = readJson(join(content, lang, 'ui.json'), label, problems)
  if (data === undefined) return undefined
  const before = problems.length
  check(data, UI_SHAPE, label, problems)
  if (problems.length > before) return undefined
  const ui = data as UiData
  if (ui.lang !== lang) problems.push(`${label}.lang: expected "${lang}"`)
  return problems.length > before ? undefined : ui
}

// ---------------------------------------------------------------------------------------------------------------
// Logos: site/assets/logos/SOURCES.json lists every harness and upstream project with its logo files. Logo tiles are
// light, so every mark is shown from its own file in its own colours (Qwen Code in its blue); the mono files stay in
// site/assets/logos for a dark surface but the site no longer uses them.

const LOGO_DIR = join(SITE_DIR, 'assets', 'logos')

interface Logos { logos: Map<string, Logo>, credits: Logo[], derived: Map<string, string> }

function loadLogos(problems: string[]): Logos {
  const out: Logos = { logos: new Map(), credits: [], derived: new Map() }
  const label = 'site/assets/logos/SOURCES.json'
  const data = readJson(join(LOGO_DIR, 'SOURCES.json'), label, problems)
  if (data === undefined) return out
  if (!Array.isArray(data)) { problems.push(`${label}: expected a list`); return out }
  for (const [i, raw] of data.entries()) {
    const e = raw as Partial<LogoSource> | null
    if (e === null || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.name !== 'string' || typeof e.kind !== 'string' || typeof e.homepage !== 'string') {
      problems.push(`${label}[${i}]: needs an id, a name, a kind and a homepage`)
      continue
    }
    const href = /https?:\/\/\S+/.exec(e.repo ?? '')?.[0] ?? e.homepage
    // A language server keeps its full name, "Go (gopls)": the project credited is the server in the brackets.
    const logo: Logo = { name: e.kind === 'lsp' ? e.name : e.name.split(' (')[0] as string, href }
    const file = typeof e.logoFile === 'string' ? e.logoFile : undefined
    const mono = typeof e.monoFile === 'string' ? e.monoFile : undefined
    if (file !== undefined) {
      if (!existsSync(join(LOGO_DIR, file))) problems.push(`${label}[${i}]: ${file} is missing from site/assets/logos`)
      else logo.src = `/assets/logos/${file}`
    }
    if (out.logos.has(e.id)) problems.push(`${label}[${i}]: the id "${e.id}" is listed twice`)
    out.logos.set(e.id, logo)
    if (e.kind !== 'harness') out.credits.push(logo)
  }
  return out
}

/** Every SOURCES id the landing data names must be in SOURCES.json. */
function checkSources(home: HomeData, lang: Lang, logos: ReadonlyMap<string, Logo>, problems: string[]): void {
  const named: Array<[string, string]> = [
    ...home.harnesses.map((h, i) => [`harnesses[${i}].source`, h.source] as [string, string]),
    ...home.tools.servers.flatMap((x, i) => x.source !== undefined ? [[`tools.servers[${i}].source`, x.source] as [string, string]] : []),
    ...home.tools.strip.map((x, i) => [`tools.strip[${i}].source`, x.source] as [string, string]),
  ]
  for (const [where, id] of named) if (!logos.has(id)) problems.push(`${lang}/home.json ${where}: "${id}" is not an id of site/assets/logos/SOURCES.json`)
}

// ---------------------------------------------------------------------------------------------------------------
// Docs pages

function frontMatter(raw: string, file: string, problems: string[]): { meta: Record<string, string>, body: string } | undefined {
  const text = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n')
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text)
  if (!m) { problems.push(`${file}: starts without front matter (--- title, description, order ---)`); return undefined }
  const meta: Record<string, string> = {}
  for (const line of (m[1] ?? '').split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line)
    if (!kv) { problems.push(`${file}: front matter line "${line}" is not "key: value"`); continue }
    const key = kv[1] as string
    let value = (kv[2] ?? '').trim()
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1)
    if (!(FRONT_KEYS as readonly string[]).includes(key)) problems.push(`${file}: front matter key "${key}" is not one of ${FRONT_KEYS.join(', ')}`)
    meta[key] = value
  }
  return { meta, body: m[2] ?? '' }
}

function renderMarkdown(body: string, file: string, ui: UiData, problems: string[]): { html: string, headings: Heading[] } {
  const raw = Bun.markdown.html(body, { noHtmlBlocks: true, noHtmlSpans: true, autolinks: { url: true, www: true, email: false } })
  const seen = new Map<string, number>()
  const headings: Heading[] = []
  let html = raw.replace(/<h([1-6])>([\s\S]*?)<\/h\1>/g, (_m, lvl: string, inner: string) => {
    const level = Number(lvl)
    if (level === 1) problems.push(`${file}: a level-one heading ("# ${textOf(inner)}"); the page title comes from the front matter, start at ##`)
    const base = slugify(textOf(inner))
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    const id = n === 0 ? base : `${base}-${n}`
    if (level === 2 || level === 3) headings.push({ level, id, text: textOf(inner) })
    return `<h${level} id="${escapeHtml(id)}">${inner}</h${level}>`
  })
  if (/<img\b/.test(html)) problems.push(`${file}: images are not part of the docs contract`)
  // Tables scroll sideways inside their own region; code blocks get a copy button.
  html = html.replace(/<table>/g, `<div class="table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(ui.docs.table)}"><table>`).replace(/<\/table>/g, '</table></div>')
  html = html.replace(/<pre><code( class="language-[^"]*")?>([\s\S]*?)<\/code><\/pre>/g, (_m, cls: string | undefined, code: string) =>
    `<div class="code"><pre tabindex="0" aria-label="${escapeHtml(ui.docs.code)}"><code${cls ?? ''}>${code}</code></pre>${copyButton(ui)}</div>`)
  return { html, headings }
}

function loadDocs(content: string, lang: Lang, ui: UiData, problems: string[]): DocPage[] {
  const dir = join(content, lang)
  let names: string[] = []
  try { names = readdirSync(dir).filter(n => n.endsWith('.md')).sort() } catch { return [] }
  const pages: DocPage[] = []
  for (const name of names) {
    const slug = name.slice(0, -3)
    const file = `${lang}/${name}`
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || RESERVED.has(slug)) { problems.push(`${file}: the file name must be a lower-case slug other than ${[...RESERVED].join(', ')}`); continue }
    const fm = frontMatter(readFileSync(join(dir, name), 'utf8'), file, problems)
    if (!fm) continue
    const missing = FRONT_KEYS.filter(k => (fm.meta[k] ?? '') === '')
    for (const k of missing) problems.push(`${file}: front matter needs "${k}"`)
    const order = Number(fm.meta['order'])
    if (fm.meta['order'] !== undefined && fm.meta['order'] !== '' && (!Number.isInteger(order) || !/^-?\d+$/.test(fm.meta['order']))) problems.push(`${file}: front matter "order" must be a whole number, not "${fm.meta['order']}"`)
    const { html, headings } = renderMarkdown(fm.body, file, ui, problems)
    pages.push({ lang, slug, file, title: fm.meta['title'] ?? slug, description: fm.meta['description'] ?? '', order: Number.isInteger(order) ? order : 0, html, headings })
  }
  pages.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug))
  for (let i = 1; i < pages.length; i++) {
    const [a, b] = [pages[i - 1] as DocPage, pages[i] as DocPage]
    if (a.order === b.order) problems.push(`${b.file}: order ${b.order} is also the order of ${a.file}`)
  }
  return pages
}

const docPath = (lang: Lang, slug: string): string => `${lang === 'en' ? '' : `/${lang}`}/${slug}/`
const homePath = (lang: Lang): string => (lang === 'en' ? '/' : `/${lang}/`)
const twinOf = (lang: Lang): Lang => (lang === 'en' ? 'tr' : 'en')

/** Finds the heading an anchor names, exactly or by the looser key; undefined when the page has none. */
function findAnchor(page: DocPage, fragment: string): string | undefined {
  if (allIds(page).has(fragment)) return fragment
  const key = anchorKey(fragment)
  const hits = [...allIds(page)].filter(id => anchorKey(id) === key)
  return hits.length === 1 ? hits[0] : undefined
}

const idCache = new WeakMap<DocPage, Set<string>>()
function allIds(page: DocPage): Set<string> {
  let ids = idCache.get(page)
  if (!ids) {
    ids = new Set([...page.html.matchAll(/<h[1-6] id="([^"]*)"/g)].map(m => decodeEntities(m[1] as string)))
    idCache.set(page, ids)
  }
  return ids
}

/**
 * Rewrites one href written in the content: `x.md` and `x.md#y` to the page URL in `lang`, `#y` to the real heading
 * id, root paths and external URLs as they are (root paths are checked against the output at the end).
 */
function resolveHref(href: string, lang: Lang, from: DocPage | undefined, bySlug: Map<string, DocPage>, file: string, problems: string[], rootLinks: Array<{ file: string, path: string }>): string {
  const decoded = safeDecode(href)
  if (/^[a-z][a-z0-9+.-]*:/i.test(decoded)) return href
  if (decoded.startsWith('/')) { rootLinks.push({ file, path: decoded.split('#')[0]?.split('?')[0] ?? decoded }); return decoded }
  const hash = decoded.indexOf('#')
  const pathPart = hash === -1 ? decoded : decoded.slice(0, hash)
  const fragment = hash === -1 ? undefined : decoded.slice(hash + 1)
  if (pathPart === '') {
    if (from === undefined) { problems.push(`${file}: the anchor "${decoded}" has no page to point into`); return decoded }
    const id = fragment === undefined || fragment === '' ? undefined : findAnchor(from, fragment)
    if (id === undefined) { problems.push(`${file}: the link "${decoded}" names no heading on this page`); return decoded }
    return `#${id}`
  }
  const m = /^(?:\.\/)?([a-z0-9-]+)\.md$/.exec(pathPart)
  if (!m) { problems.push(`${file}: the link "${decoded}" is neither another page (x.md), an anchor (#y), a site path (/x/) nor a full URL`); return decoded }
  const target = bySlug.get(m[1] as string)
  if (target === undefined) { problems.push(`${file}: the link "${decoded}" points to ${lang}/${m[1]}.md, which does not exist`); return decoded }
  if (fragment === undefined || fragment === '') return docPath(lang, target.slug)
  const id = findAnchor(target, fragment)
  if (id === undefined) { problems.push(`${file}: the link "${decoded}" names a heading that ${target.file} does not have`); return docPath(lang, target.slug) }
  return `${docPath(lang, target.slug)}#${id}`
}

// ---------------------------------------------------------------------------------------------------------------
// Files

function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string): void => {
    for (const n of readdirSync(d).sort()) {
      if (n.startsWith('.')) continue
      const p = join(d, n)
      if (statSync(p).isDirectory()) walk(p)
      else out.push(relative(dir, p).split(sep).join('/'))
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

function prepareOut(out: string): void {
  if (!existsSync(out)) { mkdirSync(out, { recursive: true }); return }
  const entries = readdirSync(out)
  if (entries.length === 0) return
  const built = entries.includes('CNAME') && entries.includes('index.html') && readFileSync(join(out, 'CNAME'), 'utf8').trim() === DOMAIN
  if (!built) throw new SiteBuildError([`${out} is not a site build (no CNAME for ${DOMAIN} and no index.html); refusing to clear it, pick an empty or new folder`])
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
}

// ---------------------------------------------------------------------------------------------------------------
// The build

export async function buildSite(opts: SiteBuildOptions): Promise<SiteBuildResult> {
  const out = resolve(opts.out)
  const content = resolve(opts.content ?? join(SITE_DIR, 'content'))
  const mediaDir = resolve(opts.media ?? join(SITE_DIR, 'media'))
  const problems: string[] = []

  const homes = new Map<Lang, HomeData>()
  const uis = new Map<Lang, UiData>()
  for (const lang of LANGS) {
    const home = loadHome(content, lang, problems)
    const ui = loadUi(content, lang, problems)
    if (home) homes.set(lang, home)
    if (ui) uis.set(lang, ui)
  }
  const { logos, credits, derived } = loadLogos(problems)
  for (const [lang, home] of homes) checkSources(home, lang, logos, problems)
  if (problems.length > 0) throw new SiteBuildError(problems)

  const docs = new Map<Lang, DocPage[]>()
  for (const lang of LANGS) docs.set(lang, loadDocs(content, lang, uis.get(lang) as UiData, problems))

  // The same slugs in both languages.
  for (const lang of LANGS) {
    const twin = twinOf(lang)
    const other = new Set((docs.get(twin) ?? []).map(p => p.slug))
    for (const p of docs.get(lang) ?? []) if (!other.has(p.slug)) problems.push(`${twin}/${p.slug}.md is missing: ${p.file} has no twin in the other language`)
  }
  for (const lang of LANGS) if ((docs.get(lang) ?? []).length === 0) problems.push(`${lang}/: no docs pages (<slug>.md)`)

  // Links, in the docs and in the landing data.
  const rootLinks: Array<{ file: string, path: string }> = []
  for (const lang of LANGS) {
    const pages = docs.get(lang) ?? []
    const bySlug = new Map(pages.map(p => [p.slug, p]))
    for (const page of pages) {
      page.html = page.html.replace(/<a href="([^"]*)"/g, (_m, href: string) => `<a href="${escapeHtml(resolveHref(decodeEntities(href), lang, page, bySlug, page.file, problems, rootLinks))}"`)
    }
    const home = homes.get(lang) as HomeData
    home.hero.docs.href = resolveHref(home.hero.docs.href, lang, undefined, bySlug, `${lang}/home.json hero.docs.href`, problems, rootLinks)
    home.loops.cases.href = resolveHref(home.loops.cases.href, lang, undefined, bySlug, `${lang}/home.json loops.cases.href`, problems, rootLinks)
  }

  // Media, per language.
  const mediaFiles = listFiles(mediaDir)
  const media = new Map<Lang, Media>()
  for (const lang of LANGS) {
    const home = homes.get(lang) as HomeData
    media.set(lang, {
      ...(mediaFiles.includes(home.video.src) ? { video: `/media/${home.video.src}` } : {}),
      ...(mediaFiles.includes(home.video.poster) ? { poster: `/media/${home.video.poster}` } : {}),
    })
  }

  // Repository files the site serves.
  const copies: Array<{ to: string, from: string }> = [
    { to: 'install.sh', from: join(REPO, 'scripts', 'install.sh') },
    { to: 'assets/favicon.svg', from: join(REPO, 'src', 'memory', 'ui', 'favicon.svg') },
    ...['buracle-dark.svg', 'buracle-light.svg'].map(f => ({ to: `assets/${f}`, from: join(REPO, 'assets', f) })),
    ...listFiles(join(SITE_DIR, 'assets')).map(f => ({ to: `assets/${f}`, from: join(SITE_DIR, 'assets', f) })),
    ...mediaFiles.map(f => ({ to: `media/${f}`, from: join(mediaDir, f) })),
  ]
  for (const c of copies) if (!existsSync(c.from)) problems.push(`${relative(REPO, c.from)}: missing, the site serves it at /${c.to}`)
  if (problems.length > 0) throw new SiteBuildError(problems)

  // Render.
  const html = new Map<string, string>()
  const firstDoc = (lang: Lang): string => docPath(lang, (docs.get(lang) as DocPage[])[0]?.slug ?? '')
  // The share image is the film's poster; a build without the media falls back to the favicon.
  const image = (lang: Lang): string => `${SITE_URL}${media.get(lang)?.poster ?? '/assets/favicon.svg'}`
  const context = (lang: Lang, path: string, twinPath: string, title: string, description: string, type: PageContext['type']): PageContext => ({
    lang, ui: uis.get(lang) as UiData, twinUi: uis.get(twinOf(lang)) as UiData, path, twinPath, title, description, image: image(lang), type, docsPath: firstDoc(lang),
  })
  for (const lang of LANGS) {
    const home = homes.get(lang) as HomeData
    const hasCredits = (docs.get(lang) as DocPage[]).some(p => p.slug === 'credits')
    const extras: LandingExtras = { logos, credits, ...(hasCredits ? { creditsPath: docPath(lang, 'credits') } : {}) }
    html.set(homePath(lang), landingPage(context(lang, homePath(lang), homePath(twinOf(lang)), home.title, home.description, 'website'), home, media.get(lang) ?? {}, extras))
    const pages = docs.get(lang) as DocPage[]
    pages.forEach((page, i) => {
      const ctx = context(lang, docPath(lang, page.slug), docPath(twinOf(lang), page.slug), `${page.title} | ${(uis.get(lang) as UiData).siteName}`, page.description, 'article')
      html.set(ctx.path, docsPage(ctx, page, pages, { ...(i > 0 ? { prev: pages[i - 1] as DocPage } : {}), ...(i < pages.length - 1 ? { next: pages[i + 1] as DocPage } : {}) }, `${REPO_URL}/edit/dev/site/content/${page.file}`))
    })
  }

  const written = new Map<string, string | Uint8Array>()
  for (const [path, page] of html) written.set(`${path.slice(1)}index.html`, page)
  written.set('404.html', notFoundPage(uis.get('en') as UiData, uis.get('tr') as UiData, { en: firstDoc('en'), tr: firstDoc('tr') }))
  written.set('CNAME', `${DOMAIN}\n`)
  written.set('robots.txt', `User-agent: *\nAllow: /\n\nSitemap: ${SITE_URL}/sitemap.xml\n`)
  written.set('sitemap.xml', sitemap([homePath('en'), ...(docs.get('en') as DocPage[]).map(p => docPath('en', p.slug))]))
  for (const c of copies) written.set(c.to, new Uint8Array(readFileSync(c.from)))
  for (const [to, text] of derived) written.set(to, text)

  // Root paths named in the content must be files of this build.
  const servable = new Set([...written.keys()].map(k => `/${k}`))
  for (const p of html.keys()) servable.add(p)
  for (const l of rootLinks) if (!servable.has(l.path) && !servable.has(`${l.path.replace(/\/?$/, '/')}`)) problems.push(`${l.file}: the link "${l.path}" names nothing the site serves`)
  if (problems.length > 0) throw new SiteBuildError(problems)

  prepareOut(out)
  const files = [...written.keys()].sort()
  for (const f of files) {
    const target = join(out, f)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, written.get(f) as string | Uint8Array)
  }
  return { files, pages: [...html.keys()].sort() }
}

function sitemap(enPaths: string[]): string {
  const twin = (p: string): string => (p === '/' ? '/tr/' : `/tr${p}`)
  const urls = enPaths.flatMap(p => [p, twin(p)].map(loc => [
    '  <url>',
    `    <loc>${SITE_URL}${loc}</loc>`,
    `    <xhtml:link rel="alternate" hreflang="en" href="${SITE_URL}${p}"/>`,
    `    <xhtml:link rel="alternate" hreflang="tr" href="${SITE_URL}${twin(p)}"/>`,
    `    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE_URL}${p}"/>`,
    '  </url>',
  ].join('\n')))
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${urls.join('\n')}\n</urlset>\n`
}

// ---------------------------------------------------------------------------------------------------------------
// Command line

const USAGE = `usage: bun site/build.ts [--out <dir>] [--content <dir>] [--media <dir>]

  --out      output folder (default site/dist); cleared first when it holds an earlier site build
  --content  content folder with <lang>/home.json, <lang>/ui.json and <lang>/<slug>.md (default site/content)
  --media    folder copied to /media/ when it exists (default site/media)
`

export async function main(argv: readonly string[]): Promise<number> {
  const opts: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--help' || a === '-h') { process.stdout.write(USAGE); return 0 }
    const m = /^--(out|content|media)(?:=(.*))?$/.exec(a)
    if (!m) { process.stderr.write(`site/build.ts: unknown argument "${a}"\n${USAGE}`); return 2 }
    const value = m[2] ?? argv[++i]
    if (value === undefined || value === '') { process.stderr.write(`site/build.ts: ${a} needs a value\n`); return 2 }
    opts[m[1] as string] = value
  }
  const out = resolve(opts['out'] ?? join(SITE_DIR, 'dist'))
  try {
    const r = await buildSite({ out, ...(opts['content'] !== undefined ? { content: opts['content'] } : {}), ...(opts['media'] !== undefined ? { media: opts['media'] } : {}) })
    process.stdout.write(`site: ${r.pages.length} pages, ${r.files.length} files in ${relative(process.cwd(), out) || '.'}\n`)
    return 0
  } catch (e) {
    process.stderr.write(`site/build.ts: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)))
