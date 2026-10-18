import { launched } from './launchers'

export const HOME = ''
export const DYN = ''

export interface VarRef {
  name?: string
  quoted: boolean
  src?: string
}

export interface ShellWord {
  text: string
  raw: string
  quoted: boolean
  dynamic: boolean
  vars?: VarRef[]
  braces?: number[]
  tildes?: number[]
}

export interface Redirect {
  op: string
  target?: ShellWord
  body?: string
  bodyExpands?: boolean
}

export interface SimpleCommand { assigns: ShellWord[]; words: ShellWord[]; redirects: Redirect[] }
export type Stage = { kind: 'cmd', cmd: SimpleCommand } | { kind: 'group', body: Script, redirects: Redirect[] }
export interface Pipeline { stages: Stage[] }
export interface Script { pipelines: Pipeline[] }
export interface ParsedShell { script: Script; subs: string[]; truncated?: boolean }

interface LexFlags { truncated: boolean }

type Tok =
  | { t: 'word', w: ShellWord }
  | { t: 'op', op: string }
  | { t: 'redir', op: string, body?: string, heredoc?: { strip: boolean, quoted?: boolean } }

const OPS = ['&&', '||', ';;', ';&', '|&', '&>>', '&>', '>>', '>|', '>&', '<<<', '<<-', '<<', '<>', '<&', '|', '&', ';', '(', ')', '<', '>'] as const
const REDIR_OPS = new Set(['&>>', '&>', '>>', '>|', '>&', '<<<', '<<-', '<<', '<>', '<&', '<', '>'])

function findClose(src: string, open: number, openCh = '(', closeCh = ')'): number {
  let depth = 0
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') { i++; continue }
    if (c === "'") { const e = src.indexOf("'", i + 1); if (e < 0) return -1; i = e; continue }
    if (c === '"') {
      let j = i + 1
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; j++ }
      if (j >= src.length) return -1
      i = j
      continue
    }
    if (c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== '`') { if (src[j] === '\\') j++; j++ }
      if (j >= src.length) return -1
      i = j
      continue
    }
    if (c === openCh) depth++
    else if (c === closeCh) { depth--; if (depth === 0) return i }
  }
  return -1
}

function decodeAnsiC(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_m, e: string) => {
    if (e.startsWith('x')) return String.fromCharCode(parseInt(e.slice(1), 16))
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8))
    switch (e) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case 'a': case 'b': case 'e': case 'E': case 'f': case 'v': return ''
      default: return e
    }
  })
}

function arithSubs(text: string, subs: string[], depth: number, flags: LexFlags): void {
  if (depth > 16) { flags.truncated = true; return }
  for (let j = 0; j < text.length; j++) {
    const c = text[j]
    if (c === '\\') { j++; continue }
    if (c === '`') {
      let k = j + 1
      let inner = ''
      while (k < text.length && text[k] !== '`') {
        if (text[k] === '\\' && k + 1 < text.length) { inner += text[k + 1]; k += 2; continue }
        inner += text[k]
        k++
      }
      subs.push(inner)
      j = k
      continue
    }
    if (c !== '$') continue
    const d = text[j + 1]
    if (d === '(') {
      const close = findClose(text, j + 1)
      const end = close < 0 ? text.length : close
      if (text[j + 2] === '(') arithSubs(text.slice(j + 3, Math.max(j + 3, end - 1)), subs, depth + 1, flags)
      else subs.push(text.slice(j + 2, end))
      j = end
      continue
    }
    if (d === '{' || d === '[') {
      const close = findClose(text, j + 1, d, d === '{' ? '}' : ']')
      const end = close < 0 ? text.length : close
      arithSubs(text.slice(j + 2, end), subs, depth + 1, flags)
      j = end
    }
  }
}

function parenTable(src: string, from: number): { from: number, close: Int32Array, seen: Uint8Array } {
  const n = src.length - from
  const close = new Int32Array(Math.max(0, n)).fill(-1)
  const seen = new Uint8Array(Math.max(0, n))
  const stack: number[] = []
  for (let i = from; i < src.length; i++) {
    const c = src[i]
    if (c === '\\') { i++; continue }
    if (c === "'") { const e = src.indexOf("'", i + 1); if (e < 0) break; i = e; continue }
    if (c === '"' || c === '`') {
      let j = i + 1
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++ }
      if (j >= src.length) break
      i = j
      continue
    }
    if (c === '(') { stack.push(i); seen[i - from] = 1 }
    else if (c === ')') { const o = stack.pop(); if (o !== undefined) close[o - from] = i }
  }
  return { from, close, seen }
}

