// The data the templates render: the landing copy (site/content/<lang>/home.json), the UI strings (ui.json) and the
// docs pages (site/content/<lang>/<slug>.md). site/build.ts checks every field before a template sees it.

export type Lang = 'en' | 'tr'

export interface Link { text: string, href: string }

/** One harness as the landing page shows it: its logo (an id of site/assets/logos/SOURCES.json) and how Buracle Stack plugs in. */
export interface HarnessCard { id: string, name: string, source: string, folder: string, files: string[], plugs: string, invoke: string }
export interface Phase { name: string, detail?: string, gate?: boolean }
export interface Loop { command: string, when: string, phases: Phase[], loopBack?: { from: number, to: number, text: string }, example: string }
/** One MCP server of canonical/mcp.yaml: its logo source, the project behind it, what it adds and a question routing sends to it. */
export interface Server { id: string, source?: string, by: string, adds: string, q: string }

/**
 * One memory of the example brain. `layer` picks the hemisphere (the project brain or the person brain); `written` and
 * `recalled` are harness ids: the agent that wrote the memory and the one that found it in a later session.
 */
export interface BrainMemory { id: string, kind: string, layer: 'project' | 'person', title: string, origin: 'explicit' | 'inferred', written: string, recalled: string, files?: string[] }

/** One guard example: the command (a shell command or the path of a write) and the answer Buracle Stack's hooks give it. */
export interface Guard { verdict: 'deny' | 'ask', tool: 'shell' | 'write', command: string, label: string }

export interface HomeData {
  title: string
  description: string
  hero: { eyebrow: string, title: string, lede: string, installLabel: string, command: string, docs: Link, film: string, orbitLabel: string, pick: string, invoke: string }
  harnesses: HarnessCard[]
  numbers: { label: string, items: Array<{ value: number, label: string }> }
  video: { eyebrow: string, label: string, src: string, poster: string }
  memory: {
    eyebrow: string, title: string, body: string[], example: string, label: string, listLabel: string,
    project: { name: string, sub: string }, person: { name: string, sub: string },
    card: { kind: string, origin: string, explicit: string, inferred: string, cites: string, written: string, recalled: string },
    memories: BrainMemory[]
  }
  loops: { eyebrow: string, title: string, sub: string, tabsLabel: string, when: string, phasesLabel: string, example: string, footnote: string, cases: Link, items: Loop[] }
  tools: {
    eyebrow: string, title: string, sub: string, routerLabel: string, ask: string,
    servers: Server[], stripLabel: string, strip: Array<{ source: string, name: string }>,
    guards: { title: string, items: Guard[] }
  }
  close: { title: string, command: string }
  credits: { title: string, body: string, link: string }
}

/** One entry of site/assets/logos/SOURCES.json: an upstream project or a harness and its logo files. */
export interface LogoSource {
  id: string
  name: string
  kind: string
  homepage: string
  repo: string | null
  projectLicense: string
  logoFile: string | null
  monoFile?: string | null
  onDark: string
}

/** A logo as a page shows it: the file under /assets/logos/ that reads on a dark tile, or no file (the name is shown as text). */
export interface Logo { name: string, href: string, src?: string }

/** What the landing page needs beyond home.json: the logos by SOURCES id and the credits page. */
export interface LandingExtras {
  logos: ReadonlyMap<string, Logo>
  /** Every upstream project of SOURCES.json that is not a harness, in file order. */
  credits: readonly Logo[]
  /** The site path of the credits page in this language, or undefined when the docs have no `credits` page. */
  creditsPath?: string
}

export interface UiData {
  lang: Lang
  locale: string
  name: string
  siteName: string
  skip: string
  home: string
  nav: { label: string, docs: string, github: string }
  language: { label: string, hint: string }
  theme: { toDark: string, toLight: string }
  copy: string
  copied: string
  copyFailed: string
  copyLabel: string
  motion: { pause: string, play: string }
  docs: { label: string, menu: string, onThisPage: string, edit: string, pager: string, prev: string, next: string, table: string, code: string }
  footer: { label: string, license: string, source: string, issues: string, releases: string }
  notFound: { title: string, body: string, home: string, docs: string }
}

export interface Heading { level: 2 | 3, id: string, text: string }

export interface DocPage {
  lang: Lang
  slug: string
  /** The source file, relative to the content folder (`en/install.md`), for messages. */
  file: string
  title: string
  description: string
  order: number
  html: string
  headings: Heading[]
}

/** The media files that exist for one language (URLs under /media/), or undefined when a file is missing. */
export interface Media { video?: string, poster?: string }

export interface PageContext {
  lang: Lang
  ui: UiData
  /** The other language's UI strings: the language switch is written in that language. */
  twinUi: UiData
  /** The site path of this page (`/`, `/install/`, `/tr/install/`). */
  path: string
  /** The site path of the same page in the other language. */
  twinPath: string
  title: string
  description: string
  /** Absolute URL of the share image. */
  image: string
  type: 'website' | 'article'
  /** The site path of the first docs page in this language: the Docs link. */
  docsPath: string
}

export const SITE_URL = 'https://stack.buracle.dev'
export const REPO_URL = 'https://github.com/burakarslan0110/Buracle-Stack'
