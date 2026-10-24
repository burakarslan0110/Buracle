import { resolve } from 'node:path'
import type { CommandIO } from '../router'
import type { BuracleConfig } from '../../core/config'
import type { Harness } from '../../core/events'
import { HARNESSES, isHarness } from '../../core/events'
import { formatPct, formatTokens, gauge, sanitizeText, stripEmoji, textWidth, truncateToWidth } from '../../core/status/format'
import type { BarModel, Segment, StatusLayout } from '../../core/status/model'
import { renderAnsi, renderAnsiLines, renderPlain, renderPlainLines, renderTmux, renderTmuxLines, rows } from '../../core/status/render'
import { barLines, barOneLine } from '../../core/status/bar'
import { barInfo } from '../../usage/bar-info'
import { loadConfigSync } from '../../engine/config'
import { statusHealth } from '../../engine/hook-health'
import { log } from '../../engine/log'
import { cachedProjectSlug, dirLabel, effectiveLayout, flowForSession, gitInfo, indexStatusFor, loadLayout, monthFromEntry, pendingUpdates, planForSession, readClaudePayload, readMemoryStatus, sessionView } from '../../usage/bar'
import { currentUsageEntry, isStale, readUsageCache, spawnUsageRefresh } from '../../usage/cache'
import type { UsageCacheEntry } from '../../usage/types'
import { resolveSession, writeTelemetry } from '../../workflow/session-store'

export const name = 'statusline'
export const summary = 'Render the status line for a harness (Claude reads its JSON on stdin)'
export const usage = `Usage: buracle statusline <harness> [--width N] [--format ansi|plain|tmux] [--style buracle|full|compact]
                          [--session <id>] [--cwd <dir>] [--json]
       buracle statusline claude --subagent

  <harness>   ${HARNESSES.join(' | ')}
  claude      reads Claude Code's statusLine JSON on stdin (settings.json "statusLine" command);
              with --subagent, reads the subagentStatusLine JSON and prints one
              {"id","content"} line per subagent row
  codex, opencode, omp
              render from session telemetry and caches, e.g. for tmux:
                set -g status-right '#(buracle statusline codex --cwd "#{pane_current_path}")'

Options:
  --width N   columns available (default: $COLUMNS - 1, else 120); segments are shortened, then
              dropped, lowest priority first
  --format    ansi (default for claude), tmux (default for the others) or plain
  --style     buracle (two lines: model/context/usage/git and Buracle/harness/memory UI, with the
              running workflow between them while one runs; one line for tmux), full or compact
              segment rows (default: config statusline.style)
  --session   session id (codex/opencode/omp; default: the session env vars, else the newest)
  --cwd       directory for git/project lookups (default: the session's cwd, else the current dir)
  --json      {harness, quiet, text, rows, bar, status?} instead of text`

type Format = 'ansi' | 'plain' | 'tmux'

export interface StatuslineArgs {
  harness?: Harness
  width?: number
  format?: Format
  style?: 'buracle' | 'full' | 'compact'
  session?: string
  cwd?: string
  subagent?: boolean
  json: boolean
  verbose: boolean
}

