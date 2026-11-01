import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmdirSync, rmSync, unlinkSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import type { Adapter, AdapterContext } from '../../adapters/registry'
import type { Harness } from '../../core/events'
import { readJsonSafeSync } from '../fsx'
import * as paths from '../paths'
import { historyCreatedDirs, listTxns, markExecsUndone, repointPathsMissing, undoKeptOnPurpose, type Journal, type Ledger, type LedgerEntry, type Op, type Plan } from '../txn'
import { isHarnessBusy } from './compose'
import { inCheckout } from './context'
import { opsDeps } from './deps'
import { AGENTS_SKILLS_OWNER, buracleHomeOwned, buracleHomeProblem, CORE_OWNER, HOME_MARKER, keyPath, pathRulesDir, type InstallRecord } from './install-core'
import { errText, isInside } from './output'

export interface ExecUndo { argv: string[]; undo: string[]; txn: string; owner?: string }

export const UNINSTALL_PLAN_PREFIX = 'uninstall-'

export interface UninstallGroup { owner: string; content: Plan; whole: Plan }

export interface UninstallPlan {
  groups: UninstallGroup[]
  adopted: LedgerEntry[]
  protected: string[]
  execs: ExecUndo[]
  obsolete: Array<{ undo: ExecUndo, reason: string }>
}

export interface ComposeUninstallOptions {
  skipKeys?: ReadonlySet<string>
  skipUndos?: ReadonlySet<string>
  skipOwners?: ReadonlySet<string>
}

const CORE_OWNERS: ReadonlySet<string> = new Set([CORE_OWNER, AGENTS_SKILLS_OWNER])

function seededSetting(key: string, e: LedgerEntry): boolean {
  if (resolve(keyPath(key)) !== resolve(paths.userConfigFile())) return false
  return e.kind === 'yaml' && e.pointer !== undefined && e.pointer !== 'repo'
}

export function composeUninstall(ledger: Ledger, journals: readonly Journal[], record: InstallRecord, vault: string, opts: ComposeUninstallOptions = {}): UninstallPlan {
  const byOwner = new Map<string, { cleanup: Op[], content: Op[], links: Op[], files: Op[] }>()
  const adopted: LedgerEntry[] = []
  const prot: string[] = []
  for (const key of Object.keys(ledger).sort()) {
    const e = ledger[key] as LedgerEntry
    const file = resolve(keyPath(key))
    if (isInside(file, vault)) { prot.push(key); continue }
    if (opts.skipOwners?.has(e.owner)) continue
    if (e.adopted === true) adopted.push(e)
    if (opts.skipKeys?.has(key)) continue
    const g = byOwner.get(e.owner) ?? { cleanup: [], content: [], links: [], files: [] }
    byOwner.set(e.owner, g)
    const op: Op = seededSetting(key, e) ? { kind: 'remove', path: key, owner: e.owner, forget: true } : { kind: 'remove', path: key, owner: e.owner }
    if (e.kind === 'cleanup') g.cleanup.push(op)
    else if (key.includes('#')) g.content.push(op)
    else (e.kind === 'symlink' ? g.links : g.files).push(op)
  }
  const owners = [...byOwner.keys()].sort((a, b) => Number(CORE_OWNERS.has(a)) - Number(CORE_OWNERS.has(b)) || (a < b ? -1 : a > b ? 1 : 0))
  const groups: UninstallGroup[] = owners.map(owner => {
    const g = byOwner.get(owner) as { cleanup: Op[], content: Op[], links: Op[], files: Op[] }
    return {
      owner,
      content: { id: `${UNINSTALL_PLAN_PREFIX}${owner}-content`, harness: harnessOf(owner), ops: [...g.cleanup, ...g.content] },
      whole: { id: `${UNINSTALL_PLAN_PREFIX}${owner}-files`, harness: harnessOf(owner), ops: [...g.links, ...g.files] },
    }
  })
  const all = execUndos(journals, record).filter(u => !opts.skipUndos?.has(undoKey(u.undo)) && !(u.owner !== undefined && opts.skipOwners?.has(u.owner)))
  const { run, obsolete } = sortOutUndos(all)
  return { groups, adopted, protected: prot, execs: run, obsolete }
}

function harnessOf(owner: string): Plan['harness'] {
  return owner === 'claude' || owner === 'codex' || owner === 'opencode' || owner === 'omp' ? owner : 'core'
}

