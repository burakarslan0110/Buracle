import { existsSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { checkMention, findMentions } from './cli-contract'
import { fenceMask } from './plan-file'

export type LintLevel = 'error' | 'warning'

export interface LintFinding {
  level: LintLevel
  code: string
  file: string
  line?: number
  message: string
}

export interface LintReport {
  findings: LintFinding[]
  errors: number
  warnings: number
}

export function summarize(findings: LintFinding[]): LintReport {
  const sorted = [...findings].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : (a.line ?? 0) - (b.line ?? 0)))
  return { findings: sorted, errors: sorted.filter(f => f.level === 'error').length, warnings: sorted.filter(f => f.level === 'warning').length }
}

export function formatFinding(f: LintFinding): string {
  return `${f.file}${f.line !== undefined ? `:${f.line}` : ''}: ${f.level} ${f.code}: ${f.message}`
}

export interface CodeSpan { line: number, text: string }

export interface MarkdownScan {
  lines: string[]
  fence: boolean[]
  spans: CodeSpan[]
  prose: CodeSpan[]
}

export function scanMarkdown(text: string): MarkdownScan {
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''))
  const fence = fenceMask(lines)
  const spans: CodeSpan[] = []
  const prose: CodeSpan[] = []
  lines.forEach((line, i) => {
    if (fence[i]) return
    let out = ''
    let j = 0
    while (j < line.length) {
      if (line[j] !== '`') { out += line[j]; j++; continue }
      let n = 0
      while (line[j + n] === '`') n++
      const ticks = '`'.repeat(n)
      let k = j + n
      let close = -1
      while (k < line.length) {
        const at = line.indexOf(ticks, k)
        if (at < 0) break
        let run = 0
        while (line[at + run] === '`') run++
        if (run === n) { close = at; break }
        k = at + run
      }
      if (close < 0) { out += ticks; j += n; continue }
      spans.push({ line: i + 1, text: line.slice(j + n, close) })
      out += ' '.repeat(close + n - j)
      j = close + n
    }
    prose.push({ line: i + 1, text: out })
  })
  return { lines, fence, spans, prose }
}

export interface PlaceholderTargets { skills: ReadonlySet<string>, agents: ReadonlySet<string> }

const SIMPLE_PLACEHOLDERS = new Set(['ask_user', 'todo', 'spawn_agent'])
const ID = /^[a-z0-9][a-z0-9-]*$/

export function checkPlaceholders(file: string, scan: MarkdownScan, targets: PlaceholderTargets | null, where: string): LintFinding[] {
  const out: LintFinding[] = []
  scan.lines.forEach((line, i) => {
    let at = line.indexOf('{{')
    while (at >= 0) {
      if (at > 0 && line[at - 1] === '\\') {
        const end = line.indexOf('}}', at + 2)
        at = line.indexOf('{{', end >= 0 ? end + 2 : at + 2)
        continue
      }
      const m = /^\{\{([^{}\n]*)\}\}/.exec(line.slice(at))
      if (targets === null) {
        const name = m?.[1] ?? ''
        if (m && (SIMPLE_PLACEHOLDERS.has(name) || /^(skill|agent):/.test(name))) {
          out.push({ level: 'error', code: 'placeholder-not-rendered', file, line: i + 1, message: `'${m[0]}': ${where} are not rendered, so the placeholder would reach the model verbatim; write plain wording instead` })
        }
        at = line.indexOf('{{', at + 2)
        continue
      }
      if (!m) {
        out.push({ level: 'error', code: 'placeholder-malformed', file, line: i + 1, message: `unterminated or malformed placeholder at column ${at + 1}; write {{ask_user}}, {{todo}}, {{spawn_agent}}, {{skill:<id>}} or {{agent:<id>}}, or escape a literal as \\{{…}}` })
        at = line.indexOf('{{', at + 2)
        continue
      }
      const name = m[1] ?? ''
      if (!SIMPLE_PLACEHOLDERS.has(name)) {
        const t = /^(skill|agent):(.*)$/.exec(name)
        if (!t || !ID.test(t[2] ?? '')) {
          out.push({ level: 'error', code: 'placeholder-unknown', file, line: i + 1, message: `unknown placeholder '${m[0]}' (allowed: {{ask_user}}, {{todo}}, {{spawn_agent}}, {{skill:<id>}}, {{agent:<id>}}; escape a literal as \\{{…}})` })
        } else if (t[1] === 'skill' && !targets.skills.has(t[2] as string)) {
          out.push({ level: 'error', code: 'placeholder-target', file, line: i + 1, message: `'${m[0]}' names a skill that does not exist` })
        } else if (t[1] === 'agent' && !targets.agents.has(t[2] as string)) {
          out.push({ level: 'error', code: 'placeholder-target', file, line: i + 1, message: `'${m[0]}' names an agent that does not exist in canonical/agents` })
        }
      }
      at = line.indexOf('{{', at + m[0].length)
    }
  })
  return out
}

export const HARNESS_NAMES = ['claude', 'codex', 'opencode', 'omp'] as const

