import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteSync } from '../engine/fsx'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { spawnArgv, windowsVerbatim } from '../engine/platform'
import { idleCortex } from './cortex'
import { brainDir } from './layout'
import { anySessionOpen } from './session-open'
import { captureOff } from './spool'
import { sameUiBuild, uiBuildId } from './ui-build'
import { processAlive, readUiRecord, type UiRecord } from './ui-record'
import { backupNow, deleteMemory, healthPayload, readBody, removeProjectNow, setMemoryStatus, settingsPayload } from './ui/actions'
import { BrainCache, brainOf, errorPayload, graphOf, memoryOf, overview, parseScope, searchOf, UiApiError } from './ui/api'
import { eventStream } from './ui/events'
import { addReviewNote, deleteReviewNote, editReviewNote, reviewDoc, reviewDocs } from './ui/review'
import { reviewChanges } from './ui/review-changes'
import { extensionsPayload } from './ui/extensions'
import { markRead, notificationsPayload } from './ui/inbox'
import { saveSetting, workflowPayload } from './ui/settings'
import { sessionsPayload, usagePayload } from './ui/work'

export { readUiRecord, type UiRecord } from './ui-record'

export const DEFAULT_UI_PORT = 41777
const PORT_TRIES = 20
const HOST = '127.0.0.1'
const UI_APP = 'buracle-memory-ui'
const CORTEX_IDLE_MS = 120_000
export const UI_STOP_AFTER_MS = 90_000
const UI_POLL_MS = 30_000

export const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'"

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': PAGE_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
  'cache-control': 'no-store',
}

function text(body: string, status: number, type = 'text/plain; charset=utf-8'): Response {
  return new Response(body, { status, headers: { ...SECURITY_HEADERS, 'content-type': type } })
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' } })
}

export function localHost(host: string | null, port: number): boolean {
  if (host === null) return false
  const h = host.trim().toLowerCase()
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(h)
}

const UI_DIR = join(import.meta.dir, 'ui')

const JS = 'text/javascript; charset=utf-8'
export const UI_ASSETS: Readonly<Record<string, string>> = {
  'tokens.css': 'text/css; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
  'dash.css': 'text/css; charset=utf-8',
  'app.js': JS,
  'pointer.js': JS,
  'brain.js': JS,
  'brain-person.js': JS,
  'render.js': JS,
  'hud.js': JS,
  'graph.js': JS,
  'network.js': JS,
  'panel.js': JS,
  'dom.js': JS,
  'i18n.js': JS,
  'manage.js': JS,
  'work.js': JS,
  'inbox.js': JS,
  'extensions.js': JS,
  'switches.js': JS,
  'logo.js': JS,
  'theme.js': JS,
  'theme-boot.js': JS,
  'favicon.svg': 'image/svg+xml',
  'review.css': 'text/css; charset=utf-8',
  'review.js': JS,
  'review-doc.js': JS,
  'review-diff.js': JS,
  'review-notes.js': JS,
}
const PAGE_FILE = 'index.html'
const REVIEW_PAGE = 'review.html'

interface PageFile { body: Buffer, etag: string, mtimeMs: number }

const fileCache = new Map<string, PageFile>()

function pageFile(dir: string, name: string): PageFile | undefined {
  const file = join(dir, name)
  const hit = fileCache.get(file)
  let mtimeMs: number
  try { mtimeMs = statSync(file).mtimeMs } catch { return hit }
  if (hit?.mtimeMs === mtimeMs) return hit
  try {
    const body = readFileSync(file)
    const fresh: PageFile = { body, etag: `"${createHash('sha256').update(body).digest('hex').slice(0, 20)}"`, mtimeMs }
    fileCache.set(file, fresh)
    return fresh
  } catch { return hit }
}

function staticFile(dir: string, name: string, type: string, req: Request): Response {
  const hit = pageFile(dir, name)
  if (hit === undefined) {
    log('warn', 'memory ui: a file of the page is missing', { file: join(dir, name) })
    return text('not found\n', 404)
  }
  const headers = { ...SECURITY_HEADERS, 'content-type': type, 'cache-control': 'no-cache', etag: hit.etag }
  if (req.headers.get('if-none-match') === hit.etag) return new Response(null, { status: 304, headers })
  return new Response(req.method === 'HEAD' ? null : hit.body, { headers })
}

function asset(dir: string, name: string, req: Request): Response {
  const type = Object.prototype.hasOwnProperty.call(UI_ASSETS, name) ? UI_ASSETS[name] : undefined
  return type === undefined ? text('not found\n', 404) : staticFile(dir, name, type, req)
}

