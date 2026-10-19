import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as paths from '../../src/engine/paths'
import { closeAllCortex } from '../../src/memory/cortex'
import { projectsFile } from '../../src/memory/layout'
import { writeSessionRecord } from '../../src/memory/session-record'
import { projectRef, saveItem } from '../../src/memory/store'
import { handle, uiContext, type UiContext } from '../../src/memory/ui'
import { notificationsFile, notify, NOTIFICATIONS_KEEP } from '../../src/workflow/notify'
import { docId } from '../../src/workflow/review-notes'
import { writeTelemetry } from '../../src/workflow/session-store'
import { withSandbox } from '../helpers/sandbox'

afterEach(async () => { await closeAllCortex() })

const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime()
const NOW = at(8)
const CLAUDE_SID = '5f1e0c3a-1111-4222-8333-944445555666'
const CODEX_SID = '0199b1a2-1111-7000-8000-000000000042'
const OMP_SID = '019c625b-1111-7000-8000-000000000078'

function ctx(): UiContext {
  return uiContext({ version: '9.9.9', port: 41999, now: () => NOW })
}

async function get(c: UiContext, path: string): Promise<{ status: number, body: Record<string, unknown> }> {
  const r = await handle(new Request(`http://127.0.0.1:${c.port}${path}`, { headers: { host: `127.0.0.1:${c.port}` } }), c)
  return { status: r.status, body: await r.json() as Record<string, unknown> }
}