const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y
const NAME_ONLY = /^[A-Za-z_][A-Za-z0-9_]*$/
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?\+?=/
const COMMAND_START_WORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time', 'for'])
const IFS_REF = /^\$(?:IFS(?![A-Za-z0-9_])|\{IFS\})/

function lex(src: string, subs: string[], flags: LexFlags, depth = 0): Tok[] {
  const toks: Tok[] = []
  const n = src.length
  let i = 0
  let cur: ShellWord | undefined
  const pending: Array<{ tok: Extract<Tok, { t: 'redir' }>, strip: boolean }> = []
  let delimFor: { tok: Extract<Tok, { t: 'redir' }>, strip: boolean } | undefined

  const word = (): ShellWord => {
    if (!cur) cur = { text: '', raw: '', quoted: false, dynamic: false }
    return cur
  }
  const dyn = (w: ShellWord, ref: VarRef): void => {
    w.text += DYN
    w.dynamic = true
    ;(w.vars ??= []).push(ref)
  }
  const finish = (): void => {
    if (!cur) return
    const w = cur
    cur = undefined
    toks.push({ t: 'word', w })
    if (delimFor) {
      const d = delimFor
      delimFor = undefined
      d.tok.heredoc = { strip: d.strip, quoted: w.quoted }
      ;(d.tok as { delim?: string }).delim = w.text.includes(DYN) ? w.raw : w.text
      pending.push(d)
    }
  }
  const readHeredocBodies = (): void => {
    while (pending.length > 0) {
      const p = pending.shift() as { tok: Extract<Tok, { t: 'redir' }>, strip: boolean }
      const delim = (p.tok as { delim?: string }).delim ?? ''
      const body: string[] = []
      let found = false
      while (i < n) {
        let e = src.indexOf('\n', i)
        if (e < 0) e = n
        const line = src.slice(i, e)
        i = e < n ? e + 1 : n
        const cmp = p.strip ? line.replace(/^\t+/, '') : line
        if (cmp === delim || cmp.replace(/\r$/, '') === delim) { found = true; break }
        body.push(line)
      }
      p.tok.body = body.join('\n')
      if (!found) break
    }
    pending.length = 0
  }
  let parens: ReturnType<typeof parenTable> | undefined
  let fallbackWork = 0
  const closeOf = (open: number): number => {
    if (parens === undefined) parens = parenTable(src, open)
    const k = open - parens.from
    if (k >= 0 && parens.seen[k] === 1) return parens.close[k] as number
    if (fallbackWork > 2_000_000) return -1
    const r = findClose(src, open)
    fallbackWork += (r < 0 ? n : r) - open
    return r
  }
  const atCommandStart = (): boolean => {
    if (cur) return false
    const prev = toks[toks.length - 1]
    if (prev === undefined || prev.t === 'op') return true
    return prev.t === 'word' && !prev.w.quoted && COMMAND_START_WORDS.has(prev.w.text)
  }

  const dollar = (inDouble: boolean): void => {
    const w = word()
    const next = src[i + 1]
    const atStart = w.text === ''
    if (next === '(' && src[i + 2] === '(') {
      const close = findClose(src, i + 1)
      const end = close < 0 ? n : close + 1
      arithSubs(src.slice(i + 3, Math.max(i + 3, end - 2)), subs, 0, flags)
      const s = src.slice(i, end)
      w.raw += s
      dyn(w, { quoted: inDouble, src: s })
      i = end
      return
    }
    if (next === '(') {
      const close = findClose(src, i + 1)
      const inner = close < 0 ? src.slice(i + 2) : src.slice(i + 2, close)
      subs.push(inner)
      const s = close < 0 ? src.slice(i) : src.slice(i, close + 1)
      w.raw += s
      if (atStart && inner.trim() === 'pwd') w.text += '.'
      else dyn(w, { quoted: inDouble, src: s })
      i = close < 0 ? n : close + 1
      return
    }
    if (next === '[') {
      const close = findClose(src, i + 1, '[', ']')
      const end = close < 0 ? n : close + 1
      arithSubs(src.slice(i + 2, Math.max(i + 2, end - 1)), subs, 0, flags)
      const s = src.slice(i, end)
      w.raw += s
      dyn(w, { quoted: inDouble, src: s })
      i = end
      return
    }
    if (next === '{') {
      const close = findClose(src, i + 1, '{', '}')
      const inner = close < 0 ? src.slice(i + 2) : src.slice(i + 2, close)
      const s = close < 0 ? src.slice(i) : src.slice(i, close + 1)
      w.raw += s
      const base = /^(HOME|PWD)(?:$|:?[-?=]|%%?\/$)/.exec(inner)?.[1]
      if (atStart && base === 'HOME') w.text += HOME
      else if (atStart && /^HOME%\/\*$/.test(inner)) w.text += `${HOME}/..`
      else if (atStart && base === 'PWD') w.text += '.'
      else dyn(w, NAME_ONLY.test(inner) ? { name: inner, quoted: inDouble, src: s } : { quoted: inDouble, src: s })
      if (inner.includes('$(') || inner.includes('`')) {
        if (depth < 32) lex(inner, subs, flags, depth + 1)
        else flags.truncated = true
      }
      i = close < 0 ? n : close + 1
      return
    }
    if (next !== undefined) {
      IDENT.lastIndex = i + 1
      const m = IDENT.exec(src)
      if (m) {
        const name = m[0]
        w.raw += '$' + name
        if (atStart && name === 'HOME') w.text += HOME
        else if (atStart && name === 'PWD') w.text += '.'
        else dyn(w, { name, quoted: inDouble, src: '$' + name })
        i += 1 + name.length
        return
      }
      if ('0123456789@*#?$!-'.includes(next)) {
        w.raw += '$' + next
        dyn(w, { quoted: inDouble, src: '$' + next })
        i += 2
        return
      }
      if (!inDouble && next === "'") {
        let j = i + 2
        while (j < n && src[j] !== "'") { if (src[j] === '\\') j++; j++ }
        w.raw += src.slice(i, Math.min(j + 1, n))
        w.text += decodeAnsiC(src.slice(i + 2, Math.min(j, n)))
        w.quoted = true
        i = Math.min(j + 1, n)
        return
      }
      if (!inDouble && next === '"') { i++; doubleQuoted(); return }
    }
    w.raw += '$'
    w.text += '$'
    i++
  }

  const backtick = (inDouble: boolean): void => {
    const w = word()
    let j = i + 1
    let inner = ''
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\' && j + 1 < n) { inner += src[j + 1]; j += 2; continue }
      inner += src[j]
      j++
    }
    subs.push(inner)
    const s = src.slice(i, Math.min(j + 1, n))
    w.raw += s
    if (w.text === '' && inner.trim() === 'pwd') w.text += '.'
    else dyn(w, { quoted: inDouble, src: s })
    i = Math.min(j + 1, n)
  }

  function doubleQuoted(): void {
    const w = word()
    w.quoted = true
    const startRaw = i
    i++
    while (i < n && src[i] !== '"') {
      const c = src[i] as string
      if (c === '\\' && i + 1 < n) {
        const d = src[i + 1] as string
        if ('$`"\\'.includes(d)) { w.text += d; i += 2; continue }
        if (d === '\n') { i += 2; continue }
        w.text += c
        i++
        continue
      }
      if (c === '$') { const before = w.raw; dollar(true); w.raw = before; continue }
      if (c === '`') { const before = w.raw; backtick(true); w.raw = before; continue }
      w.text += c
      i++
    }
    i = Math.min(i + 1, n)
    w.raw += src.slice(startRaw, i)
  }

  while (i < n) {
    const c = src[i] as string
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue }
      const w = word()
      const d = src[i + 1] ?? ''
      w.raw += c + d
      w.text += d
      w.quoted = true
      i += 2
      continue
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { finish(); i++; continue }
    if (c === '\n') {
      finish()
      toks.push({ t: 'op', op: ';' })
      i++
      if (pending.length > 0) readHeredocBodies()
      continue
    }
    if (c === '#' && !cur) {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === "'") {
      const w = word()
      const e = src.indexOf("'", i + 1)
      const end = e < 0 ? n : e
      w.text += src.slice(i + 1, end)
      w.raw += src.slice(i, Math.min(end + 1, n))
      w.quoted = true
      i = Math.min(end + 1, n)
      continue
    }
    if (c === '"') { doubleQuoted(); continue }
    if (c === '`') { backtick(false); continue }
    if (c === '$') {
      if (IFS_REF.test(src.slice(i, i + 6)) && !(cur && ASSIGN.test(cur.raw))) {
        finish()
        i += src[i + 1] === '{' ? 6 : 4
        continue
      }
      dollar(false)
      continue
    }
    if (c === '~' && !cur) {
      const pm = /^~([+-])(?=\/|$|[\s;&|()<>])/.exec(src.slice(i, i + 3))
      if (pm) {
        const w = word()
        if (pm[1] === '+') w.text += '.'
        else dyn(w, { quoted: false, src: '~-' })
        w.raw += pm[0]
        i += pm[0].length
        continue
      }
      const m = /^~([A-Za-z0-9._-]*)(?=\/|$|[\s;&|()<>])/.exec(src.slice(i, i + 64))
      if (m) {
        const w = word()
        w.text += HOME
        w.raw += m[0]
        i += m[0].length
        continue
      }
    }
    if ((c === '<' || c === '>') && src[i + 1] === '(') {
      const close = findClose(src, i + 1)
      const inner = close < 0 ? src.slice(i + 2) : src.slice(i + 2, close)
      subs.push(inner)
      const w = word()
      const s = close < 0 ? src.slice(i) : src.slice(i, close + 1)
      w.raw += s
      dyn(w, { quoted: false, src: s })
      i = close < 0 ? n : close + 1
      continue
    }
    if (c === '(' && src[i + 1] === '(' && atCommandStart()) {
      const close = closeOf(i)
      if (close > 0 && closeOf(i + 1) === close - 1) {
        arithSubs(src.slice(i + 2, close - 1), subs, 0, flags)
        const s = src.slice(i, close + 1)
        toks.push({ t: 'word', w: { text: DYN, raw: s, quoted: false, dynamic: true, vars: [{ quoted: false, src: s }] } })
        i = close + 1
        continue
      }
    }
    if ('|&;()<>'.includes(c)) {
      if ((c === '<' || c === '>') && cur && !cur.quoted && /^\d+$/.test(cur.raw)) cur = undefined
      else finish()
      const op = OPS.find(o => src.startsWith(o, i)) ?? c
      i += op.length
      if (REDIR_OPS.has(op)) {
        const tok: Extract<Tok, { t: 'redir' }> = { t: 'redir', op }
        toks.push(tok)
        if (op === '<<' || op === '<<-') delimFor = { tok, strip: op === '<<-' }
      } else {
        toks.push({ t: 'op', op })
      }
      continue
    }
    const w = word()
    if (c === '{' || c === ',' || c === '}') (w.braces ??= []).push(w.text.length)
    else if (c === '~') (w.tildes ??= []).push(w.text.length)
    w.text += c
    w.raw += c
    i++
  }
  finish()
  return toks
}

