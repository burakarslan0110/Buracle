import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realPath } from '../engine/fsx'
import * as paths from '../engine/paths'
import { run } from '../engine/proc'
import { checkCortexdb } from '../engine/toolchain/cortexdb'
import { readLedgerSync } from '../engine/txn'
import { CAPTURE_BUDGET } from '../core/memory/budgets'
import { pendingSessions } from './capture'
import { oldVaultPath, vaultImportDone } from './import-vault'
import { listBackups } from './backup'
import { brainSelfTest } from './cortex-check'
import { brainBackupsDir, brainDbFile } from './layout'
import { migrationInfo } from './migrate'
import { memoryExcludeConfig, memoryExcludeProblemText, projectExclusion, readProjectsCache, resolveProject } from './project'
import { cliArgv } from './spawn'
import { bucketCounts, listAll, personRef, projectRef } from './store'

export type DoctorLevel = 'ok' | 'info' | 'warn' | 'error'
export interface DoctorCheck { level: DoctorLevel, check: string, detail: string }

export function doctorExitCode(checks: readonly DoctorCheck[]): number {
  return checks.some(c => c.level === 'error') ? 1 : checks.some(c => c.level === 'warn') ? 2 : 0
}

export async function mcpHandshake(cwd: string, timeoutMs = 10_000): Promise<{ ok: boolean, detail: string }> {
  const msgs = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'buracle-doctor', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]
  const r = await run([...cliArgv(), 'mcp', 'memory'], { cwd: existsSync(cwd) ? cwd : undefined, stdin: msgs.map(m => JSON.stringify(m)).join('\n') + '\n', timeoutMs })
  const lines = r.stdout.split('\n').filter(l => l.trim() !== '')
  try {
    const parsed = lines.map(l => JSON.parse(l) as { id?: number, result?: { protocolVersion?: string, tools?: unknown[] } })
    const init = parsed.find(p => p.id === 1)
    const list = parsed.find(p => p.id === 2)
    const tools = list?.result?.tools?.length ?? 0
    if (init?.result?.protocolVersion && tools >= 6) return { ok: true, detail: `protocol ${init.result.protocolVersion}, ${tools} tools` }
    return { ok: false, detail: `unexpected answer (exit ${r.code}): ${r.stdout.slice(0, 200)}${r.stderr.slice(0, 200)}` }
  } catch {
    return { ok: false, detail: `stdout is not JSON-RPC (exit ${r.code}): ${(r.stdout || r.stderr).slice(0, 200)}` }
  }
}

export async function runLeakCheck(timeoutMs = 30_000): Promise<{ ok: boolean, detail: string }> {
  const root = realPath(mkdtempSync(join(realPath(tmpdir()), 'buracle-leak-')))
  try {
    return await leakCheckIn(root, timeoutMs)
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch {  }
  }
}

async function leakCheckIn(root: string, timeoutMs: number): Promise<{ ok: boolean, detail: string }> {
  const home = join(root, 'home')
  const a = join(home, 'proj-a')
  const b = join(home, 'proj-b')
  for (const d of [a, b]) { mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'README.md'), `# ${d}\n`) }
  const canary = `canary${Math.random().toString(36).slice(2, 10)}`
  const env: Record<string, string> = { HOME: home, BURACLE_HOME: join(home, '.buracle'), BURACLE_NO_AUTOSTART: '1', BURACLE_NO_DISTILL: '1', BURACLE_NO_NOTIFY: '1' }
  for (const k of ['CORTEXDB_PATH', 'CORTEXDB_REMOTE']) env[k] = ''
  const bin = checkCortexdb()
  if (bin.status === 'ok') env['BURACLE_CORTEXDB_BIN'] = bin.path
  const cli = cliArgv()
  const exec = (cwd: string, args: string[]) => run([...cli, ...args], { cwd, env, timeoutMs })
  const w = await exec(a, ['mem', 'write', '--type', 'gotcha', '--title', `Leak check ${canary}`, '--summary', `only in project A ${canary}`, '--body', canary, '--json'])
  if (w.code !== 0) return { ok: false, detail: `the canary was not written (exit ${w.code}): ${(w.stderr || w.stdout).slice(0, 200)}` }
  const back = await exec(a, ['mem', 'search', canary, '--json'])
  if (!back.stdout.includes(canary)) return { ok: false, detail: 'project A cannot find its own canary, so the check proves nothing' }
  const probes: Array<[string, string[]]> = [
    ['search', ['mem', 'search', canary, '--json']],
    ['search person', ['mem', 'search', canary, '--layer', 'person', '--json']],
    ['context', ['mem', 'context', '--json']],
    ['status', ['mem', 'status', '--json']],
  ]
  const id = (() => { try { return (JSON.parse(w.stdout) as { id?: string }).id } catch { return undefined } })()
  if (id !== undefined) probes.push(['get', ['mem', 'get', id, '--json']])
  for (const [name, args] of probes) {
    const r = await exec(b, args)
    if (r.stdout.includes(canary) || r.stderr.includes(canary)) return { ok: false, detail: `the canary of project A showed up in project B through ${name}` }
  }
  return { ok: true, detail: `a canary of project A did not reach project B (${probes.length} paths)` }
}

