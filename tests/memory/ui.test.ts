import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { MemItem } from '../../src/core/memory/brain'
import * as paths from '../../src/engine/paths'
import { tilde } from '../../src/engine/update/output'
import { closeAllCortex } from '../../src/memory/cortex'
import { projectsFile, statusFile } from '../../src/memory/layout'
import { readProjectsCache } from '../../src/memory/project'
import { refreshStatus } from '../../src/memory/status'
import { brainExists, getStored, personRef, projectRef, recordEvent, saveItem } from '../../src/memory/store'
import { clearUiRecord, handle, healthy, localHost, PAGE_CSP, readUiRecord, serveUi, UI_ASSETS, uiContext, type UiContext } from '../../src/memory/ui'
import { eventInScope, parseEventLine } from '../../src/memory/ui/events'
import { withEnv, withSandbox, type Sandbox } from '../helpers/sandbox'

afterEach(async () => { await closeAllCortex() })

const UI_DIR = join(import.meta.dir, '../../src/memory/ui')
const NOW = Date.UTC(2026, 9, 13, 12)

function item(over: Partial<MemItem> & Pick<MemItem, 'id' | 'title'>): MemItem {
  return {
    kind: 'decision', layer: 'project', summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'ok',
    importance: 3, created: '2026-10-10T10:00:00Z', updated: '2026-10-11T10:00:00Z', author: 'agent', version: 1, history: [], ...over,
  }
}

function ctx(port = 41999): UiContext {
  return uiContext({ version: '9.9.9', port, now: () => NOW })
}

function req(c: UiContext, path: string, init: { host?: string | null, method?: string, headers?: Record<string, string> } = {}): Request {
  const headers: Record<string, string> = { ...init.headers }
  if (init.host !== null) headers['host'] = init.host ?? `127.0.0.1:${c.port}`
  return new Request(`http://127.0.0.1:${c.port}${path}`, { method: init.method ?? 'GET', headers })
}

async function get(c: UiContext, path: string, init: { host?: string | null, method?: string, headers?: Record<string, string> } = {}): Promise<Response> {
  return handle(req(c, path, init), c)
}

async function getJson(c: UiContext, path: string): Promise<{ status: number, body: Record<string, unknown>, text: string }> {
  const r = await get(c, path)
  const text = await r.text()
  return { status: r.status, body: JSON.parse(text) as Record<string, unknown>, text }
}

async function seed(): Promise<void> {
  const alpha = projectRef('alpha')
  await saveItem(alpha, item({ id: 'decision-alpha-canary', title: 'Alphacanary decision', summary: 'only alpha knows this', tags: ['alphatag'], body: '<script>alert(1)</script> **bold** text', sources: ['src/alpha.ts:3'], history: [{ at: '2026-10-11T10:00:00Z', by: 'codex', what: 'written' }], harness: 'codex', commit: 'abc1234' }))
  await saveItem(alpha, item({ id: 'gotcha-alpha-broker', kind: 'gotcha', title: 'Alphabroker returns 200 on rejects', review: 'pending', created: '2026-10-01T10:00:00Z' }))
  await saveItem(alpha, item({ id: 'decision-alpha-old', title: 'An old alpha decision', status: 'deprecated' }))
  await saveItem(projectRef('beta'), item({ id: 'decision-beta-plan', title: 'Betaplan only', summary: 'beta summary', tags: ['betatag'] }))
  const person = personRef()
  await saveItem(person, item({ id: 'preference-short-answers', kind: 'preference', layer: 'person', title: 'Kullanıcının yanıtları kısa olmalı', summary: 'Kısa ve net', tags: ['iletişim'] }))
  await saveItem(person, item({ id: 'profile-result-first', kind: 'profile', layer: 'person', author: 'buracle', title: 'Wants the result first', summary: 'communication · high · stated by the user', tags: ['communication', 'stated', 'rank-1'] }))
  await saveItem(person, item({ id: 'profile-maybe-dark', kind: 'profile', layer: 'person', author: 'buracle', title: 'May prefer dark screens', summary: 'design · hypothesis · inferred from sessions', tags: ['design', 'hypothesis', 'inferred', 'rank-4'] }))
}

const ALPHA_WORDS = ['decision-alpha-canary', 'gotcha-alpha-broker', 'Alphacanary', 'Alphabroker', 'alphatag', 'only alpha knows']
const BETA_WORDS = ['decision-beta-plan', 'Betaplan', 'betatag', 'beta summary']
const PERSON_WORDS = ['preference-short-answers', 'profile-result-first', 'Kullanıcının', 'Wants the result first']

function expectNone(text: string, words: readonly string[]): void {
  for (const w of words) expect(text).not.toContain(w)
}

function assertNoInlineCode(html: string): void {
  expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i)
  expect(html).not.toMatch(/\sstyle\s*=/i)
  expect(html).not.toMatch(/<style/i)
  expect(html).not.toMatch(/\son[a-z]+\s*=/i)
  expect(html).not.toMatch(/javascript:/i)
}

