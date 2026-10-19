import { join } from 'node:path'
import type { CommandIO } from '../router'
import { CM_SERVER_ID } from '../../core/context-mode'
import { sanitizeText } from '../../core/status/format'
import * as paths from '../../engine/paths'
import { HARNESSES } from '../../core/events'
import { parseFlags, removedFlags } from '../../engine/update/args'
import { cmSmokeWarning } from '../../engine/update/context-mode-doctor'
import { liveContext, loadBundle } from '../../engine/update/context'
import { opsDeps } from '../../engine/update/deps'
import { bunPath } from '../../engine/update/install-core'
import { probeServers, readHealth, writeHealth } from '../../engine/update/mcp'
import { errText, table, tildeText, writeJson } from '../../engine/update/output'
import { isUpdateKind, UPDATE_KINDS, writeUpdatesCache, type UpdateKind } from '../../engine/update/updates-cache'
import { applyUpdates, checkUpdates, knownPluginNames, partName, revertCheckout, toolDiff, type ApplyOutcome, type CheckResult, type CheckStep, type UpdateEnv } from '../../engine/update/updates'
import { runBuildFlow } from './build'
import type { BuildReport } from '../../engine/update/build'
import { runInstallFlow, type InstallFlowResult } from './install'
import { progressSteps, type Steps } from '../ui/steps'
import { toolchainProgress } from '../ui/toolchain-live'

export const name = 'update'
export const summary = 'Update everything Buracle connects, each part from its own source'
export const usage = `Usage: buracle update [<kind>|<name>…] [--check] [--yes] [--json]

Checks everything Buracle connects and updates each part from its own source, with the
installer that installed it. In a terminal it applies what is new at once, without a
question, and shows each step while it runs: every kind it checks, every part it updates,
the reinstall and the MCP handshake. Without a terminal it only checks, and --yes applies.

  --check    only check: compare with the newest releases and write
             ~/.buracle/state/updates.json (the status line's ⬆ count)
  --yes, -y  apply also when stdin is not a terminal

Kinds and names (any number; none means everything):
  self      the Buracle checkout: git fetch; apply: git merge --ff-only, then install
  skills    skill sources (config skills.sources) and skills from \`buracle skills add\`
  mcp       the MCP server packages of the Buracle toolchain (npm, PyPI), at their newest
            release (update.minReleaseAgeDays, 0 by default, can hold younger ones back)
  plugins   Claude Code plugins; the marketplaces are refreshed before they update
  harness   Claude Code, Codex, OpenCode and Oh My Pi, each through the installer that
            installed it (Homebrew, npm, bun or its own updater); the version is read
            again afterwards and the harness's own checks run
  tools     the Homebrew tools and the toolchain's language servers and npm/PyPI tools
  pricing   canonical/pricing.yaml list prices
  <name>    one part, such as codex, context-mode or pyright

A part whose check failed is named as not checked, never as up to date. After an apply
that changed Buracle, a skill source or the prices, Buracle rebuilds and installs again
(without the toolchain step), and the MCP handshake runs again for every server that
moved. A self update that changes package.json or bun.lock runs
\`bun install --frozen-lockfile\` in the checkout; when the follow-up install fails, the
hooks keep the old runtime and the checkout moves back to its previous commit
(\`git reset --keep\`, only while its tracked files have no local changes).

Exit codes: 0 ok, 1 error, 2 some checks or updates failed, were cancelled or need action.`

const REMOVED_FLAGS: Readonly<Record<string, string>> = {
  apply: 'run `buracle update` in a terminal, or `buracle update --yes`',
  'apply-tools': 'the Homebrew tools are part of every update now: `buracle update --yes` or `buracle update tools`',
  only: 'name the kinds or items instead: `buracle update mcp tools`',
}

interface Targets { kinds: UpdateKind[], names: Map<UpdateKind, Set<string>> }

