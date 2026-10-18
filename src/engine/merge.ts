import { applyEdits, findNodeAtLocation, modify, parse as parseJsonc, parseTree, printParseErrorCode, type JSONPath, type Node as JsonNode, type ParseError } from 'jsonc-parser'
import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify as yamlStringify } from 'yaml'
import { sha256 } from './fsx'

export type KeyPath = Array<string | number>

export function parseKeyPath(path: string | readonly (string | number)[]): KeyPath {
  if (typeof path !== 'string') return [...path]
  const segs: string[] = []
  let i = 0
  const s = path
  if (s.trim() === '') throw new Error('empty key path')
  while (i < s.length) {
    while (s[i] === ' ' || s[i] === '\t') i++
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i]
      let j = i + 1
      let out = ''
      while (j < s.length && s[j] !== q) {
        if (q === '"' && s[j] === '\\' && j + 1 < s.length) { out += s[j + 1]; j += 2; continue }
        out += s[j]
        j++
      }
      if (j >= s.length) throw new Error(`unterminated quote in key path ${JSON.stringify(path)}`)
      segs.push(out)
      i = j + 1
    } else {
      let j = i
      while (j < s.length && s[j] !== '.') j++
      const seg = s.slice(i, j).trim()
      if (seg === '') throw new Error(`empty segment in key path ${JSON.stringify(path)}`)
      segs.push(seg)
      i = j
    }
    while (s[i] === ' ' || s[i] === '\t') i++
    if (i < s.length) {
      if (s[i] !== '.') throw new Error(`unexpected ${JSON.stringify(s[i])} in key path ${JSON.stringify(path)}`)
      i++
      if (i >= s.length) throw new Error(`trailing dot in key path ${JSON.stringify(path)}`)
    }
  }
  return segs
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'undefined'
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = sortKeys(x)
    }
    return out
  }
  return v
}

export function valueHash(value: unknown): string {
  return sha256(stableStringify(value))
}

function preserveEol(original: string, out: string): string {
  if (!original.includes('\r\n') || /(^|[^\r])\n/.test(original)) return out
  return out.replace(/(?<!\r)\n/g, '\r\n')
}

export function getIn(root: unknown, path: KeyPath): { found: boolean, value: unknown } {
  let cur: unknown = root
  for (const seg of path) {
    if (Array.isArray(cur)) {
      const idx = typeof seg === 'number' ? seg : /^\d+$/.test(seg) ? Number(seg) : NaN
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return { found: false, value: undefined }
      cur = cur[idx]
      continue
    }
    if (cur !== null && typeof cur === 'object' && Object.prototype.hasOwnProperty.call(cur, String(seg))) {
      cur = (cur as Record<string, unknown>)[String(seg)]
      continue
    }
    return { found: false, value: undefined }
  }
  return { found: true, value: cur }
}

export function tomlParse(text: string): Record<string, unknown> {
  if (text.trim() === '') return {}
  return Bun.TOML.parse(text) as Record<string, unknown>
}

type StmtKind = 'blank' | 'comment' | 'table' | 'array' | 'kv'
interface Stmt { kind: StmtKind; start: number; end: number; key?: string[]; indent?: string; valueEnd?: number }

class TomlScanError extends Error {}

function scanToml(text: string): Stmt[] {
  const stmts: Stmt[] = []
  const n = text.length
  let pos = 0
  const eol = (p: number): number => {
    const i = text.indexOf('\n', p)
    return i < 0 ? n : i + 1
  }
  const skipWs = (p: number): number => {
    while (p < n && (text[p] === ' ' || text[p] === '\t')) p++
    return p
  }
  const parseKey = (p: number): { segs: string[], end: number } => {
    const segs: string[] = []
    for (;;) {
      p = skipWs(p)
      const c = text[p]
      if (c === '"') {
        let j = p + 1
        let out = ''
        while (j < n && text[j] !== '"') {
          if (text[j] === '\n') throw new TomlScanError('newline in quoted key')
          if (text[j] === '\\') {
            const e = text[j + 1]
            const map: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }
            if (e === 'u' || e === 'U') {
              const len = e === 'u' ? 4 : 8
              out += String.fromCodePoint(parseInt(text.slice(j + 2, j + 2 + len), 16))
              j += 2 + len
              continue
            }
            out += e !== undefined && map[e] !== undefined ? map[e] : (e ?? '')
            j += 2
            continue
          }
          out += text[j]
          j++
        }
        segs.push(out)
        p = j + 1
      } else if (c === "'") {
        const j = text.indexOf("'", p + 1)
        if (j < 0) throw new TomlScanError('unterminated literal key')
        segs.push(text.slice(p + 1, j))
        p = j + 1
      } else {
        let j = p
        while (j < n && /[A-Za-z0-9_-]/.test(text[j] as string)) j++
        if (j === p) throw new TomlScanError(`bad key at offset ${p}`)
        segs.push(text.slice(p, j))
        p = j
      }
      const q = skipWs(p)
      if (text[q] === '.') { p = q + 1; continue }
      return { segs, end: q }
    }
  }
  const scanValue = (p: number): { end: number, valueEnd: number } => {
    let depth = 0
    let valueEnd = p
    while (p < n) {
      const c = text[p]
      if (c === '"' || c === "'") {
        const triple = text.startsWith(c.repeat(3), p)
        if (triple) {
          let q = p + 3
          let close = -1
          while (q < n) {
            if (c === '"' && text[q] === '\\') { q += 2; continue }
            if (text.startsWith(c.repeat(3), q)) { close = q; break }
            q++
          }
          if (close < 0) throw new TomlScanError('unterminated multi-line string')
          q = close + 3
          while (q < n && text[q] === c && q < close + 5) q++
          p = q
          valueEnd = p
          continue
        }
        let q = p + 1
        while (q < n && text[q] !== c && text[q] !== '\n') {
          if (c === '"' && text[q] === '\\') q++
          q++
        }
        p = q + 1
        valueEnd = Math.min(p, n)
        continue
      }
      if (c === '#') { p = text.indexOf('\n', p); if (p < 0) return { end: n, valueEnd }; continue }
      if (c === '[' || c === '{') { depth++; p++; valueEnd = p; continue }
      if (c === ']' || c === '}') { depth--; p++; valueEnd = p; continue }
      if (c === '\n') {
        if (depth <= 0) return { end: p + 1, valueEnd }
        p++
        continue
      }
      if (c !== ' ' && c !== '\t' && c !== '\r') valueEnd = p + 1
      p++
    }
    return { end: n, valueEnd }
  }
  while (pos < n) {
    const lineStart = pos
    const p = skipWs(pos)
    const c = text[p]
    if (p >= n || c === '\n' || (c === '\r' && text[p + 1] === '\n')) {
      pos = eol(p)
      stmts.push({ kind: 'blank', start: lineStart, end: pos })
      continue
    }
    if (c === '#') {
      pos = eol(p)
      stmts.push({ kind: 'comment', start: lineStart, end: pos })
      continue
    }
    if (c === '[') {
      const isArray = text[p + 1] === '['
      const k = parseKey(p + (isArray ? 2 : 1))
      let q = skipWs(k.end)
      if (text[q] !== ']' || (isArray && text[q + 1] !== ']')) throw new TomlScanError(`bad table header at offset ${lineStart}`)
      q += isArray ? 2 : 1
      pos = eol(q)
      stmts.push({ kind: isArray ? 'array' : 'table', start: lineStart, end: pos, key: k.segs, valueEnd: q })
      continue
    }
    const k = parseKey(p)
    const q = skipWs(k.end)
    if (text[q] !== '=') throw new TomlScanError(`expected = at offset ${q}`)
    const v = scanValue(skipWs(q + 1))
    pos = v.end
    stmts.push({ kind: 'kv', start: lineStart, end: pos, key: k.segs, indent: text.slice(lineStart, p), valueEnd: v.valueEnd })
  }
  return stmts
}