describe('who may ask, and what', () => {
  test('only this machine: another Host (DNS rebinding) or none is refused', async () => {
    await withSandbox(async () => {
      const c = ctx()
      expect(localHost(`127.0.0.1:${c.port}`, c.port)).toBe(true)
      expect(localHost(`LOCALHOST:${c.port}`, c.port)).toBe(true)
      expect(localHost(`[::1]:${c.port}`, c.port)).toBe(true)
      expect(localHost(`127.0.0.1:${c.port + 1}`, c.port)).toBe(false)
      expect(localHost(null, c.port)).toBe(false)
      for (const host of ['evil.example', `evil.example:${c.port}`, `127.0.0.1.evil.example:${c.port}`, `localhost:${c.port + 1}`]) {
        const r = await get(c, '/api/overview', { host })
        expect(r.status).toBe(403)
        expect(r.headers.get('content-security-policy')).toBe(PAGE_CSP)
      }
      expect((await get(c, '/', { host: null })).status).toBe(403)
    })
  })

  test('reads are GET and HEAD; a write is a POST to a write endpoint, nothing else (no preflight, no CORS)', async () => {
    await withSandbox(async () => {
      const c = ctx()
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
        for (const path of ['/', '/api/brain?scope=person', '/api/events?scope=person']) expect((await get(c, path, { method })).status).toBe(405)
      }
      for (const method of ['PUT', 'DELETE', 'OPTIONS']) expect((await get(c, '/api/memory/delete', { method })).status).toBe(405)
      const head = await get(c, '/', { method: 'HEAD' })
      expect(head.status).toBe(200)
      expect(await head.text()).toBe('')
      expect((await get(c, '/api/token')).headers.get('access-control-allow-origin')).toBeNull()
    })
  })

  test('a write needs the token of this server, its Origin, a same-origin fetch and a JSON body', async () => {
    await withSandbox(async () => {
      await seed()
      const c = ctx()
      const token = (await getJson(c, '/api/token')).body['token'] as string
      expect(token).toMatch(/^[0-9a-f]{48}$/)
      const post = (headers: Record<string, string>, body = '{"scope":"person"}') => handle(new Request(`http://127.0.0.1:${c.port}/api/backup`, { method: 'POST', headers: { host: `127.0.0.1:${c.port}`, ...headers }, body }), c)
      const json = { 'content-type': 'application/json' }
      expect((await post(json)).status).toBe(403)
      expect((await post({ ...json, 'x-buracle-token': 'f'.repeat(48) })).status).toBe(403)
      expect((await post({ ...json, 'x-buracle-token': token, origin: 'https://evil.example' })).status).toBe(403)
      expect((await post({ ...json, 'x-buracle-token': token, origin: `http://localhost:${c.port + 1}` })).status).toBe(403)
      expect((await post({ ...json, 'x-buracle-token': token, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
      expect((await post({ 'content-type': 'text/plain', 'x-buracle-token': token })).status).toBe(415)
      expect((await post({ ...json, 'x-buracle-token': token }, 'not json')).status).toBe(400)
      const ok = await post({ ...json, 'x-buracle-token': token, origin: `http://127.0.0.1:${c.port}`, 'sec-fetch-site': 'same-origin' })
      expect(ok.status).toBe(200)
      expect(ctx().token).not.toBe(token)
    })
  })
})

describe('changing the memory from the page', () => {
  async function post(c: UiContext, path: string, body: unknown): Promise<{ status: number, body: Record<string, unknown> }> {
    const token = (await getJson(c, '/api/token')).body['token'] as string
    const r = await handle(new Request(`http://127.0.0.1:${c.port}${path}`, { method: 'POST', headers: { host: `127.0.0.1:${c.port}`, 'content-type': 'application/json', 'x-buracle-token': token, origin: `http://127.0.0.1:${c.port}` }, body: JSON.stringify(body) }), c)
    return { status: r.status, body: await r.json() as Record<string, unknown> }
  }

  test('retire, restore and delete a memory; core pages and profile lines are refused', async () => {
    await withSandbox(async () => {
      await seed()
      const c = uiContext({ version: '9.9.9', port: 41999 })
      expect(await post(c, '/api/memory/retire', { scope: 'project:alpha', id: 'decision-alpha-canary' })).toEqual({ status: 200, body: { ok: true, id: 'decision-alpha-canary', status: 'deprecated' } })
      expect((await getStored(projectRef('alpha'), 'decision-alpha-canary'))?.item.status).toBe('deprecated')
      expect(await post(c, '/api/memory/restore', { scope: 'project:alpha', id: 'decision-alpha-canary' })).toEqual({ status: 200, body: { ok: true, id: 'decision-alpha-canary', status: 'active' } })
      expect((await getStored(projectRef('alpha'), 'decision-alpha-canary'))?.item.status).toBe('active')
      expect(await post(c, '/api/memory/retire', { scope: 'person', id: 'preference-short-answers' })).toMatchObject({ status: 200, body: { status: 'deprecated' } })
      expect(await post(c, '/api/memory/delete', { scope: 'project:alpha', id: 'gotcha-alpha-broker' })).toEqual({ status: 200, body: { ok: true, id: 'gotcha-alpha-broker', deleted: true } })
      expect(await getStored(projectRef('alpha'), 'gotcha-alpha-broker')).toBeUndefined()
      expect((await post(c, '/api/memory/delete', { scope: 'project:alpha', id: 'gotcha-alpha-broker' })).status).toBe(404)
      expect((await post(c, '/api/memory/delete', { scope: 'project:beta', id: 'decision-alpha-canary' })).status).toBe(404)
      expect(await post(c, '/api/memory/delete', { scope: 'person', id: 'profile-result-first' })).toMatchObject({ status: 400, body: { error: 'protected_kind' } })
      expect((await post(c, '/api/memory/delete', { scope: 'person', id: '../person' })).status).toBe(400)
      const events = readFileSync(join(paths.memoryStateDir(), 'events.jsonl'), 'utf8')
      expect(events).toContain('"op":"delete"')
      expect(events).not.toContain('Alphabroker')
    })
  })

  test('settings: the memory part is read-only (who would run the model now, the UI port); only the workflow switches can be written', async () => {
    await withSandbox(async ({ buracleHome }) => {
      const c = uiContext({ version: '9.9.9', port: 41999 })
      const s = (await getJson(c, '/api/settings')).body as { model: Record<string, unknown>, ui: Record<string, unknown> }
      expect(s.model).toEqual({ harnesses: [], held: [], headroom: { max5hPct: 75, max7dPct: 85 } })
      expect(s).not.toHaveProperty('embed')
      expect(s.ui).toEqual({ port: 41777 })
      const token = (await getJson(c, '/api/token')).body['token'] as string
      const raw = (path: string, body: unknown) => handle(new Request(`http://127.0.0.1:${c.port}${path}`, { method: 'POST', headers: { host: `127.0.0.1:${c.port}`, 'content-type': 'application/json', 'x-buracle-token': token, origin: `http://127.0.0.1:${c.port}`, 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) }), c)
      expect((await raw('/api/settings', { key: 'memory.ui.port', value: 41800 })).status).toBe(400)
      expect((await raw('/api/settings/api-key', { key: 'x' })).status).toBe(405)
      expect(existsSync(join(buracleHome, 'config.yaml')) ? readFileSync(join(buracleHome, 'config.yaml'), 'utf8') : '').not.toContain('41800')
    })
  })

  test('health reports the store, the inbox and the last capture, and no repair, sweep or verifier endpoint exists', async () => {
    await withSandbox(async () => {
      await seed()
      const c = uiContext({ version: '9.9.9', port: 41999 })
      const h = (await getJson(c, '/api/health?scope=project:alpha')).body
      expect(h).toMatchObject({ scope: 'project:alpha', health: 'ok', reasons: [], captures: 0, mcp: 'unknown' })
      for (const key of ['distill', 'heal', 'jobs', 'upkeep']) expect(h).not.toHaveProperty(key)
      await refreshStatus({ slug: 'alpha', nowMs: NOW, lastCapture: { by: 'codex', saved: 2 } })
      expect((await getJson(c, '/api/health?scope=project:alpha')).body['lastCapture']).toMatchObject({ by: 'codex', saved: 2 })
      for (const gone of ['/api/heal', '/api/sweep', '/api/verify', '/api/reflect', '/api/upkeep', '/api/profile']) {
        expect((await handle(req(c, gone, { method: 'POST' }), c)).status).toBe(405)
        expect((await get(c, gone)).status).toBe(404)
      }
    })
  })

  test('the health view lists the backups and Back up now copies every brain; a restore stays a terminal command', async () => {
    await withSandbox(async () => {
      await seed()
      const c = uiContext({ version: '9.9.9', port: 41999 })
      expect((await getJson(c, '/api/health?scope=project:alpha')).body['backups']).toEqual({ list: [] })
      const made = await post(c, '/api/backup', { scope: 'project:alpha' })
      expect(made.status).toBe(200)
      expect(made.body).toMatchObject({ ok: true, brains: 3, pruned: 0 })
      const id = String(made.body['id'])
      const b = (await getJson(c, '/api/health?scope=project:alpha')).body['backups'] as { list: Array<Record<string, unknown>>, restore?: string }
      expect(b.list).toEqual([expect.objectContaining({ id, trigger: 'manual', brains: 3, here: true })])
      expect(b.restore).toBe(`buracle mem restore ${id} --project alpha`)
      expect(((await getJson(c, '/api/health?scope=person')).body['backups'] as { restore?: string }).restore).toBe(`buracle mem restore ${id} --person`)
      expect((await post(c, '/api/backup', { scope: 'project:nope' })).status).toBe(404)
      expect((await get(c, '/api/backup')).status).toBe((await get(c, '/api/heal')).status)
    })
  })

  test('a project leaves the brain: its file, its state and its record go; the other brains stay', async () => {
    await withSandbox(async ({ root }) => {
      await seed()
      const alphaRoot = join(root, 'alpha-root')
      const gone = join(root, 'alpha-gone')
      mkdirSync(alphaRoot, { recursive: true })
      mkdirSync(dirname(projectsFile()), { recursive: true })
      writeFileSync(projectsFile(), JSON.stringify({ v: 1, projects: {
        alpha: { slug: 'alpha', scope: 'project', roots: [alphaRoot, gone], ownerRepo: 'me/alpha', updated: '2026-10-01T00:00:00Z' },
        beta: { slug: 'beta', scope: 'project', roots: [join(root, 'beta-root')], merged: ['alpha'] },
      } }))
      await refreshStatus({ slug: 'alpha', nowMs: NOW })
      expect(existsSync(statusFile('alpha'))).toBe(true)
      const c = uiContext({ version: '9.9.9', port: 41999 })

      const h = (await getJson(c, '/api/health?scope=project:alpha')).body
      expect(h['project']).toEqual({ slug: 'alpha', name: 'me/alpha', registered: true, roots: [{ path: tilde(alphaRoot), exists: true }, { path: tilde(gone), exists: false }], brain: true, memories: 2 })
      expect((await getJson(c, '/api/health?scope=person')).body['project']).toBeUndefined()

      expect(await post(c, '/api/project/remove', { scope: 'person' })).toMatchObject({ status: 400, body: { error: 'bad_scope' } })
      expect((await post(c, '/api/project/remove', { scope: 'project:gamma' })).status).toBe(404)
      expect(brainExists(personRef())).toBe(true)

      expect(await post(c, '/api/project/remove', { scope: 'project:alpha' })).toEqual({ status: 200, body: { ok: true, slug: 'alpha', brain: true, memories: 2, total: 3, record: true } })
      expect(brainExists(projectRef('alpha'))).toBe(false)
      expect(existsSync(`${projectRef('alpha').db}-wal`)).toBe(false)
      expect(existsSync(statusFile('alpha'))).toBe(false)
      const cache = readProjectsCache()
      expect(cache.projects['alpha']).toBeUndefined()
      expect(cache.projects['beta']).toMatchObject({ slug: 'beta', roots: [join(root, 'beta-root')] })
      expect(cache.projects['beta']?.merged).toBeUndefined()
      expect(((await getJson(c, '/api/overview')).body['projects'] as Array<{ slug: string }>).map(p => p.slug)).toEqual(['beta'])
      expect((await getJson(c, '/api/brain?scope=project:alpha')).status).toBe(404)
      expect((await post(c, '/api/project/remove', { scope: 'project:alpha' })).status).toBe(404)
      expect(brainExists(projectRef('alpha'))).toBe(false)
      expect((await getStored(projectRef('beta'), 'decision-beta-plan'))?.item.title).toBe('Betaplan only')
      expect((await getJson(c, '/api/brain?scope=person')).body['items']).toHaveLength(3)
      const events = readFileSync(join(paths.memoryStateDir(), 'events.jsonl'), 'utf8')
      expect(events).toContain('"op":"delete","layer":"project","project":"alpha","by":"human","n":3')
      expectNone(events, ALPHA_WORDS.slice(2))
      expect(readFileSync(join(UI_DIR, 'i18n.js'), 'utf8')).toMatch(/'health\.removeConfirm': '[^']*backups keep a copy[^']*until they are pruned/)
    })
  })
})

describe('the page and its files', () => {
  test('the page loads only its own scripts and styles, under a strict CSP and security headers', async () => {
    await withSandbox(async () => {
      const c = ctx()
      const r = await get(c, '/')
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(r.headers.get('content-security-policy')).toBe(PAGE_CSP)
      expect(PAGE_CSP).toContain("script-src 'self'")
      expect(PAGE_CSP).toContain("default-src 'none'")
      expect(PAGE_CSP).toContain("frame-ancestors 'none'")
      expect(PAGE_CSP).not.toContain('unsafe')
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
      expect(r.headers.get('x-frame-options')).toBe('DENY')
      expect(r.headers.get('referrer-policy')).toBe('no-referrer')
      const html = await r.text()
      assertNoInlineCode(html)
      const refs = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)="([^"]+)"/g)].map(m => m[1] as string)
      expect(refs.length).toBeGreaterThan(0)
      for (const a of html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/g)) expect(a[1]).toMatch(/^\/[a-z]*$/)
      for (const u of refs) {
        expect(u.startsWith('/assets/')).toBe(true)
        expect(Object.keys(UI_ASSETS)).toContain(u.slice(8))
      }
    })
  })

  test('every listed asset is served with its type and an ETag; the list covers every file the page loads', async () => {
    await withSandbox(async () => {
      const c = ctx()
      for (const [name, type] of Object.entries(UI_ASSETS)) {
        const r = await get(c, `/assets/${name}`)
        expect(r.status).toBe(200)
        expect(r.headers.get('content-type')).toBe(type)
        expect(r.headers.get('content-security-policy')).toBe(PAGE_CSP)
        const etag = r.headers.get('etag') as string
        expect(etag).toMatch(/^"[0-9a-f]{20}"$/)
        expect((await get(c, `/assets/${name}`, { headers: { 'if-none-match': etag } })).status).toBe(304)
      }
      const files = readdirSync(UI_DIR).filter(f => !f.endsWith('.ts') && f !== 'index.html' && f !== 'review.html').sort()
      expect(files).toEqual(Object.keys(UI_ASSETS).sort())
      for (const f of files.filter(n => n.endsWith('.js'))) {
        for (const m of readFileSync(join(UI_DIR, f), 'utf8').matchAll(/from '\.\/([^']+)'/g)) expect(Object.keys(UI_ASSETS)).toContain(m[1] as string)
      }
    })
  })

  test('nothing outside the allowlist is served: no server code, no path traversal', async () => {
    await withSandbox(async () => {
      const c = ctx()
      for (const p of ['/assets/api.ts', '/assets/events.ts', '/assets/index.html', '/assets/../ui.ts', '/assets/%2e%2e/ui.ts', '/assets/..%2fui.ts', '/assets/%2e%2e%2f%2e%2e%2fstore.ts', '/assets/', '/assets/nope.js', '/assets/constructor', '/assets/__proto__', '/src/memory/ui.ts', '/ui.ts', '/graph', '/api/nope', '/api/']) {
        const r = await get(c, p)
        expect(r.status).toBe(404)
      }
      expect((await get(c, '/assets/%E0%A4%A')).status).toBe(400)
    })
  })

  test('the scripts never turn text into markup', () => {
    for (const f of readdirSync(UI_DIR).filter(n => n.endsWith('.js'))) {
      const src = readFileSync(join(UI_DIR, f), 'utf8')
      expect(src).not.toMatch(/\.innerHTML|\.outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|DOMParser|createContextualFragment/)
    }
  })

  test('the page is English only: one dictionary, no locale switch, and the scripts ask only for words it has', () => {
    const keys = (file: string, start: string): Set<string> => {
      const src = readFileSync(join(UI_DIR, file), 'utf8')
      const from = src.indexOf(start)
      expect(from).toBeGreaterThan(-1)
      return new Set([...src.slice(from, src.indexOf('\n}\n', from)).matchAll(/^\s*'([^']+)':/gm)].map(m => m[1] as string))
    }
    const en = keys('i18n.js', 'const EN = {')
    expect(readdirSync(UI_DIR).filter(n => /^i18n-/.test(n))).toEqual([])
    const i18n = readFileSync(join(UI_DIR, 'i18n.js'), 'utf8')
    expect(i18n).not.toMatch(/setLang|localStorage|navigator\.language|\?lang|'tr'/)
    expect(readFileSync(join(UI_DIR, 'index.html'), 'utf8')).not.toMatch(/data-lang|id="lang"/)
    const missing: string[] = []
    for (const f of readdirSync(UI_DIR).filter(n => n.endsWith('.js'))) {
      for (const call of readFileSync(join(UI_DIR, f), 'utf8').matchAll(/\bt\(([^)]*)\)/g)) {
        for (const k of (call[1] as string).matchAll(/'([a-z][\w-]*(?:\.[\w-]+)+)'/g)) if (!en.has(k[1] as string)) missing.push(`${f}: ${k[1]}`)
      }
    }
    expect(missing).toEqual([])
  })

  test('the page has a dark and a light theme: the boot script runs before the stylesheets, and the light set defines every token of the dark one', () => {
    const html = readFileSync(join(UI_DIR, 'index.html'), 'utf8')
    const boot = html.indexOf('/assets/theme-boot.js')
    expect(boot).toBeGreaterThan(-1)
    expect(boot).toBeLessThan(html.indexOf('/assets/tokens.css'))
    expect(html.indexOf('/assets/tokens.css')).toBeLessThan(html.indexOf('/assets/app.css'))
    expect(html).toMatch(/<meta name="color-scheme" content="dark light">/)
    expect(html).toMatch(/id="btn-theme"/)
    const tokens = readFileSync(join(UI_DIR, 'tokens.css'), 'utf8')
    const darkAt = tokens.indexOf(':root {')
    const lightAt = tokens.indexOf(':root[data-theme="light"] {')
    expect(darkAt).toBeGreaterThan(-1)
    expect(lightAt).toBeGreaterThan(darkAt)
    const names = (block: string) => [...block.matchAll(/^\s*(--[\w-]+):/gm)].map(m => m[1] as string)
    const dark = names(tokens.slice(darkAt, tokens.indexOf('}', darkAt)))
    const light = new Set(names(tokens.slice(lightAt, tokens.indexOf('}', lightAt))))
    const shared = ['--mono', '--sans', '--top', '--radius', '--ease']
    expect(dark.filter(n => !shared.includes(n) && !light.has(n))).toEqual([])
    expect(dark.length).toBeGreaterThan(20)
    expect(readFileSync(join(UI_DIR, 'theme-boot.js'), 'utf8')).toContain("'buracle.brain.theme'")
    expect(readFileSync(join(UI_DIR, 'theme.js'), 'utf8')).toContain("'buracle.brain.theme'")
  })

  test('/healthz names the app, its build, the brain folder and the pid', async () => {
    await withSandbox(async () => {
      const c = uiContext({ version: '9.9.9', build: '9.9.9+abc', port: 41999 })
      const { body } = await getJson(c, '/healthz')
      expect(body).toEqual({ ok: true, app: 'buracle-memory-ui', version: '9.9.9', build: '9.9.9+abc', brain: paths.brainDir(), pid: process.pid })
    })
  })
})

