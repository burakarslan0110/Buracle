import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteSync, ensureDirSync, readJsonSafeSync } from '../engine/fsx'
import { isValidSlug } from './plan-file'
import { loadState, type ResolvedSession } from './session-store'
import { acquireRepoLock, git, gitError, mergeBase, porcelain, refExists, repoFacts, revCount, type RepoFacts } from './gitx'
import { fail, ok, type CmdResult, type WorkflowCtx } from './result'
import { PREFIXES, defaultBranches, metaForCheckout, type Prefix } from './worktree'

export interface BranchRecord {
  v: 1
  slug: string
  prefix: string
  branch: string
  base: string
  baseCommit: string
  createdAt: number
  planPath?: string
  assumed?: boolean
}

const MAX_SUFFIX = 50

function recordDir(commonDir: string): string { return join(commonDir, 'buracle', 'branches') }
function recordFile(commonDir: string, branch: string): string { return join(recordDir(commonDir), `${branch.replace(/\//g, '--')}.json`) }

export function branchRecords(commonDir: string): BranchRecord[] {
  let names: string[] = []
  try { names = readdirSync(recordDir(commonDir)).filter(n => n.endsWith('.json')).sort() } catch { return [] }
  const out: BranchRecord[] = []
  for (const n of names) {
    const r = readJsonSafeSync<BranchRecord>(join(recordDir(commonDir), n))
    const v = r.ok ? r.value : null
    if (v !== null && typeof v === 'object' && v.v === 1 && typeof v.branch === 'string' && typeof v.base === 'string' && typeof v.slug === 'string') out.push(v)
  }
  return out.sort((a, b) => b.createdAt - a.createdAt)
}

export function branchRecordFor(commonDir: string, branch: string): BranchRecord | undefined {
  return branchRecords(commonDir).find(r => r.branch === branch)
}

export function branchRecordForSlug(commonDir: string, slug: string): BranchRecord | undefined {
  return branchRecords(commonDir).find(r => r.slug === slug)
}

function writeRecord(commonDir: string, r: BranchRecord): void {
  ensureDirSync(recordDir(commonDir))
  atomicWriteSync(recordFile(commonDir, r.branch), JSON.stringify(r, null, 2) + '\n')
}

async function closestDefault(facts: RepoFacts): Promise<{ name: string, mb: string } | undefined> {
  let best: { name: string, mb: string, ahead: number } | undefined
  for (const name of await defaultBranches(facts.top)) {
    if (name === facts.branch) continue
    const mb = await mergeBase(facts.top, 'HEAD', name)
    if (mb === undefined) continue
    const ahead = await revCount(facts.top, `${mb}..HEAD`)
    if (ahead !== undefined && (best === undefined || ahead < best.ahead)) best = { name, mb, ahead }
  }
  return best
}

function result(r: BranchRecord, created: boolean, extra: Record<string, unknown>, lines: string[], warnings: string[] = []): CmdResult {
  return ok({ ok: true, created, slug: r.slug, branch: r.branch, base: r.base, baseCommit: r.baseCommit, ...extra }, lines, warnings)
}

