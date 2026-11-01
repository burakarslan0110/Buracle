import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runPlan } from '../../src/cli/commands/plan'
import * as paths from '../../src/engine/paths'
import { projectsFile } from '../../src/memory/layout'
import { handle, PAGE_CSP, UI_ASSETS, uiContext, type UiContext } from '../../src/memory/ui'
import { forgetReviewListing } from '../../src/memory/ui/review'
import { HIDDEN_REASONS } from '../../src/memory/ui/review-changes'
import { readInbox } from '../../src/workflow/review-notes'
import { saveState } from '../../src/workflow/session-store'
import { withSandbox } from '../helpers/sandbox'
import { ctxAt, makeRepo, memIO, planDoc, write } from '../workflow/fixture'

const NOW = Date.UTC(2026, 9, 18, 9)
const UI_DIR = join(import.meta.dir, '../../src/memory/ui')

function ctx(): UiContext {
  forgetReviewListing()
  return uiContext({ version: '9.9.9', port: 41999, now: () => NOW })
}

function req(c: UiContext, path: string, init: { method?: string, headers?: Record<string, string>, body?: string } = {}): Promise<Response> {
  return handle(new Request(`http://127.0.0.1:${c.port}${path}`, { method: init.method ?? 'GET', headers: { host: `127.0.0.1:${c.port}`, ...init.headers }, ...(init.body !== undefined ? { body: init.body } : {}) }), c)
}

async function getJson(c: UiContext, path: string, headers: Record<string, string> = { 'x-buracle-token': c.token }): Promise<{ status: number, body: Record<string, unknown> }> {
  const r = await req(c, path, { headers })
  return { status: r.status, body: await r.json() as Record<string, unknown> }
}

async function post(c: UiContext, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number, body: Record<string, unknown> }> {
  const r = await req(c, path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', 'x-buracle-token': c.token, origin: `http://127.0.0.1:${c.port}`, ...headers } })
  return { status: r.status, body: await r.json() as Record<string, unknown> }
}

function register(slug: string, repo: string): void {
  mkdirSync(dirname(projectsFile()), { recursive: true })
  writeFileSync(projectsFile(), JSON.stringify({ v: 1, projects: { [slug]: { slug, scope: 'project', roots: [repo], commonDir: join(repo, '.git') } } }))
}

interface Doc { id: string, rel: string, dir: string, title: string, open: number, changes: string, session?: { paused: boolean, phase: string, reason?: string } }
interface Repo { name: string, docs: Doc[], checkouts: Array<{ id: string, branch?: string, main: boolean, open: number }> }

async function setup(root: string): Promise<{ repo: string, plan: string }> {
  const repo = await makeRepo(root, 'shop')
  const plan = join(repo, 'docs', 'plans', '2026-10-18-limit.md')
  write(plan, planDoc({ title: 'Rate limit the API' }))
  write(join(repo, 'docs', 'prd', '2026-10-17-search.md'), '# Search items\n\nUsers search by name.\n')
  write(join(repo, 'docs', 'plans', 'nested', 'skip.md'), '# not listed\n')
  write(join(repo, 'src', 'app.ts'), 'export const a = 2\nexport const b = 3\n')
  write(join(repo, 'src', 'new.ts'), 'export const fresh = true\n')
  write(join(repo, '.env.local'), 'TOKEN=not-a-real-secret\n')
  writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]))
  register('shop', repo)
  return { repo, plan }
}