describe('scopes', () => {
  test('a scope is person or project:<slug> of a known project; anything else is refused before a file is named', async () => {
    await withSandbox(async () => {
      await seed()
      const c = ctx()
      for (const s of ['', 'project:', 'project:../alpha', 'project:alpha/../beta', 'project:Alpha', 'project:alpha%00', 'project: alpha', 'Person', 'people', 'alpha', 'project:-alpha']) {
        const r = await getJson(c, `/api/brain?scope=${encodeURIComponent(s)}`)
        expect(r.status).toBe(400)
        expect(r.body['error']).toBe('bad_scope')
      }
      expect((await getJson(c, '/api/brain')).status).toBe(400)
      const unknown = await getJson(c, '/api/brain?scope=project:gamma')
      expect(unknown.status).toBe(404)
      expect(unknown.body['error']).toBe('unknown_project')
      expect(brainExists(projectRef('gamma'))).toBe(false)
      for (const id of ['', '../x', 'Decision-Alpha', 'decision alpha', 'x'.repeat(200)]) {
        const r = await getJson(c, `/api/memory?scope=project:alpha&id=${encodeURIComponent(id)}`)
        expect(r.status).toBe(400)
        expect(r.body['error']).toBe('bad_id')
      }
    })
  })

  test("no response for one scope holds another's memories; the overview holds counts, never content", async () => {
    await withSandbox(async () => {
      await seed()
      const c = ctx()

      const alpha = await getJson(c, '/api/brain?scope=project:alpha')
      expect(alpha.status).toBe(200)
      expect(alpha.text).toContain('decision-alpha-canary')
      expectNone(alpha.text, [...BETA_WORDS, ...PERSON_WORDS])

      const beta = await getJson(c, '/api/brain?scope=project:beta')
      expect(beta.text).toContain('decision-beta-plan')
      expectNone(beta.text, [...ALPHA_WORDS, ...PERSON_WORDS])

      const person = await getJson(c, '/api/brain?scope=person')
      expect(person.text).toContain('preference-short-answers')
      expectNone(person.text, [...ALPHA_WORDS, ...BETA_WORDS])

      const leak = await getJson(c, '/api/memory?scope=project:beta&id=decision-alpha-canary')
      expect(leak.status).toBe(404)
      expectNone(leak.text, ALPHA_WORDS.slice(1))
      expect((await getJson(c, '/api/memory?scope=person&id=decision-alpha-canary')).status).toBe(404)
      expect((await getJson(c, '/api/memory?scope=project:alpha&id=preference-short-answers')).status).toBe(404)

      for (const q of ['alphacanary', 'canary', 'alpha', 'Alphabroker']) {
        const s = await getJson(c, `/api/search?scope=project:beta&q=${q}`)
        expect(s.body['items']).toEqual([])
        expectNone(s.text, ALPHA_WORDS.filter(w => w.toLowerCase() !== q.toLowerCase()))
        expect((await getJson(c, `/api/search?scope=person&q=${q}`)).body['items']).toEqual([])
      }

      const ov = await getJson(c, '/api/overview')
      expectNone(ov.text, [...ALPHA_WORDS, ...BETA_WORDS, ...PERSON_WORDS])
      const projects = ov.body['projects'] as Array<{ slug: string, count: number, regions: Record<string, number> }>
      expect(projects.map(p => p.slug).sort()).toEqual(['alpha', 'beta'])
      const a = projects.find(p => p.slug === 'alpha')
      expect(a?.count).toBe(2)
      expect(a?.regions['plans']).toBe(1)
      expect(a?.regions['warnings']).toBe(1)
      expect(a).not.toHaveProperty('upkeep')
      expect((ov.body['person'] as { count: number }).count).toBe(3)
      expect((ov.body['store'] as { installed: boolean }).installed).toBe(true)
    })
  })

  test('a region graph holds only its own scope\'s memories, links neighbors and hubs, and refuses an unknown region', async () => {
    await withSandbox(async () => {
      await seed()
      const alphaRef = projectRef('alpha')
      await saveItem(alphaRef, item({ id: 'gotcha-alpha-link', kind: 'gotcha', title: 'Alphalink gotcha', body: 'see decision-alpha-canary and decision-beta-plan', tags: ['alphatag'] }))
      await saveItem(personRef(), item({ id: 'preference-names-alpha', kind: 'preference', layer: 'person', title: 'Names an alpha id', body: 'decision-alpha-canary' }))
      const c = ctx()

      const plans = await getJson(c, '/api/graph?scope=project:alpha&region=plans')
      expect(plans.status).toBe(200)
      expect(plans.body).toMatchObject({ scope: 'project:alpha', region: 'plans', truncated: false })
      const nodes = plans.body['nodes'] as Array<{ id: string, type: string, focus?: boolean, degree: number }>
      expect(nodes.filter(n => n.type === 'memory').map(n => [n.id, n.focus])).toEqual([['decision-alpha-canary', true], ['gotcha-alpha-link', false]])
      expect(nodes.every(n => !('upkeep' in n))).toBe(true)
      expect(nodes.filter(n => n.type !== 'memory').map(n => n.id)).toEqual(['tag:alphatag', 'file:src/alpha.ts'])
      expect(plans.body['edges']).toEqual([
        { source: 'gotcha-alpha-link', target: 'decision-alpha-canary', kind: 'mentions', weight: 0.8 },
        { source: 'decision-alpha-canary', target: 'tag:alphatag', kind: 'tag', weight: 0.4 },
        { source: 'gotcha-alpha-link', target: 'tag:alphatag', kind: 'tag', weight: 0.4 },
        { source: 'decision-alpha-canary', target: 'file:src/alpha.ts', kind: 'cites', weight: 0.5 },
      ])
      expect(plans.body['stats']).toEqual({ memories: 2, entities: 2, edges: 4 })
      expectNone(plans.text, ['decision-alpha-old', ...BETA_WORDS, ...PERSON_WORDS, 'preference-names-alpha'])

      for (const path of ['/api/graph?scope=project:alpha', '/api/graph?scope=project:alpha&region=']) {
        const whole = await getJson(c, path)
        expect(whole.status).toBe(200)
        expect(whole.body['region']).toBeNull()
        const mem = (whole.body['nodes'] as Array<{ id: string, type: string, focus?: boolean }>).filter(n => n.type === 'memory')
        expect(mem.map(n => n.id).sort()).toEqual(['decision-alpha-canary', 'gotcha-alpha-broker', 'gotcha-alpha-link'])
        expect(mem.every(n => n.focus === true)).toBe(true)
        expectNone(whole.text, ['decision-alpha-old', ...BETA_WORDS, ...PERSON_WORDS])
      }

      const beta = await getJson(c, '/api/graph?scope=project:beta')
      expect((beta.body['nodes'] as Array<{ id: string }>).map(n => n.id)).toEqual(['decision-beta-plan', 'tag:betatag'])
      expectNone(beta.text, [...ALPHA_WORDS, ...PERSON_WORDS, 'gotcha-alpha-link'])

      const person = await getJson(c, '/api/graph?scope=person')
      const personIds = (person.body['nodes'] as Array<{ id: string, type: string }>).filter(n => n.type === 'memory').map(n => n.id).sort()
      expect(personIds).toEqual(['preference-names-alpha', 'preference-short-answers', 'profile-maybe-dark', 'profile-result-first'])
      const talk = await getJson(c, '/api/graph?scope=person&region=communication')
      const talkNodes = (talk.body['nodes'] as Array<{ id: string, type: string, region?: string, focus?: boolean }>).filter(n => n.type === 'memory' && n.focus === true)
      expect(talkNodes.map(n => n.id).sort()).toEqual(['preference-short-answers', 'profile-result-first'])
      expect(talkNodes.every(n => n.region === 'communication')).toBe(true)
      expect((await get(c, '/api/graph?scope=person&region=self')).status).toBe(400)
      expect((await get(c, '/api/graph?scope=project:alpha&region=communication')).status).toBe(400)
      expect(person.body['edges']).not.toContainEqual(expect.objectContaining({ kind: 'mentions' }))
      expectNone(person.text, [...ALPHA_WORDS, ...BETA_WORDS, 'gotcha-alpha-link'])
      for (const hidden of ['tag:stated', 'tag:hypothesis', 'tag:rank-1', 'tag:rank-4']) expect(person.text).not.toContain(hidden)

      for (const region of ['brain', 'Plans', 'plans ', '../plans', 'constructor', '__proto__']) {
        const bad = await getJson(c, `/api/graph?scope=project:alpha&region=${encodeURIComponent(region)}`)
        expect(bad.status).toBe(400)
        expect(bad.body['error']).toBe('bad_region')
        expectNone(bad.text, ALPHA_WORDS)
      }
      const badScope = await getJson(c, '/api/graph?scope=project:../alpha&region=plans')
      expect(badScope.status).toBe(400)
      expect(badScope.body['error']).toBe('bad_scope')
      expect((await getJson(c, '/api/graph?scope=project:gamma')).status).toBe(404)
    })
  })

  test('a brain lists live memories with their region, origin and the region summaries', async () => {
    await withSandbox(async () => {
      await seed()
      await saveItem(projectRef('alpha'), item({ id: 'gotcha-alpha-broker', kind: 'gotcha', title: 'Alphabroker returns 200 on rejects', review: 'pending', created: '2026-10-01T10:00:00Z', origin: 'explicit', confidence: 1 }))
      const { body } = await getJson(ctx(), '/api/brain?scope=project:alpha')
      const items = body['items'] as Array<{ id: string, region: string, unverified: boolean, origin?: string, contradicts?: boolean, status: string }>
      expect(items.map(i => i.id).sort()).toEqual(['decision-alpha-canary', 'gotcha-alpha-broker'])
      expect(body['retired']).toBe(1)
      expect(items.find(i => i.id === 'gotcha-alpha-broker')).toMatchObject({ region: 'warnings', unverified: true, origin: 'explicit', confidence: 1 })
      expect(items.find(i => i.id === 'decision-alpha-canary')).toMatchObject({ region: 'plans', unverified: false })
      expect(items.find(i => i.id === 'decision-alpha-canary')?.origin).toBeUndefined()
      const regions = body['regions'] as Array<{ id: string, count: number, groups: number, topTags: string[] }>
      expect(regions.map(r => r.id)).toEqual(['plans', 'knowledge', 'discoveries', 'self', 'skills', 'warnings', 'episodes'])
      expect(regions[0]).toMatchObject({ id: 'plans', count: 1, topTags: ['alphatag'] })
      expect(body).not.toHaveProperty('upkeep')
    })
  })
})

