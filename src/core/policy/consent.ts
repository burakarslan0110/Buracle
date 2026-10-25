import type { ShellDialect } from './bash-guard'
import { visitShellCommands } from './bash-guard'
import { scanCode, type CodeLang } from './code-scan'
import { readPrompt } from './consent-words'
import { commandName, parseShell, simpleCommands, unwrap, type ShellWord } from './shell'

export type ConsentKind = 'force-push' | 'history-rewrite' | 'discard-changes' | 'branch-delete' | 'skip-hooks' | 'push' | 'publish' | 'db-destroy' | 'recursive-delete'

export const CONSENT_KINDS: readonly ConsentKind[] = ['force-push', 'history-rewrite', 'discard-changes', 'branch-delete', 'skip-hooks', 'push', 'publish', 'db-destroy', 'recursive-delete']

export interface ConsentNeed { kind: ConsentKind; summary: string; command: string }

export interface ConsentGrant { kind: ConsentKind | 'any'; until: number; uses: number; source: 'prompt' | 'ask'; targets?: string[] }

export interface ConsentState { v: 1; pending?: ConsentNeed & { at: number; targets?: string[]; kinds?: ConsentKind[] }; grants: ConsentGrant[] }

export const GRANT_TTL_MS = 20 * 60_000
export const GRANT_USES = 5
export const PENDING_TTL_MS = 30 * 60_000

export function emptyConsent(): ConsentState {
  return { v: 1, grants: [] }
}

const SUMMARY: Readonly<Record<ConsentKind, string>> = {
  'force-push': 'force-pushes, overwriting history on the remote',
  'history-rewrite': 'rewrites git history (commits can be lost)',
  'discard-changes': 'discards uncommitted work',
  'branch-delete': 'deletes a branch or tag',
  'skip-hooks': 'skips the git hooks (--no-verify)',
  push: 'pushes to a remote',
  publish: 'publishes outside this machine (a package, a release, a merge, an image)',
  'db-destroy': 'destroys database data',
  'recursive-delete': 'deletes a directory tree',
}

export const CONSENT_LABEL: Readonly<Record<ConsentKind, string>> = {
  'force-push': 'force push',
  'history-rewrite': 'rewrite git history',
  'discard-changes': 'discard uncommitted changes',
  'branch-delete': 'delete a branch or tag',
  'skip-hooks': 'skip the git hooks (--no-verify)',
  push: 'push to a remote',
  publish: 'publish outside this machine (a package, a release, a merge, an image)',
  'db-destroy': 'delete database data',
  'recursive-delete': 'delete a folder tree',
}

const DISPOSABLE = /^(?:node_modules|dist|build|out|target|coverage|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache|\.pytest_cache|__pycache__|\.mypy_cache|\.ruff_cache|\.venv|venv|tmp|\.tmp|\.gradle|\.dart_tool|\.svelte-kit|\.vercel|\.output|\.expo|DerivedData|vendor\/bundle)(?:\/.*)?$/u

function normalizePath(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

function disposable(target: string): boolean {
  const n = normalizePath(target)
  return n !== '' && DISPOSABLE.test(n)
}

function words(ws: readonly ShellWord[]): string[] {
  return ws.map(w => w.text)
}

const GIT_GLOBAL_WITH_ARG = new Set(['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix', '--attr-source', '--list-cmds'])
const GIT_CONFIG_WITH_ARG = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--fixed-value'])

function shellWords(text: string): string[] {
  const [first] = simpleCommands(parseShell(text).script)
  return first ? [...first.assigns, ...first.words].map(w => w.text) : []
}

interface GitArgs {
  longs: string[]
  shorts: Set<string>
  pos: string[]
  after: string[]
  dashdash: boolean
}

function gitArgs(rest: readonly string[], shortValue = '', longValue: readonly string[] = []): GitArgs {
  const g: GitArgs = { longs: [], shorts: new Set(), pos: [], after: [], dashdash: false }
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] as string
    if (a === '--') { g.dashdash = true; g.after.push(...rest.slice(k + 1)); break }
    if (a.startsWith('--')) {
      const name = a.slice(2).split('=')[0] as string
      g.longs.push(name)
      if (!a.includes('=') && longValue.some(l => abbrev(name, l))) k++
      continue
    }
    if (a.length > 1 && a.startsWith('-')) {
      const letters = a.slice(1)
      for (let j = 0; j < letters.length; j++) {
        const c = letters[j] as string
        g.shorts.add(c)
        if (shortValue.includes(c)) { if (j === letters.length - 1) k++; break }
      }
      continue
    }
    g.pos.push(a)
  }
  return g
}

