import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { realPath } from '../engine/fsx'
import * as paths from '../engine/paths'
import { run } from '../engine/proc'
import { checkCortexdb, CORTEXDB_VERSION } from '../engine/toolchain/cortexdb'
import { readLedgerSync } from '../engine/txn'
import { embedStatus } from './embed'
import { oldVaultPath, vaultImportDone } from './import-vault'
import { listBackups } from './backup'
import { brainBackupsDir, brainProjectsDir, personDbFile } from './layout'
import { memoryExcludeConfig, memoryExcludeProblemText, projectExclusion, readProjectsCache, resolveProject } from './project'
import { cliArgv } from './spawn'
import { listAll, personRef, projectRef } from './store'
import { readUpkeep } from './sweep'

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
  const env: Record<string, string> = { HOME: home, BURACLE_HOME: join(home, '.buracle'), BURACLE_NO_AUTOSTART: '1', BURACLE_NO_DISTILL: '1', BURACLE_NO_REFLECT: '1', BURACLE_NO_NOTIFY: '1' }
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

export async function jobChecks(nowMs: number, slug?: string): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = []
  const add = (level: DoctorCheck['level'], check: string, detail: string) => out.push({ level, check, detail })
  const { readJobs, jobEntryLine } = await import('./jobs')
  const { orphanSpools, staleSessions } = await import('./kick')
  const { runnerArgv } = await import('./runner')
  const { distillQueue, DISTILL_QUEUE_MAX_AGE_MS } = await import('./distill')
  const { sweepDue } = await import('./sweep')
  const { latestSessionRecord } = await import('./session-record')
  const stale = staleSessions(undefined, undefined, nowMs)
  add(stale.length === 0 ? 'ok' : 'warn', 'jobs: finalize', stale.length === 0 ? 'every ended session was finalized' : `${stale.length} session(s) were left open or got new segments after their finalization (${stale.map(s => `${s.h}-${s.sid}`).slice(0, 3).join(', ')}); the next session start hands them to finalizers`)
  if (slug !== undefined) {
    const recent = latestSessionRecord(slug)
    const overdue = sweepDue(slug, nowMs) && recent !== undefined && nowMs - recent.startedMs < 12 * 3600_000
    add(overdue ? 'warn' : 'ok', 'jobs: sweep', overdue ? `${slug} was not swept in the last 6 hours although a session ran; the next session start sweeps it` : `${slug}: the sweep is current`)
  }
  const used = new Set<string>()
  for (const e of readJobs()) if (e.harness !== undefined && nowMs - Date.parse(e.at) < 7 * 86_400_000) used.add(e.harness)
  const missing = [...used].filter(h => ['claude', 'codex', 'opencode', 'omp'].includes(h)).filter(h => Bun.which(runnerArgv(h as import('../core/events').Harness)[0] as string, { PATH: process.env['PATH'] ?? '' }) === null)
  add(missing.length === 0 ? 'ok' : 'warn', 'jobs: model CLIs', missing.length === 0 ? `the CLIs of the harnesses used this week are on PATH (${[...used].join(', ') || 'none yet'})` : `not on PATH: ${missing.join(', ')}; the memory's model calls go through the other harnesses with usage headroom meanwhile`)
  const orphans = orphanSpools(nowMs)
  if (orphans.length > 0) add('warn', 'jobs: orphan spools', `${orphans.length} captured session(s) have no session record (${orphans.map(o => `${o.h}-${o.sid}`).join(', ')}); the next session start finalizes them`)
  let dead = 0
  try {
    const { lockSnapshot } = await import('../engine/lockfile')
    const { locksDir } = await import('./layout')
    for (const n of readdirSync(locksDir())) {
      if (!n.endsWith('.lock')) continue
      const seen = lockSnapshot(join(locksDir(), n))
      if (seen === undefined || nowMs - seen.mtimeMs < 86_400_000) continue
      try { const pid = (JSON.parse(seen.text) as { pid?: unknown }).pid; if (typeof pid === 'number') { try { process.kill(pid, 0) } catch (e) { if ((e as { code?: string }).code !== 'EPERM') dead++ } } } catch {  }
    }
  } catch {  }
  if (dead > 0) add('info', 'jobs: locks', `${dead} lock file(s) of dead processes older than a day; the next session start removes them`)
  const old = distillQueue().filter(q => nowMs - q.queuedMs > DISTILL_QUEUE_MAX_AGE_MS).length
  if (old > 0) add('warn', 'jobs: distill queue', `${old} queued session(s) are older than two weeks; the next sweep drops them`)
  const failures = readJobs().filter(e => e.outcome === 'failed' && nowMs - Date.parse(e.at) < 86_400_000)
  const lastFailure = failures[failures.length - 1]
  add(failures.length === 0 ? 'ok' : 'warn', 'jobs: failures', lastFailure === undefined ? 'no automatic job failed in the last 24 hours' : `${failures.length} failure(s) in the last 24 hours; the last: ${lastFailure.job} ${jobEntryLine(lastFailure, nowMs)} (buracle mem jobs)`)
  return out
}