function samePath(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i])
}
function isPrefix(prefix: readonly string[], full: readonly string[]): boolean {
  return prefix.length <= full.length && prefix.every((x, i) => x === full[i])
}

export function tomlKey(seg: string): string {
  return /^[A-Za-z0-9_-]+$/.test(seg) ? seg : tomlString(seg)
}

function tomlString(s: string): string {
  let out = '"'
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\r') out += '\\r'
    else if (ch === '\b') out += '\\b'
    else if (ch === '\f') out += '\\f'
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).padStart(4, '0')}`
    else out += ch
  }
  return out + '"'
}

function isPlainObject(x: unknown): x is Record<string, unknown> {
  if (x === null || typeof x !== 'object' || Array.isArray(x) || x instanceof Date) return false
  const proto = Object.getPrototypeOf(x) as unknown
  return proto === Object.prototype || proto === null
}

export function tomlValue(v: unknown): string {
  if (typeof v === 'string') return tomlString(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return 'nan'
    if (v === Infinity) return 'inf'
    if (v === -Infinity) return '-inf'
    return String(v)
  }
  if (v instanceof Date) return v.toISOString()
  if (Array.isArray(v)) {
    return `[${v.map((x, i) => {
      if (x === null || x === undefined) throw new Error(`TOML arrays cannot hold null (index ${i})`)
      return tomlValue(x)
    }).join(', ')}]`
  }
  if (isPlainObject(v)) {
    const parts = Object.entries(v).filter(([, x]) => x !== undefined && x !== null).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`)
    return parts.length === 0 ? '{}' : `{ ${parts.join(', ')} }`
  }
  throw new Error(`cannot serialize ${v === null ? 'null' : typeof v} as TOML`)
}

export function tomlNormalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(tomlNormalize)
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) if (x !== undefined && x !== null) out[k] = tomlNormalize(x)
    return out
  }
  return v
}

function tableBody(values: Record<string, unknown>): string {
  let out = ''
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null) continue
    out += `${tomlKey(k)} = ${tomlValue(v)}\n`
  }
  return out
}

function headerText(path: readonly string[]): string {
  return path.map(tomlKey).join('.')
}

function validateToml(text: string, what: string): void {
  try {
    tomlParse(text)
  } catch (e) {
    throw new Error(`${what}: result is not valid TOML (${e instanceof Error ? e.message : String(e)})`)
  }
}

function scanOrThrow(text: string): Stmt[] {
  try {
    return scanToml(text)
  } catch (e) {
    throw new Error(`cannot scan TOML: ${e instanceof Error ? e.message : String(e)}`)
  }
}

interface Region { header: number; bodyStart: number; contentEnd: number; regionEnd: number }

function regionOf(stmts: Stmt[], h: number, textLen: number): Region {
  let next = stmts.length
  for (let i = h + 1; i < stmts.length; i++) {
    const k = (stmts[i] as Stmt).kind
    if (k === 'table' || k === 'array') { next = i; break }
  }
  const header = stmts[h] as Stmt
  let contentEnd = header.end
  for (let i = h + 1; i < next; i++) {
    const s = stmts[i] as Stmt
    if (s.kind === 'kv') contentEnd = s.end
  }
  const regionEnd = next < stmts.length ? (stmts[next] as Stmt).start : textLen
  return { header: h, bodyStart: header.end, contentEnd, regionEnd }
}

function ensureNl(s: string): string {
  return s === '' || s.endsWith('\n') ? s : s + '\n'
}

function tomlStmtValue(text: string, s: Stmt): unknown {
  try {
    const v = Bun.TOML.parse(`x = ${text.slice(text.indexOf('=', s.start) + 1, s.valueEnd ?? s.end).trim()}\n`) as Record<string, unknown>
    return v['x']
  } catch { return undefined }
}

function updateTableBody(text: string, stmts: Stmt[], r: Region, values: Record<string, unknown>, keep: readonly string[] = []): string | undefined {
  const want = new Map(Object.entries(values).filter(([, v]) => v !== undefined && v !== null))
  const body: Stmt[] = []
  for (let i = r.header + 1; i < stmts.length; i++) {
    const st = stmts[i] as Stmt
    if (st.start >= r.contentEnd) break
    body.push(st)
  }
  if (body.some(st => st.kind === 'kv' && (st.key?.length ?? 0) !== 1)) return undefined
  let out = ''
  const seen = new Set<string>()
  let lastKvEnd = -1
  for (const st of body) {
    const piece = text.slice(st.start, st.end)
    if (st.kind !== 'kv') { out += piece; continue }
    const key = (st.key as string[])[0] as string
    if (keep.includes(key) && !want.has(key)) { out += piece; continue }
    if (!want.has(key) || seen.has(key)) continue
    seen.add(key)
    const v = want.get(key)
    if (valueHash(tomlNormalize(tomlStmtValue(text, st))) === valueHash(tomlNormalize(v))) out += piece
    else {
      const rest = st.valueEnd !== undefined ? text.slice(st.valueEnd, st.end) : '\n'
      out += `${st.indent ?? ''}${tomlKey(key)} = ${tomlValue(v)}${rest}`
    }
    lastKvEnd = out.length
  }
  let added = ''
  for (const [k, v] of want) if (!seen.has(k)) added += `${tomlKey(k)} = ${tomlValue(v)}\n`
  if (added !== '') {
    if (lastKvEnd < 0) out = added + out
    else out = ensureNl(out.slice(0, lastKvEnd)) + added + out.slice(lastKvEnd)
  }
  const header = stmts[r.header] as Stmt
  const headerLine = ensureNl(text.slice(header.start, header.end))
  const bodyStart = body[0]?.start ?? header.end
  return text.slice(0, header.start) + headerLine + text.slice(header.end, bodyStart) + out + text.slice(r.contentEnd)
}

