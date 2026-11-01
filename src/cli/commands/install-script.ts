import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { isHarness } from '../../core/events'
import * as paths from '../../engine/paths'
import { isWindows } from '../../engine/platform'
import { cortexdbBinary } from '../../engine/toolchain/cortexdb'
import { opsDeps } from '../../engine/update/deps'
import type { DoctorCheck } from '../../engine/update/doctor'
import { table, tilde, tildeText } from '../../engine/update/output'
import { addLocalBinToPath, type ShellPathResult } from '../../engine/update/shell-path'
import type { ToolchainItem } from '../../engine/toolchain/index'
import type { CommandIO } from '../router'
import type { LiveList, Outcome } from '../ui/live'
import { NAME_WIDTH, sectionMode, sectionPrinter, type SectionItem, type SectionName, type SectionPrinter, type SectionResult, type SectionStatus } from '../ui/sections'
import type { Steps } from '../ui/steps'
import { stripAnsi } from '../ui/style'
import type { InstallFlowResult } from './install'

// `buracle install --script`: the part of the install the scripts hand over to (scripts/install.sh and
// scripts/install.ps1 print the logo, Prerequisites and Buracle themselves). It prints Harnesses, Tools, Memory and
// Result in the layout of src/cli/ui/sections.ts, one line each unless something did not pass, and writes every
// detail (the toolchain, the steps, the health check) to the install log the scripts started.

export type UiStartOutcome = { state: 'running' | 'started', url: string } | { state: 'off' } | { state: 'failed', why: string }

export interface ScriptDeps {
  now(): number
  /** The checks of `buracle doctor`, run in this process. */
  doctor(): Promise<DoctorCheck[]>
  /** Starts the memory UI when memory.ui.autostart is on, and waits for its address. */
  startUi(): Promise<UiStartOutcome>
  /** Puts ~/.local/bin on PATH in the shell's startup file (POSIX). */
  addPath(): ShellPathResult
  brain(): { ok: boolean, detail: string }
}

const silentIO = (sink: (s: string) => void): CommandIO => ({
  stdout: { write: sink },
  stderr: { write: () => {} },
  stdin: { isTTY: false, text: async () => '' },
  flags: { json: true, verbose: false },
})

export const scriptDeps: ScriptDeps = {
  now: () => Date.now(),
  async doctor() {
    const { run } = await import('./doctor')
    let out = ''
    await run(['--json'], silentIO(s => { out += s }))
    try { return (JSON.parse(out) as { checks?: DoctorCheck[] }).checks ?? [] } catch { return [] }
  },
  async startUi() {
    if (process.env['BURACLE_NO_AUTOSTART'] === '1') return { state: 'off' }
    const { loadConfigSync } = await import('../../engine/config')
    const cfg = loadConfigSync({ repoRoot: paths.repoRoot() }).config.memory.ui
    if (!cfg.autostart) return { state: 'off' }
    const ui = await import('../../memory/ui')
    const { buracleArgv } = await import('../../usage/bar-info')
    const r = await ui.ensureUi(buracleArgv(), { port: cfg.port })
    return r === undefined ? { state: 'failed', why: 'it did not answer within 8 s; `buracle mem ui --serve` shows why' } : { state: r.started ? 'started' : 'running', url: r.url }
  },
  addPath: () => {
    // Only once the install made the ~/.local/bin/buracle link: before that, the folder holds nothing of Buracle's.
    if (!existsSync(join(paths.localBinDir(), isWindows() ? 'buracle.cmd' : 'buracle'))) return { changed: false, skipped: 'error', reason: 'the buracle link in ~/.local/bin is missing' }
    return addLocalBinToPath()
  },
  brain: () => (cortexdbBinary() !== undefined ? { ok: true, detail: 'brain ok' } : { ok: false, detail: 'brain: CortexDB is missing' }),
}

/** The texts the install keeps for the next run in a terminal are no step the script's reader has to take. */
export function withoutInstallHint(text: string): string {
  return text
    .replace(/buracle install \(installs it into the Buracle toolchain\)/g, 'the toolchain could not install it')
    .replace(/[,;]?\s*(?:then\s+)?run `buracle install[^`]*`(?:\s+(?:again|in a terminal))?/g, '')
    .replace(/\s*\(`buracle install[^)]*\)/g, '')
    .trim()
}

