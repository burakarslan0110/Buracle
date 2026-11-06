import type { CommandIO } from '../router'
import type { BuracleConfig } from '../../core/config'
import type { Harness } from '../../core/events'
import { HARNESSES, isHarness } from '../../core/events'
import { sanitizeText } from '../../core/status/format'
import { parseFlags, removedFlags } from '../../engine/update/args'
import { liveContext, loadBundle } from '../../engine/update/context'
import { AGENTS_SKILLS_CONSUMERS } from '../../engine/update/install-core'
import { opsDeps } from '../../engine/update/deps'
import {
  checkTools, configChecks, doctorExit, harnessChecks, memoryChecks, runMcpDoctor, runtimeChecks, skillChecks, toolChecks, toolchainChecks, toolHealth, updateChecks, type DoctorCheck,
} from '../../engine/update/doctor'
import * as paths from '../../engine/paths'
import { writeHealth } from '../../engine/update/mcp'
import { errText, table, writeJson } from '../../engine/update/output'
import { progressSteps } from '../ui/steps'
import { padEnd, styleFor, type Style } from '../ui/style'

export const name = 'doctor'
export const summary = 'Health checks: config, tools, harness adapters and their hooks, MCP and LSP handshakes, memory, code indexes and the update cache'
export const usage = `Usage: buracle doctor [<harness>|runtime|mcp|lsp|tools|memory|index|config] [--all] [--json]

In a terminal the report shows one line per section with its counts, and under it only the warnings and
errors, each with its fix; --all shows every row. A pipe gets a table of every row, --json every row as JSON.

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
  memory   \`buracle mem doctor\` (CortexDB, the project and person brains, the sessions whose
           capture is owed, the cross-project leak check, the MCP server, the old vault's import)
  index    the codegraph and semble indexes of the project in the current folder (or of
           each child project of a folder of projects), as \`buracle index status\` shows them
  updates  age of the \`buracle update --check\` cache
With <harness> (${HARNESSES.join(', ')}) only config, runtime and that harness are checked.

Options:
  --all    in a terminal, every row of every section, the ok rows too
  --json   machine-readable result

Exit codes: 0 all ok, 1 errors, 2 warnings.`

const TOPICS = ['runtime', 'mcp', 'lsp', 'tools', 'memory', 'index', 'config'] as const
const HANDSHAKE_TIMEOUT_MS = 30_000