async function resolveTargets(args: readonly string[], env: UpdateEnv): Promise<Targets | { unknown: string[] }> {
  if (args.length === 0) return { kinds: [...UPDATE_KINDS], names: new Map() }
  const { readInstalled } = await import('../../workflow/skill-install')
  const plugins = args.some(a => a.includes('@') || a.startsWith('marketplace:')) ? await knownPluginNames(env) : new Set<string>()
  const owner = (name: string): UpdateKind | undefined => {
    if ((HARNESSES as readonly string[]).includes(name)) return 'harness'
    if (name === 'buracle') return 'self'
    if (name === 'pricing.yaml') return 'pricing'
    if (env.bundle !== undefined && Object.hasOwn(env.bundle.mcp.servers, name)) return 'mcp'
    if (env.bundle?.tools.tools.some(t => t.name === name) === true) return 'tools'
    if (env.config.skills.sources.some(s => s.name === name) || readInstalled().some(s => s.id === name)) return 'skills'
    if (plugins.has(name)) return 'plugins'
    return undefined
  }
  const kinds = new Set<UpdateKind>()
  const names = new Map<UpdateKind, Set<string>>()
  const unknown: string[] = []
  for (const a of args) {
    if (isUpdateKind(a)) { kinds.add(a); continue }
    const k = owner(a)
    if (k === undefined) { unknown.push(a); continue }
    if (!names.has(k)) names.set(k, new Set())
    names.get(k)?.add(a)
  }
  if (unknown.length > 0) return { unknown }
  for (const k of kinds) names.delete(k)
  return { kinds: UPDATE_KINDS.filter(k => kinds.has(k) || names.has(k)), names }
}

function narrow(check: CheckResult, names: Targets['names']): CheckResult {
  const keep = (x: { kind: UpdateKind, id?: string }) => !names.has(x.kind) || (x.id !== undefined && (names.get(x.kind)?.has(x.id) ?? false))
  return { ...check, items: check.items.filter(keep), held: check.held.filter(keep), errors: check.errors.filter(e => e.id === undefined || keep(e)) }
}

// Registries, Homebrew and the harness CLIs write this text; no escape sequence of theirs reaches the terminal.
const line = (s: string): string => sanitizeText(tildeText(s))
const lines = (s: string): string => s.split('\n').map(line).join('\n')

const KIND_TITLE: Readonly<Record<UpdateKind, string>> = {
  self: 'Buracle', skills: 'Skills', mcp: 'MCP servers', plugins: 'Claude Code plugins', harness: 'Harnesses', tools: 'Tools', pricing: 'Prices',
}

// One line per kind while the check runs, counting only the parts the command names.
function checkStepReporter(steps: Steps, names: Targets['names']): (e: CheckStep) => void {
  return e => {
    const id = `check:${e.kind}`
    const title = KIND_TITLE[e.kind]
    if (e.phase === 'start') { steps.start(id, `${title}: checking`); return }
    const r = narrow(e.result, names)
    const error = r.errors.find(x => x.kind === e.kind)
    const unchecked = r.unchecked.find(u => u.kind === e.kind)
    const found = r.items.filter(i => i.kind === e.kind).length
    const held = r.held.filter(h => h.kind === e.kind).length
    const heldText = held > 0 ? `, ${held} held back (too new)` : ''
    if (error !== undefined) steps.done(id, 'err', line(`${title}: the check failed (${error.id !== undefined ? `${error.id}: ` : ''}${firstOf(error.error)})`))
    else if (unchecked !== undefined) steps.done(id, 'skip', line(`${title}: not checked (${unchecked.reason})`))
    else steps.done(id, found > 0 ? 'info' : 'ok', `${title}: ${found > 0 ? `${found} update${found === 1 ? '' : 's'}` : 'up to date'}${heldText}`)
  }
}

const firstOf = (s: string): string => s.trim().split('\n')[0] ?? ''

function renderCheck(io: CommandIO, kinds: readonly UpdateKind[], check: CheckResult, names: Targets['names'], minAgeDays: number): void {
  io.stdout.write(`${checkSummary(kinds, check)}\n`)
  for (const [kind, set] of names) {
    const skipped = (check.unchecked ?? []).some(u => u.kind === kind)
    for (const n of set) if (!check.items.some(i => i.kind === kind && i.id === n) && !check.errors.some(e => e.kind === kind && (e.id === undefined || e.id === n))) io.stdout.write(skipped ? `${n}: not checked\n` : `${n}: up to date\n`)
  }
  if (check.items.length > 0) io.stdout.write(table([['KIND', 'ID', 'CURRENT', 'LATEST', 'ACTION', 'RISK', 'SOURCE', 'NOTE'], ...itemRows(check)]))
  for (const h of check.held) io.stdout.write(`held back: ${h.kind} ${line(h.id)} ${line(h.version)} (released ${h.ageDays} day(s) ago; minimum age ${minAgeDays})\n`)
  for (const n of check.notes) io.stdout.write(`note: ${lines(n)}\n`)
  for (const e of check.errors) io.stderr.write(`error: ${e.kind}${e.id !== undefined ? ` ${line(e.id)}` : ''}: ${lines(e.error)}\n`)
}