type Declined = 'busy' | 'links' | 'ledger' | 'removed'

function declinedKind(question: string): Declined | undefined {
  if (/ running; write /.test(question)) return 'busy'
  if (/outside your home folder/.test(question)) return 'links'
  if (/ownership ledger/.test(question)) return 'ledger'
  if (/^Put back /.test(question)) return 'removed'
  return undefined
}

const OUTCOME_MARK: Readonly<Record<Outcome, string>> = { ok: 'ok  ', warn: 'warn', err: 'FAIL', info: 'info', skip: 'skip' }

export interface ScriptSession {
  steps: Steps
  ask?: (question: string) => Promise<boolean>
  log(text: string): void
  finish(r: InstallFlowResult | undefined, failure?: string): Promise<number>
}

export interface ScriptOptions {
  log: string
  startedMs: number
  /** install.ps1 put ~/.local/bin on the user PATH and says how (the Result line shows it). */
  pathNote?: string
  /** A terminal answers the install's questions; without one every answer is no and Result names the command. */
  interactive: boolean
}

export function scriptSession(io: CommandIO, opts: ScriptOptions): ScriptSession {
  const mode = sectionMode(io.stdout)
  // A terminal gets lines cut to its width; a pipe (a CI log, a file) keeps them whole. A pty that reports no size
  // (0 columns, as under `expect` or some ssh sessions) counts as 80 columns.
  const reported = io.stdout.columns ?? 0
  const columns = io.stdout.isTTY === true ? (reported > 0 ? reported : 80) : undefined
  const printer: SectionPrinter = sectionPrinter(io.stdout, { live: mode.live, style: mode.style, ...(columns !== undefined ? { columns } : {}) })
  const log = (text: string): void => {
    try {
      mkdirSync(dirname(opts.log), { recursive: true })
      const at = new Date(scriptDeps.now()).toISOString().slice(11, 19)
      // Readable by this user only when this call creates it (the scripts create it so already).
      appendFileSync(opts.log, stripAnsi(text).split('\n').map(l => `[${at}] ${l}`).join('\n') + '\n', { mode: 0o600 })
    } catch {  }
  }
  let phase: SectionName = 'Harnesses'
  const list: LiveList = {
    start(_id, label) { log(`... ${label}`); printer.start(phase, stripAnsi(label)) },
    update(_id, label) { printer.update(stripAnsi(label)) },
    finish(_id, outcome, label) { log(`${OUTCOME_MARK[outcome]} ${label}`) },
    note(line) { log(line) },
    stop() {},
  }
  const steps: Steps = {
    live: true,
    list,
    title() {},
    section(title) { log(`-- ${title}`) },
    start(id, label) {
      if (id === 'plan' || id === 'changes' || id === 'runtime' || id.startsWith('txn:')) phase = 'Harnesses'
      if (id === 'memory') phase = 'Memory'
      list.start(id, label)
    },
    done(id, outcome, label) {
      list.finish(id, outcome, label)
      if (id === 'build') phase = 'Tools'
    },
    stop() { printer.stop() },
  }
  const declined = new Set<Declined>()
  const ask = opts.interactive
    ? async (question: string): Promise<boolean> => {
      printer.stop()
      log(`?    ${question}`)
      const yes = await opsDeps.confirm(question)
      log(yes ? '     yes' : '     no')
      const kind = declinedKind(question)
      if (!yes && kind !== undefined) declined.add(kind)
      return yes
    }
    : undefined

  const finish = async (r: InstallFlowResult | undefined, failure?: string): Promise<number> => {
    printer.stop()
    if (r === undefined) {
      printer.done({ name: 'Harnesses', status: 'fail', detail: withoutInstallHint(failure ?? 'the install did not run') })
      printer.done({ name: 'Result', status: 'fail', detail: `failed · log ${tilde(opts.log)}` })
      return 1
    }
    for (const s of r.steps) log(`next ${s}`)
    for (const w of r.warnings) log(`warn ${w}`)
    for (const e of r.errors) log(`FAIL ${e.source}: ${e.error}`)
    const sections: SectionResult[] = [harnessSection(r, opts.interactive, declined), toolsSection(r.toolchain)]

    phase = 'Memory'
    printer.start('Memory', 'starting the memory web UI')
    const brain = scriptDeps.brain()
    let ui: UiStartOutcome
    try { ui = await scriptDeps.startUi() } catch (e) { ui = { state: 'failed', why: e instanceof Error ? e.message : String(e) } }
    sections.push(memorySection(brain, ui))

    printer.start('Result', 'running the health check (buracle doctor)')
    let checks: DoctorCheck[] = []
    try { checks = await scriptDeps.doctor() } catch (e) { log(`FAIL buracle doctor: ${e instanceof Error ? e.message : String(e)}`) }
    log(`-- buracle doctor\n${table([['SECTION', 'CHECK', 'STATUS', 'DETAIL'], ...checks.map(c => [c.section, c.check, c.level, c.detail.replace(/\s*\n\s*/g, ' / ')])])}`)
    const errors = checks.filter(c => c.level === 'error').length
    let path: string | undefined
    if (opts.pathNote !== undefined && opts.pathNote !== '') path = opts.pathNote
    else {
      const p = scriptDeps.addPath()
      if (p.changed && p.file !== undefined) path = `added in ${tilde(p.file)}`
      else if (p.skipped === 'unsafe' || p.skipped === 'error') log(`warn PATH: ${p.reason ?? 'not added'}`)
    }
    sections.push(resultSection(r, { declined, interactive: opts.interactive, errors, path, secs: Math.max(0, Math.round((scriptDeps.now() - opts.startedMs) / 1000)), log: opts.log, ...(columns !== undefined ? { columns } : {}) }))
    printer.stop()
    for (const s of sections) printer.done(s)
    log(`exit ${r.code}${errors > 0 ? ` (doctor: ${errors} errors)` : ''}`)
    return errors > 0 && r.code === 0 ? 2 : r.code
  }

  return { steps, ...(ask !== undefined ? { ask } : {}), log, finish }
}