function replaceTable(text: string, path: string[], values: Record<string, unknown>, keep: readonly string[] = []): string {
  let stmts = scanOrThrow(text)
  if (stmts.some(s => s.kind === 'array' && s.key && samePath(s.key, path))) {
    throw new Error(`[${headerText(path)}] is an array of tables; refusing to patch`)
  }
  for (;;) {
    const idx = stmts.findIndex(s => (s.kind === 'table' || s.kind === 'array') && s.key !== undefined && s.key.length > path.length && isPrefix(path, s.key) && !keep.includes(s.key[path.length] as string))
    if (idx < 0) break
    const r = regionOf(stmts, idx, text.length)
    let start = (stmts[idx] as Stmt).start
    const prev = stmts[idx - 1]
    if (prev && prev.kind === 'blank') start = prev.start
    text = text.slice(0, start) + text.slice(r.contentEnd)
    stmts = scanOrThrow(text)
  }
  const headers = stmts.map((s, i) => (s.kind === 'table' && s.key && samePath(s.key, path) ? i : -1)).filter(i => i >= 0)
  if (headers.length > 1) throw new Error(`[${headerText(path)}] is defined more than once`)
  const body = tableBody(values)
  if (headers.length === 1) {
    const r = regionOf(stmts, headers[0] as number, text.length)
    const header = stmts[r.header] as Stmt
    const inPlace = updateTableBody(text, stmts, r, values, keep)
    if (inPlace !== undefined) return inPlace
    for (let i = r.header + 1; i < stmts.length; i++) {
      const st = stmts[i] as Stmt
      if (st.start >= r.contentEnd) break
      if (st.kind === 'kv' && keep.includes((st.key ?? [])[0] as string)) throw new Error(`[${headerText(path)}] holds ${(st.key ?? []).join('.')} in a form that cannot be kept while patching`)
    }
    const headerLine = ensureNl(text.slice(header.start, header.end))
    return text.slice(0, header.start) + headerLine + body + text.slice(r.contentEnd)
  }
  let base = ensureNl(text)
  if (base !== '' && !base.endsWith('\n\n')) base += '\n'
  return `${base}[${headerText(path)}]\n${body}`
}

function setKey(text: string, path: string[], value: unknown): string {
  const stmts = scanOrThrow(text)
  const headerIdx: number[] = []
  stmts.forEach((s, i) => { if (s.kind === 'table' || s.kind === 'array') headerIdx.push(i) })
  const firstHeader = headerIdx[0] ?? stmts.length
  const remove = value === undefined || value === null
  const tryRegion = (from: number, to: number, prefix: readonly string[]): Stmt | undefined => {
    for (let i = from; i < to; i++) {
      const s = stmts[i] as Stmt
      if (s.kind === 'kv' && s.key && samePath([...prefix, ...s.key], path)) return s
    }
    return undefined
  }
  let found = tryRegion(0, firstHeader, [])
  for (let hi = 0; !found && hi < headerIdx.length; hi++) {
    const h = headerIdx[hi] as number
    const hs = stmts[h] as Stmt
    if (hs.kind !== 'table' || !hs.key || !isPrefix(hs.key, path) || hs.key.length >= path.length) continue
    const to = headerIdx[hi + 1] ?? stmts.length
    found = tryRegion(h + 1, to, hs.key)
  }
  if (found) {
    if (remove) {
      const i = stmts.indexOf(found)
      const next = stmts[i + 1]
      const prev = stmts[i - 1]
      const end = next && next.kind === 'blank' && (i === 0 || (prev !== undefined && prev.kind === 'blank')) ? next.end : found.end
      return text.slice(0, found.start) + text.slice(end)
    }
    const keyText = (found.key as string[]).map(tomlKey).join('.')
    const rest = found.valueEnd !== undefined ? text.slice(found.valueEnd, found.end) : '\n'
    return text.slice(0, found.start) + `${found.indent ?? ''}${keyText} = ${tomlValue(value)}${rest}` + text.slice(found.end)
  }
  if (remove) return text
  let best = -1
  for (const h of headerIdx) {
    const hs = stmts[h] as Stmt
    if (hs.kind === 'table' && hs.key && hs.key.length < path.length && isPrefix(hs.key, path)) {
      if (best < 0 || (hs.key.length > ((stmts[best] as Stmt).key as string[]).length)) best = h
    }
  }
  if (best >= 0) {
    const r = regionOf(stmts, best, text.length)
    const rel = path.slice(((stmts[best] as Stmt).key as string[]).length)
    const line = `${rel.map(tomlKey).join('.')} = ${tomlValue(value)}\n`
    const before = ensureNl(text.slice(0, r.contentEnd))
    return before + line + text.slice(r.contentEnd)
  }
  const line = `${path.map(tomlKey).join('.')} = ${tomlValue(value)}\n`
  let lastRootKv = -1
  for (let i = 0; i < firstHeader; i++) if ((stmts[i] as Stmt).kind === 'kv') lastRootKv = i
  if (lastRootKv >= 0) {
    const at = (stmts[lastRootKv] as Stmt).end
    return ensureNl(text.slice(0, at)) + line + text.slice(at)
  }
  if (firstHeader >= stmts.length) {
    return ensureNl(text) + line
  }
  let insertAt = firstHeader
  while (insertAt > 0 && (stmts[insertAt - 1] as Stmt).kind === 'comment') insertAt--
  const at = insertAt < stmts.length ? (stmts[insertAt] as Stmt).start : text.length
  return text.slice(0, at) + line + '\n' + text.slice(at)
}

export function tomlPatchTables(text: string, tables: Record<string, Record<string, unknown>>, keys: Record<string, unknown> = {}, keep: Readonly<Record<string, readonly string[]>> = {}): string {
  validateToml(text, 'input')
  let out = text
  for (const [name, values] of Object.entries(tables)) {
    const path = parseKeyPath(name).map(String)
    if (!isPlainObject(values)) throw new Error(`table ${name}: expected a mapping of keys`)
    out = replaceTable(out, path, values, keep[name] ?? [])
  }
  for (const [name, value] of Object.entries(keys)) {
    out = setKey(out, parseKeyPath(name).map(String), value)
  }
  out = keepMissingFinalNewline(text, preserveEol(text, out))
  validateToml(out, 'tomlPatchTables')
  return out
}

function keepMissingFinalNewline(original: string, out: string): string {
  if (original === '' || original.endsWith('\n')) return out
  if (out.endsWith('\r\n')) return out.slice(0, -2)
  if (out.endsWith('\n')) return out.slice(0, -1)
  return out
}