describe('memories, search and the profile', () => {
  test('one memory in full: body as written, sources, history and provenance', async () => {
    await withSandbox(async () => {
      await seed()
      const { status, body } = await getJson(ctx(), '/api/memory?scope=project:alpha&id=decision-alpha-canary')
      expect(status).toBe(200)
      expect(body['body']).toBe('<script>alert(1)</script> **bold** text')
      expect(body['sources']).toEqual(['src/alpha.ts:3'])
      expect(body['history']).toEqual([{ at: '2026-10-11T10:00:00Z', by: 'codex', what: 'written' }])
      expect(body['provenance']).toEqual({ version: 1, harness: 'codex', commit: 'abc1234' })
      expect(body).toMatchObject({ scope: 'project:alpha', layer: 'project', kind: 'decision', region: 'plans', title: 'Alphacanary decision' })
      expect((await getJson(ctx(), '/api/memory?scope=project:alpha&id=decision-nothing')).status).toBe(404)
    })
  })

  test('search folds Turkish letters and inflections, and never counts as a recall', async () => {
    await withSandbox(async () => {
      await seed()
      const c = ctx()
      for (const q of ['yanit', 'yanıt', 'KULLANICI', 'kısa']) {
        const { body } = await getJson(c, `/api/search?scope=person&q=${encodeURIComponent(q)}`)
        expect((body['items'] as Array<{ id: string }>).map(i => i.id)).toEqual(['preference-short-answers'])
      }
      expect((await getJson(c, '/api/search?scope=project:alpha&q=alphabroker')).body['items']).toMatchObject([{ id: 'gotcha-alpha-broker' }])
      expect((await getJson(c, '/api/search?scope=project:alpha&q=old')).body['items']).toEqual([])
      expect((await getJson(c, '/api/search?scope=project:alpha&q=')).body['items']).toEqual([])
      expect((await getStored(personRef(), 'preference-short-answers'))?.item.recallCount).toBeUndefined()
    })
  })

  test('the profile endpoint is gone: the stated preferences are ordinary memories of the person brain', async () => {
    await withSandbox(async () => {
      await seed()
      expect((await get(ctx(), '/api/profile')).status).toBe(404)
      const { body } = await getJson(ctx(), '/api/brain?scope=person')
      expect((body['items'] as Array<{ id: string, kind: string }>).filter(i => i.kind === 'preference').map(i => i.id)).toEqual(['preference-short-answers'])
    })
  })

  test('an empty brain answers with zeros and creates no file', async () => {
    await withSandbox(async () => {
      const c = ctx()
      const ov = await getJson(c, '/api/overview')
      expect(ov.body['projects']).toEqual([])
      expect(ov.body['person']).toMatchObject({ exists: false, count: 0 })
      const b = await getJson(c, '/api/brain?scope=person')
      expect(b.body['items']).toEqual([])
      expect((b.body['regions'] as Array<{ count: number }>).every(r => r.count === 0)).toBe(true)
      expect(brainExists(personRef())).toBe(false)
    })
  })

  test('without CortexDB the API says so and names the install command', async () => {
    await withSandbox(async ({ root }: Sandbox) => {
      await seed()
      await closeAllCortex()
      await withEnv({ BURACLE_CORTEXDB_BIN: join(root, 'no-cortexdb') }, async () => {
        const c = ctx()
        const r = await getJson(c, '/api/brain?scope=project:alpha')
        expect(r.status).toBe(503)
        expect(r.body).toEqual({ error: 'cortexdb_missing', message: 'CortexDB is not installed, so the brain cannot be read.', fix: 'buracle install' })
        const ov = await getJson(c, '/api/overview')
        expect(ov.status).toBe(200)
        expect(ov.body['store']).toMatchObject({ installed: false, fix: 'buracle install' })
        expect((ov.body['projects'] as Array<{ slug: string, count: number | null, error?: string }>).find(p => p.slug === 'alpha')).toMatchObject({ count: null, error: 'cortexdb_missing' })
      })
    })
  })
})