export function parseStatuslineArgs(argv: string[]): StatuslineArgs | { error: string } {
  const a: StatuslineArgs = { json: false, verbose: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string
    const value = (): string | undefined => {
      const eq = arg.indexOf('=')
      if (eq > 0) return arg.slice(eq + 1)
      i++
      return argv[i]
    }
    const flag = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg
    switch (flag) {
      case '--json': a.json = true; break
      case '--verbose': case '-v': a.verbose = true; break
      case '--subagent': a.subagent = true; break
      case '--width': {
        const n = Number(value())
        if (!Number.isFinite(n) || n <= 0) return { error: '--width expects a positive number' }
        a.width = Math.floor(n)
        break
      }
      case '--format': {
        const f = value()
        if (f !== 'ansi' && f !== 'plain' && f !== 'tmux') return { error: '--format expects ansi, plain or tmux' }
        a.format = f
        break
      }
      case '--style': {
        const s = value()
        if (s !== 'buracle' && s !== 'full' && s !== 'compact') return { error: '--style expects buracle, full or compact' }
        a.style = s
        break
      }
      case '--session': {
        const s = value()
        if (s === undefined || s === '') return { error: '--session expects an id' }
        a.session = s
        break
      }
      case '--cwd': case '--pane-path': {
        const d = value()
        if (d === undefined || d === '') return { error: '--cwd expects a directory' }
        a.cwd = d
        break
      }
      default:
        if (arg.startsWith('-')) return { error: `unknown option ${arg}` }
        if (a.harness !== undefined) return { error: `unexpected argument ${arg}` }
        if (!isHarness(arg)) return { error: `unknown harness '${arg}' (expected ${HARNESSES.join(', ')})` }
        a.harness = arg
    }
  }
  if (a.harness === undefined) return { error: 'missing <harness>' }
  if (a.subagent && a.harness !== 'claude') return { error: '--subagent is only for claude (subagentStatusLine)' }
  return a
}

export function subagentRows(input: unknown, layout: StatusLayout, fallbackWidth: number, emoji: boolean): Array<{ id: string, content: string }> {
  const o = input !== null && typeof input === 'object' ? input as Record<string, unknown> : {}
  const cols = typeof o['columns'] === 'number' && o['columns'] > 0 ? Math.floor(o['columns']) : fallbackWidth
  const tasks = Array.isArray(o['tasks']) ? o['tasks'] : []
  const out: Array<{ id: string, content: string }> = []
  for (const raw of tasks) {
    const t = raw !== null && typeof raw === 'object' ? raw as Record<string, unknown> : {}
    const id = typeof t['id'] === 'string' ? t['id'] : undefined
    if (id === undefined) continue
    const str = (k: string) => (typeof t[k] === 'string' && (t[k] as string).trim() !== '' ? (t[k] as string).trim() : undefined)
    const segs: Segment[] = []
    const name = str('label') ?? str('name') ?? str('type')
    if (name !== undefined) segs.push({ id: 'agent', text: name, color: 'cyan' })
    const model = str('model')?.replace(/^claude-/u, '')
    const effort = typeof t['effort'] === 'string' ? t['effort'] : typeof t['effort'] === 'number' ? `${formatTokens(t['effort'])} think` : undefined
    if (model !== undefined) segs.push({ id: 'model', text: effort !== undefined ? `${model} · ${effort}` : model })
    const tokens = typeof t['tokenCount'] === 'number' ? t['tokenCount'] : undefined
    const window = typeof t['contextWindowSize'] === 'number' && t['contextWindowSize'] > 0 ? t['contextWindowSize'] : undefined
    if (tokens !== undefined && window !== undefined) {
      const pct = (tokens / window) * 100
      const color = pct >= layout.thresholds.ctxCrit ? 'red' : pct >= layout.thresholds.ctxWarn ? 'yellow' : 'green'
      segs.push({ id: 'ctx', text: `ctx ${gauge(pct)} ${formatPct(pct)}% (${formatTokens(tokens)}/${formatTokens(window)})`, color })
    } else if (tokens !== undefined) segs.push({ id: 'ctx', text: `${formatTokens(tokens)} tok` })
    const status = str('status')
    if (status !== undefined && status !== 'running') segs.push({ id: 'status', text: status, color: status === 'failed' || status === 'error' ? 'red' : 'gray' })
    const clean = segs.map(s => ({ ...s, text: emoji ? sanitizeText(s.text) : stripEmoji(sanitizeText(s.text)) }))
    const width = (l: Segment[]) => l.reduce((n, s) => n + textWidth(s.text), 0) + 3 * Math.max(0, l.length - 1)
    const desc = str('description')
    const room = cols - width(clean) - 3
    if (desc !== undefined && room >= 8) clean.push({ id: 'desc', text: truncateToWidth(sanitizeText(desc), room), dim: true })
    while (clean.length > 1 && width(clean) > cols) clean.pop()
    const first = clean[0]
    if (first !== undefined && clean.length === 1 && width(clean) > cols) clean[0] = { ...first, text: truncateToWidth(first.text, cols) }
    out.push({ id, content: renderAnsi([clean]) })
  }
  return out
}