const BRACE_FULL = 256
const BRACE_MAX_WORDS = 1024
const BRACE_GROUPS = 64
const STAND_IN = 0xE100
const STAND_INS = 3000
const TILDE_STAND_IN = '\uF8FE'

type BracePart = string | { alts: BracePart[][] }

function braceSequence(s: string): string[] | undefined {
  const num = /^(-?\d{1,9})\.\.(-?\d{1,9})(?:\.\.(-?\d{1,9}))?$/.exec(s)
  const chr = num ? undefined : /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d{1,9}))?$/.exec(s)
  const m = num ?? chr
  if (!m) return undefined
  const a = num ? Number(m[1]) : (m[1] as string).charCodeAt(0)
  const b = num ? Number(m[2]) : (m[2] as string).charCodeAt(0)
  const step = Math.max(1, Math.abs(Number(m[3] ?? '1')) || 1)
  const width = num && (/^-?0\d/.test(m[1] as string) || /^-?0\d/.test(m[2] as string)) ? Math.max((m[1] as string).length, (m[2] as string).length) : 0
  const out: string[] = []
  const dir = a <= b ? 1 : -1
  for (let v = a; dir > 0 ? v <= b : v >= b; v += dir * step) {
    if (out.length > BRACE_FULL) break
    if (!num) { out.push(String.fromCharCode(v)); continue }
    const t = String(Math.abs(v))
    out.push((v < 0 ? '-' : '') + (width > 0 ? t.padStart(width - (v < 0 ? 1 : 0), '0') : t))
  }
  return out
}