export function checkSummary(kinds: readonly string[], check: Pick<CheckResult, 'items' | 'errors'> & Partial<Pick<CheckResult, 'unchecked'>>): string {
  const unchecked = check.unchecked ?? []
  const failed = kinds.filter(k => check.errors.some(e => e.kind === k))
  const skipped = kinds.filter(k => !failed.includes(k) && unchecked.some(u => u.kind === k))
  const ok = kinds.filter(k => !failed.includes(k) && !skipped.includes(k))
  const notChecked = failed.length > 0 ? `Not checked (the check failed; errors below): ${failed.join(', ')}.` : ''
  const notRun = skipped.map(k => `Not checked: ${k} (${unchecked.filter(u => u.kind === k).map(u => u.reason).join('; ')}).`).join('\n')
  if (check.items.length > 0) return [notChecked, notRun, `${check.items.length} update(s) available:`].filter(Boolean).join('\n')
  if (failed.length === 0) {
    const upToDate = ok.length > 0 ? `${skipped.length === 0 ? 'Everything' : 'Everything else'} checked is up to date (${ok.join(', ')}).` : ''
    return [upToDate, notRun].filter(Boolean).join('\n')
  }
  if (ok.length === 0) return [`No check succeeded. ${notChecked}`, notRun].filter(Boolean).join('\n')
  return [`Up to date: ${ok.join(', ')}. ${notChecked}`, notRun].filter(Boolean).join('\n')
}

function itemRows(c: CheckResult): string[][] {
  return c.items.map(i => [i.kind, i.id, i.current ?? '-', i.latest ?? '-', i.action, i.risk, i.source ?? '', i.note ?? ''].map(line))
}

async function followUpSync(outcome: ApplyOutcome, json: boolean, io: CommandIO): Promise<{ code: number, message: string, build?: BuildReport, install?: InstallFlowResult, reverted?: boolean }> {
  if (outcome.selfUpdated) {
    const repo = opsDeps.repoRoot()
    const r = await opsDeps.run([bunPath(), join(repo, 'src', 'cli', 'main.ts'), 'install', '--yes'], { timeoutMs: 900_000, cwd: repo, env: { ...process.env, BURACLE_NO_TOOLCHAIN: '1' } })
    const message = `${r.stdout}${r.stderr}`.trim() || `buracle install exited ${r.code}`
    if (r.code !== 1 || outcome.selfFrom === undefined) return { code: r.code, message }
    const back = await revertCheckout(repo, outcome.selfFrom, outcome.depsInstalled === true)
    return { code: 1, reverted: back.ok, message: `${message}\nburacle install failed after the update, so the hooks still run the previous runtime; ${back.message}.` }
  }
  const built = await runBuildFlow({ check: false })
  if (built.report.errors.length > 0) {
    const first = built.report.errors[0]
    return { code: 1, build: built.report, message: `Rebuild failed (${first ? `${first.source}: ${first.error}` : 'unknown error'}); fix it, then run \`buracle install\`.` }
  }
  const installed = await runInstallFlow({ dryRun: false, yes: true, json, silent: true, toolchain: false }, io)
  const message = installed.code === 0 ? `Rebuilt and reinstalled (${installed.applied} change(s)).`
    : installed.code === 2 ? `Rebuilt and reinstalled with conflicts or skipped items (${installed.conflicts.length} conflict(s)); see \`buracle install --dry-run\`.`
    : `Rebuilt, but the reinstall failed: ${installed.errors[0]?.error ?? 'unknown error'}`
  return { code: installed.code, build: built.report, install: installed, message }
}