export function isUninstallJournal(j: Journal): boolean {
  return Array.isArray(j.plans) && j.plans.length > 0 && j.plans.every(p => typeof p?.id === 'string' && p.id.startsWith(UNINSTALL_PLAN_PREFIX))
}

export function execUndos(journals: readonly Journal[], record: InstallRecord): ExecUndo[] {
  const sorted = [...journals].sort((a, b) => (a.txn < b.txn ? 1 : a.txn > b.txn ? -1 : 0))
  const seen = new Set<string>()
  const out: ExecUndo[] = []
  for (const j of sorted) {
    if (j.status !== 'committed' && j.status !== 'rollback-failed') continue
    if (isUninstallJournal(j)) continue
    const execs = Array.isArray(j.execs) ? j.execs : []
    const onlyHarness = Array.isArray(j.plans) && j.plans.length === 1 ? j.plans[0]?.harness : undefined
    for (let i = execs.length - 1; i >= 0; i--) {
      const ex = execs[i]
      if (!ex || ex.ran !== true || !Array.isArray(ex.argv)) continue
      const key = JSON.stringify(ex.argv)
      if (seen.has(key)) continue
      seen.add(key)
      if (ex.undone === true || !Array.isArray(ex.undo) || ex.undo.length === 0) continue
      const done = record.execUndone[key]
      if (done !== undefined && done >= j.txn) continue
      const u: ExecUndo = { argv: [...ex.argv], undo: [...ex.undo], txn: j.txn }
      const owner = (ex as { owner?: unknown }).owner
      if (typeof owner === 'string') u.owner = owner
      else if (typeof onlyHarness === 'string' && onlyHarness !== 'core') u.owner = onlyHarness
      out.push(u)
    }
  }
  return out
}

export function sortOutUndos(undos: readonly ExecUndo[]): { run: ExecUndo[], obsolete: Array<{ undo: ExecUndo, reason: string }> } {
  const run: ExecUndo[] = []
  const obsolete: Array<{ undo: ExecUndo, reason: string }> = []
  undos.forEach((u, i) => {
    const later = undos.slice(i + 1)
    if (later.some(o => undoKey(o.argv) === undoKey(u.undo))) {
      obsolete.push({ undo: u, reason: `superseded: an older undo removes what \`${u.undo.join(' ')}\` would put back` })
      return
    }
    const missing = repointPathsMissing(u.argv, u.undo)
    if (missing.length > 0) {
      obsolete.push({ undo: u, reason: `${missing.join(', ')} no longer exist${missing.length === 1 ? 's' : ''}; nothing to put back` })
      return
    }
    run.push(u)
  })
  return { run, obsolete }
}

export async function journalsForUninstall(): Promise<Journal[]> {
  return listTxns()
}

export interface AdapterUninstall { harness: Harness; plan: Plan }

export function installedFor(h: Harness, ledger: Ledger, journals: readonly Journal[], record: InstallRecord): boolean {
  if (Object.values(ledger).some(e => e.owner === h)) return true
  if (record.plans[h] !== undefined) return true
  return journals.some(j => (j.status === 'committed' || j.status === 'rollback-failed') && !isUninstallJournal(j)
    && (j.plans ?? []).some(p => p.harness === h) && (j.execs ?? []).some(e => e.ran === true && e.undone !== true))
}

export async function adapterUninstallPlans(adapters: readonly Adapter[], ctx: AdapterContext, ledger: Ledger, journals: readonly Journal[], record: InstallRecord): Promise<{ plans: AdapterUninstall[], errors: Array<{ source: string, error: string }>, busy: Array<{ harness: Harness, message: string }> }> {
  const plans: AdapterUninstall[] = []
  const errors: Array<{ source: string, error: string }> = []
  const busy: Array<{ harness: Harness, message: string }> = []
  for (const a of adapters) {
    if (typeof a.uninstallPlan !== 'function' || !installedFor(a.harness, ledger, journals, record)) continue
    try {
      const plan = a.uninstallPlan.bind(a)
      const p: unknown = await inCheckout(ctx.repoRoot, () => plan(ctx))
      if (p === null || typeof p !== 'object' || !Array.isArray((p as Plan).ops)) throw new Error('uninstallPlan() did not return a plan')
      const ops = [...(p as Plan).ops]
      if (ops.length > 0) plans.push({ harness: a.harness, plan: { id: `${UNINSTALL_PLAN_PREFIX}${a.harness}`, harness: a.harness, ops } })
    } catch (e) {
      if (isHarnessBusy(e)) busy.push({ harness: a.harness, message: errText(e) })
      else errors.push({ source: a.harness, error: errText(e) })
    }
  }
  return { plans, errors, busy }
}