export function tomlRemove(text: string, what: { tables?: string[], keys?: string[] }): string {
  validateToml(text, 'input')
  let out = text
  for (const name of what.tables ?? []) {
    const path = parseKeyPath(name).map(String)
    for (;;) {
      const stmts = scanOrThrow(out)
      const idx = stmts.findIndex(s => (s.kind === 'table' || s.kind === 'array') && s.key !== undefined && isPrefix(path, s.key))
      if (idx < 0) break
      const r = regionOf(stmts, idx, out.length)
      let start = (stmts[idx] as Stmt).start
      const prev = stmts[idx - 1]
      if (prev && prev.kind === 'blank') start = prev.start
      out = out.slice(0, start) + out.slice(r.contentEnd)
    }
  }
  for (const name of what.keys ?? []) out = setKey(out, parseKeyPath(name).map(String), undefined)
  out = keepMissingFinalNewline(text, preserveEol(text, out))
  validateToml(out, 'tomlRemove')
  return out
}

export function tomlRenameTable(text: string, from: readonly string[], to: readonly string[]): string {
  validateToml(text, 'input')
  if (from.length === 0 || to.length === 0) throw new Error('empty table path')
  const stmts = scanOrThrow(text)
  const headers = stmts.filter(s => s.kind === 'table' && s.key !== undefined && samePath(s.key, from))
  if (headers.length !== 1) throw new Error(`[${headerText(from)}] is not one table header (${headers.length === 0 ? 'it is defined some other way' : 'it is defined more than once'})`)
  if (stmts.some(s => (s.kind === 'table' || s.kind === 'array') && s.key !== undefined && s.key.length > from.length && isPrefix(from, s.key))) {
    throw new Error(`[${headerText(from)}] has sub-tables`)
  }
  if (getIn(tomlParse(text), [...to]).found) throw new Error(`${headerText(to)} is already defined`)
  const h = headers[0] as Stmt
  const open = text.indexOf('[', h.start)
  if (open < 0 || h.valueEnd === undefined) throw new Error(`cannot read the header of [${headerText(from)}]`)
  const out = text.slice(0, open) + `[${headerText(to)}]` + text.slice(h.valueEnd)
  validateToml(out, 'tomlRenameTable')
  return out
}

export function jsoncParse(text: string): { ok: true, value: unknown } | { ok: false, error: string } {
  if (text.trim() === '') return { ok: true, value: undefined }
  const errors: ParseError[] = []
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown
  if (errors.length > 0) {
    const e = errors[0] as ParseError
    return { ok: false, error: `${printParseErrorCode(e.error)} at offset ${e.offset}` }
  }
  return { ok: true, value }
}

function detectFormatting(text: string): { insertSpaces: boolean, tabSize: number, eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const m = /\n([ \t]+)\S/.exec(text)
  if (m && m[1] !== undefined) {
    if (m[1].startsWith('\t')) return { insertSpaces: false, tabSize: 1, eol }
    return { insertSpaces: true, tabSize: m[1].length >= 4 ? 4 : m[1].length, eol }
  }
  return { insertSpaces: true, tabSize: 2, eol }
}

function removeSoleMemberWithTrailingComma(text: string, path: JSONPath): string | undefined {
  const root = parseTree(text)
  if (!root) return undefined
  const prop = findNodeAtLocation(root, path)?.parent
  const obj = prop?.parent
  if (!prop || prop.type !== 'property' || !obj || obj.type !== 'object' || obj.children?.length !== 1) return undefined
  const end = prop.offset + prop.length
  let i = end
  for (;;) {
    while (i < text.length && /\s/.test(text[i] as string)) i++
    if (text.startsWith('//', i)) { const nl = text.indexOf('\n', i); i = nl < 0 ? text.length : nl + 1; continue }
    if (text.startsWith('/*', i)) { const close = text.indexOf('*/', i + 2); if (close < 0) return undefined; i = close + 2; continue }
    break
  }
  if (text[i] !== ',') return undefined
  return text.slice(0, prop.offset) + text.slice(end, i) + text.slice(i + 1)
}

function removeArrayElement(text: string, path: JSONPath): string | undefined {
  const index = path[path.length - 1]
  if (typeof index !== 'number') return undefined
  const root = parseTree(text)
  const arr = root ? findNodeAtLocation(root, path.slice(0, -1)) : undefined
  const kids = arr?.type === 'array' ? arr.children ?? [] : []
  const el = kids[index]
  if (!arr || !el) return undefined
  const close = arr.offset + arr.length - 1
  if (kids.length === 1) {
    const before = text.slice(arr.offset + 1, el.offset)
    const after = text.slice(el.offset + el.length, close)
    if (/^\s*$/.test(before) && /^\s*,?\s*$/.test(after)) return text.slice(0, arr.offset + 1) + text.slice(close)
    let end = el.offset + el.length
    const comma = /^\s*,/.exec(text.slice(end, close))
    if (comma) end += comma[0].length
    return text.slice(0, el.offset) + text.slice(end)
  }
  if (index < kids.length - 1) return text.slice(0, el.offset) + text.slice((kids[index + 1] as { offset: number }).offset)
  const prev = kids[index - 1] as { offset: number, length: number }
  return text.slice(0, prev.offset + prev.length) + text.slice(el.offset + el.length)
}

function lineIndentAt(text: string, offset: number): string | undefined {
  const start = text.lastIndexOf('\n', offset - 1) + 1
  const pre = text.slice(start, offset)
  return /^[ \t]*$/.test(pre) ? pre : undefined
}

function leadingWhitespace(text: string, offset: number): string {
  const start = text.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? ''
}

function hasComment(text: string, from: number, to: number): boolean {
  const seg = text.slice(from, to)
  return seg.includes('//') || seg.includes('/*')
}

function jsonText(value: unknown, compact: boolean, unit: string, indent: string, eol: string): string {
  if (compact) return JSON.stringify(value)
  return JSON.stringify(value, null, unit).split('\n').join(eol + indent)
}

function nestJson(keys: readonly string[], value: unknown): unknown {
  return keys.reduceRight<unknown>((acc, k) => ({ [k]: acc }), value)
}

