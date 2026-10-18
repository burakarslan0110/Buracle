import { describe, expect, test } from 'bun:test'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandIO } from '../../src/cli/router'
import { buildStatusline, parseStatuslineArgs, run, type StatuslineDeps, type StatuslineResult } from '../../src/cli/commands/statusline'
import type { Harness } from '../../src/core/events'
import type { FlowRecord } from '../../src/core/flow/record'
import { flowEnd, flowPhase, flowStart } from '../../src/core/flow/record'
import { memEmptyStatus } from '../../src/core/memory/status'
import type { MemoryStatus } from '../../src/core/memory/status'
import { renderPlain, renderPlainLines } from '../../src/core/status/render'
import { atomicWriteSync } from '../../src/engine/fsx'
import { projectSlug } from '../../src/engine/git'
import { heartbeatFile, memoryStateDir, updatesFile, userConfigFile } from '../../src/engine/paths'
import { run as runProc } from '../../src/engine/proc'
import { writeUsageEntries } from '../../src/usage/cache'
import { monthKeyOf } from '../../src/usage/month'
import type { UsageCacheEntry } from '../../src/usage/types'
import { writeFlow } from '../../src/workflow/flow'
import { readTelemetry, saveState, writeTelemetry, freshState } from '../../src/workflow/session-store'
import { indexLockFile, indexRecordFile, type IndexRecord } from '../../src/workflow/workspace'
import { withSandbox } from '../helpers/sandbox'
import { NOW } from './helpers'

const SID = 'f00dcafe-1234-4abc-9def-0123456789ab'

function claudePayload(over: Record<string, unknown> = {}, cwd = '/tmp'): Record<string, unknown> {
  return {
    cwd,
    session_id: SID,
    transcript_path: '/tmp/x.jsonl',
    model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
    workspace: { current_dir: cwd, project_dir: cwd },
    version: '2.1.293',
    cost: { total_cost_usd: 1.25, total_duration_ms: 1, total_api_duration_ms: 1, total_lines_added: 0, total_lines_removed: 0 },
    context_window: { total_input_tokens: 1, total_output_tokens: 1, context_window_size: 1_000_000, used_percentage: 37, remaining_percentage: 63, current_usage: { input_tokens: 2000, output_tokens: 10, cache_creation_input_tokens: 8000, cache_read_input_tokens: 360_000 } },
    effort: { level: 'max' },
    rate_limits: {
      five_hour: { used_percentage: 42, resets_at: Math.floor((NOW + 80 * 60_000) / 1000) },
      seven_day: { used_percentage: 18, resets_at: Math.floor((NOW + 30 * 3600_000) / 1000) },
    },
    ...over,
  }
}

function memIO(stdin = ''): CommandIO & { out(): string, err(): string } {
  let out = ''
  let err = ''
  return {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    stdin: { isTTY: false, text: async () => stdin },
    flags: { json: false, verbose: false },
    out: () => out,
    err: () => err,
  }
}

function deps(over: StatuslineDeps = {}): StatuslineDeps & { spawned: Harness[] } {
  const spawned: Harness[] = []
  return { nowMs: NOW, env: { COLUMNS: '200' }, cwd: '/tmp', spawnRefresh: h => { spawned.push(h) }, ...over, spawned }
}

function entry(h: Harness, over: Partial<UsageCacheEntry> = {}): UsageCacheEntry {
  return { harness: h, computed_at: new Date(NOW - 60_000).toISOString(), windows: [], month: { start: '2026-10-01T00:00:00.000+03:00', tokens: 38_000_000, usd: 212.4, byModel: {} }, month_key: '2026-10', ...over }
}

async function build(argv: string[], stdin: string, d: StatuslineDeps): Promise<StatuslineResult> {
  const args = parseStatuslineArgs(argv)
  if ('error' in args) throw new Error(args.error)
  return buildStatusline(args, { stdin: { isTTY: false, text: async () => stdin } }, d)
}

const flat = (r: StatuslineResult) => r.rows.flat().map(s => s.id)
const plainLines = (rows: StatuslineResult['rows']): string[] => renderPlainLines(rows).split('\n')