function abbrev(name: string, option: string, min = 2): boolean {
  return name.length >= min && option.startsWith(name)
}

function hasLong(g: GitArgs, ...options: string[]): boolean {
  return g.longs.some(n => options.some(o => abbrev(n, o)))
}

function hasShort(g: GitArgs, letters: string): boolean {
  return [...letters].some(c => g.shorts.has(c))
}

function looksLikePath(p: string): boolean {
  return p === '.' || p === '..' || p.startsWith('./') || p.startsWith('../') || p.startsWith(':') || /[*?[]/u.test(p) || /\.[A-Za-z][A-Za-z0-9]*$/u.test(p)
}

function gitConfigNeeds(rest: readonly string[], depth: number): ConsentKind[] {
  const pos: string[] = []
  for (let k = 0; k < rest.length; k++) {
    const a = rest[k] as string
    if (a === '--') { pos.push(...rest.slice(k + 1)); break }
    if (a.startsWith('-') && a.length > 1) { if (GIT_CONFIG_WITH_ARG.has(a)) k++; continue }
    pos.push(a)
  }
  const at = pos[0] === 'set' || pos[0] === 'add' ? 1 : 0
  const key = pos[at]
  const value = pos[at + 1]
  if (key === undefined || value === undefined) return []
  if (/^core\.hookspath$/iu.test(key)) return ['skip-hooks']
  if (!/^alias\.[^.]+$/iu.test(key) || depth > 4) return []
  const body = value.trim()
  if (body.startsWith('!')) return consentNeeds(body.slice(1)).map(n => n.kind)
  return gitNeeds(shellWords(body), depth + 1)
}

function gitNeeds(args: readonly string[], depth = 0): ConsentKind[] {
  let i = 0
  const globals: string[] = []
  while (i < args.length) {
    const a = args[i] as string
    if (GIT_GLOBAL_WITH_ARG.has(a)) { globals.push(a, args[i + 1] ?? ''); i += 2; continue }
    if (a.startsWith('-')) { globals.push(a); i++; continue }
    break
  }
  const out: ConsentKind[] = globals.some(g => /^(?:--config-env=)?core\.hookspath=/iu.test(g)) ? ['skip-hooks'] : []
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (sub === 'config') return unique([...out, ...gitConfigNeeds(rest, depth)])
  const first = gitNeed(sub, rest)
  return unique([...out, ...(first !== undefined ? [first, ...gitAlsoNeeds(sub, rest, first)] : [])])
}

function gitAlsoNeeds(sub: string | undefined, rest: readonly string[], first: ConsentKind): ConsentKind[] {
  if (sub === 'push') {
    if (first === 'skip-hooks') return ['push']
    const g = gitArgs(rest, 'o', ['repo', 'receive-pack', 'exec', 'push-option'])
    return g.longs.some(n => abbrev(n, 'no-verify', 4)) ? ['skip-hooks'] : []
  }
  if (sub === 'commit' && first === 'skip-hooks') {
    const g = gitArgs(rest, 'mFcCt', ['message', 'file', 'reuse-message', 'reedit-message', 'fixup', 'squash', 'author', 'date', 'template', 'cleanup', 'trailer', 'pathspec-from-file'])
    return hasLong(g, 'amend') ? ['history-rewrite'] : []
  }
  return []
}

function unique<T>(xs: readonly T[]): T[] {
  return [...new Set(xs)]
}

function gitNeed(sub: string | undefined, rest: readonly string[]): ConsentKind | undefined {
  switch (sub) {
    case 'push': {
      const g = gitArgs(rest, 'o', ['repo', 'receive-pack', 'exec', 'push-option'])
      if (hasShort(g, 'n') || hasLong(g, 'dry-run')) return undefined
      const refs = [...g.pos, ...g.after]
      if (hasShort(g, 'f') || hasLong(g, 'force', 'force-with-lease', 'force-if-includes', 'mirror') || refs.some(r => /^\+./u.test(r))) return 'force-push'
      if (hasShort(g, 'd') || hasLong(g, 'delete', 'prune') || refs.some(r => /^:[^:]+$/u.test(r))) return 'branch-delete'
      if (g.longs.some(n => abbrev(n, 'no-verify', 4))) return 'skip-hooks'
      return 'push'
    }
    case 'reset': {
      const g = gitArgs(rest)
      return hasLong(g, 'hard', 'merge', 'keep') ? 'history-rewrite' : undefined
    }
    case 'rebase': {
      const g = gitArgs(rest, 'sxX', ['onto', 'strategy', 'strategy-option', 'exec'])
      if (hasLong(g, 'abort')) return 'discard-changes'
      return hasLong(g, 'continue', 'skip', 'quit', 'edit-todo', 'show-current-patch') ? undefined : 'history-rewrite'
    }
    case 'cherry-pick': case 'revert': case 'am':
      return hasLong(gitArgs(rest), 'abort') ? 'discard-changes' : undefined
    case 'commit': {
      const g = gitArgs(rest, 'mFcCt', ['message', 'file', 'reuse-message', 'reedit-message', 'fixup', 'squash', 'author', 'date', 'template', 'cleanup', 'trailer', 'pathspec-from-file'])
      if (hasShort(g, 'n') || g.longs.some(n => abbrev(n, 'no-verify', 4))) return 'skip-hooks'
      return hasLong(g, 'amend') ? 'history-rewrite' : undefined
    }
    case 'filter-branch': case 'filter-repo': return 'history-rewrite'
    case 'update-ref': return gitArgs(rest).shorts.has('d') ? 'history-rewrite' : undefined
    case 'checkout': {
      const g = gitArgs(rest, 'bB', ['orphan', 'conflict', 'pathspec-from-file'])
      if (hasShort(g, 'f') || hasLong(g, 'force')) return 'discard-changes'
      if (g.dashdash && g.after.length > 0) return 'discard-changes'
      if (hasShort(g, 'bB') || hasLong(g, 'orphan')) return undefined
      if (g.pos.length >= 2) return 'discard-changes'
      return g.pos.length === 1 && looksLikePath(g.pos[0] as string) ? 'discard-changes' : undefined
    }
    case 'switch': {
      const g = gitArgs(rest, 'cC', ['create', 'force-create', 'orphan', 'conflict'])
      return hasShort(g, 'f') || hasLong(g, 'force', 'discard-changes') ? 'discard-changes' : undefined
    }
    case 'restore': {
      const g = gitArgs(rest, 's', ['source', 'pathspec-from-file'])
      const staged = hasShort(g, 'S') || hasLong(g, 'staged')
      const worktree = hasShort(g, 'W') || hasLong(g, 'worktree')
      if (staged && !worktree) return undefined
      return g.pos.length > 0 || g.after.length > 0 ? 'discard-changes' : undefined
    }
    case 'clean': {
      const g = gitArgs(rest, 'e', ['exclude'])
      const force = hasShort(g, 'f') || hasLong(g, 'force')
      const dry = hasShort(g, 'n') || hasLong(g, 'dry-run')
      return force && !dry ? 'discard-changes' : undefined
    }
    case 'stash':
      return rest[0] === 'drop' || rest[0] === 'clear' ? 'discard-changes' : undefined
    case 'branch': {
      const g = gitArgs(rest, 'u', ['set-upstream-to'])
      return hasShort(g, 'dD') || hasLong(g, 'delete') ? 'branch-delete' : undefined
    }
    case 'tag': {
      const g = gitArgs(rest, 'mFu', ['message', 'file', 'local-user'])
      return hasShort(g, 'd') || hasLong(g, 'delete') ? 'branch-delete' : undefined
    }
    case 'merge': {
      const g = gitArgs(rest, 'msX', ['message', 'strategy', 'strategy-option', 'file'])
      if (hasLong(g, 'abort')) return 'discard-changes'
      return g.longs.some(n => abbrev(n, 'no-verify', 4)) ? 'skip-hooks' : undefined
    }
    default:
      return undefined
  }
}

const REMOVERS = new Set(['rm', 'unlink', 'shred', 'srm'])

interface NeedWalk {
  prev?: readonly ShellWord[]
  execs: string[]
  fed?: string[]
}

function findParts(args: readonly ShellWord[]): { roots: string[]; expr: ShellWord[] } {
  let k = 0
  while (k < args.length) {
    const t = (args[k] as ShellWord).text
    if (t === '-H' || t === '-L' || t === '-P' || /^-O\d*$/u.test(t)) { k++; continue }
    if (t === '-D') { k += 2; continue }
    break
  }
  const roots: string[] = []
  while (k < args.length) {
    const t = (args[k] as ShellWord).text
    if (t.startsWith('-') || t === '(' || t === '!') break
    roots.push(t)
    k++
  }
  return { roots: roots.length > 0 ? roots : ['.'], expr: args.slice(k) }
}

function findExecs(expr: readonly ShellWord[]): ShellWord[][] {
  const out: ShellWord[][] = []
  for (let k = 0; k < expr.length; k++) {
    const t = (expr[k] as ShellWord).text
    if (t !== '-exec' && t !== '-execdir' && t !== '-ok' && t !== '-okdir') continue
    const cmd: ShellWord[] = []
    k++
    while (k < expr.length && (expr[k] as ShellWord).text !== ';' && (expr[k] as ShellWord).text !== '+') { cmd.push(expr[k] as ShellWord); k++ }
    if (cmd.length > 0) out.push(cmd)
  }
  return out
}

function removesFiles(cmd: ShellWord[]): boolean {
  const u = unwrap(cmd)
  const n = commandName(u.argv[0])
  if (n !== undefined && REMOVERS.has(n)) return true
  return u.scripts.some(s => simpleCommands(parseShell(s).script).some(c => {
    const name = commandName(unwrap(c.words).argv[0])
    return name !== undefined && REMOVERS.has(name)
  }))
}

function findNeed(args: readonly ShellWord[], st: NeedWalk): ConsentKind | undefined {
  const { roots, expr } = findParts(args)
  const execs = findExecs(expr).filter(removesFiles)
  if (!expr.some(w => w.text === '-delete') && execs.length === 0) return undefined
  if (!roots.every(disposable)) return 'recursive-delete'
  for (const e of execs) st.execs.push(words(unwrap(e).argv).join(' '))
  return undefined
}

function disposableFeeder(prev: readonly ShellWord[] | undefined): boolean {
  if (prev === undefined) return false
  const name = commandName(prev[0])
  if (name === 'find') return findParts(prev.slice(1)).roots.every(disposable)
  if (name === 'echo') {
    const items = words(prev.slice(1)).filter(w => !/^-[neE]+$/u.test(w))
    return items.length > 0 && items.every(disposable)
  }
  return false
}

function removeNeed(name: string, argv: readonly ShellWord[], st: NeedWalk): ConsentKind | undefined {
  const operands: string[] = []
  let options = true
  let recursive = false
  for (const a of words(argv.slice(1))) {
    if (options && a === '--') { options = false; continue }
    if (options && a.length > 1 && a.startsWith('-')) {
      if (/^-[a-zA-Z]*[rR]/u.test(a) || a === '--recursive') recursive = true
      continue
    }
    operands.push(a)
  }
  if (REMOVERS.has(name) && (operands.length === 0 || operands.some(o => o.includes('{}')))) {
    if (!disposableFeeder(st.prev)) st.fed = words(argv)
    return undefined
  }
  if (name !== 'rm' || !recursive || operands.length === 0) return undefined
  return operands.every(disposable) ? undefined : 'recursive-delete'
}

const PYTHON = /^(?:python|pypy)(?:\d+(?:\.\d+)*)?$/u

function interpreterCode(name: string, args: readonly string[]): { lang: CodeLang; code: string[] } | undefined {
  const flagged = (lang: CodeLang, flags: RegExp): { lang: CodeLang; code: string[] } => {
    const code: string[] = []
    for (let k = 0; k < args.length; k++) {
      const a = args[k] as string
      const eq = /^(--eval|--print)=(.*)$/su.exec(a)
      if (eq !== null && lang === 'js') { code.push(eq[2] as string); continue }
      if (flags.test(a) && args[k + 1] !== undefined) { code.push(args[k + 1] as string); k++; continue }
      if (lang === 'python' && !a.startsWith('-')) break
    }
    return { lang, code }
  }
  if (PYTHON.test(name)) return flagged('python', /^-[A-Za-z]*c$/u)
  if (name === 'node' || name === 'nodejs' || name === 'bun') return flagged('js', /^(?:-e|-p|--eval|--print)$/u)
  if (name === 'deno') return args[0] === 'eval' ? { lang: 'js', code: args.slice(1).filter(a => !a.startsWith('-')).slice(0, 1) } : undefined
  if (name === 'ruby') return flagged('ruby', /^-[A-Za-z]*e$/u)
  if (name === 'perl') return flagged('perl', /^-[A-Za-z]*[eE]$/u)
  if (name === 'php') return flagged('php', /^-r$/u)
  return undefined
}

function codeDeletesTree(code: string, lang: CodeLang): boolean {
  if (typeof code !== 'string' || code.trim() === '') return false
  return scanCode(code, lang).some(op => op.kind === 'delete-tree' && (op.target === undefined || !disposable(op.target)))
}

function fedCodeDeletesTree(command: string): boolean {
  for (const c of simpleCommands(parseShell(command).script)) {
    const u = unwrap(c.words)
    const name = commandName(u.argv[0])
    if (name === undefined) continue
    const it = interpreterCode(name, words(u.argv.slice(1)))
    if (it === undefined) continue
    for (const r of c.redirects) {
      const body = r.op === '<<<' ? r.target?.text : r.op === '<<' || r.op === '<<-' ? r.body : undefined
      if (body !== undefined && codeDeletesTree(body, it.lang)) return true
    }
  }
  return false
}

const SQL_DESTROY = /\b(?:drop\s+(?:table|database|schema)|truncate\s+(?:table\s+)?[a-z_"`])/iu
const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlite3', 'sqlite', 'duckdb', 'mongosh', 'mongo', 'clickhouse-client', 'cockroach', 'sqlcmd'])

function commandNeeds(argv: readonly ShellWord[], st: NeedWalk): ConsentKind[] {
  const name = commandName(argv[0])
  if (name === 'git') {
    const all = words(argv)
    const seen = st.execs.indexOf(all.join(' '))
    if (seen >= 0) { st.execs.splice(seen, 1); return [] }
    return gitNeeds(all.slice(1))
  }
  const kind = commandNeed(argv, st)
  return kind !== undefined ? [kind] : []
}

function commandNeed(argv: readonly ShellWord[], st: NeedWalk): ConsentKind | undefined {
  const name = commandName(argv[0])
  if (name === undefined) return undefined
  const all = words(argv)
  const seen = st.execs.indexOf(all.join(' '))
  if (seen >= 0) { st.execs.splice(seen, 1); return undefined }
  if (st.fed !== undefined) {
    const fed = st.fed
    if (all.length > fed.length && fed.every((w, i) => all[i] === w)) {
      st.fed = undefined
      return all.slice(fed.length).every(disposable) ? undefined : 'recursive-delete'
    }
  }
  const args = all.slice(1)
  if ((name === 'npm' || name === 'pnpm' || name === 'yarn' || name === 'bun') && args.includes('publish') && !args.includes('--dry-run')) return 'publish'
  if (name === 'cargo' && args[0] === 'publish' && !args.includes('--dry-run')) return 'publish'
  if (name === 'gh' && ((args[0] === 'release' && args[1] === 'create') || (args[0] === 'pr' && args[1] === 'merge'))) return 'publish'
  if ((name === 'docker' || name === 'podman') && (args[0] === 'push' || (args[0] === 'image' && args[1] === 'push'))) return 'publish'
  if (name === 'dropdb') return 'db-destroy'
  if ((name === 'prisma' || (name === 'npx' && args[0] === 'prisma') || (name === 'bunx' && args[0] === 'prisma')) && args.includes('migrate') && args.includes('reset')) return 'db-destroy'
  if ((name === 'rails' || name === 'rake' || name === 'bin/rails') && args.some(a => /^db:(?:drop|reset|purge|schema:load)$/u.test(a))) return 'db-destroy'
  if (DB_CLIENTS.has(name) && SQL_DESTROY.test(args.join(' '))) return 'db-destroy'
  if (name === 'find') return findNeed(argv.slice(1), st)
  if (REMOVERS.has(name) || name === 'rmdir') return removeNeed(name, argv, st)
  const it = interpreterCode(name, args)
  if (it !== undefined && it.code.some(code => codeDeletesTree(code, it.lang))) return 'recursive-delete'
  return undefined
}

// shell names the dialect when the harness knows it (the Claude Code PowerShell tool).
export interface ConsentOptions { shell?: ShellDialect }

export function consentNeeded(command: string, opts?: ConsentOptions): ConsentNeed | undefined {
  return consentNeeds(command, opts)[0]
}

export function consentNeeds(command: string, opts?: ConsentOptions): ConsentNeed[] {
  if (typeof command !== 'string') return []
  const kinds: ConsentKind[] = []
  try {
    const st: NeedWalk = { execs: [] }
    visitShellCommands(command, argv => {
      kinds.push(...commandNeeds(argv, st))
      st.prev = argv
      return false
    }, opts !== null && typeof opts === 'object' && opts.shell !== undefined ? { shell: opts.shell } : undefined)
    if (st.fed !== undefined) kinds.push('recursive-delete')
    if (SQL_DESTROY.test(command) && /\b(?:psql|mysql|mariadb|sqlite3?|duckdb|mongosh|sqlcmd)\b/u.test(command)) kinds.push('db-destroy')
    if (!kinds.includes('recursive-delete') && /<</u.test(command) && fedCodeDeletesTree(command)) kinds.push('recursive-delete')
  } catch {  }
  const shown = command.length > 300 ? `${command.slice(0, 297)}...` : command
  return unique(kinds).map(kind => ({ kind, summary: SUMMARY[kind], command: shown }))
}

function fnv1a(s: string, seed: number): string {
  let h = seed >>> 0
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

export function commandTarget(command: string): string {
  const t = typeof command === 'string' ? command.replace(/\s+/gu, ' ').trim() : ''
  return `${fnv1a(t, 0x811c9dc5)}${fnv1a(t, 0x050c5d1f)}:${t.length}`
}

export function grantsFromPrompt(text: string, pending: ConsentState['pending'] | undefined, now: number): ConsentGrant[] {
  const r = readPrompt(text, command => consentNeeded(command)?.kind)
  if (r === undefined || r.negated) return []
  const out: ConsentGrant[] = []
  const held = pending !== undefined ? heldKinds(pending) : []
  if (pending !== undefined && now - pending.at <= PENDING_TTL_MS && !r.question && (r.approves || held.some(k => r.confirms.has(k)))) {
    for (const kind of held) out.push({ kind, until: now + GRANT_TTL_MS, uses: GRANT_USES, source: 'prompt', ...(pending.targets !== undefined ? { targets: [...pending.targets] } : {}) })
  }
  if (r.question && !r.permits) return out
  for (const kind of CONSENT_KINDS) {
    if (!r.kinds.has(kind) || out.some(g => g.kind === kind)) continue
    out.push({ kind, until: now + GRANT_TTL_MS, uses: GRANT_USES, source: 'prompt' })
  }
  return out
}

export function liveGrants(s: ConsentState, now: number): ConsentGrant[] {
  return s.grants.filter(g => g.until > now && g.uses > 0)
}

function covers(g: ConsentGrant, kind: ConsentKind, target: string): boolean {
  const kindOk = g.kind === 'any' || g.kind === kind || (g.kind === 'force-push' && kind === 'push')
  return kindOk && (g.targets === undefined || g.targets.includes(target))
}

export interface ConsentVerdict {
  allow: boolean
  next: ConsentState
  reason?: string
}

function heldKinds(p: NonNullable<ConsentState['pending']>): ConsentKind[] {
  return Array.isArray(p.kinds) && p.kinds.length > 0 ? p.kinds : [p.kind]
}

export function consentVerdict(command: string, s: ConsentState, now: number, opts?: ConsentOptions): ConsentVerdict & { need?: ConsentNeed } {
  const needs = consentNeeds(command, opts)
  const first = needs[0]
  if (first === undefined) return { allow: true, next: s }
  const target = commandTarget(command)
  const grants = liveGrants(s, now)
  const used = new Set<number>()
  const missing: ConsentNeed[] = []
  for (const need of needs) {
    const idx = grants.findIndex(g => covers(g, need.kind, target))
    if (idx >= 0) used.add(idx)
    else missing.push(need)
  }
  const held = missing[0]
  if (held === undefined) {
    const next: ConsentState = { v: 1, grants: grants.map((g, i) => (used.has(i) ? { ...g, uses: g.uses - 1 } : g)).filter(g => g.uses > 0) }
    if (s.pending !== undefined) next.pending = s.pending
    return { allow: true, next, need: first }
  }
  const next: ConsentState = { v: 1, grants, pending: { ...held, at: now, targets: [target], ...(missing.length > 1 ? { kinds: missing.map(n => n.kind) } : {}) } }
  return { allow: false, next, reason: consentReason(missing), need: held }
}

function consentReason(needs: readonly ConsentNeed[]): string {
  const command = needs[0]?.command ?? ''
  const shown = command.length > 80 ? `${command.slice(0, 77)}...` : command
  const summary = needs.map(n => n.summary).join(' and ')
  const label = needs.map(n => CONSENT_LABEL[n.kind]).join(' and ')
  return `this command ${summary}, and the user has not allowed that in this session. Ask the user first, in their language, naming the exact command and what it changes (for example: "May I run \`${shown}\`? It will ${label}."), then retry once they say yes. Do not look for another way to do the same thing.`
}

export function consentVerdictAll(commands: readonly string[], s: ConsentState, now: number): ConsentVerdict & { need?: ConsentNeed } {
  const list = Array.isArray(commands) ? commands : []
  let state = s
  let first: ConsentNeed | undefined
  for (const command of list) {
    const v = consentVerdict(command, state, now)
    if (!v.allow) {
      const need = v.need as ConsentNeed
      const kinds = v.next.pending !== undefined ? heldKinds(v.next.pending) : [need.kind]
      const targets = list.filter(c => consentNeeds(c).some(n => kinds.includes(n.kind))).map(commandTarget)
      const pending = { ...need, at: now, targets, ...(kinds.length > 1 ? { kinds } : {}) }
      return { allow: false, next: { v: 1, grants: liveGrants(s, now), pending }, reason: v.reason ?? consentReason([need]), need }
    }
    if (v.need !== undefined) first ??= v.need
    state = v.next
  }
  return first !== undefined ? { allow: true, next: state, need: first } : { allow: true, next: state }
}

export function applyPromptGrants(s: ConsentState, text: string, now: number): ConsentState {
  const fresh = grantsFromPrompt(text, s.pending, now)
  const kept = liveGrants(s, now)
  if (fresh.length === 0 && s.pending === undefined) return kept.length === s.grants.length ? s : { ...s, grants: kept }
  const replaced = (g: ConsentGrant): boolean => fresh.some(f => f.kind === g.kind && (f.targets === undefined || (g.targets !== undefined && g.targets.every(t => f.targets?.includes(t) === true))))
  return { v: 1, grants: [...kept.filter(g => !replaced(g)), ...fresh] }
}

export function addConsentGrants(s: ConsentState, grants: readonly ConsentGrant[], now: number): ConsentState {
  const add = Array.isArray(grants) ? grants : []
  const out: ConsentState = { v: 1, grants: [...liveGrants(s, now).filter(g => !add.some(n => n.kind === g.kind)), ...add] }
  if (s.pending !== undefined && !add.some(n => n.kind === s.pending?.kind)) out.pending = s.pending
  return out
}

function targetsOf(x: unknown): string[] | undefined {
  return Array.isArray(x) && x.every(t => typeof t === 'string') ? [...x as string[]] : undefined
}

export function parseConsent(raw: unknown): ConsentState {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return emptyConsent()
  const o = raw as Record<string, unknown>
  const grants: ConsentGrant[] = []
  for (const g of Array.isArray(o['grants']) ? o['grants'] as unknown[] : []) {
    if (g === null || typeof g !== 'object') continue
    const x = g as Record<string, unknown>
    if (!(x['kind'] === 'any' || CONSENT_KINDS.includes(x['kind'] as ConsentKind)) || typeof x['until'] !== 'number' || typeof x['uses'] !== 'number') continue
    const targets = targetsOf(x['targets'])
    grants.push({ kind: x['kind'] as ConsentGrant['kind'], until: x['until'], uses: x['uses'], source: x['source'] === 'ask' ? 'ask' : 'prompt', ...(targets !== undefined ? { targets } : {}) })
  }
  const out: ConsentState = { v: 1, grants }
  const p = o['pending']
  if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
    const x = p as Record<string, unknown>
    if (CONSENT_KINDS.includes(x['kind'] as ConsentKind) && typeof x['at'] === 'number' && typeof x['command'] === 'string') {
      const targets = targetsOf(x['targets'])
      const kinds = Array.isArray(x['kinds']) ? (x['kinds'] as unknown[]).filter((k): k is ConsentKind => CONSENT_KINDS.includes(k as ConsentKind)) : []
      out.pending = {
        kind: x['kind'] as ConsentKind, summary: typeof x['summary'] === 'string' ? x['summary'] : SUMMARY[x['kind'] as ConsentKind], command: x['command'], at: x['at'],
        ...(targets !== undefined ? { targets } : {}), ...(kinds.length > 1 && kinds[0] === x['kind'] ? { kinds: unique(kinds) } : {}),
      }
    }
  }
  return out
}
