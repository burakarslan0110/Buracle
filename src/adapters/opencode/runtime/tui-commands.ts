import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { BuracleConfig } from '../../../core/config'
import type { BandView } from '../../../core/flow/band'
import { bandText } from '../../../core/flow/band'
import { memoryPaneLines, planPaneLines } from '../../../core/flow/panes'
import { brainPageArg } from '../../../core/plan/notes'
import { readJsonSafeSync } from '../../../engine/fsx'
import * as paths from '../../../engine/paths'
import { buracleArgv, liveMemoryUi } from '../../../usage/bar-info'
import { loadState } from '../../../workflow/session-store'
import { effortLevel } from './effort'
import type { TuiKeymapCommand, TuiToastVariant } from './types'

export interface CliResult { code: number; stdout: string; stderr: string }
export type CliRunner = (argv: string[], timeoutMs: number) => Promise<CliResult>

export interface UtilityHost {
  cli(): string[] | undefined
  run: CliRunner
  cfg(): BuracleConfig
  sessionID(): string | undefined
  toast(message: string, variant: TuiToastVariant, title?: string): void
  alert(title: string, message: string): Promise<void>
  band(sessionID: string | undefined): BandView
  about(): { opencode?: string, testedWith: string, workflows: readonly string[] }
  slashCommand(name: string): ((input: string) => unknown) | undefined
  pane?(title: string, lines: () => string[]): boolean
}

export interface UtilityNames {
  remember: string
  brain: string
  aside: string
  status: string
  statusAliases: string[]
  ping: string
}

export const STATUS_ALIAS = 'buracle'
export const BTW_COMMAND = 'btw'

export function utilityNames(taken: ReadonlySet<string>): UtilityNames {
  return {
    remember: taken.has('remember') ? 'buracle-remember' : 'remember',
    brain: taken.has('brain') ? 'buracle-brain' : 'brain',
    aside: taken.has('aside') ? 'buracle-aside' : 'aside',
    status: 'buracle-status',
    statusAliases: taken.has(STATUS_ALIAS) ? [] : [STATUS_ALIAS],
    ping: 'buracle-ping',
  }
}

export function defaultCli(): string[] | undefined {
  const shim = paths.shimPath()
  if (existsSync(shim)) return [shim]
  return buracleArgv()
}