describe('the live stream', () => {
  test('log lines are validated field by field and kept to their scope', () => {
    expect(parseEventLine('not json')).toBeUndefined()
    expect(parseEventLine(JSON.stringify({ op: 'explode', layer: 'project' }))).toBeUndefined()
    expect(parseEventLine(JSON.stringify({ op: 'write', layer: 'vault' }))).toBeUndefined()
    const e = parseEventLine(JSON.stringify({ at: '2026-10-13T10:00:00Z', op: 'recall', layer: 'project', project: '../alpha', id: 'Bad Id', kind: 'nonsense', ids: ['decision-a', '<b>', 7], n: 'x', text: 'secret' }))
    expect(e).toEqual({ at: '2026-10-13T10:00:00Z', op: 'recall', layer: 'project', ids: ['decision-a'] })
    const w = parseEventLine(JSON.stringify({ at: 'x', op: 'write', layer: 'project', project: 'alpha', id: 'gotcha-a', kind: 'gotcha' }))
    expect(w).toEqual({ at: 'x', op: 'write', layer: 'project', project: 'alpha', id: 'gotcha-a', kind: 'gotcha', region: 'warnings' })
    expect(parseEventLine(JSON.stringify({ at: 'x', op: 'write', layer: 'project', project: 'alpha', id: 'gotcha-a', by: 'buracle-reflect' }))?.by).toBe('buracle-reflect')
    expect(parseEventLine(JSON.stringify({ at: 'x', op: 'recall', layer: 'person', by: 'codex' }))).toEqual({ at: 'x', op: 'recall', layer: 'person', by: 'codex' })
    for (const by of ['Buracle', 'buracle reflect', '<b>x</b>', '-x', 'x'.repeat(41), 7, null, ['codex']]) {
      expect(parseEventLine(JSON.stringify({ at: 'x', op: 'recall', layer: 'person', by }))).toEqual({ at: 'x', op: 'recall', layer: 'person' })
    }
    const alpha = { kind: 'project' as const, key: 'project:alpha', slug: 'alpha', ref: { layer: 'project' as const, db: '' } }
    const person = { kind: 'person' as const, key: 'person' as const, ref: { layer: 'person' as const, db: '' } }
    expect(eventInScope(w!, alpha)).toBe(true)
    expect(eventInScope({ ...w!, project: 'beta' }, alpha)).toBe(false)
    expect(eventInScope(w!, person)).toBe(false)
    expect(eventInScope({ at: '', op: 'recall', layer: 'person' }, person)).toBe(true)
    expect(eventInScope({ at: '', op: 'recall', layer: 'person' }, alpha)).toBe(false)
  })
})

