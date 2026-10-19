import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { atomicWriteSync, realPath } from '../engine/fsx'
import { breakStaleLock, lockSnapshot, lockToken, releaseLockFile } from '../engine/lockfile'
import { run, type RunResult } from '../engine/proc'

export const GIT_TIMEOUT_MS = 120_000

const GIT_ENV = { LC_ALL: 'C', LANG: 'C', GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GIT_PAGER: 'cat' }

export interface GitResult extends RunResult { ok: boolean, out: string, err: string }

function timeout(): number {
  const raw = process.env['BURACLE_GIT_TIMEOUT_MS']
  return raw !== undefined && /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : GIT_TIMEOUT_MS
}

export async function git(cwd: string, args: string[], opts: { readOnly?: boolean, env?: Record<string, string> } = {}): Promise<GitResult> {
  const env: Record<string, string> = { ...GIT_ENV, ...(opts.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}), ...(opts.env ?? {}) }
  const r = await run(['git', ...args], { cwd, env, timeoutMs: timeout() })
  return { ...r, ok: r.code === 0, out: r.stdout.trim(), err: r.stderr.trim() }
}

export function gitError(r: GitResult): string {
  const lines = (r.err !== '' ? r.err : r.out).split('\n').map(l => l.trim()).filter(l => l !== '' && !/^hint:/.test(l))
  if (r.timedOut) return 'git timed out'
  return lines.slice(0, 4).join(' | ') || `git exited ${r.code}`
}

export function realish(p: string): string {
  const abs = resolve(p)
  try {
    return realPath(abs)
  } catch {
    const parent = dirname(abs)
    return parent === abs ? abs : join(realish(parent), basename(abs))
  }
}

export interface RepoFacts {
  top: string
  commonDir: string
  gitDir: string
  mainRoot: string
  linked: boolean
  branch?: string
  head?: string
}

export async function repoFacts(cwd: string): Promise<RepoFacts | undefined> {
  const r = await git(cwd, ['rev-parse', '--show-toplevel', '--git-common-dir', '--absolute-git-dir'], { readOnly: true })
  if (!r.ok) return undefined
  const [topRaw, commonRaw, gitDirRaw] = r.out.split('\n')
  if (topRaw === undefined || commonRaw === undefined || gitDirRaw === undefined || topRaw === '') return undefined
  const top = realish(topRaw)
  const commonDir = realish(isAbsolute(commonRaw) ? commonRaw : resolve(cwd, commonRaw))
  const gitDir = realish(gitDirRaw)
  const mainRoot = basename(commonDir) === '.git' ? dirname(commonDir) : top
  const facts: RepoFacts = { top, commonDir, gitDir, mainRoot, linked: gitDir !== commonDir }
  const br = await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], { readOnly: true })
  if (br.ok && br.out !== '') facts.branch = br.out
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], { readOnly: true })
  if (head.ok && head.out !== '') facts.head = head.out
  return facts
}

export async function refExists(cwd: string, ref: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { readOnly: true })).ok
}

export async function revCount(cwd: string, range: string): Promise<number | undefined> {
  const r = await git(cwd, ['rev-list', '--count', range], { readOnly: true })
  return r.ok && /^\d+$/.test(r.out) ? Number(r.out) : undefined
}

export async function mergeBase(cwd: string, a: string, b: string): Promise<string | undefined> {
  const r = await git(cwd, ['merge-base', a, b], { readOnly: true })
  return r.ok && r.out !== '' ? r.out : undefined
}

export interface PorcelainStatus { tracked: string[], untracked: string[], conflicted: string[] }

export async function porcelain(cwd: string): Promise<PorcelainStatus | undefined> {
  const r = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { readOnly: true })
  if (!r.ok) return undefined
  const out: PorcelainStatus = { tracked: [], untracked: [], conflicted: [] }
  const parts = r.stdout.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i] ?? ''
    if (e.length < 4) continue
    const xy = e.slice(0, 2)
    const path = e.slice(3)
    if (xy === '??') out.untracked.push(path)
    else if (xy === '!!') continue
    else {
      if (/U/.test(xy) || xy === 'AA' || xy === 'DD') out.conflicted.push(path)
      out.tracked.push(path)
      if (xy[0] === 'R' || xy[0] === 'C') i++
    }
  }
  return out
}

export interface WorktreeEntry { path: string, head?: string, branch?: string, detached: boolean, bare: boolean, locked: boolean, prunable: boolean }

