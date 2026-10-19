import { DYN, HOME } from './shell'

// A reading of PowerShell and cmd.exe command lines, deep enough for the shell guard: commands with
// their words, redirections and pipelines, and the code they nest (script blocks, subexpressions,
// parenthesized pipelines). Unknown values become DYN, the home folder HOME, as in shell.ts.

export interface PsWord {
  kind: 'word' | 'param' | 'block' | 'group' | 'comma'
  text: string
  raw: string
  quoted: boolean
  dynamic: boolean
  name?: string
  value?: PsWord
  src?: string
  refs?: Array<string | undefined>
}

export interface PsRedirect { op: '>' | '>>'; target: PsWord }

export interface PsCommand { words: PsWord[]; redirects: PsRedirect[] }

export interface PsStatement {
  stages: PsCommand[]
  assign?: { name: string; env: boolean; value?: PsWord[] }
  expr?: string
  keyword?: string
}

export interface PsScript { statements: PsStatement[]; nested: string[]; truncated?: boolean }

const MAX_SOURCE = 1_000_000

const KNOWN_HOME = new Set(['home', 'env:userprofile', 'env:home'])
const KEYWORDS = new Set(['if', 'elseif', 'else', 'foreach', 'for', 'while', 'do', 'until', 'switch', 'try', 'catch', 'finally', 'function', 'filter', 'trap', 'begin', 'process', 'end', 'param', 'data', 'return', 'throw', 'break', 'continue', 'exit', 'class', 'enum'])

// Quotes and subexpressions nest; past NEST_MAX levels a construct counts as unclosed.
const NEST_MAX = 64

function closing(src: string, open: number, openCh: string, closeCh: string, nest = 0): number {
  if (nest > NEST_MAX) return -1
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i] as string
    if (c === '`') { i++; continue }
    if (c === "'") { i = singleEnd(src, i); continue }
    if (c === '"') { i = doubleEnd(src, i, nest + 1); continue }
    if (c === '#' && (i === 0 || /\s/.test(src[i - 1] as string))) { const nl = src.indexOf('\n', i); if (nl < 0) return -1; i = nl; continue }
    if (c === '<' && src[i + 1] === '#') { const e = src.indexOf('#>', i + 2); if (e < 0) return -1; i = e + 1; continue }
    if (c === openCh) depth++
    else if (c === closeCh) { depth--; if (depth === 0) return i }
  }
  return -1
}

function singleEnd(src: string, i: number): number {
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "'") { if (src[j + 1] === "'") { j++; continue } return j }
  }
  return src.length - 1
}

function doubleEnd(src: string, i: number, nest = 0): number {
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]
    if (c === '`') { j++; continue }
    if (c === '$' && src[j + 1] === '(') { const e = closing(src, j + 1, '(', ')', nest + 1); if (e < 0) return src.length - 1; j = e; continue }
    if (c === '"') { if (src[j + 1] === '"') { j++; continue } return j }
  }
  return src.length - 1
}

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '0': '\0', a: '\x07', b: '\b', e: '\x1b', f: '\f', v: '\v' }

interface Lexer { src: string; i: number; nested: string[] }

