import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { realPath } from '../engine/fsx'
import { run } from '../engine/proc'
import { checkCortexdb } from '../engine/toolchain/cortexdb'
import { readLedgerSync } from '../engine/txn'
import { CAPTURE_BUDGET } from '../core/memory/budgets'
import { pendingSessions } from './capture'
import { listBackups } from './backup'
import { brainSelfTest, cortexdbVersion, cortexdbVersionProblem } from './cortex-check'
import { brainBackupsDir, brainDbFile } from './layout'
import { corruptProjectsBackups, memoryExcludeConfig, memoryExcludeProblemText, projectExclusion, projectsCacheProblem, readProjectsCache, resolveProject } from './project'
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
  // The folder name tells the version of an installed binary; the binary's own word covers one named by BURACLE_CORTEXDB_BIN.
  const old = bin.status === 'ok' ? cortexdbVersionProblem(await cortexdbVersion(bin)) : undefined
  if (bin.status !== 'ok') add('error', 'cortexdb', bin.detail)
  else if (old !== undefined) add('error', 'cortexdb', `${bin.path}: ${old} (buracle install takes the newest release)`)
  else add('ok', 'cortexdb', bin.source === 'env' ? `${bin.path} (BURACLE_CORTEXDB_BIN)` : `${bin.version}, sha256 verified`)
  const db = brainDbFile()
  if (existsSync(db)) add('ok', 'brain', `${db} (${Math.max(1, Math.round(statSync(db).size / 1024))} KB)`)
  else add('ok', 'brain', `${db} does not exist yet; the first memory write creates it`)
  const backups = listBackups()
  const newest = backups[0]
  add('info', 'backups', newest === undefined
    ? `none yet in ${brainBackupsDir()}: \`buracle mem backup\` takes one`
    : `${backups.length} in ${brainBackupsDir()}, the newest ${newest.id} (${newest.trigger}); \`buracle mem backup --list\` shows them, \`buracle mem restore <id>\` puts one back`)
  const excludeProblem = memoryExcludeConfig().problem
  if (excludeProblem !== undefined) add('warn', 'memory.exclude', memoryExcludeProblemText(excludeProblem))
  // Before any project resolution rebuilds it: an unreadable projects cache was backed up (PRD R14).
  const cacheProblem = projectsCacheProblem()
  if (cacheProblem !== undefined) {
    add('warn', 'projects cache', `${cacheProblem}; a backup was kept beside it and the next session rebuilds it; restore records by hand if any are missing`)
  } else {
    const kept = corruptProjectsBackups()
    if (kept.length > 0) {
      const newest = basename(kept[kept.length - 1] ?? '')
      add('info', 'projects cache', `an earlier projects.json was unreadable and was rebuilt; ${kept.length} backup(s) kept, the newest ${newest}`)
    }
  }
  let answered = false
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
      // Only a brain whose every read above went through counts as answering.
      answered = true
    } catch (e) {
      add('error', 'brain', `CortexDB did not answer: ${(e as Error).message}`)
    }
    if (opts.leak !== false) {
      const leak = await runLeakCheck()
      add(leak.ok ? 'ok' : 'error', 'leak check', leak.detail)
    }
  }
  if (bin.status === 'ok' && existsSync(db)) {
    const t = await brainSelfTest(db)
    // The self-test passed and the brain answered just now: the file is readable, and a restore would drop every memory
    // newer than the backup, so only a failed self-test names it.
    if (t.status === 'failed' && t.selfTestPassed === true && answered) add('warn', 'brain file', `CortexDB's check of ${db} reported a problem although its self-test passed and the memory answers: ${t.detail}. Close every harness and run \`buracle mem doctor\` again; when it stays, report it with that output`)
    else if (t.status === 'failed') add('error', 'brain file', `CortexDB's check of ${db} failed: ${t.detail}; restore a backup (buracle mem backup --list)`)
    else if (t.status === 'passed') add('ok', 'brain file', `CortexDB's self-test passed (${t.detail})`)
  }
  if (opts.mcp !== false) {
    const h = await mcpHandshake(opts.cwd)
    add(h.ok ? 'ok' : 'error', 'mcp', h.detail)
  }
  try {
    const left = Object.keys(readLedgerSync()).filter(k => k.endsWith('#autoMemoryDirectory'))
    if (left.length > 0) add('warn', 'claude redirect', `${left.length} project(s) still carry the autoMemoryDirectory an older Buracle wrote; \`buracle install\` takes them back`)
  } catch {  }
  return checks
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
