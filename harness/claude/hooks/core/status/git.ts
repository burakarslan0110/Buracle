import type { GitState } from './model'

function trimSlashes(p: string): string {
  const s = p.replace(/\\/g, '/')
  return s.length > 1 ? s.replace(/\/+$/u, '') : s
}

function lastSegment(p: string): string {
  const parts = trimSlashes(p).split('/').filter(x => x !== '')
  return parts[parts.length - 1] ?? p
}

function int(s: string | undefined): number {
  const n = s === undefined ? Number.NaN : Number.parseInt(s, 10)
  return Number.isFinite(n) && n > 0 ? n : 0
}

// The lines added and removed in the working tree against HEAD, from `git diff HEAD --shortstat`
// (" 3 files changed, 12 insertions(+), 4 deletions(-)"); git leaves out a side that is zero.
export function linesFromShortstat(text: string): { added: number; removed: number } | undefined {
  const line = text.split('\n').map(l => l.trim()).find(l => /\bfiles? changed\b/u.test(l))
  if (line === undefined) return undefined
  return { added: int(/(\d+) insertions?\(\+\)/u.exec(line)?.[1]), removed: int(/(\d+) deletions?\(-\)/u.exec(line)?.[1]) }
}

// The git segment's " +N −M" (U+2212 minus), or nothing when the working tree has no line changes.
export function gitTreeLines(g: GitState): string {
  const l = g.lines
  return l !== undefined && l.added + l.removed > 0 ? ` +${l.added} −${l.removed}` : ''
}

export function gitFromPorcelainV2(text: string, gitDir?: string, commonDir?: string): GitState {
  const st: GitState = { ahead: 0, behind: 0, staged: 0, unstaged: 0, untracked: 0, stash: 0, conflicts: 0 }
  let oid: string | undefined
  let head: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line === '') continue
    if (line.startsWith('# ')) {
      const space = line.indexOf(' ', 2)
      const key = space < 0 ? line.slice(2) : line.slice(2, space)
      const value = space < 0 ? '' : line.slice(space + 1)
      if (key === 'branch.oid') oid = value
      else if (key === 'branch.head') head = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/u.exec(value.trim())
        if (m) { st.ahead = int(m[1]); st.behind = int(m[2]) }
      } else if (key === 'stash') st.stash = int(value.trim())
      continue
    }
    const kind = line[0]
    if ((kind === '1' || kind === '2') && line[1] === ' ') {
      const x = line[2]
      const y = line[3]
      if (x !== undefined && x !== '.') st.staged++
      if (y !== undefined && y !== '.') st.unstaged++
    } else if (kind === 'u' && line[1] === ' ') st.conflicts++
    else if (kind === '?' && line[1] === ' ') st.untracked++
  }
  if (head === '(detached)') {
    st.detached = true
    if (oid !== undefined && /^[0-9a-f]{7,}$/iu.test(oid)) st.branch = oid.slice(0, 7)
  } else if (head !== undefined && head !== '') st.branch = head
  if (gitDir !== undefined && commonDir !== undefined && gitDir !== '' && commonDir !== '' && trimSlashes(gitDir) !== trimSlashes(commonDir)) {
    st.worktree = lastSegment(gitDir)
  }
  return st
}