function variable(lx: Lexer, w: PsWord): void {
  const { src } = lx
  const start = lx.i
  lx.i++
  if (src[lx.i] === '(') {
    const e = closing(src, lx.i, '(', ')')
    const end = e < 0 ? src.length - 1 : e
    lx.nested.push(src.slice(lx.i + 1, end))
    lx.i = end + 1
    addRef(w, undefined, src.slice(start, lx.i))
    return
  }
  let name = ''
  if (src[lx.i] === '{') {
    const e = src.indexOf('}', lx.i)
    const end = e < 0 ? src.length : e
    name = src.slice(lx.i + 1, end)
    lx.i = end + 1
  } else {
    const m = /^(?:[A-Za-z_][\w]*:)?[\w?]+|^[$^_?]/.exec(src.slice(lx.i, lx.i + 256))
    if (m === null) { w.text += '$'; w.raw += '$'; return }
    name = m[0]
    lx.i += name.length
  }
  let member = ''
  while (lx.i < src.length && (src[lx.i] === '.' || src[lx.i] === '[') && /[\w[]/.test(src[lx.i + 1] ?? '')) {
    if (src[lx.i] === '[') { const e = closing(src, lx.i, '[', ']'); if (e < 0) break; member += src.slice(lx.i, e + 1); lx.i = e + 1; continue }
    const m = /^\.[\w]+/.exec(src.slice(lx.i))
    if (m === null) break
    member += m[0]
    lx.i += m[0].length
    if (src[lx.i] === '(') {
      const e = closing(src, lx.i, '(', ')')
      const end = e < 0 ? src.length - 1 : e
      lx.nested.push(src.slice(lx.i + 1, end))
      member += src.slice(lx.i, end + 1)
      lx.i = end + 1
    }
  }
  const key = name.toLowerCase()
  if (member === '' && KNOWN_HOME.has(key) && w.text === '') { w.text += HOME; w.raw += src.slice(start, lx.i); return }
  addRef(w, member === '' ? key : /^\.\w+$/.test(member) ? `${key}${member.toLowerCase()}` : undefined, src.slice(start, lx.i))
}

function addRef(w: PsWord, name: string | undefined, raw: string): void {
  w.text += DYN
  w.raw += raw
  w.dynamic = true
  ;(w.refs ??= []).push(name)
}

function word(): PsWord {
  return { kind: 'word', text: '', raw: '', quoted: false, dynamic: false }
}

function singleQuoted(lx: Lexer, w: PsWord): void {
  const end = singleEnd(lx.src, lx.i)
  w.text += lx.src.slice(lx.i + 1, end).replace(/''/g, "'")
  w.raw += lx.src.slice(lx.i, end + 1)
  w.quoted = true
  lx.i = end + 1
}

function doubleQuoted(lx: Lexer, w: PsWord): void {
  const { src } = lx
  const start = lx.i
  w.quoted = true
  lx.i++
  while (lx.i < src.length) {
    const c = src[lx.i] as string
    if (c === '"') { if (src[lx.i + 1] === '"') { w.text += '"'; lx.i += 2; continue } lx.i++; break }
    if (c === '`' && lx.i + 1 < src.length) { const d = src[lx.i + 1] as string; w.text += ESCAPES[d] ?? d; lx.i += 2; continue }
    if (c === '$' && /[\w{(:?^$]/.test(src[lx.i + 1] ?? '')) { const before = w.raw; variable(lx, w); w.raw = before; continue }
    w.text += c
    lx.i++
  }
  w.raw += src.slice(start, lx.i)
}

function hereString(lx: Lexer, w: PsWord): boolean {
  const { src } = lx
  const q = src[lx.i + 1]
  if (src[lx.i] !== '@' || (q !== "'" && q !== '"') || !/^[ \t]*\r?\n/.test(src.slice(lx.i + 2, lx.i + 64))) return false
  const close = new RegExp(`\\r?\\n${q}@`, 'g')
  close.lastIndex = lx.i + 2
  const m = close.exec(src)
  const end = m === null ? src.length : m.index
  const bodyStart = src.indexOf('\n', lx.i + 2) + 1
  const body = src.slice(bodyStart, end)
  w.quoted = true
  if (q === '"' && /\$\(|\$[\w{]/.test(body)) { w.text += DYN; w.dynamic = true; (w.refs ??= []).push(undefined) } else w.text += body
  lx.i = m === null ? src.length : m.index + m[0].length
  w.raw += src.slice(bodyStart - 3, lx.i)
  return true
}

function bashHeredoc(lx: Lexer): boolean {
  const m = /^<<-?[ \t]*(['"]?)([A-Za-z_][\w]*)\1/.exec(lx.src.slice(lx.i, lx.i + 128))
  if (m === null) return false
  const tag = m[2] as string
  const nl = lx.src.indexOf('\n', lx.i)
  if (nl < 0) { lx.i = lx.src.length; return true }
  const lines = lx.src.slice(nl + 1).split('\n')
  let at = nl + 1
  for (const line of lines) {
    at += line.length + 1
    if (line.replace(/^\t+/, '').replace(/\r$/, '') === tag) break
  }
  lx.i = Math.min(at, lx.src.length)
  return true
}

type Tok = { t: 'word', w: PsWord } | { t: 'op', op: string } | { t: 'redir', op: '>' | '>>' | 'dup' | '<' }

const WORD_END = /[\s;|&(){},<>]/

function bare(lx: Lexer, w: PsWord): void {
  const { src } = lx
  while (lx.i < src.length) {
    const c = src[lx.i] as string
    if (WORD_END.test(c)) {
      if (c === '(' && w.text !== '' && !w.quoted) {
        const e = closing(src, lx.i, '(', ')')
        const end = e < 0 ? src.length - 1 : e
        lx.nested.push(src.slice(lx.i + 1, end))
        w.raw += src.slice(lx.i, end + 1)
        w.text += DYN
        w.dynamic = true
        ;(w.refs ??= []).push(undefined)
        lx.i = end + 1
        continue
      }
      break
    }
    if (c === '`') {
      if (src[lx.i + 1] === '\n' || (src[lx.i + 1] === '\r' && src[lx.i + 2] === '\n')) break
      const d = src[lx.i + 1] ?? ''
      w.text += d
      w.raw += c + d
      lx.i += 2
      continue
    }
    if (c === "'") { singleQuoted(lx, w); continue }
    if (c === '"') { doubleQuoted(lx, w); continue }
    if (c === '$' && /[\w{(:?^$]/.test(src[lx.i + 1] ?? '')) { variable(lx, w); continue }
    if (c === '~' && w.text === '' && w.raw === '' && (lx.i + 1 >= src.length || /[\\/\s;|)}]/.test(src[lx.i + 1] as string))) { w.text += HOME; w.raw += c; lx.i++; continue }
    w.text += c
    w.raw += c
    lx.i++
  }
}

function lex(lx: Lexer): Tok[] {
  const { src } = lx
  const out: Tok[] = []
  while (lx.i < src.length) {
    const c = src[lx.i] as string
    if (c === '`' && (src[lx.i + 1] === '\n' || (src[lx.i + 1] === '\r' && src[lx.i + 2] === '\n'))) { lx.i += src[lx.i + 1] === '\n' ? 2 : 3; continue }
    if (c === '\n') { out.push({ t: 'op', op: ';' }); lx.i++; continue }
    if (/\s/.test(c)) { lx.i++; continue }
    if (c === '#') { const nl = src.indexOf('\n', lx.i); lx.i = nl < 0 ? src.length : nl; continue }
    if (c === '<' && src[lx.i + 1] === '#') { const e = src.indexOf('#>', lx.i + 2); lx.i = e < 0 ? src.length : e + 2; continue }
    if (c === '<' && src[lx.i + 1] === '<' && bashHeredoc(lx)) { out.push({ t: 'op', op: ';' }); continue }
    if (src.startsWith('&&', lx.i) || src.startsWith('||', lx.i)) { out.push({ t: 'op', op: ';' }); lx.i += 2; continue }
    if (c === ';' || c === '|') { out.push({ t: 'op', op: c }); lx.i++; continue }
    if (c === '&') { out.push({ t: 'op', op: '&' }); lx.i++; continue }
    if (c === ')' || c === '}') { lx.i++; continue }
    const redir = /^(?:[1-6*])?(>>?)(?:&[12])?|^</.exec(src.slice(lx.i, lx.i + 5))
    if (redir !== null && (/^[1-6*]?>/.test(redir[0]) || redir[0] === '<')) {
      lx.i += redir[0].length
      out.push({ t: 'redir', op: redir[0].includes('&') ? 'dup' : redir[0] === '<' ? '<' : (redir[1] as '>' | '>>') })
      continue
    }
    if (c === ',') { out.push({ t: 'word', w: { kind: 'comma', text: ',', raw: ',', quoted: false, dynamic: false } }); lx.i++; continue }
    if (c === '{' || c === '(' || (c === '@' && src[lx.i + 1] === '(') || (c === '$' && src[lx.i + 1] === '(')) {
      const at = c === '@' || c === '$' ? lx.i + 1 : lx.i
      const open = src[at] as string
      const e = closing(src, at, open, open === '{' ? '}' : ')')
      const end = e < 0 ? src.length : e
      const inner = src.slice(at + 1, end)
      lx.nested.push(inner)
      const raw = src.slice(lx.i, Math.min(end + 1, src.length))
      lx.i = end + 1
      out.push({ t: 'word', w: { kind: open === '{' ? 'block' : 'group', text: DYN, raw, quoted: false, dynamic: true, src: inner, refs: [undefined] } })
      continue
    }
    const w = word()
    if (hereString(lx, w)) { out.push({ t: 'word', w }); continue }
    if (c === '-' && /[A-Za-z]/.test(src[lx.i + 1] ?? '')) {
      const m = /^-([A-Za-z][\w-]*)(:?)/.exec(src.slice(lx.i, lx.i + 128)) as RegExpExecArray
      if (m[2] === ':' || WORD_END.test(src[lx.i + m[0].length] ?? ' ')) {
        lx.i += m[0].length
        const p: PsWord = { kind: 'param', text: m[0].replace(/:$/, ''), raw: m[0], quoted: false, dynamic: false, name: (m[1] as string).toLowerCase() }
        if (m[2] === ':') {
          const v = word()
          bare(lx, v)
          p.value = v
          p.raw += v.raw
        }
        out.push({ t: 'word', w: p })
        continue
      }
    }
    const before = lx.i
    bare(lx, w)
    if (lx.i === before) { lx.i++; continue }
    out.push({ t: 'word', w })
  }
  return out
}

function statementsOf(toks: Tok[]): PsStatement[] {
  const out: PsStatement[] = []
  let stages: PsCommand[] = []
  let cur: PsCommand = { words: [], redirects: [] }
  const flushCmd = (): void => { if (cur.words.length > 0 || cur.redirects.length > 0) stages.push(cur); cur = { words: [], redirects: [] } }
  const flush = (): void => {
    flushCmd()
    if (stages.length > 0) out.push(statement(stages))
    stages = []
  }
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k] as Tok
    if (t.t === 'op') {
      if (t.op === '|') flushCmd()
      else if (t.op === '&' && cur.words.length === 0) continue
      else flush()
      continue
    }
    if (t.t === 'redir') {
      const next = toks[k + 1]
      if (t.op === 'dup' || t.op === '<') { if (t.op === '<' && next?.t === 'word') k++; continue }
      if (next !== undefined && next.t === 'word') { cur.redirects.push({ op: t.op, target: next.w }); k++ }
      continue
    }
    cur.words.push(t.w)
  }
  flush()
  return out
}

function statement(stages: PsCommand[]): PsStatement {
  const first = stages[0] as PsCommand
  const w0 = first.words[0]
  const w1 = first.words[1]
  if (w0 !== undefined && w0.kind === 'word' && !w0.quoted && /^\$[\w:{}]+$/.test(w0.raw) && w1 !== undefined && /^[+\-*/]?=$/.test(w1.raw)) {
    const name = w0.raw.slice(1).replace(/^\{|\}$/g, '').toLowerCase()
    const env = name.startsWith('env:')
    const rest = first.words.slice(2)
    const assign = { name: env ? name.slice(4) : name, env, ...(w1.raw === '=' ? { value: rest } : {}) }
    const head = rest[0]
    const command = head !== undefined && head.kind === 'word' && !head.quoted && !head.dynamic && /^[A-Za-z]/.test(head.text)
    return command ? { stages: [{ words: rest, redirects: first.redirects }, ...stages.slice(1)], assign } : { stages: stages.slice(1), assign }
  }
  if (w0 !== undefined && w0.kind === 'word' && !w0.quoted && KEYWORDS.has(w0.text.toLowerCase())) return { stages: [], keyword: w0.text.toLowerCase() }
  if (w0 !== undefined && (w0.quoted || w0.kind === 'group' || /^[[\d$]/.test(w0.raw)) && w0.kind !== 'block') {
    return { stages: stages.slice(1), expr: first.words.map(w => w.raw).join(' ') }
  }
  return { stages }
}

export function parsePowerShell(source: string): PsScript {
  const src = typeof source === 'string' ? source : ''
  const truncated = src.length > MAX_SOURCE
  const lx: Lexer = { src: truncated ? src.slice(0, MAX_SOURCE) : src, i: 0, nested: [] }
  const statements = statementsOf(lex(lx))
  return truncated ? { statements, nested: lx.nested, truncated: true } : { statements, nested: lx.nested }
}

// The signs that a command line is PowerShell rather than POSIX shell: a PowerShell-only cmdlet,
// variable or type, a PowerShell parameter on a delete or copy, or a backslash path.
const POWERSHELL_SIGNS = new RegExp([
  String.raw`\$env:`, String.raw`\[(?:system\.)?(?:io\.(?:file|directory)|environment|net\.webclient)\]`,
  String.raw`(?:^|[\s;|&({])(?:remove|copy|move|rename|set|add|clear|new|out|format|stop|restart|invoke|start|initialize|get|foreach|where|tee)-[a-z]+(?=[\s;|)}]|$)`,
  String.raw`(?:^|[\s;|&(])(?:ri|rd|del|erase|cpi|mi|rni|sc|ac|clc|ni|iex|iwr|irm|gci|saps|sl|cmd(?:\.exe)?\s+/[ck])\s`,
  String.raw`\s-(?:recurse|force|literalpath|itemtype|destination|outfile|filepath|erroraction|whatif|argumentlist|encodedcommand)\b`,
  String.raw`(?:^|[\s'"=(,])(?:[a-z]:|\.{1,2}|~)\\`,
].join('|'), 'i')

export function looksLikePowerShell(command: string): boolean {
  return typeof command === 'string' && POWERSHELL_SIGNS.test(command.length > 65_536 ? command.slice(0, 65_536) : command)
}

// PowerShell's -EncodedCommand is base64 of UTF-16LE text.
export function decodeEncodedCommand(b64: string): string | undefined {
  const t = typeof b64 === 'string' ? b64.replace(/\s+/g, '') : ''
  if (t === '' || t.length > 262_144 || !/^[A-Za-z0-9+/]+={0,2}$/.test(t)) return undefined
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes: number[] = []
  let buf = 0
  let bits = 0
  for (const ch of t.replace(/=+$/, '')) {
    buf = (buf << 6) | A.indexOf(ch)
    bits += 6
    if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xff) }
  }
  if (bytes.length % 2 !== 0) return undefined
  let out = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] as number) | ((bytes[i + 1] as number) << 8))
  return /[\0-\x08\x0e-\x1f]/.test(out) ? undefined : out
}

// cmd.exe: `^` escapes, `"` quotes, `&`, `&&`, `||` and `|` separate, `(...)` groups nest.
export interface CmdScript { commands: PsCommand[]; nested: string[] }

const CMD_KNOWN: Readonly<Record<string, string>> = {
  userprofile: HOME, cd: '.', systemdrive: 'C:', systemroot: 'C:\\Windows', windir: 'C:\\Windows',
  programfiles: 'C:\\Program Files', 'programfiles(x86)': 'C:\\Program Files (x86)', programdata: 'C:\\ProgramData',
}

export function parseCmd(source: string): CmdScript {
  const src = typeof source === 'string' ? source.slice(0, MAX_SOURCE) : ''
  const commands: PsCommand[] = []
  const nested: string[] = []
  let cur: PsCommand = { words: [], redirects: [] }
  let w = word()
  let started = false
  let redirect: '>' | '>>' | undefined
  const endWord = (): void => {
    if (!started) return
    if (redirect !== undefined) { cur.redirects.push({ op: redirect, target: w }); redirect = undefined } else cur.words.push(w)
    w = word()
    started = false
  }
  const endCmd = (): void => {
    endWord()
    const first = cur.words[0]
    if (first !== undefined && first.text.startsWith('@')) first.text = first.text.slice(1)
    const name = first?.text.toLowerCase()
    if (name !== undefined && name !== 'rem' && !name.startsWith('::')) commands.push(cur)
    cur = { words: [], redirects: [] }
  }
  let quoted = false
  const plain = src.replace(/["'`#<]/g, ' ')
  for (let i = 0; i < src.length; i++) {
    const c = src[i] as string
    if (quoted) {
      if (c === '"') { quoted = false; w.raw += c; continue }
      if (c === '%') { i = percent(src, i, w); continue }
      w.text += c
      w.raw += c
      continue
    }
    if (c === '"') { quoted = true; w.quoted = true; started = true; w.raw += c; continue }
    if (c === '^' && i + 1 < src.length) { w.text += src[i + 1]; w.raw += c + src[i + 1]; started = true; i++; continue }
    if (c === '%') { i = percent(src, i, w); started = true; continue }
    if (c === '!' && /^![A-Za-z_][\w]*!/.test(src.slice(i, i + 64))) { const e = src.indexOf('!', i + 1); addRef(w, undefined, src.slice(i, e + 1)); started = true; i = e; continue }
    if (c === '\n' || c === '&' || c === '|') { endCmd(); if (src[i + 1] === c) i++; continue }
    if (c === '(' && !started && cur.words.length === 0) {
      const e = closing(plain, i, '(', ')')
      const end = e < 0 ? src.length : e
      nested.push(src.slice(i + 1, end))
      i = end
      continue
    }
    if (c === '(' && cur.words.length > 0 && /^(?:if|for|do|else)$/i.test(cur.words[0]?.text ?? '')) {
      const e = closing(plain, i, '(', ')')
      const end = e < 0 ? src.length : e
      nested.push(src.slice(i + 1, end))
      i = end
      continue
    }
    const r = /^[12]?(>>?)(&[12])?/.exec(src.slice(i, i + 5))
    if (r !== null && !started) {
      i += r[0].length - 1
      if (r[2] === undefined) redirect = r[1] as '>' | '>>'
      continue
    }
    if (r !== null && started && /^>/.test(r[0])) {
      endWord()
      i += r[0].length - 1
      if (r[2] === undefined) redirect = r[1] as '>' | '>>'
      continue
    }
    if (/\s/.test(c)) { endWord(); continue }
    w.text += c
    w.raw += c
    started = true
  }
  endCmd()
  return { commands, nested }
}

function percent(src: string, i: number, w: PsWord): number {
  const m = /^%([^%\s]+)%/.exec(src.slice(i, i + 128))
  if (m === null) {
    const arg = /^%~?[a-z]*[0-9*]/i.exec(src.slice(i, i + 16))
    if (arg !== null) { addRef(w, undefined, arg[0]); return i + arg[0].length - 1 }
    w.text += '%'
    w.raw += '%'
    return i
  }
  const name = (m[1] as string).toLowerCase()
  const known = CMD_KNOWN[name]
  if (known === HOME && w.text === '') w.text += HOME
  else if (known !== undefined && known !== HOME) w.text += known
  else if (name === 'homedrive' && /^%homedrive%%homepath%/i.test(src.slice(i, i + 21)) && w.text === '') { w.text += HOME; w.raw += src.slice(i, i + 21); return i + 20 }
  else { addRef(w, undefined, m[0]); return i + m[0].length - 1 }
  w.raw += m[0]
  return i + m[0].length - 1
}