function embedCheck(): DoctorCheck {
  const s = embedStatus()
  if (s.off) return { level: 'info', check: 'embeddings', detail: 'BURACLE_NO_EMBED=1: the search is by words in this process' }
  if (!s.installed) return { level: 'warn', check: 'embeddings', detail: `${s.check.status === 'ok' ? '' : s.check.detail}; the search is by words until the model is downloaded (the repair does it)` }
  const rows = s.check.status === 'ok' ? s.check.header.rows : 0
  return {
    level: 'ok', check: 'embeddings',
    detail: `${s.model}: ${s.dim} dimensions, ${rows} word pieces, in the toolchain (hybrid search${s.endpoint !== undefined ? `; the brain web UI serves it at ${s.endpoint}` : '; the brain web UI is not running, so CortexDB answers by words until a session starts it'})`,
  }
}

export async function memDoctor(opts: { cwd: string, mcp?: boolean, leak?: boolean }): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []
  const add = (level: DoctorCheck['level'], check: string, detail: string) => checks.push({ level, check, detail })
  const bin = checkCortexdb()
  if (bin.status === 'ok') add('ok', 'cortexdb', bin.source === 'env' ? `${bin.path} (BURACLE_CORTEXDB_BIN)` : `${CORTEXDB_VERSION}, sha256 verified`)
  else add('error', 'cortexdb', bin.detail)
  const projects = (() => { try { return readdirSync(brainProjectsDir()).filter(n => n.endsWith('.db')).length } catch { return 0 } })()
  add('ok', 'brain', `${paths.brainDir()}: ${projects} project brain${projects === 1 ? '' : 's'}${existsSync(personDbFile()) ? ', person brain' : ', no person brain yet'}`)
  try {
    const known = new Set(Object.keys(readProjectsCache().projects))
    const orphans = readdirSync(brainProjectsDir()).filter(n => n.endsWith('.db') && !known.has(n.slice(0, -3)))
    if (orphans.length > 0) add('warn', 'brain', `${orphans.length} brain file(s) without a project record, so no sweep, status or repair reaches them: ${orphans.join(', ')}; a session in the project's folder registers it again (buracle project init), or move the file out of ${brainProjectsDir()}`)
  } catch {  }
  const backups = listBackups()
  const newest = backups[0]
  add('info', 'backups', newest === undefined
    ? `none yet in ${brainBackupsDir()}: the tick takes one a day, \`buracle mem backup\` one now`
    : `${backups.length} in ${brainBackupsDir()}, the newest ${newest.id} (${newest.trigger}); \`buracle mem backup --list\` shows them, \`buracle mem restore <id>\` puts one back`)
  const excludeProblem = memoryExcludeConfig().problem
  if (excludeProblem !== undefined) add('warn', 'memory.exclude', memoryExcludeProblemText(excludeProblem))
  if (bin.status === 'ok') {
    const rec = await resolveProject(opts.cwd).catch(() => undefined)
    try {
      const person = await listAll(personRef())
      add('ok', 'person memory', `${person.length} memories`)
      if (rec !== undefined) {
        const items = await listAll(projectRef(rec.slug))
        add('ok', 'project memory', `${rec.slug}: ${items.length} memories`)
        const up = (readUpkeep(rec.slug)?.items.length ?? 0) + (readUpkeep(undefined)?.items.length ?? 0)
        add('info', 'upkeep', up === 0 ? 'nothing waits' : `${up} item(s) wait for a harness (memory_status lists them)`)
      } else {
        const excluded = await projectExclusion(opts.cwd).catch(() => undefined)
        add('info', 'project memory', excluded !== undefined ? `${opts.cwd} is ${excluded}` : `${opts.cwd} is not a project`)
      }
      for (const c of await jobChecks(Date.now(), rec?.slug)) checks.push(c)
    } catch (e) {
      add('error', 'brain', `CortexDB did not answer: ${(e as Error).message}`)
    }
    checks.push(embedCheck())
    if (opts.leak !== false) {
      const leak = await runLeakCheck()
      add(leak.ok ? 'ok' : 'error', 'leak check', leak.detail)
    }
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