/** What the on-demand capture still owes: sessions whose model call failed or was held back, and stale spools. */
export function captureChecks(nowMs: number): DoctorCheck[] {
  const pending = pendingSessions(nowMs, { max: 50, afterMs: 0 })
  const retry = pending.filter(p => p.why === 'retry')
  const other = pending.length - retry.length
  const out: DoctorCheck[] = []
  out.push(pending.length === 0
    ? { level: 'ok', check: 'capture', detail: 'no session waits for its capture' }
    : { level: 'warn', check: 'capture', detail: `${pending.length} session(s) wait for their capture (${retry.length} for another model try, ${other} never finalized); the next session end takes up to ${CAPTURE_BUDGET.pendingPerRun}, or run \`buracle mem capture --pending\`` })
  return out
}

export async function memDoctor(opts: { cwd: string, mcp?: boolean, leak?: boolean }): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const add = (level: DoctorCheck['level'], check: string, detail: string) => checks.push({ level, check, detail })
  const bin = checkCortexdb()
  if (bin.status === 'ok') add('ok', 'cortexdb', bin.source === 'env' ? `${bin.path} (BURACLE_CORTEXDB_BIN)` : `${bin.version}, sha256 verified`)
  else add('error', 'cortexdb', bin.detail)
  const db = brainDbFile()
  if (existsSync(db)) add('ok', 'brain', `${db} (${Math.max(1, Math.round(statSync(db).size / 1024))} KB)`)
  else if (migrationInfo().legacy.length > 0) add('info', 'brain', `${db} does not exist yet; the Buracle 0.5 brain files are folded into it at the first memory call`)
  else add('ok', 'brain', `${db} does not exist yet; the first memory write creates it`)
  const backups = listBackups()
  const newest = backups[0]
  add('info', 'backups', newest === undefined
    ? `none yet in ${brainBackupsDir()}: \`buracle mem backup\` takes one`
    : `${backups.length} in ${brainBackupsDir()}, the newest ${newest.id} (${newest.trigger}); \`buracle mem backup --list\` shows them, \`buracle mem restore <id>\` puts one back`)
  const excludeProblem = memoryExcludeConfig().problem
  if (excludeProblem !== undefined) add('warn', 'memory.exclude', memoryExcludeProblemText(excludeProblem))
  if (bin.status === 'ok') {
    const rec = await resolveProject(opts.cwd).catch(() => undefined)
    try {
      const person = await listAll(personRef())
      add('ok', 'person memory', `${person.length} memories`)
      await bucketChecks(add)
      if (rec !== undefined) {
        const items = await listAll(projectRef(rec.slug))
        add('ok', 'project memory', `${rec.slug}: ${items.length} memories`)
      } else {
        const excluded = await projectExclusion(opts.cwd).catch(() => undefined)
        add('info', 'project memory', excluded !== undefined ? `${opts.cwd} is ${excluded}` : `${opts.cwd} is not a project`)
      }
      for (const c of captureChecks(Date.now())) checks.push(c)
    } catch (e) {
      add('error', 'brain', `CortexDB did not answer: ${(e as Error).message}`)
    }
    if (opts.leak !== false) {
      const leak = await runLeakCheck()
      add(leak.ok ? 'ok' : 'error', 'leak check', leak.detail)
    }
  }
  checks.push(...migrationChecks())
  if (bin.status === 'ok' && existsSync(db)) {
    const t = await brainSelfTest(db)
    if (t.status === 'failed') add('error', 'brain file', `CortexDB's self-test failed on ${db}: ${t.detail}; restore a backup (buracle mem backup --list)`)
    else if (t.status === 'passed') add('ok', 'brain file', `CortexDB's self-test passed (${t.detail})`)
  }
  if (opts.mcp !== false) {
    const h = await mcpHandshake(opts.cwd)
    add(h.ok ? 'ok' : 'error', 'mcp', h.detail)
  }
  const vault = oldVaultPath()
  if (existsSync(join(vault, 'projects')) || existsSync(join(vault, 'global'))) {
    const done = vaultImportDone()
    add(done !== undefined ? 'info' : 'warn', 'old vault', done !== undefined
      ? `${vault} was imported on ${done.at.slice(0, 10)}; Buracle no longer reads or writes it (it is yours to keep or delete)`
      : `${vault} has notes that are not in the brain yet: run \`buracle mem import-vault\` (the vault is only read)`)
  }
  try {
    const left = Object.keys(readLedgerSync()).filter(k => k.endsWith('#autoMemoryDirectory'))
    if (left.length > 0) add('warn', 'claude redirect', `${left.length} project(s) still carry the autoMemoryDirectory an older Buracle wrote; \`buracle install\` takes them back`)
  } catch {  }
  return checks
}