export function removedKeys(plans: readonly AdapterUninstall[]): Set<string> {
  return new Set(plans.flatMap(p => p.plan.ops.filter(op => op.kind === 'remove').map(op => (op as Extract<Op, { kind: 'remove' }>).path)))
}

export function undoKey(argv: readonly string[]): string {
  return JSON.stringify([basename(argv[0] ?? ''), ...argv.slice(1)])
}

export function adapterUndoArgvs(plans: readonly AdapterUninstall[]): Set<string> {
  return new Set(plans.flatMap(p => p.plan.ops.filter(op => op.kind === 'exec').map(op => undoKey((op as Extract<Op, { kind: 'exec' }>).argv))))
}

export async function markAdapterUndos(journals: readonly Journal[], undoKeys: ReadonlySet<string>): Promise<number> {
  let marked = 0
  for (const j of journals) {
    if ((j.status !== 'committed' && j.status !== 'rollback-failed') || isUninstallJournal(j)) continue
    const argvs = (j.execs ?? []).filter(ex => ex.undone !== true && (ex.ran === true || ex.started === true) && Array.isArray(ex.undo) && ex.undo.length > 0 && undoKeys.has(undoKey(ex.undo))).map(ex => ex.argv)
    if (argvs.length === 0) continue
    try { marked += await markExecsUndone(j.txn, argvs) } catch {  }
  }
  return marked
}

export interface UndoOutcome { undone: string[]; failed: Array<{ command: string, detail: string }>; skipped: Array<{ command: string, detail: string }> }

export async function runExecUndos(undos: readonly ExecUndo[], record: InstallRecord, obsolete: ReadonlyArray<{ undo: ExecUndo, reason: string }> = []): Promise<UndoOutcome> {
  const out: UndoOutcome = { undone: [], failed: [], skipped: [] }
  const settle = async (u: ExecUndo) => {
    record.execUndone[JSON.stringify(u.argv)] = u.txn
    try { await markExecsUndone(u.txn, [u.argv]) } catch {  }
  }
  for (const o of obsolete) {
    await settle(o.undo)
    out.skipped.push({ command: o.undo.undo.join(' '), detail: o.reason })
  }
  for (const u of undos) {
    const r = await opsDeps.run(u.undo, { timeoutMs: 300_000 })
    const cmd = u.undo.join(' ')
    if (r.code === 0) {
      out.undone.push(cmd)
      await settle(u)
    } else if (undoKeptOnPurpose(u.undo, r.code)) {
      await settle(u)
      out.skipped.push({ command: cmd, detail: (r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' / ') || 'kept on purpose' })
    } else {
      out.failed.push({ command: cmd, detail: (r.stderr || r.stdout).trim().split('\n').slice(0, 3).join(' / ') || `exit ${r.code}` })
    }
  }
  return out
}

// Context Mode (removed in 0.6.0) kept its session data here; --purge-state still removes what an older Buracle left.
function legacyContextModeHome(): string {
  return join(paths.buracleHome(), 'context-mode')
}

export function purgeTargets(): string[] {
  const h = paths.buracleHome()
  return [paths.stateDir(), paths.sessionsDir(), paths.runDir(), join(h, 'cache'), paths.logsDir(), paths.backupsDir(), paths.journalDir(), paths.binDir(), legacyContextModeHome(), paths.toolchainDir(), paths.runtimeRoot()]
}

const TXN_DIR = /^\d{8}T\d{9}Z-[0-9a-f]{6}$/
const RUNTIME_ENTRY = /^(?:[0-9a-f]{16}|\.staging-.+)$/
const CACHE_ENTRIES = ['memory', 'usage', 'skills', 'npm', 'statusline-slugs.json', 'claude-plan.json', 'harness-versions.json', 'hook-health.json', 'runtime-drift.json']
const TMP_FILE = /^\..*\.buracle-\d+-[0-9a-f]+\.tmp$/
const HARNESS_DIRS = ['claude', 'codex', 'opencode', 'omp']
const LEGACY_CONTEXT_MODE_DIRS = [...HARNESS_DIRS, 'probe', 'sentinel', 'tmp', 'claude-config-empty']

