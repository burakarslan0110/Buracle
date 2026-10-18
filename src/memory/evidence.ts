import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { MemItem } from '../core/memory/brain'
import { redact } from '../core/memory/text'
import { evidenceTargets, excerptWindows, type VerifyExcerpt } from '../core/memory/verify'
import { sha256 } from '../engine/fsx'
import { run as runProc } from '../engine/proc'

const MAX_FILE_BYTES = 512 * 1024

export async function git(root: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean, out: string }> {
  const r = await runProc(['git', ...args], { cwd: root, timeoutMs, env: { LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' } })
  return { ok: r.code === 0, out: r.stdout }
}

export async function headOf(root: string): Promise<{ full: string, short: string } | undefined> {
  const full = await git(root, ['rev-parse', 'HEAD'], 5000)
  const short = await git(root, ['rev-parse', '--short', 'HEAD'], 5000)
  const f = full.out.trim()
  const s = short.out.trim()
  return full.ok && short.ok && /^[0-9a-f]{40}$/.test(f) && /^[0-9a-f]{4,40}$/.test(s) ? { full: f, short: s } : undefined
}

function fileBytes(root: string, path: string, known: ReadonlySet<string>): Buffer | undefined {
  if (!known.has(path)) return undefined
  try {
    const file = join(root, path)
    if (statSync(file).size > MAX_FILE_BYTES) return undefined
    const bytes = readFileSync(file)
    return bytes.includes(0) ? undefined : bytes
  } catch {
    return undefined
  }
}

export function fileAt(root: string, path: string, known: ReadonlySet<string>): string[] | undefined {
  return fileBytes(root, path, known)?.toString('utf8').split('\n')
}

export function keyOf(root: string, item: MemItem, known: ReadonlySet<string>): string {
  const parts: string[] = []
  for (const f of evidenceTargets(item).files) {
    const bytes = fileBytes(root, f.path, known)
    parts.push(`${f.path}:${bytes === undefined ? '-' : sha256(bytes).slice(0, 16)}`)
  }
  return parts.sort().join('|')
}

export async function trackedFiles(root: string): Promise<Set<string>> {
  return new Set((await git(root, ['ls-files', '-z'], 15_000)).out.split('\u0000').filter(Boolean))
}

export async function knownFiles(root: string): Promise<Set<string>> {
  return new Set((await git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], 15_000)).out.split('\u0000').filter(Boolean))
}

export async function dirtyFiles(root: string): Promise<Set<string>> {
  const r = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], 15_000)
  if (!r.ok) return new Set()
  const out = new Set<string>()
  for (const entry of r.out.split('\u0000')) if (entry.length > 3) out.add(entry.slice(3))
  return out
}

export async function excerptsFor(root: string, item: MemItem, known: ReadonlySet<string>): Promise<VerifyExcerpt[]> {
  const targets = evidenceTargets(item)
  const out: VerifyExcerpt[] = []
  const add = (file: string, lines: readonly string[], line?: number) => {
    for (const w of excerptWindows(lines, { ...(line !== undefined ? { line } : {}), terms: targets.terms })) {
      out.push({ file, start: w.start, text: redact(lines.slice(w.start - 1, w.end).join('\n')).text })
    }
  }
  for (const f of targets.files.slice(0, 6)) {
    const lines = fileAt(root, f.path, known)
    if (lines !== undefined) add(f.path, lines, f.line)
  }
  if (targets.files.length === 0 && targets.terms.length > 0) {
    const hits = new Map<string, number>()
    for (const term of targets.terms.slice(0, 6)) {
      const r = await git(root, ['grep', '-n', '-I', '-F', '--untracked', '--max-count', '2', '-e', term, '--'])
      for (const l of r.out.split('\n')) {
        const m = /^(.+?):(\d+):/.exec(l)
        if (m === null || hits.has(m[1] as string)) continue
        hits.set(m[1] as string, Number(m[2]))
        if (hits.size >= 5) break
      }
      if (hits.size >= 5) break
    }
    for (const [path, line] of hits) {
      const lines = fileAt(root, path, known)
      if (lines !== undefined) add(path, lines, line)
    }
  }
  return out.slice(0, 8)
}

export function fitExcerpts(excerpts: readonly VerifyExcerpt[], budget: number): VerifyExcerpt[] {
  const out: VerifyExcerpt[] = []
  let used = 0
  for (const e of excerpts) {
    const lines = e.text.split('\n')
    const cost = (l: string) => l.length + 8
    const total = lines.reduce((n, l) => n + cost(l), 80)
    if (used + total <= budget) { out.push(e); used += total; continue }
    const kept: string[] = []
    let n = used + 80
    for (const l of lines) { if (n + cost(l) > budget) break; kept.push(l); n += cost(l) }
    if (kept.length > 0) out.push({ ...e, text: kept.join('\n') })
    break
  }
  return out
}
