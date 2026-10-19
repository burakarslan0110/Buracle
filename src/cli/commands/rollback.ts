import type { CommandIO } from '../router'
import type { CanonicalBundle } from '../../core/catalog'
import { loadBundle } from '../../engine/update/context'
import { opsDeps } from '../../engine/update/deps'
import { isBackgroundJournal, listTxns, rollbackTxn, withTxnLock, type Journal, type RollbackReport } from '../../engine/txn'
import { parseFlags } from '../../engine/update/args'
import { errText, table, tilde, tildeText, writeJson } from '../../engine/update/output'
import { isUninstallJournal } from '../../engine/update/uninstall'

export const name = 'rollback'
export const summary = 'Undo the newest install, a given transaction, or the last toolchain upgrade'
export const usage = `Usage: buracle rollback [<txn>] [--list] [--json]
       buracle rollback toolchain [<package>…] [--json]

Without <txn>: undoes the newest \`buracle install\` run that is not rolled
back yet: all of its transactions (the core one and one per harness), newest
first. Transactions a hook wrote on its own (the Claude Code memory redirect of
a project, plan memory-project-<slug>; RUN "hook" in --list) are skipped. A newest
transaction made by \`buracle uninstall\` is never picked this way (that would
leave Buracle half installed): run \`buracle install\` to set it up again, or pass
that transaction's id to restore exactly what it removed.
With <txn>: undoes that one transaction (an uninstall's or a hook's too; the
commands an uninstall undid, such as plugin registrations, are not re-run).

Files are restored from the backups, commands that ran are undone once and
ownership records are reverted. A path changed again after the transaction is
left as it is and reported; in a file Buracle merged into, only Buracle's own
keys are undone. Transactions older than the retained backups cannot be rolled back.

toolchain: puts back the version each package of the Buracle toolchain (~/.buracle/toolchain)
held before its last install or update (npm: the kept copy; PyPI: a reinstall of that
version); with names (a tool or MCP server id, a package name or <registry>:<name>) only
those. An install or update does not take the rolled-back version again, only a newer one.
Run it again to undo the rollback.

Options:
  --list   list transactions (newest first) instead of rolling back
  --json   machine-readable output

Exit codes: 0 restored completely, 1 error, 2 partial (paths left alone or warnings).`

function journalRow(j: Journal): string[] {
  const files = Array.isArray(j.files) ? j.files.length : 0
  const execs = Array.isArray(j.execs) ? j.execs.filter(e => e.ran).length : 0
  const plans = Array.isArray(j.plans) ? j.plans.map(p => p.id).join(',') : ''
  return [j.txn, j.status, j.startedAt ?? '', `${files} file(s)`, `${execs} exec(s)`, plans, j.run ?? (isBackgroundJournal(j) ? 'hook' : '-')]
}

async function newestRun(): Promise<Journal[]> {
  const all = (await listTxns()).filter(j => !isBackgroundJournal(j))
  const latest = all.find(j => j.status !== 'rolled-back')
  if (latest === undefined) throw new Error('no committed transaction to roll back')
  if (isUninstallJournal(latest)) {
    throw new Error(`the newest transaction (${latest.txn}) was made by \`buracle uninstall\`; \`buracle rollback\` without an id only undoes install runs, so Buracle is never left half installed. Run \`buracle install\` to set Buracle up again, or \`buracle rollback ${latest.txn}\` to restore exactly the files that uninstall removed (the commands it undid are not run again).`)
  }
  if (latest.run === undefined) return [latest]
  return all.filter(j => j.run === latest.run && j.status !== 'rolled-back')
}

function merge(reports: readonly RollbackReport[]): RollbackReport & { txns: string[] } {
  return {
    txn: reports[0]?.txn ?? '',
    txns: reports.map(r => r.txn),
    restored: reports.flatMap(r => r.restored),
    skipped: reports.flatMap(r => r.skipped),
    undone: reports.flatMap(r => r.undone),
    errors: reports.flatMap(r => r.errors),
    warnings: reports.flatMap(r => r.warnings),
  }
}