function braceParts(t: string, close: Map<number, number>, commas: Map<number, number[]>, start: number, end: number, depth: number): BracePart[] {
  const out: BracePart[] = []
  let lit = ''
  let i = start
  while (i < end) {
    const c = close.get(i)
    if (c !== undefined && c < end && depth < 16) {
      const cs = commas.get(i) ?? []
      if (cs.length > 0) {
        const alts: BracePart[][] = []
        let s = i + 1
        for (const x of [...cs, c]) { alts.push(braceParts(t, close, commas, s, x, depth + 1)); s = x + 1 }
        if (lit !== '') { out.push(lit); lit = '' }
        out.push({ alts })
        i = c + 1
        continue
      }
      const seq = braceSequence(t.slice(i + 1, c))
      if (seq) {
        if (lit !== '') { out.push(lit); lit = '' }
        out.push({ alts: seq.map(x => [x]) })
        i = c + 1
        continue
      }
    }
    lit += t[i] as string
    i++
  }
  if (lit !== '') out.push(lit)
  return out
}

function braceCount(parts: BracePart[]): number {
  let n = 1
  for (const p of parts) {
    if (typeof p === 'string') continue
    let s = 0
    for (const alt of p.alts) s = Math.min(1e9, s + braceCount(alt))
    n = Math.min(1e9, n * s)
  }
  return n
}

