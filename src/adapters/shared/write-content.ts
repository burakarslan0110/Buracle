import { readFileSync, statSync } from 'node:fs'
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser'
import { resolvePath } from '../../core/events'
import type { ConfigParsers, WriteContent } from '../../core/policy/write-guard'
import { guardedFile } from '../../core/policy/write-guard'
import { parseYaml } from '../../engine/yaml'

export const WRITE_CONTENT_MAX_BYTES = 2_000_000

export const CONFIG_PARSERS: ConfigParsers = {
  jsonc: text => {
    const errors: ParseError[] = []
    const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false }) as unknown
    const first = errors[0]
    if (first !== undefined) throw new Error(`${printParseErrorCode(first.error)} at offset ${first.offset}`)
    return value
  },
  toml: text => {
    if (typeof Bun === 'undefined') throw new Error('no TOML parser in this runtime')
    return Bun.TOML.parse(text) as unknown
  },
  yaml: text => parseYaml(text) as unknown,
}

export function currentText(file: string): string | undefined {
  try {
    const st = statSync(file)
    if (!st.isFile() || st.size > WRITE_CONTENT_MAX_BYTES) return undefined
    return readFileSync(file, 'utf8')
  } catch (e) {
    return (e as { code?: unknown }).code === 'ENOENT' ? '' : undefined
  }
}

export interface FileChange { file: string; after: (read: (path: string) => string | undefined) => string | undefined }

export interface TextReplace { old: unknown; new: unknown; all?: unknown }

