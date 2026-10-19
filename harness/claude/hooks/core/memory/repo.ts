import { memClip } from './text'

export interface MemStackItem {
  slug: string
  name: string
  kind: 'language' | 'runtime' | 'framework' | 'tool' | 'package-manager' | 'test-runner' | 'database' | 'platform'
  description: string
}

export interface MemRepoScan {
  stack: MemStackItem[]
  languages: Array<{ name: string, files: number }>
  commands: Array<{ cmd: string, source: string }>
  dirs: Array<{ name: string, files: number }>
  manifests: string[]
  files: number
  truncated?: boolean
}

function pct(n: number, total: number): string {
  return total > 0 ? `${Math.round((100 * n) / total)}%` : '0%'
}

function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function memCommandLines(scan: MemRepoScan): string[] {
  return scan.commands.slice(0, 20).map(c => `- \`${c.cmd.replace(/`/g, "'")}\` (${c.source})`)
}

export function memStructureLines(scan: MemRepoScan): string[] {
  const out: string[] = []
  const total = scan.languages.reduce((n, l) => n + l.files, 0)
  if (scan.stack.length > 0) out.push(`- Stack: ${scan.stack.slice(0, 12).map(s => s.name).join(' · ')}`)
  if (scan.languages.length > 0) out.push(`- Languages: ${scan.languages.slice(0, 6).map(l => `${l.name} ${pct(l.files, total)}`).join(' · ')}`)
  if (scan.dirs.length > 0) out.push(`- Top-level folders: ${scan.dirs.slice(0, 10).map(d => `\`${d.name}/\` (${d.files})`).join(' · ')}`)
  if (scan.manifests.length > 0) out.push(`- Manifests: ${scan.manifests.slice(0, 10).map(m => `\`${m}\``).join(', ')}`)
  if (scan.truncated) out.push(`- Counted the first ${thousands(scan.files)} files only.`)
  return out
}

export const DETECTED_OPEN = '<!-- buracle:detected:start -->'
export const DETECTED_CLOSE = '<!-- buracle:detected:end -->'

export function detectedBlock(section: string, scan: MemRepoScan | undefined): string {
  if (scan === undefined) return ''
  const lines = section === 'commands' ? memCommandLines(scan) : section === 'architecture' ? memStructureLines(scan) : []
  return lines.length === 0 ? '' : [DETECTED_OPEN, 'Detected from the repository (Buracle keeps this part current):', ...lines, DETECTED_CLOSE].join('\n')
}

export function withDetectedBlock(body: string, block: string): string {
  const start = body.indexOf(DETECTED_OPEN)
  const end = start >= 0 ? body.indexOf(DETECTED_CLOSE, start) : -1
  if (start >= 0 && end > start) {
    const before = body.slice(0, start).trimEnd()
    const after = body.slice(end + DETECTED_CLOSE.length).trimStart()
    return [before, block, after].filter(s => s !== '').join('\n\n')
  }
  if (block === '') return body
  return body.trim() === '' ? block : `${body.trimEnd()}\n\n${block}`
}

export function detectedBlockOf(body: string): string {
  const start = body.indexOf(DETECTED_OPEN)
  const end = start >= 0 ? body.indexOf(DETECTED_CLOSE, start) : -1
  return start >= 0 && end > start ? body.slice(start, end + DETECTED_CLOSE.length) : ''
}

export function coreHumanPart(body: string): string {
  return withDetectedBlock(body, '').trim()
}

export function detectedSummary(section: string, scan: MemRepoScan): string | undefined {
  if (section === 'commands' && scan.commands.length > 0) return memClip(`Detected: ${scan.commands.slice(0, 5).map(c => c.cmd).join(' · ')}`, 280)
  if (section === 'architecture') {
    const langs = scan.languages.slice(0, 3).map(l => l.name)
    const dirs = scan.dirs.slice(0, 5).map(d => `${d.name}/`)
    if (langs.length === 0 && dirs.length === 0) return undefined
    return memClip(`Detected: ${[langs.join(', '), dirs.join(' ')].filter(s => s !== '').join('; ')}`, 280)
  }
  return undefined
}
