import { existsSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import type { CommandIO } from '../router'
import type { Harness } from '../../core/events'
import { HARNESSES, isHarness } from '../../core/events'
import { loadConfigSync, writeRuntimeConfig } from '../../engine/config'
import { ensureDirSync } from '../../engine/fsx'
import { clearRuntimeDriftCache } from '../../engine/hook-health'
import * as paths from '../../engine/paths'
import {
  applyPlans, diffPlan, isTxnInterrupted, ledgerRebuildable, newRunId, readJournal, readLedger, withTxnLock, type ApplyOptions, type ApplyResult, type Op, type Plan,
} from '../../engine/txn'
import { parseFlags, removedFlags } from '../../engine/update/args'
import { composeInstall, type ComposedPlan, type ComposeResult, type HarnessStatus } from '../../engine/update/compose'
import { liveContext } from '../../engine/update/context'
import { opsDeps } from '../../engine/update/deps'
import { shimReferenceChecks } from '../../engine/update/doctor'
import {
  AGENTS_SKILLS_OWNER, applyWithRetry, bunPath, buracleHomeProblem, checkHome, CORE_OWNER, INSTALL_PHASES, keyPath, markBuracleHome, partitionEscapes, readInstallRecord,
  retargetShim, writeInstallRecord,
} from '../../engine/update/install-core'
import { discardRuntime, planRuntime, pruneRuntimes, readShim, runtimeDirOf, runtimeModeFromEnv, stageRuntime, type RuntimeMode, type RuntimePlan } from '../../engine/update/runtime'
import { errText, isInside, table, tilde, tildeText, writeJson } from '../../engine/update/output'
import { addLocalBinToPath } from '../../engine/update/shell-path'
import { isWindows } from '../../engine/platform'
import type { ToolchainItem } from '../../engine/toolchain/index'
import { lspRecommendationPlan } from '../../adapters/claude/install'
import { codexTrustPlan } from '../../adapters/codex/trust'
import { cliVersion } from '../router'
import { runBuildFlow } from './build'
import { NO_STEPS, progressSteps, type Steps } from '../ui/steps'
import { heading, padEnd, styleFor, wordmark, type Style } from '../ui/style'

export const name = 'install'
export const summary = 'Set up or repair Buracle in every detected harness (first setup included)'
export const usage = `Usage: buracle install [<harness>…] [--dry-run] [--yes] [--json]
       buracle install --script --log <file> [--started <epoch ms>] [--path-note <text>] [--yes]

Sets Buracle up, repairs it, and makes edits in the checkout live, in one command. With
harness names (${HARNESSES.join(', ')}) only those harnesses are installed.
On a new machine it creates ~/.buracle/config.yaml (repo: this checkout), the
~/.buracle/bin/buracle shim and its ~/.local/bin/buracle link, and the memory folder
(~/.buracle/brain), puts ~/.local/bin on PATH in the shell's startup file when PATH
lacks it (macOS and Linux; one marked block, \`buracle uninstall\` takes it out), and says
what is left (a harness to install).

--script is what scripts/install.sh and scripts/install.ps1 run: it prints the Harnesses,
Tools, Memory and Result sections, one line each unless something did not pass, starts the
memory web UI (memory.ui.autostart), runs the checks of \`buracle doctor\` and writes every
detail to the install log (--log). --started is when the script began (the Result line
shows the time taken); --path-note says how install.ps1 put ~/.local/bin on PATH.

It first regenerates harness/ from canonical/ and src/ (\`buracle build\`); a failed build
installs nothing. --dry-run only checks the generated files and prints the diff of every
plan; nothing is written.

Hooks and the CLI run a frozen copy of the checkout, not the checkout itself: install
copies src/, canonical/, harness/ and the runtime packages into ~/.buracle/runtime/<id>,
checks the copy (\`--version\`, and a Claude Code and a Codex PreToolUse hook must deny
\`rm -rf ~\` and let \`ls\` through) and only then points the shim at it. A copy that fails
its check leaves the old runtime live and fails the install. One previous runtime is
kept for \`buracle rollback\`. BURACLE_RUNTIME=checkout makes the shim run the checkout
directly (tests, debugging).

Then it installs the toolchain (toolchain.autoInstall; false skips it): missing system tools through
Homebrew (macOS, or Linux with Homebrew) or winget/scoop (Windows), and every MCP server package and language server
at its newest release (update.minReleaseAgeDays, 0 by default, can wait days) into ~/.buracle/toolchain, staged
and swapped in with the previous copy kept for \`buracle rollback toolchain\`. Then composes:
  - the core plan: ~/.buracle/bin/buracle shim, ~/.local/bin/buracle link, repo: in
    config.yaml, and the path rules Codex and OpenCode read (~/.buracle/rules/paths/<id>.md)
  - the shared skills plan: ~/.agents/skills/<id> -> harness/agents-skills/<id> symlinks
    (when Codex, OpenCode or Oh My Pi is enabled and installed)
  - each enabled and detected harness adapter's install plan
then applies the core and shared plans as one transaction and each harness as its
own: backup -> atomic writes -> journal -> commands -> verify -> ledger -> commit,
rolling that transaction back on failure (or on Ctrl-C). A harness that fails is
reported (exit 2); the others stay installed. Values you changed are kept and
reported as conflicts; items you deleted stay deleted (reported).

In a terminal it applies at once, without a confirmation question, and shows each step while it
runs: the generated files, the toolchain, the plan, the runtime check, each transaction and the
memory. Without a terminal it writes nothing unless --yes is given.

In a terminal it asks when a rare case comes up, once each, and the answer is no unless you
say yes: a harness is running (write its config anyway?), Buracle items you removed (put
them back?), config files that are links leading outside your home folder (write through
them?), a lost ownership ledger (record the values that equal Buracle's as Buracle's own?).
Without a terminal, or with --yes, every answer is no and the next steps say so.
Right after the Codex transaction, Codex's trust records for Buracle's own hooks are
written (their own transaction), so /hooks needs no approval. Right after the Claude
transaction, the official LSP plugins Buracle's language servers replace go on
lspRecommendationNeverPlugins in ~/.claude.json (their own transaction), so Claude
Code's "LSP plugin recommendation" dialog stops offering them. Afterwards it lists
harness-specific next steps (Codex /hooks only when that trust could not be recorded,
the one-time OpenCode service restart, the omp plugin link).

Options:
  --dry-run             check the generated files, print the unified diff of every plan and stop
  --yes, -y             apply when stdin is not a terminal; the rare cases above are answered no
                        without asking
  --json                machine-readable result (the install result plus its build report)

Exit codes: 0 ok, 1 error, 2 conflicts, skipped, running or failed harnesses, or --yes
needed (no terminal); 130/143 interrupted (the running transaction was rolled back).`

export interface InstallFlowOptions {
  harnesses?: Harness[]
  dryRun: boolean
  yes: boolean
  json: boolean
  coreOnly?: boolean
  memInit?: boolean
  force?: boolean
  silent?: boolean
  restore?: boolean
  takeOwnership?: boolean
  allowOutsideHome?: boolean
  toolchain?: boolean
  // Asks the user about a rare case (a running harness, removed items, links outside HOME, a lost
  // ledger); without it every answer is no.
  ask?: (question: string) => Promise<boolean>
  // The live step list on a terminal; a question is only asked while no step runs.
  progress?: Steps
}

export interface ConflictInfo { path: string; kind: string; owner: string; detail: string }

export interface TxnInfo { plan: string; txn: string; applied: number; error?: string }

export interface KeptInfo { path: string; key: string }

export interface InstallFlowResult {
  code: number
  ok: boolean
  dryRun: boolean
  txn: string
  txns: TxnInfo[]
  run: string
  applied: number
  unchanged: number
  pruned: number
  retried: boolean
  conflicts: ConflictInfo[]
  kept: KeptInfo[]
  adopted: string[]
  recovered: string[]
  harnesses: HarnessStatus[]
  plans: Array<{ key: string, ops: number, prunes: number, diff?: string }>
  errors: Array<{ source: string, error: string }>
  warnings: string[]
  steps: string[]
  interrupted?: string
  toolchain?: ToolchainItem[]
  runtime?: { mode: RuntimeMode, id?: string, dir?: string, reused?: boolean, pruned?: string[] }
  busyHarnesses?: Harness[]
  removedItems?: number
  outsideLinks?: number
  ledgerLost?: boolean
  /** The shell startup file the install added ~/.local/bin to (POSIX, only when PATH lacked it). */
  pathAdded?: string
}

function emptyResult(dryRun: boolean): InstallFlowResult {
  return { code: 0, ok: true, dryRun, txn: '', txns: [], run: '', applied: 0, unchanged: 0, pruned: 0, retried: false, conflicts: [], kept: [], adopted: [], recovered: [], harnesses: [], plans: [], errors: [], warnings: [], steps: [] }
}

function keptOf(skipped: ApplyResult['skipped']): KeptInfo[] {
  const out: KeptInfo[] = []
  for (const s of skipped) {
    const key = /^kept user value \((.+)\)$/.exec(s.reason)?.[1]
    if (key !== undefined && 'path' in s.op) out.push({ path: s.op.path, key })
  }
  return out
}

function conflictInfo(c: { op: Op, detail: string }): ConflictInfo {
  const op = c.op
  const path = op.kind === 'exec' ? op.argv.join(' ') : op.path
  return { path, kind: op.kind, owner: op.owner, detail: c.detail }
}

function verbose(io: CommandIO, opts: InstallFlowOptions, phase: string): void {
  if (!io.flags.verbose || opts.silent || opts.json) return
  const i = INSTALL_PHASES.findIndex(p => p.id === phase)
  io.stderr.write(`[${i + 1}/${INSTALL_PHASES.length}] ${phase}\n`)
}

function andList(names: readonly string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function foundLine(composed: ComposeResult): string {
  const names = composed.harnesses.filter(h => h.included).map(h => HARNESS_TITLE[h.harness])
  return names.length === 0 ? 'Harnesses: none to install into' : `Harnesses: ${andList(names)}`
}

const changes = (n: number): string => `${n} change${n === 1 ? '' : 's'}`

function groupTitle(key: string): string {
  return key === 'core' ? 'Shim, PATH link and shared skills' : HARNESS_TITLE[key as Harness] ?? key
}

function harnessRows(hs: HarnessStatus[]): string[][] {
  return hs.map(h => [h.harness, h.version ?? '-', h.included ? 'install' : `skipped: ${h.reason ?? 'not selected'}`])
}

async function memorySteps(): Promise<string[]> {
  const steps: string[] = []
  const reason = (r: { code: number, stderr: string }) => (r.stderr.trim().split('\n')[0] ?? '').slice(0, 160) || `exit ${r.code}`
  try {
    const { checkCortexdb } = await import('../../engine/toolchain/cortexdb')
    const bin = checkCortexdb()
    if (bin.status !== 'ok') steps.push(`Memory: ${bin.detail}.`)
    const { legacyPending } = await import('../../memory/migration-state')
    if (bin.status === 'ok' && legacyPending()) {
      const r = await opsDeps.runCli(['mem', 'migrate', '--json'])
      steps.push(r.code === 0
        ? 'Folded the brain files of Buracle 0.5 (person.db, projects/) into ~/.buracle/brain/brain.db: verified copies first (brain/backups/pre-migrate-*), nothing deleted; `buracle mem migrate --rollback` goes back.'
        : `Fold the brain files of Buracle 0.5 into brain.db: run \`buracle mem migrate\` (${reason(r)}).`)
    }
    const { oldVaultPath, vaultImportDone } = await import('../../memory/import-vault')
    const vault = oldVaultPath()
    const { removeVaultPreCommitHook } = await import('../../engine/update/uninstall')
    if (await removeVaultPreCommitHook(vault) === 'removed') steps.push(`Removed Buracle's pre-commit hook from the old vault ${tilde(vault)} (manual commits there work again; the notes are untouched).`)
    const hasNotes = existsSync(join(vault, 'projects')) || existsSync(join(vault, 'global'))
    if (bin.status === 'ok' && hasNotes && vaultImportDone() === undefined) {
      const r = await opsDeps.runCli(['mem', 'import-vault', '--vault', vault, '--json'])
      if (r.code !== 0) steps.push(`Import the old vault's notes into the memory: run \`buracle mem import-vault\` (${reason(r)}).`)
      else {
        let n = 0
        try { const j = JSON.parse(r.stdout) as { imported?: unknown[] }; n = Array.isArray(j.imported) ? j.imported.length : 0 } catch {  }
        steps.push(`Imported ${n} memor${n === 1 ? 'y' : 'ies'} from the old vault ${tilde(vault)} into ~/.buracle/brain (the vault was only read; it is yours to keep or delete).`)
      }
    }
    const { removeClaudeRedirects } = await import('../../memory/project-init')
    const redirects = await removeClaudeRedirects()
    if (redirects.removed.length > 0) steps.push(`Took back Claude Code's memory redirect (autoMemoryDirectory) in ${redirects.removed.length} project${redirects.removed.length === 1 ? '' : 's'}; Claude Code's own auto memory is off, Buracle's brain is the memory.`)
    for (const k of redirects.kept.slice(0, 3)) steps.push(`${tilde(k.path)} keeps an autoMemoryDirectory Buracle did not write or that changed (${k.why}); it is unused while Claude Code's auto memory is off.`)
  } catch (e) {
    steps.push(`Memory setup did not finish: ${e instanceof Error ? e.message : String(e)} (run \`buracle mem doctor\`).`)
  }
  return steps
}

function ensureStateDirs(): void {
  markBuracleHome()
  for (const d of [paths.buracleHome(), paths.binDir(), paths.stateDir(), paths.logsDir()]) ensureDirSync(d)
}

type ExecOp = Extract<Op, { kind: 'exec' }>

function planOf(composed: ComposeResult, key: string): ComposedPlan | undefined {
  return composed.plans.find(p => p.key === key)
}

function pendingExecs(composed: ComposeResult, h: Harness, skipped: ApplyResult['skipped']): ExecOp[] {
  const done = new Set(skipped.filter(s => s.op.kind === 'exec').map(s => JSON.stringify((s.op as ExecOp).argv)))
  return (planOf(composed, h)?.plan.ops ?? []).filter((op): op is ExecOp => op.kind === 'exec' && !done.has(JSON.stringify(op.argv)))
}

function isServiceEnvSet(op: ExecOp): boolean {
  return op.argv.slice(1, 4).join(' ') === 'service set env'
}

const OPENCODE_RESTART_AHEAD = 'OpenCode: applying runs `opencode service set env BURACLE_HOME …`, which stops OpenCode\'s background service once; the next `opencode` run starts it again with Buracle\'s environment.'

async function postInstallSteps(composed: ComposeResult, txns: readonly string[], hadCodex: boolean, repoRoot: string, failed: ReadonlySet<string>, codexTrusted = false): Promise<string[]> {
  const included = (h: Harness) => composed.harnesses.some(x => x.harness === h && x.included) && !failed.has(h)
  const files = new Set<string>()
  const ran = new Set<string>()
  for (const t of txns) {
    if (t === '') continue
    try {
      const j = await readJournal(t)
      for (const f of j.files ?? []) files.add(f.path)
      for (const e of j.execs ?? []) if (e.ran) ran.add(JSON.stringify(e.argv))
    } catch {  }
  }
  const ranFor = (h: Harness) => (planOf(composed, h)?.plan.ops ?? []).filter((op): op is ExecOp => op.kind === 'exec' && ran.has(JSON.stringify(op.argv)))
  const steps: string[] = []
  if (included('codex') && !codexTrusted && (!hadCodex || files.has(join(paths.codexHome(), 'hooks.json')))) {
    steps.push('Codex: open Codex and trust the Buracle hooks once with /hooks (Codex skips untrusted hooks; the approval holds while Buracle\'s hook definitions stay the same). `buracle doctor codex` lists the hooks still pending.')
  }
  if (included('opencode') && ranFor('opencode').some(isServiceEnvSet)) {
    steps.push('OpenCode: `opencode service set env BURACLE_HOME` stopped OpenCode\'s background service once so it picks up Buracle\'s environment; the next `opencode` run starts it again (restart OpenCode windows that are open).')
  }
  if (included('omp') && ranFor('omp').length > 0) {
    steps.push(`Oh My Pi: the buracle-omp plugin is linked to ${tilde(join(repoRoot, 'harness', 'omp'))} (\`omp plugin link\`), so \`buracle build\` reaches it without a reinstall. Keep the checkout there (after moving it, run \`buracle install omp\` again) and restart running omp sessions.`)
  }
  if (included('claude') && (ranFor('claude').length > 0 || [...files].some(f => isInside(f, paths.claudeDir()) || f === paths.claudeJson()))) {
    steps.push('Claude Code: run /reload-plugins in open sessions (new sessions pick the changes up automatically).')
  }
  return steps
}

function transactionGroups(composed: ComposeResult, plans: readonly Plan[]): Array<{ key: string, harness?: Harness, plans: Plan[] }> {
  const core: Plan[] = []
  const groups: Array<{ key: string, harness?: Harness, plans: Plan[] }> = []
  composed.plans.forEach((p, i) => {
    const plan = plans[i] as Plan
    if (p.key === 'core' || p.key === 'agents-skills') core.push(plan)
    else groups.push({ key: p.key, harness: p.key as Harness, plans: [plan] })
  })
  return [{ key: 'core', plans: core }, ...groups]
}

export async function runInstallFlow(opts: InstallFlowOptions, io: CommandIO): Promise<InstallFlowResult> {
  const result = emptyResult(opts.dryRun)
  const steps = opts.silent === true || opts.json ? NO_STEPS : opts.progress ?? NO_STEPS
  const fail = (msg: string, code = 1): InstallFlowResult => {
    result.ok = false
    result.code = code
    result.errors.push({ source: 'install', error: msg })
    return result
  }

  verbose(io, opts, 'preflight')
  const homeProblem = checkHome() ?? buracleHomeProblem()
  if (homeProblem) return fail(homeProblem)
  const repoRoot = opsDeps.repoRoot()
  if (paths.isFrozenRuntime(repoRoot)) return fail(`${tilde(repoRoot)} is a frozen runtime, not the checkout; run \`bun src/cli/main.ts install\` in the Buracle checkout`)
  let live = liveContext(repoRoot, { force: opts.force === true })
  for (const e of live.loaded.errors) result.warnings.push(`config: ${e}`)
  for (const w of live.loaded.warnings) result.warnings.push(`config: ${w}`)
  const runtimeMode = runtimeModeFromEnv()
  let runtimePlan: RuntimePlan | undefined
  if (runtimeMode === 'frozen') {
    const planned = planRuntime(repoRoot)
    if ('error' in planned) return fail(`cannot freeze the runtime: ${planned.error}`)
    runtimePlan = planned
    result.runtime = { mode: runtimeMode, id: planned.id, dir: planned.dir }
  } else result.runtime = { mode: runtimeMode }

  verbose(io, opts, 'toolchain')
  const wantToolchain = (opts.toolchain ?? live.config.toolchain.autoInstall) && !opts.coreOnly && process.env['BURACLE_NO_TOOLCHAIN'] !== '1'
  if (wantToolchain) {
    const { runToolchainLive } = await import('../ui/toolchain-live')
    const r = await runToolchainLive({
      install: !opts.dryRun,
      upgrade: !opts.dryRun && live.config.toolchain.upgrade,
      system: !opts.dryRun && live.config.toolchain.system,
      checkLatest: true,
    }, io, { quiet: opts.silent === true || opts.json, ...(steps.live ? { live: steps.list } : {}) })
    if ('error' in r) result.warnings.push(`toolchain: ${r.error}`)
    else {
      result.toolchain = r.items
      for (const i of r.items) {
        if (i.status === 'failed' || (i.status === 'missing' && i.required)) result.warnings.push(`toolchain: ${i.label}: ${i.detail}`)
      }
    }
  }

  verbose(io, opts, 'detect')
  steps.section(opts.dryRun ? 'Preview' : 'Install')
  let composed: ComposeResult
  const compose = async (label: string): Promise<ComposeResult> => {
    steps.start('plan', label)
    try {
      const adapters = opts.coreOnly ? [] : await opsDeps.adapters()
      verbose(io, opts, 'compose')
      const composeOpts: Parameters<typeof composeInstall>[0] = { repoRoot, live, adapters }
      if (opts.harnesses) composeOpts.only = opts.harnesses
      if (opts.coreOnly) composeOpts.coreOnly = true
      const c = await composeInstall(composeOpts)
      steps.done('plan', c.harnesses.some(h => h.included) || opts.coreOnly === true ? 'ok' : 'warn', foundLine(c))
      for (const b of c.busy) steps.done(`busy:${b.harness}`, 'warn', `${HARNESS_TITLE[b.harness]} is running, so it is left out`)
      return c
    } catch (e) {
      steps.done('plan', 'err', `Planning failed: ${errText(e)}`)
      throw e
    }
  }
  try {
    composed = await compose('Finding the harnesses and planning the changes')
    if (composed.busy.length > 0 && opts.ask !== undefined && opts.force !== true) {
      const names = composed.busy.map(b => b.harness)
      if (await opts.ask(`${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} running; write ${names.length === 1 ? 'its' : 'their'} config anyway?`)) {
        live = liveContext(repoRoot, { force: true })
        composed = await compose(`Planning again with ${andList(names.map(h => HARNESS_TITLE[h]))}`)
      }
    }
  } catch (e) {
    return fail(`cannot compose the install: ${errText(e)}`)
  }
  if (runtimePlan !== undefined) {
    const target = { bun: bunPath(), repoRoot, runtime: runtimePlan.dir }
    composed = { ...composed, plans: composed.plans.map(p => (p.key === 'core' ? { ...p, plan: retargetShim(p.plan, target) } : p)) }
  }
  result.harnesses = composed.harnesses
  result.errors.push(...composed.errors)
  result.warnings.push(...composed.warnings)
  result.plans = composed.plans.map(p => ({ key: p.key, ops: p.plan.ops.length, prunes: p.prunes }))
  result.pruned = composed.plans.reduce((n, p) => n + p.prunes, 0)
  result.busyHarnesses = composed.busy.map(b => b.harness)
  for (const b of composed.busy) {
    result.steps.push(`${b.message} (\`buracle install ${b.harness}\` afterwards, or run \`buracle install\` in a terminal to write it anyway)`)
    if (opts.dryRun) result.warnings.push(`${b.harness} is running, so its plan is not part of this preview and \`buracle install\` would skip it now (exit 2): ${b.message}`)
  }
  const requestedButSkipped = composed.busy.length > 0 || (opts.harnesses !== undefined && composed.harnesses.some(h => h.inScope && !h.included))

  let escapes = partitionEscapes(composed.plans.map(p => p.plan), opts.allowOutsideHome === true)
  result.outsideLinks = escapes.conflicts.length
  if (escapes.conflicts.length > 0 && opts.ask !== undefined && opts.allowOutsideHome !== true) {
    if (await opts.ask(`Write through ${escapes.conflicts.length} link(s) that lead outside your home folder?`)) escapes = partitionEscapes(composed.plans.map(p => p.plan), true)
  }
  const plans = escapes.plans
  const escapeConflicts = escapes.conflicts.map(conflictInfo)
  if (escapeConflicts.length > 0 && !opts.dryRun) result.steps.push(`${escapeConflicts.length} config file(s) are links that lead outside your home folder and were left alone; run \`buracle install\` in a terminal to write through them.`)

  const applyOpts: ApplyOptions = { restore: op => opts.restore === true || op.owner === CORE_OWNER, takeOwnership: opts.takeOwnership === true }
  if (opts.takeOwnership !== true) {
    const { record } = readInstallRecord()
    if (!existsSync(paths.ownedLedgerFile()) && Object.keys(record.plans).length > 0 && !ledgerRebuildable()) {
      result.ledgerLost = true
      if (opts.ask !== undefined && await opts.ask('The ownership ledger is gone; record the values that equal Buracle\'s as Buracle\'s own?')) applyOpts.takeOwnership = true
      else result.warnings.push(`the ownership ledger ${tilde(paths.ownedLedgerFile())} is missing and no transaction journal is left to rebuild it: values that equal Buracle's are recorded as yours (adopted) and are never removed. If they are Buracle's, run \`buracle install\` in a terminal and say yes when it asks.`)
    }
  }

  verbose(io, opts, 'preview')
  if (opts.dryRun) {
    steps.start('preview', 'Preparing the diff of every plan')
    try {
      for (const [i, p] of plans.entries()) {
        const d = await diffPlan(p, applyOpts)
        const entry = result.plans[i]
        if (entry) entry.diff = d
      }
    } catch (e) {
      steps.done('preview', 'err', `Preview failed: ${errText(e)}`)
      return fail(`cannot preview the plans: ${errText(e)}`)
    }
    steps.done('preview', 'ok', `Preview ready: ${result.plans.reduce((n, p) => n + p.ops, 0)} operations planned, nothing written`)
    result.conflicts = escapeConflicts
    result.code = result.errors.length > 0 || requestedButSkipped || escapeConflicts.length > 0 ? 2 : 0
    result.ok = result.errors.length === 0
    return result
  }

  let preview
  const compare = async (): Promise<Awaited<ReturnType<typeof applyPlans>>> => {
    steps.start('changes', 'Comparing with what is installed')
    try {
      const p = await applyPlans(plans, { ...applyOpts, dryRun: true })
      steps.done('changes', 'ok', p.applied > 0 ? `${changes(p.applied)} to write` : 'Nothing to change')
      return p
    } catch (e) {
      steps.done('changes', 'err', `The plan is invalid: ${errText(e)}`)
      throw e
    }
  }
  try {
    preview = await compare()
    result.removedItems = preview.conflicts.filter(c => c.removed === true).length
    if (result.removedItems > 0 && opts.ask !== undefined && opts.restore !== true && await opts.ask(`Put back ${result.removedItems} Buracle item(s) you removed?`)) {
      applyOpts.restore = () => true
      preview = await compare()
    } else if (result.removedItems > 0) result.steps.push(`${result.removedItems} Buracle item(s) you removed stay removed; run \`buracle install\` in a terminal to put them back.`)
  } catch (e) {
    return fail(`invalid install plan: ${errText(e)}`)
  }
  const pending = preview.applied
  // A terminal applies at once; without one, only --yes writes.
  if (pending > 0 && !opts.yes && !io.stdin.isTTY) {
    const kept = preview.conflicts.length + escapeConflicts.length
    const summaryLine = `${pending} change(s) to apply across ${plans.filter(p => p.ops.length > 0).map(p => p.id).join(', ') || 'no plans'}${kept > 0 ? `, ${kept} conflict(s) kept as yours` : ''}`
    result.ok = false
    result.code = 2
    result.steps.push(`Nothing was written: ${summaryLine}. Re-run with --yes to apply (or --dry-run to see the diff).`)
    if (pendingExecs(composed, 'opencode', preview.skipped).some(isServiceEnvSet)) result.steps.push(OPENCODE_RESTART_AHEAD)
    return result
  }

  ensureStateDirs()
  const run = newRunId()
  result.run = run
  const failed = new Set<string>()
  const conflicts: ConflictInfo[] = [...escapeConflicts]
  let coreFailed = false
  let attention = false
  let codexTrusted = false
  try {
    await withTxnLock(async () => {
      let staged: Awaited<ReturnType<typeof stageRuntime>> | undefined
      verbose(io, opts, 'runtime')
      if (runtimePlan !== undefined) {
        steps.start('runtime', 'Copying the runtime and checking its hooks')
        try {
          staged = await stageRuntime(runtimePlan, { bun: bunPath(), version: cliVersion(), nowIso: new Date(opsDeps.now()).toISOString() })
        } catch (e) {
          steps.done('runtime', 'err', `The runtime failed its check: ${errText(e)}`)
          throw e
        }
        result.runtime = { mode: 'frozen', id: staged.plan.id, dir: staged.plan.dir, reused: staged.reused }
        steps.done('runtime', 'ok', `${staged.reused ? 'Runtime unchanged' : 'Runtime copied and checked'}: ${tilde(staged.plan.dir)}`)
      }
      verbose(io, opts, 'apply')
      for (const g of transactionGroups(composed, plans)) {
        const title = groupTitle(g.key)
        if (g.plans.every(p => p.ops.length === 0 && (p.cleanupKeys ?? []).length === 0) && g.key !== 'core') {
          steps.done(`txn:${g.key}`, 'ok', `${title}: up to date`)
          continue
        }
        steps.start(`txn:${g.key}`, g.key === 'core' ? 'Writing the shim, the PATH link and the shared skills' : `Writing ${title}'s configuration`)
        try {
          const r = await applyWithRetry(g.plans, { ...applyOpts, run })
          result.txns.push({ plan: g.key, txn: r.txn, applied: r.applied })
          if (result.txn === '' && r.txn !== '') result.txn = r.txn
          result.applied += r.applied
          result.unchanged += r.skipped.filter(s => s.reason === 'unchanged').length
          result.kept.push(...keptOf(r.skipped))
          if (r.retried === true) result.retried = true
          result.recovered.push(...(r.recovered ?? []))
          result.warnings.push(...r.warnings)
          if (r.txn !== '') {
            try { if ((await readJournal(r.txn)).execs.some(e => e.soft === true && e.failed === true)) attention = true } catch {  }
          }
          conflicts.push(...r.conflicts.map(conflictInfo))
          if (g.key === 'core' && staged !== undefined) settleRuntimes(result, staged.plan.dir)
          if (g.key === 'codex') codexTrusted = await applyCodexTrust(result, conflicts, { ...applyOpts, run }, live.config)
          if (g.key === 'claude') await applyClaudeLspHints(result, conflicts, { ...applyOpts, run }, live.ctx)
          const kept = r.conflicts.length
          steps.done(`txn:${g.key}`, kept > 0 ? 'warn' : 'ok', `${title}: ${r.applied > 0 ? changes(r.applied) : 'up to date'}${kept > 0 ? `, ${kept} of your value${kept === 1 ? '' : 's'} kept` : ''}`)
        } catch (e) {
          if (isTxnInterrupted(e)) {
            steps.done(`txn:${g.key}`, 'err', `${title}: interrupted and rolled back`)
            result.interrupted = e.signal
            result.errors.push({ source: g.key, error: errText(e) })
            failed.add(g.key)
            break
          }
          steps.done(`txn:${g.key}`, 'err', `${title}: failed and rolled back (${errText(e)})`)
          result.txns.push({ plan: g.key, txn: '', applied: 0, error: errText(e) })
          result.errors.push({ source: g.key, error: errText(e) })
          failed.add(g.key)
          if (g.key === 'core') {
            coreFailed = true
            if (staged !== undefined && !staged.reused) discardRuntime(staged.plan.dir)
            break
          }
        }
      }
    })
  } catch (e) {
    return fail(errText(e))
  }
  result.conflicts = conflicts
  if (coreFailed || (result.interrupted !== undefined && result.txns.length === 0)) {
    result.ok = false
    result.code = result.interrupted !== undefined ? interruptCode(result.interrupted) : 1
    if (coreFailed) result.steps.push('Nothing was installed into the harnesses: the core transaction (shim, PATH link, config.yaml) failed and was rolled back.')
    return result
  }

  verbose(io, opts, 'record')
  const after = loadConfigSync({ repoRoot })
  try {
    await writeRuntimeConfig(after)
  } catch (e) {
    result.warnings.push(`runtime-config.json: ${errText(e)}`)
  }
  const { record } = readInstallRecord()
  const hadCodex = record.plans['codex'] !== undefined
  const notRecorded = new Set([...composed.errors.map(e => e.source), ...failed])
  if (failed.has('core')) { notRecorded.add('core'); notRecorded.add(AGENTS_SKILLS_OWNER) }
  for (const p of composed.plans) if (!notRecorded.has(p.key)) record.plans[p.key] = { keys: p.keys }
  try { writeInstallRecord(record) } catch (e) { result.warnings.push(`install record: ${errText(e)}`) }
  let ledger: Awaited<ReturnType<typeof readLedger>> = {}
  try {
    ledger = await readLedger()
    const keys = new Set(composed.plans.flatMap(p => p.keys))
    result.adopted = [...keys].filter(k => ledger[k]?.adopted === true || (ledger[k]?.items ?? []).some(i => i.adopted === true)).sort()
  } catch {  }
  for (const c of shimReferenceChecks(ledger, repoRoot)) {
    if (c.level === 'ok') continue
    result.warnings.push(c.detail)
    attention = true
  }

  if (result.interrupted !== undefined) {
    result.ok = false
    result.code = interruptCode(result.interrupted)
    result.steps.push(`Interrupted by ${result.interrupted}: the transaction that was running was rolled back; the ones before it stay applied. Run \`buracle install\` again to finish.`)
    return result
  }

  verbose(io, opts, 'post')
  if (result.runtime?.mode === 'frozen' && result.runtime.reused === false && result.runtime.dir !== undefined) {
    result.steps.push(`Hooks and the CLI now run the runtime ${tilde(result.runtime.dir)}, copied from the checkout and checked; later edits in the checkout go live with \`buracle install\`.`)
  }
  if (opts.memInit !== false) {
    steps.start('memory', 'Checking the memory')
    const mem = await memorySteps()
    steps.done('memory', 'ok', mem.length === 0 ? 'Memory ready' : 'Memory checked (see the next steps)')
    result.steps.push(...mem)
  }
  result.steps.push(...await postInstallSteps(composed, result.txns.map(t => t.txn), hadCodex, repoRoot, failed, codexTrusted))
  for (const h of failed) if (h !== 'core') result.steps.push(`${h}: its transaction failed and was rolled back (the other harnesses stay installed); fix the cause, then run \`buracle install ${h}\`.`)
  const conflictsOrSkips = result.conflicts.length > 0 || requestedButSkipped || result.errors.length > 0 || attention
  result.ok = result.errors.length === 0
  result.code = conflictsOrSkips ? 2 : 0
  return result
}

async function applyCodexTrust(result: InstallFlowResult, conflicts: ConflictInfo[], opts: ApplyOptions, config: Parameters<typeof codexTrustPlan>[0]['config']): Promise<boolean> {
  const plan = codexTrustPlan({ paths, config })
  if (plan === undefined) return false
  try {
    const t = await applyWithRetry([plan], opts)
    if (t.txn !== '') result.txns.push({ plan: 'codex-trust', txn: t.txn, applied: t.applied })
    result.applied += t.applied
    result.warnings.push(...t.warnings)
    conflicts.push(...t.conflicts.map(conflictInfo))
    return t.conflicts.length === 0
  } catch (e) {
    result.warnings.push(`codex: recording Buracle's hooks as trusted failed (${errText(e)}); approve them in Codex with /hooks`)
    return false
  }
}

async function applyClaudeLspHints(result: InstallFlowResult, conflicts: ConflictInfo[], opts: ApplyOptions, ctx: Parameters<typeof lspRecommendationPlan>[0]): Promise<void> {
  try {
    const plan = lspRecommendationPlan(ctx)
    if (plan === undefined) return
    const t = await applyWithRetry([plan], opts)
    if (t.txn !== '') result.txns.push({ plan: plan.id, txn: t.txn, applied: t.applied })
    result.applied += t.applied
    result.warnings.push(...t.warnings)
    conflicts.push(...t.conflicts.map(conflictInfo))
  } catch (e) {
    result.warnings.push(`claude: listing the official LSP plugins under lspRecommendationNeverPlugins in ~/.claude.json failed (${errText(e)}); Claude Code's "LSP plugin recommendation" dialog may still offer them (answer "Never for this plugin", not "Yes")`)
  }
}

function settleRuntimes(result: InstallFlowResult, dir: string): void {
  clearRuntimeDriftCache()
  const live = runtimeDirOf(readShim())
  if (live !== dir) {
    result.warnings.push(`the shim does not run the new runtime ${tilde(dir)}${live !== undefined ? ` (it runs ${tilde(live)})` : ''}; run \`buracle install\` again`)
    return
  }
  try {
    const pruned = pruneRuntimes([dir])
    if (result.runtime !== undefined && pruned.length > 0) result.runtime.pruned = pruned
  } catch (e) {
    result.warnings.push(`old runtimes in ${tilde(paths.runtimeRoot())} could not be removed: ${errText(e)}`)
  }
}

function interruptCode(signal: string): number {
  return 128 + (signal === 'SIGINT' ? 2 : signal === 'SIGHUP' ? 1 : 15)
}

const HARNESS_TITLE: Readonly<Record<Harness, string>> = { claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', omp: 'Oh My Pi' }

// header: false when the live steps already printed the title.
export function renderInstallStyled(r: InstallFlowResult, st: Style, columns = 100, header = true): string {
  const lines: string[] = header ? ['', `  ${wordmark(st)} ${st.muted(r.dryRun ? 'install preview' : 'install')}`, ''] : ['']
  if (r.harnesses.length > 0) {
    lines.push(heading(st, 'Harnesses', columns))
    const w = Math.max(...r.harnesses.map(h => HARNESS_TITLE[h.harness].length))
    for (const h of r.harnesses) {
      const icon = h.included ? st.ok(st.sym.ok) : h.installed ? st.warn(st.sym.warn) : st.muted('-')
      const what = h.included ? st.muted(`${h.version ?? ''} · installed`.replace(/^ · /, '')) : st.muted(h.reason ?? 'not selected')
      lines.push(`  ${icon} ${padEnd(st.bold(HARNESS_TITLE[h.harness]), w)}  ${what}`)
    }
    lines.push('')
  }
  lines.push(heading(st, 'Result', columns))
  if (r.dryRun) lines.push(`  ${st.accent(st.sym.info)} Preview: nothing was written (${r.plans.reduce((n, p) => n + p.ops, 0)} operations planned; --json for details)`)
  else if (r.applied > 0) lines.push(`  ${st.ok(st.sym.ok)} Applied ${r.applied} change${r.applied === 1 ? '' : 's'}${r.unchanged > 0 ? st.muted(` · ${r.unchanged} already up to date`) : ''}${r.retried ? st.muted(' · retried once because a file changed') : ''}`)
  else if (r.errors.length === 0) lines.push(`  ${st.ok(st.sym.ok)} Everything is already up to date`)
  if (r.pruned > 0 && !r.dryRun) lines.push(`  ${st.accent(st.sym.info)} Removed ${r.pruned} leftover item${r.pruned === 1 ? '' : 's'} from earlier installs`)
  if (r.pathAdded !== undefined) lines.push(`  ${st.accent(st.sym.info)} ${pathAddedText(r.pathAdded)}`)
  if (r.recovered.length > 0) lines.push(`  ${st.warn(st.sym.warn)} Rolled back an interrupted transaction: ${r.recovered.join(', ')}`)
  for (const c of r.conflicts) lines.push(`  ${st.warn(st.sym.warn)} Kept your value: ${st.muted(tildeText(c.detail))}`)
  for (const k of r.kept) lines.push(`  ${st.accent(st.sym.info)} Kept your value of ${k.key} in ${st.muted(tilde(k.path))}`)
  if (r.adopted.length > 0) lines.push(`  ${st.accent(st.sym.info)} ${r.adopted.length} value${r.adopted.length === 1 ? '' : 's'} already matched Buracle's; they stay yours and are never removed`)
  for (const w of r.warnings) lines.push(`  ${st.warn(st.sym.warn)} ${tildeText(w)}`)
  for (const e of r.errors) lines.push(`  ${st.err(st.sym.err)} ${e.source}: ${tildeText(e.error)}`)
  if (r.steps.length > 0) {
    lines.push('', heading(st, 'Next steps', columns))
    for (const s of r.steps) lines.push(`  ${st.accent(st.sym.arrow)} ${s}`)
  }
  lines.push('')
  return lines.join('\n')
}

export function renderInstall(r: InstallFlowResult, io: CommandIO, title = 'buracle install', header = true): void {
  const out = io.stdout
  if (out.isTTY === true) {
    out.write(renderInstallStyled(r, styleFor({ isTTY: true }), out.columns !== undefined && out.columns >= 40 ? out.columns : 100, header))
    return
  }
  if (r.harnesses.length > 0) {
    out.write('Harnesses:\n')
    out.write(table(harnessRows(r.harnesses)))
  }
  if (r.dryRun) {
    out.write(`${title} --dry-run: nothing was written.\n`)
    for (const p of r.plans) {
      out.write(`\n== plan ${p.key} (${p.ops} op(s)${p.prunes > 0 ? `, ${p.prunes} stale item(s) to remove` : ''}) ==\n`)
      out.write(p.diff && p.diff !== '' ? tildeText(p.diff) : '(no changes)\n')
    }
  } else if (r.txn !== '' || r.applied > 0) {
    const ids = r.txns.filter(t => t.txn !== '').map(t => t.txn)
    out.write(`Applied ${r.applied} change(s) in transaction${ids.length > 1 ? 's' : ''} ${ids.join(', ')}${r.unchanged > 0 ? ` (${r.unchanged} unchanged)` : ''}${r.retried ? ' after one retry (a file changed during the first attempt)' : ''}.\n`)
  } else if (r.errors.length === 0 && r.code === 0) {
    out.write('Everything is already up to date.\n')
  }
  if (r.pruned > 0 && !r.dryRun) out.write(`Removed stale items from earlier installs: ${r.pruned} planned.\n`)
  if (r.pathAdded !== undefined) out.write(`${pathAddedText(r.pathAdded)}.\n`)
  if (r.recovered.length > 0) out.write(`Recovered (rolled back) interrupted transaction(s): ${r.recovered.join(', ')}\n`)
  if (r.conflicts.length > 0) {
    out.write('Conflicts (your version was kept):\n')
    for (const c of r.conflicts) out.write(`  - ${tildeText(c.detail)}\n`)
  }
  if (r.kept.length > 0) {
    out.write('Kept your values (you changed them; Buracle leaves them as they are):\n')
    for (const k of r.kept) out.write(`  - ${tilde(k.path)} ${k.key}\n`)
  }
  if (r.adopted.length > 0) {
    out.write('Adopted (these already had Buracle\'s value; they stay yours and are never removed):\n')
    for (const a of r.adopted) out.write(`  - ${tilde(keyPath(a))}${a.includes('#') ? ` ${a.slice(a.indexOf('#') + 1)}` : ''}\n`)
  }
  for (const w of r.warnings) io.stderr.write(`warning: ${tildeText(w)}\n`)
  for (const e of r.errors) io.stderr.write(`error: ${e.source}: ${tildeText(e.error)}\n`)
  if (r.steps.length > 0) {
    out.write('Next steps:\n')
    for (const s of r.steps) out.write(`  - ${s}\n`)
  }
}

const ASKED = 'run `buracle install` in a terminal; it asks when this case comes up'

const REMOVED_FLAGS: Readonly<Record<string, string>> = {
  harness: 'name the harnesses instead: `buracle install codex`',
  'no-toolchain': '`buracle config set toolchain.autoInstall false` skips the toolchain step',
  force: `${ASKED} (a running harness)`,
  restore: `${ASKED} (items you removed)`,
  'take-ownership': `${ASKED} (a lost ownership ledger)`,
  'allow-outside-home': `${ASKED} (links that lead outside your home folder)`,
}

function onPath(dir: string): boolean {
  return (process.env['PATH'] ?? '').split(delimiter).some(d => d !== '' && resolve(d) === dir)
}

export function pathAddedText(file: string): string {
  return `Added ${tilde(paths.localBinDir())} to PATH in ${tilde(file)}; open a new terminal to use buracle`
}

// What the first setup of a machine still needs, after the install wrote the shim and its link. A missing
// ~/.local/bin on PATH is fixed in the shell's startup file (POSIX); the hint stays only when that cannot be done.
function firstRunSteps(r: InstallFlowResult): void {
  const hint = `Add ${tilde(paths.localBinDir())} to PATH (e.g. in ~/.zshrc: export PATH="$HOME/.local/bin:$PATH").`
  if (!onPath(paths.localBinDir()) && existsSync(join(paths.localBinDir(), isWindows() ? 'buracle.cmd' : 'buracle'))) {
    const p = addLocalBinToPath()
    if (p.changed && p.file !== undefined) r.pathAdded = p.file
    else if (p.skipped !== 'in-file') r.steps.push(p.reason !== undefined ? `${hint} (${tildeText(p.reason)})` : hint)
  }
  if (r.harnesses.length > 0 && !r.harnesses.some(h => h.installed)) r.steps.push('No enabled harness was found; install one of Claude Code, Codex, OpenCode or Oh My Pi, then run `buracle install`.')
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const removed = removedFlags(argv, REMOVED_FLAGS)
  if (removed.length > 0) { io.stderr.write(`buracle install: ${removed.join('; ')}\n`); return 1 }
  const p = parseFlags(argv, { flags: { 'dry-run': 'bool', yes: 'bool', json: 'bool', script: 'bool', log: 'string', started: 'string', 'path-note': 'string' }, aliases: { y: 'yes' } })
  const json = io.flags.json || p.bools.has('json')
  const bad = p.positionals.filter(h => !isHarness(h))
  if (p.errors.length > 0 || bad.length > 0) {
    const msg = [...p.errors, ...bad.map(h => `unknown harness ${h} (expected ${HARNESSES.join(', ')})`)].join('; ')
    io.stderr.write(`buracle install: ${msg}\n${usage}\n`)
    return 1
  }
  const opts: InstallFlowOptions = { dryRun: p.bools.has('dry-run'), yes: p.bools.has('yes'), json }
  const interactive = !opts.dryRun && !opts.yes && !json && io.stdin.isTTY === true
  const started = Number(p.strings.get('started'))
  const script = p.bools.has('script') && !json && !opts.dryRun
    ? (await import('./install-script')).scriptSession(io, {
      log: p.strings.get('log') ?? paths.installLogFile(new Date(opsDeps.now())),
      startedMs: Number.isFinite(started) && started > 0 ? started : opsDeps.now(),
      ...(p.strings.get('path-note') !== undefined ? { pathNote: p.strings.get('path-note') as string } : {}),
      interactive,
    })
    : undefined
  if (interactive) opts.ask = script?.ask ?? (q => opsDeps.confirm(q))
  const hs = p.positionals.filter(isHarness)
  if (hs.length > 0) opts.harnesses = hs
  const scope = opts.harnesses !== undefined ? { harnesses: opts.harnesses } : {}
  const steps = script?.steps ?? progressSteps(io, json)
  opts.progress = steps
  try {
    steps.title(opts.dryRun ? 'install preview' : 'install')
    steps.start('build', 'Checking the generated files')
    // The generated files are rebuilt only when they differ and the install may write; the install
    // itself writes runtime-config.json, so a declined or dry run leaves the home folder alone.
    let built = await runBuildFlow({ check: true, ...scope })
    if (built.report.errors.length === 0 && built.report.drift.length > 0 && !opts.dryRun && (opts.yes || io.stdin.isTTY)) {
      steps.start('build', 'Rebuilding the generated files')
      built = await runBuildFlow({ check: false, runtimeConfig: false, ...scope })
    }
    const rebuilt = built.report.written.length + built.report.removed.length > 0
    if (built.report.errors.length > 0) {
      const first = built.report.errors[0]
      const why = first !== undefined ? `${first.source}: ${first.error}` : 'unknown error'
      steps.done('build', 'err', `The build failed (${why})`)
      if (script !== undefined) return await script.finish(undefined, `the build failed (${why}); nothing was installed`)
      if (json) writeJson(io.stdout, { ok: false, code: 1, build: built.report, install: null })
      else io.stderr.write(`buracle install: the build failed (${why}); nothing was installed.\n`)
      return 1
    }
    steps.done('build', 'ok', rebuilt ? `Rebuilt the generated files: ${built.report.written.length} written, ${built.report.removed.length} removed`
      : built.report.drift.length > 0 ? `${built.report.drift.length} generated file(s) differ from the sources; a preview does not rebuild them` : 'Generated files are up to date')
    const r = await runInstallFlow(opts, io)
    if (script !== undefined) return await script.finish(r)
    if (!opts.dryRun) firstRunSteps(r)
    if (json) writeJson(io.stdout, { ...r, build: built.report })
    else {
      if (!opts.dryRun && rebuilt && !steps.live) io.stdout.write(`Rebuilt the generated files (${built.report.written.length} written, ${built.report.removed.length} removed).\n`)
      renderInstall(r, io, undefined, !steps.live)
    }
    return r.code
  } finally {
    steps.stop()
  }
}