function knownEntry(dir: string, name: string): boolean {
  if (TMP_FILE.test(name)) return true
  switch (dir) {
    case paths.binDir(): return name === 'buracle'
    case paths.stateDir(): return ['owned.json', 'health.json', 'updates.json', 'usage.json', 'runtime-config.json', 'txn.lock', 'install-record.json', 'memory', 'usage.lock', 'notifications.jsonl', 'notifications-read.json', 'toolchain.json', 'toolchain.json.lock', 'memory-ui.json', 'memory-ui.spawn', 'ui-sessions', 'shell-path.json', 'index', 'skills.json'].includes(name) || name.startsWith('usage.spawn.') || name.startsWith('toolchain.spawn.')
    case paths.toolchainDir(): return ['npm', 'uv', 'go', 'dotnet', 'cortexdb', 'system'].includes(name)
    case paths.sessionsDir(): case paths.runDir(): return HARNESS_DIRS.includes(name)
    case join(paths.buracleHome(), 'cache'): return CACHE_ENTRIES.includes(name)
    case paths.logsDir(): return /^buracle\.log(\.\d+)?$/.test(name) || paths.INSTALL_LOG_RE.test(name)
    case paths.backupsDir(): return TXN_DIR.test(name)
    case paths.journalDir(): return /^\d{8}T\d{9}Z-[0-9a-f]{6}\.json$/.test(name) || name === '_checkpoint.json'
    case legacyContextModeHome(): return LEGACY_CONTEXT_MODE_DIRS.includes(name)
    case paths.runtimeRoot(): return RUNTIME_ENTRY.test(name)
    default: return false
  }
}

export function purgeState(vault: string): { removed: string[], kept: string[], refused?: string } {
  const removed: string[] = []
  const kept: string[] = []
  const problem = buracleHomeProblem()
  if (problem !== undefined) return { removed, kept: purgeTargets().filter(d => existsSync(d)), refused: problem }
  const owned = buracleHomeOwned()
  for (const d of purgeTargets()) {
    if (!existsSync(d)) continue
    if (isInside(vault, d) || isInside(d, vault)) { kept.push(d); continue }
    try {
      if (lstatSync(d).isSymbolicLink()) { kept.push(d); continue }
      if (owned) {
        rmSync(d, { recursive: true, force: true })
        removed.push(d)
        continue
      }
      const foreign: string[] = []
      for (const n of readdirSync(d)) {
        if (!knownEntry(d, n)) { foreign.push(n); continue }
        rmSync(join(d, n), { recursive: true, force: true })
      }
      if (foreign.length === 0) { rmdirSync(d); removed.push(d) } else kept.push(`${d} (not Buracle's: ${foreign.slice(0, 5).join(', ')}${foreign.length > 5 ? ', …' : ''})`)
    } catch {
      kept.push(d)
    }
  }
  if (owned) {
    try { unlinkSync(join(paths.buracleHome(), HOME_MARKER)) } catch {  }
  }
  return { removed, kept }
}

export async function pruneCreatedDirs(vault: string): Promise<string[]> {
  let dirs: string[] = []
  try { dirs = await historyCreatedDirs() } catch { dirs = [] }
  const removed: string[] = []
  for (const d of [...new Set(dirs)].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))) {
    if (isInside(d, vault) || isInside(vault, d)) continue
    try {
      if (!lstatSync(d).isDirectory() || readdirSync(d).length > 0) continue
      rmdirSync(d)
      removed.push(d)
    } catch {  }
  }
  return removed
}

export async function stopMemoryUi(): Promise<{ status: 'none' | 'stopped' | 'not-running' | 'unconfirmed' | 'still-running', url?: string }> {
  try {
    const { readUiRecord, stopUi } = await import('../../memory/ui')
    const rec = readUiRecord()
    if (rec === undefined) return { status: 'none' }
    return { status: await stopUi(rec), url: rec.url }
  } catch {
    return { status: 'none' }
  }
}

/**
 * The system tools the install downloaded (node, uv, rg, jq under toolchain/system) and their records: Buracle's own
 * copies of programs the machine lacked, so a plain uninstall removes them (the npm and uv packages stay for a purge).
 */
