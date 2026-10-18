import type { Finding, PlanTask } from './format'
import { vaguePhrase } from './vague'

export interface OutlineCard { n: number, head: number, end: number, done: boolean, files: PlanTask['files'], prose: readonly number[] }
export interface OutlineSection { text: string, line: number, end: number }
export interface PlanOutline { lines: readonly string[], code: readonly boolean[], body: number, sections: readonly OutlineSection[], cards: readonly OutlineCard[] }
export interface InventoryRow { line: number, item: string, tasks: number[], reason?: string }

const EXTENSIONS = new Set([
  'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc', 'json5', 'md', 'mdx', 'rst', 'adoc', 'txt',
  'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'xml', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'svg',
  'vue', 'svelte', 'astro', 'py', 'pyi', 'ipynb', 'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle',
  'swift', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs', 'fs', 'php', 'pl', 'pm', 'lua', 'jl', 'dart', 'ex', 'exs', 'erl',
  'clj', 'elm', 'hs', 'ml', 'nim', 'zig', 'sql', 'graphql', 'gql', 'proto', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat',
  'lock', 'tf', 'tfvars', 'hcl', 'nix', 'csv', 'tsv', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'pdf', 'wasm',
])
const FILE_NAMES = new Set(['Makefile', 'Dockerfile', 'Containerfile', 'Justfile', 'Procfile', 'Gemfile', 'Rakefile'])
const AFTER_RUN = new Set(['deviations', 'follow-ups', 'followups', 'review notes', 'gaps', 'evidence', 'e2e results', 'dod audit', 'unverified', 'red evidence'])
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const MAX_DRIFT = 5
const MAX_IDS = 400
const VERIFY_LINE = /^\s*(?:[-*+]\s+)?\**verify\**\s*:/i
const RUNNERS = new Set(['bun', 'node', 'deno', 'tsx', 'ts-node', 'python', 'python3', 'ruby', 'perl', 'php', 'sh', 'bash', 'zsh', 'fish', 'pwsh', 'powershell', 'source', '.'])

