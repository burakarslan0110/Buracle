import { isWindowsPath } from '../events'
import { DYN, HOME } from './shell'

export type CodeLang = 'python' | 'js' | 'perl' | 'ruby' | 'php' | 'lua' | 'awk' | 'applescript' | 'tcl' | 'powershell' | 'unknown'

export type CodeOp =
  | { kind: 'delete-tree', api: string, target?: string }
  | { kind: 'delete', api: string, target?: string }
  | { kind: 'write', api: string, target?: string }
  | { kind: 'move', api: string, src?: string, dst?: string }
  | { kind: 'shell', api: string, command: string }
  | { kind: 'unreadable', api: string, why: string }

const LANGS: ReadonlyArray<[CodeLang, readonly string[]]> = [
  ['python', ['py', 'python', 'python2', 'python3', 'ipython', 'py3', 'pypy', 'pypy3']],
  ['js', ['js', 'javascript', 'node', 'nodejs', 'bun', 'deno', 'ts', 'typescript', 'mjs', 'cjs', 'jsx', 'tsx']],
  ['perl', ['pl', 'perl', 'perl5']],
  ['ruby', ['rb', 'ruby']],
  ['php', ['php']],
  ['lua', ['lua', 'luajit']],
  ['awk', ['awk', 'gawk', 'mawk', 'nawk']],
  ['applescript', ['applescript', 'osascript', 'scpt']],
  ['tcl', ['tcl', 'tclsh', 'wish', 'expect']],
  ['powershell', ['ps1', 'powershell', 'pwsh']],
]

export function codeLang(language: string): CodeLang {
  const l = typeof language === 'string' ? language.trim().toLowerCase() : ''
  for (const [lang, names] of LANGS) if (names.includes(l)) return lang
  return 'unknown'
}

const MAX_CODE = 200_000
const MAX_TOKENS = 200_000
const MAX_DEPTH = 24
const MAX_VALUE = 8_192
const MAX_OPS = 10_000
const MAX_WORK = 4_000_000
const MAX_NESTED = 3

type CTok =
  | { k: 'id', v: string }
  | { k: 'str', v: string }
  | { k: 'tpl', chunks: string[], exprs: Array<string | undefined> }
  | { k: 'num' }
  | { k: 'p', v: string }
  | { k: 'nl' }
  | { k: 'cmd', v: string }

interface Profile {
  line: readonly string[]
  block: ReadonlyArray<readonly [string, string]>
  quotes: readonly string[]
  backtick: 'template' | 'command' | 'none'
  interpolate: 'none' | 'dollar' | 'ruby'
  pyPrefix: boolean
  regex: boolean
}

const PROFILES: Readonly<Record<CodeLang, Profile>> = {
  python: { line: ['#'], block: [], quotes: ["'", '"'], backtick: 'none', interpolate: 'none', pyPrefix: true, regex: false },
  js: { line: ['//'], block: [['/*', '*/']], quotes: ["'", '"'], backtick: 'template', interpolate: 'none', pyPrefix: false, regex: true },
  perl: { line: ['#'], block: [], quotes: ["'", '"'], backtick: 'command', interpolate: 'dollar', pyPrefix: false, regex: false },
  ruby: { line: ['#'], block: [], quotes: ["'", '"'], backtick: 'command', interpolate: 'ruby', pyPrefix: false, regex: false },
  php: { line: ['//', '#'], block: [['/*', '*/']], quotes: ["'", '"'], backtick: 'command', interpolate: 'dollar', pyPrefix: false, regex: false },
  lua: { line: ['--'], block: [['--[[', ']]']], quotes: ["'", '"'], backtick: 'none', interpolate: 'none', pyPrefix: false, regex: false },
  awk: { line: ['#'], block: [], quotes: ['"'], backtick: 'none', interpolate: 'none', pyPrefix: false, regex: false },
  applescript: { line: ['--', '#'], block: [['(*', '*)']], quotes: ['"'], backtick: 'none', interpolate: 'none', pyPrefix: false, regex: false },
  tcl: { line: ['#'], block: [], quotes: ['"'], backtick: 'none', interpolate: 'dollar', pyPrefix: false, regex: false },
  powershell: { line: ['#'], block: [['<#', '#>']], quotes: ["'", '"'], backtick: 'none', interpolate: 'dollar', pyPrefix: false, regex: false },
  unknown: { line: ['#', '//'], block: [['/*', '*/']], quotes: ["'", '"'], backtick: 'template', interpolate: 'none', pyPrefix: true, regex: false },
}

const PUNCT = ['===', '!==', '**=', '...', '>>>', '<=>', '?.', '??', '=>', '==', '!=', '<=', '>=', '&&', '||', '**', '//', '+=', '-=', '*=', '/=', '<<', '>>', '::', '->']
const ID_START = /[A-Za-z_$]/
const ID_CHAR = /[A-Za-z0-9_$]/
const REGEX_AFTER = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '=>', '==', '===', '!=', '!==', '&&', '||', '??', 'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'void', 'throw'])

function decodeEscapes(s: string): string {
  return s.replace(/\\(?:x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|([\s\S]))/g, (_m, x?: string, ub?: string, u?: string, c?: string) => {
    const code = x ?? ub ?? u
    if (code !== undefined) {
      const n = parseInt(code, 16)
      return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ''
    }
    switch (c) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case '0': return ''
      case '\n': return ''
      default: return c ?? ''
    }
  })
}

function skipBraced(src: string, i: number, depth: number): number {
  let d = 1
  const n = src.length
  while (i < n) {
    const c = src[i] as string
    if (c === '\\') { i += 2; continue }
    if (c === "'" || c === '"') {
      const q = c
      i++
      while (i < n && src[i] !== q && src[i] !== '\n') { if (src[i] === '\\') i++; i++ }
      i++
      continue
    }
    if (c === '`' && depth < 8) { i = skipTemplate(src, i + 1, depth + 1); continue }
    if (c === '{') d++
    else if (c === '}') { d--; if (d === 0) return i + 1 }
    i++
  }
  return n
}

function skipTemplate(src: string, i: number, depth: number): number {
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === '\\') { i += 2; continue }
    if (c === '`') return i + 1
    if (c === '$' && src[i + 1] === '{') { i = skipBraced(src, i + 2, depth); continue }
    i++
  }
  return n
}

function readTemplate(src: string, i: number): { tok: CTok, end: number } {
  const chunks: string[] = []
  const exprs: Array<string | undefined> = []
  let cur = ''
  const n = src.length
  while (i < n) {
    const c = src[i] as string
    if (c === '\\') { cur += decodeEscapes(src.slice(i, i + 2)); i += 2; continue }
    if (c === '`') { i++; break }
    if (c === '$' && src[i + 1] === '{') {
      const end = skipBraced(src, i + 2, 0)
      chunks.push(cur)
      cur = ''
      exprs.push(src.slice(i + 2, Math.max(i + 2, end - 1)))
      i = end
      continue
    }
    cur += c
    i++
  }
  chunks.push(cur)
  return { tok: exprs.length === 0 ? { k: 'str', v: chunks.join('') } : { k: 'tpl', chunks, exprs }, end: i }
}