// After a self update the rest runs with the new code, in a child: it checks again and applies.
async function applyRestWithNewCode(kinds: readonly UpdateKind[], names: Targets['names'], outcome: ApplyOutcome): Promise<number> {
  const repo = opsDeps.repoRoot()
  const named = [...names.entries()].filter(([k]) => k !== 'self').flatMap(([, s]) => [...s])
  const args = [...kinds.filter(k => k !== 'self' && !names.has(k)), ...named]
  const r = await opsDeps.run([bunPath(), join(repo, 'src', 'cli', 'main.ts'), 'update', '--yes', '--json', ...args], { timeoutMs: 1_800_000, cwd: repo, env: { ...process.env } })
  let child: Partial<Pick<ApplyOutcome, 'applied' | 'failed' | 'skipped' | 'harnessChecks'>> & { code?: number } | undefined
  try { child = JSON.parse(r.stdout.trim()) as typeof child } catch { child = undefined }
  if (child === undefined || typeof child.code !== 'number') {
    outcome.failed.push({ kind: 'self', id: 'buracle', error: `the update with the new code failed: ${(r.stderr.trim().split('\n')[0] ?? '') || `exit ${r.code}`}` })
    return 1
  }
  outcome.applied.push(...(child.applied ?? []))
  outcome.failed.push(...(child.failed ?? []))
  outcome.skipped.push(...(child.skipped ?? []))
  outcome.harnessChecks.push(...(child.harnessChecks ?? []))
  return child.code
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const removed = removedFlags(argv, REMOVED_FLAGS)
  if (removed.length > 0) { io.stderr.write(`buracle update: ${removed.join('; ')}\n`); return 1 }
  const p = parseFlags(argv, { flags: { check: 'bool', yes: 'bool', json: 'bool' }, aliases: { y: 'yes' } })
  const json = io.flags.json || p.bools.has('json')
  const problems = [...p.errors]
  if (p.bools.has('check') && p.bools.has('yes')) problems.push('--check and --yes are mutually exclusive (--check never applies)')
  if (problems.length > 0) {
    io.stderr.write(`buracle update: ${problems.join('; ')}\n${usage}\n`)
    return 1
  }
  const repoRoot = opsDeps.repoRoot()
  const live = liveContext(repoRoot)
  const loaded = loadBundle(repoRoot)
  let adapters
  try { adapters = await opsDeps.adapters() } catch (e) { io.stderr.write(`buracle update: ${errText(e)}\n`); return 1 }
  const env: UpdateEnv = { repoRoot, config: live.config, adapters, nowMs: opsDeps.now(), ctx: live.ctx }
  if ('bundle' in loaded) env.bundle = loaded.bundle
  const targets = await resolveTargets(p.positionals, env)
  if ('unknown' in targets) {
    io.stderr.write(`buracle update: unknown kind or name ${targets.unknown.join(', ')} (kinds: ${UPDATE_KINDS.join(', ')}; names: a harness, an MCP server, a tool, a skill or a plugin)\n`)
    return 1
  }
  const kinds = targets.kinds
  const checkedAt = new Date(env.nowMs).toISOString()
  const yes = p.bools.has('yes')
  const checkOnly = p.bools.has('check')
  // A terminal applies at once; without one, only --yes applies.
  const interactive = !yes && !checkOnly && !json && io.stdin.isTTY
  const steps = progressSteps(io, json)
  try {
    steps.title(checkOnly ? 'update --check' : 'update')
    const full = await checkUpdates(kinds, env, steps.live ? checkStepReporter(steps, targets.names) : undefined)
    try {
      writeUpdatesCache({ checked_at: checkedAt, kinds, items: full.items, held: full.held, errors: full.errors })
    } catch (e) {
      full.notes.push(`could not write ${paths.updatesFile()}: ${errText(e)}`)
    }
    const check = narrow(full, targets.names)
    const minAge = live.config.update.minReleaseAgeDays

    if (!yes && !interactive) {
      const failedKinds = kinds.filter(k => check.errors.some(e => e.kind === k))
      const code = check.errors.length > 0 ? (check.items.length === 0 && failedKinds.length === kinds.length ? 1 : 2) : 0
      if (json) { writeJson(io.stdout, { ok: code === 0, code, checked_at: checkedAt, kinds, ...check }); return code }
      renderCheck(io, kinds, check, targets.names, minAge)
      if (check.items.length > 0 && !checkOnly) io.stdout.write('Apply with `buracle update --yes` (name kinds or items to limit it).\n')
      return code
    }

    const actionable = check.items.filter(i => !['report', 'manual', 'review', 'monitor'].includes(i.action))
    if (interactive) {
      // The live steps already named what is new; without them, the table does.
      if (!steps.live || actionable.length === 0) renderCheck(io, kinds, check, targets.names, minAge)
      if (actionable.length === 0) return check.errors.length > 0 ? 2 : 0
    }
    const restActionable = actionable.filter(i => i.kind !== 'self')
    const splitSelf = actionable.some(i => i.kind === 'self') && restActionable.length > 0
    steps.section('Updating')
    const progress = toolchainProgress(io, { quiet: json, title: false, ...(steps.live ? { live: steps.list } : {}) })
    const stepEnv: Partial<UpdateEnv> = steps.live ? { onStep: e => (e.phase === 'start' ? steps.start(e.id, line(firstOf(e.label))) : steps.done(e.id, e.outcome, line(firstOf(e.label)))) } : {}
    let outcome: ApplyOutcome
    try {
      outcome = await applyUpdates(splitSelf ? check.items.filter(i => i.kind === 'self') : check.items, { ...env, ...stepEnv, onToolchainEvent: progress.onEvent })
    } finally {
      progress.stop()
    }
    const warnings: string[] = []
    if (outcome.applied.some(a => a.kind === 'mcp' && a.id === CM_SERVER_ID)) {
      const w = await cmSmokeWarning()
      if (w !== undefined) warnings.push(w)
    }
    let sync: Awaited<ReturnType<typeof followUpSync>> | undefined
    if (outcome.rebuild) {
      const self = outcome.selfUpdated
      steps.start('sync', self ? 'Installing the new Buracle' : 'Rebuilding and installing again')
      sync = await followUpSync(outcome, json, io)
      const what = sync.code === 0 ? 'Installed the new Buracle' : sync.code === 2 ? 'Installed the new Buracle, with points to look at (below)' : 'Installing the new Buracle failed (below)'
      steps.done('sync', sync.code === 0 ? 'ok' : sync.code === 2 ? 'warn' : 'err', line(firstOf(self ? what : sync.message)))
    }
    let restCode = 0
    if (splitSelf) {
      const from = partsCount(outcome)
      if (outcome.selfUpdated && sync !== undefined && sync.code !== 1) {
        steps.start('rest', 'Applying the other updates with the new Buracle')
        restCode = await applyRestWithNewCode(kinds, targets.names, outcome)
      } else for (const i of restActionable) outcome.skipped.push({ kind: i.kind, id: i.id, reason: sync?.reverted === true ? 'self update was reverted' : 'the self update did not finish' })
      showParts(steps, outcome, from, 'rest')
    }
    const handshakes: Array<{ id: string, status: string, tools?: number, version?: string, added: string[], removed: string[], error?: string }> = []
    if (outcome.bumpedServers.length > 0) {
      steps.start('handshake', `MCP handshake: ${outcome.bumpedServers.join(', ')}`)
      const after = loadBundle(repoRoot)
      if ('bundle' in after) {
        const before = readHealth()
        const now = () => new Date(opsDeps.now()).toISOString()
        const entries = await probeServers(after.bundle.mcp, { ids: outcome.bumpedServers, timeoutMs: 60_000, fetcher: opsDeps.fetch, buracle: paths.shimPath() }, now)
        try { writeHealth({ mcp: entries }, now()) } catch {  }
        for (const [id, e] of Object.entries(entries)) {
          const d = toolDiff(before?.mcp[id]?.toolNames, e.toolNames)
          const h: (typeof handshakes)[number] = { id, status: e.status, added: before?.mcp[id]?.toolNames ? d.added : [], removed: d.removed }
          if (e.tools !== undefined) h.tools = e.tools
          if (e.version !== undefined) h.version = e.version
          if (e.error !== undefined) h.error = e.error
          handshakes.push(h)
        }
      }
      const down = handshakes.filter(h => h.status !== 'ok').length
      if (handshakes.length === 0) steps.done('handshake', 'skip', 'MCP handshake: not run (canonical/ could not be loaded)')
      else steps.done('handshake', down > 0 ? 'err' : 'ok', `MCP handshake: ${handshakes.length - down} ok${down > 0 ? `, ${down} not ok (below)` : ''}`)
    }
    const done = new Set(outcome.applied.map(a => `${a.kind}\0${a.id}`))
    try {
      writeUpdatesCache({ checked_at: checkedAt, kinds, items: full.items.filter(i => !done.has(`${i.kind}\0${i.id}`)), held: full.held, errors: full.errors })
    } catch {  }
    const failed = outcome.failed.length > 0 || (sync !== undefined && sync.code === 1) || handshakes.some(h => h.status !== 'ok')
    const attention = outcome.skipped.some(s => s.benign !== true) || outcome.harnessChecks.length > 0 || (sync?.code === 2) || check.errors.length > 0
    const own = failed ? (outcome.applied.length === 0 && outcome.failed.length > 0 ? 1 : 2) : attention ? 2 : 0
    const code = own === 1 || restCode === 1 ? 1 : own === 2 || restCode === 2 ? 2 : 0
    if (json) {
      writeJson(io.stdout, { ok: code === 0, code, checked_at: checkedAt, kinds, check, ...outcome, sync: sync ?? null, handshakes, warnings })
      return code
    }
    if (steps.live) {
      // Each part already has its line above; this is the tally.
      const n = outcome.applied.length + outcome.skipped.length + outcome.failed.length
      io.stdout.write(n === 0 ? `\nNothing was applied. ${checkSummary(kinds, check)}\n` : `\n${outcome.applied.length} updated · ${outcome.skipped.length} skipped · ${outcome.failed.length} failed\n`)
      for (const h of check.held) io.stdout.write(`held back: ${h.kind} ${line(h.id)} ${line(h.version)} (released ${h.ageDays} day(s) ago; minimum age ${minAge})\n`)
    } else {
      if (outcome.applied.length === 0 && outcome.failed.length === 0 && outcome.skipped.length === 0) io.stdout.write(`Nothing to apply. ${checkSummary(kinds, check)}\n`)
      for (const a of outcome.applied) io.stdout.write(`applied  ${a.kind} ${line(a.id)}: ${lines(a.detail)}\n`)
      for (const s of outcome.skipped) io.stdout.write(`skipped  ${s.kind} ${line(s.id)}: ${lines(s.reason)}\n`)
      for (const f of outcome.failed) io.stderr.write(`failed   ${f.kind} ${line(f.id)}: ${lines(f.error)}\n`)
    }
    for (const c of outcome.harnessChecks) io.stderr.write(`${c.level === 'error' ? 'error' : 'warning'}: ${c.harness} ${line(c.check)}: ${lines(c.detail)}\n`)
    if (sync && (!steps.live || sync.code !== 0)) io.stdout.write(`${lines(sync.message)}\n`)
    for (const h of handshakes) {
      io.stdout.write(`${line(`handshake ${h.id}: ${h.status}${h.tools !== undefined ? `, ${h.tools} tool(s)` : ''}${h.version !== undefined ? `, v${h.version}` : ''}${h.added.length > 0 ? `, new tools: ${h.added.join(', ')}` : ''}${h.removed.length > 0 ? `, removed tools: ${h.removed.join(', ')}` : ''}${h.error !== undefined ? ` (${tildeText(h.error)})` : ''}`)}\n`)
    }
    if (outcome.pinsBumped) io.stdout.write('canonical/mcp.yaml changed: review and commit it.\n')
    for (const n of check.notes) io.stdout.write(`note: ${lines(n)}\n`)
    for (const e of check.errors) io.stderr.write(`error: ${e.kind}${e.id !== undefined ? ` ${line(e.id)}` : ''}: ${lines(e.error)}\n`)
    for (const w of warnings) io.stderr.write(`warning: ${lines(w)}\n`)
    return code
  } finally {
    steps.stop()
  }
}

function partsCount(o: ApplyOutcome): { applied: number, skipped: number, failed: number } {
  return { applied: o.applied.length, skipped: o.skipped.length, failed: o.failed.length }
}

// The parts added to the outcome since `from`, one line each; the first takes the running step's place.
function showParts(steps: Steps, o: ApplyOutcome, from: ReturnType<typeof partsCount>, id: string): void {
  if (!steps.live) return
  const parts = [
    ...o.applied.slice(from.applied).map(a => ({ outcome: 'ok' as const, text: `${partName(a.kind, a.id)}: ${a.detail}` })),
    ...o.skipped.slice(from.skipped).map(s => ({ outcome: s.benign === true ? 'ok' as const : 'skip' as const, text: `${partName(s.kind, s.id)}: ${s.reason}` })),
    ...o.failed.slice(from.failed).map(f => ({ outcome: 'err' as const, text: `${partName(f.kind, f.id)}: ${f.error}` })),
  ]
  if (parts.length === 0) parts.push({ outcome: 'ok', text: 'Other updates: nothing left to apply' })
  parts.forEach((p, i) => steps.done(i === 0 ? id : `${id}#${i}`, p.outcome, line(firstOf(p.text))))
}
