import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { Harness } from '../core/events'
import type { MemItem } from '../core/memory/brain'
import { memIsSlug } from '../core/memory/note'
import { VERIFY_SETTLED_TRIES } from '../core/memory/verify'
import { keyOf } from './evidence'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import { appendJob } from './jobs'
import { verifyLockFile, verifyStateFile } from './layout'
import { lockHeld } from './lock'
import { projectRoot } from './project'
import { spawnCli } from './spawn'
import { readUpkeep } from './upkeep-file'

export const NO_VERIFY_ENV = 'BURACLE_NO_VERIFY'

export const VERIFY_REASONS: readonly string[] = ['source-changed', 'unverified', 'stale']

const STATE_KEEP_MS = 30 * 86_400_000

export interface VerifyBackoffState { v: 1, backoff: Record<string, { at: string, key: string, head?: string, tries?: number, until?: string }> }

export function settledIds(items: readonly MemItem[], repo?: { root: string, known: ReadonlySet<string> }): Set<string> {
  const out = new Set<string>()
  const byId = new Map(items.map(i => [i.id, i]))
  for (const [id, e] of Object.entries(readVerifyState().backoff)) {
    if ((e.tries ?? 0) < VERIFY_SETTLED_TRIES) continue
    const i = byId.get(id)
    if (i === undefined || (i.updated || i.created) > e.at) continue
    if (repo !== undefined && keyOf(repo.root, i, repo.known) !== e.key) continue
    out.add(id)
  }
  return out
}

export function headShaSync(root: string): string | undefined {
  try {
    let gitDir = join(root, '.git')
    const st = statSync(gitDir)
    if (st.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(gitDir, 'utf8'))
      if (m === null) return undefined
      gitDir = isAbsolute(m[1] as string) ? (m[1] as string).trim() : join(root, (m[1] as string).trim())
    }
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    const ref = /^ref:\s*(.+)$/.exec(head)
    if (ref === null) return /^[0-9a-f]{40}$/.test(head) ? head : undefined
    const name = (ref[1] as string).trim()
    try { return readFileSync(join(gitDir, name), 'utf8').trim() } catch {  }
    const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
    const line = packed.split('\n').find(l => l.endsWith(` ${name}`))
    return line?.slice(0, 40)
  } catch {
    return undefined
  }
}

export function readVerifyState(): VerifyBackoffState {
  const r = readJsonSafeSync<VerifyBackoffState>(verifyStateFile())
  return r.ok && r.value !== null && typeof r.value === 'object' && r.value.v === 1 && typeof r.value.backoff === 'object' ? r.value : { v: 1, backoff: {} }
}

export function writeVerifyState(s: VerifyBackoffState, nowMs: number): void {
  for (const [k, e] of Object.entries(s.backoff)) if (nowMs - Date.parse(e.at) > STATE_KEEP_MS) delete s.backoff[k]
  try { atomicWriteSync(verifyStateFile(), JSON.stringify(s) + '\n', { mode: 0o600 }) } catch (e) { log('warn', 'memory: the verifier state was not written', { error: e }) }
}

export function verifiableCount(slug: string, nowMs: number = Date.now()): number {
  const backoff = readVerifyState().backoff
  let head: string | undefined | null = null
  const headNow = (): string | undefined => {
    if (head === null) { const root = projectRoot(slug); head = root !== undefined ? headShaSync(root) : undefined }
    return head
  }
  return (readUpkeep(slug)?.items ?? []).filter(i => {
    if (!i.reasons.some(r => VERIFY_REASONS.includes(r)) || i.reasons.some(r => (r as string) === 'contradicted')) return false
    if (i.quiet === true) return false
    const b = backoff[i.id]
    if (b === undefined || (b.tries ?? 0) >= VERIFY_SETTLED_TRIES) return true
    const until = b.until !== undefined ? Date.parse(b.until) : Number.NaN
    if (!Number.isFinite(until) || nowMs >= until) return true
    return b.head !== undefined && headNow() !== undefined && headNow() !== b.head
  }).length
}

export function maybeStartVerify(opts: { slug: string, nowMs: number, trigger: 'session-end' | 'heal' | 'session-start' | 'tick', harness?: Harness, sid?: string }): boolean {
  if (process.env['BURACLE_NO_AUTOSTART'] === '1' || process.env[NO_VERIFY_ENV] === '1' || !memIsSlug(opts.slug)) return false
  const scope = { project: opts.slug, ...(opts.harness !== undefined ? { harness: opts.harness } : {}), ...(opts.sid !== undefined ? { sid: opts.sid } : {}) }
  try {
    const waiting = verifiableCount(opts.slug, opts.nowMs)
    if (waiting === 0) return false
    if (lockHeld(verifyLockFile(opts.slug), 10 * 60_000, opts.nowMs)) return false
    const pid = spawnCli(['mem', 'verify', '--quiet', '--trigger', opts.trigger, '--project', opts.slug, ...(opts.harness !== undefined ? ['--harness', opts.harness] : []), ...(opts.sid !== undefined ? ['--session', opts.sid] : [])])
    appendJob(pid !== undefined
      ? { job: 'verify', trigger: opts.trigger, outcome: 'ran', reason: 'started', detail: `${waiting} waiting; started in the background`, ...scope }
      : { job: 'verify', trigger: opts.trigger, outcome: 'failed', reason: 'not-started', detail: `${waiting} waiting, but the background job did not start`, ...scope }, opts.nowMs)
    return pid !== undefined
  } catch (e) {
    log('warn', 'memory: cannot start the verifier', { slug: opts.slug, error: e })
    return false
  }
}
