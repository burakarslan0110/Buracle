import { existsSync } from 'node:fs'
import type { CommandIO } from '../router'
import type { Adapter } from '../../adapters/registry'
import * as paths from '../../engine/paths'
import { diffPlan, isTxnInterrupted, newRunId, readJournal, readLedger, withTxnLock, type Journal, type Ledger, type Op, type Plan } from '../../engine/txn'
import { parseFlags, removedFlags } from '../../engine/update/args'
import { liveContext } from '../../engine/update/context'
import { opsDeps } from '../../engine/update/deps'
import { applyWithRetry, buracleHomeProblem, checkHome, keyPath, partitionEscapes, readInstallRecord, writeInstallRecord } from '../../engine/update/install-core'
import { errText, tilde, tildeText, writeJson } from '../../engine/update/output'
import {
  adapterUndoArgvs, adapterUninstallPlans, composeUninstall, journalsForUninstall, markAdapterUndos, projectLeftovers, pruneCreatedDirs, pruneEmptyRuleDirs, purgeState,
  removedKeys, removeVaultPreCommitHook, runExecUndos, stopMemoryUi, type AdapterUninstall, type ProjectLeftover,
} from '../../engine/update/uninstall'

export const name = 'uninstall'
export const summary = 'Remove everything Buracle installed (ledger-proven), undo its commands; never touches the memory'
export const usage = `Usage: buracle uninstall [--purge-state] [--dry-run] [--yes] [--json]

Removes only what the ownership ledger proves Buracle wrote and that still holds
Buracle's content. Values you changed are kept and reported; values that were
already yours before Buracle (adopted) are left in place, and so are the keys
you added to config.yaml. A harness adapter's own uninstall plan
runs first (e.g. \`omp plugin uninstall buracle-omp\`); commands that a committed
transaction ran (e.g. \`claude plugin install\`) are then undone with their
recorded undo command, once. Then each harness's files and keys are removed in
transactions of their own, Buracle's core (the shim, the PATH link) last: one
harness failing never rolls back the others. A harness that is running (Codex
rewrites its own config) is left alone and reported. The whole uninstall holds
the transaction lock. The memory (~/.buracle/brain, the CortexDB files) is never
touched, not even by --purge-state; neither is the old Obsidian vault
(~/Documents/Buracle).

Outside the ledger: the memory web UI is stopped; the old vault's pre-commit hook
is removed when it is Buracle's (an older Buracle's secret scan, which would refuse
every commit once Buracle is gone; a hook you wrote stays). Files Buracle wrote into your
projects without a ledger entry (the .codegraph/ index, the managed blocks of
.sembleignore and .git/info/exclude, .claude/skills links to .agents/skills) are
listed with how to remove them, never deleted. The toolchain (~/.buracle/toolchain)
stays unless --purge-state is given.

In a terminal it asks when a rare case comes up, and the answer is no unless you say yes: a
harness is running (change its config anyway?), config files are links that lead outside your
home folder (change them?), a step failed while --purge-state was given (delete the state
anyway?). Without a terminal, or with --yes, every answer is no.

Options:
  --purge-state         also delete ~/.buracle state (state/, sessions/, run/, cache/, logs/,
                        backups/, journal/, bin/, context-mode/ with Context Mode's session
                        data, toolchain/ with the npm and uv packages, runtime/ with the
                        frozen runtimes the hooks run); config.yaml and the memory
                        (brain/) are kept.
                        Skipped when anything failed, so the records stay for a retry. When
                        BURACLE_HOME is not a directory of Buracle's own, only Buracle's files
                        are removed there. System tools installed with Homebrew, winget or
                        scoop stay installed.
  --dry-run            show what would be removed and which undo commands would run
  --yes, -y             do not ask for confirmation (required when stdin is not a terminal)
  --json                machine-readable result

Exit codes: 0 ok, 1 error (Buracle's core could not be removed), 2 items kept, an
undo, a harness or a running harness left out, or confirmation needed;
130/143 interrupted.`

interface UninstallResult {
  ok: boolean
  code: number
  dryRun: boolean
  txns: string[]
  run: string
  removed: number
  kept: Array<{ path: string, detail: string }>
  adopted: string[]
  protected: string[]
  harnesses: string[]
  busy: string[]
  undone: string[]
  undoFailed: Array<{ command: string, detail: string }>
  undoSkipped: Array<{ command: string, detail: string }>
  pendingUndos: string[]
  purged: string[]
  purgeKept: string[]
  prunedDirs: string[]
  memoryUi: string
  vaultHook: string
  projectLeftovers: ProjectLeftover[]
  diff?: string
  errors: string[]
  warnings: string[]
  notes: string[]
  interrupted?: string
}

