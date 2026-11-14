import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as paths from '../../src/engine/paths'
import { closeAllCortex } from '../../src/memory/cortex'
import { projectsFile } from '../../src/memory/layout'
import { projectRef, saveItem } from '../../src/memory/store'
import { handle, uiContext, type UiContext } from '../../src/memory/ui'
import { withSandbox } from '../helpers/sandbox'

afterEach(async () => { await closeAllCortex() })

const at = (day: number, hour = 12) => new Date(2026, 9, day, hour).getTime()
const NOW = at(8)

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
      expect(keys).toEqual(expect.arrayContaining(['plan.questions', 'plan.reviews.plan', 'plan.reviews.changes', 'plan.reviews.goal', 'plan.goalVerification', 'plan.modelSwitch', 'plan.planApproval', 'plan.resultApproval', 'plan.branchIsolation']))
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
