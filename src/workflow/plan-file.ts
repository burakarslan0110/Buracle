import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { parseFrontmatter, renderScalar, type FmData } from '../core/frontmatter'
import { parsePlan, type PlanStatus, type PlanType } from '../core/plan/format'
import { atomicWriteSync } from '../engine/fsx'

export type Phase = 'plan' | 'implement' | 'verify' | 'done'

export const PLAN_STATUSES: readonly PlanStatus[] = ['PENDING', 'APPROVED', 'IN_PROGRESS', 'COMPLETE', 'VERIFIED', 'SAVED']
export const SETTABLE_STATUSES: readonly PlanStatus[] = ['PENDING', 'APPROVED', 'IN_PROGRESS', 'COMPLETE', 'VERIFIED']
export const PLAN_TYPES: readonly PlanType[] = ['Feature', 'Bugfix', 'Build', 'Plan']
export const PHASES: readonly Phase[] = ['plan', 'implement', 'verify', 'done']

const HEADER_ORDER = ['created', 'status', 'approved', 'worktree', 'type', 'phase', 'iterations', 'rounds', 'harness']

export interface TaskProgress {
  done: number
  total: number
  open: Array<{ n: number, title: string }>
  source: 'core' | 'local'
}

export interface PlanInfo {
  hasFrontmatter: boolean
  frontmatter: FmData
  status?: PlanStatus
  type?: PlanType
  approved?: boolean
  worktree?: boolean
  phase?: Phase
  iterations?: number
  rounds?: number
  created?: string
  title?: string
  tasks: TaskProgress
  problems: string[]
}

export function normalizeStatus(x: unknown): PlanStatus | undefined {
  if (typeof x !== 'string') return undefined
  const u = x.trim().toUpperCase().replace(/[\s-]+/g, '_')
  return (PLAN_STATUSES as readonly string[]).includes(u) ? u as PlanStatus : undefined
}

export function normalizeType(x: unknown): PlanType | undefined {
  if (typeof x !== 'string') return undefined
  const l = x.trim().toLowerCase()
  return PLAN_TYPES.find(t => t.toLowerCase() === l)
}

export function normalizePhase(x: unknown): Phase | undefined {
  if (typeof x !== 'string') return undefined
  const l = x.trim().toLowerCase()
  return (PHASES as readonly string[]).includes(l) ? l as Phase : undefined
}

export function parseBool(x: unknown): boolean | undefined {
  if (typeof x === 'boolean') return x
  if (typeof x !== 'string') return undefined
  const l = x.trim().toLowerCase()
  if (l === 'true' || l === 'yes' || l === '1') return true
  if (l === 'false' || l === 'no' || l === '0') return false
  return undefined
}

function nonNegInt(x: unknown): number | undefined {
  if (typeof x === 'number' && Number.isInteger(x) && x >= 0) return x
  if (typeof x === 'string' && /^\d+$/.test(x.trim())) return Number(x.trim())
  return undefined
}

export function fenceMask(lines: readonly string[]): boolean[] {
  const mask: boolean[] = []
  let fence: { ch: string, len: number } | undefined
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
    if (fence) {
      mask.push(true)
      if (m && m[1] !== undefined && m[1][0] === fence.ch && m[1].length >= fence.len && line.trim() === m[1]) fence = undefined
      continue
    }
    if (m && m[1] !== undefined && !(m[1][0] === '`' && line.slice(line.indexOf(m[1]) + m[1].length).includes('`'))) {
      fence = { ch: m[1][0] as string, len: m[1].length }
      mask.push(true)
      continue
    }
    mask.push(false)
  }
  return mask
}

export function planTitle(body: string): string | undefined {
  const lines = body.split(/\r?\n/)
  const mask = fenceMask(lines)
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue
    const m = /^#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(lines[i] ?? '')
    if (m && m[1] !== undefined) return m[1]
  }
  return undefined
}

export function planSections(body: string): Map<string, string[]> {
  const lines = body.split(/\r?\n/)
  const mask = fenceMask(lines)
  const out = new Map<string, string[]>()
  let current: string[] | undefined
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!mask[i]) {
      const h = /^(#{1,2})[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/.exec(line)
      if (h) {
        current = undefined
        const name = (h[2] ?? '').trim()
        if (h[1] === '##' && !out.has(name)) { current = []; out.set(name, current) }
        continue
      }
    }
    current?.push(line)
  }
  return out
}