function display(key: string): string {
  const i = key.indexOf('#')
  return i >= 0 ? `${tilde(keyPath(key))} ${key.slice(i + 1)}` : tilde(key)
}

type ExecOp = Extract<Op, { kind: 'exec' }>

function execArgvs(p: AdapterUninstall): string[][] {
  return p.plan.ops.filter((op): op is ExecOp => op.kind === 'exec').map(op => op.argv)
}

function interruptCode(signal: string): number {
  return 128 + (signal === 'SIGINT' ? 2 : signal === 'SIGHUP' ? 1 : 15)
}

const ASKED = 'run `buracle uninstall` in a terminal; it asks when this case comes up'

const REMOVED_FLAGS: Readonly<Record<string, string>> = {
  force: `${ASKED} (a running harness, or state to delete after a failed step)`,
  'allow-outside-home': `${ASKED} (links that lead outside your home folder)`,
  purge: 'its full name is `--purge-state`',
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const removed = removedFlags(argv, REMOVED_FLAGS)
  if (removed.length > 0) { io.stderr.write(`buracle uninstall: ${removed.join('; ')}\n`); return 1 }
  const p = parseFlags(argv, { flags: { 'purge-state': 'bool', 'dry-run': 'bool', yes: 'bool', json: 'bool' }, aliases: { y: 'yes' } })
  const json = io.flags.json || p.bools.has('json')
  if (p.errors.length > 0 || p.positionals.length > 0) {
    io.stderr.write(`buracle uninstall: ${[...p.errors, ...p.positionals.map(x => `unexpected argument ${x}`)].join('; ')}\n${usage}\n`)
    return 1
  }
  const purge = p.bools.has('purge-state')
  const dryRun = p.bools.has('dry-run')
  const ask = !dryRun && !p.bools.has('yes') && !json && io.stdin.isTTY ? (q: string) => opsDeps.confirm(q) : undefined
  const res: UninstallResult = { ok: true, code: 0, dryRun, txns: [], run: '', removed: 0, kept: [], adopted: [], protected: [], harnesses: [], busy: [], undone: [], undoFailed: [], undoSkipped: [], pendingUndos: [], purged: [], purgeKept: [], prunedDirs: [], memoryUi: 'none', vaultHook: 'missing', projectLeftovers: [], errors: [], warnings: [], notes: [] }
  const finish = (): number => {
    if (json) writeJson(io.stdout, res)
    else render(res, io)
    return res.code
  }
  const fail = (msg: string): number => { res.ok = false; res.code = 1; res.errors.push(msg); return finish() }

  const homeProblem = checkHome()
  if (homeProblem) return fail(homeProblem)
  if (dryRun) {
    try { await uninstallFlow(res, { purge, dryRun, yes: true, allowOutsideHome: false }, io, json) } catch (e) { return fail(errText(e)) }
    return finish()
  }
  try {
    await withTxnLock(() => uninstallFlow(res, { purge, dryRun, yes: p.bools.has('yes'), allowOutsideHome: false, ...(ask !== undefined ? { ask } : {}) }, io, json))
  } catch (e) {
    return fail(errText(e))
  }
  return finish()
}

interface FlowOptions { purge: boolean; dryRun: boolean; yes: boolean; allowOutsideHome: boolean; ask?: (question: string) => Promise<boolean> }

