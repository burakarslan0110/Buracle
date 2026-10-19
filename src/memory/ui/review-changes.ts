import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'
import { reviewDocOf } from '../../core/plan/notes'
import { credentialLocation } from '../../core/policy/write-guard'
import * as paths from '../../engine/paths'
import { git, mergeBase, porcelain } from '../../workflow/gitx'
import { resolveReviewScope, type ReviewScope } from '../../workflow/review-scope'
import { UiApiError } from './api'
import { checkoutNotes, findCheckout } from './review'

const FILES_MAX = 300
const FILE_LINES_MAX = 4000
const PATCH_BYTES_MAX = 3 * 1024 * 1024
const UNTRACKED_MAX = 100
const UNTRACKED_BYTES_MAX = 256 * 1024

export type ChangeStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked'

export const HIDDEN_REASONS = ['secret', 'large', 'binary', 'limit', 'symlink', 'unreadable'] as const

type Hidden = typeof HIDDEN_REASONS[number]

export interface ChangedFile {
  path: string
  old?: string
  status: ChangeStatus
  add: number
  del: number
  hidden?: Hidden
  patch?: string
}

interface NumStat { path: string, old?: string, add: number, del: number, binary: boolean }

function numstat(raw: string): NumStat[] {
  const out: NumStat[] = []
  const parts = raw.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i] ?? ''
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/su.exec(rec)
    if (m === null) continue
    const binary = m[1] === '-' || m[2] === '-'
    const add = binary ? 0 : Number(m[1])
    const del = binary ? 0 : Number(m[2])
    if (m[3] === '') {
      const old = parts[++i] ?? ''
      const path = parts[++i] ?? ''
      out.push({ path, old, add, del, binary })
    } else out.push({ path: m[3] as string, add, del, binary })
  }
  return out
}

function chunks(patch: string): string[] {
  const out: string[] = []
  let cur: string[] | undefined
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (cur !== undefined) out.push(cur.join('\n'))
      cur = [line]
    } else if (cur !== undefined) cur.push(line)
  }
  if (cur !== undefined) out.push(cur.join('\n'))
  return out
}

function hunksOnly(chunk: string): string {
  const i = chunk.indexOf('\n@@')
  return i < 0 ? '' : chunk.slice(i + 1).replace(/\n$/, '')
}

function statusOf(chunk: string, n: NumStat): ChangeStatus {
  if (n.old !== undefined && n.old !== n.path) return 'renamed'
  if (/\nnew file mode /.test(chunk)) return 'added'
  if (/\ndeleted file mode /.test(chunk)) return 'deleted'
  return 'modified'
}

const CREDENTIAL_NAMES = /^(?:\.npmrc|\.netrc|_netrc|\.pypirc|\.git-credentials|\.htpasswd|\.pgpass|kubeconfig(?:\.ya?ml)?|.+\.kubeconfig|.+\.tfvars(?:\.json)?|.+\.tfstate(?:\.backup)?|.+\.env|secrets?\.(?:json|ya?ml|toml|ini|conf|cfg|txt|xml|properties)|service[-_]?account.*\.json)$/i
const CREDENTIAL_PATHS = /(?:^|\/)(?:\.docker\/config\.json|\.kube\/config)$/i

function secret(rel: string, cwd: string): boolean {
  if (CREDENTIAL_NAMES.test(rel.slice(rel.lastIndexOf('/') + 1)) || CREDENTIAL_PATHS.test(rel)) return true
  return credentialLocation(rel, { cwd, home: paths.home() }) !== undefined
}

async function diffBase(cwd: string, scope: ReviewScope): Promise<string> {
  if (scope.mode === 'working-tree') return scope.diff_range
  return (await mergeBase(cwd, scope.base_ref, 'HEAD')) ?? scope.base_ref
}

function readText(file: string): { text: string } | { hidden: Hidden } {
  try {
    const l = lstatSync(file)
    if (l.isSymbolicLink()) return { hidden: 'symlink' }
    if (!l.isFile()) return { hidden: 'unreadable' }
    if (l.size > UNTRACKED_BYTES_MAX) return { hidden: 'large' }
    const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const s = fstatSync(fd)
      if (!s.isFile()) return { hidden: 'unreadable' }
      if (s.size > UNTRACKED_BYTES_MAX) return { hidden: 'large' }
      const buf = Buffer.alloc(s.size)
      const n = readSync(fd, buf, 0, s.size, 0)
      if (buf.subarray(0, n).includes(0)) return { hidden: 'binary' }
      return { text: buf.subarray(0, n).toString('utf8') }
    } finally { closeSync(fd) }
  } catch { return { hidden: 'unreadable' } }
}

