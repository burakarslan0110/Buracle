import { isAbsolute, join, resolve } from 'node:path'

export interface EditChange { file: string; removed: string; added: string }
export interface EditTargets {
  paths: string[]
  changes: EditChange[]
}

const READ_MAX = 512 * 1024

const SECTION = /^\[(.+)#([0-9A-Fa-f]{4})\]\s*$/
const RANGE = /^(?:PUT|CUT)\s+(\d+)\s*\.=\s*(\d+)/
const BLOCK = /^(?:PUT|CUT)\s+(\d+)\s*\*/
const MOVE = /^MV\s+(?:"([^"]+)"|'([^']+)'|(\S.*?))\s*$/
const SLOPPY_FILE = /^\*\*\* Edit File:\s*(.*?)\s*$/
const SLOPPY_PART = /^\*\*\* (Find|Replace|Insert Before|Insert After)\s*$/

function abs(cwd: string, p: string, home: string | undefined): string {
  const t = p.trim()
  if (home !== undefined && (t === '~' || t.startsWith('~/'))) return join(home, t.slice(2))
  return isAbsolute(t) ? resolve(t) : resolve(cwd, t)
}

interface Section { file: string; ranges: Array<[number, number]>; added: string[]; removedAll: boolean }

function hashline(text: string, cwd: string, read: (path: string) => string | undefined, home: string | undefined): EditTargets | undefined {
  const sections: Section[] = []
  const paths: string[] = []
  const addPath = (p: string): void => { if (!paths.includes(p)) paths.push(p) }
  let cur: Section | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const head = SECTION.exec(line.trim())
    if (head !== null) {
      cur = { file: abs(cwd, head[1] as string, home), ranges: [], added: [], removedAll: false }
      sections.push(cur)
      addPath(cur.file)
      continue
    }
    if (cur === undefined) continue
    if (line.startsWith('+')) { cur.added.push(line.slice(1)); continue }
    const op = line.trim()
    const range = RANGE.exec(op)
    if (range !== null) { cur.ranges.push([Number(range[1]), Number(range[2])]); continue }
    const block = BLOCK.exec(op)
    if (block !== null) { cur.ranges.push([Number(block[1]), Number(block[1])]); continue }
    if (/^REM\s*$/.test(op)) { cur.removedAll = true; continue }
    const move = MOVE.exec(op)
    if (move !== null) addPath(abs(cwd, (move[1] ?? move[2] ?? move[3]) as string, home))
  }
  if (sections.length === 0) return undefined
  const changes: EditChange[] = []
  for (const s of sections) {
    let removed = ''
    if (s.removedAll || s.ranges.length > 0) {
      let body: string | undefined
      try { body = read(s.file) } catch { body = undefined }
      if (body !== undefined) {
        const lines = body.slice(0, READ_MAX).split('\n')
        removed = s.removedAll
          ? lines.join('\n')
          : s.ranges.flatMap(([a, b]) => lines.slice(Math.max(0, Math.min(a, b) - 1), Math.max(a, b))).join('\n')
      }
    }
    changes.push({ file: s.file, removed, added: s.added.join('\n') })
  }
  return { paths, changes }
}

function sloppy(text: string, cwd: string, home: string | undefined): EditTargets | undefined {
  const paths: string[] = []
  const byFile = new Map<string, { removed: string[], added: string[] }>()
  let file: string | undefined
  let part: 'find' | 'add' | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const f = SLOPPY_FILE.exec(line)
    if (f !== null) {
      const name = (f[1] ?? '').replace(/\s+all$/, '').trim()
      if (name !== '') {
        file = abs(cwd, name, home)
        if (!paths.includes(file)) paths.push(file)
        if (!byFile.has(file)) byFile.set(file, { removed: [], added: [] })
      }
      part = undefined
      continue
    }
    const p = SLOPPY_PART.exec(line)
    if (p !== null) { part = p[1] === 'Find' ? 'find' : 'add'; continue }
    if (file === undefined || part === undefined || line.startsWith('*** ')) continue
    const entry = byFile.get(file)
    if (entry !== undefined) (part === 'find' ? entry.removed : entry.added).push(line)
  }
  if (paths.length === 0) return undefined
  return { paths, changes: paths.map(p => ({ file: p, removed: byFile.get(p)?.removed.join('\n') ?? '', added: byFile.get(p)?.added.join('\n') ?? '' })) }
}

export function editTargets(input: Record<string, unknown>, cwd: string, read: (path: string) => string | undefined, home?: string): EditTargets | undefined {
  const text = input['input']
  if (typeof text !== 'string' || text.trim() === '') return undefined
  return hashline(text, cwd, read, home) ?? sloppy(text, cwd, home)
}