function jsoncSurgical(text: string, path: JSONPath, value: unknown, fmt: { insertSpaces: boolean, tabSize: number, eol: string }): string | undefined {
  if (path.length === 0 || text.trim() === '') return undefined
  const root = parseTree(text, [], { allowTrailingComma: true, disallowComments: false })
  if (!root || root.type !== 'object') return undefined
  const unit = fmt.insertSpaces ? ' '.repeat(fmt.tabSize) : '\t'
  const eol = fmt.eol
  const singleLine = (n: JsonNode) => !text.slice(n.offset, n.offset + n.length).includes('\n')
  let depth = path.length - 1
  let parent: JsonNode | undefined
  for (; depth >= 0; depth--) {
    parent = depth === 0 ? root : findNodeAtLocation(root, path.slice(0, depth))
    if (parent !== undefined) break
  }
  if (parent === undefined) return undefined
  const seg = path[depth]
  if (depth < path.length - 1) {
    if (value === undefined || parent.type !== 'object' || typeof seg !== 'string' || path.slice(depth + 1).some(x => typeof x !== 'string')) return undefined
    if ((parent.children ?? []).some(p => p.children?.[0]?.value === seg)) return undefined
    return jsoncSurgical(text, path.slice(0, depth + 1), nestJson(path.slice(depth + 1) as string[], value), fmt)
  }
  const close = parent.offset + parent.length - 1
  if (parent.type === 'object' && typeof seg === 'string') {
    const props = parent.children ?? []
    const idx = props.findIndex(p => p.children?.[0]?.value === seg)
    if (value === undefined) {
      if (idx < 0) return text
      const p = props[idx] as JsonNode
      const pEnd = p.offset + p.length
      if (props.length === 1) {
        if (/^\s*$/.test(text.slice(parent.offset + 1, p.offset)) && /^\s*,?\s*$/.test(text.slice(pEnd, close))) return text.slice(0, parent.offset + 1) + text.slice(close)
        return undefined
      }
      if (idx === props.length - 1) {
        const prev = props[idx - 1] as JsonNode
        if (hasComment(text, prev.offset + prev.length, p.offset)) return undefined
        return text.slice(0, prev.offset + prev.length) + text.slice(pEnd)
      }
      const next = props[idx + 1] as JsonNode
      if (hasComment(text, pEnd, next.offset)) return undefined
      return text.slice(0, p.offset) + text.slice(next.offset)
    }
    if (idx >= 0) {
      const v = (props[idx] as JsonNode).children?.[1]
      if (v === undefined) return undefined
      const compact = singleLine(parent)
      const indent = compact ? '' : lineIndentAt(text, (props[idx] as JsonNode).offset)
      if (indent === undefined) return undefined
      return text.slice(0, v.offset) + jsonText(value, compact, unit, indent, eol) + text.slice(v.offset + v.length)
    }
    const key = JSON.stringify(seg)
    const oneLineDoc = singleLine(root) && (root.children ?? []).length > 0
    if (props.length === 0) {
      if (text.slice(parent.offset + 1, close).trim() !== '') return undefined
      if (oneLineDoc) return text.slice(0, parent.offset + 1) + `${key}: ${JSON.stringify(value)}` + text.slice(close)
      const base = leadingWhitespace(text, parent.offset)
      const childIndent = base + unit
      return text.slice(0, parent.offset + 1) + eol + childIndent + `${key}: ${jsonText(value, false, unit, childIndent, eol)}` + eol + base + text.slice(close)
    }
    const last = props[props.length - 1] as JsonNode
    const lastEnd = last.offset + last.length
    if (hasComment(text, lastEnd, close)) return undefined
    if (singleLine(parent)) {
      const first = props[0] as JsonNode
      const sep = props.length >= 2 ? text.slice(first.offset + first.length, (props[1] as JsonNode).offset) : ', '
      const k = first.children?.[0]
      const v = first.children?.[1]
      const colon = k !== undefined && v !== undefined ? text.slice(k.offset + k.length, v.offset) : ': '
      if (!/^\s*,\s*$/.test(sep) || !/^\s*:\s*$/.test(colon)) return undefined
      return text.slice(0, lastEnd) + sep + key + colon + JSON.stringify(value) + text.slice(lastEnd)
    }
    const indent = lineIndentAt(text, last.offset)
    if (indent === undefined) return undefined
    return text.slice(0, lastEnd) + ',' + eol + indent + `${key}: ${jsonText(value, false, unit, indent, eol)}` + text.slice(lastEnd)
  }
  if (parent.type === 'array' && typeof seg === 'number') {
    if (value === undefined) return undefined
    const els = parent.children ?? []
    if (seg >= 0 && seg < els.length) {
      const el = els[seg] as JsonNode
      const compact = singleLine(parent)
      const indent = compact ? '' : lineIndentAt(text, el.offset)
      if (indent === undefined) return undefined
      return text.slice(0, el.offset) + jsonText(value, compact, unit, indent, eol) + text.slice(el.offset + el.length)
    }
    if (seg !== -1 && seg !== els.length) return undefined
    if (els.length === 0) {
      if (text.slice(parent.offset + 1, close).trim() !== '') return undefined
      if (singleLine(root) && (root.children ?? []).length > 0) return text.slice(0, parent.offset + 1) + JSON.stringify(value) + text.slice(close)
      const base = leadingWhitespace(text, parent.offset)
      const childIndent = base + unit
      return text.slice(0, parent.offset + 1) + eol + childIndent + jsonText(value, false, unit, childIndent, eol) + eol + base + text.slice(close)
    }
    const last = els[els.length - 1] as JsonNode
    const lastEnd = last.offset + last.length
    if (hasComment(text, lastEnd, close)) return undefined
    if (singleLine(parent)) {
      const sep = els.length >= 2 ? text.slice((els[0] as JsonNode).offset + (els[0] as JsonNode).length, (els[1] as JsonNode).offset) : ', '
      if (!/^\s*,\s*$/.test(sep)) return undefined
      return text.slice(0, lastEnd) + sep + JSON.stringify(value) + text.slice(lastEnd)
    }
    const indent = lineIndentAt(text, last.offset)
    if (indent === undefined) return undefined
    return text.slice(0, lastEnd) + ',' + eol + indent + jsonText(value, false, unit, indent, eol) + text.slice(lastEnd)
  }
  return undefined
}

export function jsoncSet(text: string, dottedPath: string | readonly (string | number)[], value: unknown): string {
  const parsed = jsoncParse(text)
  if (!parsed.ok) throw new Error(`cannot edit unparsable JSON: ${parsed.error}`)
  const path = parseKeyPath(dottedPath) as JSONPath
  const fmt = detectFormatting(text)
  let out: string | undefined
  if (value === undefined && !getIn(parsed.value, path).found) return text
  if (value === undefined) out = removeArrayElement(text, path)
  if (out === undefined) {
    let surgical: string | undefined
    try { surgical = jsoncSurgical(text, path, value, fmt) } catch { surgical = undefined }
    if (surgical !== undefined) {
      const check = jsoncParse(surgical)
      const last = path[path.length - 1]
      const arr = getIn(parsed.value, path.slice(0, -1))
      const want = value === undefined ? withoutValueAt(parsed.value, path)
        : last === -1 && arr.found && Array.isArray(arr.value) ? withValueAt(parsed.value, path.slice(0, -1), [...arr.value, value])
        : withValueAt(parsed.value, path, value)
      if (check.ok && want !== undefined && stableStringify(check.value) === stableStringify(want)) out = surgical
    }
  }
  if (out === undefined && value === undefined) out = removeSoleMemberWithTrailingComma(text, path)
  if (out === undefined) out = applyEdits(text, modify(text, path, value, { formattingOptions: fmt }))
  if ((text === '' || text.endsWith('\n')) && !out.endsWith('\n')) out += fmt.eol
  const check = jsoncParse(out)
  if (!check.ok) throw new Error(`editing ${JSON.stringify(pointerText(path))} would produce invalid JSON (${check.error}); refusing`)
  return out
}

