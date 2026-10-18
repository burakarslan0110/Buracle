import { normalizePath, resolvePath } from '../events'
import type { ConfigParsers, WriteContent } from './switch-off'
import { guardedFile, switchOffChange } from './switch-off'

export type { ConfigParsers, GuardedFile, GuardedKind, WriteContent } from './switch-off'
export { guardedFile } from './switch-off'

export interface WriteGuardContext {
  cwd: string
  home: string
  vault: string
  protect: string[]
  buracleRepo?: string
  realpath?: (p: string) => string | undefined
  selfPaths?: SelfPaths
  contents?: Readonly<Record<string, WriteContent>>
  parsers?: ConfigParsers
}

export interface SelfPaths {
  buracleHome?: string
  localBinDir?: string
  claudeDir?: string
  codexHome?: string
  opencodeConfigDir?: string
  ompAgentDir?: string
  ompHome?: string
  repo?: string
}

export type SelfArea = 'buracle' | 'shim' | 'claude' | 'codex' | 'opencode' | 'omp' | 'repo'

interface SelfLayout { key: Exclude<keyof SelfPaths, 'repo'>; under: string; entries: readonly string[]; area: SelfArea }
type SelfRoot = { root: string, layout: SelfLayout }

const SELF_LAYOUT: readonly SelfLayout[] = [
  { key: 'buracleHome', under: '.buracle', entries: [''], area: 'buracle' },
  { key: 'localBinDir', under: '.local/bin', entries: ['buracle', 'buracle.cmd'], area: 'shim' },
  { key: 'claudeDir', under: '.claude', entries: ['settings.json', 'settings.local.json', 'plugins/'], area: 'claude' },
  { key: 'codexHome', under: '.codex', entries: ['config.toml', 'hooks.json', 'rules/'], area: 'codex' },
  { key: 'opencodeConfigDir', under: '.config/opencode', entries: [''], area: 'opencode' },
  { key: 'ompAgentDir', under: '.omp/agent', entries: ['config.yml', 'config.yaml', 'settings.json', 'extensions/', 'hooks/'], area: 'omp' },
  { key: 'ompHome', under: '.omp', entries: ['plugins/'], area: 'omp' },
]

const HOME_PREFIX = /^\/(?:(?:users|home)\/[^/]+|root|var\/root)(?=\/|$)/i

const SELF_TEXT: Readonly<Record<SelfArea, { what: string, remedy: string }>> = {
  buracle: { what: "Buracle's own installation, which runs every guard hook", remedy: 'change Buracle through the buracle CLI (`buracle config set …`, `buracle install`) instead' },
  shim: { what: 'the `buracle` command on PATH, a link to the shim that runs every guard hook', remedy: '`buracle install` manages it, so ask the user to run that instead' },
  claude: { what: "Claude Code's own configuration, which registers Buracle's guard hooks", remedy: "ask the user to make this change themselves, or use Claude Code's own commands (`claude plugin …`, `claude mcp …`, `/config`)" },
  codex: { what: "Codex's own configuration, which registers Buracle's guard hooks", remedy: "ask the user to make this change themselves, or use Codex's own commands (`codex mcp …`, `codex features …`)" },
  opencode: { what: "OpenCode's own configuration, which loads Buracle's guard plugin", remedy: "ask the user to make this change themselves, or use OpenCode's own commands (`opencode mcp …`, `opencode plugin …`)" },
  omp: { what: "omp's own configuration, which loads Buracle's guard extension", remedy: "ask the user to make this change themselves, or use omp's own commands (`omp config set …`, `omp plugin …`)" },
  repo: { what: "Buracle's own source code, which every Buracle hook runs", remedy: 'change it from a session opened in the Buracle repository, or ask the user to make the change' },
}

export function selfProtectionText(area: SelfArea): { what: string, remedy: string } {
  return SELF_TEXT[area]
}

function usableRoot(root: string, layout: SelfLayout, home: string, cwd: string): boolean {
  if (root === '/' || !root.startsWith('/')) return false
  if (!layout.entries.includes('')) return true
  return (home === '' || !within(home, root)) && (cwd === '' || !within(cwd, root))
}