function worst(items: readonly SectionItem[], base: SectionStatus = 'ok'): SectionStatus {
  if (items.some(i => i.status === 'fail')) return 'fail'
  if (items.some(i => i.status === 'warn' || i.status === 'skip')) return 'warn'
  return base
}

function harnessSection(r: InstallFlowResult, interactive: boolean, declined: ReadonlySet<Declined>): SectionResult {
  const included = r.harnesses.filter(h => h.included).map(h => h.harness)
  const absent = r.harnesses.filter(h => h.enabled && h.inScope && !h.installed).map(h => h.harness)
  const items: SectionItem[] = []
  for (const h of r.busyHarnesses ?? []) {
    items.push({ status: 'warn', name: h, detail: interactive && declined.has('busy') ? 'skipped · still running (you said no)' : 'skipped · running' })
  }
  const failed = new Set<string>()
  for (const t of r.txns) if (t.error !== undefined && isHarness(t.plan)) failed.add(t.plan)
  for (const e of r.errors) if (isHarness(e.source)) failed.add(e.source)
  for (const h of failed) {
    const why = r.txns.find(t => t.plan === h && t.error !== undefined)?.error ?? r.errors.find(e => e.source === h)?.error ?? 'failed'
    items.push({ status: 'fail', name: h, detail: `rolled back · ${withoutInstallHint(tildeText(why))}` })
  }
  if (included.length === 0 && absent.length === r.harnesses.length) {
    return { name: 'Harnesses', status: 'warn', detail: 'none found · install Claude Code, Codex, OpenCode or Oh My Pi', items }
  }
  const detail = `${included.join(', ') || 'none'}${absent.length > 0 ? ` · ${absent.join(', ')} not installed` : ''}`
  return { name: 'Harnesses', status: worst(items), detail, items }
}

const READY: ReadonlySet<ToolchainItem['status']> = new Set(['ok', 'installed', 'upgraded', 'outdated'])

function toolsSection(items: readonly ToolchainItem[] | undefined): SectionResult {
  if (items === undefined || items.length === 0) {
    return { name: 'Tools', status: 'ok', detail: process.env['BURACLE_NO_TOOLCHAIN'] === '1' ? 'skipped (BURACLE_NO_TOOLCHAIN)' : 'skipped (toolchain.autoInstall is off)' }
  }
  const listed: SectionItem[] = []
  for (const i of items) {
    if (i.status === 'failed' || (i.status === 'missing' && i.required)) listed.push({ status: 'fail', name: i.label, detail: withoutInstallHint(tildeText(i.detail)) })
  }
  for (const i of items) {
    if (i.status === 'missing' && !i.required) listed.push({ status: 'warn', name: i.label, detail: `optional · ${withoutInstallHint(tildeText(i.detail))}` })
  }
  const ready = items.filter(i => READY.has(i.status)).length
  // codegraph is a tool and an MCP server of the same package: one failure, one line.
  const unique = listed.filter((x, i) => listed.findIndex(y => y.name === x.name && y.detail === x.detail) === i)
  return { name: 'Tools', status: worst(unique), detail: `${ready}/${items.length} ready`, items: unique }
}