export interface StatuslineResult {
  harness: Harness
  quiet: boolean
  text: string
  rows: Segment[][]
  joined?: boolean
  bar?: BarModel
  status?: Record<string, string>
}

export interface StatuslineDeps {
  nowMs?: number
  env?: Record<string, string | undefined>
  cwd?: string
  spawnRefresh?: (h: Harness) => void
  gitBudgetMs?: number
}

function widthOf(args: StatuslineArgs, env: Record<string, string | undefined>): number {
  if (args.width !== undefined) return args.width
  const cols = Number(env['COLUMNS'])
  return Number.isFinite(cols) && cols > 1 ? Math.floor(cols) - 1 : 120
}

async function withDeadline<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>(res => { timer = setTimeout(() => res(undefined), Math.max(0, ms)) })
  try {
    return await Promise.race([p, late])
  } finally {
    clearTimeout(timer)
  }
}

interface DecorateOptions {
  cwd: string
  sessionId?: string
  extraRoots: string[]
  entry?: UsageCacheEntry
  monthly: boolean
  nowMs: number
  gitBudgetMs: number
  worktreeHint?: string
  config: BuracleConfig
}

async function decorate(bar: BarModel, h: Harness, o: DecorateOptions): Promise<void> {
  const pending = Promise.all([
    gitInfo(o.cwd, o.gitBudgetMs).catch(() => undefined),
    cachedProjectSlug(o.cwd, o.nowMs).catch(() => undefined),
    withDeadline(indexStatusFor(o.cwd, o.config, o.nowMs), o.gitBudgetMs).catch((e: unknown) => {
      log('warn', 'statusline: code index state unavailable', { error: e })
      return undefined
    }),
    statusHealth(o.nowMs).catch(() => undefined),
  ])
  const [gi, slug, index, hooks] = await pending
  if (hooks !== undefined) bar.hooks = hooks
  if (gi !== undefined) {
    bar.git = gi.git
    if (gi.git.worktree === undefined && o.worktreeHint !== undefined) gi.git.worktree = o.worktreeHint
  }
  const dir = dirLabel(o.cwd, gi)
  if (dir !== undefined) bar.dir = dir
  const mem = readMemoryStatus(slug)
  if (mem !== undefined) bar.mem = mem
  if (index !== undefined) bar.index = index
  const roots = [...new Set([...o.extraRoots, ...(gi?.toplevel !== undefined ? [gi.toplevel] : []), o.cwd])]
  const plan = planForSession(h, o.sessionId, roots)
  if (plan !== undefined) bar.plan = plan
  try {
    const flow = flowForSession(h, o.sessionId, o.nowMs, o.config.workflow.foldAfterSec, roots)
    if (flow !== undefined) bar.flow = flow
  } catch (e) { log('warn', 'statusline: workflow view unavailable', { error: e }) }
  if (o.monthly && bar.month === undefined) {
    const m = monthFromEntry(o.entry, o.nowMs)
    if (m !== undefined) bar.month = m
  }
  const upd = pendingUpdates()
  if (upd !== undefined && upd > 0) bar.updates = upd
}

function statusTexts(bar: BarModel, layout: StatusLayout, nowMs: number): Record<string, string> | undefined {
  const map = layout.native?.setStatus
  if (map === undefined) return undefined
  const out: Record<string, string> = {}
  for (const [key, ids] of Object.entries(map)) out[key] = renderPlain(rows(bar, { ...layout, rows: [ids] }, Number.POSITIVE_INFINITY, nowMs))
  return out
}