export async function listWorktrees(cwd: string): Promise<WorktreeEntry[]> {
  const r = await git(cwd, ['worktree', 'list', '--porcelain'], { readOnly: true })
  if (!r.ok) return []
  const out: WorktreeEntry[] = []
  let cur: WorktreeEntry | undefined
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur)
      cur = { path: realish(line.slice(9)), detached: false, bare: false, locked: false, prunable: false }
    } else if (cur) {
      if (line.startsWith('HEAD ')) cur.head = line.slice(5)
      else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '')
      else if (line === 'detached') cur.detached = true
      else if (line === 'bare') cur.bare = true
      else if (line.startsWith('locked')) cur.locked = true
      else if (line.startsWith('prunable')) cur.prunable = true
    }
  }
  if (cur) out.push(cur)
  return out
}

export function operationInProgress(gitDir: string): string | undefined {
  const marks: Array<[string, string]> = [['MERGE_HEAD', 'a merge'], ['rebase-merge', 'a rebase'], ['rebase-apply', 'a rebase or am'], ['CHERRY_PICK_HEAD', 'a cherry-pick'], ['REVERT_HEAD', 'a revert'], ['BISECT_LOG', 'a bisect']]
  for (const [f, what] of marks) if (existsSync(join(gitDir, f))) return what
  return undefined
}

const BLOCK_START = '# >>> buracle (managed by the buracle CLI; edit outside this block)'
const BLOCK_END = '# <<< buracle'

export function excludeFile(commonDir: string): string {
  return join(commonDir, 'info', 'exclude')
}

function normPattern(p: string): string {
  return p.trim().replace(/^\//, '').replace(/\/$/, '')
}

export function updateExclude(commonDir: string, entries: readonly string[], dropManaged?: (line: string) => boolean): { path: string, added: string[], removed: string[] } {
  const path = excludeFile(commonDir)
  let text = ''
  try { text = readFileSync(path, 'utf8') } catch {  }
  const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
  let start = lines.indexOf(BLOCK_START)
  let end = start >= 0 ? lines.indexOf(BLOCK_END, start + 1) : -1
  if (start >= 0 && end < 0) { end = lines.length; lines.push(BLOCK_END) }
  const outside = lines.filter((_, i) => start < 0 || i < start || i > end)
  let managed = start >= 0 ? lines.slice(start + 1, end) : []
  const removed: string[] = []
  if (dropManaged) {
    managed = managed.filter(l => {
      if (l.trim() !== '' && !l.startsWith('#') && dropManaged(l) && !entries.some(e => normPattern(e) === normPattern(l))) { removed.push(l); return false }
      return true
    })
  }
  const present = new Set([...outside, ...managed].filter(l => !l.startsWith('#')).map(normPattern))
  const added: string[] = []
  for (const e of entries) {
    if (present.has(normPattern(e))) continue
    managed.push(e)
    present.add(normPattern(e))
    added.push(e)
  }
  if (added.length === 0 && removed.length === 0) return { path, added, removed }
  const before = start >= 0 ? lines.slice(0, start) : lines
  const after = start >= 0 ? lines.slice(end + 1) : []
  const block = managed.length > 0 ? [BLOCK_START, ...managed, BLOCK_END] : []
  const outLines = [...before, ...block, ...after]
  mkdirSync(dirname(path), { recursive: true })
  atomicWriteSync(path, outLines.join('\n') + '\n')
  return { path, added, removed }
}

export interface RepoLock { release(): void }

const STALE_MS = 30 * 60_000

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code === 'EPERM' }
}

function lockTimeout(): number {
  const raw = process.env['BURACLE_LOCK_TIMEOUT_MS']
  return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : 60_000
}

export async function acquireRepoLock(commonDir: string, what: string, timeoutMs = lockTimeout()): Promise<RepoLock> {
  const dir = join(commonDir, 'buracle')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'lock')
  const host = hostname()
  const start = Date.now()
  for (;;) {
    const text = JSON.stringify({ pid: process.pid, host, at: Date.now(), what, token: lockToken() }) + '\n'
    try {
      const fd = openSync(path, 'wx', 0o600)
      try { writeSync(fd, text) } finally { closeSync(fd) }
      let released = false
      return {
        release() {
          if (released) return
          released = true
          releaseLockFile(path, text)
        },
      }
    } catch (e) {
      if ((e as { code?: string }).code !== 'EEXIST') throw e
    }
    const seen = lockSnapshot(path)
    if (seen === undefined) continue
    let holder: { pid?: number, host?: string, at?: number, what?: string } = {}
    try { holder = JSON.parse(seen.text) as typeof holder } catch {  }
    const age = Date.now() - seen.mtimeMs
    const dead = typeof holder.pid === 'number' && holder.host === host && !pidAlive(holder.pid)
    if ((dead || age > STALE_MS) && breakStaleLock(path, seen) !== 'busy') continue
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`another buracle command holds the repository lock (${holder.what ?? 'unknown'}, pid ${holder.pid ?? '?'}, for ${Math.round(age / 1000)} s): ${path}`)
    }
    await Bun.sleep(100)
  }
}
