import { isAbsolute, relative } from 'node:path'
import type { LspDiagnostic, LspRange } from './lsp-client'
import { uriPath } from './lsp-client'

export const SEVERITY_NAMES = ['', 'error', 'warning', 'info', 'hint'] as const

export const SYMBOL_KIND_NAMES = [
  '', 'file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum',
  'interface', 'function', 'variable', 'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null',
  'enum member', 'struct', 'event', 'operator', 'type parameter',
] as const

function isObj(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x)
}

export function splitLines(text: string): string[] {
  return text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l))
}

export function toCharacter(line: string, column: number): number {
  return Array.from(line).slice(0, Math.max(0, column - 1)).join('').length
}

export function toColumn(line: string | undefined, character: number): number {
  if (line === undefined) return character + 1
  return Array.from(line.slice(0, Math.max(0, character))).length + 1
}

export function symbolColumn(line: string, symbol: string): number | undefined {
  if (symbol === '') return undefined
  const esc = symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const word = /^[\p{L}\p{N}_$]+$/u.test(symbol) ? new RegExp(`(?<![\\p{L}\\p{N}_$])${esc}(?![\\p{L}\\p{N}_$])`, 'u').exec(line) : null
  const at = word !== null ? word.index : line.indexOf(symbol)
  return at < 0 ? undefined : Array.from(line.slice(0, at)).length + 1
}

export function displayPath(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}

export interface FoundLocation { path: string; range: LspRange }

function rangeOf(x: unknown): LspRange | undefined {
  if (!isObj(x) || !isObj(x['start']) || !isObj(x['end'])) return undefined
  const s = x['start']
  const e = x['end']
  if (typeof s['line'] !== 'number' || typeof s['character'] !== 'number' || typeof e['line'] !== 'number' || typeof e['character'] !== 'number') return undefined
  return { start: { line: s['line'], character: s['character'] }, end: { line: e['line'], character: e['character'] } }
}

export function locationsOf(result: unknown): FoundLocation[] {
  const list = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result]
  const out: FoundLocation[] = []
  for (const l of list) {
    if (!isObj(l)) continue
    const uri = typeof l['targetUri'] === 'string' ? l['targetUri'] : typeof l['uri'] === 'string' ? l['uri'] : undefined
    const range = rangeOf(l['targetSelectionRange']) ?? rangeOf(l['targetRange']) ?? rangeOf(l['range'])
    const path = uri !== undefined ? uriPath(uri) : undefined
    if (path === undefined || range === undefined) continue
    if (!out.some(o => o.path === path && o.range.start.line === range.start.line && o.range.start.character === range.start.character)) out.push({ path, range })
  }
  return out
}

export type LineReader = (path: string) => string[] | undefined

export function locationLine(loc: FoundLocation, cwd: string, lines: LineReader): string {
  const text = lines(loc.path)?.[loc.range.start.line]
  const col = toColumn(text, loc.range.start.character)
  const snippet = text !== undefined ? `  ${text.trim().slice(0, 160)}` : ''
  return `${displayPath(loc.path, cwd)}:${loc.range.start.line + 1}:${col}${snippet}`
}

function markup(x: unknown): string {
  if (typeof x === 'string') return x
  if (!isObj(x)) return ''
  const value = typeof x['value'] === 'string' ? x['value'] : ''
  if (typeof x['language'] === 'string' && value !== '') return `\`\`\`${x['language']}\n${value}\n\`\`\``
  return value
}

export function hoverText(result: unknown): string {
  if (!isObj(result)) return ''
  const c = result['contents']
  const parts = Array.isArray(c) ? c.map(markup) : [markup(c)]
  return parts.map(p => p.trim()).filter(p => p !== '').join('\n\n')
}

function codeText(code: LspDiagnostic['code']): string {
  if (typeof code === 'string' || typeof code === 'number') return String(code)
  if (isObj(code) && (typeof code['value'] === 'string' || typeof code['value'] === 'number')) return String(code['value'])
  return ''
}