export async function worktreeBranch(slugArg: string | undefined, o: { base?: string, prefix?: string }, ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<CmdResult> {
  if (slugArg === undefined) return fail('usage', 'missing <slug>')
  if (!isValidSlug(slugArg)) return fail('usage', `invalid slug '${slugArg}': use kebab-case ASCII (a-z, 0-9, '-'), at most 64 characters`)
  const slug = slugArg
  const prefix = (o.prefix ?? 'plan-build') as Prefix
  if (!PREFIXES.includes(prefix)) return fail('usage', `--prefix must be one of ${PREFIXES.join(', ')} (got '${o.prefix}')`)
  const facts = await repoFacts(ctx.cwd)
  if (facts === undefined) return fail('not_a_repo', `not a git repository: ${ctx.cwd}`)
  if (facts.head === undefined) return fail('no_commits', 'the repository has no commits yet; commit once before creating a branch')
  const inside = facts.linked ? metaForCheckout(facts) : undefined
  if (inside !== undefined) return fail('inside_worktree', `you are inside the Buracle worktree '${inside.slug}'; run this from the main checkout`)
  const baseArg = o.base?.trim()
  if (baseArg !== undefined && (baseArg === '' || baseArg.startsWith('-') || !await refExists(facts.top, baseArg))) {
    return fail('no_base', `--base '${o.base ?? ''}' is not a branch, tag or commit of this repository`)
  }
  let lock
  try {
    lock = await acquireRepoLock(facts.commonDir, `worktree branch ${slug}`)
  } catch (e) {
    return fail('locked', e instanceof Error ? e.message : String(e))
  }
  try {
    const planPath = s !== undefined ? loadState(s.harness, s.sessionId).plan?.path : undefined
    const mine = new RegExp(`^${prefix}/${slug}(?:-\\d+)?$`)
    const current = facts.branch !== undefined ? branchRecordFor(facts.commonDir, facts.branch) : undefined
    if (current !== undefined && current.slug === slug) {
      return result(current, false, { switched: false }, [`Already on ${current.branch} (created from ${current.base}).`])
    }
    if (current === undefined && facts.branch !== undefined && mine.test(facts.branch)) {
      const guess = baseArg !== undefined ? { name: baseArg, mb: (await git(facts.top, ['rev-parse', baseArg], { readOnly: true })).out } : await closestDefault(facts)
      const rec: BranchRecord = { v: 1, slug, prefix, branch: facts.branch, base: guess?.name ?? facts.head, baseCommit: guess?.mb ?? facts.head, createdAt: ctx.now, ...(planPath !== undefined ? { planPath } : {}), ...(baseArg === undefined ? { assumed: true } : {}) }
      writeRecord(facts.commonDir, rec)
      const warn = baseArg === undefined ? [`no record says where ${facts.branch} was created from; assuming ${rec.base}. Re-run with --base <ref> to correct it`] : []
      return result(rec, false, { switched: false, adopted: true }, [`Already on ${facts.branch}; recorded its base ${rec.base}.`], warn)
    }
    const own = planPath === undefined ? undefined : branchRecords(facts.commonDir).find(r => r.slug === slug && r.prefix === prefix && r.planPath === planPath)
    if (own !== undefined && baseArg === undefined && await refExists(facts.top, `refs/heads/${own.branch}`)) {
      const back = await git(facts.top, ['switch', own.branch])
      if (!back.ok) return fail('switch_failed', `nothing changed: git switch ${own.branch} failed: ${gitError(back)}; commit or stash your local changes first`)
      return result(own, false, { switched: true }, [`Switched back to ${own.branch}, this plan's branch (created from ${own.base}).`])
    }
    let name: string | undefined
    for (let n = 1; n <= MAX_SUFFIX && name === undefined; n++) {
      const candidate = n === 1 ? `${prefix}/${slug}` : `${prefix}/${slug}-${n}`
      if (!await refExists(facts.top, `refs/heads/${candidate}`)) name = candidate
    }
    if (name === undefined) return fail('branch_taken', `${prefix}/${slug} and ${prefix}/${slug}-2 to -${MAX_SUFFIX} all exist; pick another slug`)
    const base = baseArg ?? facts.branch ?? facts.head
    const baseCommit = (await git(facts.top, ['rev-parse', `${baseArg ?? 'HEAD'}^{commit}`], { readOnly: true })).out
    const local = await porcelain(facts.top)
    const carried = (local?.tracked.length ?? 0) + (local?.untracked.length ?? 0)
    const sw = await git(facts.top, baseArg !== undefined ? ['switch', '-c', name, baseArg] : ['switch', '-c', name])
    if (!sw.ok) return fail('switch_failed', `nothing changed: git switch -c ${name}${baseArg !== undefined ? ` ${baseArg}` : ''} failed: ${gitError(sw)}${carried > 0 ? '; commit or stash your local changes first, or leave out --base so the branch starts from HEAD' : ''}`)
    const rec: BranchRecord = { v: 1, slug, prefix, branch: name, base, baseCommit, createdAt: ctx.now, ...(planPath !== undefined ? { planPath } : {}) }
    writeRecord(facts.commonDir, rec)
    const warnings = name !== `${prefix}/${slug}` ? [`${prefix}/${slug} already exists; created ${name} instead`] : []
    const lines = [`Created and switched to ${name} from ${base}${carried > 0 ? `; ${carried} uncommitted change(s) came along` : ''}.`]
    return result(rec, true, { switched: true, carried }, lines, warnings)
  } finally {
    lock.release()
  }
}