function selfRoots(homes: readonly string[], self: SelfPaths | undefined, cwd: string): SelfRoot[] {
  const out: SelfRoot[] = []
  for (const layout of SELF_LAYOUT) {
    for (const h of homes) out.push({ root: `${h}/${layout.under}`, layout })
    const given = self !== null && typeof self === 'object' ? self[layout.key] : undefined
    if (typeof given !== 'string' || !given.startsWith('/')) continue
    const g = normalizePath(given)
    if (usableRoot(g, layout, homes[0] ?? '', cwd) && !out.some(r => r.layout === layout && lower(r.root) === lower(g))) out.push({ root: g, layout })
  }
  return out
}

function repoRoot(self: SelfPaths | undefined, home: string): string | undefined {
  const given = self !== null && typeof self === 'object' ? self.repo : undefined
  if (typeof given !== 'string' || !given.startsWith('/')) return undefined
  const r = normalizePath(given)
  if (r === '/' || !r.startsWith('/') || (home !== '' && within(home, r))) return undefined
  return r
}

function unrelated(cwd: string, repo: string): boolean {
  return cwd.startsWith('/') && !within(cwd, repo) && !within(repo, cwd)
}

function hitsRoot(abs: string, root: string, entries: readonly string[], ancestor: boolean): boolean {
  for (const e of entries) {
    const loc = e === '' ? root : `${root}/${e.replace(/\/$/, '')}`
    const folder = e === '' || e.endsWith('/')
    if (folder ? within(abs, loc) : lower(abs) === lower(loc)) return true
    if (ancestor && within(loc, abs)) return true
  }
  return false
}

function selfHit(abs: string, home: string, self: SelfPaths | undefined, ancestor: boolean, cwd = '', extra: readonly SelfRoot[] = []): { area: SelfArea, root: string } | undefined {
  const homes: string[] = []
  const h = home !== '' ? normalizePath(home) : ''
  if (h.startsWith('/') && h !== '/') homes.push(h)
  const named = HOME_PREFIX.exec(abs)?.[0]
  if (named !== undefined && !homes.some(x => lower(x) === lower(named))) homes.push(named)
  for (const { root, layout } of [...selfRoots(homes, self, cwd), ...extra]) {
    if (hitsRoot(abs, root, layout.entries, ancestor)) return { area: layout.area, root }
  }
  const repo = repoRoot(self, homes[0] ?? '')
  if (repo !== undefined && unrelated(cwd, repo) && (within(abs, repo) || (ancestor && within(repo, abs)))) return { area: 'repo', root: repo }
  return undefined
}

export function selfProtectedArea(abs: string, home: string, self?: SelfPaths, ancestor = false, cwd?: string): SelfArea | undefined {
  if (typeof abs !== 'string' || !abs.startsWith('/')) return undefined
  const session = typeof cwd === 'string' && cwd.startsWith('/') ? normalizePath(cwd) : ''
  return selfHit(normalizePath(abs), typeof home === 'string' ? home : '', self, ancestor, session)?.area
}

const TEMPLATE_SUFFIX = /\.(?:example|sample|template|dist|defaults)$/i
const SOURCE_OR_DOC = /\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts|py|pyi|go|rs|java|kt|kts|swift|rb|php|cs|c|h|cc|cpp|hpp|scala|dart|ex|exs|lua|sh|md|mdx|rst|txt|html|css)$/i
const GENERATED_HARNESS = /^(.*)\/harness\/(?:claude|codex|opencode|omp|agents-skills)(?:\/|$)/

function expandHome(p: string, home: string): string {
  if (home === '') return p
  if (p === '~') return home
  if (p.startsWith('~/')) return home.replace(/\/+$/, '') + p.slice(1)
  return p
}

function absolute(p: string, cwd: string, home: string): string | undefined {
  if (typeof p !== 'string' || p.trim() === '') return undefined
  return resolvePath(cwd, expandHome(p.trim(), home))
}

function lower(s: string): string { return s.toLowerCase() }

function within(p: string, dir: string): boolean {
  if (dir === '' || dir === '/') return dir === '/'
  const a = lower(p)
  const b = lower(dir.replace(/\/+$/, ''))
  return a === b || a.startsWith(b + '/')
}

function shown(p: string, home: string): string {
  if (home !== '' && within(p, home) && p.length > home.length) return '~' + p.slice(home.replace(/\/+$/, '').length)
  return p
}

