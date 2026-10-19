import type { CommandIO } from '../router'
import type { McpCatalog } from '../../core/catalog'
import type { BuracleConfig } from '../../core/config'
import type { Harness } from '../../core/events'
import { HARNESSES, isHarness } from '../../core/events'
import { sanitizeText } from '../../core/status/format'
import { parseFlags, removedFlags } from '../../engine/update/args'
import { liveContext, loadBundle } from '../../engine/update/context'
import { opsDeps } from '../../engine/update/deps'
import {
  checkTools, configChecks, doctorExit, harnessChecks, memoryChecks, runMcpDoctor, runtimeChecks, skillChecks, toolChecks, toolchainChecks, toolHealth, updateChecks, type DoctorCheck,
} from '../../engine/update/doctor'
import * as paths from '../../engine/paths'
import { writeHealth } from '../../engine/update/mcp'
import { errText, table, writeJson } from '../../engine/update/output'
import { heading, makeStyle, colorLevel, padEnd, type Style } from '../ui/style'

export const name = 'doctor'
export const summary = 'Health checks: config, tools, harness adapters and their hooks, MCP and LSP handshakes, Context Mode, memory, code indexes and the update cache'
export const usage = `Usage: buracle doctor [<harness>|runtime|mcp|lsp|tools|memory|index|config|context-mode] [--json]

Without a topic every section runs:
  config   ~/.buracle/config.yaml, canonical/ data, runtime-config.json, shim (and what it
           runs: the frozen runtime, or the checkout directly, which is a warning), PATH,
           the memory folder, BURACLE_HOME, and that every installed command running the shim (hooks,
           MCP servers, status lines) finds it, also with a non-default BURACLE_HOME
  runtime  the frozen runtime the shim runs (~/.buracle/runtime/<id>): present, checked,
           behind or ahead of the checkout (\`buracle install\` makes checkout edits live);
           node_modules against bun.lock; uncommitted changes (a note); Buracle hook
           failures and fail-closed denials in the log of the last 24 h; transactions
           that could not be rolled back; stale lock files; generated harness/ files
           against harness/.manifest.json and canonical/
  tools    the CLI tools in canonical/tools.yaml (missing ones get install advice only; a
           tool Buracle's toolchain provides counts through its toolchain copy), and the
           version of every package in ~/.buracle/toolchain with the one it keeps for
           \`buracle rollback toolchain\`
  skills   every skill is where each enabled harness reads it (the Claude plugin's skills/,
           ~/.agents/skills for Codex, OpenCode and Oh My Pi)
  <h>      each enabled harness: installed version and the adapter's own checks; Claude
           Code and Codex also run their PreToolUse hook the way the harness does and
           expect it to deny a destructive command (the guards really run). With a harness
           topic the zero-cost liveness probes run too (Claude Code: the mod answers
           \`claude -p /buracle-ping\` itself, without a model call)
  mcp      spawn every stdio MCP server (HTTP servers are called) and run
           initialize + tools/list, each within 30 s; results go to
           ~/.buracle/state/health.json, which routing enforcement and the capability card read
  lsp      start every language server (Buracle's toolchain copy) and run the LSP
           initialize handshake, each within 30 s
  context-mode
           Context Mode: the toolchain copy and its version, Bun, the smoke test of its
           session library, ~/.buracle/context-mode, the contextMode switches, the last
           MCP handshake (its tool list), context-mode installed outside Buracle (its own
           Claude Code, Codex, OpenCode or omp plugin, its server in Claude Code's or omp's
           MCP config, stray hooks, a global CLI) and its telemetry file (platform.json in
           ~/.context-mode, $XDG_CONFIG_HOME/context-mode or %APPDATA%\\context-mode), which
           only context-mode's hook scripts (in its Claude Code and Codex plugins) read: a warning, an error beside
           an install that runs them. Read-only.
  memory   \`buracle mem doctor\` (CortexDB, the project and person brains, upkeep, the
           cross-project leak check, the MCP server, the old vault's import)
  index    the codegraph and semble indexes of the project in the current folder (or of
           each child project of a folder of projects), as \`buracle index status\` shows them
  updates  age of the \`buracle update --check\` cache
With <harness> (${HARNESSES.join(', ')}) only config, runtime and that harness are checked.

Options:
  --json   machine-readable result

Exit codes: 0 all ok, 1 errors, 2 warnings.`

const TOPICS = ['runtime', 'mcp', 'lsp', 'tools', 'memory', 'index', 'config', 'context-mode'] as const
const HANDSHAKE_TIMEOUT_MS = 30_000

const REMOVED_FLAGS: Readonly<Record<string, string>> = {
  'no-mcp': 'run `buracle doctor <topic>` for the sections you want',
  'no-lsp': 'run `buracle doctor <topic>` for the sections you want',
  live: 'a harness topic runs the liveness probes: `buracle doctor claude`',
  timeout: 'every handshake waits up to 30 s',
}

