export type FmScalar = string | number | boolean | null
export type FmValue = FmScalar | FmValue[] | { [k: string]: FmValue }
export type FmData = Record<string, FmValue>

export interface ParsedFrontmatter {
  data: FmData
  body: string
  hasFrontmatter: boolean
}

const OPEN = /^---[ \t]*\r?\n/
const CLOSE = /^(?:---|\.\.\.)[ \t]*$/

export function parseFrontmatter(markdown: string): ParsedFrontmatter {
  const text = markdown.replace(/^﻿/, '')
  if (!OPEN.test(text)) return { data: {}, body: text, hasFrontmatter: false }
  const lines = text.split(/\r?\n/)
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (CLOSE.test(lines[i] ?? '')) { end = i; break }
  }
  if (end < 0) return { data: {}, body: text, hasFrontmatter: false }
  const data = parseYamlBlock(lines.slice(1, end))
  let body = lines.slice(end + 1).join('\n')
  if (body.startsWith('\n')) body = body.slice(1)
  return { data, body, hasFrontmatter: true }
}

export function parseYamlBlock(lines: string[]): FmData {
  const out: FmData = {}
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (isBlankOrComment(line) || indentOf(line) > 0) { i++; continue }
    const kv = splitKey(line)
    if (!kv) { i++; continue }
    const [key, rest] = kv
    if (rest === '' ) {
      const child = collectChildren(lines, i + 1)
      i = child.next
      out[key] = child.lines.length === 0 ? null : parseChildBlock(child.lines)
      continue
    }
    if (/^[|>][+-]?$/.test(rest)) {
      const child = collectChildren(lines, i + 1)
      i = child.next
      out[key] = blockScalar(rest, child.lines)
      continue
    }
    out[key] = parseInline(rest)
    i++
  }
  return out
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim()
  return t === '' || t.startsWith('#')
}

function indentOf(line: string): number {
  const m = /^( *)/.exec(line)
  return m?.[1]?.length ?? 0
}