async function uninstallFlow(res: UninstallResult, o: FlowOptions, io: CommandIO, json: boolean): Promise<void> {
  const fail = (msg: string): void => { res.ok = false; res.code = 1; res.errors.push(msg) }
  let ledger: Ledger
  try { ledger = await readLedger() } catch (e) { fail(errText(e)); return }
  const { record } = readInstallRecord()
  let journals: Journal[] = await journalsForUninstall()
  const repoRoot = opsDeps.repoRoot()
  let live = liveContext(repoRoot, { force: false })
  const vault = paths.oldVaultRoot()

  let adapters: Adapter[] = []
  try { adapters = await opsDeps.adapters() } catch (e) { res.warnings.push(`harness adapters could not be loaded (${errText(e)}); only the generic removal runs`) }
  let ad = await adapterUninstallPlans(adapters, live.ctx, ledger, journals, record)
  // This answer covers the running harnesses only; deleting state after a failed step is its own question below.
  if (ad.busy.length > 0 && o.ask !== undefined) {
    const names = ad.busy.map(b => b.harness)
    if (await o.ask(`${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} running; change ${names.length === 1 ? 'its' : 'their'} config anyway?`)) {
      live = liveContext(repoRoot, { force: true })
      ad = await adapterUninstallPlans(adapters, live.ctx, ledger, journals, record)
    }
  }
  for (const e of ad.errors) res.warnings.push(`${e.source}: its uninstall plan failed (${e.error}); the generic removal and the recorded undo commands clean up instead`)
  const busy = new Set<string>(ad.busy.map(b => b.harness))
  res.busy = [...busy]
  for (const b of ad.busy) res.notes.push(`${b.message} Buracle left ${b.harness} as it is; quit it and run \`buracle uninstall\` again (in a terminal it asks whether to change it anyway).`)
  res.harnesses = ad.plans.map(a => a.harness)

  const preview = composeUninstall(ledger, journals, record, vault, { skipKeys: removedKeys(ad.plans), skipUndos: adapterUndoArgvs(ad.plans), skipOwners: busy })
  res.adopted = preview.adopted.map(e => display(e.pointer !== undefined ? `${e.path}#${e.pointer}` : e.path))
  res.protected = preview.protected.map(display)
  res.pendingUndos = [...ad.plans.flatMap(a => execArgvs(a).map(x => x.join(' '))), ...preview.execs.map(u => u.undo.join(' '))]

  const keptDetails = new Set<string>()
  const keep = (plan: Plan, report: boolean): Plan => {
    const r = partitionEscapes([plan], o.allowOutsideHome)
    if (report) {
      for (const c of r.conflicts) {
        if (keptDetails.has(c.detail)) continue
        keptDetails.add(c.detail)
        res.kept.push({ path: c.op.kind === 'exec' ? c.op.argv.join(' ') : c.op.path, detail: c.detail })
      }
    }
    return r.plans[0] as Plan
  }

  if (o.ask !== undefined && !o.allowOutsideHome) {
    const plans = [...ad.plans.map(a => a.plan), ...preview.groups.flatMap(g => [g.content, g.whole])]
    const links = plans.reduce((n, pl) => n + partitionEscapes([pl], false).conflicts.length, 0)
    if (links > 0 && await o.ask(`Change ${links} config file(s) that are links leading outside your home folder?`)) o.allowOutsideHome = true
  }
  const adapterOps = ad.plans.reduce((n, a) => n + keep(a.plan, o.dryRun).ops.filter(op => op.kind !== 'exec').length, 0)
  const total = adapterOps + preview.groups.reduce((n, g) => n + keep(g.content, o.dryRun).ops.length + keep(g.whole, o.dryRun).ops.length, 0)
  if (o.dryRun) {
    try {
      const diffs: string[] = []
      for (const a of ad.plans) diffs.push(await diffPlan(keep(a.plan, false)))
      for (const g of preview.groups) diffs.push(await diffPlan(keep(g.content, false)), await diffPlan(keep(g.whole, false)))
      res.diff = diffs.filter(d => d !== '').join('')
    } catch (e) { fail(errText(e)); return }
    for (const ob of preview.obsolete) res.undoSkipped.push({ command: ob.undo.undo.join(' '), detail: ob.reason })
    res.projectLeftovers = projectLeftovers()
    if (res.warnings.length > 0 || res.busy.length > 0 || res.kept.length > 0) res.code = 2
    return
  }
  if (total > 0 || res.pendingUndos.length > 0) {
    if (!o.yes) {
      const what = `${total} owned item(s)${res.pendingUndos.length > 0 ? ` and ${res.pendingUndos.length} undo command(s)` : ''}`
      if (!io.stdin.isTTY) {
        res.ok = false
        res.code = 2
        res.notes.push(`Nothing was removed: ${what} would be. Re-run with --yes (or --dry-run to see them).`)
        return
      }
      if (!json) io.stdout.write(`buracle uninstall: ${what} will be removed.\n`)
      if (!(await opsDeps.confirm('Uninstall Buracle?'))) {
        res.ok = false
        res.code = 2
        res.notes.push('Cancelled; nothing was removed.')
        return
      }
    }
  }

  const run = newRunId()
  res.run = run
  const failedOwners = new Set<string>()
  const interrupted = (e: unknown): boolean => {
    if (!isTxnInterrupted(e)) return false
    res.interrupted = e.signal
    res.errors.push(errText(e))
    return true
  }
  for (const a of ad.plans) {
    try {
      const r = await applyWithRetry([keep(a.plan, true)], { run })
      let ran: string[][] = []
      if (r.txn !== '') {
        res.txns.push(r.txn)
        try { ran = (await readJournal(r.txn)).execs.filter(e => e.ran).map(e => e.argv) } catch { ran = [] }
      }
      res.removed += Math.max(0, r.applied - ran.length)
      res.undone.push(...ran.map(x => x.join(' ')))
      res.warnings.push(...r.warnings)
      for (const c of r.conflicts) res.kept.push({ path: c.op.kind === 'exec' ? c.op.argv.join(' ') : c.op.path, detail: c.detail })
      await markAdapterUndos(journals, adapterUndoArgvs([a]))
    } catch (e) {
      if (interrupted(e)) break
      res.warnings.push(`${a.harness}: ${errText(e)} (the generic removal below still runs)`)
    }
  }

  if (res.interrupted === undefined) {
    if (ad.plans.length > 0) {
      try { ledger = await readLedger() } catch (e) { fail(errText(e)); return }
      journals = await journalsForUninstall()
    }
    const plan = composeUninstall(ledger, journals, record, vault, { skipOwners: busy })
    const undo = await runExecUndos(plan.execs, record, plan.obsolete)
    res.undone.push(...undo.undone)
    res.undoFailed = undo.failed
    res.undoSkipped = undo.skipped
    res.pendingUndos = []
    for (const g of plan.groups) {
      for (const part of [g.content, g.whole]) {
        const ops = keep(part, true)
        if (ops.ops.length === 0) continue
        try {
          const r = await applyWithRetry([ops], { run })
          if (r.txn !== '') res.txns.push(r.txn)
          res.removed += r.applied
          res.warnings.push(...r.warnings)
          for (const c of r.conflicts) res.kept.push({ path: c.op.kind === 'exec' ? c.op.argv.join(' ') : c.op.path, detail: c.detail })
        } catch (e) {
          if (interrupted(e)) break
          failedOwners.add(g.owner)
          res.errors.push(`${g.owner}: ${errText(e)}`)
          break
        }
      }
      if (res.interrupted !== undefined) break
    }
  }
  if (res.interrupted === undefined) {
    for (const k of Object.keys(record.plans)) if (!failedOwners.has(k) && !busy.has(k)) delete record.plans[k]
  }
  try { writeInstallRecord(record) } catch (e) { res.notes.push(`install record: ${errText(e)}`) }
  pruneEmptyRuleDirs()
  if (failedOwners.size === 0 && res.interrupted === undefined) res.prunedDirs = (await pruneCreatedDirs(vault)).map(tilde)

  const coreFailed = failedOwners.has('core') || failedOwners.has('agents-skills')
  if (res.interrupted === undefined) {
    res.projectLeftovers = projectLeftovers()
    const ui = await stopMemoryUi()
    res.memoryUi = ui.status
    if (ui.status === 'still-running') res.warnings.push(`the memory web UI at ${ui.url ?? '?'} did not stop; end its process by hand`)
    if (!coreFailed) res.vaultHook = await removeVaultPreCommitHook(vault)
  }
  if (!o.purge && existsSync(paths.toolchainDir())) res.notes.push(`The toolchain at ${tilde(paths.toolchainDir())} (npm and uv packages) was kept; \`buracle uninstall --purge-state\` removes it.`)
  if (o.purge) {
    const homeProblem = buracleHomeProblem()
    if (homeProblem !== undefined) {
      res.notes.push(`State was not purged: ${homeProblem}.`)
      res.purgeKept = ['(purge refused)']
    } else if ((res.errors.length > 0 || res.undoFailed.length > 0 || res.busy.length > 0 || res.interrupted !== undefined)
      && !(res.interrupted === undefined && o.ask !== undefined && await o.ask(`Delete state even though ${res.errors.length + res.undoFailed.length + res.busy.length} step(s) failed?`))) {
      res.notes.push('State was not purged because something failed or was left out; the records are kept so `buracle uninstall` can be retried (in a terminal it asks whether to purge anyway).')
    } else {
      const pr = purgeState(vault)
      res.purged = pr.removed.map(tilde)
      res.purgeKept = pr.kept.map(k => tildeText(k))
      if (pr.refused !== undefined) res.notes.push(`State was not purged: ${pr.refused}.`)
    }
  }
  res.notes.push(`The memory at ${tilde(paths.brainDir())} was not touched${existsSync(vault) ? `, nor the old vault at ${tilde(vault)}${res.vaultHook === 'removed' ? ' (only Buracle\'s pre-commit hook in its .git/hooks was removed)' : ''}` : ''}.`)
  if (res.interrupted !== undefined) res.code = interruptCode(res.interrupted)
  else if (coreFailed) res.code = 1
  else if (res.errors.length > 0 || res.kept.length > 0 || res.undoFailed.length > 0 || res.purgeKept.length > 0 || res.warnings.length > 0 || res.busy.length > 0) res.code = 2
  res.ok = res.errors.length === 0 && res.interrupted === undefined
}

