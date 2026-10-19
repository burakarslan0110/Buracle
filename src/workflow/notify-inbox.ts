import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { stateDir } from '../engine/paths'
import type { NotifyType } from './memory-bridge'
import { fail, ok, type CmdResult, type WorkflowCtx } from './result'

export interface NotificationEntry {
  id: string
  ts: string
  type: NotifyType | string
  title: string
  message: string
  cwd?: string
  plan?: string
  harness?: string
  session?: string
  read: boolean
}

const ID_RE = /^[a-z0-9-]{4,40}$/

export function notificationsFile(): string {
  return join(stateDir(), 'notifications.jsonl')
}

export function notificationsReadFile(): string {
  return join(stateDir(), 'notifications-read.json')
}

export function newNotificationId(nowMs: number): string {
  return `n${Math.max(0, Math.floor(nowMs)).toString(36)}-${randomBytes(3).toString('hex')}`
}

function lineId(line: string): string {
  return `l-${createHash('sha256').update(line).digest('hex').slice(0, 12)}`
}

function str(x: unknown): string | undefined {
  return typeof x === 'string' && x !== '' ? x : undefined
}

function readIds(): Set<string> {
  const r = readJsonSafeSync<{ v?: unknown, read?: unknown }>(notificationsReadFile())
  if (!r.ok || r.value === null || typeof r.value !== 'object' || !Array.isArray(r.value.read)) return new Set()
  return new Set(r.value.read.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)))
}

export function readNotifications(): NotificationEntry[] {
  let text: string
  try { text = readFileSync(notificationsFile(), 'utf8') } catch { return [] }
  const read = readIds()
  const out: NotificationEntry[] = []
  const seen = new Set<string>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let o: Record<string, unknown>
    try {
      const v = JSON.parse(line) as unknown
      if (v === null || typeof v !== 'object' || Array.isArray(v)) continue
      o = v as Record<string, unknown>
    } catch { continue }
    const ts = str(o['ts'])
    const title = str(o['title'])
    if (ts === undefined || title === undefined || !Number.isFinite(Date.parse(ts))) continue
    let id = typeof o['id'] === 'string' && ID_RE.test(o['id']) ? o['id'] : lineId(line)
    if (seen.has(id)) id = lineId(line)
    if (seen.has(id)) continue
    seen.add(id)
    const e: NotificationEntry = { id, ts, type: str(o['type']) ?? 'info', title, message: typeof o['message'] === 'string' ? o['message'] : '', read: read.has(id) }
    for (const k of ['cwd', 'plan', 'harness', 'session'] as const) { const v = str(o[k]); if (v !== undefined) e[k] = v }
    out.push(e)
  }
  return out.sort((a, b) => b.ts.localeCompare(a.ts) || (a.id < b.id ? 1 : -1))
}

export function markNotificationsRead(ids: readonly string[] | 'all'): { marked: number, unread: number, unknown: string[] } {
  const all = readNotifications()
  const present = new Set(all.map(e => e.id))
  const read = new Set([...readIds()].filter(id => present.has(id)))
  const want = ids === 'all' ? [...present] : ids
  const unknown = ids === 'all' ? [] : ids.filter(id => !present.has(id))
  let marked = 0
  for (const id of want) {
    if (!present.has(id) || read.has(id)) continue
    read.add(id)
    marked++
  }
  try {
    mkdirSync(stateDir(), { recursive: true })
    atomicWriteSync(notificationsReadFile(), JSON.stringify({ v: 1, read: all.map(e => e.id).filter(id => read.has(id)) }) + '\n', { mode: 0o600 })
  } catch (e) {
    log('warn', 'could not write notifications-read.json', { error: e })
    throw e
  }
  return { marked, unread: all.filter(e => !read.has(e.id)).length, unknown }
}

export function unreadCount(): number {
  return readNotifications().filter(e => !e.read).length
}

export const NOTIFY_LIST_LIMIT = 20

function tildeOf(p: string, home: string | undefined): string {
  return home !== undefined && home !== '' && (p === home || p.startsWith(`${home}/`)) ? `~${p.slice(home.length)}` : p
}

function localStamp(ts: string): string {
  const d = new Date(Date.parse(ts))
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function oneLine(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

export function notifyList(opts: { unread?: boolean, limit?: number }, ctx: WorkflowCtx): CmdResult {
  const all = readNotifications()
  const unread = all.filter(e => !e.read).length
  const list = (opts.unread === true ? all.filter(e => !e.read) : all).slice(0, opts.limit ?? NOTIFY_LIST_LIMIT)
  const home = ctx.env['HOME']
  const lines = list.length === 0
    ? [opts.unread === true ? 'No unread notifications.' : 'No notifications yet.']
    : list.map(e => `${e.read ? ' ' : '*'} ${localStamp(e.ts)}  ${e.type.padEnd(21)} ${oneLine(e.title, 60)}${e.message !== '' ? ` · ${oneLine(e.message, 80)}` : ''}${e.plan !== undefined ? `  (${tildeOf(e.plan, home)})` : ''}  [${e.id}]`)
  if (list.length > 0) lines.push(`${unread} unread of ${all.length} (\`buracle notify read <id>\` or \`--all\` marks them read)`)
  return ok({ unread, total: all.length, notifications: list }, lines)
}

export function notifyRead(ids: readonly string[], all: boolean): CmdResult {
  if (!all && ids.length === 0) return fail('usage', 'name the notification ids to mark read, or pass --all')
  if (all && ids.length > 0) return fail('usage', '--all takes no ids')
  const bad = ids.filter(id => !ID_RE.test(id))
  if (bad.length > 0) return fail('usage', `not a notification id: ${bad.join(', ')}`)
  const r = markNotificationsRead(all ? 'all' : ids)
  if (r.unknown.length > 0 && r.marked === 0 && !all) return fail('not_found', `no notification with the id ${r.unknown.join(', ')}`, { unread: r.unread })
  return ok({ ok: true, marked: r.marked, unread: r.unread, ...(r.unknown.length > 0 ? { unknown: r.unknown } : {}) }, [`Marked ${r.marked} read; ${r.unread} unread.`], r.unknown.length > 0 ? [`no notification with the id ${r.unknown.join(', ')}`] : [])
}