export async function contextModeSection(cfg: BuracleConfig, catalog: McpCatalog | undefined, nowMs: number): Promise<DoctorCheck[]> {
  try {
    const { contextModeChecks } = await import('../../engine/update/context-mode-doctor')
    const o: Parameters<typeof contextModeChecks>[0] = { config: cfg, nowMs }
    if (catalog !== undefined) o.catalog = catalog
    return await contextModeChecks(o)
  } catch (e) {
    return [{ section: 'context-mode', level: 'warn', check: 'context-mode', detail: `the checks could not run: ${errText(e)}` }]
  }
}

export async function indexSection(cwd: string, cfg: BuracleConfig, nowMs: number): Promise<DoctorCheck[]> {
  try {
    const { indexChecks } = await import('../../workflow/workspace-index')
    return (await indexChecks(cwd, cfg, nowMs)).map(c => ({ section: 'index', ...c }))
  } catch (e) {
    return [{ section: 'index', level: 'warn', check: 'index', detail: `the index state could not be read: ${errText(e)}` }]
  }
}

async function withLiveProbes<T>(on: boolean, fn: () => Promise<T>): Promise<T> {
  if (!on) return fn()
  const prev = process.env['BURACLE_DOCTOR_LIVE']
  process.env['BURACLE_DOCTOR_LIVE'] = '1'
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env['BURACLE_DOCTOR_LIVE']
    else process.env['BURACLE_DOCTOR_LIVE'] = prev
  }
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  const removed = removedFlags(argv, REMOVED_FLAGS)
  if (removed.length > 0) { io.stderr.write(`buracle doctor: ${removed.join('; ')}\n`); return 1 }
  const p = parseFlags(argv, { flags: { json: 'bool' } })
  const json = io.flags.json || p.bools.has('json')
  const topic = p.positionals[0]
  const problems = [...p.errors]
  if (p.positionals.length > 1) problems.push('at most one topic')
  if (topic !== undefined && !isHarness(topic) && !(TOPICS as readonly string[]).includes(topic)) problems.push(`unknown topic ${topic}`)
  if (problems.length > 0) {
    io.stderr.write(`buracle doctor: ${problems.join('; ')}\n${usage}\n`)
    return 1
  }
  const repoRoot = paths.isFrozenRuntime() ? (paths.checkoutRoot() ?? opsDeps.repoRoot()) : opsDeps.repoRoot()
  const live = liveContext(repoRoot)
  const bundle = loadBundle(repoRoot)
  const wants = (section: 'config' | 'runtime' | 'tools' | 'harness' | 'mcp' | 'lsp' | 'context-mode' | 'memory' | 'index' | 'updates'): boolean => {
    if (topic === undefined) return true
    if (isHarness(topic)) return section === 'config' || section === 'runtime' || section === 'harness'
    return topic === section
  }
  const checks: DoctorCheck[] = []
  const nowIso = () => new Date(opsDeps.now()).toISOString()
  if (wants('config')) checks.push(...configChecks(live, bundle, repoRoot))
  if (wants('runtime')) checks.push(...await runtimeChecks(repoRoot, bundle, opsDeps.now()))
  if (wants('tools')) {
    if ('bundle' in bundle) {
      const { toolApplies } = await import('../../engine/toolchain/system')
      const tools = bundle.bundle.tools.tools.filter(t => toolApplies(t))
      const results = await checkTools(tools)
      checks.push(...toolChecks(tools, results))
      const { readToolchainState } = await import('../../engine/toolchain/state')
      checks.push(...toolchainChecks(readToolchainState()))
      if (!live.config.toolchain.autoInstall) checks.push({ section: 'tools', level: 'info', check: 'toolchain.autoInstall', detail: 'off: `buracle install` skips the toolchain, so the advice above installs nothing until `buracle config set toolchain.autoInstall true`' })
      try { writeHealth({ tools: toolHealth(results, nowIso()) }, nowIso()) } catch {  }
    } else checks.push({ section: 'tools', level: 'error', check: 'tools.yaml', detail: 'canonical data could not be loaded' })
  }
  if (wants('harness') && 'bundle' in bundle) {
    const enabled = (h: Harness) => live.config.harnesses[h].enabled && (!isHarness(topic) || topic === h)
    const ids = bundle.bundle.skills.filter(s => s.frontmatter['harnesses'] === undefined || !Array.isArray(s.frontmatter['harnesses']) || (s.frontmatter['harnesses'] as unknown[]).length > 0).map(s => s.id)
    checks.push(...skillChecks(ids, repoRoot, { claude: enabled('claude'), shared: enabled('codex') || enabled('opencode') || enabled('omp') }))
  }
  if (wants('harness')) {
    try {
      const adapters = await opsDeps.adapters()
      checks.push(...await withLiveProbes(isHarness(topic), () => harnessChecks(adapters, live, isHarness(topic) ? (topic as Harness) : undefined)))
    } catch (e) {
      checks.push({ section: 'harness', level: 'error', check: 'adapters', detail: errText(e) })
    }
  }
  if (wants('mcp')) {
    if ('bundle' in bundle) checks.push(...await runMcpDoctor(bundle.bundle.mcp, HANDSHAKE_TIMEOUT_MS))
    else checks.push({ section: 'mcp', level: 'error', check: 'mcp.yaml', detail: 'canonical data could not be loaded' })
  }
  if (wants('lsp')) {
    try {
      const { checkLspServers } = await import('./lsp')
      for (const r of await checkLspServers([], HANDSHAKE_TIMEOUT_MS)) {
        checks.push({ section: 'lsp', level: r.status === 'ok' ? 'ok' : r.required ? 'error' : 'warn', check: r.id, detail: r.detail })
      }
    } catch (e) {
      checks.push({ section: 'lsp', level: 'error', check: 'lsp', detail: errText(e) })
    }
  }
  if (wants('context-mode')) checks.push(...await contextModeSection(live.config, 'bundle' in bundle ? bundle.bundle.mcp : undefined, opsDeps.now()))
  if (wants('memory')) checks.push(...await memoryChecks())
  if (wants('index')) checks.push(...await indexSection(process.cwd(), live.config, opsDeps.now()))
  if (wants('updates')) checks.push(...updateChecks(opsDeps.now()))

  const code = doctorExit(checks)
  const count = (l: DoctorCheck['level']) => checks.filter(c => c.level === l).length
  if (json) {
    writeJson(io.stdout, { ok: code === 0, code, summary: { ok: count('ok'), info: count('info'), warn: count('warn'), error: count('error') }, checks })
    return code
  }
  if (io.stdout.isTTY === true) {
    const cols = io.stdout.columns !== undefined && io.stdout.columns >= 40 ? io.stdout.columns : 100
    io.stdout.write(styledReport(makeStyle(colorLevel({ isTTY: true })), checks, cols))
    return code
  }
  const mark: Record<DoctorCheck['level'], string> = { ok: 'ok', info: 'info', warn: 'WARN', error: 'ERROR' }
  const oneLine = (s: string) => sanitizeText(s.replace(/\s*\n\s*/g, ' / ')).trim()
  io.stdout.write(table([['SECTION', 'CHECK', 'STATUS', 'DETAIL'], ...checks.map(c => [c.section, c.check, mark[c.level], oneLine(c.detail)])]))
  io.stdout.write(`\n${count('ok')} ok, ${count('warn')} warning(s), ${count('error')} error(s)${count('info') > 0 ? `, ${count('info')} note(s)` : ''}.\n`)
  return code
}