function freePort(): number {
  const s = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') })
  const port = s.port as number
  s.stop(true)
  return port
}

async function readUntil(r: Response, until: RegExp, ms = 6000): Promise<string> {
  const reader = (r.body as ReadableStream<Uint8Array>).getReader()
  const dec = new TextDecoder()
  let text = ''
  const deadline = Date.now() + ms
  try {
    while (!until.test(text) && Date.now() < deadline) {
      const next = await Promise.race([reader.read(), Bun.sleep(Math.max(1, deadline - Date.now())).then(() => null)])
      if (next === null || next.done) break
      text += dec.decode(next.value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  return text
}

describe('the server', () => {
  test('records itself, answers /healthz, streams events of one scope only and resumes from Last-Event-ID', async () => {
    await withSandbox(async () => {
      await seed()
      const { server, record } = serveUi({ port: freePort(), version: '9.9.9' })
      try {
        expect(readUiRecord()).toMatchObject({ v: 1, pid: process.pid, port: record.port, host: '127.0.0.1', brain: paths.brainDir() })
        expect(await healthy(record.url)).toBe(true)
        expect(await healthy(`http://localhost:${record.port}`)).toBe(true)
        const page = await fetch(`${record.url}/`)
        expect(page.status).toBe(200)
        expect(await page.text()).toContain('/assets/app.js')

        const live = await fetch(`${record.url}/api/events?scope=project:alpha`)
        expect(live.status).toBe(200)
        expect(live.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
        expect(live.headers.get('content-security-policy')).toBe(PAGE_CSP)
        recordEvent({ op: 'write', layer: 'project', project: 'beta', id: 'decision-beta-plan', kind: 'decision' })
        recordEvent({ op: 'recall', layer: 'person', ids: ['preference-short-answers'] })
        recordEvent({ op: 'write', layer: 'project', project: 'alpha', id: 'gotcha-alpha-broker', kind: 'gotcha' })
        const text = await readUntil(live, /gotcha-alpha-broker/)
        expect(text.startsWith('retry: 3000\n')).toBe(true)
        expect(text).toContain('event: brain\n')
        expect(text).toMatch(/id: \d+\nevent: brain\ndata: \{"at":"[^"]+","op":"write","layer":"project","project":"alpha","id":"gotcha-alpha-broker","kind":"gotcha","region":"warnings"\}\n\n/)
        expectNone(text, ['decision-beta-plan', 'preference-short-answers', '"beta"'])

        const again = await fetch(`${record.url}/api/events?scope=project:alpha`, { headers: { 'last-event-id': '0' } })
        const replay = await readUntil(again, /gotcha-alpha-broker/)
        expect(replay).toContain('gotcha-alpha-broker')
        expectNone(replay, ['decision-beta-plan', 'preference-short-answers'])
        const ids = [...replay.matchAll(/^id: (\d+)$/gm)].map(m => Number(m[1]))
        expect(ids.length).toBe(1)
        const after = await fetch(`${record.url}/api/events?scope=project:alpha`, { headers: { 'last-event-id': String(ids[0]) } })
        const rest = await readUntil(after, /gotcha-alpha-broker/, 1500)
        expect(rest).not.toContain('gotcha-alpha-broker')
        expect(rest.startsWith('retry: 3000\n')).toBe(true)

        const refused = await fetch(`${record.url}/api/events?scope=project:../alpha`)
        expect(refused.status).toBe(400)
      } finally {
        server.stop(true)
        clearUiRecord()
      }
      expect(readUiRecord()).toBeUndefined()
    })
  }, 30_000)

  test('takes the next port when one is busy', async () => {
    await withSandbox(async () => {
      const blocker = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('busy') })
      const busy = blocker.port as number
      const { server, record } = serveUi({ port: busy, version: '9.9.9' })
      try {
        expect(record.port).toBe(busy + 1)
        expect(await healthy(`http://127.0.0.1:${busy}`)).toBe(false)
        expect(await healthy(record.url)).toBe(true)
      } finally {
        server.stop(true)
        blocker.stop(true)
        clearUiRecord()
      }
    })
  })
})

describe('the personal profile brain', () => {
  test('the person scope is drawn with profile regions; a project keeps the memory-kind regions', async () => {
    await withSandbox(async () => {
      await seed()
      const { body } = await getJson(ctx(), '/api/brain?scope=person')
      expect(body['design']).toBe('person')
      const regions = body['regions'] as Array<{ id: string, count: number, stated: number, hypotheses: number }>
      expect(regions.map(r => r.id)).toEqual(['communication', 'collaboration', 'workflow', 'engineering', 'avoid', 'lessons', 'inbox'])
      expect(regions.find(r => r.id === 'communication')).toMatchObject({ count: 2, stated: 2, hypotheses: 0 })
      expect(regions.find(r => r.id === 'collaboration')).toMatchObject({ count: 1, hypotheses: 1 })
      const items = body['items'] as Array<{ id: string, region: string }>
      expect(Object.fromEntries(items.map(i => [i.id, i.region]))).toEqual({
        'preference-short-answers': 'communication', 'profile-result-first': 'communication', 'profile-maybe-dark': 'collaboration',
      })
      const project = await getJson(ctx(), '/api/brain?scope=project:alpha')
      expect(project.body['design']).toBe('project')
      expect((project.body['regions'] as Array<{ id: string }>)[0]?.id).toBe('plans')
      const memory = await getJson(ctx(), '/api/memory?scope=person&id=profile-maybe-dark')
      expect(memory.body['region']).toBe('collaboration')
    })
  })
})