export function looksLikePath(raw: string): string | undefined {
  const t = raw.trim().replace(/^["'([]+/, '').replace(/["',;)\]]+$/, '').replace(/^\.\//, '')
  if (t === '' || t.length > 200 || /^(?:\/|~|-|\.\.)/.test(t) || t.includes('//')) return undefined
  const segs = t.replace(/\/$/, '').split('/')
  if (segs.some(s => !/^[A-Za-z0-9_.+-]+$/.test(s) || s === '.' || s === '..')) return undefined
  if (t.endsWith('/')) return t
  const last = segs[segs.length - 1] as string
  if (FILE_NAMES.has(last)) return t
  const ext = /[^.]\.([A-Za-z0-9]+)$/.exec(last)?.[1]?.toLowerCase()
  if (ext === undefined || !EXTENSIONS.has(ext)) return undefined
  if (segs.length === 1 && ext === 'js' && /^[A-Z][A-Za-z0-9]*\.js$/.test(last)) return undefined
  return t
}

export function pathsIn(text: string, whole = false): string[] {
  const spans = whole ? [text] : [...text.matchAll(/`([^`]+)`/g)].map(m => m[1] as string)
  const out: string[] = []
  for (const span of spans) {
    for (const tok of span.split(/\s+/)) {
      const p = looksLikePath(tok)
      if (p !== undefined) out.push(p)
    }
  }
  return out
}

export function filePaths(raw: string): string[] {
  return raw.split(/\s*(?:->|\u2192|=>)\s*/)
    .map(part => (part.trim().split(/\s+/)[0] ?? '').replace(/`/g, '').replace(/^["']+|["',;]+$/g, '').replace(/^\.\//, ''))
    .filter(p => p !== '')
    .slice(0, 2)
}

export function pathCovered(path: string, listed: readonly string[]): boolean {
  const q = path.replace(/\/+$/, '')
  for (const raw of listed) {
    const l = raw.replace(/\/+$/, '')
    if (l === '') continue
    if (l === q || q.startsWith(`${l}/`)) return true
    if (path.endsWith('/') && l.startsWith(`${q}/`)) return true
    if (!q.includes('/') && l.endsWith(`/${q}`)) return true
  }
  return false
}

export function listedPaths(o: PlanOutline): string[] {
  return o.cards.flatMap(c => c.files.flatMap(f => filePaths(f.path)))
}

function sectionOf(o: PlanOutline, name: string): OutlineSection | undefined {
  return o.sections.find(s => s.text.trim().toLowerCase() === name)
}

function at(line: number, level: Finding['level'], code: string, message: string): Finding {
  return { level, code, message, line: line + 1 }
}

function scriptsRun(command: string): Set<string> {
  const out = new Set<string>()
  for (const seg of command.split(/&&|\|\||[;|]/)) {
    const toks = seg.trim().split(/\s+/).filter(t => t !== '')
    let k = 0
    while (k < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[k] as string)) k++
    const head = toks[k]
    if (head === undefined) continue
    const self = head.startsWith('./') ? looksLikePath(head) : undefined
    if (self !== undefined) { out.add(self); continue }
    if (!RUNNERS.has(head)) continue
    k++
    while (k < toks.length && ((toks[k] as string).startsWith('-') || (toks[k] === 'run' && (head === 'bun' || head === 'deno')))) k++
    const script = toks[k] !== undefined ? looksLikePath(toks[k] as string) : undefined
    if (script !== undefined) out.add(script)
  }
  return out
}

function filesIncomplete(o: PlanOutline): Finding[] {
  const listed = listedPaths(o)
  const seen = new Set<string>()
  const out: Finding[] = []
  for (const card of o.cards) {
    for (const i of card.prose) {
      const line = o.lines[i] ?? ''
      const code = o.code[i] === true
      const ran = code ? scriptsRun(line) : VERIFY_LINE.test(line) ? new Set([...line.matchAll(/`([^`]+)`/g)].flatMap(m => [...scriptsRun(m[1] as string)])) : undefined
      for (const p of pathsIn(line, code)) {
        if (seen.has(p) || pathCovered(p, listed) || ran?.has(p) === true) continue
        seen.add(p)
        out.push(at(i, 'warning', 'files-incomplete', `Task ${card.n} names \`${p}\`, but no task's \`**Files:**\` list has it; add it under the verb that fits (\`Test:\` for a test the task runs but does not change), or write it as a \`path:line\` reference if the task only points at it`))
      }
    }
  }
  return out
}

function vagueFindings(o: PlanOutline): Finding[] {
  const out: Finding[] = []
  const owner = new Map<number, number>()
  for (const card of o.cards) for (let i = card.head; i < card.end; i++) owner.set(i, card.n)
  const skip = new Set<number>()
  for (const s of o.sections) if (AFTER_RUN.has(s.text.trim().toLowerCase())) for (let i = s.line; i < s.end; i++) skip.add(i)
  for (const card of o.cards) {
    for (const i of card.prose) {
      if (o.code[i] === true) continue
      const phrase = vaguePhrase((o.lines[i] ?? '').replace(/`[^`]*`/g, '``'))
      if (phrase !== undefined) out.push(at(i, 'warning', 'vague-placeholder', `Task ${card.n}: "${phrase}" leaves the work undefined; name the exact cases, values, files or steps`))
    }
  }
  for (let i = o.body; i < o.lines.length; i++) {
    if (o.code[i] === true || owner.has(i) || skip.has(i)) continue
    const phrase = vaguePhrase((o.lines[i] ?? '').replace(/`[^`]*`/g, '``'))
    if (phrase !== undefined) out.push(at(i, 'info', 'vague-placeholder', `"${phrase}" leaves something undefined; say exactly what is meant`))
  }
  return out
}

function tableCells(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
}

export function inventoryRows(o: PlanOutline): InventoryRow[] {
  const sec = sectionOf(o, 'inventory')
  if (sec === undefined) return []
  const rows: InventoryRow[] = []
  let header = true
  for (let i = sec.line + 1; i < sec.end; i++) {
    const line = (o.lines[i] ?? '').trim()
    if (o.code[i] === true || !line.startsWith('|')) continue
    const cells = tableCells(line)
    if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue
    if (header) { header = false; continue }
    const tasks: number[] = []
    for (const c of cells.slice(1)) {
      for (const m of c.matchAll(/\btask\s*#?(\d+)\b/gi)) tasks.push(Number(m[1]))
      const bare = /^#?(\d+)$/.exec(c)
      if (bare) tasks.push(Number(bare[1]))
    }
    const last = cells.length >= 3 ? (cells[cells.length - 1] as string) : ''
    const row: InventoryRow = { line: i, item: (cells[0] ?? '').replace(/`/g, ''), tasks: [...new Set(tasks)] }
    if (!/^[-\u2013\u2014]*$/.test(last)) row.reason = last
    rows.push(row)
  }
  return rows
}

function inventoryFindings(o: PlanOutline): Finding[] {
  const known = new Set(o.cards.map(c => c.n))
  const out: Finding[] = []
  for (const r of inventoryRows(o)) {
    const missing = r.tasks.filter(n => !known.has(n))
    if (missing.length > 0) out.push(at(r.line, 'warning', 'inventory-unmapped', `Inventory row "${r.item}" names Task ${missing.join(', Task ')}, which the plan does not have`))
    else if (r.tasks.length === 0 && r.reason === undefined) out.push(at(r.line, 'warning', 'inventory-unmapped', `Inventory row "${r.item}" names no task that keeps it and no reason for dropping it`))
  }
  return out
}

export function deviationPaths(o: PlanOutline): string[] {
  const sec = sectionOf(o, 'deviations')
  if (sec === undefined) return []
  const out: string[] = []
  for (let i = sec.line + 1; i < sec.end; i++) {
    if (o.code[i] === true) continue
    out.push(...pathsIn((o.lines[i] ?? '').replace(/`/g, ' '), true))
  }
  return [...new Set(out)]
}

function charBag(s: string): Int16Array {
  const bag = new Int16Array(128)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 128) bag[c] = (bag[c] as number) + 1
  }
  return bag
}