function pointerText(path: JSONPath): string {
  return path.map(String).join('.')
}

export function jsoncGet(text: string, dottedPath: string | readonly (string | number)[]): { found: boolean, value: unknown } {
  const parsed = jsoncParse(text)
  if (!parsed.ok) throw new Error(`cannot read unparsable JSON: ${parsed.error}`)
  return getIn(parsed.value, parseKeyPath(dottedPath))
}

type YamlDocument = ReturnType<typeof parseDocument>
type YamlRange = [number, number, number]

function yamlDoc(text: string): YamlDocument {
  const doc = parseDocument(text)
  if (doc.errors.length > 0) throw new Error(`cannot edit unparsable YAML: ${(doc.errors[0]?.message ?? 'error').split('\n')[0]}`)
  return doc
}

export function yamlParse(text: string): unknown {
  return yamlDoc(text).toJS() as unknown
}

export interface YamlLayout {
  indent: number
  indentSeq: boolean
  flowCollectionPadding: boolean
}

function rangeOf(node: unknown): YamlRange | undefined {
  const r = (node as { range?: unknown } | null | undefined)?.range
  return Array.isArray(r) && typeof r[0] === 'number' && typeof r[1] === 'number' ? r as YamlRange : undefined
}

function lineStartOf(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1
}

function columnOf(text: string, offset: number): number {
  return offset - lineStartOf(text, offset)
}

function endOfLine(text: string, pos: number): number {
  if (pos > 0 && text[pos - 1] === '\n') return pos
  const nl = text.indexOf('\n', pos)
  return nl < 0 ? text.length : nl + 1
}

export function yamlLayout(text: string, doc: YamlDocument = yamlDoc(text)): YamlLayout {
  let indent: number | undefined
  let indentSeq: boolean | undefined
  let padding: boolean | undefined
  const walk = (node: unknown, depth: number): void => {
    if (depth > 100 || !(isMap(node) || isSeq(node))) return
    const r = rangeOf(node)
    if (node.flow === true && padding === undefined && node.items.length > 0 && r) padding = text[r[0] + 1] === ' '
    if (isSeq(node)) { for (const item of node.items) walk(item, depth + 1); return }
    for (const item of node.items) {
      const v = item.value
      const keyRange = rangeOf(item.key)
      if (node.flow !== true && keyRange && (isMap(v) || isSeq(v)) && v.flow !== true && v.items.length > 0) {
        const first = isMap(v) ? rangeOf(v.items[0]?.key)?.[0] : rangeOf(v)?.[0]
        if (first !== undefined) {
          const delta = columnOf(text, first) - columnOf(text, keyRange[0])
          if (isMap(v) && indent === undefined && delta > 0) indent = delta
          if (isSeq(v) && indentSeq === undefined) indentSeq = delta > 0
        }
      }
      walk(v, depth + 1)
    }
  }
  walk(doc.contents, 0)
  return { indent: indent ?? 2, indentSeq: indentSeq ?? true, flowCollectionPadding: padding ?? true }
}

function renderYamlPair(key: string, value: unknown, layout: YamlLayout): string {
  const out = yamlStringify({ [key]: value }, { indent: layout.indent, indentSeq: layout.indentSeq, flowCollectionPadding: layout.flowCollectionPadding, lineWidth: 0 })
  return out.endsWith('\n') ? out : out + '\n'
}

function indentLines(text: string, column: number): string {
  if (column <= 0) return text
  const pad = ' '.repeat(column)
  return text.split('\n').map(l => (l === '' ? l : pad + l)).join('\n')
}

function nestValue(keys: readonly string[], value: unknown): unknown {
  return keys.reduceRight<unknown>((acc, k) => ({ [k]: acc }), value)
}

function renderYamlScalar(value: string | number | boolean | null, style: unknown): string {
  if (typeof value === 'string') {
    if (style === 'QUOTE_DOUBLE') return JSON.stringify(value)
    if (style === 'QUOTE_SINGLE') return `'${value.replace(/'/g, "''")}'`
  }
  return yamlStringify(value, { lineWidth: 0 }).replace(/\n$/, '')
}

function isYamlScalarValue(v: unknown): v is string | number | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

function pairRegion(text: string, pair: { key: unknown, value: unknown }): { start: number, end: number, column: number } | undefined {
  const kr = rangeOf(pair.key)
  if (!kr) return undefined
  const start = lineStartOf(text, kr[0])
  if (!/^[ \t]*$/.test(text.slice(start, kr[0]))) return undefined
  const vr = rangeOf(pair.value)
  return { start, end: endOfLine(text, vr ? Math.max(vr[1], kr[1]) : kr[1]), column: kr[0] - start }
}

type YamlMapNode = { items: Array<{ key: unknown, value: unknown }>, flow?: boolean, range?: unknown }

function findYamlPair(map: YamlMapNode, key: string): { key: unknown, value: unknown } | undefined {
  return map.items.find(p => isScalar(p.key) && String(p.key.value) === key)
}