export function rollbackKeys(only: readonly string[], packages: Readonly<Record<string, { registry: string, name: string }>>, bundle: Pick<CanonicalBundle, 'mcp' | 'tools'> | undefined): { keys: string[], unknown: string[] } {
  const keys = new Set<string>()
  const unknown: string[] = []
  for (const raw of only) {
    const want = raw.trim()
    let names: string[] = []
    const server = bundle?.mcp.servers[want.replace(/^mcp:/, '')]?.package
    const tool = bundle?.tools.tools.find(x => x.name === want.replace(/^tool:/, ''))
    if (server !== undefined) names = [server.name]
    else if (tool !== undefined) {
      const ref = tool.npm !== undefined ? tool.npm.replace(/(.)@[^@/]+$/, '$1') : tool.pypi !== undefined ? tool.pypi.replace(/[[=].*$/, '') : undefined
      if (ref !== undefined) names = [ref]
    }
    const hits = Object.keys(packages).filter(k => k === want || packages[k]?.name === want || names.includes(packages[k]?.name ?? ''))
    if (hits.length === 0) unknown.push(want)
    for (const k of hits) keys.add(k)
  }
  return { keys: [...keys].sort(), unknown }
}

async function runToolchainRollback(only: readonly string[], io: CommandIO, json: boolean): Promise<number> {
  const { readToolchainState } = await import('../../engine/toolchain/state')
  const { rollbackCandidates, rollbackPackages, withToolchainLock } = await import('../../engine/toolchain/index')
  const fail = (error: string): number => {
    if (json) writeJson(io.stdout, { ok: false, error })
    else io.stderr.write(`buracle rollback toolchain: ${error}\n`)
    return 1
  }
  const state = readToolchainState()
  let keys: string[] | undefined
  if (only.length > 0) {
    const b = loadBundle(opsDeps.repoRoot())
    const r = rollbackKeys(only, state.packages, 'bundle' in b ? b.bundle : undefined)
    if (r.unknown.length > 0) return fail(`not in the toolchain: ${r.unknown.join(', ')}`)
    keys = r.keys
  }
  const candidates = rollbackCandidates(state, keys)
  if (candidates.length === 0) return fail(`no previous version is recorded for ${keys === undefined ? 'any toolchain package' : keys.join(', ')}; an install keeps one previous version per package once it replaced one`)
  const results = await withToolchainLock(opsDeps.now(), () => rollbackPackages(candidates, opsDeps.now()))
  if (results === undefined) return fail('another Buracle process is installing the toolchain; try again in a moment')
  const failed = results.filter(r => !r.ok)
  if (json) {
    writeJson(io.stdout, { ok: failed.length === 0, items: results })
    return failed.length === 0 ? 0 : 1
  }
  for (const r of results) io.stdout.write(r.ok ? `rolled back ${r.name}: ${r.from} → ${r.to ?? '?'}\n` : `failed ${r.name}: ${r.error ?? 'failed'}\n`)
  if (failed.length === 0) io.stdout.write('Installs and updates keep these versions until a newer release than the one rolled back is out; run `buracle rollback toolchain` again to undo this.\n')
  return failed.length === 0 ? 0 : 1
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const p = parseFlags(argv, { flags: { list: 'bool', json: 'bool' } })
  const json = io.flags.json || p.bools.has('json')
  if (p.errors.length === 0 && p.positionals[0] === 'toolchain' && !p.bools.has('list')) return runToolchainRollback(p.positionals.slice(1), io, json)
  if (p.errors.length > 0 || p.positionals.length > 1) {
    io.stderr.write(`buracle rollback: ${[...p.errors, ...(p.positionals.length > 1 ? ['at most one transaction id'] : [])].join('; ')}\n${usage}\n`)
    return 1
  }
  if (p.bools.has('list')) {
    const txns = await listTxns()
    if (json) writeJson(io.stdout, txns.map(j => ({ txn: j.txn, status: j.status, run: j.run, startedAt: j.startedAt, finishedAt: j.finishedAt, rolledBackAt: j.rolledBackAt, plans: j.plans, files: j.files?.length ?? 0, execs: j.execs?.length ?? 0, backupsPruned: j.backupsPruned === true })))
    else if (txns.length === 0) io.stdout.write('No transactions recorded.\n')
    else io.stdout.write(table([['TXN', 'STATUS', 'STARTED', 'FILES', 'EXECS', 'PLANS', 'RUN'], ...txns.map(journalRow)]))
    return 0
  }
  let report: RollbackReport & { txns: string[] }
  try {
    report = await withTxnLock(async () => {
      const id = p.positionals[0]
      if (id !== undefined) {
        const r = await rollbackTxn(id)
        const j = (await listTxns()).find(x => x.txn === r.txn)
        if (j !== undefined && isUninstallJournal(j)) r.warnings.push('this was an uninstall transaction: its files are back, but the commands it undid (e.g. plugin registrations) were not re-run; run `buracle install` to complete the setup')
        return merge([r])
      }
      const reports: RollbackReport[] = []
      for (const j of await newestRun()) reports.push(await rollbackTxn(j.txn))
      return merge(reports)
    })
  } catch (e) {
    if (json) writeJson(io.stdout, { ok: false, error: errText(e) })
    else io.stderr.write(`buracle rollback: ${tildeText(errText(e))}\n`)
    return 1
  }
  const code = report.errors.length > 0 ? 1 : report.skipped.length > 0 || report.warnings.length > 0 ? 2 : 0
  if (json) {
    writeJson(io.stdout, { ok: code === 0, code, ...report })
    return code
  }
  io.stdout.write(`Rolled back ${report.txns.join(', ')}: restored ${report.restored.length} path(s)${report.undone.length > 0 ? `, undid ${report.undone.length} command(s)` : ''}.\n`)
  for (const r of report.restored) io.stdout.write(`  restored ${tilde(r)}\n`)
  for (const u of report.undone) io.stdout.write(`  undid ${u}\n`)
  if (report.skipped.length > 0) {
    io.stdout.write('Left as is (changed after the transaction):\n')
    for (const s of report.skipped) io.stdout.write(`  - ${tilde(s.path)}: ${s.reason}\n`)
  }
  for (const w of report.warnings) io.stderr.write(`warning: ${tildeText(w)}\n`)
  for (const e of report.errors) io.stderr.write(`error: ${tildeText(e)}\n`)
  if (report.errors.length > 0) io.stderr.write(`Fix the problems above, then run \`buracle rollback ${report.txn}\` again.\n`)
  return code
}