export async function buildStatusline(args: StatuslineArgs, io: Pick<CommandIO, 'stdin'>, deps: StatuslineDeps = {}): Promise<StatuslineResult> {
  const h = args.harness as Harness
  const nowMs = deps.nowMs ?? Date.now()
  const env = deps.env ?? process.env
  const baseCwd = deps.cwd ?? process.cwd()
  const spawnRefresh = deps.spawnRefresh ?? ((x: Harness) => { spawnUsageRefresh(x) })
  const gitBudgetMs = deps.gitBudgetMs ?? 300

  if (h === 'claude') {
    const text = await io.stdin.text()
    let payload: unknown = {}
    try { payload = text.trim() === '' ? {} : JSON.parse(text) as unknown } catch (e) { log('warn', 'statusline: stdin is not JSON', { error: e }) }
    const p = readClaudePayload(payload, baseCwd)
    if (p.sessionId !== undefined) {
      try {
        const t: Parameters<typeof writeTelemetry>[2] = { at: nowMs, windows: p.windows, cwd: p.cwd }
        if (p.model !== undefined) t.model = p.model
        if (p.modelId !== undefined) t.modelId = p.modelId
        if (p.effort !== undefined) t.effort = p.effort
        if (p.ctx !== undefined) t.ctx = p.ctx
        if (p.costUsd !== undefined) t.costUsd = p.costUsd
        writeTelemetry('claude', p.sessionId, t)
      } catch (e) { log('warn', 'statusline: telemetry write failed', { error: e }) }
    }
    const config = loadConfigSync().config
    const style = args.style ?? config.statusline.style
    const layout = effectiveLayout(loadLayout('claude'), config.statusline, args.style)
    const monthly = config.statusline.monthly !== 'off'
    const cache = readUsageCache()
    const entry = currentUsageEntry(cache, 'claude', nowMs)
    if (monthly && isStale(cache?.harnesses.claude, nowMs)) spawnRefresh('claude')
    const bar: BarModel = { harness: 'claude', windows: p.windows }
    if (p.model !== undefined) bar.model = p.model
    if (p.effort !== undefined) bar.effort = p.effort
    if (p.ctx !== undefined) bar.ctx = p.ctx
    if (!p.hasRateLimits && p.costUsd !== undefined && p.costUsd > 0) bar.cost = { usd: p.costUsd }
    if (monthly && p.monthPct !== undefined) {
      const m: NonNullable<BarModel['month']> = { tokens: entry?.month.tokens ?? 0, estimate: false, pct: p.monthPct }
      if (p.monthUsd !== undefined) m.usd = p.monthUsd
      bar.month = m
    }
    const d: DecorateOptions = { cwd: p.cwd, extraRoots: p.projectDir !== undefined ? [p.projectDir] : [], monthly, nowMs, gitBudgetMs, config }
    if (p.sessionId !== undefined) d.sessionId = p.sessionId
    if (entry !== undefined) d.entry = entry
    if (p.worktree !== undefined) d.worktreeHint = p.worktree
    await decorate(bar, 'claude', d)
    if (style === 'buracle') {
      const po: Parameters<typeof barInfo>[1] = { nowMs }
      if (p.version !== undefined) po.version = p.version
      if (p.lines !== undefined) po.lines = p.lines
      const info = await barInfo('claude', po)
      return { harness: h, quiet: false, text: '', rows: barLines(bar, info, layout, widthOf(args, env), nowMs), joined: true, bar }
    }
    return { harness: h, quiet: false, text: '', rows: rows(bar, layout, widthOf(args, env), nowMs), bar }
  }

  const config = loadConfigSync().config
  const style = args.style ?? config.statusline.style
  const layout = effectiveLayout(loadLayout(h), config.statusline, args.style)
  const monthly = config.statusline.monthly !== 'off'
  const cache = readUsageCache()
  const entry = currentUsageEntry(cache, h, nowMs)
  if (isStale(cache?.harnesses[h], nowMs)) spawnRefresh(h)
  let sessionId = args.session
  if (sessionId === undefined) {
    const r = resolveSession({}, env)
    if (r !== undefined && r.harness === h) sessionId = r.sessionId
  }
  const vo: Parameters<typeof sessionView>[1] = { nowMs }
  if (sessionId !== undefined) vo.sessionId = sessionId
  if (args.cwd !== undefined) vo.cwd = resolve(args.cwd)
  if (entry !== undefined) vo.entry = entry
  const view = sessionView(h, vo)
  const cwd = args.cwd !== undefined ? resolve(args.cwd) : view.cwd ?? baseCwd
  const bar: BarModel = { harness: h, windows: view.windows }
  if (view.model !== undefined) bar.model = view.model
  if (view.effort !== undefined) bar.effort = view.effort
  if (view.ctx !== undefined) bar.ctx = view.ctx
  if (view.windows.length === 0 && view.costUsd !== undefined && view.costUsd > 0) bar.cost = { usd: view.costUsd }
  if (monthly && entry?.month_pct !== undefined) {
    const m: NonNullable<BarModel['month']> = { tokens: entry.month.tokens, estimate: true, pct: entry.month_pct }
    if (entry.month.usd !== undefined) m.usd = entry.month.usd
    bar.month = m
  }
  const d: DecorateOptions = { cwd, extraRoots: [], monthly, nowMs, gitBudgetMs, config }
  if (view.sessionId !== undefined) d.sessionId = view.sessionId
  if (entry !== undefined) d.entry = entry
  await decorate(bar, h, d)
  const width = widthOf(args, env)
  let result: StatuslineResult
  if (style === 'buracle') {
    const info = await barInfo(h, { nowMs })
    const lines = args.format === undefined || args.format === 'tmux' ? [barOneLine(bar, info, layout, width, nowMs)] : barLines(bar, info, layout, width, nowMs)
    result = { harness: h, quiet: false, text: '', rows: lines, joined: true, bar }
  } else result = { harness: h, quiet: false, text: '', rows: rows(bar, layout, width, nowMs), bar }
  const status = statusTexts(bar, layout, nowMs)
  if (status !== undefined) result.status = status
  return result
}

