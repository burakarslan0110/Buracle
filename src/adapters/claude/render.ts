import type { Harness } from '../../core/events'
import { isHarness } from '../../core/events'
import { PLUGIN_NAME } from './constants'

export class RenderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RenderError'
  }
}

const MARKER = /<!--[ \t]*(?:harness:([A-Za-z0-9_-]*)|(\/harness))[ \t]*-->/g

interface MarkerSpan { start: number; end: number; open: boolean; harness: string }

function markerSpans(text: string): MarkerSpan[] {
  const spans: MarkerSpan[] = []
  for (const m of text.matchAll(MARKER)) {
    const at = m.index ?? 0
    let start = at
    let end = at + m[0].length
    const lineStart = text.lastIndexOf('\n', at - 1) + 1
    const nl = text.indexOf('\n', end)
    const lineEnd = nl < 0 ? text.length : nl
    if (/^[ \t]*$/.test(text.slice(lineStart, at)) && /^[ \t]*\r?$/.test(text.slice(end, lineEnd))) {
      start = lineStart
      end = nl < 0 ? text.length : nl + 1
    }
    spans.push({ start, end, open: m[2] === undefined, harness: m[1] ?? '' })
  }
  return spans
}

export function applyHarnessBlocks(text: string, target: Harness, where = 'text'): string {
  const spans = markerSpans(text)
  if (spans.length === 0) return text
  let out = ''
  let pos = 0
  let open: MarkerSpan | undefined
  for (const s of spans) {
    if (s.open) {
      if (open) throw new RenderError(`${where}: harness:${s.harness} block opened inside the harness:${open.harness} block`)
      if (!isHarness(s.harness)) throw new RenderError(`${where}: unknown harness ${JSON.stringify(s.harness)} in a harness marker`)
      out += text.slice(pos, s.start)
      open = s
    } else {
      if (!open) throw new RenderError(`${where}: <!-- /harness --> without an opening harness marker`)
      if (open.harness === target) out += text.slice(open.end, s.start)
      open = undefined
    }
    pos = s.end
  }
  if (open) throw new RenderError(`${where}: the harness:${open.harness} block is never closed`)
  return out + text.slice(pos)
}

export type PlaceholderExpander = (name: string, arg: string | undefined, inCode: boolean) => string | undefined

const PLACEHOLDER = /(\\?)\{\{([a-z_]+)(?::([^{}\s]+))?\}\}/g
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const ID = /^[a-z0-9][a-z0-9._-]*$/

function codeSpans(line: string): Array<[number, number]> {
  const runs = [...line.matchAll(/`+/g)].map(m => ({ at: m.index ?? 0, n: m[0].length }))
  const out: Array<[number, number]> = []
  let k = 0
  while (k < runs.length) {
    const open = runs[k] as { at: number, n: number }
    let j = k + 1
    while (j < runs.length && (runs[j] as { n: number }).n !== open.n) j++
    const close = runs[j]
    if (close === undefined) { k++; continue }
    out.push([open.at, close.at + close.n])
    k = j + 1
  }
  return out
}

function expandLine(line: string, inFence: boolean, expand: PlaceholderExpander): string {
  if (!line.includes('{{')) return line
  const spans = inFence ? [] : codeSpans(line)
  return line.replace(PLACEHOLDER, (whole: string, esc: string, name: string, arg: string | undefined, offset: number) => {
    if (esc === '\\') return whole.slice(1)
    const inCode = inFence || spans.some(([a, b]) => offset >= a && offset < b)
    return expand(name, arg, inCode) ?? whole
  })
}

export function expandPlaceholders(text: string, expand: PlaceholderExpander): string {
  if (!text.includes('{{')) return text
  const lines = text.split('\n')
  let fence: { ch: string, n: number } | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string
    const m = FENCE_OPEN.exec(line)
    if (fence) {
      lines[i] = expandLine(line, true, expand)
      if (m && (m[1] as string)[0] === fence.ch && (m[1] as string).length >= fence.n && /^ {0,3}(`+|~+)[ \t]*\r?$/.test(line)) fence = undefined
      continue
    }
    if (m) {
      fence = { ch: (m[1] as string)[0] as string, n: (m[1] as string).length }
      lines[i] = expandLine(line, true, expand)
      continue
    }
    lines[i] = expandLine(line, false, expand)
  }
  return lines.join('\n')
}

export const CLAUDE_TODO = '`TodoWrite` (or `TaskCreate`/`TaskUpdate`, whichever this session has, if any)'

export function claudePlaceholderFor(protocols: readonly string[] = []): PlaceholderExpander {
  return (name, arg, inCode) => claudeLiteral(protocols, name, arg, inCode)
}

function claudeLiteral(protocols: readonly string[], name: string, arg: string | undefined, inCode: boolean): string | undefined {
  const code = (s: string) => (inCode ? s : `\`${s}\``)
  switch (name) {
    case 'ask_user':
      return arg === undefined ? code('AskUserQuestion') : undefined
    case 'todo':
      return arg === undefined ? (inCode ? 'TodoWrite' : CLAUDE_TODO) : undefined
    case 'spawn_agent':
      return arg === undefined ? (inCode ? 'Agent' : 'the `Agent` tool') : undefined
    case 'skill':
      return arg !== undefined && ID.test(arg) ? code(protocols.includes(arg) ? `/${PLUGIN_NAME}:${arg}` : `/${arg}`) : undefined
    case 'agent':
      return arg !== undefined && ID.test(arg) ? code(`${PLUGIN_NAME}:${arg}`) : undefined
    default:
      return undefined
  }
}

export const claudePlaceholder: PlaceholderExpander = claudePlaceholderFor()

export function renderClaudeMarkdown(text: string, where = 'text', protocols: readonly string[] = []): string {
  return expandPlaceholders(applyHarnessBlocks(text, 'claude', where), claudePlaceholderFor(protocols))
}

const PLAIN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/
const YAML_WORDS = /^(?:true|false|yes|no|on|off|null|y|n|~)$/i
const NUMERIC = /^[-+]?(?:\d[\d_]*\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/

export function yamlScalar(v: string | number | boolean): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : JSON.stringify(String(v))
  if (PLAIN.test(v) && !YAML_WORDS.test(v) && !NUMERIC.test(v)) return v
  return JSON.stringify(v)
}

export type FrontmatterValue = string | number | boolean | readonly string[]

export function withFrontmatter(entries: ReadonlyArray<readonly [string, FrontmatterValue | undefined]>, body: string): string {
  const lines: string[] = ['---']
  for (const [key, value] of entries) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) { lines.push(`${key}: []`); continue }
      lines.push(`${key}:`)
      for (const item of value as readonly string[]) lines.push(`  - ${JSON.stringify(item)}`)
      continue
    }
    lines.push(`${key}: ${yamlScalar(value as string | number | boolean)}`)
  }
  lines.push('---')
  const text = body.replace(/^\n+/, '')
  return `${lines.join('\n')}\n${text === '' ? '' : `\n${text}`}`
}