const REPLACEMENT_PATTERN = /\$[$&`'0-9<]/

export function replaceText(text: string, r: TextReplace): string | undefined {
  const oldText = r.old
  const newText = r.new
  if (typeof oldText !== 'string' || typeof newText !== 'string') return undefined
  if (REPLACEMENT_PATTERN.test(newText)) return undefined
  if (oldText === '') return text === '' ? newText : undefined
  const at = text.indexOf(oldText)
  if (at < 0) return undefined
  if (r.all === true) return text.split(oldText).join(newText)
  if (text.lastIndexOf(oldText) !== at) return undefined
  return text.slice(0, at) + newText + text.slice(at + oldText.length)
}

export function replaceAllText(text: string, edits: readonly TextReplace[]): string | undefined {
  let out: string | undefined = text
  for (const e of edits) {
    if (out === undefined) return undefined
    out = replaceText(out, e)
  }
  return out
}

function writeChanges(paths: readonly string[], content: unknown): FileChange[] {
  if (typeof content !== 'string') return []
  return paths.map(file => ({ file, after: () => content }))
}

function replaceChanges(paths: readonly string[], edits: readonly TextReplace[]): FileChange[] {
  if (edits.length === 0) return []
  return paths.map(file => ({
    file,
    after: read => {
      const before = read(file)
      return before === undefined ? undefined : replaceAllText(before, edits)
    },
  }))
}

function rec(x: unknown): Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}
}

function firstString(o: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string') return v
  }
  return undefined
}

export interface PatchChunk { context?: string; old: string[]; new: string[]; eof: boolean }

export interface PatchSection { kind: 'add' | 'update' | 'delete'; path: string; moveTo?: string; lines?: string[]; chunks?: PatchChunk[] }

const BEGIN = '*** Begin Patch'
const END = '*** End Patch'
const EOF_MARKER = '*** End of File'
const HEADER = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/
const MOVE = /^\*\*\* Move to:\s*(.+)$/

function updateChunks(body: readonly string[], start: number): { chunks: PatchChunk[], next: number } | undefined {
  const chunks: PatchChunk[] = []
  let i = start
  while (i < body.length) {
    const line = body[i] as string
    if (line.trim() === '') { i++; continue }
    if (line.startsWith('***')) break
    let chunk: PatchChunk
    if (line === '@@') { chunk = { old: [], new: [], eof: false }; i++ } else if (line.startsWith('@@ ')) { chunk = { context: line.slice(3), old: [], new: [], eof: false }; i++ } else if (chunks.length === 0) chunk = { old: [], new: [], eof: false }
    else return undefined
    let n = 0
    while (i < body.length) {
      const l = body[i] as string
      if (l === EOF_MARKER) {
        if (n === 0) return undefined
        chunk.eof = true
        i++
        break
      }
      const c = l.charAt(0)
      if (l === '') { chunk.old.push(''); chunk.new.push('') } else if (c === ' ') { chunk.old.push(l.slice(1)); chunk.new.push(l.slice(1)) } else if (c === '+') chunk.new.push(l.slice(1))
      else if (c === '-') chunk.old.push(l.slice(1))
      else if (n === 0) return undefined
      else break
      n++
      i++
    }
    if (n === 0) return undefined
    chunks.push(chunk)
  }
  return chunks.length > 0 ? { chunks, next: i } : undefined
}

export function parsePatchSections(text: string): PatchSection[] | undefined {
  if (typeof text !== 'string') return undefined
  const lines = text.trim().split(/\r?\n/)
  if (lines.length < 2 || lines[0]?.trim() !== BEGIN || lines[lines.length - 1]?.trim() !== END) return undefined
  const body = lines.slice(1, -1)
  const out: PatchSection[] = []
  let i = 0
  while (i < body.length) {
    const head = HEADER.exec((body[i] as string).trim())
    if (head === null) return undefined
    const path = head[2] as string
    i++
    if (head[1] === 'Delete') { out.push({ kind: 'delete', path }); continue }
    if (head[1] === 'Add') {
      const added: string[] = []
      while (i < body.length && (body[i] as string).startsWith('+')) { added.push((body[i] as string).slice(1)); i++ }
      out.push({ kind: 'add', path, lines: added })
      continue
    }
    const section: PatchSection = { kind: 'update', path }
    const move = i < body.length ? MOVE.exec(body[i] as string) : null
    if (move !== null) { section.moveTo = move[1] as string; i++ }
    const r = updateChunks(body, i)
    if (r === undefined) return undefined
    section.chunks = r.chunks
    i = r.next
    out.push(section)
  }
  return out
}

const WS = '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const TRIM_END = new RegExp(`${WS}+$`)
const TRIM_START = new RegExp(`^${WS}+`)
const trimEnd = (s: string): string => s.replace(TRIM_END, '')
const trimBoth = (s: string): string => trimEnd(s).replace(TRIM_START, '')
const SAME: ReadonlyArray<(a: string, b: string) => boolean> = [(a, b) => a === b, (a, b) => trimEnd(a) === trimEnd(b), (a, b) => trimBoth(a) === trimBoth(b)]

function seek(lines: readonly string[], pattern: readonly string[], start: number, eof: boolean): number | undefined {
  if (pattern.length === 0) return start
  if (pattern.length > lines.length) return undefined
  const from = eof ? lines.length - pattern.length : start
  const last = lines.length - pattern.length
  for (const eq of SAME) {
    for (let i = from; i <= last; i++) {
      let ok = true
      for (let k = 0; k < pattern.length; k++) {
        if (!eq(lines[i + k] as string, pattern[k] as string)) { ok = false; break }
      }
      if (ok) return i
    }
  }
  return undefined
}

export function applyPatchChunks(text: string, chunks: readonly PatchChunk[]): string | undefined {
  const lines = text.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const reps: Array<{ at: number, len: number, put: string[] }> = []
  let index = 0
  for (const chunk of chunks) {
    if (chunk.context !== undefined) {
      const at = seek(lines, [chunk.context], index, false)
      if (at === undefined) return undefined
      index = at + 1
    }
    if (chunk.old.length === 0) {
      const at = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
      reps.push({ at, len: 0, put: [...chunk.new] })
      continue
    }
    let pattern = chunk.old
    let put = chunk.new
    let found = seek(lines, pattern, index, chunk.eof)
    if (found === undefined && pattern[pattern.length - 1] === '') {
      pattern = pattern.slice(0, -1)
      if (put[put.length - 1] === '') put = put.slice(0, -1)
      found = seek(lines, pattern, index, chunk.eof)
    }
    if (found === undefined) return undefined
    reps.push({ at: found, len: pattern.length, put: [...put] })
    index = found + pattern.length
  }
  const out = [...lines]
  for (const r of [...reps].sort((a, b) => a.at - b.at).reverse()) out.splice(r.at, r.len, ...r.put)
  if (out.length === 0 || out[out.length - 1] !== '') out.push('')
  return out.join('\n')
}

function headerPath(raw: string, cwd: string, home: string | undefined): string | undefined {
  let t = raw.trim()
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) t = t.slice(1, -1)
  return resolvePath(cwd, t, home)
}

export function patchChanges(text: string, cwd: string, home?: string): FileChange[] {
  const sections = parsePatchSections(text)
  if (sections === undefined) return []
  const seen = new Map<string, number>()
  const count = (p: string | undefined): void => { if (p !== undefined) seen.set(p, (seen.get(p) ?? 0) + 1) }
  const resolved = sections.map(s => {
    const file = headerPath(s.path, cwd, home)
    const dest = s.moveTo !== undefined ? headerPath(s.moveTo, cwd, home) : undefined
    count(file)
    count(dest)
    return { s, file, dest }
  })
  const out: FileChange[] = []
  for (const { s, file, dest } of resolved) {
    if (file === undefined || (s.moveTo !== undefined && dest === undefined)) continue
    if (s.kind === 'add') {
      if (seen.get(file) !== 1) continue
      const content = (s.lines ?? []).map(l => `${l}\n`).join('')
      out.push({ file, after: () => content })
    } else if (s.kind === 'update') {
      const target = dest ?? file
      if (seen.get(file) !== 1 || seen.get(target) !== 1) continue
      const chunks = s.chunks ?? []
      out.push({
        file: target,
        after: read => {
          const before = read(file)
          return before === undefined ? undefined : applyPatchChunks(before, chunks)
        },
      })
    }
  }
  return out
}

export function patchTextOf(input: Record<string, unknown>): string | undefined {
  const cmd = input['command']
  const looks = (s: string): boolean => /\*\*\* (?:Begin Patch|Add File:|Update File:|Delete File:)/.test(s)
  if (typeof cmd === 'string' && looks(cmd)) return cmd
  if (Array.isArray(cmd)) for (const part of cmd) if (typeof part === 'string' && looks(part)) return part
  return firstString(input, ['patchText', 'patch', 'input', 'diff']) ?? (typeof cmd === 'string' ? cmd : undefined)
}

export function claudeChanges(tool: string, input: Record<string, unknown>, paths: readonly string[]): FileChange[] {
  if (tool === 'Write') return writeChanges(paths, input['content'])
  if (tool === 'Edit') return replaceChanges(paths, [{ old: input['old_string'], new: input['new_string'], all: input['replace_all'] }])
  if (tool === 'MultiEdit' && Array.isArray(input['edits'])) {
    return replaceChanges(paths, (input['edits'] as unknown[]).map(e => { const o = rec(e); return { old: o['old_string'], new: o['new_string'], all: o['replace_all'] } }))
  }
  return []
}

export function opencodeChanges(tool: string, input: Record<string, unknown>, paths: readonly string[], cwd: string, home: string | undefined): FileChange[] {
  if (tool === 'write') return writeChanges(paths, input['content'])
  if (tool === 'edit') return replaceChanges(paths, [{ old: input['oldString'], new: input['newString'], all: input['replaceAll'] }])
  if (tool === 'multiedit' && Array.isArray(input['edits'])) {
    return replaceChanges(paths, (input['edits'] as unknown[]).map(e => { const o = rec(e); return { old: o['oldString'], new: o['newString'], all: o['replaceAll'] } }))
  }
  if (tool === 'patch' || tool === 'apply_patch') {
    const text = patchTextOf(input)
    return text !== undefined ? patchChanges(text, cwd, home) : []
  }
  return []
}

const OMP_OLD = ['old_string', 'old_str', 'old_text', 'oldString', 'oldText'] as const
const OMP_NEW = ['new_string', 'new_str', 'new_text', 'newString', 'newText'] as const

export function ompChanges(tool: string, input: Record<string, unknown>, paths: readonly string[], cwd: string, home: string | undefined): FileChange[] {
  if (tool === 'write') return writeChanges(paths, input['content'])
  if (tool !== 'edit') return []
  const text = input['input']
  if (typeof text === 'string') return patchChanges(text, cwd, home)
  if (typeof input['_input'] === 'string' || Array.isArray(input['edits'])) return []
  const oldText = firstString(input, OMP_OLD)
  const newText = firstString(input, OMP_NEW)
  if (oldText === undefined || newText === undefined) return []
  return replaceChanges(paths, [{ old: oldText, new: newText, all: input['replace_all'] ?? input['replaceAll'] }])
}

export function codexPatchChanges(input: Record<string, unknown>, cwd: string): FileChange[] {
  const text = patchTextOf(input)
  return text !== undefined ? patchChanges(text, cwd) : []
}

export interface ContentsOptions {
  realpath?: (path: string) => string | undefined
  read?: (path: string) => string | undefined
}

export function guardedContents(changes: readonly FileChange[], paths: readonly string[], home: string, opts: ContentsOptions = {}): Record<string, WriteContent> {
  const out: Record<string, WriteContent> = {}
  if (changes.length === 0) return out
  const read = opts.read ?? currentText
  const real = (p: string): string | undefined => { try { return opts.realpath?.(p) } catch { return undefined } }
  for (const p of paths) {
    try {
      if (typeof p !== 'string') continue
      const r = real(p)
      if (guardedFile(p, home) === undefined && (r === undefined || guardedFile(r, home) === undefined)) continue
      const change = changes.find(c => c.file === p) ?? (r !== undefined ? changes.find(c => real(c.file) === r) : undefined)
      if (change === undefined) continue
      const before = read(p)
      if (before === undefined) continue
      const after = change.after(read)
      if (typeof after !== 'string') continue
      out[p] = before === '' ? { after } : { after, before }
    } catch {  }
  }
  return out
}
