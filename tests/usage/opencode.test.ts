import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { collectOpencode, opencodeDbPath, readOpencodeMonth } from '../../src/usage/opencode'
import { loadPricing } from '../../src/usage/pricing'
import { withEnv, withSandbox } from '../helpers/sandbox'
import { NOW } from './helpers'

const t = (iso: string) => Date.parse(iso)

function buildDb(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true })
  const db = new Database(path, { create: true })
  db.run('PRAGMA journal_mode = WAL')
  db.run(`CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL,
    time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  db.run('CREATE INDEX session_message_time_created_idx ON session_message (time_created)')
  db.run(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL)`)
  const v2 = db.prepare('INSERT INTO session_message VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)')
  const tokens = (input: number, output: number, reasoning: number, read: number, write: number) => ({ input, output, reasoning, cache: { read, write } })
  v2.run('msg_1', 'ses_a', 'assistant', 1, t('2026-10-05T10:00:00Z'), JSON.stringify({ agent: 'build', model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' }, content: [], cost: 0.05, tokens: tokens(1000, 200, 0, 5000, 100), time: { created: t('2026-10-05T10:00:00Z') } }))
  v2.run('msg_2', 'ses_a', 'assistant', 2, t('2026-10-06T10:00:00Z'), JSON.stringify({ agent: 'build', model: { providerID: 'openai', id: 'gpt-6.1-sol', variant: 'high' }, content: [], cost: 0, tokens: tokens(2000, 300, 100, 0, 0), time: { created: t('2026-10-06T10:00:00Z') } }))
  v2.run('msg_3', 'ses_a', 'compaction', 3, t('2026-10-06T11:00:00Z'), JSON.stringify({ status: 'completed', reason: 'auto', model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' }, summary: 's', recent: 'r', cost: 0.01, tokens: tokens(500, 100, 0, 0, 0), time: { created: t('2026-10-06T11:00:00Z') } }))
  v2.run('msg_4', 'ses_a', 'user', 4, t('2026-10-06T12:00:00Z'), JSON.stringify({ text: 'hi', time: { created: t('2026-10-06T12:00:00Z') } }))
  v2.run('msg_5', 'ses_b', 'assistant', 1, t('2026-09-20T10:00:00Z'), JSON.stringify({ agent: 'build', model: { providerID: 'anthropic', id: 'claude-sonnet-5-5' }, content: [], cost: 1.5, tokens: tokens(9000, 900, 0, 0, 0), time: { created: t('2026-09-20T10:00:00Z') } }))
  v2.run('msg_6', 'ses_b', 'compaction', 2, t('2026-10-06T13:00:00Z'), JSON.stringify({ status: 'running', reason: 'manual', summary: '', recent: '', time: { created: t('2026-10-06T13:00:00Z') } }))
  const v1 = db.prepare('INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)')
  v1.run('msg_1', 'ses_a', t('2026-10-05T10:00:00Z'), JSON.stringify({ role: 'assistant', providerID: 'anthropic', modelID: 'claude-sonnet-5-5', cost: 0.05, tokens: tokens(1000, 200, 0, 5000, 100), time: { created: t('2026-10-05T10:00:00Z') } }))
  v1.run('msg_old', 'ses_old', t('2026-10-02T08:00:00Z'), JSON.stringify({ role: 'assistant', providerID: 'anthropic', modelID: 'claude-haiku-5-5', cost: 0.002, tokens: tokens(100, 50, 0, 0, 0), time: { created: t('2026-10-02T08:00:00Z') } }))
  v1.run('msg_user', 'ses_old', t('2026-10-02T07:59:00Z'), JSON.stringify({ role: 'user', time: { created: t('2026-10-02T07:59:00Z') } }))
  db.close()
}

describe('collectOpencode', () => {
  test('v2 messages and billed compactions, v1 leftovers deduplicated by id, cost or list price', () => withSandbox(async ({ home }) => {
    buildDb(join(home, '.local', 'share', 'opencode', 'opencode.db'))
    const e = await collectOpencode({ nowMs: NOW, pricing: loadPricing() })
    expect(e.month.byModel).toEqual({
      'anthropic/claude-haiku-5-5': { tokens: 150, usd: 0.002 },
      'anthropic/claude-sonnet-5-5': { tokens: 6300 + 600, usd: 0.06 },
      'openai/gpt-6.1-sol': { tokens: 2400, usd: 0.008 },
    })
    expect(e.month.tokens).toBe(9450)
    expect(e.month.usd).toBe(0.07)
    expect(e.windows).toEqual([])
    expect(e.notes).toBeUndefined()
    const sep = await collectOpencode({ nowMs: NOW, pricing: loadPricing(), month: '2026-09' })
    expect(sep.month.byModel).toEqual({ 'anthropic/claude-sonnet-5-5': { tokens: 9900, usd: 1.5 } })
  }))

  test('results are cached until the database changes', () => withSandbox(async ({ home }) => {
    const path = join(home, '.local', 'share', 'opencode', 'opencode.db')
    buildDb(path)
    const first = await collectOpencode({ nowMs: NOW, pricing: {} })
    const db = new Database(path)
    db.run('INSERT INTO session_message VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)', ['msg_9', 'ses_a', 'assistant', 9, t('2026-10-07T10:00:00Z'), JSON.stringify({ model: { providerID: 'anthropic', id: 'claude-haiku-5-5' }, cost: 0.001, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } })])
    db.close()
    const second = await collectOpencode({ nowMs: NOW, pricing: {} })
    expect(second.month.tokens).toBe(first.month.tokens + 20)
  }))

  test('a missing database is an empty month with a note', () => withSandbox(async ({ home }) => {
    const e = await collectOpencode({ nowMs: NOW, pricing: {} })
    expect(e.month).toMatchObject({ tokens: 0, byModel: {} })
    expect(e.notes).toEqual([`no OpenCode database at ${join(home, '.local', 'share', 'opencode', 'opencode.db')}`])
  }))

  test('OPENCODE_DB and XDG_DATA_HOME are honored', () => withSandbox(async ({ root }) => {
    await withEnv({ XDG_DATA_HOME: join(root, 'xdg') }, () => {
      expect(opencodeDbPath()).toBe(join(root, 'xdg', 'opencode', 'opencode.db'))
    })
    await withEnv({ OPENCODE_DB: 'opencode-dev.db', XDG_DATA_HOME: join(root, 'xdg') }, () => {
      expect(opencodeDbPath()).toBe(join(root, 'xdg', 'opencode', 'opencode-dev.db'))
    })
    await withEnv({ OPENCODE_DB: join(root, 'custom.db') }, () => {
      expect(opencodeDbPath()).toBe(join(root, 'custom.db'))
    })
  }))

  test('an unreadable database is reported, not thrown', () => withSandbox(async ({ home }) => {
    const path = join(home, '.local', 'share', 'opencode', 'opencode.db')
    mkdirSync(join(path, '..'), { recursive: true })
    await Bun.write(path, 'this is not sqlite')
    const e = await collectOpencode({ nowMs: NOW, pricing: {} })
    expect(e.month.tokens).toBe(0)
    expect(e.notes?.[0]).toStartWith('OpenCode database unreadable')
  }))

  test('readOpencodeMonth on a v1-only database', () => withSandbox(async ({ root }) => {
    const path = join(root, 'v1.db')
    const db = new Database(path, { create: true })
    db.run('CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)')
    db.run('INSERT INTO message VALUES (?1, ?2, ?3, ?3, ?4)', ['m1', 's', t('2026-10-03T00:00:00Z'), JSON.stringify({ role: 'assistant', providerID: 'openai', modelID: 'gpt-6.1-sol', cost: 0, tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } } })])
    db.close()
    const r = readOpencodeMonth(path, t('2026-10-01T00:00:00Z'), t('2026-11-01T00:00:00Z'))
    expect(r.tables).toEqual(['message'])
    expect(r.totals['openai/gpt-6.1-sol']).toEqual({ tokens: 15, costUsd: 0, unpriced: { input: 1, output: 5, cacheRead: 4, cacheWrite: 5 }, priceModel: 'gpt-6.1-sol' })
  }))
})