export function checkHarnessBlocks(file: string, scan: MarkdownScan, allowed: boolean, where: string): LintFinding[] {
  const out: LintFinding[] = []
  let open: { line: number, name: string } | undefined
  scan.lines.forEach((line, i) => {
    const re = /<!--([\s\S]*?)-->/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line)) !== null) {
      const inner = m[1] ?? ''
      if (!/^\s*\/?\s*harness\b/.test(inner)) continue
      if (!allowed) {
        out.push({ level: 'error', code: 'harness-block-not-rendered', file, line: i + 1, message: `${where} are not rendered per harness; '${m[0]}' would reach every harness verbatim` })
        continue
      }
      const openM = /^ harness:([a-z]+) $/.exec(inner)
      if (openM) {
        const h = openM[1] as string
        if (!(HARNESS_NAMES as readonly string[]).includes(h)) {
          out.push({ level: 'error', code: 'harness-unknown', file, line: i + 1, message: `unknown harness '${h}' in '${m[0]}' (use ${HARNESS_NAMES.join(', ')})` })
        }
        if (open !== undefined) out.push({ level: 'error', code: 'harness-block-nested', file, line: i + 1, message: `'${m[0]}' opens a block inside the ${open.name} block opened on line ${open.line}; close it first with <!-- /harness -->` })
        open = { line: i + 1, name: h }
        continue
      }
      if (inner === ' /harness ') {
        if (open === undefined) out.push({ level: 'error', code: 'harness-block-unopened', file, line: i + 1, message: "'<!-- /harness -->' closes a block that was never opened" })
        open = undefined
        continue
      }
      out.push({ level: 'error', code: 'harness-marker-malformed', file, line: i + 1, message: `malformed harness marker '${m[0]}'; write exactly '<!-- harness:<name> -->' and '<!-- /harness -->'` })
    }
  })
  if (open !== undefined) out.push({ level: 'error', code: 'harness-block-unclosed', file, line: open.line, message: `the ${open.name} block opened here is never closed with <!-- /harness -->` })
  return out
}

export function checkBuracleMentions(file: string, scan: MarkdownScan): LintFinding[] {
  const out: LintFinding[] = []
  const check = (line: number, code: string) => {
    for (const mention of findMentions(code)) {
      for (const p of checkMention(mention.tokens)) out.push({ level: 'error', code: 'buracle-command', file, line, message: p.message })
    }
  }
  for (const s of scan.spans) check(s.line, s.text)
  scan.lines.forEach((l, i) => { if (scan.fence[i]) check(i + 1, l) })
  return out
}

const INLINE_LINK = /!?\[(?:[^\]\\]|\\.)*\]\(\s*(<[^>]*>|[^)\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g
const REF_DEF = /^\s{0,3}\[[^\]]+\]:\s*(<[^>]*>|\S+)/

export interface LinkPolicy {
  containWithin?: string
  noRelative?: string
}

export function checkLinks(file: string, absFile: string, scan: MarkdownScan, policy: LinkPolicy = {}): LintFinding[] {
  const out: LintFinding[] = []
  const targets: Array<{ line: number, target: string }> = []
  for (const p of scan.prose) {
    let m: RegExpExecArray | null
    INLINE_LINK.lastIndex = 0
    while ((m = INLINE_LINK.exec(p.text)) !== null) targets.push({ line: p.line, target: m[1] ?? '' })
    const d = REF_DEF.exec(p.text)
    if (d && d[1] !== undefined) targets.push({ line: p.line, target: d[1] })
  }
  for (const { line, target: raw } of targets) {
    const target = raw.replace(/^<|>$/g, '').trim()
    if (target === '' || target.startsWith('#') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target) || target.includes('{{') || /[<>]/.test(target)) continue
    if (target.startsWith('/') || target.startsWith('~')) {
      out.push({ level: 'warning', code: 'link-absolute', file, line, message: `absolute link '${target}' will not resolve on another machine` })
      continue
    }
    const pathPart = target.replace(/[?#].*$/, '')
    let decoded = pathPart
    try { decoded = decodeURIComponent(pathPart) } catch {  }
    if (policy.noRelative !== undefined) {
      out.push({ level: 'warning', code: 'link-relative', file, line, message: `relative link '${target}': ${policy.noRelative}` })
      continue
    }
    const abs = resolve(dirname(absFile), decoded)
    if (!existsSync(abs)) {
      out.push({ level: 'error', code: 'link-broken', file, line, message: `link target '${target}' does not exist` })
      continue
    }
    if (policy.containWithin !== undefined) {
      const rel = relative(policy.containWithin, abs)
      if (rel.startsWith('..') || isAbsolute(rel)) out.push({ level: 'warning', code: 'link-outside-skill', file, line, message: `link '${target}' leaves the skill folder; installed copies of the skill will not include it` })
    }
  }
  return out
}

export function sizeOf(text: string): { words: number, lines: number, tokens: number } {
  const words = text.split(/\s+/).filter(w => w !== '').length
  const lines = text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
  return { words, lines, tokens: Math.max(Math.ceil(text.length / 4), Math.ceil(words * 4 / 3)) }
}
