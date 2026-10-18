import type { Harness } from '../../core/events'

export type RenderTarget = Harness | 'neutral'

export const NEUTRAL_HARNESSES = ['codex', 'opencode', 'omp'] as const
export type NeutralHarness = typeof NEUTRAL_HARNESSES[number]

export const HARNESS_LABEL: Readonly<Record<Harness, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  omp: 'Oh My Pi',
}

export interface RenderOptions {
  file?: string
  skills?: readonly string[]
  agents?: readonly string[]
  protocols?: readonly string[]
}

function userInvocable(id: string, opts: Pick<RenderOptions, 'protocols'>): boolean {
  return !(opts.protocols ?? []).includes(id)
}

export class RenderError extends Error {}

type PlaceholderName = 'ask_user' | 'todo' | 'spawn_agent' | 'skill' | 'agent'

interface Placeholder { name: PlaceholderName, arg?: string, raw: string }

const PLACEHOLDER_RE = /\{\{([a-z_]+)(?::([A-Za-z0-9._-]+))?\}\}/g

export function placeholderLiteral(p: { name: string, arg?: string }, h: Harness, invocable = true): string | undefined {
  const arg = p.arg ?? ''
  switch (p.name) {
    case 'ask_user':
      return { claude: 'AskUserQuestion', codex: 'request_user_input', opencode: 'question', omp: 'ask' }[h]
    case 'todo':
      return { claude: 'TodoWrite', codex: 'update_plan', opencode: undefined, omp: 'todo' }[h]
    case 'spawn_agent':
      return { claude: 'Agent', codex: 'spawn_agent', opencode: 'subagent', omp: 'task' }[h]
    case 'skill':
      return invocable
        ? { claude: `/${arg}`, codex: `$${arg}`, opencode: `/${arg}`, omp: `/${arg}` }[h]
        : { claude: `/buracle:${arg}`, codex: `$${arg}`, opencode: `@${arg}`, omp: `/skill:${arg}` }[h]
    case 'agent':
      return h === 'claude' ? `buracle:${arg}` : arg
    default:
      return undefined
  }
}

function codeLiteral(p: Placeholder, h: Harness, opts: Pick<RenderOptions, 'protocols'>): string {
  const invocable = p.name === 'skill' ? userInvocable(p.arg ?? '', opts) : true
  return placeholderLiteral(p, h, invocable) ?? (p.name === 'todo' ? 'a short checklist in your reply' : p.raw)
}

const DETERMINERS = new Set(['a', 'an', 'the', 'one', 'each', 'every', 'any', 'another', 'this', 'that', 'these', 'those', 'your', 'our', 'its', 'their', 'no', 'some', 'same'])

function neutralProse(p: Placeholder, afterDeterminer: boolean, opts: Pick<RenderOptions, 'protocols'>, inParens: boolean): string {
  const owner = afterDeterminer ? '' : 'your '
  switch (p.name) {
    case 'ask_user':
      return `${owner}structured-question tool (\`request_user_input\` in Codex, \`question\` in OpenCode, \`ask\` in Oh My Pi)`
    case 'todo':
      return `${owner}plan/todo tool where available (\`update_plan\` in Codex, the todo tool in Oh My Pi; OpenCode v2 has none)`
    case 'spawn_agent':
      return `${owner}subagent tool (\`spawn_agent\` in Codex, \`subagent\` in OpenCode, \`task\` in Oh My Pi)`
    case 'skill': {
      const a = p.arg ?? ''
      if (userInvocable(a, opts)) return inParens ? `\`/${a}\`; Codex: \`$${a}\`` : `\`/${a}\` (Codex: \`$${a}\`)`
      const name = `${afterDeterminer ? '' : 'the '}\`${a}\` skill`
      const how = `read \`~/.agents/skills/${a}/SKILL.md\` in Codex, load it with the \`skill\` tool in OpenCode, read \`skill://${a}\` in Oh My Pi`
      return inParens ? `${name}: ${how}` : `${name} (${how})`
    }
    case 'agent':
      return p.arg ?? ''
  }
}

function harnessProse(p: Placeholder, h: Harness, opts: Pick<RenderOptions, 'protocols'>): string {
  if (p.name === 'agent') return placeholderLiteral(p, h) ?? p.raw
  if (p.name === 'todo' && h === 'opencode') return 'a short checklist in your replies'
  const lit = placeholderLiteral(p, h, p.name === 'skill' ? userInvocable(p.arg ?? '', opts) : true)
  return lit === undefined ? p.raw : `\`${lit}\``
}