function yamlSurgical(text: string, doc: YamlDocument, segs: readonly string[], value: unknown, layout: YamlLayout): string | undefined {
  if (segs.length === 0) return undefined
  let node: unknown = doc.contents
  let parentMap: YamlMapNode | undefined
  let pair: { key: unknown, value: unknown } | undefined
  let depth = 0
  while (depth < segs.length && node !== null && node !== undefined) {
    if (depth > 0 && isScalar(node) && node.value === null) break
    if (!isMap(node)) return undefined
    const p = findYamlPair(node as YamlMapNode, segs[depth] as string)
    if (!p) break
    parentMap = node as YamlMapNode
    pair = p
    node = p.value
    depth++
  }
  const replacePair = (p: { key: unknown, value: unknown }, key: string, v: unknown): string | undefined => {
    const region = pairRegion(text, p)
    if (!region) return undefined
    return text.slice(0, region.start) + indentLines(renderYamlPair(key, v, layout), region.column) + text.slice(region.end)
  }
  const insertInto = (map: YamlMapNode | null | undefined, keys: readonly string[], v: unknown): string | undefined => {
    let at: number
    let column: number
    if (map === null || map === undefined) {
      at = text.length
      column = 0
    } else {
      if (map.flow === true) return insertIntoFlow(text, map, keys, v, layout)
      const r = rangeOf(map)
      const firstKey = rangeOf(map.items[0]?.key)
      if (!r || !firstKey) return undefined
      at = endOfLine(text, r[1])
      column = columnOf(text, firstKey[0])
    }
    const before = text.slice(0, at)
    const sep = before !== '' && !before.endsWith('\n') ? '\n' : ''
    return before + sep + indentLines(renderYamlPair(keys[0] as string, nestValue(keys.slice(1), v), layout), column) + text.slice(at)
  }

  if (depth === segs.length && pair && parentMap) {
    const target = pair.value
    if (value !== undefined && isYamlScalarValue(value) && isScalar(target)) {
      const r = rangeOf(target)
      if (r && r[1] > r[0] && !String(target.type ?? '').startsWith('BLOCK_') && !text.slice(r[0], r[1]).includes('\n')) {
        const rendered = renderYamlScalar(value, target.type)
        if (!rendered.includes('\n')) return text.slice(0, r[0]) + rendered + text.slice(r[1])
      }
    }
    if (parentMap.flow === true) return editFlowPair(text, parentMap, pair, value, layout)
    if (value === undefined) {
      if (parentMap !== doc.contents && parentMap.items.length === 1) return undefined
      const region = pairRegion(text, pair)
      return region ? text.slice(0, region.start) + text.slice(region.end) : undefined
    }
    return replacePair(pair, segs[segs.length - 1] as string, value)
  }
  if (value === undefined) return undefined
  const rest = segs.slice(depth)
  if (depth === 0) {
    const root = doc.contents
    if (root !== null && root !== undefined && !isMap(root)) return undefined
    return insertInto(root as YamlMapNode | null, rest, value)
  }
  if (!pair || !parentMap || parentMap.flow === true) return undefined
  const holder = pair.value
  if (holder === null || holder === undefined || (isScalar(holder) && holder.value === null)) {
    return replacePair(pair, segs[depth - 1] as string, nestValue(rest, value))
  }
  if (!isMap(holder)) return undefined
  if ((holder as YamlMapNode).items.length === 0 && (holder as YamlMapNode).flow !== true) return undefined
  return insertInto(holder as YamlMapNode, rest, value)
}

function flowKey(key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) ? key : JSON.stringify(key)
}

function flowValueText(value: unknown, layout: YamlLayout): string | undefined {
  const out = isYamlScalarValue(value) ? renderYamlScalar(value, undefined) : yamlStringify(value, { collectionStyle: 'flow', flowCollectionPadding: layout.flowCollectionPadding, lineWidth: 0 }).replace(/\n$/, '')
  return out.includes('\n') ? undefined : out
}

function insertIntoFlow(text: string, map: YamlMapNode, keys: readonly string[], v: unknown, layout: YamlLayout): string | undefined {
  const r = rangeOf(map)
  if (!r) return undefined
  const open = r[0]
  const close = r[1] - 1
  if (text[open] !== '{' || text[close] !== '}' || text.slice(open, r[1]).includes('\n')) return undefined
  const value = flowValueText(nestValue(keys.slice(1), v), layout)
  if (value === undefined) return undefined
  const pair = `${flowKey(keys[0] as string)}: ${value}`
  if (map.items.length === 0) {
    if (text.slice(open + 1, close).trim() !== '') return undefined
    const pad = layout.flowCollectionPadding ? ' ' : ''
    return text.slice(0, open + 1) + pad + pair + pad + text.slice(close)
  }
  const last = map.items[map.items.length - 1] as { key: unknown, value: unknown }
  const lastEnd = rangeOf(last.value)?.[1] ?? rangeOf(last.key)?.[1]
  if (lastEnd === undefined) return undefined
  return text.slice(0, lastEnd) + ', ' + pair + text.slice(lastEnd)
}

function editFlowPair(text: string, map: YamlMapNode, pair: { key: unknown, value: unknown }, value: unknown, layout: YamlLayout): string | undefined {
  const r = rangeOf(map)
  const kr = rangeOf(pair.key)
  if (!r || !kr || text.slice(r[0], r[1]).includes('\n')) return undefined
  const vr = rangeOf(pair.value)
  const pairEnd = vr?.[1] ?? kr[1]
  if (value !== undefined) {
    if (!vr) return undefined
    const rendered = flowValueText(value, layout)
    return rendered === undefined ? undefined : text.slice(0, vr[0]) + rendered + text.slice(vr[1])
  }
  const items = map.items
  const i = items.indexOf(pair)
  if (i < 0) return undefined
  if (items.length === 1) return text.slice(0, r[0] + 1) + text.slice(r[1] - 1)
  if (i === items.length - 1) {
    const prev = items[i - 1] as { key: unknown, value: unknown }
    const prevEnd = rangeOf(prev.value)?.[1] ?? rangeOf(prev.key)?.[1]
    return prevEnd === undefined ? undefined : text.slice(0, prevEnd) + text.slice(pairEnd)
  }
  const next = rangeOf((items[i + 1] as { key: unknown }).key)
  return next === undefined ? undefined : text.slice(0, kr[0]) + text.slice(next[0])
}

function cloneJson(x: unknown): unknown {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x)) as unknown
}

export function withValueAt(root: unknown, path: readonly (string | number)[], value: unknown): unknown {
  const out = cloneJson(root ?? {}) as unknown
  let cur: unknown = out
  for (let i = 0; i < path.length; i++) {
    const seg = String(path[i])
    const last = i === path.length - 1
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return undefined
      const idx = Number(seg)
      if (last) { cur[idx] = cloneJson(value); return out }
      if (cur[idx] === undefined || cur[idx] === null) cur[idx] = {}
      cur = cur[idx]
    } else if (cur !== null && typeof cur === 'object') {
      const rec = cur as Record<string, unknown>
      if (last) { rec[seg] = cloneJson(value); return out }
      if (rec[seg] === undefined || rec[seg] === null) rec[seg] = {}
      cur = rec[seg]
    } else {
      return undefined
    }
  }
  return out
}

export function withoutValueAt(root: unknown, path: readonly (string | number)[]): unknown {
  const out = cloneJson(root ?? {}) as unknown
  let cur: unknown = out
  for (let i = 0; i < path.length - 1; i++) {
    if (cur === null || typeof cur !== 'object') return out
    cur = Array.isArray(cur) ? cur[Number(path[i])] : (cur as Record<string, unknown>)[String(path[i])]
  }
  const last = String(path[path.length - 1])
  if (Array.isArray(cur)) { if (/^\d+$/.test(last) && Number(last) < cur.length) cur.splice(Number(last), 1) }
  else if (cur !== null && typeof cur === 'object') delete (cur as Record<string, unknown>)[last]
  return out
}

function yamlRootValue(doc: YamlDocument): unknown {
  const v = doc.toJS() as unknown
  return v === null || v === undefined ? {} : v
}

