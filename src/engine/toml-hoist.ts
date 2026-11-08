// A TOML file cannot define one table twice: `features.memories = false` at the root defines [features], so a later
// `[features]` header is a "duplicate key" and Codex refuses to start. That is what happened when Buracle wrote the
// dotted key and herdr's Codex integration then appended a [features] table (it adds one when the file has none).
// This module moves such dotted root keys into a [table] of their own, where every tool expects to find them.
import { ensureNl, keepMissingFinalNewline, preserveEol, regionOf, scanOrThrow, tomlKey, validateToml, type Stmt } from './merge'

interface Moved { stmt: Stmt, rel: string, line: string }
interface Edit { at: number, cut: number, insert: string }

/** The first parts of the dotted keys at the root of `text` (`features` for `features.memories = false`), once each, in order. */
export function rootDottedHeads(text: string): string[] {
  const stmts = scanOrThrow(text)
  const firstHeader = stmts.findIndex(s => s.kind === 'table' || s.kind === 'array')
  const heads: string[] = []
  for (const s of stmts.slice(0, firstHeader < 0 ? stmts.length : firstHeader)) {
    if (s.kind === 'kv' && s.key !== undefined && s.key.length >= 2 && !heads.includes(s.key[0] as string)) heads.push(s.key[0] as string)
  }
  return heads
}

/** The dotted root keys that collide with a `[table]` header of the same name: the reason a file does not parse. */
export function collidingHeads(text: string): string[] {
  const stmts = scanOrThrow(text)
  const headers = new Set(stmts.filter(s => s.kind === 'table' && s.key?.length === 1).map(s => (s.key as string[])[0] as string))
  return rootDottedHeads(text).filter(h => headers.has(h))
}

/**
 * Moves the dotted keys at the root of `text` whose first part is one of `tables` (`features.memories = false`) into
 * the `[table]` of that name: into its header when the file has one, else into a new table at the end. A trailing
 * comment goes with its key; nothing else changes. Returns `text` itself when there is nothing to move. Throws when the
 * table already holds the same key, or is defined in a form that cannot take new keys (an array of tables, twice).
 * The input need not be valid TOML (the collision above is the reason to call it); the result is.
 */
export function tomlHoistDotted(text: string, tables: readonly string[]): string {
  if (tables.length === 0) return text
  const stmts = scanOrThrow(text)
  const firstHeader = stmts.findIndex(s => s.kind === 'table' || s.kind === 'array')
  const rootEnd = firstHeader < 0 ? stmts.length : firstHeader
  const byTable = new Map<string, Moved[]>()
  for (let i = 0; i < rootEnd; i++) {
    const s = stmts[i] as Stmt
    if (s.kind !== 'kv' || s.key === undefined || s.key.length < 2 || s.valueStart === undefined) continue
    const head = s.key[0] as string
    if (!tables.includes(head)) continue
    const rel = s.key.slice(1).map(tomlKey).join('.')
    const list = byTable.get(head) ?? []
    list.push({ stmt: s, rel, line: `${rel} = ${ensureNl(text.slice(s.valueStart, s.end))}` })
    byTable.set(head, list)
  }
  if (byTable.size === 0) return text

  const edits: Edit[] = []
  const created: Array<[string, Moved[]]> = []
  for (const [table, list] of byTable) {
    for (const m of list) edits.push({ at: m.stmt.start, cut: m.stmt.end, insert: '' })
    if (stmts.some(s => s.kind === 'array' && s.key?.length === 1 && s.key[0] === table)) throw new Error(`[[${table}]] is an array of tables; refusing to move keys into it`)
    const headers = stmts.flatMap((s, i) => (s.kind === 'table' && s.key?.length === 1 && s.key[0] === table ? [i] : []))
    if (headers.length > 1) throw new Error(`[${table}] is defined more than once`)
    const h = headers[0]
    if (h === undefined) { created.push([table, list]); continue }
    const r = regionOf(stmts, h, text.length)
    const have = new Set(stmts.slice(h + 1).filter(s => s.kind === 'kv' && s.start < r.contentEnd).map(s => (s.key ?? []).map(tomlKey).join('.')))
    const clash = list.find(m => have.has(m.rel))
    if (clash !== undefined) throw new Error(`[${table}] already holds ${clash.rel}; cannot move ${table}.${clash.rel} into it`)
    const lead = r.contentEnd > 0 && text[r.contentEnd - 1] !== '\n' ? '\n' : ''
    edits.push({ at: r.contentEnd, cut: r.contentEnd, insert: lead + list.map(m => m.line).join('') })
  }

  let out = ''
  let pos = 0
  for (const e of edits.sort((a, b) => a.at - b.at)) {
    out += text.slice(pos, e.at) + e.insert
    pos = Math.max(pos, e.cut)
  }
  out += text.slice(pos)
  for (const [table, list] of created) {
    let base = ensureNl(out)
    if (base !== '' && !base.endsWith('\n\n')) base += '\n'
    out = `${base}[${tomlKey(table)}]\n${list.map(m => m.line).join('')}`
  }
  out = keepMissingFinalNewline(text, preserveEol(text, out))
  validateToml(out, 'tomlHoistDotted')
  return out
}