const REMOVED_FLAGS: Readonly<Record<string, string>> = {
  'no-mcp': 'run `buracle doctor <topic>` for the sections you want',
  'no-lsp': 'run `buracle doctor <topic>` for the sections you want',
  live: 'a harness topic runs the liveness probes: `buracle doctor claude`',
  timeout: 'every handshake waits up to 30 s',
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
  const p = parseFlags(argv, { flags: { json: 'bool', all: 'bool' } })
  const json = io.flags.json || p.bools.has('json')
  const all = p.bools.has('all')
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
  const wants = (section: 'config' | 'runtime' | 'tools' | 'harness' | 'mcp' | 'lsp' | 'memory' | 'index' | 'updates'): boolean => {
    if (topic === undefined) return true
    if (isHarness(topic)) return section === 'config' || section === 'runtime' || section === 'harness'
    return topic === section
  }
  const checks: DoctorCheck[] = []
  const nowIso = () => new Date(opsDeps.now()).toISOString()
  // One rolling line names the section that runs (the handshakes take up to 30 s); it is gone before the report.
  const steps = progressSteps(io, json)
  steps.title(topic !== undefined ? `doctor ${topic}` : 'doctor')
  let working = false
  const checking = (what: string): void => {
    if (!steps.live) return
    if (working) steps.list.update('doctor', `Checking ${what}…`)
    else { steps.list.start('doctor', `Checking ${what}…`); working = true }
  }
  try {
    if (wants('config')) { checking('configuration'); checks.push(...configChecks(live, bundle, repoRoot)) }
    if (wants('runtime')) { checking('the runtime'); checks.push(...await runtimeChecks(repoRoot, bundle, opsDeps.now())) }
    if (wants('tools')) {
      checking('tools')
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
    if (wants('harness')) {
      checking('the harnesses')
      let found: DoctorCheck[]
      try {
        const adapters = await opsDeps.adapters()
        found = await withLiveProbes(isHarness(topic), () => harnessChecks(adapters, live, isHarness(topic) ? (topic as Harness) : undefined))
      } catch (e) {
        found = [{ section: 'harness', level: 'error', check: 'adapters', detail: errText(e) }]
      }
      if ('bundle' in bundle) {
        const enabled = (h: Harness) => live.config.harnesses[h].enabled && (!isHarness(topic) || topic === h)
        // Install links ~/.agents/skills only for an installed Codex, OpenCode or Oh My Pi (compose.ts), so only then is a missing link an error.
        const installed = (h: Harness) => found.some(c => c.section === h && c.check === 'installed' && c.level === 'ok')
        const ids = bundle.bundle.skills.filter(s => s.frontmatter['harnesses'] === undefined || !Array.isArray(s.frontmatter['harnesses']) || (s.frontmatter['harnesses'] as unknown[]).length > 0).map(s => s.id)
        checks.push(...skillChecks(ids, repoRoot, { claude: enabled('claude'), shared: AGENTS_SKILLS_CONSUMERS.some(h => enabled(h) && installed(h)) }))
      }
      checks.push(...found)
    }
    if (wants('mcp')) {
      checking('MCP servers')
      if ('bundle' in bundle) checks.push(...await runMcpDoctor(bundle.bundle.mcp, HANDSHAKE_TIMEOUT_MS))
      else checks.push({ section: 'mcp', level: 'error', check: 'mcp.yaml', detail: 'canonical data could not be loaded' })
    }
    if (wants('lsp')) {
      checking('language servers')
      try {
        const { checkLspServers } = await import('./lsp')
        for (const r of await checkLspServers([], HANDSHAKE_TIMEOUT_MS)) {
          checks.push({ section: 'lsp', level: r.status === 'ok' ? 'ok' : r.required ? 'error' : 'warn', check: r.id, detail: r.detail })
        }
      } catch (e) {
        checks.push({ section: 'lsp', level: 'error', check: 'lsp', detail: errText(e) })
      }
    }
    if (wants('memory')) { checking('memory'); checks.push(...await memoryChecks()) }
    if (wants('index')) { checking('code indexes'); checks.push(...await indexSection(process.cwd(), live.config, opsDeps.now())) }
    if (wants('updates')) checks.push(...updateChecks(opsDeps.now()))
  } finally {
    steps.stop()
  }

  const code = doctorExit(checks)
  const count = (l: DoctorCheck['level']) => checks.filter(c => c.level === l).length
  if (json) {
    writeJson(io.stdout, { ok: code === 0, code, summary: { ok: count('ok'), info: count('info'), warn: count('warn'), error: count('error') }, checks })
    return code
  }
  if (io.stdout.isTTY === true) {
    const cols = io.stdout.columns !== undefined && io.stdout.columns >= 40 ? io.stdout.columns : 100
    io.stdout.write(styledReport(styleFor({ isTTY: true }), checks, cols, { all }))
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
  mcp: 'MCP servers', lsp: 'Language servers', memory: 'Memory', index: 'Code indexes', updates: 'Updates', harness: 'Harnesses',
}

// Words that fit `first` columns on the first line and `next` on the ones after; a word too long for a line is split.
function wrapWords(text: string, first: number, next: number): string[] {
  const out: string[] = []
  let line = ''
  let room = Math.max(1, first)
  const push = (): void => { out.push(line); line = ''; room = Math.max(1, next) }
  for (let word of text.split(' ')) {
    while (word.length > room && line === '') { out.push(word.slice(0, room)); word = word.slice(room); room = Math.max(1, next) }
    if (line === '') line = word
    else if (line.length + 1 + word.length <= room) line = `${line} ${word}`
    else { push(); line = word }
  }
  if (line !== '' || out.length === 0) out.push(line)
  return out
}

/**
 * The doctor report for a terminal: one line per section with its worst state and its counts, then its warning and
 * error rows with their whole detail (the fix), wrapped. With `all`, every row. The JSON and the piped table keep
 * every row in their own formats.
 */
export function styledReport(st: Style, checks: readonly DoctorCheck[], columns: number, opts: { all?: boolean } = {}): string {
  const all = opts.all === true
  const width = Math.max(20, columns - 1)
  const sym = (l: DoctorCheck['level']) => (l === 'ok' ? st.ok(st.sym.ok) : l === 'warn' ? st.warn(st.sym.warn) : l === 'error' ? st.err(st.sym.err) : st.accent(st.sym.info))
  const paint = (l: DoctorCheck['level'], s: string) => (l === 'ok' || l === 'info' ? st.muted(s) : l === 'warn' ? st.warn(s) : st.err(s))
  const n = (rows: readonly DoctorCheck[], l: DoctorCheck['level']) => rows.filter(c => c.level === l).length
  const counts = (rows: readonly DoctorCheck[]): string => {
    const count = (l: DoctorCheck['level'], noun: string) => `${n(rows, l)} ${noun}${n(rows, l) === 1 ? '' : 's'}`
    return [`${n(rows, 'ok')} ok`, ...(n(rows, 'warn') > 0 ? [count('warn', 'warning')] : []), ...(n(rows, 'error') > 0 ? [count('error', 'error')] : []), ...(n(rows, 'info') > 0 ? [count('info', 'note')] : [])].join(' · ')
  }
  const worst = (rows: readonly DoctorCheck[]): DoctorCheck['level'] => (n(rows, 'error') > 0 ? 'error' : n(rows, 'warn') > 0 ? 'warn' : 'ok')
  // One line per section, in the order the sections first appear, also when a section's rows are not next to each other.
  const sections: Array<{ id: string, rows: DoctorCheck[] }> = []
  for (const c of checks) {
    const known = sections.find(s => s.id === c.section)
    if (known !== undefined) known.rows.push(c)
    else sections.push({ id: c.section, rows: [c] })
  }
  const title = (id: string) => SECTION_TITLE[id] ?? id
  const titleWidth = Math.max(0, ...sections.map(s => title(s.id).length))
  const shown = (rows: readonly DoctorCheck[]) => (all ? rows : rows.filter(c => c.level === 'warn' || c.level === 'error'))
  const checkWidth = Math.min(30, Math.max(0, ...sections.flatMap(s => shown(s.rows).map(c => c.check.length))))
  const lines: string[] = []
  for (const s of sections) {
    lines.push(`  ${sym(worst(s.rows))} ${padEnd(st.bold(title(s.id)), titleWidth)}  ${st.muted(counts(s.rows))}`)
    for (const c of shown(s.rows)) {
      const detail = sanitizeText(c.detail.replace(/\s*\n\s*/g, ' / ')).trim()
      const head = `    ${sym(c.level)} ${padEnd(st.bold(c.check), checkWidth)}  `
      const room = width - (6 + Math.max(checkWidth, c.check.length) + 2)
      if (c.level === 'ok' || c.level === 'info') {
        lines.push(`${head}${paint(c.level, detail.length > room ? `${detail.slice(0, Math.max(1, room - 1))}…` : detail)}`)
        continue
      }
      // A problem's detail is its fix: it wraps, its next lines 6 columns in, and is never cut.
      const wrapped = wrapWords(detail, room, width - 6)
      lines.push(`${head}${paint(c.level, wrapped[0] ?? '')}`, ...wrapped.slice(1).map(l => `      ${paint(c.level, l)}`))
    }
  }
  lines.push('', `  ${sym(worst(checks))} ${st.bold(counts(checks))}`)
  if (!all && checks.some(c => c.level === 'ok' || c.level === 'info')) lines.push(`  ${st.muted('buracle doctor --all shows every row')}`)
  lines.push('')
  return lines.join('\n')
}