function joinLabels(hs: readonly Harness[]): string {
  const names = hs.map(h => HARNESS_LABEL[h])
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function groupByValue<T>(entries: ReadonlyArray<readonly [NeutralHarness, T]>, key: (v: T) => string): Array<{ harnesses: NeutralHarness[], value: T }> {
  const out: Array<{ harnesses: NeutralHarness[], value: T, k: string }> = []
  for (const [h, v] of entries) {
    const k = key(v)
    const hit = out.find(g => g.k === k)
    if (hit) hit.harnesses.push(h)
    else out.push({ harnesses: [h], value: v, k })
  }
  return out.map(({ harnesses, value }) => ({ harnesses, value }))
}

function isParagraphText(trimmed: string): boolean {
  return !/^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|>|\||`{3,}|~{3,}|<|\s)/.test(trimmed) && trimmed !== ''
}

function labelLines(lines: string[], label: string): string[] {
  const k = lines.findIndex(l => l.trim() !== '')
  if (k < 0) return []
  const line = lines[k] as string
  const indent = /^[ \t]*/.exec(line)?.[0] ?? ''
  const trimmed = line.slice(indent.length)
  const out = [...lines]
  if (isParagraphText(trimmed)) {
    out[k] = `${indent}**${label}:** ${trimmed}`
    return out
  }
  const spacer = /^(?:[-*+]\s|\d+[.)]\s|#{1,6}\s|\|)/.test(trimmed) ? [''] : []
  out.splice(k, 0, `${indent}**${label}:**`, ...spacer)
  return out
}

const BLOCK_START = /^[ \t]*<!--[ \t]*harness:(claude|codex|opencode|omp)[ \t]*-->[ \t]*$/
const BLOCK_END = /^[ \t]*<!--[ \t]*\/harness[ \t]*-->[ \t]*$/
const INLINE_BLOCK = /<!--[ \t]*harness:(claude|codex|opencode|omp)[ \t]*-->([\s\S]*?)<!--[ \t]*\/harness[ \t]*-->/g
const ANY_MARKER = /<!--[ \t]*\/?harness(?::[a-z]+)?[ \t]*-->/

interface Block { harness: Harness, lines: string[] }

function renderRun(run: Block[], target: RenderTarget): string[] {
  if (target !== 'neutral') return run.filter(b => b.harness === target).flatMap(b => b.lines)
  const kept = run.filter((b): b is Block & { harness: NeutralHarness } => b.harness !== 'claude')
  const groups = groupByValue(kept.map(b => [b.harness, b.lines] as const), lines => lines.map(l => l.trimEnd()).join('\n').trim())
  return groups.flatMap(g => labelLines(g.value, joinLabels(g.harnesses)))
}

function renderInlineBlocks(line: string, target: RenderTarget): string {
  return line.replace(INLINE_BLOCK, (_m, h: string, text: string) => {
    if (target === 'neutral') return h === 'claude' ? '' : `**${HARNESS_LABEL[h as Harness]}:** ${text.trim()}`
    return h === target ? text : ''
  })
}

export function renderHarnessBlocks(text: string, target: RenderTarget, opts: RenderOptions = {}): string {
  const where = opts.file ?? 'markdown'
  const lines = text.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    if (!BLOCK_START.test(line)) {
      if (BLOCK_END.test(line)) throw new RenderError(`${where}:${i + 1}: <!-- /harness --> without an opening harness block`)
      const inline = ANY_MARKER.test(line) ? renderInlineBlocks(line, target) : line
      if (ANY_MARKER.test(inline)) throw new RenderError(`${where}:${i + 1}: unbalanced harness marker`)
      out.push(inline)
      i++
      continue
    }
    const run: Block[] = []
    while (i < lines.length) {
      const m = BLOCK_START.exec(lines[i] as string)
      if (!m) break
      const start = i
      const body: string[] = []
      i++
      while (i < lines.length && !BLOCK_END.test(lines[i] as string)) {
        if (BLOCK_START.test(lines[i] as string)) throw new RenderError(`${where}:${i + 1}: nested harness block (the block opened at line ${start + 1} is not closed)`)
        body.push(lines[i] as string)
        i++
      }
      if (i >= lines.length) throw new RenderError(`${where}:${start + 1}: harness block is not closed with <!-- /harness -->`)
      i++
      run.push({ harness: m[1] as Harness, lines: body })
    }
    const rendered = renderRun(run, target)
    if (rendered.length === 0) {
      const prevBlank = out.length === 0 || (out[out.length - 1] as string).trim() === ''
      if (prevBlank && i < lines.length && (lines[i] as string).trim() === '') i++
    }
    out.push(...rendered)
  }
  return out.join('\n')
}

const ESCAPE_OPEN = '\u{F8FF}'

function parsePlaceholder(raw: string, name: string, arg: string | undefined): Placeholder | undefined {
  if (name === 'skill' || name === 'agent') return arg === undefined || arg === '' ? undefined : { name, arg, raw }
  if ((name === 'ask_user' || name === 'todo' || name === 'spawn_agent') && arg === undefined) return { name, raw }
  return undefined
}

function checkReference(p: Placeholder, opts: RenderOptions, warnings: string[], where: string): void {
  if (p.name === 'skill' && opts.skills && !opts.skills.includes(p.arg ?? '')) warnings.push(`${where}: {{skill:${p.arg}}} names an unknown skill`)
  if (p.name === 'agent' && opts.agents && !opts.agents.includes(p.arg ?? '')) warnings.push(`${where}: {{agent:${p.arg}}} names an unknown agent`)
}

function startsSentence(before: string, prevLine: string | undefined): boolean {
  const lead = before.replace(/^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?(?:\|[ \t]*)?(?:\*\*|__|\*|_)?/, '')
  if (lead.trim() === '') {
    if (/^[ \t]*(?:>[ \t]*)*(?:[-*+]|\d+[.)])[ \t]+/.test(before) || /^[ \t]*\|/.test(before)) return true
    if (prevLine === undefined || prevLine.trim() === '') return true
    return /[.!?:]\s*$/.test(prevLine) || /^[ \t]*(?:#{1,6}\s|`{3,}|~{3,})/.test(prevLine)
  }
  return /[.!?]\s+(?:\*\*|__|\*|_)?$/.test(before)
}