function splitKey(line: string): [string, string] | undefined {
  const t = line.trim()
  let key: string
  let rest: string
  if (t.startsWith('"') || t.startsWith("'")) {
    const q = t[0] as string
    const close = t.indexOf(q, 1)
    if (close < 0) return undefined
    key = t.slice(1, close)
    const after = t.slice(close + 1)
    if (!after.startsWith(':')) return undefined
    rest = after.slice(1).trim()
  } else {
    const m = /^([^:#][^:]*?):(?:\s+(.*)|\s*)$/.exec(t)
    if (!m) return undefined
    key = (m[1] ?? '').trim()
    rest = (m[2] ?? '').trim()
  }
  return [key, rest]
}

function collectChildren(lines: string[], start: number): { lines: string[], next: number } {
  const out: string[] = []
  let i = start
  while (i < lines.length) {
    const line = lines[i] ?? ''
    if (line.trim() === '') { out.push(line); i++; continue }
    if (indentOf(line) === 0 && !line.startsWith('- ') && line !== '-') break
    if (indentOf(line) === 0 && (line.startsWith('- ') || line === '-')) {
      out.push(line)
      i++
      continue
    }
    out.push(line)
    i++
  }
  while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') out.pop()
  return { lines: out, next: i }
}

function parseChildBlock(lines: string[]): FmValue {
  const content = lines.filter(l => !isBlankOrComment(l))
  if (content.length === 0) return null
  const first = (content[0] ?? '').trim()
  if (first.startsWith('- ') || first === '-') {
    const items: FmValue[] = []
    for (const l of content) {
      const t = l.trim()
      if (t.startsWith('- ')) items.push(parseInline(t.slice(2).trim()))
      else if (t === '-') items.push(null)
    }
    return items
  }
  const base = indentOf(content[0] ?? '')
  const map: Record<string, FmValue> = {}
  let i = 0
  while (i < content.length) {
    const l = content[i] ?? ''
    if (indentOf(l) !== base) { i++; continue }
    const kv = splitKey(l)
    if (!kv) { i++; continue }
    const [k, rest] = kv
    if (rest === '') {
      const sub: string[] = []
      let j = i + 1
      while (j < content.length && indentOf(content[j] ?? '') > base) { sub.push(content[j] ?? ''); j++ }
      map[k] = sub.length === 0 ? null : parseChildBlock(sub)
      i = j
      continue
    }
    map[k] = parseInline(rest)
    i++
  }
  return map
}

function blockScalar(indicator: string, lines: string[]): string {
  const content = lines.slice()
  const nonEmpty = content.filter(l => l.trim() !== '')
  const indent = nonEmpty.length === 0 ? 0 : Math.min(...nonEmpty.map(indentOf))
  const stripped = content.map(l => l.slice(Math.min(indent, indentOf(l))))
  const literal = indicator.startsWith('|')
  let text: string
  if (literal) {
    text = stripped.join('\n')
  } else {
    const paras: string[] = []
    let cur: string[] = []
    for (const l of stripped) {
      if (l.trim() === '') { paras.push(cur.join(' ')); cur = [] }
      else cur.push(l.trim())
    }
    paras.push(cur.join(' '))
    text = paras.join('\n').replace(/\n+$/, '')
  }
  if (indicator.endsWith('-')) return text.replace(/\n+$/, '')
  if (indicator.endsWith('+')) return text + '\n'
  return text.replace(/\n*$/, '\n')
}

export function parseInline(raw: string): FmValue {
  const s = raw.trim()
  if (s === '') return null
  if (s.startsWith('[')) {
    const close = findFlowClose(s)
    if (close === s.length - 1 || /^\s*(#.*)?$/.test(s.slice(close + 1))) return splitFlow(s.slice(1, close)).map(parseInline)
  }
  if (s.startsWith('"')) {
    const end = findDoubleQuoteEnd(s)
    if (end > 0) return unescapeDouble(s.slice(1, end))
  }
  if (s.startsWith("'")) {
    const end = findSingleQuoteEnd(s)
    if (end > 0) return s.slice(1, end).replace(/''/g, "'")
  }
  const plain = stripTrailingComment(s)
  return typedScalar(plain)
}

function stripTrailingComment(s: string): string {
  const idx = s.search(/\s#/)
  return (idx >= 0 ? s.slice(0, idx) : s).trim()
}

function typedScalar(s: string): FmScalar {
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false
  if (/^[-+]?\d+$/.test(s) && Number.isSafeInteger(Number(s))) return Number(s)
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) return Number(s)
  return s
}

function findFlowClose(s: string): number {
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') { i++; continue }
      if (c === quote) {
        if (quote === "'" && s[i + 1] === "'") { i++; continue }
        quote = undefined
      }
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) return i }
  }
  return -1
}

function splitFlow(inner: string): string[] {
  const parts: string[] = []
  let cur = ''
  let depth = 0
  let quote: string | undefined
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] as string
    if (quote) {
      cur += c
      if (c === '\\' && quote === '"' && i + 1 < inner.length) { cur += inner[i + 1]; i++; continue }
      if (c === quote) {
        if (quote === "'" && inner[i + 1] === "'") { cur += "'"; i++; continue }
        quote = undefined
      }
      continue
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue }
    if (c === '[' || c === '{') depth++
    if (c === ']' || c === '}') depth--
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue }
    cur += c
  }
  if (cur.trim() !== '') parts.push(cur)
  return parts.map(p => p.trim()).filter(p => p !== '')
}

function findDoubleQuoteEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue }
    if (s[i] === '"') return i
  }
  return -1
}

function findSingleQuoteEnd(s: string): number {
  for (let i = 1; i < s.length; i++) {
    if (s[i] === "'") {
      if (s[i + 1] === "'") { i++; continue }
      return i
    }
  }
  return -1
}

function unescapeDouble(s: string): string {
  return s.replace(/\\(U[0-9a-fA-F]{8}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_m, e: string) => {
    if (e.startsWith('U')) return String.fromCodePoint(parseInt(e.slice(1), 16))
    if (e.startsWith('u') || e.startsWith('x')) return String.fromCharCode(parseInt(e.slice(1), 16))
    switch (e) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case 'b': return '\b'
      case 'f': return '\f'
      case 'v': return '\v'
      case 'a': return '\x07'
      case 'e': return '\x1b'
      case '0': return '\0'
      case 'N': return '\u0085'
      case '_': return '\u00a0'
      case 'L': return '\u2028'
      case 'P': return '\u2029'
      case '"': return '"'
      case '\\': return '\\'
      case '/': return '/'
      default: return e
    }
  })
}