export function diagnosticLines(items: readonly LspDiagnostic[], lines: string[] | undefined, max: number): string[] {
  const sorted = [...items].filter(d => rangeOf(d.range) !== undefined && typeof d.message === 'string').sort((a, b) =>
    (a.severity ?? 1) - (b.severity ?? 1) || a.range.start.line - b.range.start.line || a.range.start.character - b.range.start.character)
  const out = sorted.slice(0, max).map(d => {
    const col = toColumn(lines?.[d.range.start.line], d.range.start.character)
    const sev = SEVERITY_NAMES[d.severity ?? 1] ?? 'error'
    const code = codeText(d.code)
    const source = typeof d.source === 'string' && d.source !== '' ? ` [${d.source}]` : ''
    const msg = d.message.trim().split('\n').map((l, i) => (i === 0 ? l : `      ${l.trim()}`)).join('\n')
    return `  ${d.range.start.line + 1}:${col}  ${sev}${code !== '' ? ` ${code}` : ''}  ${msg}${source}`
  })
  if (sorted.length > max) out.push(`  ... ${sorted.length - max} more`)
  return out
}

export function countLabel(items: readonly LspDiagnostic[]): string {
  if (items.length === 0) return 'no problems'
  const n = (s: number) => items.filter(d => (d.severity ?? 1) === s).length
  const parts = [[n(1), 'error'], [n(2), 'warning'], [n(3), 'info'], [n(4), 'hint']] as const
  return parts.filter(([c]) => c > 0).map(([c, w]) => `${c} ${w}${c === 1 || w === 'info' ? '' : 's'}`).join(', ')
}

interface OutlineRow { depth: number; kind: string; name: string; detail: string; line: number; endLine: number }

function outlineRows(list: unknown[], depth: number, out: OutlineRow[]): void {
  for (const s of list) {
    if (!isObj(s) || typeof s['name'] !== 'string') continue
    const range = rangeOf(s['range']) ?? (isObj(s['location']) ? rangeOf(s['location']['range']) : undefined)
    if (range === undefined) continue
    const kind = SYMBOL_KIND_NAMES[typeof s['kind'] === 'number' ? s['kind'] : 0] ?? ''
    out.push({ depth, kind, name: s['name'], detail: typeof s['detail'] === 'string' ? s['detail'] : '', line: range.start.line + 1, endLine: range.end.line + 1 })
    if (Array.isArray(s['children'])) outlineRows(s['children'], depth + 1, out)
  }
}

export function outlineLines(result: unknown, max: number): { lines: string[], total: number } {
  const rows: OutlineRow[] = []
  outlineRows(Array.isArray(result) ? result : [], 0, rows)
  const lines = rows.slice(0, max).map(r => {
    const span = r.endLine > r.line ? `${r.line}-${r.endLine}` : `${r.line}`
    const detail = r.detail !== '' ? `  ${r.detail.split('\n')[0]?.slice(0, 100) ?? ''}` : ''
    return `${'  '.repeat(r.depth)}${r.kind !== '' ? `${r.kind} ` : ''}${r.name}  ${span}${detail}`
  })
  if (rows.length > max) lines.push(`... ${rows.length - max} more`)
  return { lines, total: rows.length }
}

export function workspaceSymbolLines(result: unknown, cwd: string, max: number): { lines: string[], total: number } {
  const list = Array.isArray(result) ? result.filter(isObj) : []
  const rows: string[] = []
  for (const s of list) {
    if (typeof s['name'] !== 'string' || !isObj(s['location'])) continue
    const uri = s['location']['uri']
    const path = typeof uri === 'string' ? uriPath(uri) : undefined
    if (path === undefined) continue
    const range = rangeOf(s['location']['range'])
    const kind = SYMBOL_KIND_NAMES[typeof s['kind'] === 'number' ? s['kind'] : 0] ?? ''
    const container = typeof s['containerName'] === 'string' && s['containerName'] !== '' ? `  (in ${s['containerName']})` : ''
    rows.push(`${kind !== '' ? `${kind} ` : ''}${s['name']}  ${displayPath(path, cwd)}${range !== undefined ? `:${range.start.line + 1}` : ''}${container}`)
  }
  const lines = rows.slice(0, max)
  if (rows.length > max) lines.push(`... ${rows.length - max} more`)
  return { lines, total: rows.length }
}