function code(s: string): string { return '`' + s.replace(/`/g, "'") + '`' }

const CREDENTIAL_FOLDER = /^\/(?:(?:users|home)\/[^/]+|root|var\/root)\/\.(ssh|aws|gnupg)(?:\/|$)/i
const CREDENTIAL_WHAT: Readonly<Record<string, string>> = { ssh: "the user's SSH directory", aws: "the user's AWS credentials directory", gnupg: "the user's GnuPG directory" }

const CREDENTIAL_STORES: readonly string[] = ['.netrc', '.git-credentials', '.npmrc', '.pypirc', '.docker/config.json', '.kube/config', '.config/gh/hosts.yml', '.config/gcloud/', '.azure/']

function credentialStore(abs: string, home: string): string | undefined {
  const homes = [home, HOME_PREFIX.exec(abs)?.[0] ?? ''].filter(h => h.startsWith('/') && h !== '/')
  for (const h of homes) {
    for (const store of CREDENTIAL_STORES) {
      const loc = `${h}/${store.replace(/\/$/, '')}`
      const shownStore = `~/${store}`
      if (store.endsWith('/') ? within(abs, loc) : lower(abs) === lower(loc)) return `is one of the user's credential stores (${shownStore})`
      if (within(loc, abs)) return `holds one of the user's credential stores (${shownStore})`
    }
  }
  return undefined
}

export function credentialLocation(path: string, ctx: { cwd: string, home: string }): string | undefined {
  if (typeof path !== 'string' || ctx === null || typeof ctx !== 'object') return undefined
  const home = typeof ctx.home === 'string' && ctx.home !== '' ? normalizePath(ctx.home) : ''
  const abs = absolute(path, typeof ctx.cwd === 'string' ? ctx.cwd : '', home)
  if (abs === undefined) return undefined
  if (home !== '') {
    for (const dir of ['ssh', 'aws', 'gnupg']) if (within(abs, `${home}/.${dir}`)) return `is in ${CREDENTIAL_WHAT[dir]}`
    if (abs.startsWith('/') && within(home, abs)) return 'holds the home folder with its credentials (~/.ssh, ~/.aws)'
  } else if (abs === '/') return 'holds every home folder with its credentials'
  const m = CREDENTIAL_FOLDER.exec(abs)
  if (m) return `is in ${CREDENTIAL_WHAT[(m[1] as string).toLowerCase()] ?? 'a credentials directory'}`
  if (abs.startsWith('/')) {
    const store = credentialStore(abs, home)
    if (store !== undefined) return store
  }
  return secretKind(abs.slice(abs.lastIndexOf('/') + 1))
}

function secretKind(base: string): string | undefined {
  const b = lower(base)
  if (TEMPLATE_SUFFIX.test(b)) return undefined
  if (b.startsWith('.env')) return 'holds environment secrets'
  if (/\.(?:pem|key|p12|pfx)$/.test(b)) return 'is a private key or certificate'
  if (/^id_(?:rsa|ed25519|ecdsa|dsa)/.test(b)) return 'is an SSH key'
  if (b.startsWith('credentials') && !SOURCE_OR_DOC.test(b)) return 'looks like a credentials file'
  return undefined
}

function escapeRe(c: string): string {
  return /[\\^$.*+?()[\]{}|/]/.test(c) ? '\\' + c : c
}

function globBody(glob: string, depth = 0): string {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string
    if (c === '\\' && i + 1 < glob.length) { re += escapeRe(glob[i + 1] as string); i++; continue }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/'
        if (atStart && glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; continue }
        re += '.*'
        i++
        continue
      }
      re += '[^/]*'
      continue
    }
    if (c === '?') { re += '[^/]'; continue }
    if (c === '[') {
      const close = glob.indexOf(']', i + 2)
      if (close > i) {
        let cls = glob.slice(i + 1, close).replace(/\\/g, '\\\\').replace(/\//g, '')
        if (cls.startsWith('!')) cls = '^' + cls.slice(1)
        re += `[${cls}]`
        i = close
        continue
      }
    }
    if (c === '{' && depth < 4) {
      const close = glob.indexOf('}', i + 1)
      if (close > i) {
        re += '(?:' + glob.slice(i + 1, close).split(',').map(a => globBody(a, depth + 1)).join('|') + ')'
        i = close
        continue
      }
    }
    re += escapeRe(c)
  }
  return re
}

const globCache = new Map<string, RegExp | null>()