async function post(c: UiContext, path: string, body: unknown, browser = true): Promise<{ status: number, body: Record<string, unknown> }> {
  const token = (await get(c, '/api/token')).body['token'] as string
  const headers: Record<string, string> = { host: `127.0.0.1:${c.port}`, 'content-type': 'application/json', 'x-buracle-token': token }
  if (browser) Object.assign(headers, { origin: `http://127.0.0.1:${c.port}`, 'sec-fetch-site': 'same-origin' })
  const r = await handle(new Request(`http://127.0.0.1:${c.port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) }), c)
  return { status: r.status, body: await r.json() as Record<string, unknown> }
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

function registerProject(root: string, slug: string): string {
  const dir = join(root, slug)
  mkdirSync(dir, { recursive: true })
  write(projectsFile(), JSON.stringify({ v: 1, projects: { [slug]: { slug, scope: 'project', roots: [dir], ownerRepo: `me/${slug}` } } }))
  return dir
}

describe('the workflow switches in the settings view', () => {
  test('come from the config schema: every on/off and choice key under plan except the stop guard, with its value, default and description', async () => {
    await withSandbox(async () => {
      const s = (await get(ctx(), '/api/settings')).body['workflow'] as { file: string, switches: Array<Record<string, unknown>> }
      expect(s.file).toBe('~/.buracle/config.yaml')
      const keys = s.switches.map(x => x['key'])
      expect(keys).toEqual(expect.arrayContaining(['plan.questions', 'plan.reviews.plan', 'plan.reviews.changes', 'plan.reviews.goal', 'plan.goalVerification', 'plan.modelSwitch', 'plan.planApproval', 'plan.resultApproval', 'plan.branchIsolation', 'plan.autoPause']))
      expect(keys.every(k => typeof k === 'string' && k.startsWith('plan.'))).toBe(true)
      for (const gone of ['plan.stopGuard', 'plan.runaway.perPlan', 'plan.worktreeDir']) expect(keys).not.toContain(gone)
      expect(s.switches.find(x => x['key'] === 'plan.modelSwitch')).toMatchObject({ type: 'enum', values: ['off', 'manual'], value: 'off', default: 'off' })
      expect(s.switches.find(x => x['key'] === 'plan.reviews.changes')).toMatchObject({ type: 'bool', value: true, default: true, description: expect.stringContaining('changes-review') })
    })
  })

  test('only the page, in a browser, changes them; the same editor as `buracle config set` writes config.yaml and the runtime snapshot', async () => {
    await withSandbox(async ({ buracleHome }) => {
      const c = ctx()
      expect(await post(c, '/api/settings', { key: 'plan.reviews.changes', value: false }, false)).toMatchObject({ status: 403, body: { error: 'not_the_page' } })
      expect(await post(c, '/api/settings', { key: 'plan.stopGuard', value: false })).toMatchObject({ status: 400, body: { error: 'not_editable' } })
      expect(await post(c, '/api/settings', { key: 'plan.reviews.changes', value: 'no' })).toMatchObject({ status: 400, body: { error: 'bad_value' } })
      expect(await post(c, '/api/settings', { key: 'plan.modelSwitch', value: 'auto' })).toMatchObject({ status: 400, body: { error: 'bad_value' } })
      expect(await post(c, '/api/settings', { key: 'plan.reviews.changes', value: false })).toEqual({ status: 200, body: { ok: true, key: 'plan.reviews.changes', value: false, changed: true } })
      expect(await post(c, '/api/settings', { key: 'plan.modelSwitch', value: 'manual' })).toMatchObject({ status: 200, body: { changed: true } })
      expect(await post(c, '/api/settings', { key: 'plan.modelSwitch', value: 'manual' })).toMatchObject({ status: 200, body: { changed: false } })
      const yaml = readFileSync(join(buracleHome, 'config.yaml'), 'utf8')
      expect(yaml).toMatch(/reviews:\s*\n\s+changes: false/)
      expect(yaml).toContain('modelSwitch: manual')
      const snap = JSON.parse(readFileSync(paths.runtimeConfigFile(), 'utf8')) as { config: { plan: { reviews: { changes: boolean }, modelSwitch: string } } }
      expect(snap.config.plan.reviews.changes).toBe(false)
      expect(snap.config.plan.modelSwitch).toBe('manual')
      const after = (await get(c, '/api/settings')).body['workflow'] as { switches: Array<Record<string, unknown>> }
      expect(after.switches.find(x => x['key'] === 'plan.reviews.changes')).toMatchObject({ value: false, default: true })
    })
  })

  test('a percent-encoded spelling of the settings path is refused before the editor runs, so config.yaml stays as it was', async () => {
    await withSandbox(async ({ buracleHome }) => {
      const file = join(buracleHome, 'config.yaml')
      write(file, 'plan:\n  reviews:\n    changes: true\n')
      const c = ctx()
      for (const p of ['/api/%73ettings', '/api%2Fsettings', '/api/sett%69ngs']) {
        expect({ p, r: await post(c, p, { key: 'plan.reviews.changes', value: false }) }).toEqual({ p, r: { status: 400, body: expect.objectContaining({ error: 'bad_path' }) } })
      }
      expect(readFileSync(file, 'utf8')).toBe('plan:\n  reviews:\n    changes: true\n')
      expect(existsSync(paths.runtimeConfigFile())).toBe(false)
    })
  })
})

describe('the notification center', () => {
  test('lists what buracle notify recorded, newest first, and marks them read by id or all at once', async () => {
    await withSandbox(async ({ root }) => {
      const wctx = (now: number) => ({ cwd: root, now, env: { BURACLE_NO_NOTIFY: '1' } })
      await notify('plan_approval', 'Plan ready', 'Ready for your review', { plan: 'docs/plans/p.md' }, wctx(at(7)), { harness: 'codex', sessionId: CODEX_SID, source: '--session' })
      await notify('attention_needed', 'Input needed', '2 questions', {}, wctx(at(8)), undefined)
      const c = ctx()
      const n = (await get(c, '/api/notifications')).body as { unread: number, total: number, items: Array<Record<string, unknown>> }
      expect(n).toMatchObject({ unread: 2, total: 2 })
      expect(n.items.map(i => i['title'])).toEqual(['Input needed', 'Plan ready'])
      expect(n.items[1]).toMatchObject({ type: 'plan_approval', plan: expect.stringMatching(/docs[\\/]plans[\\/]p\.md$/), planPath: join(root, 'docs/plans/p.md'), reviewDoc: docId(join(root, 'docs/plans/p.md')), harness: 'codex', read: false })
      expect((await post(c, '/api/notifications/read', { ids: ['../x'] }, false)).status).toBe(400)
      expect((await post(c, '/api/notifications/read', {}, false)).status).toBe(400)
      expect(await post(c, '/api/notifications/read', { ids: [n.items[1]?.['id']] }, false)).toEqual({ status: 200, body: { ok: true, marked: 1, unread: 1 } })
      expect(await post(c, '/api/notifications/read', { all: true }, false)).toEqual({ status: 200, body: { ok: true, marked: 1, unread: 0 } })
      expect((await get(c, '/api/notifications')).body['unread']).toBe(0)
    })
  })

  test('the list, the unread badge and the total count the same newest entries, as many as the store keeps', async () => {
    await withSandbox(async () => {
      const extra = 20
      const lines = Array.from({ length: NOTIFICATIONS_KEEP + extra }, (_, i) => JSON.stringify({ ts: new Date(Date.UTC(2026, 9, 1) + i * 60_000).toISOString(), type: 'info', title: `n${i}`, message: '' }))
      write(notificationsFile(), lines.join('\n') + '\n')
      const c = ctx()
      const n = (await get(c, '/api/notifications')).body as { unread: number, total: number, items: Array<Record<string, unknown>> }
      expect(n.items).toHaveLength(NOTIFICATIONS_KEEP)
      expect(n.items[0]?.['title']).toBe(`n${NOTIFICATIONS_KEEP + extra - 1}`)
      expect(n.items[NOTIFICATIONS_KEEP - 1]?.['title']).toBe(`n${extra}`)
      expect([n.unread, n.total]).toEqual([NOTIFICATIONS_KEEP, NOTIFICATIONS_KEEP])
      const marked = await post(c, '/api/notifications/read', { ids: [n.items[0]?.['id']] }, false)
      expect(marked.body).toMatchObject({ marked: 1, unread: NOTIFICATIONS_KEEP - 1 })
    })
  })
})

describe('sessions and usage', () => {
  test('a session list across the harnesses with counts, landed commits and the cost of each from the harness records, never text', async () => {
    await withSandbox(async ({ root, home }) => {
      const dir = registerProject(root, 'alpha')
      writeSessionRecord({ v: 1, harness: 'claude', sid: CLAUDE_SID, cwd: dir, slug: 'alpha', startedMs: at(6), status: 'ended', finalizedMs: at(6, 14), memoryId: 'session-claude-555666', branch: 'main',
        stats: { endedMs: at(6, 13), prompts: 4, turns: 4, tools: 30, commands: 9, files: 5, tests: 3, testFailures: 1, commits: 2, filesChanged: 5, insertions: 80, deletions: 7, model: 'claude-opus-5-5', topTools: [['Edit', 12], ['Bash', 9]] } })
      writeSessionRecord({ v: 1, harness: 'codex', sid: CODEX_SID, cwd: dir, slug: 'alpha', startedMs: at(7), status: 'ended', finalizedMs: at(7, 13), stats: { prompts: 1, turns: 1, tools: 3, commands: 1, files: 0, tests: 0, testFailures: 0, commits: 0 } })
      writeSessionRecord({ v: 1, harness: 'opencode', sid: 'ses_live1', cwd: join(root, 'scratch'), startedMs: at(8, 9), status: 'active' })
      writeTelemetry('opencode', 'ses_live1', { at: at(8, 10), costUsd: 0.42, model: 'gpt-6.1-sol' })
      writeSessionRecord({ v: 1, harness: 'omp', sid: OMP_SID, cwd: dir, slug: 'alpha', startedMs: at(5), status: 'ended', finalizedMs: at(5, 15), stats: { prompts: 6, turns: 6, tools: 20, commands: 4, files: 3, tests: 2, testFailures: 0, commits: 4 } })
      writeTelemetry('omp', OMP_SID, { at: at(5, 14), costUsd: 1 })
      write(join(home, '.claude', 'projects', '-w-alpha', `${CLAUDE_SID}.jsonl`), JSON.stringify({ type: 'assistant', timestamp: new Date(at(6)).toISOString(), requestId: 'r1', message: { id: 'm1', model: 'zz-unpriced-model', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }) + '\n')
      write(join(home, '.codex', 'sessions', '2026', '10', '07', `rollout-2026-10-07T12-00-00-${CODEX_SID}.jsonl`), [
        { timestamp: new Date(at(7)).toISOString(), type: 'session_meta', payload: { id: CODEX_SID, cwd: dir } },
        { timestamp: new Date(at(7)).toISOString(), type: 'turn_context', payload: { model: 'zz-unpriced-model' } },
        { timestamp: new Date(at(7)).toISOString(), type: 'token_usage_record', payload: { response_id: 'r1', usage: { input_tokens: 900, cached_input_tokens: 0, output_tokens: 100, total_tokens: 1000 } } },
      ].map(l => JSON.stringify(l)).join('\n') + '\n')
      const { collectClaude } = await import('../../src/usage/claude')
      const { collectCodex } = await import('../../src/usage/codex')
      await collectClaude({ nowMs: NOW, pricing: {} })
      await collectCodex({ nowMs: NOW, pricing: {}, which: () => undefined })
      const s = (await get(ctx(), '/api/sessions')).body as { sessions: Array<Record<string, unknown>>, yield: Record<string, unknown> }
      expect(s.sessions.map(r => r['harness'])).toEqual(['opencode', 'codex', 'claude', 'omp'])
      expect(s.sessions[2]).toMatchObject({ sid: CLAUDE_SID, project: 'alpha', projectName: 'me/alpha', status: 'ended', prompts: 4, tools: 30, commits: 2, insertions: 80, deletions: 7, model: 'claude-opus-5-5', memoryId: 'session-claude-555666', tokens: 150, costFrom: 'records', topTools: [['Edit', 12], ['Bash', 9]] })
      expect(s.sessions[2]?.['usd']).toBeUndefined()
      expect(s.sessions[1]).toMatchObject({ sid: CODEX_SID, tokens: 1000, commits: 0, costFrom: 'records' })
      expect(s.sessions[0]).toMatchObject({ harness: 'opencode', status: 'active', usd: 0.42, costFrom: 'harness', model: 'gpt-6.1-sol', folder: expect.stringContaining('scratch') })
      expect(s.sessions[3]).toMatchObject({ sid: OMP_SID, commits: 4, usd: 1, costFrom: 'harness' })
      expect(s.yield).toEqual({ days: 30, sessions: 4, counted: 3, landed: 2, commits: 6, usd: 1, priced: 1, pricedCommits: 4, perCommit: 0.25 })
    })
  })

  test('a session in a folder memory.exclude keeps out shows no folder and no counts', async () => {
    await withSandbox(async ({ root, buracleHome }) => {
      const dir = join(root, 'secret-project')
      mkdirSync(dir, { recursive: true })
      write(join(buracleHome, 'config.yaml'), `memory:\n  exclude:\n    - ${dir}\n`)
      writeSessionRecord({ v: 1, harness: 'omp', sid: '019c625b-1111-7000-8000-000000000077', cwd: dir, startedMs: at(7), status: 'ended', stats: { prompts: 9, turns: 9, tools: 9, commands: 0, files: 0, tests: 0, testFailures: 0 } })
      const s = (await get(ctx(), '/api/sessions')).body as { sessions: Array<Record<string, unknown>> }
      expect(s.sessions[0]).toMatchObject({ harness: 'omp', excluded: true })
      expect(s.sessions[0]?.['folder']).toBeUndefined()
      expect(s.sessions[0]?.['prompts']).toBeUndefined()
      expect(JSON.stringify(s)).not.toContain('secret-project')
    })
  })

  test('a session that started before its project was kept out (its record names the project) shows no project, folder or counts either', async () => {
    await withSandbox(async ({ root, buracleHome }) => {
      const dir = registerProject(root, 'secret')
      write(join(buracleHome, 'config.yaml'), `memory:\n  exclude:\n    - ${dir}\n`)
      writeSessionRecord({ v: 1, harness: 'claude', sid: CLAUDE_SID, cwd: dir, slug: 'secret', startedMs: at(7), status: 'ended', finalizedMs: at(7, 13), memoryId: 'session-claude-555666', branch: 'client-x',
        stats: { endedMs: at(7, 12), prompts: 9, turns: 9, tools: 9, commands: 0, files: 0, tests: 0, testFailures: 0, commits: 3, model: 'claude-opus-5-5' } })
      const s = (await get(ctx(), '/api/sessions')).body as { sessions: Array<Record<string, unknown>>, yield: Record<string, unknown> }
      expect(s.sessions).toEqual([{ harness: 'claude', sid: CLAUDE_SID, short: expect.any(String), status: 'ended', startedAt: new Date(at(7)).toISOString(), endedAt: new Date(at(7, 12)).toISOString(), excluded: true }])
      expect(JSON.stringify(s)).not.toContain('secret')
      expect(s.yield).toMatchObject({ sessions: 0, commits: 0 })
    })
  })

  test('usage by day, month and model for all four harnesses, read from the stores without scanning', async () => {
    await withSandbox(async ({ home }) => {
      write(join(home, '.omp', 'agent', 'sessions', '-w', '2026-10-05T12-00-00-000Z_019c625b-1111-7000-8000-000000000077.jsonl'),
        JSON.stringify({ type: 'message', id: 'a1', timestamp: new Date(at(5)).toISOString(), message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-5-5', usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120, cost: { total: 0.25 } } } }) + '\n')
      const { collectOmp } = await import('../../src/usage/omp')
      await collectOmp({ nowMs: NOW, pricing: {}, offline: true })
      const u = (await get(ctx(), '/api/usage')).body as { days: string[], months: string[], harnesses: Record<string, Record<string, unknown>>, refreshing: string[] }
      expect(u.days).toHaveLength(30)
      expect(u.days[29]).toBe('2026-10-08')
      expect(u.months).toEqual(['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'])
      expect(Object.keys(u.harnesses)).toEqual(['claude', 'codex', 'opencode', 'omp'])
      expect(u.harnesses['omp']).toMatchObject({ enabled: true, days: { '2026-10-05': { tokens: 120, usd: 0.25 } }, months: { '2026-10': { tokens: 120, usd: 0.25 } }, models: { 'anthropic/claude-sonnet-5-5': { tokens: 120, usd: 0.25 } } })
      expect(u.harnesses['claude']).toMatchObject({ days: {}, months: {}, windows: [] })
      expect(u.refreshing).toEqual([])
    })
  })
})

describe('the extensions overview', () => {
  test('lists the skills, agents and rules with where each harness has them; a harness turned off shows as off', async () => {
    await withSandbox(async ({ home, buracleHome }) => {
      write(join(buracleHome, 'config.yaml'), 'harnesses:\n  codex:\n    enabled: false\n')
      write(join(home, '.agents', 'skills', 'memory', 'SKILL.md'), '---\nname: memory\ndescription: d\n---\n')
      const e = (await get(ctx(), '/api/extensions?scope=person')).body as { harnesses: Record<string, boolean>, skills: Array<Record<string, unknown>>, agents: Array<Record<string, unknown>>, rules: Array<Record<string, unknown>> }
      expect(e.harnesses).toEqual({ claude: true, codex: false, opencode: true, omp: true })
      const memory = e.skills.find(s => s['id'] === 'memory' && s['kind'] === 'canonical')
      expect(memory).toMatchObject({ source: 'buracle', where: { claude: 'ok', codex: 'off', opencode: 'ok', omp: 'ok' }, lint: { errors: 0 } })
      expect(e.skills.find(s => s['id'] === 'plan-build')).toMatchObject({ where: { claude: 'ok', codex: 'off', opencode: 'missing', omp: 'missing' } })
      expect(e.agents.map(a => a['id'])).toEqual(['changes-review', 'goal-build-review', 'plan-build-review'])
      expect(e.agents[0]).toMatchObject({ where: { claude: 'ok', codex: 'off', opencode: 'missing', omp: 'ok' } })
      expect(e.rules.find(r => r['id'] === 'core')).toMatchObject({ scope: 'always', title: 'Core working rules', where: { claude: 'missing', omp: 'ok' } })
      expect(e.rules.find(r => r['id'] === 'python')).toMatchObject({ scope: 'paths', paths: expect.arrayContaining(['**/*.py']) })
      expect((await get(ctx(), '/api/extensions')).status).toBe(400)
    })
  })
})

describe('the project switcher', () => {
  test('marks a project memory.exclude keeps out', async () => {
    await withSandbox(async ({ root, buracleHome }) => {
      const dir = registerProject(root, 'alpha')
      await saveItem(projectRef('alpha'), { id: 'decision-a', kind: 'decision', layer: 'project', title: 'A', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'ok', importance: 3, created: '2026-10-01T00:00:00Z', updated: '2026-10-01T00:00:00Z', author: 'agent', version: 1, history: [] })
      const before = (await get(ctx(), '/api/overview')).body['projects'] as Array<Record<string, unknown>>
      expect(before[0]?.['excluded']).toBeUndefined()
      write(join(buracleHome, 'config.yaml'), `memory:\n  exclude:\n    - ${dir}\n`)
      const after = (await get(ctx(), '/api/overview')).body['projects'] as Array<Record<string, unknown>>
      expect(after[0]).toMatchObject({ slug: 'alpha', count: 1, excluded: expect.stringContaining(dir) })
    })
  })
})