const SECTION_TITLE: Readonly<Record<string, string>> = {
  config: 'Configuration', runtime: 'Runtime', tools: 'Tools', skills: 'Skills', claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', omp: 'Oh My Pi',
  mcp: 'MCP servers', lsp: 'Language servers', 'context-mode': 'Context Mode', memory: 'Memory', index: 'Code indexes', updates: 'Updates', harness: 'Harnesses',
}

export function styledReport(st: Style, checks: readonly DoctorCheck[], columns: number): string {
  const sym = (l: DoctorCheck['level']) => (l === 'ok' ? st.ok(st.sym.ok) : l === 'warn' ? st.warn(st.sym.warn) : l === 'error' ? st.err(st.sym.err) : st.accent(st.sym.info))
  const width = Math.min(30, Math.max(8, ...checks.map(c => c.check.length)))
  const lines: string[] = []
  let section: string | undefined
  for (const c of checks) {
    if (c.section !== section) {
      section = c.section
      lines.push('', heading(st, SECTION_TITLE[c.section] ?? c.section, columns))
    }
    const detail = sanitizeText(c.detail.replace(/\s*\n\s*/g, ' / ')).trim()
    const room = Math.max(20, columns - width - 8)
    const shown = detail.length > room && c.level === 'ok' ? `${detail.slice(0, room - 1)}…` : detail
    const text = c.level === 'ok' || c.level === 'info' ? st.muted(shown) : c.level === 'warn' ? st.warn(shown) : st.err(shown)
    lines.push(`  ${sym(c.level)} ${padEnd(st.bold(c.check), width)}  ${text}`)
  }
  const n = (l: DoctorCheck['level']) => checks.filter(c => c.level === l).length
  const count = (l: DoctorCheck['level'], noun: string) => `${n(l)} ${noun}${n(l) === 1 ? '' : 's'}`
  const summary = [`${n('ok')} ok`, ...(n('warn') > 0 ? [count('warn', 'warning')] : []), ...(n('error') > 0 ? [count('error', 'error')] : []), ...(n('info') > 0 ? [count('info', 'note')] : [])].join(' · ')
  const head = n('error') > 0 ? st.err(st.sym.err) : n('warn') > 0 ? st.warn(st.sym.warn) : st.ok(st.sym.ok)
  lines.push('', `${head} ${st.bold(summary)}`, '')
  return lines.join('\n')
}