function render(r: UninstallResult, io: CommandIO): void {
  const out = io.stdout
  if (r.dryRun) {
    out.write('buracle uninstall --dry-run: nothing was removed.\n')
    out.write(r.diff && r.diff !== '' ? tildeText(r.diff) : '(no owned files or keys)\n')
    if (r.pendingUndos.length > 0) {
      out.write('Undo commands that would run:\n')
      for (const c of r.pendingUndos) out.write(`  - ${tildeText(c)}\n`)
    }
  } else {
    if (r.undone.length > 0) {
      out.write(`Undid ${r.undone.length} command(s):\n`)
      for (const c of r.undone) out.write(`  - ${tildeText(c)}\n`)
    }
    out.write(r.removed > 0 ? `Removed ${r.removed} change(s)${r.txns.length > 0 ? ` (transaction ${r.txns.join(', ')})` : ''}.\n` : 'Nothing owned by Buracle needed removing.\n')
    if (r.prunedDirs.length > 0) out.write(`Removed ${r.prunedDirs.length} empty folder(s) Buracle had created.\n`)
  }
  if (r.undoSkipped.length > 0) {
    out.write(`Undo commands not needed${r.dryRun ? '' : ' (recorded as done)'}:\n`)
    for (const s of r.undoSkipped) out.write(`  - ${tildeText(s.command)}: ${tildeText(s.detail)}\n`)
  }
  if (r.kept.length > 0) {
    out.write('Kept (changed since Buracle wrote them, or not Buracle\'s to change):\n')
    for (const k of r.kept) out.write(`  - ${tildeText(k.detail)}\n`)
  }
  if (r.adopted.length > 0) {
    out.write(`Left in place (already yours before Buracle; adopted)${r.dryRun ? ' would be' : ''}:\n`)
    for (const a of r.adopted) out.write(`  - ${a}\n`)
  }
  if (r.protected.length > 0) {
    out.write('Never touched (inside the old memory vault):\n')
    for (const a of r.protected) out.write(`  - ${a}\n`)
  }
  if (r.undoFailed.length > 0) {
    out.write('Undo commands that failed (fix the cause, then run `buracle uninstall` again):\n')
    for (const f of r.undoFailed) out.write(`  - ${tildeText(f.command)}: ${tildeText(f.detail)}\n`)
  }
  if (r.memoryUi === 'stopped') out.write('Stopped the memory web UI.\n')
  if (r.vaultHook === 'removed') out.write('Removed the old vault\'s pre-commit hook (an older Buracle\'s secret scan).\n')
  else if (r.vaultHook === 'foreign') out.write('Kept the old vault\'s pre-commit hook: it is not Buracle\'s.\n')
  if (r.projectLeftovers.length > 0) {
    out.write(`Left in your projects (not in the ownership ledger; remove them by hand if you want)${r.dryRun ? '' : ':'}\n`)
    for (const l of r.projectLeftovers) out.write(`  - ${l.path}: ${l.what}; ${l.remove}\n`)
  }
  if (r.purged.length > 0) out.write(`Purged: ${r.purged.join(', ')}\n`)
  if (r.purgeKept.length > 0) out.write(`Not purged: ${r.purgeKept.join(', ')}\n`)
  for (const w of r.warnings) io.stderr.write(`warning: ${tildeText(w)}\n`)
  for (const e of r.errors) io.stderr.write(`error: ${tildeText(e)}\n`)
  for (const n of r.notes) out.write(`${n}\n`)
}