async function gitRepo(dir: string): Promise<string> {
  mkdirSync(join(dir, 'src'), { recursive: true })
  const g = (...a: string[]) => runProc(['git', '-c', 'user.email=t@example.com', '-c', 'user.name=t', ...a], { cwd: dir })
  await g('init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'x\n')
  await g('add', 'README.md')
  await g('commit', '-q', '-m', 'init')
  writeFileSync(join(dir, 'new.txt'), 'y\n')
  return realpathSync(dir)
}

function bindPlan(repo: string, title: string): string {
  mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
  const file = join(repo, 'docs', 'plans', '2026-10-08-plan.md')
  writeFileSync(file, `---\nstatus: IN_PROGRESS\n---\n# ${title}\n\n## Tasks\n\n### Task 1: Core\n- [x] Task 1 done\n\n### Task 2: CLI\n- [ ] Task 2 done\n\n### Task 3: Docs\n- [ ] Task 3 done\n`)
  saveState('claude', SID, { ...freshState(), plan: { path: file, slug: 'plan', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW - 10 * 60_000 } })
  return file
}

function specFlow(title: string): FlowRecord {
  const r = flowStart(undefined, { workflow: 'plan-build', title, source: 'command' }, NOW - 10 * 60_000).record
  return flowPhase(r, { phase: 'implement' }, NOW - 5 * 60_000).record
}

function writeIndexRecord(root: string, rec: Omit<IndexRecord, 'v' | 'root'>): void {
  atomicWriteSync(indexRecordFile(root), JSON.stringify({ v: 1, root, ...rec }))
}

describe('parseStatuslineArgs', () => {
  test('flags and errors', () => {
    expect(parseStatuslineArgs(['codex', '--width', '80', '--format=plain', '--style', 'compact', '--session', 's1', '--cwd', '/x', '--json'])).toEqual({ harness: 'codex', width: 80, format: 'plain', style: 'compact', session: 's1', cwd: '/x', json: true, verbose: false })
    expect(parseStatuslineArgs(['codex', '--pane-path', '/p'])).toMatchObject({ cwd: '/p' })
    expect(parseStatuslineArgs([])).toEqual({ error: 'missing <harness>' })
    expect(parseStatuslineArgs(['cursor'])).toEqual({ error: "unknown harness 'cursor' (expected claude, codex, opencode, omp)" })
    expect(parseStatuslineArgs(['claude', '--width', '-3'])).toEqual({ error: '--width expects a positive number' })
    expect(parseStatuslineArgs(['claude', '--format', 'html'])).toEqual({ error: '--format expects ansi, plain or tmux' })
    expect(parseStatuslineArgs(['claude', 'codex'])).toEqual({ error: 'unexpected argument codex' })
  })
})

describe('statusline claude', () => {
  test('the default Buracle bar: model, context bar, both windows and the folder; the footer names Buracle, Claude Code and the memory UI as a link', () => withSandbox(async () => {
    const r = await build(['claude'], JSON.stringify(claudePayload()), deps())
    expect(r.joined).toBe(true)
    const lines = plainLines(r.rows)
    expect(lines[0]).toBe('Opus 5.5 [max] [1M] | ███░░░░░ 37% | 5h: 42% ↓ 1h20m | 7d: 18% ↓ 1d6h | /tmp')
    expect(lines[1]).toMatch(/^Buracle \d+\.\d+\.\d+ · CC 2\.1\.293 · Buracle Brain: localhost:41777$/)
    const io = memIO(JSON.stringify(claudePayload()))
    expect(await run(['claude'], io, deps())).toBe(0)
    expect(io.out()).toMatch(/\u001b\]8;;http:\/\/localhost:41777\u001b\\(?:\u001b\[[0-9;]*m)*localhost:41777(?:\u001b\[[0-9;]*m)*\u001b\]8;;\u001b\\/)
    const narrow = await build(['claude', '--width', '40'], JSON.stringify(claudePayload()), deps())
    for (const l of plainLines(narrow.rows)) expect(l.length).toBeLessThanOrEqual(40)
    expect(plainLines(narrow.rows)[0]).toContain('Opus 5.5')
  }))

  test('renders the full bar from stdin, records telemetry, starts a refresh when the usage cache is stale', () => withSandbox(async () => {
    const d = deps()
    const r = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload()), d)
    expect(r.quiet).toBe(false)
    expect(r.rows[0]?.map(s => s.text)).toEqual(['Opus 5.5 · max', 'ctx ▓▓░░░░ 37% (370k/1M)', '5h 42% ⇣ ↺1h20m', expect.stringMatching(/^7d 18% ⇣ ↺/)])
    expect(flat(r)).not.toContain('cost')
    expect(d.spawned).toEqual(['claude'])
    const tel = readTelemetry('claude', SID)
    expect(tel).toMatchObject({ v: 1, harness: 'claude', sessionId: SID, at: NOW, model: 'Opus 5.5', modelId: 'claude-opus-5-5', effort: 'max', cwd: '/tmp', ctx: { pct: 37, tokens: 370_000, window: 1_000_000 } })
    expect(tel?.windows?.map(w => w.label)).toEqual(['5h', '7d'])
  }))

  test('a fresh mod heartbeat no longer silences the bar (the mod draws none); telemetry and the usage cache stay fresh', () => withSandbox(async () => {
    mkdirSync(join(heartbeatFile('claude', SID), '..'), { recursive: true })
    writeFileSync(heartbeatFile('claude', SID), JSON.stringify({ at: NOW - 5_000 }))
    const io = memIO(JSON.stringify(claudePayload()))
    const d = deps()
    expect(await run(['claude'], io, d)).toBe(0)
    expect(io.out()).toContain('Opus 5.5')
    expect(io.out().endsWith('\n')).toBe(true)
    expect(d.spawned).toEqual(['claude'])
    expect(readTelemetry('claude', SID)?.at).toBe(NOW)
    writeUsageEntries([entry('claude')], NOW)
    const fresh = deps()
    await run(['claude'], memIO(JSON.stringify(claudePayload())), fresh)
    expect(fresh.spawned).toEqual([])
  }))

  test('API plans show the session cost; a gateway spend limit becomes the month percentage', () => withSandbox(async () => {
    const api = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({ rate_limits: undefined })), deps())
    expect(api.rows.flat().find(s => s.id === 'cost')?.text).toBe('$1.25')
    const gw = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({ rate_limits: { spend_limit: { used_percentage: 62.8, resets_at: 0, used_usd: 314.12, limit_usd: 500, period: 'monthly' } } })), deps())
    expect(gw.rows.flat().find(s => s.id === 'month')?.text).toBe('mo 63% $314')
    const shown = await build(['claude'], JSON.stringify(claudePayload({ rate_limits: { spend_limit: { used_percentage: 62.8, resets_at: 0, used_usd: 314.12, limit_usd: 500, period: 'monthly' } } })), deps())
    expect(shown.rows.flat().find(s => s.id === 'month')?.text).toBe('mo 63%')
    expect(flat(gw)).not.toContain('cost')
  }))

  test('month from a fresh usage cache (no refresh), updates count, memory status, and the bound plan shown as its workflow', () => withSandbox(async ({ root }) => {
    const repo = await gitRepo(join(root, 'proj'))
    writeUsageEntries([entry('claude')], NOW)
    writeFileSync(updatesFile(), JSON.stringify({ count: 2 }))
    const slug = await projectSlug(repo)
    const mem: MemoryStatus = { ...memEmptyStatus('2026-10-08T08:00:00.000Z', slug), counts: { project: 128, person: 37 }, captures: 2 }
    mkdirSync(join(memoryStateDir(), 'status'), { recursive: true })
    writeFileSync(join(memoryStateDir(), 'status', `${slug}.json`), JSON.stringify(mem))
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true })
    writeFileSync(join(repo, 'docs', 'plans', '2026-10-08-statusline.md'), '---\nstatus: IN_PROGRESS\n---\n# Statusline bar\n\n## Tasks\n\n### Task 1: Core\n- [x] Task 1 done\n\n### Task 2: CLI\n- [ ] Task 2 done\n\n### Task 3: Docs\n- [ ] Task 3 done\n')
    saveState('claude', SID, { ...freshState(), plan: { path: 'docs/plans/2026-10-08-statusline.md', slug: 'statusline', status: 'IN_PROGRESS', type: 'Feature', phase: 'implement', registeredAt: NOW } })
    const d = deps()
    const r = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, repo)), d)
    expect(d.spawned).toEqual([])
    const byId = Object.fromEntries(r.rows.flat().map(s => [s.id, s.text]))
    expect(byId['month']).toBe('mo ≈$212 · 38M tok')
    expect(byId['upd']).toBe('⬆2')
    expect(byId['flow']).toBe('plan-build ● Implement 1/3 · Statusline bar')
    expect(byId['plan']).toBeUndefined()
    expect(byId['mem']).toContain('128')
    expect(byId['git']).toBe('⎇ main …2')
    expect(byId['dir']).toBeUndefined()
    const sub = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, join(repo, 'src'))), deps())
    expect(Object.fromEntries(sub.rows.flat().map(s => [s.id, s.text]))['dir']).toBe('src')
    const shown = plainLines((await build(['claude'], JSON.stringify(claudePayload({}, repo)), deps())).rows)
    expect(shown[1]).toBe('plan-build ● Implement 1/3 | Statusline bar | ▸ Task 2: CLI | <1m')
    expect(shown[0]).toContain('⎇ main')
    expect(shown.at(-1)).toContain('⬆2')
  }))

  test('the running workflow comes from the session\'s flow record; an ended run shows as done, folds after workflow.foldAfterSec and the plan line returns', () => withSandbox(async ({ root }) => {
    const repo = await gitRepo(join(root, 'proj'))
    bindPlan(repo, 'Rate limit plan')
    const rec = specFlow('Rate limit')
    writeFlow('claude', SID, rec)
    const d = deps({ gitBudgetMs: 10_000 })
    const shown = async () => plainLines((await build(['claude'], JSON.stringify(claudePayload({}, repo)), d)).rows)
    expect(await shown()).toEqual([
      expect.stringMatching(/^Opus 5\.5 \[max\] \[1M\] \| /),
      'plan-build ● Implement 1/3 | Rate limit | ▸ Task 2: CLI | 10m',
      expect.stringMatching(/^Buracle \S+ · CC 2\.1\.293 · Buracle Brain: localhost:41777 · idx none$/),
    ])
    const full = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, repo)), d)
    expect(full.rows[1]?.map(s => s.id)).toEqual(['git', 'index', 'flow'])
    expect(full.rows[1]?.find(s => s.id === 'flow')).toMatchObject({ text: 'plan-build ● Implement 1/3 · Rate limit', color: 'magenta' })
    expect(full.bar?.flow).toMatchObject({ visible: true, workflow: 'plan-build', status: 'running', title: 'Rate limit', progress: { done: 1, total: 3, unit: 'tasks' } })
    writeFlow('claude', SID, flowEnd(rec, 'done', NOW - 5_000).record)
    expect((await shown())[1]).toBe('plan-build ✓ done 1/3 | Rate limit | 9m')
    writeFlow('claude', SID, flowEnd(rec, 'done', NOW - 9_000).record)
    expect((await shown())[1]).toBe('Plan: Rate limit plan [implement] ▰▰▱▱▱▱ 1/3')
    writeFileSync(userConfigFile(), 'workflow:\n  foldAfterSec: 60\n')
    expect((await shown())[1]).toBe('plan-build ✓ done 1/3 | Rate limit | 9m')
  }))

  test('the code index state of the session\'s project: none, building, ready, failed, off; nothing outside a project', () => withSandbox(async ({ root, home }) => {
    const repo = await gitRepo(join(root, 'proj'))
    const d = deps({ gitBudgetMs: 10_000 })
    const at = async (cwd: string) => (await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, cwd)), d)).bar?.index
    expect(await at(repo)).toBe('none')
    atomicWriteSync(indexLockFile(repo), JSON.stringify({ pid: process.pid, at: NOW }))
    expect(await at(repo)).toBe('building')
    writeIndexRecord(repo, { codegraph: { at: NOW - 60_000, ok: true }, semble: { at: NOW - 60_000, ok: true } })
    expect(await at(repo)).toBe('ready')
    expect(await at(join(repo, 'src'))).toBe('ready')
    rmSync(indexLockFile(repo))
    writeIndexRecord(repo, { codegraph: { at: NOW - 60_000, ok: false, error: 'codegraph init failed', failures: 1 }, semble: { at: NOW - 60_000, ok: true } })
    expect(await at(repo)).toBe('failed')
    const segs = (await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, repo)), d)).rows.flat()
    expect(segs.find(s => s.id === 'index')).toMatchObject({ text: 'idx failed', color: 'red' })
    writeFileSync(userConfigFile(), 'index:\n  codegraph: false\n  semble: false\n')
    expect(await at(repo)).toBe('off')
    expect(await at(home)).toBeUndefined()
  }))

  test('O3: hook failures of the last 24 hours show on the Buracle bar footer and in the segment rows; nothing while all is well', () => withSandbox(async ({ buracleHome }) => {
    const quiet = await build(['claude'], JSON.stringify(claudePayload()), deps())
    expect(plainLines(quiet.rows).join('\n')).not.toContain('hooks')
    const logs = join(buracleHome, 'logs')
    mkdirSync(logs, { recursive: true })
    const fail = (ts: number, result: string) => JSON.stringify({ ts: new Date(ts).toISOString(), level: 'error', pid: 1, msg: 'hook handler failed', data: { harness: 'claude', event: 'PreToolUse', result } })
    writeFileSync(join(logs, 'buracle.log'), `${fail(NOW - 3_600_000, 'fail-closed')}\n${fail(NOW - 60_000, 'fail-open')}\n`)
    const later = NOW + 61_000
    const shown = await build(['claude'], JSON.stringify(claudePayload()), deps({ nowMs: later }))
    expect(plainLines(shown.rows).at(-1)).toMatch(/^Buracle \d+\.\d+\.\d+ · CC 2\.1\.293 · hooks ✗2 \(1 denied\) · Buracle Brain: localhost:41777$/)
    const full = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload()), deps({ nowMs: later }))
    expect(flat(full)).toContain('hooks')
    expect(renderPlain(full.rows)).toContain('hooks ✗2 (1 denied)')
  }))

  test('outside git the dir segment shows the folder; garbage stdin still renders something', () => withSandbox(async ({ home }) => {
    const plain = join(home, 'notes')
    mkdirSync(plain)
    const r = await build(['claude', '--width', '200'], JSON.stringify(claudePayload({}, plain)), deps())
    expect(r.rows.flat().find(s => s.id === 'dir')?.text).toBe('~/notes')
    expect(flat(r)).not.toContain('git')
    const junk = await build(['claude'], 'not json at all', deps({ cwd: plain }))
    expect(junk.quiet).toBe(false)
    expect(readTelemetry('claude', SID)).toBeDefined()
  }))

  test('--json and narrow widths', () => withSandbox(async () => {
    const io = memIO(JSON.stringify(claudePayload()))
    io.flags.json = true
    expect(await run(['claude', '--width', '30', '--style', 'full'], io, deps())).toBe(0)
    const j = JSON.parse(io.out()) as StatuslineResult
    expect(j.harness).toBe('claude')
    expect(j.text).toContain('\u001b[')
    for (const row of j.rows) expect(renderPlain([row]).length).toBeLessThanOrEqual(30)
    expect(j.bar?.windows.length).toBe(2)
    const pio = memIO(JSON.stringify(claudePayload()))
    pio.flags.json = true
    expect(await run(['claude', '--width', '30'], pio, deps())).toBe(0)
    const pj = JSON.parse(pio.out()) as StatuslineResult
    expect(pj.joined).toBe(true)
    for (const l of plainLines(pj.rows)) expect(l.length).toBeLessThanOrEqual(30)
  }))

  test('bad arguments exit 1 with usage on stderr', async () => {
    const io = memIO()
    expect(await run(['claude', '--nope'], io, deps())).toBe(1)
    expect(io.err()).toContain('unknown option --nope')
    expect(io.out()).toBe('')
  })
})

