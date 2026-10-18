const HARNESS_BLOCK = /<!--\s*harness:\s*([a-z][a-z, ]*?)\s*-->[ \t]*\r?\n?([\s\S]*?)<!--\s*\/harness\s*-->[ \t]*(\r?\n)?/g

export function filterHarnessBlocks(text: string, harness = 'omp'): string {
  return text.replace(HARNESS_BLOCK, (_all, list: string, body: string) => {
    const names = list.split(',').map(s => s.trim()).filter(s => s !== '')
    if (!names.includes(harness)) return ''
    return body.endsWith('\n') ? body : body + '\n'
  })
}

function placeholder(name: string, inCode: boolean): string | undefined {
  const tool = (t: string) => (inCode ? t : `the \`${t}\` tool`)
  switch (name) {
    case 'ask_user': return tool('ask')
    case 'todo': return tool('todo')
    case 'spawn_agent': return tool('task')
  }
  const skill = /^skill:([a-z0-9][a-z0-9._-]*)$/.exec(name)
  if (skill) return inCode ? `/skill:${skill[1]}` : `\`/skill:${skill[1]}\``
  const agent = /^agent:([a-z0-9][a-z0-9._-]*)$/.exec(name)
  if (agent) return inCode ? `${agent[1]}` : `\`${agent[1]}\``
  return undefined
}

function expandSegment(seg: string, inCode: boolean): string {
  return seg.replace(/(\\?)\{\{([a-z_]+(?::[a-z0-9._-]+)?)\}\}/g, (all, esc: string, name: string) => {
    if (esc === '\\') return `{{${name}}}`
    return placeholder(name, inCode) ?? all
  })
}

export function expandPlaceholders(text: string): string {
  let fence: string | undefined
  return text.split('\n').map(line => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line)
    if (m && m[1] !== undefined) {
      const marker = m[1]
      if (fence === undefined) fence = marker[0] === '`' ? '`' : '~'
      else if (marker[0] === fence) fence = undefined
      return expandSegment(line, true)
    }
    if (fence !== undefined) return expandSegment(line, true)
    return line.split('`').map((seg, i) => expandSegment(seg, i % 2 === 1)).join('`')
  }).join('\n')
}

export function renderForOmp(text: string): string {
  return expandPlaceholders(filterHarnessBlocks(text.replace(/\r\n/g, '\n'))).replace(/\n{3,}/g, '\n\n')
}

export function firstHeading(body: string): string | undefined {
  const m = /^#\s+(.+?)(?:\s+#+)?\s*$/m.exec(body)
  return m?.[1]
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys)
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k]
      if (x !== undefined) out[k] = sortKeys(x)
    }
    return out
  }
  return v
}

export function stableJson(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeys(value), null, indent)
}

export type FrontmatterValue = string | number | boolean | string[]

export function frontmatter(entries: Array<[string, FrontmatterValue | undefined]>): string {
  const lines = ['---']
  for (const [key, value] of entries) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      if (value.length === 0) { lines.push(`${key}: []`); continue }
      lines.push(`${key}:`)
      for (const item of value) lines.push(`  - ${JSON.stringify(item)}`)
    } else if (typeof value === 'string') {
      lines.push(`${key}: ${JSON.stringify(value)}`)
    } else {
      lines.push(`${key}: ${String(value)}`)
    }
  }
  lines.push('---')
  return lines.join('\n') + '\n'
}

export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

export function withFinalNewline(s: string): string {
  return s.replace(/\s+$/, '') + '\n'
}
