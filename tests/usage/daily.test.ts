import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runUsage } from '../../src/cli/commands/usage'
import { collectClaude } from '../../src/usage/claude'
import { collectCodex } from '../../src/usage/codex'
import { sessionUsage, usageHistory } from '../../src/usage/history'
import { collectOmp } from '../../src/usage/omp'
import { collectOpencode } from '../../src/usage/opencode'
import { cursorFile } from '../../src/usage/scan'
import { withSandbox } from '../helpers/sandbox'

const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime()
const iso = (day: number, hour = 12) => new Date(at(day, hour)).toISOString()
const NOW = at(8)
const CLAUDE_SID = '5f1e0c3a-1111-4222-8333-944445555666'
const CODEX_SID = '0199b1a2-1111-7000-8000-000000000042'
const OMP_SID = '019c625b-1111-7000-8000-000000000077'

function write(path: string, lines: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
}

function claudeLine(day: number, id: string, input: number, output: number, model = 'claude-opus-5-5') {
  return { type: 'assistant', timestamp: iso(day), requestId: `req-${id}`, message: { id, model, usage: { input_tokens: input, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
}

function seed(home: string): void {
  write(join(home, '.claude', 'projects', '-w-proj', `${CLAUDE_SID}.jsonl`), [claudeLine(5, 'm1', 100, 50), claudeLine(6, 'm2', 300, 100), claudeLine(6, 'm3', 40, 10, 'claude-haiku-5-5')])
  write(join(home, '.claude', 'projects', '-w-proj', CLAUDE_SID, 'subagents', 'agent-x.jsonl'), [claudeLine(6, 'm4', 20, 5, 'claude-haiku-5-5')])
  write(join(home, '.codex', 'sessions', '2026', '10', '05', `rollout-2026-10-05T12-00-00-${CODEX_SID}.jsonl`), [
    { timestamp: iso(5), type: 'session_meta', payload: { id: CODEX_SID, cwd: '/w/proj' } },
    { timestamp: iso(5), type: 'turn_context', payload: { model: 'gpt-6.1-sol' } },
    { timestamp: iso(5), type: 'token_usage_record', payload: { response_id: 'r1', usage: { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, total_tokens: 1100 } } },
    { timestamp: iso(7), type: 'token_usage_record', payload: { response_id: 'r2', usage: { input_tokens: 2000, cached_input_tokens: 0, output_tokens: 200, total_tokens: 2200 } } },
  ])
  write(join(home, '.omp', 'agent', 'sessions', '-w-proj', `2026-10-05T12-00-00-000Z_${OMP_SID}.jsonl`), [
    { type: 'session', version: 3, id: OMP_SID, timestamp: iso(5), cwd: '/w/proj' },
    { type: 'message', id: 'a1', timestamp: iso(5), message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5-5', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.25 } } } },
    { type: 'message', id: 'a2', timestamp: iso(7), message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5-5', usage: { input: 400, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 480, cost: { total: 0.5 } } } },
  ])
  const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db')
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = new Database(dbPath, { create: true })
  db.run('CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)')
  const row = db.prepare('INSERT INTO session_message VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)')
  const msg = (cost: number, input: number, output: number) => JSON.stringify({ model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' }, cost, tokens: { input, output, reasoning: 0, cache: { read: 0, write: 0 } } })
  row.run('o1', 'ses_one', 'assistant', 1, at(4), msg(0.125, 60, 40))
  row.run('o2', 'ses_one', 'assistant', 2, at(6), msg(0.375, 150, 50))
  row.run('o3', 'ses_two', 'assistant', 1, at(6), msg(0.5, 300, 100))
  row.run('o4', 'ses_old', 'assistant', 1, new Date(2026, 8, 20, 12).getTime(), msg(1, 900, 100))
  db.close()
}

describe('daily usage on all four harnesses', () => {
  test('each collector adds the days of the month with their tokens and estimate, summing to the month', () => withSandbox(async ({ home }) => {
    seed(home)
    const claude = await collectClaude({ nowMs: NOW, pricing: {} })
    expect(claude.days).toEqual([{ day: '2026-10-05', tokens: 150 }, { day: '2026-10-06', tokens: 475 }])
    const codex = await collectCodex({ nowMs: NOW, pricing: {}, which: () => undefined })
    expect(codex.days).toEqual([{ day: '2026-10-05', tokens: 1100 }, { day: '2026-10-07', tokens: 2200 }])
    const omp = await collectOmp({ nowMs: NOW, pricing: {}, offline: true })
    expect(omp.days).toEqual([{ day: '2026-10-05', tokens: 120, usd: 0.25 }, { day: '2026-10-07', tokens: 480, usd: 0.5 }])
    const opencode = await collectOpencode({ nowMs: NOW, pricing: {} })
    expect(opencode.days).toEqual([{ day: '2026-10-04', tokens: 100, usd: 0.125 }, { day: '2026-10-06', tokens: 600, usd: 0.875 }])
    for (const e of [claude, codex, omp, opencode]) expect((e.days ?? []).reduce((n, d) => n + d.tokens, 0)).toBe(e.month.tokens)
  }))

  test('the history reads the stores without scanning: days, months and models per harness, and the cost of each session', () => withSandbox(async ({ home }) => {
    seed(home)
    await collectClaude({ nowMs: NOW, pricing: {} })
    await collectCodex({ nowMs: NOW, pricing: {}, which: () => undefined })
    await collectOmp({ nowMs: NOW, pricing: {}, offline: true })
    const h = usageHistory({ nowMs: NOW, pricing: {}, days: 7, months: 2 })
    expect(h.days).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08'])
    expect(h.months).toEqual(['2026-09', '2026-10'])
    expect(h.harnesses.claude.days).toEqual({ '2026-10-05': { tokens: 150 }, '2026-10-06': { tokens: 475 } })
    expect(h.harnesses.claude.models).toEqual({ 'claude-haiku-5-5': { tokens: 75 }, 'claude-opus-5-5': { tokens: 550 } })
    expect(h.harnesses.codex.months).toEqual({ '2026-10': { tokens: 3300 } })
    expect(h.harnesses.omp.days['2026-10-07']).toEqual({ tokens: 480, usd: 0.5 })
    expect(h.harnesses.opencode.months).toEqual({ '2026-09': { tokens: 1000, usd: 1 }, '2026-10': { tokens: 700, usd: 1 } })
    expect(h.harnesses.opencode.days['2026-10-06']).toEqual({ tokens: 600, usd: 0.875 })
    const s = sessionUsage({ nowMs: NOW, sinceMs: at(1), pricing: {} })
    expect(s.get(`claude:${CLAUDE_SID}`)).toEqual({ tokens: 625 })
    expect(s.get(`codex:${CODEX_SID}`)).toEqual({ tokens: 3300 })
    expect(s.get(`omp:${OMP_SID}`)).toEqual({ tokens: 600, usd: 0.75 })
    expect(s.get('opencode:ses_one')).toEqual({ tokens: 300, usd: 0.5 })
    expect(s.get('opencode:ses_two')).toEqual({ tokens: 400, usd: 0.5 })
  }))

  test('an unchanged OpenCode database is read once for each range the page asks for, not again on every call', () => withSandbox(async ({ home }) => {
    seed(home)
    const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db')
    const round = () => ({ history: usageHistory({ nowMs: NOW, pricing: {}, days: 7, months: 2 }).harnesses.opencode, session: sessionUsage({ nowMs: NOW, sinceMs: at(1), pricing: {} }).get('opencode:ses_one') })
    const first = round()
    expect(first.history.notes).toBeUndefined()
    expect(first.session).toEqual({ tokens: 300, usd: 0.5 })
    chmodSync(dbPath, 0o000)
    try {
      expect(round()).toEqual(first)
      expect(round()).toEqual(first)
    } finally { chmodSync(dbPath, 0o644) }
  }))

  test('a store written before the day buckets is read again once; the month stays the same and a gone file keeps its months', () => withSandbox(async ({ home }) => {
    seed(home)
    await collectClaude({ nowMs: NOW, pricing: {} })
    const file = cursorFile('claude')
    const store = JSON.parse(readFileSync(file, 'utf8')) as { files: Record<string, Record<string, unknown>> }
    for (const cur of Object.values(store.files)) { delete cur['days']; delete cur['session'] }
    store.files['/gone/old-session.jsonl'] = { size: 10, mtimeMs: 1, offset: 10, tail: '', order: 0, primary: { '2026-09': { 'claude-opus-5-5': { tokens: 999, costUsd: 0, unpriced: { input: 999, output: 0, cacheRead: 0, cacheWrite: 0 } } } }, keys: {}, carry: { recent: [] }, hasPrimary: true }
    writeFileSync(file, JSON.stringify(store))
    const again = await collectClaude({ nowMs: NOW, pricing: {} })
    expect(again.month.tokens).toBe(625)
    expect(again.days).toEqual([{ day: '2026-10-05', tokens: 150 }, { day: '2026-10-06', tokens: 475 }])
    expect((await collectClaude({ nowMs: NOW, pricing: {}, month: '2026-09' })).month.tokens).toBe(999)
    expect(sessionUsage({ nowMs: NOW, sinceMs: at(1), pricing: {} }).get(`claude:${CLAUDE_SID}`)).toEqual({ tokens: 625 })
    rmSync(join(home, '.claude', 'projects'), { recursive: true, force: true })
    expect((await collectClaude({ nowMs: NOW, pricing: {} })).month.tokens).toBe(625)
  }))

  test('buracle usage --daily prints one line per day with each harness', () => withSandbox(async ({ home }) => {
    seed(home)
    let out = ''
    const io = { stdout: { write: (s: string) => { out += s } }, stderr: { write: () => undefined } }
    expect(await runUsage({ refresh: true, harnesses: ['claude', 'omp'], breakdown: false, daily: true, offline: true, json: false, background: false }, io, { nowMs: NOW })).toBe(0)
    expect(out).toContain('\nBy day\n')
    expect(out).toMatch(/^ {2}2026-10-05 +≈\$0\.25 +270 tok +claude ≈\$0\.00 · omp ≈\$0\.25$/m)
    expect(out).toMatch(/^ {2}2026-10-07 +≈\$0\.50 +480 tok +omp ≈\$0\.50$/m)
  }))
})