function readString(src: string, i: number, prof: Profile, prefix: string): { tok: CTok, end: number } {
  const q = src[i] as string
  const triple = prof.pyPrefix && src.startsWith(q.repeat(3), i)
  const open = triple ? 3 : 1
  const raw = /r/i.test(prefix)
  const fmt = /f/i.test(prefix)
  const n = src.length
  let j = i + open
  let body = ''
  let closed = false
  while (j < n) {
    const c = src[j] as string
    if (c === '\\' && j + 1 < n) { body += src.slice(j, j + 2); j += 2; continue }
    if (triple ? src.startsWith(q.repeat(3), j) : c === q) { closed = true; break }
    if (!triple && c === '\n' && (prof === PROFILES.python || prof === PROFILES.js)) break
    body += c
    j++
  }
  const end = closed ? j + open : j
  if (q === "'" && prof.interpolate !== 'none' && !fmt) return { tok: { k: 'str', v: raw ? body : body.replace(/\\(['\\])/g, '$1') }, end }
  if (fmt) {
    const chunks: string[] = []
    const exprs: Array<string | undefined> = []
    let cur = ''
    for (let k = 0; k < body.length; k++) {
      const c = body[k] as string
      if (c === '{' && body[k + 1] === '{') { cur += '{'; k++; continue }
      if (c === '}' && body[k + 1] === '}') { cur += '}'; k++; continue }
      if (c === '{') {
        const close = body.indexOf('}', k + 1)
        const e = close < 0 ? body.length : close
        chunks.push(raw ? cur : decodeEscapes(cur))
        cur = ''
        exprs.push(body.slice(k + 1, e).replace(/(?:![rsa])?(?::[^:}]*)?$/, ''))
        k = e
        continue
      }
      cur += c
    }
    chunks.push(raw ? cur : decodeEscapes(cur))
    return { tok: exprs.length === 0 ? { k: 'str', v: chunks.join('') } : { k: 'tpl', chunks, exprs }, end }
  }
  if (q === '"' && prof.interpolate !== 'none') {
    const re = prof.interpolate === 'ruby' ? /#\{[^}]*\}/g : /\$\{[^}]*\}|\$[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\]|\{[^}]*\}|->\w+)*|@\{\[[^\]]*\]\}/g
    const parts = body.split(re)
    if (parts.length > 1) return { tok: { k: 'tpl', chunks: parts.map(p => decodeEscapes(p)), exprs: parts.slice(1).map(() => undefined) }, end }
  }
  return { tok: { k: 'str', v: raw ? body : decodeEscapes(body) }, end }
}

function readQuoteLike(src: string, i: number): { text: string, end: number } | undefined {
  const open = src[i]
  const close = open === '(' ? ')' : open === '{' ? '}' : open === '[' ? ']' : open === '<' ? '>' : open
  if (open === undefined || /[\s\w]/.test(open)) return undefined
  let d = 0
  for (let j = i; j < src.length; j++) {
    const c = src[j]
    if (c === '\\') { j++; continue }
    if (c === open && close !== open) d++
    else if (c === close) {
      if (close === open && j === i) continue
      if (close !== open) d--
      if (d <= 0) return { text: src.slice(i + 1, j), end: j + 1 }
    }
  }
  return { text: src.slice(i + 1), end: src.length }
}

function tokenize(src: string, lang: CodeLang): CTok[] {
  const prof = PROFILES[lang]
  const toks: CTok[] = []
  const n = src.length
  let i = 0
  const prevSignificant = (): CTok | undefined => {
    for (let k = toks.length - 1; k >= 0; k--) if ((toks[k] as CTok).k !== 'nl') return toks[k]
    return undefined
  }
  while (i < n && toks.length < MAX_TOKENS) {
    const c = src[i] as string
    if (c === '\n') { toks.push({ k: 'nl' }); i++; continue }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue }
    const blk = prof.block.find(([a]) => src.startsWith(a, i))
    if (blk) {
      const e = src.indexOf(blk[1], i + blk[0].length)
      i = e < 0 ? n : e + blk[1].length
      continue
    }
    if (prof.line.some(m => src.startsWith(m, i))) {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (prof.pyPrefix && /[rRbBuUfF]/.test(c)) {
      const m = /^([rRbBuUfF]{1,2})(['"])/.exec(src.slice(i, i + 3))
      if (m && /^(?:[rR][bBfF]?|[bBfF][rR]?|[uU])$/.test(m[1] as string)) {
        const r = readString(src, i + (m[1] as string).length, prof, m[1] as string)
        toks.push(r.tok)
        i = r.end
        continue
      }
    }
    if (prof.quotes.includes(c)) {
      const r = readString(src, i, prof, '')
      toks.push(r.tok)
      i = r.end
      continue
    }
    if (c === '`') {
      if (prof.backtick === 'template') {
        const r = readTemplate(src, i + 1)
        toks.push(r.tok)
        i = r.end
        continue
      }
      if (prof.backtick === 'command') {
        let j = i + 1
        while (j < n && src[j] !== '`') { if (src[j] === '\\') j++; j++ }
        toks.push({ k: 'cmd', v: src.slice(i + 1, Math.min(j, n)) })
        i = Math.min(j + 1, n)
        continue
      }
    }
    if ((lang === 'perl' || lang === 'unknown') && src.startsWith('qx', i) && !ID_CHAR.test(src[i + 2] ?? ' ') && (i === 0 || !ID_CHAR.test(src[i - 1] as string))) {
      const r = readQuoteLike(src, i + 2)
      if (r) { toks.push({ k: 'cmd', v: r.text }); i = r.end; continue }
    }
    if (lang === 'ruby' && src.startsWith('%x', i)) {
      const r = readQuoteLike(src, i + 2)
      if (r) { toks.push({ k: 'cmd', v: r.text }); i = r.end; continue }
    }
    if (ID_START.test(c)) {
      let j = i + 1
      while (j < n && ID_CHAR.test(src[j] as string)) j++
      if ((lang === 'ruby') && (src[j] === '!' || src[j] === '?') && src[j + 1] !== '=') j++
      toks.push({ k: 'id', v: src.slice(i, j) })
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1
      while (j < n && /[0-9A-Za-z_.]/.test(src[j] as string)) j++
      toks.push({ k: 'num' })
      i = j
      continue
    }
    if (c === '/' && prof.regex) {
      const prev = prevSignificant()
      const allowed = prev === undefined || (prev.k === 'p' && REGEX_AFTER.has(prev.v)) || (prev.k === 'id' && REGEX_AFTER.has(prev.v))
      if (allowed && src[i + 1] !== '/' && src[i + 1] !== '*') {
        let j = i + 1
        let cls = false
        while (j < n && src[j] !== '\n') {
          const d = src[j]
          if (d === '\\') { j += 2; continue }
          if (d === '[') cls = true
          else if (d === ']') cls = false
          else if (d === '/' && !cls) break
          j++
        }
        j++
        while (j < n && /[a-z]/.test(src[j] as string)) j++
        toks.push({ k: 'num' })
        i = j
        continue
      }
    }
    const op = PUNCT.find(p => src.startsWith(p, i)) ?? c
    toks.push({ k: 'p', v: op })
    i += op.length
  }
  return toks
}

type V =
  | { t: 'str', s: string }
  | { t: 'list', items: V[] }
  | { t: 'obj', props: Map<string, V> }
  | { t: 'bool', b: boolean }
  | { t: 'ref', path: string }
  | { t: 'unknown' }

const UNKNOWN: V = { t: 'unknown' }

function str(s: string): V {
  return { t: 'str', s: s.length > MAX_VALUE ? s.slice(0, MAX_VALUE) : s }
}

function textOf(v: V): string {
  if (v.t === 'str') return v.s
  return DYN
}

function joinPath(parts: string[]): string {
  let out = ''
  for (const p of parts) {
    if (p === '') continue
    if (p.startsWith('/') || p.startsWith(HOME) || isWindowsPath(p)) { out = p; continue }
    out = out === '' ? p : /[\\/]$/.test(out) ? out + p : `${out}/${p}`
  }
  return out
}

function expandUser(s: string): string {
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return HOME + s.slice(1)
  if (/^~[A-Za-z0-9._-]+(?:\/|$)/.test(s)) return HOME + s.slice(s.indexOf('/') < 0 ? s.length : s.indexOf('/'))
  return s
}

function expandVars(s: string): string {
  return s.replace(/^(?:\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\$env:HOME)(?=[\\/]|$)/i, HOME)
}

const HOME_ENV = new Set(['HOME', 'USERPROFILE'])

function envValue(name: V | string): V {
  const n = typeof name === 'string' ? name : name.t === 'str' ? name.s : undefined
  if (n !== undefined && HOME_ENV.has(n)) return str(HOME)
  if (n === 'PWD') return str('.')
  return UNKNOWN
}

function tail(path: string, segs = 2): string {
  const parts = path.split('.')
  return parts.slice(-segs).join('.')
}

function last(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1)
}

interface Budget { work: number; limit?: string }

interface Scope { vars: Map<string, V>; lang: CodeLang; depth: number; budget: Budget }

function charge(budget: Budget, n: number): boolean {
  budget.work -= n
  if (budget.work < 0 && budget.limit === undefined) budget.limit = 'it is too large to evaluate'
  return budget.work >= 0
}

function cannotEvaluate(scope: Scope, why: string): void {
  scope.budget.limit ??= why
}

const PY_DANGEROUS = /^(?:os|posix|nt|subprocess|shutil|pty|commands|builtins|__builtins__|importlib|ctypes|sys\.modules(?:\.\w+)?)$/
const JS_DANGEROUS = /^(?:child_process|fs|fs\.promises|fs\/promises|vm|process|global|globalThis|window|self|Bun|Deno|module)$/

function dangerousRoot(path: string, lang: CodeLang): boolean {
  if (lang === 'python') return PY_DANGEROUS.test(path)
  if (lang === 'js') return JS_DANGEROUS.test(path)
  return false
}

const LOOKUPS: ReadonlySet<string> = new Set(['getattr', '__import__', 'import_module', 'require', 'import'])

const BUILTIN_CODE = /^(?:(?:builtins|__builtins__|globalThis|global|window|vm)\.)?(?:exec|eval|compile|Function|runInThisContext|runInNewContext|runInContext)$/

function applyFn(callee: V, receiver: V | undefined, args: V[], _kwargs: Map<string, V>, scope: Scope): V {
  const path = callee.t === 'ref' ? callee.path : ''
  const name = last(path)
  const t2 = tail(path)
  const a0 = args[0]
  if (receiver !== undefined && receiver.t === 'str') {
    if (name === 'expanduser') return str(expandUser(receiver.s))
    if (name === 'resolve' || name === 'absolute' || name === 'strip' || name === 'rstrip' || name === 'lstrip' || name === 'trim' || name === 'toString' || name === 'as_posix' || name === 'normalize') return receiver
    if (name === 'joinpath' || name === 'concat') return str(name === 'concat' ? receiver.s + args.map(textOf).join('') : joinPath([receiver.s, ...args.map(textOf)]))
    if (name === 'join' && a0?.t === 'list' && scope.lang !== 'js') return str(a0.items.map(textOf).join(receiver.s))
    if (name === 'with_name' || name === 'with_suffix' || name === 'parent') return UNKNOWN
    return UNKNOWN
  }
  if (name === 'require' || name === '__import__' || name === 'import_module' || (name === 'import' && scope.lang === 'js')) {
    if (a0?.t === 'str' && !a0.s.includes(DYN)) return { t: 'ref', path: a0.s.replace(/^node:/, '') }
    if (path === name || /^(?:builtins|__builtins__|importlib)\.\w+$/.test(path)) cannotEvaluate(scope, 'it imports a module whose name it computes at run time')
    return UNKNOWN
  }
  if (name === 'getattr' && (path === 'getattr' || /^(?:builtins|__builtins__)\.getattr$/.test(path)) && a0?.t === 'ref') {
    const a1 = args[1]
    if (a1?.t === 'str' && /^[A-Za-z_]\w*$/.test(a1.s)) return { t: 'ref', path: `${a0.path}.${a1.s}` }
    if (dangerousRoot(a0.path, scope.lang)) cannotEvaluate(scope, `it looks up a function of ${a0.path} by a name it computes at run time`)
    return UNKNOWN
  }
  if (name === 'expanduser' && a0 !== undefined) return a0.t === 'str' ? str(expandUser(a0.s)) : UNKNOWN
  if (name === 'expandvars' && a0 !== undefined) return a0.t === 'str' ? str(expandVars(a0.s)) : UNKNOWN
  if ((name === 'expand_path' || (name === 'glob' && scope.lang === 'perl')) && a0 !== undefined) return a0.t === 'str' ? str(expandUser(a0.s)) : UNKNOWN
  if (name === 'homedir' || name === 'home' || t2 === 'Path.home' || name === 'gethome') return str(HOME)
  if (name === 'getcwd' || name === 'cwd' || name === 'getcwdb') return str('.')
  if (name === 'getenv' || (name === 'get' && /(?:^|\.)(?:environ|env)$/i.test(path.slice(0, -4)))) return a0 !== undefined ? envValue(a0) : UNKNOWN
  if (['join', 'resolve'].includes(name) && /(?:^|\.)(?:path|posixpath|ntpath|File)$/.test(path.slice(0, -(name.length + 1)))) {
    if (args.some(a => a.t !== 'str')) return args.length > 0 && args[0]?.t === 'str' ? str(joinPath([...args.map(textOf)])) : UNKNOWN
    return str(joinPath(args.map(textOf)))
  }
  if (['abspath', 'realpath', 'normpath', 'normalize', 'fspath', 'str', 'String', 'toString', 'resolve', 'file', 'Path', 'PurePath', 'PosixPath', 'PurePosixPath', 'URL'].includes(name)) {
    if (name === 'Path' || name === 'PurePath' || name === 'PosixPath' || name === 'PurePosixPath') return args.length === 0 ? str('.') : str(joinPath(args.map(textOf)))
    return a0 ?? UNKNOWN
  }
  if (name === 'fileURLToPath' || name === 'dirname' || name === 'basename') return UNKNOWN
  return UNKNOWN
}

class Evaluator {
  private p: number
  private readonly ok: boolean
  constructor(private readonly toks: CTok[], start: number, private readonly end: number, private readonly scope: Scope) {
    this.p = start
    this.ok = charge(scope.budget, Math.max(1, end - start))
  }

  run(): V {
    if (!this.ok) return UNKNOWN
    try { return this.expr(0) } catch { return UNKNOWN }
  }

  private peek(): CTok | undefined { return this.p < this.end ? this.toks[this.p] : undefined }
  private isP(v: string): boolean { const t = this.peek(); return t !== undefined && t.k === 'p' && t.v === v }

  private expr(depth: number): V {
    if (depth > MAX_DEPTH) return UNKNOWN
    let left = this.unary(depth + 1)
    for (let guard = 0; guard < 512; guard++) {
      const t = this.peek()
      if (t === undefined || t.k !== 'p') break
      if (t.v === '+' || t.v === '/' || t.v === '%' || t.v === '-' || t.v === '*' || t.v === '??' || t.v === '||') {
        this.p++
        const right = this.unary(depth + 1)
        if (t.v === '+') {
          left = left.t === 'list' && right.t === 'list' ? { t: 'list', items: [...left.items, ...right.items] }
            : left.t === 'str' || right.t === 'str' ? str(textOf(left) + textOf(right)) : UNKNOWN
        }
        else if (t.v === '/' && this.scope.lang === 'python' && left.t === 'str' && right.t === 'str') left = str(joinPath([left.s, right.s]))
        else if ((t.v === '??' || t.v === '||') && left.t !== 'unknown') {  }
        else if (t.v === '??' || t.v === '||') left = right
        else left = UNKNOWN
        continue
      }
      break
    }
    if (this.isP('?')) { this.skipRest(); return UNKNOWN }
    return left
  }

  private skipRest(): void { this.p = this.end }

  private unary(depth: number): V {
    const t = this.peek()
    if (t === undefined || depth > MAX_DEPTH * 8) return UNKNOWN
    if (t.k === 'id' && (t.v === 'await' || t.v === 'new' || t.v === 'yield')) { this.p++; return this.unary(depth + 1) }
    if (t.k === 'id' && (t.v === 'not' || t.v === 'typeof' || t.v === 'void' || t.v === 'delete')) { this.p++; this.unary(depth + 1); return UNKNOWN }
    if (t.k === 'p' && (t.v === '!' || t.v === '-' || t.v === '+' || t.v === '~' || t.v === '...' || t.v === '*' || t.v === '**')) { this.p++; const v = this.unary(depth + 1); return t.v === '...' || t.v === '*' ? v : UNKNOWN }
    return this.postfix(depth)
  }

  private callArgs(depth: number): { args: V[], kwargs: Map<string, V> } {
    const args: V[] = []
    const kwargs = new Map<string, V>()
    this.p++
    for (let guard = 0; guard < 256 && this.p < this.end; guard++) {
      if (this.isP(')')) { this.p++; break }
      const t = this.peek()
      const n = this.toks[this.p + 1]
      if (t?.k === 'id' && n?.k === 'p' && n.v === '=' && this.scope.lang !== 'js') {
        this.p += 2
        kwargs.set(t.v, this.expr(depth + 1))
      } else {
        args.push(this.expr(depth + 1))
      }
      if (this.isP(',')) { this.p++; continue }
      if (this.isP(')')) { this.p++; break }
      this.skipToClose('(', ')')
      break
    }
    return { args, kwargs }
  }

  private skipToClose(open: string, close: string): void {
    let d = 1
    while (this.p < this.end) {
      const t = this.toks[this.p] as CTok
      this.p++
      if (t.k === 'p' && t.v === open) d++
      else if (t.k === 'p' && t.v === close) { d--; if (d === 0) return }
    }
  }

  private postfix(depth: number): V {
    let v = this.primary(depth)
    let receiver: V | undefined
    for (let guard = 0; guard < 256; guard++) {
      const t = this.peek()
      if (t === undefined) break
      if (t.k === 'p' && (t.v === '.' || t.v === '?.' || t.v === '::' || t.v === '->')) {
        const nx = this.toks[this.p + 1]
        if (nx?.k !== 'id') break
        this.p += 2
        if (v.t === 'ref') { receiver = undefined; v = { t: 'ref', path: `${v.path}.${nx.v}` }; continue }
        if (v.t === 'obj') { receiver = undefined; v = v.props.get(nx.v) ?? UNKNOWN; continue }
        receiver = v
        v = { t: 'ref', path: `<value>.${nx.v}` }
        if (!this.isP('(')) {
          if (nx.v === 'parent' || nx.v === 'name' || nx.v === 'length') { v = UNKNOWN; receiver = undefined }
          else if (receiver.t === 'str' && (nx.v === 'home')) v = str(HOME)
        }
        continue
      }
      if (t.k === 'p' && t.v === '(') {
        const { args, kwargs } = this.callArgs(depth + 1)
        v = applyFn(v, receiver, args, kwargs, this.scope)
        receiver = undefined
        continue
      }
      if (t.k === 'p' && t.v === '[') {
        this.p++
        const idx = this.expr(depth + 1)
        if (this.isP(']')) this.p++
        else this.skipToClose('[', ']')
        if (v.t === 'ref' && /(?:^|\.)(?:environ|env)$/i.test(v.path)) v = envValue(idx)
        else if (v.t === 'ref' && idx.t === 'str' && /^[A-Za-z_$][\w$]*$/.test(idx.s)) v = { t: 'ref', path: `${v.path}.${idx.s}` }
        else if (v.t === 'ref' && (idx.t !== 'str' || idx.s.includes(DYN)) && dangerousRoot(v.path, this.scope.lang)) { cannotEvaluate(this.scope, `it looks up a function of ${v.path} by a name it computes at run time`); v = UNKNOWN }
        else if (v.t === 'list' && idx.t === 'unknown') v = UNKNOWN
        else if (v.t === 'obj' && idx.t === 'str') v = v.props.get(idx.s) ?? UNKNOWN
        else v = UNKNOWN
        receiver = undefined
        continue
      }
      if (t.k === 'tpl' || t.k === 'str') {
        if (v.t === 'ref') { this.p++; v = UNKNOWN; continue }
      }
      if (t.k === 'p' && t.v === '{' && v.t === 'ref' && /ENV$/.test(v.path)) {
        const key = this.toks[this.p + 1]
        this.p++
        this.skipToClose('{', '}')
        v = key !== undefined && (key.k === 'id' || key.k === 'str') ? envValue(key.v) : UNKNOWN
        continue
      }
      break
    }
    if (v.t === 'ref') {
      const p = v.path
      if (/(?:^|\.)(?:env|environ)\.(?:HOME|USERPROFILE)$/i.test(p) || /(?:^|\.)Dir\.home$/.test(p)) return str(HOME)
      if (/(?:^|\.)env\.PWD$/.test(p)) return str('.')
      if (p === 'os.sep' || p === 'path.sep' || p === 'sep') return str('/')
      if (p === '__dirname' || p === '__file__' || p === '__filename') return UNKNOWN
    }
    return v
  }

  private primary(depth: number): V {
    const t = this.peek()
    if (t === undefined) return UNKNOWN
    this.p++
    switch (t.k) {
      case 'str': return str(t.v)
      case 'num': return UNKNOWN
      case 'cmd': return UNKNOWN
      case 'nl': return UNKNOWN
      case 'tpl': {
        let s = ''
        t.chunks.forEach((c, i) => {
          s += c
          if (i < t.exprs.length) {
            const e = t.exprs[i]
            s += e === undefined ? DYN : textOf(evalSource(e, this.scope))
          }
        })
        return str(s)
      }
      case 'id': {
        const id = t.v
        if (id === 'True' || id === 'true') return { t: 'bool', b: true }
        if (id === 'False' || id === 'false') return { t: 'bool', b: false }
        if (id === 'None' || id === 'null' || id === 'undefined' || id === 'nil') return UNKNOWN
        if (id === 'lambda' || id === 'function') { this.skipRest(); return UNKNOWN }
        const bound = this.scope.vars.get(id)
        if (bound !== undefined) return bound
        return { t: 'ref', path: id }
      }
      case 'p': {
        if (t.v === '(') {
          const v = this.expr(depth + 1)
          if (this.isP(',')) {
            const items = [v]
            while (this.isP(',')) { this.p++; if (this.isP(')')) break; items.push(this.expr(depth + 1)) }
            if (this.isP(')')) this.p++
            else this.skipToClose('(', ')')
            return { t: 'list', items }
          }
          if (this.isP(')')) this.p++
          else this.skipToClose('(', ')')
          return v
        }
        if (t.v === '[') {
          const items: V[] = []
          for (let guard = 0; guard < 4096 && this.p < this.end; guard++) {
            if (this.isP(']')) { this.p++; break }
            items.push(this.expr(depth + 1))
            if (this.isP(',')) { this.p++; continue }
            if (this.isP(']')) { this.p++; break }
            this.skipToClose('[', ']')
            return UNKNOWN
          }
          return { t: 'list', items }
        }
        if (t.v === '{') {
          const props = new Map<string, V>()
          for (let guard = 0; guard < 1024 && this.p < this.end; guard++) {
            if (this.isP('}')) { this.p++; break }
            const k = this.peek()
            let key: string | undefined
            if (k?.k === 'id' || k?.k === 'str') { key = k.v; this.p++ }
            else if (k?.k === 'p' && k.v === '...') { this.p++; this.expr(depth + 1); if (this.isP(',')) this.p++; continue }
            else { this.skipToClose('{', '}'); return { t: 'obj', props } }
            if (this.isP(':')) { this.p++; props.set(key, this.expr(depth + 1)) }
            else if (key !== undefined) props.set(key, this.scope.vars.get(key) ?? UNKNOWN)
            if (this.isP(',')) { this.p++; continue }
            if (this.isP('}')) { this.p++; break }
            this.skipToClose('{', '}')
            break
          }
          return { t: 'obj', props }
        }
        return UNKNOWN
      }
    }
  }
}

function evalSource(src: string, scope: Scope): V {
  if (scope.depth > 6 || src.length > 4096 || !charge(scope.budget, src.length)) return UNKNOWN
  const toks = tokenize(src, scope.lang === 'unknown' ? 'js' : scope.lang)
  return new Evaluator(toks, 0, toks.length, { ...scope, depth: scope.depth + 1 }).run()
}

type Effect = 'delete-tree' | 'delete-tree-if-recursive' | 'delete' | 'write' | 'write-mode' | 'write-dst' | 'write-arg1' | 'move' | 'shell' | 'shell-argv' | 'shell-exec' | 'tool' | 'code'

const PY_API: Readonly<Record<string, Effect>> = {
  rmtree: 'delete-tree', remove_tree: 'delete-tree',
  'os.remove': 'delete', 'os.unlink': 'delete', unlink: 'delete',
  open: 'write-mode', 'io.open': 'write-mode', 'codecs.open': 'write-mode',
  write_text: 'write', write_bytes: 'write', touch: 'write', symlink_to: 'write', hardlink_to: 'write',
  copy: 'write-dst', copy2: 'write-dst', copyfile: 'write-dst', copytree: 'write-dst', copyfileobj: 'write-dst',
  move: 'move', 'os.rename': 'move', 'os.replace': 'move', 'os.renames': 'move', rename: 'move', replace: 'move',
  'os.symlink': 'write-arg1', 'os.link': 'write-arg1',
  system: 'shell', popen: 'shell', getoutput: 'shell', getstatusoutput: 'shell', check_output: 'shell', check_call: 'shell', call: 'shell', run: 'shell', Popen: 'shell',
  'pty.spawn': 'shell-argv', execv: 'shell-exec', execve: 'shell-exec', execvp: 'shell-exec', execvpe: 'shell-exec', execl: 'shell-exec', execlp: 'shell-exec', execle: 'shell-exec', execlpe: 'shell-exec',
  spawnv: 'shell-exec', spawnvp: 'shell-exec', spawnl: 'shell-exec', spawnlp: 'shell-exec', posix_spawn: 'shell-exec', posix_spawnp: 'shell-exec',
  'tool.bash': 'tool', 'tool.write': 'tool', 'tool.edit': 'tool', 'tool.ast_edit': 'tool', write: 'write',
  exec: 'code', eval: 'code', compile: 'code',
}
const JS_API: Readonly<Record<string, Effect>> = {
  rmSync: 'delete-tree-if-recursive', rm: 'delete-tree-if-recursive', rmdirSync: 'delete-tree-if-recursive', rmdir: 'delete-tree-if-recursive', remove: 'delete-tree', 'Deno.remove': 'delete-tree-if-recursive',
  rimraf: 'delete-tree', rimrafSync: 'delete-tree', 'rimraf.sync': 'delete-tree', removeSync: 'delete-tree', emptyDir: 'delete-tree', emptyDirSync: 'delete-tree', deleteSync: 'delete-tree', deleteAsync: 'delete-tree',
  unlinkSync: 'delete', unlink: 'delete',
  writeFileSync: 'write', writeFile: 'write', appendFileSync: 'write', appendFile: 'write', createWriteStream: 'write', outputFile: 'write', outputFileSync: 'write',
  writeJson: 'write', writeJsonSync: 'write', outputJson: 'write', outputJsonSync: 'write', truncateSync: 'write', truncate: 'write', writeTextFile: 'write', writeTextFileSync: 'write',
  'Bun.write': 'write', openSync: 'write-mode', copyFileSync: 'write-dst', copyFile: 'write-dst', cpSync: 'write-dst', cp: 'write-dst', copySync: 'write-dst', copy: 'write-dst',
  renameSync: 'move', rename: 'move', moveSync: 'move', move: 'move', symlinkSync: 'write-arg1', symlink: 'write-arg1', linkSync: 'write-arg1',
  exec: 'shell', execSync: 'shell', execaCommand: 'shell', execaCommandSync: 'shell',
  execFile: 'shell-argv', execFileSync: 'shell-argv', spawn: 'shell-argv', spawnSync: 'shell-argv', execa: 'shell-argv', execaSync: 'shell-argv', 'Deno.Command': 'shell-argv', 'Deno.run': 'shell-argv',
  'tool.bash': 'tool', 'tool.write': 'tool', 'tool.edit': 'tool', 'tool.ast_edit': 'tool', write: 'write',
  eval: 'code', Function: 'code', runInThisContext: 'code', runInNewContext: 'code', runInContext: 'code',
}
const PERL_API: Readonly<Record<string, Effect>> = {
  system: 'shell-argv', exec: 'shell-argv', rmtree: 'delete-tree', remove_tree: 'delete-tree', unlink: 'delete', open: 'write-mode',
}
const RUBY_API: Readonly<Record<string, Effect>> = {
  system: 'shell-argv', exec: 'shell-argv', spawn: 'shell-argv', popen: 'shell-argv', capture2: 'shell-argv', capture2e: 'shell-argv', capture3: 'shell-argv', popen3: 'shell-argv',
  rm_rf: 'delete-tree', rm_r: 'delete-tree', 'rm_rf!': 'delete-tree', remove_dir: 'delete-tree', remove_entry: 'delete-tree', remove_entry_secure: 'delete-tree', rmtree: 'delete-tree',
  rm: 'delete', rm_f: 'delete', 'File.delete': 'delete', 'File.unlink': 'delete', delete: 'delete',
  'File.write': 'write', 'IO.write': 'write', 'File.open': 'write-mode', 'File.binwrite': 'write',
}
const PHP_API: Readonly<Record<string, Effect>> = {
  system: 'shell', exec: 'shell', shell_exec: 'shell', passthru: 'shell', popen: 'shell', proc_open: 'shell-argv', unlink: 'delete', file_put_contents: 'write',
}
const LUA_API: Readonly<Record<string, Effect>> = { 'os.execute': 'shell', 'io.popen': 'shell', 'os.remove': 'delete', execute: 'shell' }
const AWK_API: Readonly<Record<string, Effect>> = { system: 'shell' }

function apiTable(lang: CodeLang): Readonly<Record<string, Effect>> {
  switch (lang) {
    case 'python': return PY_API
    case 'js': return JS_API
    case 'perl': return PERL_API
    case 'ruby': return RUBY_API
    case 'php': return PHP_API
    case 'lua': return LUA_API
    case 'awk': return AWK_API
    default: return {}
  }
}

const FS_RECEIVER = /^(?:fs|fsp|fse|fsExtra|fs_extra|promises|fs\.promises|extra|Deno|shutil|os|subprocess|sp|pathlib|cp|child_process|childProcess|proc|Bun|FileUtils|File|IO|Open3|Kernel|tool|builtins|__builtins__)$/
const GENERIC = new Set(['remove', 'copy', 'move', 'run', 'call', 'rm', 'cp', 'rename', 'replace', 'unlink', 'exec', 'spawn', 'popen', 'write', 'delete', 'open', 'system'])
const GENERIC_BARE = new Set(['remove', 'copy', 'move', 'run', 'call', 'rm', 'cp', 'rename', 'unlink', 'exec', 'spawn', 'popen', 'write', 'delete', 'open', 'system'])
const VALUE_METHODS = new Set(['unlink', 'rename', 'open'])

function effectOf(table: Readonly<Record<string, Effect>>, path: string, hasValueReceiver: boolean): Effect | undefined {
  if (path === '') return undefined
  const two = tail(path)
  const one = last(path)
  const direct = Object.prototype.hasOwnProperty.call(table, two) ? table[two] : undefined
  if (direct !== undefined) return direct
  if (!Object.prototype.hasOwnProperty.call(table, one)) return undefined
  const eff = table[one]
  if (!GENERIC.has(one)) return eff
  const recv = path.includes('.') ? path.slice(0, path.lastIndexOf('.')) : ''
  if (recv === '<value>') return hasValueReceiver && VALUE_METHODS.has(one) ? eff : undefined
  if (recv === '') return GENERIC_BARE.has(one) ? eff : undefined
  return FS_RECEIVER.test(recv) || FS_RECEIVER.test(recv.slice(recv.lastIndexOf('.') + 1)) ? eff : undefined
}

function shellQuoteValue(v: V): string {
  const s = textOf(v)
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function argvCommand(items: V[]): string {
  return items.map(shellQuoteValue).join(' ')
}

function chainStart(toks: CTok[], end: number, closers: Map<number, number>): number {
  let j = end - 1
  for (let guard = 0; guard < 256 && j >= 0; guard++) {
    const t = toks[j] as CTok
    if (t.k === 'p' && (t.v === ')' || t.v === ']')) {
      const o = closers.get(j)
      if (o === undefined) return j + 1
      j = o - 1
      const before = toks[j]
      if (before !== undefined && before.k === 'id') { j--; }
      else if (before !== undefined && before.k === 'p' && (before.v === ')' || before.v === ']')) continue
      else return j + 1
    } else if (t.k === 'id' || t.k === 'str' || t.k === 'tpl') {
      j--
    } else {
      return j + 1
    }
    const sep = toks[j]
    if (sep !== undefined && sep.k === 'p' && (sep.v === '.' || sep.v === '?.' || sep.v === '::' || sep.v === '->')) { j--; continue }
    return j + 1
  }
  return Math.max(0, j + 1)
}

function calleePath(toks: CTok[], start: number, end: number, closers: Map<number, number>): { path: string, recvEnd?: number } {
  const ids: string[] = []
  let ok = true
  for (let j = start; j < end; j++) {
    const t = toks[j] as CTok
    if ((j - start) % 2 === 0) { if (t.k === 'id') ids.push(t.v); else { ok = false; break } }
    else if (!(t.k === 'p' && (t.v === '.' || t.v === '?.' || t.v === '::' || t.v === '->'))) { ok = false; break }
  }
  if (ok && ids.length > 0) return { path: ids.join('.') }
  const lastTok = toks[end - 1]
  if (lastTok?.k === 'id' && end - 2 > start) return { path: `<value>.${lastTok.v}`, recvEnd: end - 2 }
  const open = closers.get(end - 1)
  const key = toks[end - 2]
  if (lastTok?.k === 'p' && lastTok.v === ']' && open === end - 3 && key?.k === 'str' && /^[A-Za-z_$][\w$]*$/.test(key.v) && open > start) return { path: `<value>.${key.v}`, recvEnd: open }
  return { path: '' }
}

interface Site { api: string, effect: Effect, args: V[], kwargs: Map<string, V>, receiver?: V, depth: number, budget: Budget }

function recursiveOption(args: V[], kwargs: Map<string, V>): boolean {
  const opts = args.slice(1).find(a => a.t === 'obj')
  if (opts !== undefined && opts.t === 'obj') {
    const r = opts.props.get('recursive')
    return r === undefined ? false : !(r.t === 'bool' && !r.b)
  }
  if (args.length >= 2 && (args[1]?.t === 'unknown' || args[1]?.t === 'ref')) return true
  const kw = kwargs.get('recursive')
  return kw !== undefined && !(kw.t === 'bool' && !kw.b)
}

function writesMode(mode: V | undefined, lang: CodeLang): boolean {
  if (mode === undefined) return false
  if (mode.t !== 'str') return true
  if (lang === 'perl') return /^\s*(?:\+?>|\+<)/.test(mode.s)
  return /[wax+]/.test(mode.s)
}

function cut(v: V | undefined): boolean {
  if (v === undefined) return false
  if (v.t === 'str') return v.s.length >= MAX_VALUE
  if (v.t === 'list') return v.items.some(cut)
  return false
}

function siteOps(site: Site, lang: CodeLang, out: CodeOp[]): void {
  const { api, effect, args, kwargs } = site
  const runs = effect === 'shell' || effect === 'shell-argv' || effect === 'shell-exec' || effect === 'code' || (effect === 'tool' && api.endsWith('bash'))
  if (runs && (args.some(cut) || [...kwargs.values()].some(cut))) {
    out.push({ kind: 'unreadable', api, why: 'it builds a command or code string longer than the guard evaluates' })
    return
  }
  const a0 = args[0]
  const target = (v: V | undefined): string | undefined => (v === undefined ? undefined : v.t === 'str' ? v.s : undefined)
  const recvTarget = site.receiver !== undefined ? target(site.receiver) : undefined
  switch (effect) {
    case 'delete-tree': out.push({ kind: 'delete-tree', api, ...(opt(target(a0) ?? recvTarget)) }); return
    case 'delete-tree-if-recursive':
      if (recursiveOption(args, kwargs)) out.push({ kind: 'delete-tree', api, ...opt(target(a0)) })
      else out.push({ kind: 'delete', api, ...opt(target(a0)) })
      return
    case 'delete': {
      const list = lang === 'perl' || lang === 'php' ? args : [a0]
      if (site.receiver !== undefined && args.length === 0) { out.push({ kind: 'delete', api, ...opt(recvTarget) }); return }
      for (const v of list) out.push({ kind: 'delete', api, ...opt(target(v)) })
      return
    }
    case 'write':
      if (site.receiver !== undefined && site.receiver.t === 'str') { out.push({ kind: 'write', api, ...opt(recvTarget) }); return }
      out.push({ kind: 'write', api, ...opt(target(a0 ?? kwargs.get('path') ?? kwargs.get('file'))) })
      return
    case 'write-mode': {
      if (site.receiver !== undefined && site.receiver.t === 'str') {
        if (writesMode(a0 ?? kwargs.get('mode'), lang)) out.push({ kind: 'write', api, ...opt(recvTarget) })
        return
      }
      if (lang === 'perl') {
        const mode = args[1]
        if (args.length >= 3 && writesMode(mode, lang)) { out.push({ kind: 'write', api, ...opt(target(args[2])) }); return }
        if (mode?.t === 'str') {
          const m = /^\s*(\+?>>?|\|)\s*(.*)$/.exec(mode.s)
          if (m && m[1] === '|') out.push({ kind: 'shell', api, command: (m[2] as string) })
          else if (m) out.push({ kind: 'write', api, ...opt(m[2] as string) })
          else if (/\|\s*$/.test(mode.s)) out.push({ kind: 'shell', api, command: mode.s.replace(/\|\s*$/, '') })
        }
        return
      }
      const mode = args[1] ?? kwargs.get('mode') ?? kwargs.get('flags')
      if (writesMode(mode, lang)) out.push({ kind: 'write', api, ...opt(target(a0 ?? kwargs.get('file'))) })
      return
    }
    case 'write-dst': out.push({ kind: 'write', api, ...opt(target(args[1] ?? kwargs.get('dst'))) }); return
    case 'write-arg1': out.push({ kind: 'write', api, ...opt(target(args[1] ?? kwargs.get('dst'))) }); return
    case 'move': {
      if (site.receiver !== undefined && site.receiver.t === 'str') { out.push({ kind: 'move', api, ...optSrc(recvTarget), ...optDst(target(a0)) }); return }
      out.push({ kind: 'move', api, ...optSrc(target(a0 ?? kwargs.get('src'))), ...optDst(target(args[1] ?? kwargs.get('dst'))) })
      return
    }
    case 'shell': {
      const cmd = a0 ?? kwargs.get('args') ?? kwargs.get('cmd') ?? kwargs.get('command')
      if (cmd === undefined) return
      if (cmd.t === 'list') { out.push({ kind: 'shell', api, command: argvCommand(cmd.items) }); return }
      out.push({ kind: 'shell', api, command: textOf(cmd) })
      return
    }
    case 'shell-argv': {
      if (a0 === undefined) return
      if (a0.t === 'list') { out.push({ kind: 'shell', api, command: argvCommand(a0.items) }); return }
      if (a0.t === 'obj') {
        const c = a0.props.get('cmd')
        if (c?.t === 'list') out.push({ kind: 'shell', api, command: argvCommand(c.items) })
        return
      }
      const rest = args.slice(1)
      const list = rest.find(r => r.t === 'list')
      const opts = rest.find(r => r.t === 'obj')
      const shell = opts !== undefined && opts.t === 'obj' && opts.props.get('shell') !== undefined && !(opts.props.get('shell')?.t === 'bool' && opts.props.get('shell')?.t === 'bool' && (opts.props.get('shell') as { b: boolean }).b === false)
      const fromOpts = opts !== undefined && opts.t === 'obj' ? opts.props.get('args') : undefined
      const argList = list !== undefined && list.t === 'list' ? list.items : fromOpts !== undefined && fromOpts.t === 'list' ? fromOpts.items : rest.filter(r => r.t === 'str')
      if (argList.length === 0 && rest.length === 0 && (lang === 'perl' || lang === 'ruby' || lang === 'js')) {
        out.push({ kind: 'shell', api, command: textOf(a0) })
        return
      }
      if (shell) { out.push({ kind: 'shell', api, command: [textOf(a0), ...argList.map(textOf)].join(' ') }); return }
      out.push({ kind: 'shell', api, command: argvCommand([a0, ...argList]) })
      return
    }
    case 'shell-exec': {
      const lists = args.filter(a => a.t === 'list')
      const firstList = lists[0]
      if (firstList !== undefined && firstList.t === 'list') { out.push({ kind: 'shell', api, command: argvCommand(firstList.items) }); return }
      const strs = args.filter(a => a.t === 'str')
      if (strs.length >= 2) out.push({ kind: 'shell', api, command: argvCommand(strs.slice(1)) })
      return
    }
    case 'code': {
      const src = lang === 'js' && api.endsWith('Function') ? args[args.length - 1] : a0
      if (src !== undefined && (src.t !== 'str' || src.s.includes(DYN)) && BUILTIN_CODE.test(api)) {
        out.push({ kind: 'unreadable', api, why: 'it runs code it builds at run time' })
        return
      }
      if (src?.t !== 'str') return
      if (site.depth >= MAX_NESTED) { site.budget.limit ??= 'it nests exec/eval strings too deeply'; return }
      if (charge(site.budget, src.s.length)) scanLang(src.s, lang, out, site.budget, site.depth + 1)
      return
    }
    case 'tool': {
      const obj = args.find(a => a.t === 'obj')
      const prop = (k: string): V | undefined => (obj !== undefined && obj.t === 'obj' ? obj.props.get(k) : undefined) ?? kwargs.get(k)
      if (api.endsWith('bash')) {
        const c = prop('command') ?? (a0?.t === 'str' ? a0 : undefined)
        if (c !== undefined) out.push({ kind: 'shell', api, command: textOf(c) })
        return
      }
      const p = prop('path') ?? prop('file_path') ?? (a0?.t === 'str' ? a0 : undefined)
      out.push({ kind: 'write', api, ...opt(p !== undefined ? target(p) : undefined) })
      return
    }
  }
}

function opt(target: string | undefined): { target?: string } {
  return target === undefined ? {} : { target }
}
function optSrc(src: string | undefined): { src?: string } {
  return src === undefined ? {} : { src }
}
function optDst(dst: string | undefined): { dst?: string } {
  return dst === undefined ? {} : { dst }
}

function pythonMagics(code: string, out: CodeOp[]): string {
  const lines = code.split('\n')
  const first = (lines[0] ?? '').trim()
  if (/^%%(?:bash|sh|zsh|script\s+(?:\S*\/)?(?:ba|z|da)?sh|system)\b/.test(first)) {
    out.push({ kind: 'shell', api: first.split(/\s+/)[0] as string, command: lines.slice(1).join('\n') })
    return ''
  }
  return lines.map(l => {
    const m = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)?(?:!|%(?:sx|system|sc)\s)(.*)$/.exec(l)
    if (m && !/^\s*!=/.test(l)) { out.push({ kind: 'shell', api: '!', command: m[1] as string }); return '' }
    return l
  }).join('\n')
}

function statementForms(toks: CTok[], lang: CodeLang, scope: Scope, out: CodeOp[]): void {
  for (let j = 0; j < toks.length; j++) {
    const t = toks[j] as CTok
    if (lang === 'applescript' && t.k === 'id' && t.v === 'do' && (toks[j + 1] as CTok | undefined)?.k === 'id' && (toks[j + 1] as { v?: string }).v === 'shell' && (toks[j + 2] as { v?: string } | undefined)?.v === 'script') {
      const e = new Evaluator(toks, j + 3, toks.length, scope)
      out.push({ kind: 'shell', api: 'do shell script', command: textOf(e.run()) })
    }
    if (lang === 'tcl' && t.k === 'id' && t.v === 'exec') {
      const words: string[] = []
      for (let k = j + 1; k < toks.length; k++) {
        const w = toks[k] as CTok
        if (w.k === 'nl' || (w.k === 'p' && (w.v === ';' || w.v === ']'))) break
        words.push(w.k === 'id' ? w.v : w.k === 'str' ? `'${w.v.replace(/'/g, `'\\''`)}'` : w.k === 'p' ? w.v : DYN)
      }
      out.push({ kind: 'shell', api: 'exec', command: words.join(' ').replace(/ ([/.~-]) /g, ' $1') })
    }
  }
}

function assignmentAt(toks: CTok[], j: number, lang: CodeLang): { name: string, rhs: number } | undefined {
  const t = toks[j]
  if (t === undefined || t.k !== 'id') return undefined
  const prev = toks[j - 1]
  const atStatement = prev === undefined || prev.k === 'nl' || (prev.k === 'p' && (prev.v === ';' || prev.v === '{' || prev.v === '}')) || (prev.k === 'id' && (prev.v === 'const' || prev.v === 'let' || prev.v === 'var' || prev.v === 'my' || prev.v === 'local' || prev.v === 'our'))
  if (!atStatement) return undefined
  const eq = toks[j + 1]
  if (eq === undefined || eq.k !== 'p' || eq.v !== '=') return undefined
  void lang
  return { name: t.v, rhs: j + 2 }
}

function statementEnd(toks: CTok[], from: number, lang: CodeLang): number {
  let d = 0
  for (let j = from; j < toks.length; j++) {
    const t = toks[j] as CTok
    if (t.k === 'p' && (t.v === '(' || t.v === '[' || t.v === '{')) d++
    else if (t.k === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')) { if (d === 0) return j; d-- }
    else if (d === 0 && (t.k === 'nl' || (t.k === 'p' && t.v === ';')) && !(lang === 'js' && t.k === 'nl' && isContinuation(toks, j))) return j
    else if (d === 0 && lang === 'python' && t.k === 'p' && t.v === ',') return j
  }
  return toks.length
}

function isContinuation(toks: CTok[], nl: number): boolean {
  const prev = toks[nl - 1]
  const next = toks[nl + 1]
  return (prev?.k === 'p' && ['+', '=', '(', ',', '.', '?', ':', '&&', '||', '??'].includes(prev.v)) || (next?.k === 'p' && ['.', '?.', '+', '?', ':'].includes(next.v))
}

function scanLang(code: string, lang: CodeLang, out: CodeOp[], budget: Budget, depth = 0): void {
  let src = code
  if (lang === 'python') src = pythonMagics(src, out)
  const toks = tokenize(src, lang)
  if (toks.length >= MAX_TOKENS) budget.limit ??= 'it has too many tokens'
  const scope: Scope = { vars: new Map(), lang, depth: 0, budget }
  const table = apiTable(lang)
  const closers = new Map<number, number>()
  const openers = new Map<number, number>()
  {
    const stack: number[] = []
    for (let j = 0; j < toks.length; j++) {
      const t = toks[j] as CTok
      if (t.k !== 'p') continue
      if (t.v === '(' || t.v === '[' || t.v === '{') stack.push(j)
      else if (t.v === ')' || t.v === ']' || t.v === '}') {
        const o = stack.pop()
        if (o !== undefined) { closers.set(j, o); openers.set(o, j) }
      }
    }
  }
  for (let j = 0; j < toks.length; j++) {
    if (out.length >= MAX_OPS) { budget.limit ??= 'it has too many file or process effects'; break }
    if (budget.limit !== undefined) break
    const t = toks[j] as CTok
    if (t.k === 'cmd') { out.push({ kind: 'shell', api: '`…`', command: t.v }); continue }
    const as = assignmentAt(toks, j, lang)
    if (as !== undefined && scope.vars.size < 512) {
      const end = statementEnd(toks, as.rhs, lang)
      scope.vars.set(as.name, new Evaluator(toks, as.rhs, end, scope).run())
    }
    if ((t.k === 'tpl' || t.k === 'str') && lang === 'js') {
      const prev = toks[j - 1]
      if (prev?.k === 'id' && (prev.v === '$' || prev.v === 'sh' || prev.v === 'shell' || prev.v === 'execaCommand')) {
        let cmd = ''
        if (t.k === 'str') cmd = t.v
        else t.chunks.forEach((c, i) => { cmd += c; if (i < t.exprs.length) { const e = t.exprs[i]; cmd += e === undefined ? DYN : shellQuoteValue(evalSource(e, scope)) } })
        const before = toks[j - 2]
        const api = before?.k === 'p' && before.v === '.' && (toks[j - 3] as { v?: string } | undefined)?.v === 'Bun' ? 'Bun.$' : prev.v
        out.push({ kind: 'shell', api, command: cmd })
        continue
      }
    }
    if (PARENLESS.has(lang) && t.k === 'id' && !(toks[j + 1]?.k === 'p' && (toks[j + 1] as { v: string }).v === '(')) {
      const site = parenlessSite(toks, j, lang, scope, table, closers)
      if (site !== undefined) siteOps({ ...site, depth, budget }, lang, out)
      continue
    }
    if (t.k !== 'p' || t.v !== '(') continue
    const prev = toks[j - 1]
    if (prev === undefined || !(prev.k === 'id' || (prev.k === 'p' && (prev.v === ')' || prev.v === ']')))) continue
    if (!charge(budget, 1)) break
    const start = chainStart(toks, j, closers)
    const callee = calleePath(toks, start, j, closers)
    if (callee.path === '') {
      if (start >= j) continue
      const fn = new Evaluator(toks, start, j, scope).run()
      if (fn.t !== 'ref') continue
      const effect = effectOf(table, fn.path, false)
      if (effect === undefined) continue
      const close = openers.get(j)
      const { args, kwargs } = new ArgsReader(toks, j, close === undefined ? toks.length : close + 1, scope).read()
      siteOps({ api: fn.path, effect, args, kwargs, depth, budget }, lang, out)
      continue
    }
    const receiver = callee.recvEnd !== undefined && callee.recvEnd > start ? new Evaluator(toks, start, callee.recvEnd, scope).run() : undefined
    let path = callee.path
    let valueReceiver = callee.recvEnd !== undefined
    if (receiver?.t === 'ref') { path = `${receiver.path}.${last(path)}`; valueReceiver = false }
    if (LOOKUPS.has(last(path))) {
      const close = openers.get(j)
      if (close !== undefined) new Evaluator(toks, start, close + 1, scope).run()
    }
    const effect = effectOf(table, path, valueReceiver)
    if (effect === undefined) continue
    const close = openers.get(j)
    const end = close === undefined ? toks.length : close + 1
    const { args, kwargs } = new ArgsReader(toks, j, end, scope).read()
    siteOps({ api: path.replace(/^<value>\./, ''), effect, args, kwargs, depth, budget, ...(receiver !== undefined && receiver.t !== 'ref' ? { receiver } : {}) }, lang, out)
  }
  statementForms(toks, lang, scope, out)
}

const PARENLESS: ReadonlySet<CodeLang> = new Set(['perl', 'ruby', 'lua'])

function parenlessSite(toks: CTok[], j: number, lang: CodeLang, scope: Scope, table: Readonly<Record<string, Effect>>, closers: Map<number, number>): Omit<Site, 'depth' | 'budget'> | undefined {
  const next = toks[j + 1]
  if (next === undefined || !(next.k === 'str' || next.k === 'tpl' || next.k === 'id')) return undefined
  if (next.k === 'id' && /^(?:if|unless|and|or|do|then|end|while|until|rescue)$/.test(next.v)) return undefined
  const start = chainStart(toks, j + 1, closers)
  const callee = calleePath(toks, start, j + 1, closers)
  if (callee.path === '' || callee.recvEnd !== undefined) return undefined
  const effect = effectOf(table, callee.path, false)
  if (effect === undefined) return undefined
  const end = statementEnd(toks, j + 1, lang)
  const args: V[] = []
  let p = j + 1
  for (let guard = 0; guard < 64 && p < end; guard++) {
    let d = 0
    let e = p
    for (; e < end; e++) {
      const t = toks[e] as CTok
      if (t.k === 'p' && (t.v === '(' || t.v === '[' || t.v === '{')) d++
      else if (t.k === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')) d--
      else if (d === 0 && t.k === 'p' && t.v === ',') break
    }
    if (e > p) args.push(new Evaluator(toks, p, e, scope).run())
    p = e + 1
  }
  return { api: callee.path, effect, args, kwargs: new Map() }
}

class ArgsReader {
  constructor(private readonly toks: CTok[], private readonly open: number, private readonly end: number, private readonly scope: Scope) {}
  read(): { args: V[], kwargs: Map<string, V> } {
    const args: V[] = []
    const kwargs = new Map<string, V>()
    let p = this.open + 1
    const stop = this.end - 1
    for (let guard = 0; guard < 256 && p < stop; guard++) {
      let d = 0
      let e = p
      for (; e < stop; e++) {
        const t = this.toks[e] as CTok
        if (t.k === 'p' && (t.v === '(' || t.v === '[' || t.v === '{')) d++
        else if (t.k === 'p' && (t.v === ')' || t.v === ']' || t.v === '}')) d--
        else if (d === 0 && t.k === 'p' && t.v === ',') break
      }
      const k = this.toks[p]
      const eq = this.toks[p + 1]
      if (k?.k === 'id' && eq?.k === 'p' && eq.v === '=' && this.scope.lang !== 'js') kwargs.set(k.v, new Evaluator(this.toks, p + 2, e, this.scope).run())
      else if (k?.k === 'id' && eq?.k === 'p' && eq.v === '=>' && this.scope.lang === 'perl') kwargs.set(k.v, new Evaluator(this.toks, p + 2, e, this.scope).run())
      else if (e > p) args.push(new Evaluator(this.toks, p, e, this.scope).run())
      p = e + 1
    }
    return { args, kwargs }
  }
}

export function scanCode(code: string, lang: CodeLang): CodeOp[] {
  if (typeof code !== 'string' || code.trim() === '') return []
  if (!Object.prototype.hasOwnProperty.call(PROFILES, lang)) lang = codeLang(String(lang))
  const budget: Budget = { work: MAX_WORK }
  if (code.length > MAX_CODE) budget.limit = 'it is too long'
  const src = code.length > MAX_CODE ? code.slice(0, MAX_CODE) : code
  const out: CodeOp[] = []
  try {
    const langs: CodeLang[] = lang === 'unknown' ? ['python', 'js'] : lang === 'tcl' || lang === 'applescript' || lang === 'powershell' ? [lang, 'perl'] : [lang]
    for (const l of langs) scanLang(src, l, out, budget)
  } catch {
    budget.limit ??= 'the scanner failed on it'
  }
  const ops = out.slice(0, MAX_OPS)
  if (budget.limit !== undefined) ops.push({ kind: 'unreadable', api: 'scan', why: budget.limit })
  return ops
}