function bagDistance(a: Int16Array, b: Int16Array): number {
  let plus = 0
  let minus = 0
  for (let c = 0; c < 128; c++) {
    const d = (a[c] as number) - (b[c] as number)
    if (d > 0) plus += d
    else minus -= d
  }
  return Math.max(plus, minus)
}

function withinTwoEdits(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 2) return false
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min((prev[j] as number) + 1, (cur[j - 1] as number) + 1, (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1))
      cur.push(v)
      if (v < best) best = v
    }
    if (best > 2) return false
    prev = cur
  }
  return (prev[b.length] as number) <= 2
}

function identifierDrift(o: PlanOutline): Finding[] {
  const first = new Map<string, number>()
  for (let i = o.body; i < o.lines.length; i++) {
    if (o.code[i] === true) continue
    for (const m of (o.lines[i] ?? '').matchAll(/`([^`\s]+)`/g)) {
      const id = (m[1] as string).replace(/\(\)$/, '')
      if (id.length >= 4 && IDENT.test(id) && !first.has(id)) first.set(id, i)
    }
  }
  const ids = [...first.keys()].slice(0, MAX_IDS)
  const keys = ids.map(s => s.toLowerCase().replace(/_/g, ''))
  const bags = ids.map(charBag)
  const out: Finding[] = []
  const pairs: Array<[string, string]> = []
  for (let x = 0; x < ids.length && pairs.length < MAX_DRIFT; x++) {
    for (let y = x + 1; y < ids.length && pairs.length < MAX_DRIFT; y++) {
      const a = ids[x] as string
      const b = ids[y] as string
      if (keys[x] === keys[y]) { pairs.push([a, b]); continue }
      if (a.length < 8 || b.length < 8 || Math.abs(a.length - b.length) > 2 || a === `${b}s` || b === `${a}s`) continue
      if (bagDistance(bags[x] as Int16Array, bags[y] as Int16Array) > 2) continue
      if (withinTwoEdits(a, b)) pairs.push([a, b])
    }
  }
  for (const [a, b] of pairs) {
    out.push(at(first.get(b) as number, 'info', 'identifier-drift', `\`${a}\` and \`${b}\` look like one name spelled two ways; use one spelling everywhere, or ignore this if both exist`))
  }
  return out
}

export function authoringFindings(o: PlanOutline): Finding[] {
  return [...filesIncomplete(o), ...vagueFindings(o), ...inventoryFindings(o), ...identifierDrift(o)]
}