function braceFull(parts: BracePart[]): string[] {
  let acc = ['']
  for (const p of parts) {
    if (typeof p === 'string') { acc = acc.map(a => a + p); continue }
    const opts = p.alts.flatMap(alt => braceFull(alt))
    const next: string[] = []
    for (const a of acc) for (const o of opts) next.push(a + o)
    acc = next
  }
  return acc
}

function braceFirst(parts: BracePart[]): string {
  return parts.map(p => (typeof p === 'string' ? p : braceFirst(p.alts[0] ?? []))).join('')
}

function braceSample(parts: BracePart[], out: Set<string>, prefix: string, suffix: string): void {
  const base = parts.map(p => (typeof p === 'string' ? p : braceFirst(p.alts[0] ?? [])))
  out.add(prefix + base.join('') + suffix)
  let before = prefix
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k] as BracePart
    if (typeof p !== 'string') {
      const after = base.slice(k + 1).join('') + suffix
      for (const alt of p.alts) {
        if (out.size >= BRACE_MAX_WORDS) return
        braceSample(alt, out, before, after)
      }
    }
    before += base[k] as string
  }
}

function quoteRawPart(s: string): string {
  return /^[A-Za-z0-9_@%+=:,./*?^!-]*$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`
}

export function rawFromText(text: string, vars: readonly VarRef[] | undefined): string {
  let out = ''
  let lit = ''
  let k = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (ch === HOME || ch === DYN) {
      if (lit !== '') { out += quoteRawPart(lit); lit = '' }
      if (ch === HOME) out += i === 0 ? '~' : '"$HOME"'
      else {
        const ref = vars?.[k]
        k++
        const s = ref?.src ?? '$__BURACLE_UNKNOWN'
        out += ref?.quoted === true ? `"${s}"` : s
      }
      continue
    }
    lit += ch
  }
  if (lit !== '') out += quoteRawPart(lit)
  return out === '' ? "''" : out
}

export function expandBraces(w: ShellWord): ShellWord[] {
  const pos = w.braces
  if (pos === undefined || pos.length < 2) return [w]
  const refs = w.vars ?? []
  if (refs.length > STAND_INS || w.text.length > 16_384) return [w]
  const tildes = new Set(w.tildes ?? [])
  let t = ''
  let k = 0
  for (let i = 0; i < w.text.length; i++) {
    const ch = w.text[i] as string
    if (ch === DYN) { t += String.fromCharCode(STAND_IN + k); k++ } else if (tildes.has(i)) t += TILDE_STAND_IN
    else t += ch
  }
  const close = new Map<number, number>()
  const commas = new Map<number, number[]>()
  const stack: number[] = []
  for (const p of pos) {
    const ch = t[p]
    if (ch === '{') stack.push(p)
    else if (ch === '}') { const o = stack.pop(); if (o !== undefined) close.set(o, p) }
    else if (ch === ',' && stack.length > 0) {
      const o = stack[stack.length - 1] as number
      const list = commas.get(o)
      if (list) list.push(p)
      else commas.set(o, [p])
    }
  }
  if (close.size === 0 || close.size > BRACE_GROUPS) return [w]
  const parts = braceParts(t, close, commas, 0, t.length, 0)
  if (parts.every(p => typeof p === 'string')) return [w]
  let texts: string[]
  if (braceCount(parts) <= BRACE_FULL) texts = braceFull(parts)
  else {
    const set = new Set<string>()
    braceSample(parts, set, '', '')
    texts = [...set]
  }
  const out: ShellWord[] = []
  for (const y of texts.slice(0, BRACE_MAX_WORDS)) {
    const x = y.startsWith(TILDE_STAND_IN) && (y.length === 1 || y[1] === '/') ? HOME + y.slice(1) : y
    let text = ''
    const vars: VarRef[] = []
    for (let i = 0; i < x.length; i++) {
      const code = x.charCodeAt(i)
      if (code >= STAND_IN && code < STAND_IN + STAND_INS) { text += DYN; vars.push(refs[code - STAND_IN] ?? { quoted: false }) } else if (x[i] === TILDE_STAND_IN) text += '~'
      else text += x[i] as string
    }
    if (text === '' && !w.quoted) continue
    const word: ShellWord = { text, raw: rawFromText(text, vars), quoted: w.quoted, dynamic: text.includes(DYN) }
    if (vars.length > 0) word.vars = vars
    out.push(word)
  }
  return out
}

const RESERVED = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '{', '}', '!', 'esac', '[[', ']]'])

function newCmd(): SimpleCommand { return { assigns: [], words: [], redirects: [] } }

function redirectOf(r: Extract<Tok, { t: 'redir' }>, target: ShellWord | undefined): Redirect {
  const out: Redirect = { op: r.op }
  if (target) out.target = target
  if (r.body !== undefined) out.body = r.body
  if (r.heredoc !== undefined && r.heredoc.quoted === false) out.bodyExpands = true
  return out
}

function parseTokens(toks: Tok[]): Script {
  let p = 0
  const parseList = (inGroup: boolean, depth: number): Script => {
    const pipelines: Pipeline[] = []
    let stages: Stage[] = []
    let cmd = newCmd()
    let skipClause = false
    const flushCmd = (): void => {
      if (cmd.words.length > 0 || cmd.assigns.length > 0 || cmd.redirects.length > 0) stages.push({ kind: 'cmd', cmd })
      cmd = newCmd()
    }
    const flushPipeline = (): void => {
      flushCmd()
      if (stages.length > 0) pipelines.push({ stages })
      stages = []
      skipClause = false
    }
    while (p < toks.length) {
      const tk = toks[p] as Tok
      if (tk.t === 'op') {
        if (tk.op === ')') {
          p++
          if (inGroup) { flushPipeline(); return { pipelines } }
          flushCmd()
          skipClause = false
          continue
        }
        if (tk.op === '(') {
          p++
          const next = toks[p]
          if (cmd.words.length === 1 && next !== undefined && next.t === 'op' && next.op === ')') {
            p++
            cmd = newCmd()
            continue
          }
          flushCmd()
          const body = depth < 64 ? parseList(true, depth + 1) : { pipelines: [] }
          const redirects: Redirect[] = []
          while (p < toks.length) {
            const r = toks[p] as Tok
            if (r.t !== 'redir') break
            p++
            const tw = toks[p]
            const target = tw !== undefined && tw.t === 'word' ? (p++, tw.w) : undefined
            redirects.push(redirectOf(r, target))
          }
          stages.push({ kind: 'group', body, redirects })
          continue
        }
        if (tk.op === '|' || tk.op === '|&') { flushCmd(); p++; skipClause = false; continue }
        flushPipeline()
        p++
        continue
      }
      if (tk.t === 'redir') {
        p++
        const tw = toks[p]
        const target = tw !== undefined && tw.t === 'word' ? (p++, tw.w) : undefined
        cmd.redirects.push(redirectOf(tk, target))
        continue
      }
      p++
      if (skipClause) continue
      const w = tk.w
      if (cmd.words.length === 0) {
        if (!w.quoted) {
          if (w.text === 'for' || w.text === 'select' || w.text === 'case') { skipClause = true; continue }
          if (w.text === 'function') {
            const nx = toks[p]
            if (nx !== undefined && nx.t === 'word') p++
            continue
          }
          if (RESERVED.has(w.text)) continue
        }
        if (ASSIGN.test(w.raw)) { delete w.braces; delete w.tildes; cmd.assigns.push(w); continue }
      }
      if (w.braces !== undefined) {
        for (const x of expandBraces(w)) { delete x.braces; delete x.tildes; cmd.words.push(x) }
      } else {
        delete w.tildes
        cmd.words.push(w)
      }
    }
    flushPipeline()
    return { pipelines }
  }
  return parseList(false, 0)
}

export function parseShell(src: string): ParsedShell {
  const subs: string[] = []
  const flags: LexFlags = { truncated: false }
  const toks = lex(src, subs, flags)
  const script = parseTokens(toks)
  return flags.truncated ? { script, subs, truncated: true } : { script, subs }
}

export function simpleCommands(script: Script): SimpleCommand[] {
  const out: SimpleCommand[] = []
  const visit = (s: Script, depth: number): void => {
    if (depth > 64) return
    for (const pl of s.pipelines) {
      for (const st of pl.stages) {
        if (st.kind === 'cmd') out.push(st.cmd)
        else visit(st.body, depth + 1)
      }
    }
  }
  visit(script, 0)
  return out
}

export function stageCommands(stage: Stage): SimpleCommand[] {
  return stage.kind === 'cmd' ? [stage.cmd] : simpleCommands(stage.body)
}

export function commandName(w: ShellWord | undefined): string | undefined {
  if (!w || w.text === '' || w.text.includes(DYN) || w.text.startsWith(HOME)) return undefined
  const base = w.text.slice(w.text.lastIndexOf('/') + 1)
  return base === '' ? undefined : base.toLowerCase()
}

export const SHELL_NAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish'])

export interface Unwrapped {
  argv: ShellWord[]
  scripts: string[]
  shellReadsStdin: boolean
  tooDeep?: boolean
}

const MAX_WRAPPERS = 24

function isSudoShellFlag(w: ShellWord): boolean {
  const t = w.text
  if (t === '--shell' || t === '--login') return true
  if (!/^-[A-Za-z]/.test(t)) return false
  for (const l of t.slice(1)) {
    if (l === 's' || l === 'i') return true
    if (SUDO_ARG.has(l)) return false
  }
  return false
}

function joinWords(ws: ShellWord[]): string {
  return ws.map(w => (w.dynamic ? w.raw : w.text)).join(' ')
}

function skipOptions(ws: ShellWord[], withArg: ReadonlySet<string>, longWithArg: ReadonlySet<string> = new Set()): ShellWord[] {
  let k = 0
  while (k < ws.length) {
    const t = (ws[k] as ShellWord).text
    if (t === '--') { k++; break }
    if (!t.startsWith('-') || t === '-') break
    if (t.startsWith('--')) {
      const name = t.split('=')[0] as string
      k += longWithArg.has(name) && !t.includes('=') ? 2 : 1
      continue
    }
    const letters = t.slice(1)
    let consumed = 1
    for (let j = 0; j < letters.length; j++) {
      if (withArg.has(letters[j] as string)) { consumed = j === letters.length - 1 ? 2 : 1; break }
    }
    k += consumed
  }
  return ws.slice(k)
}

const SUDO_ARG = new Set(['u', 'g', 'h', 'p', 'C', 'D', 'r', 't', 'U', 'T', 'c'])
const SUDO_LONG_ARG = new Set(['--user', '--group', '--host', '--prompt', '--close-from', '--chdir', '--role', '--type', '--other-user', '--command-timeout', '--login-class'])
const DOAS_ARG = new Set(['u', 'C'])
const NICE_ARG = new Set(['n'])
const TIMEOUT_ARG = new Set(['s', 'k'])
const TIMEOUT_LONG_ARG = new Set(['--signal', '--kill-after'])
const XARGS_ARG = new Set(['I', 'L', 'n', 'P', 's', 'E', 'd', 'a', 'R', 'S'])
const XARGS_LONG_ARG = new Set(['--max-args', '--max-procs', '--max-chars', '--delimiter', '--arg-file', '--eof', '--replace', '--max-lines', '--process-slot-var'])
const STDBUF_ARG = new Set(['i', 'o', 'e'])
const SIMPLE_WRAPPERS = new Set(['nohup', 'builtin', 'chronic', 'unbuffer', 'nocorrect', 'noglob', 'busybox', 'toybox', '-'])
const WRAPPER_ARGS: Readonly<Record<string, ReadonlySet<string>>> = {
  caffeinate: new Set(['t', 'w']),
  taskpolicy: new Set(['c', 'd', 't', 'l', 'p']),
}
const SHELL_ARG_OPTS = new Set(['o', 'O'])

export function unwrap(words: ShellWord[]): Unwrapped {
  let argv = words
  const scripts: string[] = []
  let guard = 0
  for (; guard < MAX_WRAPPERS && argv.length > 0; guard++) {
    const name = commandName(argv[0])
    if (name === undefined) break
    const rest = argv.slice(1)
    if (name === 'sudo' || name === 'sudoedit') {
      if (name === 'sudoedit' || rest.some(w => w.text === '-e' || w.text === '--edit')) return { argv: [], scripts, shellReadsStdin: false }
      argv = skipOptions(rest, SUDO_ARG, SUDO_LONG_ARG)
      if (argv.length > 0 && rest.slice(0, rest.length - argv.length).some(isSudoShellFlag)) scripts.push(joinWords(argv))
      continue
    }
    if (name === 'doas') { argv = skipOptions(rest, DOAS_ARG); continue }
    if (name === 'env') {
      let k = 0
      while (k < rest.length) {
        const t = (rest[k] as ShellWord).text
        if (t === '--') { k++; break }
        if (t === '-S' || t === '--split-string') { const s = rest[k + 1]; if (s) scripts.push(s.text); k += 2; continue }
        if (t.startsWith('--split-string=')) { scripts.push(t.slice('--split-string='.length)); k++; continue }
        if (t === '-u' || t === '-C' || t === '-P' || t === '--unset' || t === '--chdir') { k += 2; continue }
        if (t.startsWith('-') && t !== '-') { k++; continue }
        break
      }
      while (k < rest.length && ASSIGN.test((rest[k] as ShellWord).raw)) k++
      argv = rest.slice(k)
      continue
    }
    if (name === 'command') {
      const r = skipOptions(rest, new Set())
      if (rest.some(w => w.text === '-v' || w.text === '-V')) return { argv: [], scripts, shellReadsStdin: false }
      argv = r
      continue
    }
    if (name === 'exec') { argv = skipOptions(rest, new Set(['a'])); continue }
    if (name === 'nice' || name === 'renice') { argv = skipOptions(rest, NICE_ARG); continue }
    if (name === 'timeout' || name === 'gtimeout') {
      const r = skipOptions(rest, TIMEOUT_ARG, TIMEOUT_LONG_ARG)
      argv = r.slice(1)
      continue
    }
    if (name === 'stdbuf') { argv = skipOptions(rest, STDBUF_ARG); continue }
    if (SIMPLE_WRAPPERS.has(name)) { argv = name === '-' ? rest : skipOptions(rest, new Set()); continue }
    const withArgs = WRAPPER_ARGS[name]
    if (withArgs !== undefined) { argv = skipOptions(rest, withArgs); continue }
    if (name === 'repeat') { argv = rest.slice(1); continue }
    if (name === 'coproc') {
      const r = rest[0] !== undefined && rest[1] !== undefined && /^[A-Za-z_][A-Za-z0-9_]*$/.test(rest[0].text) && (rest[1].text === '{' || rest[1].text === '(') ? rest.slice(2) : rest
      argv = r[0]?.text === '{' || r[0]?.text === '(' ? r.slice(1) : r
      continue
    }
    if (name === 'trap') {
      const r = skipOptions(rest, new Set())
      if (r.length >= 2 && !rest.some(w => w.text === '-p' || w.text === '-l')) scripts.push(r[0]?.dynamic === true ? (r[0] as ShellWord).raw : (r[0] as ShellWord).text)
      return { argv: [], scripts, shellReadsStdin: false }
    }
    if (name === 'script') {
      let k = 0
      while (k < rest.length && (rest[k] as ShellWord).text.startsWith('-')) {
        const t = (rest[k] as ShellWord).text
        if (t === '-c' || t === '--command') { const c = rest[k + 1]; if (c) scripts.push(c.dynamic ? c.raw : c.text); k += 2; continue }
        if (t === '-t' || t === '-T' || t === '-I' || t === '-O' || t === '-B' || t === '-E') { k += 2; continue }
        k++
      }
      argv = rest.slice(k + 1)
      if (argv.length === 0) return { argv: [], scripts, shellReadsStdin: false }
      continue
    }
    if (name === 'xargs') {
      const r = skipOptions(rest, XARGS_ARG, XARGS_LONG_ARG)
      if (r.length === 0) return { argv: [], scripts, shellReadsStdin: false }
      argv = r
      continue
    }
    if (name === 'watch') {
      const r = skipOptions(rest, new Set(['n', 'd', 'q']), new Set(['--interval', '--differences']))
      if (r.length > 0) scripts.push(joinWords(r))
      return { argv: [], scripts, shellReadsStdin: false }
    }
    if (name === 'eval') {
      if (rest.length > 0) scripts.push(joinWords(rest))
      return { argv: [], scripts, shellReadsStdin: false }
    }
    if (name === 'su') {
      for (let k = 0; k < rest.length; k++) {
        const t = (rest[k] as ShellWord).text
        if ((t === '-c' || t === '--command') && rest[k + 1]) scripts.push((rest[k + 1] as ShellWord).text)
        else if (t.startsWith('--command=')) scripts.push(t.slice('--command='.length))
      }
      return { argv: [], scripts, shellReadsStdin: false }
    }
    if (SHELL_NAMES.has(name)) {
      let k = 0
      let hasC = false
      let readsStdin = false
      while (k < rest.length) {
        const t = (rest[k] as ShellWord).text
        if (t === '--' || t === '-') { k++; if (t === '-') readsStdin = true; break }
        if (!t.startsWith('-') && !t.startsWith('+')) break
        if (t.startsWith('--')) { k++; continue }
        const letters = t.slice(1)
        if (letters.includes('c')) hasC = true
        if (letters.includes('s')) readsStdin = true
        k++
        if ([...letters].some(l => SHELL_ARG_OPTS.has(l))) k++
      }
      if (hasC) {
        const script = rest[k]
        if (script) scripts.push(script.dynamic ? script.raw : script.text)
        return { argv, scripts, shellReadsStdin: false }
      }
      const operand = rest[k]
      return { argv, scripts, shellReadsStdin: readsStdin || operand === undefined || operand.text === '/dev/stdin' || operand.text === '/dev/fd/0' }
    }
    const l = launched(name, rest)
    if (l === undefined) break
    scripts.push(...l.scripts)
    if (l.stdin === true) return { argv, scripts, shellReadsStdin: true }
    argv = l.argv
  }
  if (guard >= MAX_WRAPPERS && argv.length > 0) return { argv, scripts, shellReadsStdin: false, tooDeep: true }
  return { argv, scripts, shellReadsStdin: false }
}