export function sectionFilled(lines: readonly string[] | undefined): boolean {
  if (lines === undefined) return false
  const text = lines.join('\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '')
  const rows = text.split('\n').map(l => l.trim()).filter(l => l !== '')
  const content = rows.filter(l => !/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?$/.test(l))
  if (content.length === 0) return false
  if (content.length === 1 && content[0]?.startsWith('|') === true && rows.length > 1) return false
  return true
}

const TASK_HEADING = /^###\s+Task\s+(\d+)\s*[:.\-–—]?\s*(.*?)\s*$/
const TASK_CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s+Task\s+(\d+)\s+done\b/i

export function localTaskProgress(body: string): TaskProgress {
  const lines = body.split(/\r?\n/)
  const mask = fenceMask(lines)
  let start = 0
  let end = lines.length
  const tasksAt = lines.findIndex((l, i) => !mask[i] && /^##\s+Tasks\s*$/.test(l))
  if (tasksAt >= 0) {
    start = tasksAt + 1
    for (let i = start; i < lines.length; i++) {
      if (!mask[i] && /^##\s/.test(lines[i] ?? '')) { end = i; break }
    }
  }
  const tasks = new Map<number, { title: string, done: boolean }>()
  let current: number | undefined
  for (let i = start; i < end; i++) {
    if (mask[i]) continue
    const line = lines[i] ?? ''
    const h = TASK_HEADING.exec(line)
    if (h) {
      const n = Number(h[1])
      current = tasks.has(n) ? undefined : n
      if (current !== undefined) tasks.set(n, { title: h[2] ?? '', done: false })
      continue
    }
    if (/^#{1,3}\s/.test(line)) { current = undefined; continue }
    const c = TASK_CHECKBOX.exec(line)
    if (c && current !== undefined && Number(c[2]) === current) {
      const t = tasks.get(current)
      if (t) t.done = (c[1] ?? ' ').toLowerCase() === 'x'
    }
  }
  const all = [...tasks.entries()].sort((a, b) => a[0] - b[0])
  return {
    done: all.filter(([, t]) => t.done).length,
    total: all.length,
    open: all.filter(([, t]) => !t.done).map(([n, t]) => ({ n, title: t.title })),
    source: 'local',
  }
}

export function taskProgress(markdown: string, body: string): TaskProgress {
  try {
    const plan = parsePlan(markdown)
    if (Array.isArray(plan.tasks)) {
      const tasks = [...plan.tasks].sort((a, b) => a.n - b.n)
      return {
        done: tasks.filter(t => t.done).length,
        total: tasks.length,
        open: tasks.filter(t => !t.done).map(t => ({ n: t.n, title: t.title })),
        source: 'core',
      }
    }
  } catch {  }
  return localTaskProgress(body)
}

export function analyzePlan(markdown: string): PlanInfo {
  const fm = parseFrontmatter(markdown)
  const d = fm.data
  const problems: string[] = []
  const info: PlanInfo = { hasFrontmatter: fm.hasFrontmatter, frontmatter: d, tasks: taskProgress(markdown, fm.body), problems }
  const status = normalizeStatus(d['status'])
  if (status !== undefined) info.status = status
  else if (d['status'] !== undefined) problems.push(`invalid status ${JSON.stringify(d['status'])}`)
  const type = normalizeType(d['type'])
  if (type !== undefined) info.type = type
  else if (d['type'] !== undefined) problems.push(`invalid type ${JSON.stringify(d['type'])}`)
  const approved = parseBool(d['approved'])
  if (approved !== undefined) info.approved = approved
  else if (d['approved'] !== undefined) problems.push(`invalid approved ${JSON.stringify(d['approved'])}`)
  const worktree = parseBool(d['worktree'])
  if (worktree !== undefined) info.worktree = worktree
  const phase = normalizePhase(d['phase'])
  if (phase !== undefined) info.phase = phase
  else if (d['phase'] !== undefined) problems.push(`invalid phase ${JSON.stringify(d['phase'])}`)
  const it = nonNegInt(d['iterations'])
  if (it !== undefined) info.iterations = it
  const rounds = nonNegInt(d['rounds'])
  if (rounds !== undefined) info.rounds = rounds
  if (d['created'] !== undefined && d['created'] !== null) info.created = String(d['created'])
  const title = planTitle(fm.body)
  if (title !== undefined) info.title = title
  return info
}

export type PlanRead =
  | { ok: true, text: string, info: PlanInfo }
  | { ok: false, code: 'missing' | 'io', error: string }

export function readPlanFile(path: string): PlanRead {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, code: 'missing', error: `plan file not found: ${path}` }
    if (code === 'EISDIR') return { ok: false, code: 'io', error: `${path} is a directory, not a plan file` }
    return { ok: false, code: 'io', error: `${path}: ${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, text, info: analyzePlan(text) }
}

export type HeaderValue = string | number | boolean

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function keyLineRe(key: string): RegExp {
  const k = escapeRe(key)
  return new RegExp(`^(?:${k}|"${k}"|'${k}')[ \\t]*:(?:[ \\t]|\\r?$)`)
}

function findKeyLine(fm: readonly string[], key: string): number {
  const re = keyLineRe(key)
  return fm.findIndex(l => re.test(l))
}

function restOf(line: string): string {
  const i = line.indexOf(':')
  return line.slice(i + 1).replace(/\r$/, '').trim()
}

function entryEnd(fm: readonly string[], i: number): number {
  const rest = restOf(fm[i] ?? '')
  if (rest !== '' && !/^[|>][+-]?$/.test(rest)) return i
  let j = i + 1
  while (j < fm.length) {
    const l = (fm[j] ?? '').replace(/\r$/, '')
    if (/^[ \t]+\S/.test(l) || /^-([ \t]|$)/.test(l)) { j++; continue }
    break
  }
  return j - 1
}

function trailingComment(line: string): string {
  const rest = restOf(line)
  if (rest.startsWith('"') || rest.startsWith("'")) return ''
  const m = /\s(#.*)$/.exec(rest)
  return m && m[1] !== undefined ? ` ${m[1]}` : ''
}

export function updateFrontmatterText(markdown: string, updates: Readonly<Record<string, HeaderValue>>): string {
  const bom = markdown.startsWith('﻿') ? '﻿' : ''
  const text = bom === '' ? markdown : markdown.slice(1)
  const lines = text.split('\n')
  if (!/^---[ \t]*\r?$/.test(lines[0] ?? '')) throw new Error('the plan file has no YAML frontmatter (it must start with ---)')
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (/^(?:---|\.\.\.)[ \t]*\r?$/.test(lines[i] ?? '')) { end = i; break }
  }
  if (end < 0) throw new Error('the plan frontmatter is not closed with ---')
  const cr = (lines[0] ?? '').endsWith('\r') ? '\r' : ''
  const fm = lines.slice(1, end)
  for (const [key, value] of Object.entries(updates)) {
    const fresh = `${key}: ${renderScalar(value)}`
    const at = findKeyLine(fm, key)
    if (at >= 0) {
      const last = entryEnd(fm, at)
      fm.splice(at, last - at + 1, fresh + trailingComment(fm[at] ?? '') + cr)
      continue
    }
    let insertAt = fm.length
    const pos = HEADER_ORDER.indexOf(key)
    if (pos >= 0) {
      let after = -1
      for (const k of HEADER_ORDER.slice(0, pos)) {
        const i = findKeyLine(fm, k)
        if (i >= 0) after = Math.max(after, entryEnd(fm, i))
      }
      if (after >= 0) insertAt = after + 1
      else {
        for (const k of HEADER_ORDER.slice(pos + 1)) {
          const i = findKeyLine(fm, k)
          if (i >= 0) insertAt = Math.min(insertAt, i)
        }
      }
    } else {
      while (insertAt > 0 && (fm[insertAt - 1] ?? '').replace(/\r$/, '').trim() === '') insertAt--
    }
    fm.splice(insertAt, 0, fresh + cr)
  }
  const out = bom + [lines[0] as string, ...fm, ...lines.slice(end)].join('\n')
  const back = parseFrontmatter(out).data
  for (const [key, value] of Object.entries(updates)) {
    if (String(back[key]) !== String(value)) throw new Error(`could not update frontmatter key ${key}`)
  }
  return out
}

export function writePlanHeader(path: string, text: string, updates: Readonly<Record<string, HeaderValue>>): string {
  const next = updateFrontmatterText(text, updates)
  if (next !== text) atomicWriteSync(path, next)
  return next
}

export const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isValidSlug(s: string): boolean {
  return s.length > 0 && s.length <= 64 && SLUG_RE.test(s)
}

export function slugFromTitle(title: string, max = 50): string {
  const folded = title
    .replace(/İ/g, 'i').replace(/I/g, 'i').replace(/ı/g, 'i')
    .toLowerCase()
    .replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  let slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  if (slug.length > max) {
    const cut = slug.slice(0, max)
    const dash = cut.lastIndexOf('-')
    slug = (dash >= Math.floor(max / 2) ? cut.slice(0, dash) : cut).replace(/-+$/g, '')
  }
  return slug === '' ? 'plan' : slug
}

export function slugFromPlanPath(path: string): string {
  const base = basename(path).replace(/\.md$/i, '')
  const m = /^\d{4}-\d{2}-\d{2}-(.+)$/.exec(base)
  const s = m && m[1] !== undefined ? m[1] : base
  return isValidSlug(s) ? s : slugFromTitle(s, 64)
}

export function localDate(now: number): string {
  const d = new Date(now)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