export async function removeDownloadedTools(nowMs: number): Promise<string[]> {
  const dir = paths.systemToolsDir()
  if (!existsSync(dir)) return []
  const names = readdirSync(dir).filter(n => !n.startsWith('.')).sort()
  rmSync(dir, { recursive: true, force: true })
  if (existsSync(paths.toolchainStateFile())) {
    const { updateToolchainState } = await import('../toolchain/state')
    updateToolchainState(s => { for (const [k, r] of Object.entries(s.system)) if (r.via === 'download') delete s.system[k] }, new Date(nowMs).toISOString())
  }
  return names
}

export const VAULT_PRE_COMMIT_MARKER = '# Installed by buracle: refuse commits that contain secrets.'

export async function removeVaultPreCommitHook(vault: string): Promise<'removed' | 'foreign' | 'missing' | 'error'> {
  const file = join(vault, '.git', 'hooks', 'pre-commit')
  try {
    let text: string
    try { text = readFileSync(file, 'utf8') } catch { return 'missing' }
    if (!text.includes(VAULT_PRE_COMMIT_MARKER)) return 'foreign'
    unlinkSync(file)
    return 'removed'
  } catch {
    return 'error'
  }
}

export interface ProjectLeftover { root: string; path: string; what: string; remove: string }

const MANAGED_BLOCK_START = '# >>> buracle'

function holdsBlock(file: string): boolean {
  try { return readFileSync(file, 'utf8').split('\n').some(l => l.startsWith(MANAGED_BLOCK_START)) } catch { return false }
}

export function knownProjectRoots(): string[] {
  const roots = new Set<string>()
  let names: string[] = []
  try { names = readdirSync(paths.indexStateDir()) } catch { names = [] }
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    const r = readJsonSafeSync<{ root?: unknown }>(join(paths.indexStateDir(), n))
    if (r.ok && r.value !== null && typeof r.value === 'object' && typeof r.value.root === 'string') roots.add(r.value.root)
  }
  const cache = readJsonSafeSync<{ projects?: Record<string, { roots?: unknown }> }>(join(paths.memoryStateDir(), 'projects.json'))
  if (cache.ok && cache.value !== null && typeof cache.value === 'object' && cache.value.projects !== null && typeof cache.value.projects === 'object') {
    for (const p of Object.values(cache.value.projects)) {
      if (p !== null && typeof p === 'object' && Array.isArray(p.roots)) for (const r of p.roots) if (typeof r === 'string') roots.add(r)
    }
  }
  return [...roots].filter(r => isAbsolute(r) && existsSync(r)).sort()
}

export function projectLeftovers(roots: readonly string[] = knownProjectRoots()): ProjectLeftover[] {
  const out: ProjectLeftover[] = []
  for (const root of roots) {
    const codegraph = join(root, '.codegraph')
    if (existsSync(codegraph)) out.push({ root, path: codegraph, what: 'codegraph index (built by Buracle\'s index runs, unless you use codegraph yourself)', remove: `rm -rf '${codegraph}'` })
    const semble = join(root, '.sembleignore')
    if (holdsBlock(semble)) out.push({ root, path: semble, what: 'managed block (plan worktrees kept out of semble)', remove: 'delete the lines from `# >>> buracle` to `# <<< buracle` (the whole file when nothing else is in it)' })
    const exclude = join(root, '.git', 'info', 'exclude')
    if (holdsBlock(exclude)) out.push({ root, path: exclude, what: 'managed block (local-only files kept out of git status)', remove: 'delete the lines from `# >>> buracle` to `# <<< buracle`' })
    const links = join(root, '.claude', 'skills')
    let ids: string[] = []
    try { ids = readdirSync(links).sort() } catch { ids = [] }
    for (const id of ids) {
      const link = join(links, id)
      try {
        if (!lstatSync(link).isSymbolicLink()) continue
        const target = resolve(links, readlinkSync(link))
        if (!isInside(target, join(root, '.agents', 'skills'))) continue
        out.push({ root, path: link, what: 'link to the project skill in .agents/skills (buracle project sync)', remove: `rm '${link}'` })
      } catch {  }
    }
  }
  return out
}

export function pruneEmptyRuleDirs(): void {
  for (const d of [pathRulesDir(), dirname(pathRulesDir())]) {
    try {
      if (lstatSync(d).isDirectory() && readdirSync(d).length === 0) rmdirSync(d)
    } catch {  }
  }
}