function capitalize(s: string): string {
  return s.length > 0 ? (s[0] as string).toUpperCase() + s.slice(1) : s
}

function precededByDeterminer(before: string): boolean {
  const m = /([A-Za-z]+)[ \t]+$/.exec(before)
  return m !== null && DETERMINERS.has((m[1] as string).toLowerCase())
}

interface CodeSpan { start: number, end: number, ticks: string }

function codeSpans(line: string): CodeSpan[] {
  const spans: CodeSpan[] = []
  const re = /`+/g
  const runs: Array<{ start: number, len: number }> = []
  for (let m = re.exec(line); m; m = re.exec(line)) runs.push({ start: m.index, len: m[0].length })
  let k = 0
  while (k < runs.length) {
    const open = runs[k] as { start: number, len: number }
    const closeIdx = runs.findIndex((r, j) => j > k && r.len === open.len)
    if (closeIdx < 0) { k++; continue }
    const close = runs[closeIdx] as { start: number, len: number }
    spans.push({ start: open.start, end: close.start + close.len, ticks: '`'.repeat(open.len) })
    k = closeIdx + 1
  }
  return spans
}

function hasPlaceholder(s: string): boolean {
  PLACEHOLDER_RE.lastIndex = 0
  return PLACEHOLDER_RE.test(s)
}

function codeForHarness(code: string, h: Harness, opts: Pick<RenderOptions, 'protocols'>): string {
  return code.replace(PLACEHOLDER_RE, (raw, name: string, arg: string | undefined) => {
    const p = parsePlaceholder(raw, name, arg)
    return p ? codeLiteral(p, h, opts) : raw
  })
}

function neutralCodeVariants(code: string, opts: Pick<RenderOptions, 'protocols'>): Array<{ harnesses: NeutralHarness[], value: string }> {
  return groupByValue(NEUTRAL_HARNESSES.map(h => [h, codeForHarness(code, h, opts)] as const), v => v)
}