function firstLine(text: string): string {
  return (text.split('\n').map(l => l.trim()).find(l => l !== '') ?? '').slice(0, 300)
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const NO_CLI = 'The Buracle CLI was not found (~/.buracle/bin/buracle); run `buracle install` first.'

export async function remember(host: UtilityHost, input: string | undefined, name = 'remember'): Promise<void> {
  const text = (input ?? '').trim()
  if (text === '') { host.toast(`Usage: /${name} <text>`, 'warning', 'Buracle'); return }
  const cli = host.cli()
  if (cli === undefined) { host.toast(NO_CLI, 'error', 'Buracle'); return }
  const r = await host.run([...cli, 'mem', 'remember', '--', text], 20_000)
  if (r.code === 0) {
    const said = firstLine(r.stdout).replace(/^saved as a capture:\s*/i, '').replace(/\s*\(.*\)$/, '')
    host.toast(said !== '' ? `Remembered: ${said}` : 'Remembered.', 'success', 'Buracle')
  } else {
    host.toast(`Not saved (exit code ${r.code}): ${firstLine(r.stderr) || firstLine(r.stdout)}`, 'error', 'Buracle')
  }
}

function memoryUiUrl(cfg: BuracleConfig): string | undefined {
  try {
    const live = liveMemoryUi()
    if (live !== undefined) return live.url
  } catch {  }
  return `http://localhost:${cfg.memory.ui.port}`
}

export async function brain(host: UtilityHost, input = '', name = 'brain'): Promise<void> {
  const page = brainPageArg(input)
  if (page === undefined) { host.toast(`Usage: /${name} [review]`, 'warning', 'Buracle'); return }
  const cli = host.cli()
  if (cli === undefined) { host.toast(NO_CLI, 'error', 'Buracle'); return }
  const r = await host.run([...cli, 'mem', 'ui', '--open', ...(page === 'review' ? ['--page', 'review'] : []), '--json'], 15_000)
  if (r.code !== 0) { host.toast(`Could not open the memory UI (exit code ${r.code}): ${firstLine(r.stderr) || firstLine(r.stdout)}`, 'error', 'Buracle'); return }
  let url: string | undefined
  try {
    const j = JSON.parse(r.stdout) as { url?: unknown, page?: unknown }
    if (page === 'review' && typeof j.page === 'string') url = j.page
    else if (typeof j.url === 'string') url = j.url
  } catch {  }
  url ??= memoryUiUrl(host.cfg())
  host.toast(url !== undefined ? `${page === 'review' ? 'Review page' : 'Memory UI'}: ${url}` : 'The memory UI is starting.', 'success', 'Buracle')
}

export function statusLines(host: UtilityHost): string[] {
  const cfg = host.cfg()
  const about = host.about()
  const sid = host.sessionID()
  const level = effortLevel(cfg)
  const lines = [
    `Buracle on OpenCode ${about.opencode ?? '?'} (tested with ${about.testedWith})`,
    `session: ${sid ?? '-'}`,
    `permissions: ${cfg.permissions.bypass ? "no approval prompts (Buracle's guards and consent gate still deny)" : 'as OpenCode is configured'}`,
    `routing: ${cfg.routing.strictness} · skill router: ${cfg.routing.skills} · workflow band: ${cfg.workflow.band ? 'on' : 'off'}`,
    `default effort: ${level ?? 'OpenCode decides'} (effort.opencode ${cfg.effort.opencode})`,
    `workflows: ${about.workflows.map(w => `/${w}`).join(' ')}`,
  ]
  const url = memoryUiUrl(cfg)
  if (url !== undefined) lines.push(`memory UI: ${url}`)
  return lines
}

export async function status(host: UtilityHost, input: string | undefined): Promise<void> {
  const what = ((input ?? '').trim().split(/\s+/)[0] ?? '').toLowerCase()
  const sid = host.sessionID()
  let title: string
  let lines: string[]
  if (what === '' || what === 'status') {
    title = 'Buracle status'
    lines = statusLines(host)
  } else if (what === 'memory' || what === 'mem' || what === 'plan') {
    title = what === 'plan' ? 'Buracle plan' : 'Buracle memory'
    const live = what === 'plan' ? () => planLines(host, sid) : () => memoryLines(host.cfg())
    if (host.pane?.(title, live) === true) return
    lines = live()
  } else if (what === 'flow') {
    title = 'Buracle workflow'
    lines = bandText(host.band(sid))
  } else {
    host.toast('Usage: /buracle-status [status|memory|plan|flow]', 'warning', 'Buracle')
    return
  }
  await host.alert(title, lines.join('\n'))
}

export const PANE_REFRESH_MS = 2_000

export function memoryLines(cfg: BuracleConfig): string[] {
  const r = readJsonSafeSync<unknown>(join(paths.memoryStateDir(), 'status', '_global.json'))
  return memoryPaneLines(r.ok ? r.value : undefined, memoryUiUrl(cfg), paths.brainDir()).map(l => l.text.replace(/ {2}\(w\)$/, ''))
}

export function planLines(host: Pick<UtilityHost, 'band'>, sid: string | undefined): string[] {
  return planPaneLines(host.band(sid), sid !== undefined && paths.isValidSessionId(sid) ? loadState('opencode', sid) : { v: 1, guard: { blocksForPlan: 0, blocksInChain: 0 } }).map(l => l.text)
}

export async function aside(host: UtilityHost, input: string | undefined, name = 'aside'): Promise<void> {
  const btw = host.slashCommand(BTW_COMMAND)
  if (btw === undefined) {
    host.toast(`/${name} hands the question to OpenCode's /${BTW_COMMAND}, which this OpenCode does not offer to plugins: type /${BTW_COMMAND} <question>.`, 'warning', 'Buracle')
    return
  }
  await btw((input ?? '').trim())
}

export function ping(host: UtilityHost): void {
  host.toast('pong', 'success', 'Buracle')
}

export function utilityCommands(host: UtilityHost, names: UtilityNames): TuiKeymapCommand[] {
  const guarded = (what: string, fn: (input: string | undefined) => Promise<void> | void) => async (input?: string): Promise<void> => {
    try { await fn(input) } catch (e) { host.toast(`${what} failed: ${errText(e)}`, 'error', 'Buracle') }
  }
  return [
    {
      id: 'buracle.remember', title: 'Remember', description: 'Buracle: save the text as a note in the memory inbox', group: 'Buracle', palette: true,
      slash: { name: names.remember, arguments: true }, run: guarded(`/${names.remember}`, input => remember(host, input, names.remember)),
    },
    {
      id: 'buracle.brain', title: 'Open the memory web UI', description: 'Buracle: start and open the memory web UI (review: the plan and change review page)', group: 'Buracle', palette: true,
      slash: { name: names.brain, arguments: true }, run: guarded(`/${names.brain}`, input => brain(host, input ?? '', names.brain)),
    },
    {
      id: 'buracle.aside', title: 'Ask a side question', description: 'Buracle: a read-only side question, answered by /btw (never added to the session)', group: 'Buracle', palette: true,
      slash: { name: names.aside, arguments: true }, run: guarded(`/${names.aside}`, input => aside(host, input, names.aside)),
    },
    {
      id: 'buracle.status', title: 'Buracle status', description: 'Buracle status: status, memory, plan or flow', group: 'Buracle', palette: true,
      slash: { name: names.status, ...(names.statusAliases.length > 0 ? { aliases: [...names.statusAliases] } : {}), arguments: true },
      run: guarded(`/${names.status}`, input => status(host, input)),
    },
    {
      id: 'buracle.ping', title: 'Buracle ping', description: 'Buracle: liveness check (no model turn)', group: 'Buracle', palette: true,
      slash: { name: names.ping, arguments: true }, run: guarded(`/${names.ping}`, () => ping(host)),
    },
  ]
}