/** Where the migration from Buracle 0.5 stands, and what it left behind. */
export function migrationChecks(): DoctorCheck[] {
  const info = migrationInfo()
  const m = info.marker
  const out: DoctorCheck[] = []
  if (info.state === 'none') return out
  if (info.state === 'complete') {
    out.push({ level: 'ok', check: 'migration', detail: `complete${m?.finishedAt !== undefined ? ` on ${m.finishedAt.slice(0, 10)}` : ''}: the memory is one file, brain.db` })
    if (info.keptLegacy) out.push({ level: 'info', check: 'migration', detail: `the Buracle 0.5 brain files are kept in ${paths.brainDir()}/legacy-0.5${info.backup !== undefined ? ` and verified copies in backups/${info.backup}` : ''}; \`buracle mem migrate --purge-legacy\` deletes them` })
  } else {
    out.push({
      level: info.state === 'failed' ? 'error' : 'warn', check: 'migration',
      detail: `${info.state}: ${info.legacy.length} Buracle 0.5 file(s) wait to be folded into brain.db (${info.legacy.join(', ')})${m?.error !== undefined ? `; the last run stopped: ${m.error}` : ''}; \`buracle mem migrate\` runs it, \`buracle mem migrate --status\` shows where it is`,
    })
  }
  if (m?.leftover !== undefined && m.leftover.length > 0) out.push({ level: 'warn', check: 'migration', detail: `${m.leftover.length} Buracle 0.5 file(s) could not be moved aside (a process still holds them open): ${m.leftover.join(', ')}; they are not migrated again, move them out of ${paths.brainDir()} once that process is gone` })
  return out
}

async function bucketChecks(add: (level: DoctorLevel, check: string, detail: string) => void): Promise<void> {
  const counts = await bucketCounts()
  const slugs = [...counts.projects.keys()].sort()
  add('ok', 'buckets', `person ${counts.person}${slugs.length > 0 ? `, ${slugs.map(s => `${s} ${counts.projects.get(s)}`).join(', ')}` : ''} (rows, retired ones included)`)
  const known = new Set(Object.keys(readProjectsCache().projects))
  const orphans = slugs.filter(s => !known.has(s))
  if (orphans.length > 0) add('warn', 'brain', `${orphans.length} project bucket(s) without a project record, so no status reaches them: ${orphans.join(', ')}; a session in the project's folder registers it again (buracle project init)`)
  if (counts.foreign > 0) add('warn', 'brain', `${counts.foreign} row(s) in brain.db belong to no bucket (an id without the u/ or p/<project>/ prefix); Buracle ignores them`)
}