describe('the review page', () => {
  test('is served at /review with the page policy, only allowlisted assets and no inline code', async () => {
    await withSandbox(async () => {
      const c = ctx()
      const r = await req(c, '/review')
      expect(r.status).toBe(200)
      expect(r.headers.get('content-security-policy')).toBe(PAGE_CSP)
      const html = await r.text()
      expect(html).toBe(readFileSync(join(UI_DIR, 'review.html'), 'utf8'))
      expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>|\sstyle\s*=|<style|\son[a-z]+\s*=|javascript:/i)
      const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map(m => m[1] as string).filter(u => u.startsWith('/assets/'))
      expect(refs.length).toBeGreaterThan(4)
      for (const u of refs) expect(Object.keys(UI_ASSETS)).toContain(u.slice(8))
      expect((await req(c, '/review', { method: 'POST' })).status).toBe(405)
    })
  })

  test('lists the plans, build contracts and PRDs of registered projects and their checkouts, and marks a plan that waits for approval', async () => {
    await withSandbox(async ({ root }) => {
      const { repo, plan } = await setup(root)
      saveState('claude', 'review-s1', { v: 1, plan: { path: plan, slug: 'limit', status: 'PENDING', type: 'Feature', phase: 'plan', registeredAt: NOW }, interaction: { state: 'paused', kind: 'decision', since: NOW, reason: 'plan approval' }, guard: { blocksForPlan: 0, blocksInChain: 0 } })
      const c = ctx()
      const r = await getJson(c, '/api/review/docs')
      expect(r.status).toBe(200)
      const repos = r.body['repos'] as Repo[]
      expect(repos.map(x => x.name)).toEqual(['shop'])
      const docs = repos[0]!.docs
      expect(docs.map(d => d.rel).sort()).toEqual(['docs/plans/2026-10-18-limit.md', 'docs/prd/2026-10-17-search.md'])
      const p = docs.find(d => d.dir === 'plans')!
      expect(p.title).toBe('Rate limit the API')
      expect(p.session).toMatchObject({ paused: true, phase: 'plan', reason: 'plan approval' })
      expect(repos[0]!.checkouts).toEqual([expect.objectContaining({ branch: 'main', main: true, open: 0 })])
      expect(p.changes).toBe(repos[0]!.checkouts[0]!.id)
      const doc = await getJson(c, `/api/review/doc?id=${p.id}`)
      expect(doc.status).toBe(200)
      expect((await getJson(c, '/api/review/docs', {})).status).toBe(200)
      const bare = await getJson(c, `/api/review/doc?id=${p.id}`, {})
      expect(bare).toMatchObject({ status: 403, body: { error: 'bad_token' } })
      expect(JSON.stringify(bare.body)).not.toContain('Do step 1.')
      expect((await getJson(c, `/api/review/doc?id=${p.id}`, { 'x-buracle-token': c.token, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
      expect(doc.body['text']).toBe(readFileSync(plan, 'utf8'))
      expect(doc.body['notes']).toEqual([])
      expect((await getJson(c, '/api/review/doc?id=000000000000')).status).toBe(404)
      expect((await getJson(c, '/api/review/doc?id=../../etc')).status).toBe(400)
      expect(repo).toContain('shop')
    })
  })

  test('a note is written only with the token and the page origin, and the agent reads it with buracle plan notes', async () => {
    await withSandbox(async ({ root }) => {
      const { repo, plan } = await setup(root)
      const c = ctx()
      const p = ((await getJson(c, '/api/review/docs')).body['repos'] as Repo[])[0]!.docs.find(d => d.dir === 'plans')!
      const note = { doc: p.id, kind: 'plan', quote: 'Do step 1.', line: 12, text: 'Say which client it was' }
      expect((await post(c, '/api/review/note/add', note, { 'x-buracle-token': 'f'.repeat(48) })).status).toBe(403)
      expect((await post(c, '/api/review/note/add', note, { origin: 'https://evil.example' })).status).toBe(403)
      expect((await post(c, '/api/review/note/add', note, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
      expect((await post(c, '/api/review/note/add', { ...note, kind: 'code', file: 'src/app.ts', start: 1 })).status).toBe(400)
      expect((await post(c, '/api/review/note/add', { ...note, text: ' ' })).status).toBe(400)
      expect((await post(c, '/api/review/note/add', { ...note, doc: 'ffffffffffff' })).status).toBe(404)
      const added = await post(c, '/api/review/note/add', note)
      expect(added.status).toBe(200)
      const id = added.body['id'] as string
      expect(added.body['open']).toBe(1)
      expect(readInbox()).toEqual([expect.objectContaining({ open: 1, rel: 'docs/plans/2026-10-18-limit.md', at: NOW })])

      const edited = await post(c, '/api/review/note/edit', { doc: p.id, id, text: 'Name the incident ticket' })
      expect(edited.status).toBe(200)
      expect((edited.body['notes'] as Array<{ text: string, edited?: string }>)[0]).toMatchObject({ text: 'Name the incident ticket', edited: new Date(NOW).toISOString() })

      const io = memIO(true)
      expect(await runPlan(['notes', plan, '--kind', 'plan'], io, ctxAt(repo, NOW))).toBe(0)
      expect(io.json<{ notes: Array<{ id: string, text: string }> }>().notes).toEqual([expect.objectContaining({ id, text: 'Name the incident ticket', quote: 'Do step 1.', line: 12 })])
      expect(await runPlan(['notes', plan, '--done', id], memIO(true), ctxAt(repo, NOW))).toBe(0)

      const after = await getJson(c, `/api/review/doc?id=${p.id}`)
      expect(after.body['open']).toBe(0)
      expect((after.body['notes'] as Array<{ done?: string }>)[0]?.done).toBe(new Date(NOW).toISOString())
      expect((await post(c, '/api/review/note/edit', { doc: p.id, id, text: 'too late' })).status).toBe(404)
      const gone = await post(c, '/api/review/note/delete', { doc: p.id, id })
      expect(gone.body).toMatchObject({ ok: true, deleted: true, notes: [] })
      expect((await post(c, '/api/review/note/delete', { doc: p.id, id })).status).toBe(404)
    })
  })

  test('the changes view shows the working tree diff as text, hides secret and binary files, leaves plan files to the plans view, and takes line notes', async () => {
    await withSandbox(async ({ root }) => {
      const { repo } = await setup(root)
      const c = ctx()
      const co = ((await getJson(c, '/api/review/docs')).body['repos'] as Repo[])[0]!.checkouts[0]!
      const bare = await getJson(c, `/api/review/changes?checkout=${co.id}`, {})
      expect(bare).toMatchObject({ status: 403, body: { error: 'bad_token' } })
      expect(JSON.stringify(bare.body)).not.toContain('export const')
      expect((await getJson(c, `/api/review/changes?checkout=${co.id}`, { 'x-buracle-token': 'f'.repeat(48) })).status).toBe(403)
      expect((await getJson(c, `/api/review/changes?checkout=${co.id}`, { 'x-buracle-token': c.token, origin: 'https://evil.example' })).status).toBe(403)
      const r = await getJson(c, `/api/review/changes?checkout=${co.id}`)
      expect(r.status).toBe(200)
      expect(r.body['scope']).toMatchObject({ mode: 'working-tree', base_ref: 'HEAD', branch: 'main' })
      const files = r.body['files'] as Array<{ path: string, status: string, add: number, del: number, hidden?: string, patch?: string }>
      expect(files.map(f => f.path).sort()).toEqual(['.env.local', 'docs/plans/nested/skip.md', 'logo.bin', 'src/app.ts', 'src/new.ts'])
      const app = files.find(f => f.path === 'src/app.ts')!
      expect(app).toMatchObject({ status: 'modified', add: 2, del: 1 })
      expect(app.patch).toBe('@@ -1 +1,2 @@\n-export const a = 1\n+export const a = 2\n+export const b = 3')
      expect(files.find(f => f.path === 'src/new.ts')).toMatchObject({ status: 'untracked', add: 1, patch: '@@ -0,0 +1,1 @@\n+export const fresh = true' })
      expect(files.find(f => f.path === '.env.local')).toEqual({ path: '.env.local', status: 'untracked', add: 0, del: 0, hidden: 'secret' })
      expect(files.find(f => f.path === 'logo.bin')?.hidden).toBe('binary')
      expect(JSON.stringify(r.body)).not.toContain('not-a-real-secret')

      expect((await post(c, '/api/review/note/add', { checkout: co.id, kind: 'plan', quote: 'x', text: 'y' })).status).toBe(400)
      expect((await post(c, '/api/review/note/add', { checkout: co.id, kind: 'code', file: '../etc/passwd', start: 1, text: 'y' })).status).toBe(400)
      const added = await post(c, '/api/review/note/add', { checkout: co.id, kind: 'code', file: 'src/app.ts', side: 'new', start: 1, end: 2, quote: 'export const a = 2\nexport const b = 3', text: 'Keep a at 1' })
      expect(added.status).toBe(200)
      expect((await getJson(c, `/api/review/changes?checkout=${co.id}`)).body['open']).toBe(1)
      const io = memIO(true)
      expect(await runPlan(['notes', '--kind', 'code'], io, ctxAt(repo, NOW))).toBe(0)
      expect(io.json<{ notes: unknown[] }>().notes).toEqual([expect.objectContaining({ file: 'src/app.ts', start: 1, end: 2, side: 'new', text: 'Keep a at 1' })])
      expect((await getJson(c, '/api/review/changes?checkout=ffffffffffff')).status).toBe(404)
      expect(paths.reviewNotesDir().startsWith(paths.buracleHome())).toBe(true)
    })
  })

  test('the changes view never shows the text of a common credential file, and still shows a source file that only has secret in its name', async () => {
    await withSandbox(async ({ root }) => {
      const { repo } = await setup(root)
      const creds = ['.npmrc', '.netrc', '.pypirc', '.git-credentials', '.htpasswd', 'secrets.json', 'config/secrets.yaml', 'service-account.json', 'gcp/service_account-prod.json', 'infra/terraform.tfvars', 'infra/prod.tfstate', 'infra/prod.tfstate.backup', 'kubeconfig', 'ops/staging.kubeconfig', '.docker/config.json', '.kube/config', 'deploy/secret.env']
      for (const f of creds) write(join(repo, f), 'cred-text-xyz\n')
      write(join(repo, 'src', 'secrets.ts'), 'export const reader = 1\n')
      const c = ctx()
      const co = ((await getJson(c, '/api/review/docs')).body['repos'] as Repo[])[0]!.checkouts[0]!
      const r = await getJson(c, `/api/review/changes?checkout=${co.id}`)
      expect(r.status).toBe(200)
      const files = r.body['files'] as Array<{ path: string, status: string, hidden?: string, patch?: string }>
      for (const f of creds) expect({ f, hidden: files.find(x => x.path === f)?.hidden }).toEqual({ f, hidden: 'secret' })
      expect(JSON.stringify(r.body)).not.toContain('cred-text-xyz')
      expect(files.find(x => x.path === 'src/secrets.ts')).toMatchObject({ status: 'untracked', patch: '@@ -0,0 +1,1 @@\n+export const reader = 1' })
    })
  })

  test('the page never follows a symbolic link out of the repository and names why a file is not shown', async () => {
    await withSandbox(async ({ root }) => {
      const { repo } = await setup(root)
      const outside = join(root, 'outside')
      write(join(outside, 'notes.txt'), 'secret-stuff-xyz\n')
      write(join(outside, 'plan.md'), '# Outside plan\n\nouter-plan-text\n')
      symlinkSync(join(outside, 'notes.txt'), join(repo, 'src', 'link.txt'))
      symlinkSync(join(outside, 'plan.md'), join(repo, 'docs', 'plans', '2026-10-18-linked.md'))
      write(join(repo, 'big.txt'), 'plain text line\n'.repeat(20_000))
      const c = ctx()
      const listing = await getJson(c, '/api/review/docs')
      const docs = (listing.body['repos'] as Repo[])[0]!.docs
      expect(docs.map(d => d.rel)).not.toContain('docs/plans/2026-10-18-linked.md')
      expect(JSON.stringify(listing.body)).not.toContain('Outside plan')
      const co = (listing.body['repos'] as Repo[])[0]!.checkouts[0]!
      const r = await getJson(c, `/api/review/changes?checkout=${co.id}`)
      const files = r.body['files'] as Array<{ path: string, status: string, add: number, del: number, hidden?: string, patch?: string }>
      expect(files.find(f => f.path === 'src/link.txt')).toEqual({ path: 'src/link.txt', status: 'untracked', add: 0, del: 0, hidden: 'symlink' })
      expect(files.find(f => f.path === 'big.txt')).toEqual({ path: 'big.txt', status: 'untracked', add: 0, del: 0, hidden: 'large' })
      expect(JSON.stringify(r.body)).not.toContain('secret-stuff-xyz')
      expect(JSON.stringify(r.body)).not.toContain('outer-plan-text')
      const i18n = readFileSync(join(UI_DIR, 'i18n.js'), 'utf8')
      for (const reason of HIDDEN_REASONS) expect(i18n).toContain(`'review.hidden.${reason}':`)
    })
  })
})

type DiagramEntry = { light?: string, dark?: string, error?: string }

async function docDiagrams(c: UiContext, rel: string): Promise<Record<string, DiagramEntry>> {
  forgetReviewListing()
  const docs = ((await getJson(c, '/api/review/docs')).body['repos'] as Repo[])[0]!.docs
  const d = docs.find(x => x.rel === rel)
  if (d === undefined) throw new Error(`no listed doc ${rel}: ${docs.map(x => x.rel).join(', ')}`)
  const r = await getJson(c, `/api/review/doc?id=${d.id}`)
  expect(r.status).toBe(200)
  return r.body['diagrams'] as Record<string, DiagramEntry>
}

const FLOW = 'flowchart LR\n  A[Plan] --> B[Build]'
const SEQ = 'sequenceDiagram\n  Agent->>User: done'
const PIE = 'pie title Pets\n  "Dogs" : 386'

describe('the review page draws Mermaid blocks', () => {
  test('each mermaid block, keyed by its body, gets a light and a dark SVG or the parse error', async () => {
    await withSandbox(async ({ root }) => {
      const { repo } = await setup(root)
      const text = [
        // A fence inside the frontmatter is data, not a block: the page skips the frontmatter.
        '---', 'type: prd', 'notes: |', '  ```mermaid', '  flowchart LR', '  ```', '---', '# Flows', '',
        '```mermaid', FLOW, '```', '',
        '```ts', 'const a = 1', '```', '',
        '```mermaid', PIE, '```', '',
        'Again:', '', '```mermaid', FLOW, '```', '',
        '~~~mermaid', SEQ, '~~~', '',
        // The page ends a comment at the first line holding -->, so this one has no arrow inside.
        '<!-- hidden', '```mermaid', 'sequenceDiagram', '  X->>Y: hi', '```', '-->', '',
        '````markdown', '```mermaid', 'flowchart TD', '  P --> Q', '```', '````', '',
      ].join('\n')
      write(join(repo, 'docs', 'prd', '2026-10-19-flows.md'), text)
      const c = ctx()
      const diagrams = await docDiagrams(c, 'docs/prd/2026-10-19-flows.md')
      expect(Object.keys(diagrams).sort()).toEqual([FLOW, PIE, SEQ].sort())
      for (const key of [FLOW, SEQ]) {
        expect(diagrams[key]!.light!.startsWith('<svg')).toBe(true)
        expect(diagrams[key]!.dark!.startsWith('<svg')).toBe(true)
        expect(diagrams[key]!.light).not.toContain('<script')
      }
      expect(diagrams[PIE]).toEqual({ error: expect.stringContaining('Invalid mermaid header') })
    })
  })

  test('CRLF line ends and an unclosed fence give the same keys the page computes; a doc without blocks gets none', async () => {
    await withSandbox(async ({ root }) => {
      const { repo } = await setup(root)
      write(join(repo, 'docs', 'prd', '2026-10-19-crlf.md'), ['# CRLF', '', '```mermaid', FLOW, '```', ''].join('\n').replace(/\n/g, '\r\n'))
      write(join(repo, 'docs', 'prd', '2026-10-19-open.md'), ['# Open', '', '```mermaid', SEQ].join('\n'))
      const c = ctx()
      expect(Object.keys(await docDiagrams(c, 'docs/prd/2026-10-19-crlf.md'))).toEqual([FLOW])
      expect(Object.keys(await docDiagrams(c, 'docs/prd/2026-10-19-open.md'))).toEqual([SEQ])
      expect(await docDiagrams(c, 'docs/prd/2026-10-17-search.md')).toEqual({})
    })
  })

  test('past 30 distinct blocks, and for a block over 20000 characters, the entry is an error and nothing is drawn', async () => {
    await withSandbox(async ({ root }) => {
      const { repo } = await setup(root)
      const blocks = Array.from({ length: 31 }, (_, i) => `flowchart LR\n  A${i} --> B${i}`)
      const huge = ('flowchart TD\n' + '  A --> B\n'.repeat(2500)).trimEnd()
      write(join(repo, 'docs', 'prd', '2026-10-19-many.md'), ['# Many', '', ...blocks.flatMap(b => ['```mermaid', b, '```', ''])].join('\n'))
      write(join(repo, 'docs', 'prd', '2026-10-19-huge.md'), ['# Huge', '', '```mermaid', huge, '```', ''].join('\n'))
      const c = ctx()
      const diagrams = await docDiagrams(c, 'docs/prd/2026-10-19-many.md')
      expect(diagrams[blocks[29]!]!.light).toBeString()
      expect(diagrams[blocks[30]!]).toEqual({ error: expect.stringContaining('30') })
      expect((await docDiagrams(c, 'docs/prd/2026-10-19-huge.md'))[huge]).toEqual({ error: expect.stringContaining('20000') })
    })
  }, 30_000)
})