export function renderYamlBlock(data: Record<string, unknown>, order: string[] = []): string {
  const keys = [...order.filter(k => k in data), ...Object.keys(data).filter(k => !order.includes(k))]
  const out: string[] = []
  for (const k of keys) {
    const v = data[k]
    if (v === undefined) continue
    out.push(...renderEntry(k, v, 0))
  }
  return out.join('\n')
}

function renderEntry(key: string, value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent)
  const k = renderKey(key)
  if (Array.isArray(value)) {
    if (value.every(isScalarLike)) return [`${pad}${k}: [${value.map(renderFlowScalar).join(', ')}]`]
    return [`${pad}${k}:`, ...value.map(v => `${pad}  - ${isScalarLike(v) ? renderScalar(v) : renderScalar(JSON.stringify(v))}`)]
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return [`${pad}${k}: {}`]
    const lines = [`${pad}${k}:`]
    for (const [ck, cv] of entries) {
      if (cv !== null && typeof cv === 'object' && !Array.isArray(cv)) {
        lines.push(`${pad}  ${renderKey(ck)}: ${renderScalar(JSON.stringify(cv))}`)
      } else {
        lines.push(...renderEntry(ck, cv, indent + 2))
      }
    }
    return lines
  }
  if (typeof value === 'string' && value.includes('\n') && literalBlockFits(value)) {
    const body = value.replace(/\n$/, '').split('\n').map(l => (l === '' ? '' : `${pad}  ${l}`))
    return [`${pad}${k}: ${value.endsWith('\n') ? '|' : '|-'}`, ...body]
  }
  return [`${pad}${k}: ${renderScalar(value)}`]
}

function literalBlockFits(s: string): boolean {
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(s)) return false
  if (/\n\n$/.test(s)) return false
  const lines = s.replace(/\n$/, '').split('\n')
  const first = lines.find(l => l.trim() !== '')
  if (first === undefined || /^[ \t]/.test(first)) return false
  return (lines[lines.length - 1] ?? '').trim() !== '' || lines[lines.length - 1] === ''
}

function renderFlowScalar(v: unknown): string {
  if (typeof v === 'string' && !needsQuotes(v) && /[,[\]{}]/.test(v)) return JSON.stringify(v)
  return renderScalar(v)
}

function isScalarLike(v: unknown): boolean {
  return v === null || ['string', 'number', 'boolean'].includes(typeof v)
}

function renderKey(key: string): string {
  return /^[A-Za-z0-9_][A-Za-z0-9_.\-/]*$/.test(key) ? key : JSON.stringify(key)
}

export function renderScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : JSON.stringify(String(v))
  const s = String(v)
  if (needsQuotes(s)) return JSON.stringify(s)
  return s
}

function needsQuotes(s: string): boolean {
  if (s === '') return true
  if (s !== s.trim()) return true
  if (/^(true|false|null|yes|no|on|off|~)$/i.test(s)) return true
  if (/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return true
  if (/^[-+]?(?:0x[0-9a-f]+|0o[0-7]+|\.(?:inf|nan))$/i.test(s)) return true
  if (/^[\[\]{}>|*&!%@`'",?#-]/.test(s) && !/^-[A-Za-z0-9]/.test(s)) return true
  if (s.startsWith('- ')) return true
  if (/: |:$| #|\t/.test(s)) return true
  if (/[\x00-\x1f]/.test(s)) return true
  return false
}

export function renderFrontmatter(data: Record<string, unknown>, body: string, order: string[] = []): string {
  const yaml = renderYamlBlock(data, order)
  const b = body.startsWith('\n') ? body.slice(1) : body
  return `---\n${yaml}\n---\n${b.length > 0 ? '\n' + b : ''}`
}