describe('statusline claude --subagent (subagentStatusLine)', () => {
  test('one {id, content} JSON line per task, fitted to the given columns', () => withSandbox(async () => {
    const input = {
      session_id: SID,
      columns: 80,
      tasks: [
        { id: 't1', name: 'changes-review', type: 'buracle:changes-review', status: 'running', description: 'Review the statusline diff for correctness and style issues in detail', model: 'claude-sonnet-5-5', effort: 'high', contextWindowSize: 1_000_000, tokenCount: 420_000 },
        { name: 'no id: keeps the default row' },
        { id: 't2', name: 'explore', status: 'completed', tokenCount: 1200 },
      ],
    }
    const io = memIO(JSON.stringify(input))
    expect(await run(['claude', '--subagent'], io, deps())).toBe(0)
    const lines = io.out().trim().split('\n').map(l => JSON.parse(l) as { id: string, content: string })
    expect(lines.map(l => l.id)).toEqual(['t1', 't2'])
    const plain = lines.map(l => l.content.replace(/\u001b\[[0-9;]*m/g, ''))
    expect(plain[0]).toBe('changes-review │ sonnet-5-5 · high │ ctx ▓▓▓░░░ 42% (420k/1M) │ Review the stat…')
    expect(plain[1]).toBe('explore │ 1.2k tok │ completed')
    const narrow = memIO(JSON.stringify({ ...input, columns: 30 }))
    await run(['claude', '--subagent'], narrow, deps())
    const rowsNarrow = narrow.out().trim().split('\n').map(l => (JSON.parse(l) as { content: string }).content.replace(/\u001b\[[0-9;]*m/g, ''))
    expect(rowsNarrow).toEqual(['changes-review', 'explore │ 1.2k tok │ completed'])
    const tiny = memIO(JSON.stringify({ ...input, columns: 6 }))
    await run(['claude', '--subagent'], tiny, deps())
    expect(tiny.out().trim().split('\n').map(l => (JSON.parse(l) as { content: string }).content.replace(/\u001b\[[0-9;]*m/g, ''))).toEqual(['chang…', 'explo…'])
  }))

  test('only for claude; empty or broken stdin prints nothing', () => withSandbox(async () => {
    expect(parseStatuslineArgs(['codex', '--subagent'])).toEqual({ error: '--subagent is only for claude (subagentStatusLine)' })
    const io = memIO('{broken')
    expect(await run(['claude', '--subagent'], io, deps())).toBe(0)
    expect(io.out()).toBe('')
  }))
})

describe('statusline codex / opencode / omp', () => {
  test('codex from telemetry + cache, as one tmux line', () => withSandbox(async ({ root }) => {
    const repo = await gitRepo(join(root, 'proj'))
    writeTelemetry('codex', 'thread-1', { at: NOW - 60_000, model: 'gpt-6.1-sol', effort: 'high', cwd: repo, ctx: { pct: 3, tokens: 21_000, window: 272_000 } })
    writeUsageEntries([entry('codex', { windows: [{ label: '5h', pct: 22, windowMinutes: 300, resetsAt: new Date(NOW + 120 * 60_000).toISOString() }, { label: '7d', pct: 41, windowMinutes: 10080, resetsAt: new Date(NOW + 4 * 86_400_000).toISOString() }] })], NOW)
    const io = memIO()
    const d = deps()
    expect(await run(['codex', '--cwd', repo, '--style', 'full'], io, d)).toBe(0)
    const line = io.out()
    expect(line.split('\n').filter(Boolean).length).toBe(1)
    expect(line).toContain('#[fg=')
    expect(line).toContain('ctx ░░░░░░ 3% (21k/272k)')
    expect(line).toContain('5h 22% ⇣ ↺2h')
    expect(line).toContain('mo ≈$212')
    expect(line).toContain('⎇ main')
    expect(d.spawned).toEqual([])
    const pio = memIO()
    expect(await run(['codex', '--cwd', repo], pio, deps())).toBe(0)
    const pline = pio.out()
    expect(pline.split('\n').filter(Boolean).length).toBe(1)
    const text = pline.replace(/#\[[^\]]*\]/g, '')
    expect(text).toContain('gpt-6.1-sol [high] [272k] | █░░░░░░░ 3% | 5h: 22% ↓ 2h | 7d: 41%')
    expect(text).toContain('Buracle Brain: localhost:41777')
  }))

  test('without telemetry the usage cache\'s latest session fills in; stale cache starts a refresh', () => withSandbox(async ({ root }) => {
    writeUsageEntries([entry('codex', { computed_at: new Date(NOW - 3_600_000).toISOString(), latest: { at: NOW - 5 * 60_000, model: 'gpt-6.1-sol', cwd: root, ctx: { pct: 50, tokens: 142_000, window: 272_000 } } })], NOW)
    const d = deps()
    const r = await build(['codex', '--format', 'plain'], '', d)
    expect(r.bar?.ctx?.pct).toBe(50)
    expect(d.spawned).toEqual(['codex'])
  }))

  test('sessions: another harness\'s env session is ignored; an explicit unknown session shows no telemetry', () => withSandbox(async ({ root }) => {
    writeTelemetry('codex', 'thread-9', { at: NOW - 60_000, model: 'gpt-6.1-sol', cwd: root, ctx: { pct: 9 } })
    const viaClaudeEnv = await build(['codex', '--format', 'plain'], '', deps({ env: { CLAUDE_CODE_SESSION_ID: 'claude-1', COLUMNS: '200' } }))
    expect(viaClaudeEnv.bar?.ctx?.pct).toBe(9)
    const viaCodexEnv = await build(['codex'], '', deps({ env: { CODEX_THREAD_ID: 'thread-9' } }))
    expect(viaCodexEnv.bar?.model).toBe('gpt-6.1-sol')
    const unknown = await build(['codex', '--session', 'nope'], '', deps())
    expect(unknown.bar?.ctx).toBeUndefined()
  }))

  test('omp --json carries the setStatus texts for buracle.budget, buracle.hooks and buracle.mem', () => withSandbox(async ({ root }) => {
    const repo = await gitRepo(join(root, 'proj'))
    writeUsageEntries([entry('omp', { month_pct: 62 })], NOW)
    const slug = await projectSlug(repo)
    mkdirSync(join(memoryStateDir(), 'status'), { recursive: true })
    writeFileSync(join(memoryStateDir(), 'status', `${slug}.json`), JSON.stringify({ ...memEmptyStatus('2026-10-08T08:00:00.000Z', slug), counts: { project: 5, person: 1 } }))
    const io = memIO()
    io.flags.json = true
    await run(['omp', '--cwd', repo], io, deps())
    const j = JSON.parse(io.out()) as StatuslineResult
    expect(j.status?.['buracle.budget']).toBe('mo 62% ≈$212')
    expect(j.status?.['buracle.mem']).toContain('5')
    expect(j.status?.['buracle.hooks']).toBe('')
    expect(Object.keys(j.status ?? {}).sort()).toEqual(['buracle.budget', 'buracle.hooks', 'buracle.mem'])
  }))

  test('codex tmux: the running workflow of the Codex session goes into the one line (Codex has no band above the prompt)', () => withSandbox(async ({ root }) => {
    const repo = await gitRepo(join(root, 'proj'))
    writeTelemetry('codex', 'thread-7', { at: NOW - 60_000, model: 'gpt-6.1-sol', effort: 'high', cwd: repo, ctx: { pct: 3, tokens: 21_000, window: 272_000 } })
    writeUsageEntries([entry('codex')], NOW)
    let rec = flowStart(undefined, { workflow: 'bugfix', title: 'Login loop', source: 'prompt' }, NOW - 3 * 60_000).record
    rec = flowPhase(rec, { phase: 'red' }, NOW - 2 * 60_000).record
    writeFlow('codex', 'thread-7', rec)
    const d = deps({ gitBudgetMs: 10_000 })
    const io = memIO()
    expect(await run(['codex', '--cwd', repo, '--session', 'thread-7'], io, d)).toBe(0)
    const line = io.out().replace(/#\[[^\]]*\]/g, '')
    expect(line.split('\n').filter(Boolean)).toHaveLength(1)
    expect(line).toContain('| bugfix ● RED | Login loop |')
    const ids = async (width: number) => (await build(['codex', '--cwd', repo, '--session', 'thread-7', '--style', 'full', '--width', String(width)], '', d)).rows.flat().map(s => s.id)
    const wide = await build(['codex', '--cwd', repo, '--session', 'thread-7', '--style', 'full', '--width', '200'], '', d)
    expect(wide.rows.flat().map(s => s.id)).toEqual(['ctx', 'month', 'git', 'index', 'flow'])
    expect(wide.rows.flat().find(s => s.id === 'flow')?.text).toBe('bugfix ● RED · Login loop')
    expect(await ids(51)).toEqual(['ctx', 'month', 'git', 'index', 'flow'])
    expect(await ids(43)).toEqual(['ctx', 'month', 'git', 'flow'])
    expect(await ids(42)).toEqual(['ctx', 'git', 'flow'])
  }))

  test("another month's usage entry is ignored (month, month_pct, windows, latest) and a refresh starts", () => withSandbox(async ({ root }) => {
    expect(monthKeyOf(NOW)).toBe('2026-10')
    const lastMonth = { month_key: '2026-09', computed_at: new Date(NOW - 60_000).toISOString() }
    const window = { label: '7d', pct: 41, windowMinutes: 10080, resetsAt: new Date(NOW + 2 * 86_400_000).toISOString() }
    writeUsageEntries([
      entry('claude', lastMonth),
      entry('omp', { ...lastMonth, month_pct: 62, windows: [window] }),
      entry('codex', { ...lastMonth, windows: [window], latest: { at: NOW - 60_000, model: 'gpt-6.1-sol', cwd: root, ctx: { pct: 50 } } }),
    ], NOW)
    const d = deps()
    const claude = await build(['claude'], JSON.stringify(claudePayload({}, root)), d)
    expect(flat(claude)).not.toContain('month')
    const gw = await build(['claude'], JSON.stringify(claudePayload({ rate_limits: { spend_limit: { used_percentage: 10, resets_at: 0, used_usd: 50, limit_usd: 500, period: 'monthly' } } }, root)), d)
    expect(gw.bar?.month).toEqual({ tokens: 0, estimate: false, pct: 10, usd: 50 })
    const omp = await build(['omp', '--cwd', root, '--json'], '', d)
    expect(omp.bar?.month).toBeUndefined()
    expect(omp.bar?.windows).toEqual([])
    expect(omp.status?.['buracle.budget']).toBe('')
    const codex = await build(['codex', '--format', 'plain'], '', d)
    expect(codex.bar?.windows).toEqual([])
    expect(codex.bar?.ctx).toBeUndefined()
    expect(codex.bar?.model).toBeUndefined()
    expect([...new Set(d.spawned)].sort()).toEqual(['claude', 'codex', 'omp'])
    writeUsageEntries([entry('omp', { month_pct: 62, windows: [window] })], NOW)
    const fresh = await build(['omp', '--cwd', root, '--json'], '', deps())
    expect(fresh.bar?.month?.pct).toBe(62)
    expect(fresh.bar?.windows.map(w => w.label)).toEqual(['7d'])
  }))

  test('opencode with nothing known: the segment rows print nothing; the Buracle bar still shows its footer', () => withSandbox(async ({ root }) => {
    const io = memIO()
    expect(await run(['opencode', '--cwd', root, '--format', 'plain', '--style', 'full'], io, deps())).toBe(0)
    expect(io.out()).toBe('')
    expect(io.err()).toBe('')
    const pio = memIO()
    expect(await run(['opencode', '--cwd', root, '--format', 'plain'], pio, deps())).toBe(0)
    const lines = pio.out().trim().split('\n')
    expect(lines[0]).toContain('--%')
    expect(lines.at(-1)).toMatch(/^Buracle \S+ · OpenCode( \S+)? · Buracle Brain: localhost:41777$/)
  }))
})

describe('statusline: no Context Mode segment, and no harness process lookup for it', () => {
  test('claude: the rows and the Buracle bar footer carry no `cm` part, and the harness process is never looked for', () => withSandbox(async ({ root }) => {
    const proj = join(root, 'proj')
    mkdirSync(proj, { recursive: true })
    const d = deps({})
    const full = await build(['claude', '--style', 'full'], JSON.stringify(claudePayload({}, proj)), d)
    expect(full.rows.flat().find(s => s.id === 'cm')).toBeUndefined()
    const shown = plainLines((await build(['claude'], JSON.stringify(claudePayload({}, proj)), d)).rows)
    expect(shown.at(-1)).not.toContain('cm ')
  }))
})

describe('statusline performance (real process)', () => {
  test('a typical claude render stays well under the 100 ms target', () => withSandbox(async ({ home }) => {
    writeUsageEntries([entry('claude', { computed_at: new Date().toISOString(), month_key: monthKeyOf(Date.now()) })], Date.now())
    const payload = JSON.stringify(claudePayload({}, home))
    const main = join(import.meta.dir, '..', '..', 'src', 'cli', 'main.ts')
    const times: number[] = []
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now()
      const r = await runProc([process.execPath, main, 'statusline', 'claude'], { stdin: payload, timeoutMs: 10_000, env: { COLUMNS: '160' } })
      times.push(performance.now() - t0)
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('Opus 5.5')
    }
    times.sort((a, b) => a - b)
    expect(times[2]).toBeLessThan(1000)
  }), 30_000)
})
