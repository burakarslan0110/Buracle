import { opsDeps } from './deps'

const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }

export type GitUpstreamStatus =
  | { kind: 'no-repo' }
  | { kind: 'no-upstream' }
  | { kind: 'error', error: string }
  | { kind: 'ok', ahead: number, behind: number, head: string, upstream: string, upstreamName: string, dirty: boolean }

async function git(dir: string, args: string[], timeoutMs = 30_000): Promise<{ code: number, out: string, err: string }> {
  const r = await opsDeps.run(['git', '-C', dir, ...args], { timeoutMs, env: GIT_ENV })
  return { code: r.code, out: r.stdout.trim(), err: r.stderr.trim() }
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? ''
}

export async function upstreamStatus(dir: string, opts: { fetch: boolean }): Promise<GitUpstreamStatus> {
  const inside = await git(dir, ['rev-parse', '--is-inside-work-tree'], 10_000)
  if (inside.code !== 0 || inside.out !== 'true') return { kind: 'no-repo' }
  const up = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], 10_000)
  if (up.code !== 0 || up.out === '') return { kind: 'no-upstream' }
  if (opts.fetch) {
    const f = await git(dir, ['fetch', '--quiet', '--prune'], 120_000)
    if (f.code !== 0) return { kind: 'error', error: `git fetch failed: ${firstLine(f.err) || `exit ${f.code}`}` }
  }
  const counts = await git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}'], 10_000)
  const m = /^(\d+)\s+(\d+)$/.exec(counts.out)
  if (counts.code !== 0 || !m) return { kind: 'error', error: `cannot compare with ${up.out}: ${firstLine(counts.err) || counts.out}` }
  const head = await git(dir, ['rev-parse', '--short', 'HEAD'], 10_000)
  const upstream = await git(dir, ['rev-parse', '--short', '@{u}'], 10_000)
  const dirty = await git(dir, ['status', '--porcelain', '--untracked-files=no'], 10_000)
  return { kind: 'ok', ahead: Number(m[1]), behind: Number(m[2]), head: head.out, upstream: upstream.out, upstreamName: up.out, dirty: dirty.out !== '' }
}

export async function fastForward(dir: string): Promise<{ ok: true, from: string, to: string } | { ok: false, error: string }> {
  const before = await git(dir, ['rev-parse', '--short', 'HEAD'], 10_000)
  const r = await git(dir, ['merge', '--ff-only', '@{u}'], 120_000)
  if (r.code !== 0) return { ok: false, error: `git merge --ff-only failed: ${firstLine(r.err) || firstLine(r.out) || `exit ${r.code}`}` }
  const after = await git(dir, ['rev-parse', '--short', 'HEAD'], 10_000)
  return { ok: true, from: before.out, to: after.out }
}

export async function clone(url: string, dir: string, ref?: string): Promise<{ ok: true } | { ok: false, error: string }> {
  const argv = ['git', 'clone', '--quiet', ...(ref !== undefined ? ['--branch', ref] : []), url, dir]
  const r = await opsDeps.run(argv, { timeoutMs: 300_000, env: GIT_ENV })
  return r.code === 0 ? { ok: true } : { ok: false, error: `git clone failed: ${firstLine(r.stderr.trim()) || `exit ${r.code}`}` }
}

export async function remoteHead(dir: string, ref: string): Promise<string | undefined> {
  const r = await git(dir, ['ls-remote', 'origin', ref], 60_000)
  if (r.code !== 0) return undefined
  return /^([0-9a-f]{7,64})\s/m.exec(r.out)?.[1]
}

export async function headCommit(dir: string): Promise<string | undefined> {
  const r = await git(dir, ['rev-parse', 'HEAD'], 10_000)
  return r.code === 0 && /^[0-9a-f]{7,64}$/.test(r.out) ? r.out : undefined
}

export async function isClean(dir: string): Promise<boolean | undefined> {
  const r = await git(dir, ['status', '--porcelain', '--untracked-files=no'], 10_000)
  return r.code === 0 ? r.out === '' : undefined
}

export async function changedPaths(dir: string, from: string, to: string, files: readonly string[]): Promise<string[] | undefined> {
  const r = await git(dir, ['diff', '--name-only', from, to, '--', ...files], 10_000)
  return r.code === 0 ? r.out.split('\n').filter(l => l !== '') : undefined
}

export async function resetKeep(dir: string, commit: string): Promise<{ ok: true } | { ok: false, error: string }> {
  const r = await git(dir, ['reset', '--keep', commit], 60_000)
  return r.code === 0 ? { ok: true } : { ok: false, error: `git reset --keep failed: ${firstLine(r.err) || firstLine(r.out) || `exit ${r.code}`}` }
}