export interface UiContext { version: string; build?: string; port: number; now: () => number; cache: BrainCache; token: string; uiDir: string }

export interface UiServerHandle { timeout(req: Request, seconds: number): void }

export function uiContext(opts: { version: string, build?: string, port: number, now?: () => number, uiDir?: string }): UiContext {
  const c: UiContext = { version: opts.version, port: opts.port, now: opts.now ?? Date.now, cache: new BrainCache(), token: randomBytes(24).toString('hex'), uiDir: opts.uiDir ?? UI_DIR }
  if (opts.build !== undefined) c.build = opts.build
  for (const name of [PAGE_FILE, REVIEW_PAGE, ...Object.keys(UI_ASSETS)]) pageFile(c.uiDir, name)
  return c
}

const WRITE_PATHS: ReadonlySet<string> = new Set(['/api/backup', '/api/project/remove', '/api/memory/retire', '/api/memory/restore', '/api/memory/delete', '/api/review/note/add', '/api/review/note/edit', '/api/review/note/delete', '/api/notifications/read', '/api/settings'])

const BROWSER_ONLY: ReadonlySet<string> = new Set(['/api/settings'])

const TOKEN_READS: ReadonlySet<string> = new Set(['/api/review/doc', '/api/review/changes'])

function sameToken(sent: string | null, token: string): boolean {
  if (sent === null) return false
  const a = Buffer.from(sent)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

export function writeRefusal(req: Request, c: UiContext, path?: string): UiApiError | undefined {
  const origin = req.headers.get('origin')
  if (path !== undefined && BROWSER_ONLY.has(path) && (origin === null || req.headers.get('sec-fetch-site') !== 'same-origin')) return new UiApiError(403, 'not_the_page', 'only the page of this server, in a browser, may change the workflow settings')
  if (origin !== null && !localHost(origin.replace(/^http:\/\//u, ''), c.port)) return new UiApiError(403, 'bad_origin', 'only the page of this server may change the memory')
  const site = req.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') return new UiApiError(403, 'bad_origin', 'only the page of this server may change the memory')
  if (!sameToken(req.headers.get('x-buracle-token'), c.token)) return new UiApiError(403, 'bad_token', 'the write token is missing or old; reload the page')
  return undefined
}

async function write(p: string, raw: string, req: Request, c: UiContext): Promise<Response> {
  if (BROWSER_ONLY.has(p) && raw !== p) throw new UiApiError(400, 'bad_path', `name ${p} without percent-encoding`)
  const refused = writeRefusal(req, c, p)
  if (refused !== undefined) throw refused
  const body = await readBody(req)
  const now = c.now()
  switch (p) {
    case '/api/backup': return json(await backupNow(body, now))
    case '/api/project/remove': return json(await removeProjectNow(body, now))
    case '/api/memory/retire': return json(await setMemoryStatus(body, 'deprecated', now))
    case '/api/memory/restore': return json(await setMemoryStatus(body, 'active', now))
    case '/api/memory/delete': return json(await deleteMemory(body, now))
    case '/api/review/note/add': return json(await addReviewNote(body, now))
    case '/api/review/note/edit': return json(await editReviewNote(body, now))
    case '/api/review/note/delete': return json(await deleteReviewNote(body, now))
    case '/api/notifications/read': return json(markRead(body))
    case '/api/settings': return json(await saveSetting(body))
    default: throw new UiApiError(404, 'not_found', `there is no API at ${p}`)
  }
}

export async function handle(req: Request, c: UiContext, server?: UiServerHandle): Promise<Response> {
  if (!localHost(req.headers.get('host'), c.port)) return text('forbidden: only this machine may use the memory UI\n', 403)
  const url = new URL(req.url)
  let p: string
  try { p = decodeURIComponent(url.pathname) } catch { return text('bad request: the path is not valid URL encoding\n', 400) }
  if (req.method === 'POST' && WRITE_PATHS.has(p)) {
    try {
      return await write(p, url.pathname, req, c)
    } catch (e) {
      const { status, body } = errorPayload(e)
      if (status >= 500) log('warn', 'memory ui: a write failed', { path: p, error: e })
      return json(body, status)
    }
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return text('method not allowed: the memory UI reads with GET and writes only with POST to its write endpoints\n', 405)
  if (p === '/' || p === '/index.html') return staticFile(c.uiDir, PAGE_FILE, 'text/html; charset=utf-8', req)
  if (p === '/review') return staticFile(c.uiDir, REVIEW_PAGE, 'text/html; charset=utf-8', req)
  if (p.startsWith('/assets/')) return asset(c.uiDir, p.slice(8), req)
  if (p === '/favicon.ico') return asset(c.uiDir, 'favicon.svg', req)
  if (p === '/healthz') return json({ ok: true, app: UI_APP, version: c.version, ...(c.build !== undefined ? { build: c.build } : {}), brain: brainDir(), pid: process.pid })
  if (!p.startsWith('/api/')) return text('not found\n', 404)
  const q = url.searchParams
  const now = c.now()
  try {
    const refused = TOKEN_READS.has(p) ? writeRefusal(req, c) : undefined
    if (refused !== undefined) throw refused
    switch (p) {
      case '/api/overview': return json(await overview(c.cache, now))
      case '/api/brain': return json(await brainOf(c.cache, await parseScope(q.get('scope')), now))
      case '/api/memory': return json(await memoryOf(await parseScope(q.get('scope')), q.get('id')))
      case '/api/search': return json(await searchOf(c.cache, await parseScope(q.get('scope')), q.get('q'), now))
      case '/api/graph': return json(await graphOf(c.cache, await parseScope(q.get('scope')), q.get('region'), now))
      case '/api/token': return json({ token: c.token })
      case '/api/health': return json(await healthPayload(await parseScope(q.get('scope')), now))
      case '/api/settings': return json({ ...settingsPayload(now), workflow: workflowPayload() })
      case '/api/review/docs': return json(await reviewDocs(now))
      case '/api/review/doc': return json(await reviewDoc(q.get('id'), now))
      case '/api/review/changes': return json(await reviewChanges(q.get('checkout'), now))
      case '/api/sessions': return json(await sessionsPayload(now))
      case '/api/usage': return json(await usagePayload(now))
      case '/api/notifications': return json(notificationsPayload())
      case '/api/extensions': return json(await extensionsPayload(await parseScope(q.get('scope')), now))
      case '/api/events': {
        const scope = await parseScope(q.get('scope'))
        if (req.method === 'HEAD') return new Response(null, { headers: { ...SECURITY_HEADERS, 'content-type': 'text/event-stream; charset=utf-8' } })
        server?.timeout(req, 0)
        const r = eventStream(req, scope)
        for (const [k, v] of Object.entries(SECURITY_HEADERS)) if (!r.headers.has(k)) r.headers.set(k, v)
        return r
      }
      default: throw new UiApiError(404, 'not_found', `there is no API at ${p}`)
    }
  } catch (e) {
    const { status, body } = errorPayload(e)
    if (status >= 500) log('warn', 'memory ui: request failed', { path: p, error: e })
    return json(body, status)
  }
}

const alive = processAlive

export interface UiHealth { pid?: number; version?: string; build?: string; brain?: string }

export async function probeUi(url: string, timeoutMs = 1500): Promise<UiHealth | undefined> {
  try {
    const base = url.replace(/\/+$/u, '').replace(/^http:\/\/localhost(?=[:/]|$)/u, 'http://127.0.0.1')
    const r = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return undefined
    const j = await r.json() as unknown
    if (j === null || typeof j !== 'object' || (j as { app?: unknown }).app !== UI_APP) return undefined
    const o = j as Record<string, unknown>
    const health: UiHealth = {}
    if (typeof o['pid'] === 'number') health.pid = o['pid']
    if (typeof o['version'] === 'string') health.version = o['version']
    if (typeof o['build'] === 'string') health.build = o['build']
    if (typeof o['brain'] === 'string') health.brain = o['brain']
    return health
  } catch { return undefined }
}

export async function healthy(url: string, timeoutMs = 1500): Promise<boolean> {
  return (await probeUi(url, timeoutMs)) !== undefined
}

export async function liveUi(): Promise<(UiRecord & { health: UiHealth }) | undefined> {
  const rec = readUiRecord()
  if (rec === undefined || !alive(rec.pid)) return undefined
  const health = await probeUi(rec.url)
  return health !== undefined ? { ...rec, health } : undefined
}

export type UiStopOutcome = 'stopped' | 'not-running' | 'unconfirmed' | 'still-running'

export async function stopUi(rec: UiRecord, opts: { waitMs?: number } = {}): Promise<UiStopOutcome> {
  if (!alive(rec.pid)) { clearUiRecord(rec.pid); return 'not-running' }
  const health = await probeUi(rec.url)
  if (health === undefined || health.pid !== rec.pid) return 'unconfirmed'
  try { process.kill(rec.pid, 'SIGTERM') } catch (e) {
    if ((e as { code?: string }).code !== 'ESRCH') return 'unconfirmed'
    clearUiRecord(rec.pid)
    return 'not-running'
  }
  const deadline = Date.now() + (opts.waitMs ?? 5_000)
  while (alive(rec.pid)) {
    if (Date.now() >= deadline) return 'still-running'
    await Bun.sleep(50)
  }
  clearUiRecord(rec.pid)
  return 'stopped'
}

export type UiStopReason = 'home-gone' | 'no-sessions'

export interface ServeOptions {
  port?: number
  version: string
  build?: string
  now?: () => number
  idleEveryMs?: number
  stopAfterMs?: number
  onStop?: (why: UiStopReason) => void
}

export function serveUi(opts: ServeOptions): { server: ReturnType<typeof Bun.serve>, record: UiRecord } {
  const first = opts.port ?? DEFAULT_UI_PORT
  const build = opts.build ?? uiBuildId()
  const now = opts.now ?? Date.now
  const stopAfterMs = opts.stopAfterMs ?? UI_STOP_AFTER_MS
  const pollMs = opts.idleEveryMs ?? Math.min(UI_POLL_MS, Math.max(20, Math.floor(stopAfterMs / 3)))
  const follow = !captureOff()
  let lastErr: unknown
  for (let port = first; port < first + PORT_TRIES; port++) {
    const ctx = uiContext({ version: opts.version, port, ...(build !== undefined ? { build } : {}), ...(opts.now !== undefined ? { now: opts.now } : {}) })
    try {
      const server = Bun.serve({ hostname: HOST, port, idleTimeout: 60, fetch: (req, srv) => handle(req, ctx, srv) })
      const record: UiRecord = { v: 1, pid: process.pid, port, host: HOST, url: `http://${HOST}:${port}`, startedAt: new Date().toISOString(), version: opts.version, ...(build !== undefined ? { build } : {}), brain: brainDir() }
      atomicWriteSync(paths.memoryUiStateFile(), JSON.stringify(record, null, 2) + '\n')
      let openAt: number | undefined
      const idle = setInterval(() => {
        idleCortex(CORTEX_IDLE_MS)
        if (!existsSync(paths.buracleHome())) {
          clearInterval(idle)
          try { server.stop(true) } catch {  }
          opts.onStop?.('home-gone')
          return
        }
        if (!follow) return
        const t = now()
        if (anySessionOpen(t)) { openAt = t; return }
        if (openAt === undefined || t - openAt < stopAfterMs) return
        clearInterval(idle)
        log('info', 'memory ui: stopping, no harness session has been open', { port, forMs: t - openAt })
        clearUiRecord()
        try { server.stop(true) } catch {  }
        opts.onStop?.('no-sessions')
      }, pollMs)
      idle.unref?.()
      return { server, record }
    } catch (e) { lastErr = e }
  }
  throw new Error(`no free port in ${first}-${first + PORT_TRIES - 1} for the memory UI (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`)
}

export function clearUiRecord(pid = process.pid): void {
  const rec = readUiRecord()
  if (rec !== undefined && rec.pid !== pid) return
  try { atomicWriteSync(paths.memoryUiStateFile(), '{}\n') } catch {  }
}

export async function ensureUi(argv: string[] | undefined, opts: { port?: number, waitMs?: number } = {}): Promise<{ url: string, started: boolean } | undefined> {
  const live = await liveUi()
  if (live !== undefined && (argv === undefined || sameUiBuild(live.health.build, uiBuildId()))) return { url: live.url, started: false }
  if (argv === undefined) return undefined
  const spawned = spawnArgv([...argv, 'mem', 'ui', '--serve', ...(opts.port !== undefined ? ['--port', String(opts.port)] : [])])
  const child = Bun.spawn(spawned, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true, cwd: paths.home(), env: { ...process.env }, windowsVerbatimArguments: windowsVerbatim(spawned) })
  child.unref()
  const deadline = Date.now() + (opts.waitMs ?? 8_000)
  while (Date.now() < deadline) {
    await Bun.sleep(150)
    const rec = readUiRecord()
    if (rec !== undefined && rec.pid === child.pid && await healthy(rec.url)) return { url: rec.url, started: true }
  }
  return undefined
}

export function openInBrowser(url: string): boolean {
  try {
    const argv = process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '""', url] : ['xdg-open', url]
    const p = Bun.spawn(argv, { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', detached: true, env: { ...process.env } })
    p.unref()
    return true
  } catch { return false }
}