function renderProseSegment(seg: string, lineBefore: string, prevLine: string | undefined, target: RenderTarget, opts: RenderOptions, warnings: string[], where: string): string {
  let out = ''
  let last = 0
  PLACEHOLDER_RE.lastIndex = 0
  for (let m = PLACEHOLDER_RE.exec(seg); m; m = PLACEHOLDER_RE.exec(seg)) {
    const raw = m[0]
    const p = parsePlaceholder(raw, m[1] as string, m[2])
    out += seg.slice(last, m.index)
    last = m.index + raw.length
    if (!p) { warnings.push(`${where}: unknown placeholder ${raw} left as is`); out += raw; continue }
    checkReference(p, opts, warnings, where)
    const before = lineBefore + out
    let text: string
    if (target === 'neutral') text = neutralProse(p, precededByDeterminer(before), opts, before.endsWith('(') && seg[last] === ')')
    else text = harnessProse(p, target, opts)
    if (startsSentence(before, prevLine) && /^[a-z]/.test(text)) text = capitalize(text)
    out += text
  }
  return out + seg.slice(last)
}

function renderInlineCode(span: string, target: RenderTarget, opts: RenderOptions, warnings: string[], where: string): string {
  if (!hasPlaceholder(span)) return span
  PLACEHOLDER_RE.lastIndex = 0
  for (let m = PLACEHOLDER_RE.exec(span); m; m = PLACEHOLDER_RE.exec(span)) {
    const p = parsePlaceholder(m[0], m[1] as string, m[2])
    if (p) checkReference(p, opts, warnings, where)
    else warnings.push(`${where}: unknown placeholder ${m[0]} left as is`)
  }
  if (target !== 'neutral') return codeForHarness(span, target, opts)
  const variants = neutralCodeVariants(span, opts)
  if (variants.length === 1) return (variants[0] as { value: string }).value
  return variants.map(v => `${v.value} in ${joinLabels(v.harnesses)}`).join(', ')
}

function renderProseLine(line: string, prevLine: string | undefined, target: RenderTarget, opts: RenderOptions, warnings: string[], where: string): string {
  if (!hasPlaceholder(line)) return line
  const spans = codeSpans(line)
  let out = ''
  let pos = 0
  for (const s of spans) {
    out += renderProseSegment(line.slice(pos, s.start), out, prevLine, target, opts, warnings, where)
    out += renderInlineCode(line.slice(s.start, s.end), target, opts, warnings, where)
    pos = s.end
  }
  out += renderProseSegment(line.slice(pos), out, prevLine, target, opts, warnings, where)
  return out
}

const FENCE_OPEN = /^([ \t]*)(`{3,}|~{3,})(.*)$/

export function renderPlaceholders(text: string, target: RenderTarget, opts: RenderOptions = {}, warnings: string[] = []): string {
  const where = opts.file ?? 'markdown'
  const parked = text.replace(/\\\{\{/g, ESCAPE_OPEN)
  const lines = parked.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] as string
    const fence = FENCE_OPEN.exec(line)
    if (fence) {
      const marker = fence[2] as string
      const closeRe = new RegExp(`^[ \\t]*${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`)
      let j = i + 1
      while (j < lines.length && !closeRe.test(lines[j] as string)) j++
      const block = lines.slice(i, Math.min(j + 1, lines.length))
      const body = block.join('\n')
      if (!hasPlaceholder(body)) out.push(...block)
      else {
        PLACEHOLDER_RE.lastIndex = 0
        for (let m = PLACEHOLDER_RE.exec(body); m; m = PLACEHOLDER_RE.exec(body)) {
          const p = parsePlaceholder(m[0], m[1] as string, m[2])
          if (p) checkReference(p, opts, warnings, `${where}:${i + 1}`)
          else warnings.push(`${where}:${i + 1}: unknown placeholder ${m[0]} left as is`)
        }
        if (target !== 'neutral') out.push(...codeForHarness(body, target, opts).split('\n'))
        else {
          const variants = neutralCodeVariants(body, opts)
          if (variants.length === 1) out.push(...(variants[0] as { value: string }).value.split('\n'))
          else for (const v of variants) out.push(...labelLines(v.value.split('\n'), joinLabels(v.harnesses)))
        }
      }
      i = j + 1
      continue
    }
    out.push(renderProseLine(line, i > 0 ? lines[i - 1] : undefined, target, opts, warnings, `${where}:${i + 1}`))
    i++
  }
  return out.join('\n').split(ESCAPE_OPEN).join('{{')
}

export function renderMarkdown(text: string, target: RenderTarget, opts: RenderOptions = {}, warnings: string[] = []): string {
  return renderPlaceholders(renderHarnessBlocks(text, target, opts), target, opts, warnings)
}