function render(r: StatuslineResult, format: Format): string {
  if (r.quiet || r.rows.length === 0) return ''
  if (r.joined === true) return format === 'tmux' ? renderTmuxLines(r.rows) : format === 'plain' ? renderPlainLines(r.rows) : renderAnsiLines(r.rows)
  return format === 'tmux' ? renderTmux(r.rows) : format === 'plain' ? renderPlain(r.rows) : renderAnsi(r.rows)
}

export async function run(argv: string[], io: CommandIO, deps: StatuslineDeps = {}): Promise<number> {
  const args = parseStatuslineArgs(argv)
  if ('error' in args) {
    io.stderr.write(`buracle statusline: ${args.error}\n${usage}\n`)
    return 1
  }
  if (io.flags.json) args.json = true
  if (io.flags.verbose) args.verbose = true
  if (args.subagent) {
    try {
      const text = await io.stdin.text()
      const input: unknown = text.trim() === '' ? {} : JSON.parse(text)
      const config = loadConfigSync().config
      const layout = effectiveLayout(loadLayout('claude'), config.statusline, args.style)
      const env = deps.env ?? process.env
      for (const row of subagentRows(input, layout, widthOf(args, env), layout.emoji)) io.stdout.write(JSON.stringify(row) + '\n')
    } catch (e) {
      log('warn', 'subagent statusline failed', { error: e })
      if (args.verbose) io.stderr.write(`buracle statusline: ${e instanceof Error ? e.message : String(e)}\n`)
    }
    return 0
  }
  const format: Format = args.format ?? (args.harness === 'claude' ? 'ansi' : 'tmux')
  let result: StatuslineResult
  try {
    result = await buildStatusline(args, io, deps)
  } catch (e) {
    log('error', 'statusline failed', { harness: args.harness, error: e })
    if (args.verbose) io.stderr.write(`buracle statusline: ${e instanceof Error ? e.message : String(e)}\n`)
    result = { harness: args.harness as Harness, quiet: false, text: '', rows: [] }
  }
  result.text = render(result, format)
  if (args.json) {
    io.stdout.write(JSON.stringify(result) + '\n')
    return 0
  }
  if (result.text !== '') io.stdout.write(result.text + '\n')
  return 0
}