async function untrackedFiles(cwd: string): Promise<ChangedFile[]> {
  const st = await porcelain(cwd)
  const out: ChangedFile[] = []
  for (const rel of (st?.untracked ?? []).filter(p => reviewDocOf(p) === undefined)) {
    if (out.length >= UNTRACKED_MAX) { out.push({ path: rel, status: 'untracked', add: 0, del: 0, hidden: 'limit' }); continue }
    if (secret(rel, cwd)) { out.push({ path: rel, status: 'untracked', add: 0, del: 0, hidden: 'secret' }); continue }
    const read = readText(join(cwd, rel))
    if ('hidden' in read) { out.push({ path: rel, status: 'untracked', add: 0, del: 0, hidden: read.hidden }); continue }
    const text = read.text
    const lines = text.replace(/\n$/, '').split('\n')
    if (text === '') { out.push({ path: rel, status: 'untracked', add: 0, del: 0, patch: '' }); continue }
    if (lines.length > FILE_LINES_MAX) { out.push({ path: rel, status: 'untracked', add: lines.length, del: 0, hidden: 'large' }); continue }
    out.push({ path: rel, status: 'untracked', add: lines.length, del: 0, patch: `@@ -0,0 +1,${lines.length} @@\n${lines.map(l => `+${l}`).join('\n')}` })
  }
  return out
}

function pageText(text: string | undefined, drop: (part: string) => boolean): string | undefined {
  if (text === undefined) return undefined
  const parts = text.split('; ').filter(p => !drop(p))
  return parts.length > 0 ? parts.join('; ') : undefined
}

function pageWarning(scope: ReviewScope): string | undefined {
  return pageText(scope.warning, w => scope.mode === 'worktree' && w.includes('uncommitted change(s) in the worktree'))
}

function pageNote(scope: ReviewScope): string | undefined {
  return pageText(scope.note, n => n.startsWith('untracked files are not in git diff'))
}

export async function reviewChanges(id: string | null, nowMs: number): Promise<Record<string, unknown>> {
  const { checkout, facts } = await findCheckout(id, nowMs)
  const cwd = checkout.path
  const r = await resolveReviewScope(undefined, cwd, undefined)
  if ('error' in r) throw new UiApiError(409, r.error, r.message)
  const scope = r.scope
  const base = await diffBase(cwd, scope)
  const opts = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '-M']
  const ns = await git(cwd, [...opts, '--numstat', '-z', base], { readOnly: true })
  if (!ns.ok) throw new UiApiError(409, 'diff_failed', `git diff failed: ${ns.err.split('\n')[0] ?? ''}`)
  const stats = numstat(ns.stdout).filter(n => reviewDocOf(n.path) === undefined)
  const files: ChangedFile[] = []
  const wanted: NumStat[] = []
  for (const n of stats) {
    const f: ChangedFile = { path: n.path, ...(n.old !== undefined && n.old !== n.path ? { old: n.old } : {}), status: n.old !== undefined && n.old !== n.path ? 'renamed' : 'modified', add: n.add, del: n.del }
    if (files.length >= FILES_MAX) f.hidden = 'limit'
    else if (secret(n.path, cwd) || (n.old !== undefined && secret(n.old, cwd))) f.hidden = 'secret'
    else if (n.binary) f.hidden = 'binary'
    else if (n.add + n.del > FILE_LINES_MAX) f.hidden = 'large'
    else wanted.push(n)
    files.push(f)
  }
  let budget = PATCH_BYTES_MAX
  if (wanted.length > 0) {
    const pd = await git(cwd, [...opts, '-U3', base, '--', ...new Set(wanted.flatMap(n => (n.old !== undefined ? [n.old, n.path] : [n.path])))], { readOnly: true })
    if (!pd.ok) throw new UiApiError(409, 'diff_failed', `git diff failed: ${pd.err.split('\n')[0] ?? ''}`)
    const byFile = new Map<string, string>()
    for (const c of chunks(pd.stdout)) {
      const head = c.slice(0, c.indexOf('\n') < 0 ? c.length : c.indexOf('\n'))
      const hit = wanted.find(n => !byFile.has(n.path) && head.endsWith(` b/${n.path}`))
      if (hit !== undefined) byFile.set(hit.path, c)
    }
    for (const f of files) {
      const c = byFile.get(f.path)
      if (c === undefined || f.hidden !== undefined) continue
      const n = wanted.find(x => x.path === f.path) as NumStat
      f.status = statusOf(c, n)
      const body = hunksOnly(c)
      if (body.length > budget) { f.hidden = 'large'; continue }
      budget -= body.length
      f.patch = body
    }
  }
  if (scope.mode === 'working-tree' || scope.mode === 'worktree') files.push(...await untrackedFiles(cwd))
  return {
    checkout: { ...checkout },
    scope: {
      mode: scope.mode, base: scope.base_branch ?? scope.base_ref, base_ref: base, ...(scope.branch !== undefined ? { branch: scope.branch } : {}),
      ...(pageWarning(scope) !== undefined ? { warning: pageWarning(scope) } : {}), ...(pageNote(scope) !== undefined ? { note: pageNote(scope) } : {}),
    },
    files,
    ...checkoutNotes(checkout, facts),
  }
}