export function yamlSet(text: string, dottedPath: string | readonly (string | number)[], value: unknown): string {
  const doc = yamlDoc(text)
  const path = parseKeyPath(dottedPath)
  const segs = path.map(String)
  if (doc.contents !== null && !isMap(doc.contents) && !isSeq(doc.contents)) throw new Error('cannot set a key: YAML root is a scalar')
  const before = yamlRootValue(doc)
  if (value === undefined && (doc.contents === null || !getIn(before, path).found)) return text
  const expected = value === undefined ? withoutValueAt(before, segs) : withValueAt(before, segs, value)
  const label = JSON.stringify(segs.join('.'))
  const readsBack = (out: string): boolean => {
    const d = parseDocument(out)
    return d.errors.length === 0 && (expected === undefined || stableStringify(yamlRootValue(d)) === stableStringify(expected))
  }
  const layout = yamlLayout(text, doc)
  let surgical: string | undefined
  try { surgical = yamlSurgical(text, doc, segs, value, layout) } catch { surgical = undefined }
  if (surgical !== undefined) {
    const out = keepMissingFinalNewline(text, preserveEol(text, surgical))
    if (readsBack(out)) return out
  }
  if (value === undefined) doc.deleteIn(path)
  else doc.setIn(path, value)
  const out = keepMissingFinalNewline(text, preserveEol(text, doc.toString({ lineWidth: 0, indent: layout.indent, indentSeq: layout.indentSeq, flowCollectionPadding: layout.flowCollectionPadding })))
  if (parseDocument(out).errors.length > 0) throw new Error(`editing ${label} would produce invalid YAML; refusing`)
  if (!readsBack(out)) throw new Error(`editing ${label} would change other values of the document; refusing`)
  return out
}

export function yamlGet(text: string, dottedPath: string | readonly (string | number)[]): { found: boolean, value: unknown } {
  return getIn(yamlParse(text), parseKeyPath(dottedPath))
}

export function yamlParseMerged(text: string): unknown {
  const doc = parseDocument(text, { merge: true })
  if (doc.errors.length > 0) throw new Error(`cannot read unparsable YAML: ${(doc.errors[0]?.message ?? 'error').split('\n')[0]}`)
  return doc.toJS() as unknown
}

export function yamlPathProblem(text: string, segs: readonly string[]): string | undefined {
  let doc: YamlDocument
  let merged: unknown
  try {
    doc = yamlDoc(text)
    merged = yamlParseMerged(text)
  } catch { return undefined }
  let node: unknown = doc.contents
  for (let k = 0; k < segs.length; k++) {
    const here = segs.slice(0, k)
    if (isAlias(node)) return `${here.join('.')} is a YAML alias (*${String(node.source)}): changing ${segs.join('.')} through it would also change the anchor and its other aliases`
    if (!isMap(node)) return undefined
    const map = node as YamlMapNode
    const pair = findYamlPair(map, segs[k] as string)
    if (pair === undefined) {
      const hasMerge = map.items.some(p => isScalar(p.key) && p.key.value === '<<')
      if (hasMerge && getIn(merged, segs.slice(0, k + 1)).found) return `${segs.slice(0, k + 1).join('.')} is inherited through a YAML merge key (<<: *anchor); Buracle does not override inherited values`
      return undefined
    }
    node = pair.value
  }
  return undefined
}

export function yamlAliasAt(text: string, segs: readonly string[]): string | undefined {
  let node: unknown
  try { node = yamlDoc(text).contents } catch { return undefined }
  for (const seg of segs) {
    if (!isMap(node)) return undefined
    const pair = findYamlPair(node as YamlMapNode, seg)
    if (pair === undefined) return undefined
    node = pair.value
  }
  return isAlias(node) ? String(node.source) : undefined
}

const BLOCK_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

export function mdBlockMarkers(id: string): { start: string, end: string } {
  if (!BLOCK_ID.test(id)) throw new Error(`invalid block id ${JSON.stringify(id)}`)
  return { start: `<!-- buracle:${id}:start -->`, end: `<!-- buracle:${id}:end -->` }
}

function allIndexes(text: string, needle: string): number[] {
  const out: number[] = []
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) out.push(i)
  return out
}

function locateBlock(text: string, id: string): { start: number, end: number, innerStart: number, innerEnd: number } | undefined {
  const m = mdBlockMarkers(id)
  const s = allIndexes(text, m.start)
  const e = allIndexes(text, m.end)
  if (s.length === 0 && e.length === 0) return undefined
  if (s.length !== 1 || e.length !== 1 || (e[0] as number) < (s[0] as number)) {
    throw new Error(`malformed buracle:${id} block markers (start ×${s.length}, end ×${e.length})`)
  }
  const start = s[0] as number
  const endMarker = e[0] as number
  return { start, end: endMarker + m.end.length, innerStart: start + m.start.length, innerEnd: endMarker }
}

export function mdBlockGet(text: string, id: string): string | undefined {
  const b = locateBlock(text, id)
  if (!b) return undefined
  let inner = text.slice(b.innerStart, b.innerEnd)
  if (inner.startsWith('\r\n')) inner = inner.slice(2)
  else if (inner.startsWith('\n')) inner = inner.slice(1)
  if (inner.endsWith('\r\n')) inner = inner.slice(0, -2)
  else if (inner.endsWith('\n')) inner = inner.slice(0, -1)
  return inner
}

function normalizeBlockContent(content: string): string {
  return content.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

export function mdBlockUpsert(text: string, id: string, content: string): string {
  const m = mdBlockMarkers(id)
  const body = normalizeBlockContent(content)
  if (body.includes(m.start) || body.includes(m.end)) throw new Error(`block ${id}: content contains its own markers`)
  const block = body === '' ? `${m.start}\n${m.end}` : `${m.start}\n${body}\n${m.end}`
  const b = locateBlock(text, id)
  if (b) return preserveEol(text, text.slice(0, b.start) + block + text.slice(b.end))
  if (text === '') return block + '\n'
  if (!text.endsWith('\n')) return preserveEol(text, `${text}\n\n${block}`)
  return preserveEol(text, `${text}\n${block}\n`)
}

export function mdBlockRemove(text: string, id: string): string {
  const b = locateBlock(text, id)
  if (!b) return text
  let before = text.slice(0, b.start)
  let after = text.slice(b.end)
  if (after === '') {
    if (before.endsWith('\r\n\r\n')) return before.slice(0, -4)
    if (before.endsWith('\n\n')) return before.slice(0, -2)
    return before
  }
  if (after.startsWith('\r\n')) after = after.slice(2)
  else if (after.startsWith('\n')) after = after.slice(1)
  if (before.endsWith('\r\n\r\n')) before = before.slice(0, -2)
  else if (before.endsWith('\n\n')) before = before.slice(0, -1)
  return before + after
}