export function protectGlobToRegExp(glob: string): RegExp | null {
  const hit = globCache.get(glob)
  if (hit !== undefined) return hit
  let re: RegExp | null
  try { re = new RegExp('^' + globBody(glob) + '$', 'i') } catch { re = null }
  if (globCache.size > 512) globCache.clear()
  globCache.set(glob, re)
  return re
}

function protectMatches(pattern: string, abs: string, cwd: string, home: string): boolean {
  const p = pattern.trim()
  if (p === '') return false
  if (p.startsWith('~') || p.startsWith('/')) {
    const re = protectGlobToRegExp(normalizeGlob(expandHome(p, home)))
    return re !== null && (re.test(abs) || re.test(abs + '/'))
  }
  if (p.includes('/')) {
    if (cwd === '' || !within(abs, cwd)) return false
    const rel = abs.slice(cwd.replace(/\/+$/, '').length + 1)
    const re = protectGlobToRegExp(p.replace(/^\.\//, ''))
    return re !== null && rel !== '' && re.test(rel)
  }
  const re = protectGlobToRegExp(p)
  const base = abs.slice(abs.lastIndexOf('/') + 1)
  return re !== null && re.test(base)
}

function normalizeGlob(p: string): string {
  return p.replace(/\/{2,}/g, '/').replace(/\/\.(?=\/)/g, '')
}

function buracleRepoOf(abs: string, ctx: WriteGuardContext): string | undefined {
  const cwd = ctx.cwd
  const explicit = typeof ctx.buracleRepo === 'string' && ctx.buracleRepo !== '' ? normalizePath(expandHome(ctx.buracleRepo, ctx.home)) : undefined
  if (explicit !== undefined) return cwd !== '' && within(cwd, explicit) ? explicit : undefined
  const m = GENERATED_HARNESS.exec(abs)
  if (!m) return undefined
  const root = m[1] === '' ? '/' : (m[1] as string)
  return cwd !== '' && within(cwd, root) ? root : undefined
}

interface ResolvedContext extends WriteGuardContext { selfResolved?: readonly SelfRoot[] }

function denyFor(abs: string, ctx: ResolvedContext, content?: WriteContent): string | undefined {
  const home = ctx.home ? normalizePath(ctx.home) : ''
  const show = shown(abs, home)
  const base = abs.slice(abs.lastIndexOf('/') + 1)

  if (home !== '') {
    if (within(abs, `${home}/.ssh`)) return `${code(show)} is in the user's SSH directory; ask the user to make this change themselves.`
    if (within(abs, `${home}/.aws`)) return `${code(show)} is in the user's AWS credentials directory; ask the user to make this change themselves.`
  }
  const secret = secretKind(base)
  if (secret) {
    const hint = lower(base).startsWith('.env') ? `ask the user to change it, or put placeholder values in ${code('.env.example')} instead` : 'ask the user to create or change it themselves'
    return `${code(show)} ${secret}; ${hint}.`
  }
  const self = selfHit(abs, home, ctx.selfPaths, false, ctx.cwd ? normalizePath(ctx.cwd) : '', ctx.selfResolved)
  if (self !== undefined) {
    if (self.area === 'buracle' && within(abs, `${self.root}/state`)) {
      return `${code(show)} is Buracle's own state; change it through the buracle CLI (for example ${code('buracle plan set …')} or ${code('buracle plan pause')}) instead of editing the file.`
    }
    return `${code(show)} belongs to ${SELF_TEXT[self.area].what}; ${SELF_TEXT[self.area].remedy}.`
  }
  const guarded = guardedFile(abs, home)
  if (guarded !== undefined) {
    if (content === undefined || typeof content.after !== 'string') {
      return `${code(show)} is ${guarded.what}, and Buracle cannot see what this write puts there; make the change with a file edit or whole-file write tool (apply_patch on Codex) so Buracle can check it, or ask the user to make it themselves.`
    }
    const change = switchOffChange(guarded, abs, content, ctx.parsers)
    if (change !== undefined) return `${code(show)} is ${guarded.what}, and this change ${change}; that would switch Buracle's guards off, so ask the user to make this change themselves.`
  }
  const vault = ctx.vault ? normalizePath(expandHome(ctx.vault, home)) : ''
  if (vault !== '' && vault !== '/') {
    if (within(abs, `${vault}/.obsidian`)) return `${code(show)} holds Obsidian's own settings for the vault; leave it to Obsidian and the user.`
    if (within(abs, `${vault}/.git`)) return `${code(show)} is inside the vault's git internals; use git commands (Buracle commits the vault itself) instead of writing there.`
    if (within(abs, `${vault}/.buracle`)) return `${code(show)} is Buracle's internal data inside the vault; change it through the buracle CLI instead of editing it.`
  }
  const repo = buracleRepoOf(abs, ctx)
  if (repo !== undefined && within(abs, `${repo}/harness`)) {
    return `${code(shown(abs, home))} is generated by ${code('buracle build')}; edit the source under ${code('canonical/')} (or ${code('src/')}) and run ${code('buracle build')} instead.`
  }
  for (const pattern of Array.isArray(ctx.protect) ? ctx.protect : []) {
    if (typeof pattern !== 'string') continue
    if (protectMatches(pattern, abs, ctx.cwd ? normalizePath(ctx.cwd) : '', home)) {
      return `${code(show)} matches the protected pattern ${code(pattern)} from guards.write.protect; ask the user before changing it.`
    }
  }
  return undefined
}

export function checkWrite(paths: string[], ctx: { cwd: string, home: string, vault: string, protect: string[] }): { deny?: string } {
  if (!Array.isArray(paths) || ctx === null || typeof ctx !== 'object') return {}
  const full = ctx as WriteGuardContext
  const home = typeof full.home === 'string' ? full.home : ''
  const cwd = typeof full.cwd === 'string' ? full.cwd : ''
  const resolver = typeof full.realpath === 'function' ? safeResolver(full.realpath) : undefined
  const base: WriteGuardContext = repoRule({ ...full, home, cwd }, resolver)
  let resolved: ResolvedContext | undefined
  for (const p of paths) {
    const abs = absolute(p, cwd, home)
    if (abs === undefined) continue
    const content = contentOf(full.contents, p)
    const reason = denyFor(abs, base, content)
    if (reason) return { deny: reason }
    if (resolver === undefined || !abs.startsWith('/')) continue
    resolved ??= resolvedRoots(base, resolver)
    const real = resolveTarget(abs, resolver)
    if (real !== undefined && real !== abs) {
      const why = denyFor(real, base, content) ?? denyFor(real, resolved, content)
      if (why) return { deny: `Writing ${code(shown(abs, home))} follows a symlink: ${why}` }
    }
    const direct = denyFor(abs, resolved, content)
    if (direct) return { deny: direct }
  }
  return {}
}

function contentOf(contents: WriteGuardContext['contents'], p: unknown): WriteContent | undefined {
  if (contents === null || typeof contents !== 'object' || typeof p !== 'string' || !Object.prototype.hasOwnProperty.call(contents, p)) return undefined
  const c = contents[p]
  return c !== null && typeof c === 'object' && typeof c.after === 'string' ? c : undefined
}

function repoRule(ctx: WriteGuardContext, realpath: ((p: string) => string | undefined) | undefined): WriteGuardContext {
  const self = ctx.selfPaths
  if (self === null || typeof self !== 'object' || self.repo === undefined) return ctx
  const repo = repoRoot(self, ctx.home.startsWith('/') ? normalizePath(ctx.home) : '')
  const cwd = ctx.cwd.startsWith('/') ? normalizePath(ctx.cwd) : ''
  const spellings = (p: string): string[] => {
    const r = realpath?.(p)
    return r !== undefined && lower(r) !== lower(p) ? [p, r] : [p]
  }
  if (repo !== undefined && cwd !== '' && spellings(cwd).every(c => spellings(repo).every(r => unrelated(c, r)))) return ctx
  const rest: SelfPaths = { ...self }
  delete rest.repo
  return { ...ctx, selfPaths: rest }
}

function safeResolver(fn: (p: string) => string | undefined): (p: string) => string | undefined {
  return (p: string) => {
    try {
      const r = fn(p)
      return typeof r === 'string' && r.startsWith('/') ? normalizePath(r) : undefined
    } catch {
      return undefined
    }
  }
}

function ancestors(abs: string): string[] {
  const out: string[] = []
  let cur = abs
  for (let guard = 0; guard < 256; guard++) {
    const i = cur.lastIndexOf('/')
    if (i <= 0) { if (cur !== '/') out.push('/'); break }
    cur = cur.slice(0, i)
    out.push(cur)
  }
  return out
}

function resolveTarget(abs: string, realpath: (p: string) => string | undefined): string | undefined {
  const direct = realpath(abs)
  if (direct !== undefined) return direct
  for (const dir of ancestors(abs)) {
    const r = realpath(dir)
    if (r === undefined) continue
    const rest = abs.slice(dir === '/' ? 1 : dir.length + 1)
    return normalizePath(rest === '' ? r : `${r.replace(/\/+$/, '')}/${rest}`)
  }
  return undefined
}

function contextSelfRoots(ctx: WriteGuardContext): SelfRoot[] {
  const home = typeof ctx.home === 'string' && ctx.home !== '' ? normalizePath(ctx.home) : ''
  const cwd = typeof ctx.cwd === 'string' && ctx.cwd !== '' ? normalizePath(ctx.cwd) : ''
  return selfRoots(home.startsWith('/') && home !== '/' ? [home] : [], ctx.selfPaths, cwd)
}

function resolvedRoots(ctx: WriteGuardContext, realpath: (p: string) => string | undefined): ResolvedContext {
  const home = ctx.home !== '' ? realpath(normalizePath(ctx.home)) ?? ctx.home : ''
  const vaultAbs = ctx.vault ? normalizePath(expandHome(ctx.vault, ctx.home)) : ''
  const vault = vaultAbs.startsWith('/') ? realpath(vaultAbs) ?? vaultAbs : ctx.vault
  const cwd = ctx.cwd.startsWith('/') ? realpath(normalizePath(ctx.cwd)) ?? ctx.cwd : ctx.cwd
  const out: ResolvedContext = { ...ctx, home, vault, cwd }
  if (typeof ctx.buracleRepo === 'string' && ctx.buracleRepo !== '') {
    const repo = normalizePath(expandHome(ctx.buracleRepo, ctx.home))
    out.buracleRepo = repo.startsWith('/') ? realpath(repo) ?? repo : repo
  }
  const self: SelfRoot[] = []
  const realHome = normalizePath(home)
  const realCwd = cwd.startsWith('/') ? normalizePath(cwd) : ''
  for (const r of contextSelfRoots(ctx)) {
    const real = realpath(r.root)
    if (real !== undefined && lower(real) !== lower(r.root) && usableRoot(real, r.layout, realHome, realCwd)) self.push({ root: real, layout: r.layout })
  }
  if (self.length > 0) out.selfResolved = self
  const repo = repoRoot(ctx.selfPaths, ctx.home.startsWith('/') ? normalizePath(ctx.home) : '')
  if (repo !== undefined) {
    const real = realpath(repo)
    if (real !== undefined && lower(real) !== lower(repo)) out.selfPaths = { ...ctx.selfPaths, repo: real }
  }
  return out
}

export function realpathQueries(paths: string[], ctx: { cwd: string, home: string, vault: string, protect: string[] }): string[] {
  if (!Array.isArray(paths) || ctx === null || typeof ctx !== 'object') return []
  const full = ctx as WriteGuardContext
  const home = typeof full.home === 'string' ? full.home : ''
  const cwd = typeof full.cwd === 'string' ? full.cwd : ''
  const out = new Set<string>()
  for (const p of paths) {
    const abs = absolute(p, cwd, home)
    if (abs === undefined || !abs.startsWith('/')) continue
    out.add(abs)
    for (const a of ancestors(abs)) out.add(a)
  }
  if (home.startsWith('/')) out.add(normalizePath(home))
  const vault = typeof full.vault === 'string' && full.vault !== '' ? normalizePath(expandHome(full.vault, home)) : ''
  if (vault.startsWith('/')) out.add(vault)
  if (cwd.startsWith('/')) out.add(normalizePath(cwd))
  if (typeof full.buracleRepo === 'string' && full.buracleRepo !== '') {
    const repo = normalizePath(expandHome(full.buracleRepo, home))
    if (repo.startsWith('/')) out.add(repo)
  }
  for (const r of contextSelfRoots({ ...full, home, cwd })) out.add(r.root)
  const repo = repoRoot(full.selfPaths, home.startsWith('/') ? normalizePath(home) : '')
  if (repo !== undefined) out.add(repo)
  return [...out]
}