function memorySection(brain: { ok: boolean, detail: string }, ui: UiStartOutcome): SectionResult {
  const items: SectionItem[] = []
  let uiText: string
  if (ui.state === 'off') uiText = 'UI off · buracle mem ui'
  else if (ui.state === 'failed') {
    uiText = 'UI did not start'
    items.push({ status: 'warn', name: 'ui', detail: ui.why })
  } else uiText = `UI ${ui.url}`
  return { name: 'Memory', status: worst(items, brain.ok ? 'ok' : 'warn'), detail: `${brain.detail} · ${uiText}`, items }
}

function resultSection(r: InstallFlowResult, o: { declined: ReadonlySet<Declined>, interactive: boolean, errors: number, path?: string, secs: number, log: string, columns?: number }): SectionResult {
  const items: SectionItem[] = []
  const doctor = o.errors > 0 ? ` · doctor: ${o.errors} ${o.errors === 1 ? 'error' : 'errors'}` : ''
  const done = `done in ${o.secs} s${doctor}`
  // A terminal cuts a line to its width (sections.ts), but the log path must stay whole: when the Result line would not
  // fit, the path gets a line of its own.
  const inline = `${done} · log ${tilde(o.log)}`
  const fits = o.columns === undefined || [...`${'Result'.padEnd(NAME_WIDTH)}${inline}`].length <= o.columns - 3
  if (!fits) items.push({ status: 'info', name: 'log', detail: tilde(o.log) })
  if (o.path !== undefined) items.push({ status: 'info', name: 'PATH', detail: `${tilde(paths.localBinDir())} ${o.path} · open a new terminal` })
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  // Without a terminal nobody answered the install's questions: each case it would have asked is listed with its command.
  if (!o.interactive) {
    for (const h of r.busyHarnesses ?? []) items.push({ status: 'warn', name: h, detail: `later: buracle install ${h}` })
    if ((r.removedItems ?? 0) > 0) items.push({ status: 'warn', name: 'removed', detail: `${plural(r.removedItems ?? 0, 'Buracle item', 'Buracle items')} you removed · buracle install (in a terminal)` })
    if ((r.outsideLinks ?? 0) > 0) items.push({ status: 'warn', name: 'links', detail: `${plural(r.outsideLinks ?? 0, 'link', 'links')} out of your home folder · buracle install (in a terminal)` })
    if (r.ledgerLost === true) items.push({ status: 'warn', name: 'ledger', detail: 'the ownership ledger is gone · buracle install (in a terminal)' })
  } else {
    if (o.declined.has('removed')) items.push({ status: 'warn', name: 'removed', detail: `${plural(r.removedItems ?? 0, 'Buracle item', 'Buracle items')} you removed stay removed (you said no)` })
    if (o.declined.has('links')) items.push({ status: 'warn', name: 'links', detail: `${plural(r.outsideLinks ?? 0, 'link', 'links')} out of your home folder left alone (you said no)` })
    if (o.declined.has('ledger')) items.push({ status: 'warn', name: 'ledger', detail: 'values equal to Buracle\'s stay yours (you said no)' })
  }
  for (const e of r.errors) if (!isHarness(e.source)) items.push({ status: 'fail', name: e.source, detail: withoutInstallHint(tildeText(e.error)) })
  // The one next step the user has to take by hand: Codex runs only the hooks it trusts.
  for (const s of r.steps) if (s.startsWith('Codex: open Codex and trust')) items.push({ status: 'info', name: 'codex', detail: 'open Codex and trust the Buracle hooks once with /hooks' })
  const base: SectionStatus = r.code === 1 ? 'fail' : o.errors > 0 ? 'warn' : 'ok'
  return { name: 'Result', status: worst(items, base), detail: fits ? inline : done, items }
}
