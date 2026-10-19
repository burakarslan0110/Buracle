import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MemItem } from '../../src/core/memory/brain'
import { update, write } from '../../src/memory/api'
import { brainAbsorbedDir, projectsFile } from '../../src/memory/layout'
import { deleteItem, getStored, listAll, personRef, projectRef, saveItem } from '../../src/memory/store'
import { readUpkeep, sweep, sweepDue, sweepLayer } from '../../src/memory/sweep'
import { mergedProjects, resolveProject } from '../../src/memory/project'
import { agentCtx, git, makeRepo, withBrain } from './helpers'

const DAY = 86_400_000

function episode(id: string, over: Partial<MemItem>): MemItem {
  const at = new Date(Date.now() - DAY).toISOString()
  return { id, kind: 'session', layer: 'project', title: id, summary: '', body: '', tags: [], sources: [], about: [], status: 'active', review: 'ok', importance: 2, created: at, updated: at, author: 'buracle', version: 1, history: [], ...over }
}

describe('sweep', () => {
  test('deletes expired and long-retired memories, keeps the rest, and creates the core pages', async () => {
    await withBrain(async ({ repo }) => {
      await resolveProject(repo)
      const ref = projectRef('demo')
      await saveItem(ref, episode('session-expired', { expires: new Date(Date.now() - 1000).toISOString() }))
      await saveItem(ref, episode('session-fresh', { expires: new Date(Date.now() + DAY).toISOString() }))
      await saveItem(ref, episode('decision-retired', { kind: 'decision', status: 'deprecated', deprecatedAt: new Date(Date.now() - 40 * DAY).toISOString(), author: 'agent' }))
      await saveItem(ref, episode('decision-just-retired', { kind: 'decision', status: 'deprecated', deprecatedAt: new Date(Date.now() - DAY).toISOString(), author: 'agent' }))
      const r = await sweep({ slug: 'demo' })
      const layer = r.layers.find(l => l.project === 'demo')
      expect(layer?.pruned.map(p => p.id).sort()).toEqual(['decision-retired', 'session-expired'])
      const ids = (await listAll(ref)).map(i => i.id)
      expect(ids).toContain('session-fresh')
      expect(ids).toContain('decision-just-retired')
      expect(ids.filter(i => i.startsWith('core-')).sort()).toEqual(['core-architecture', 'core-brief', 'core-commands', 'core-conventions', 'core-glossary', 'core-progress'])
      expect(sweepDue('demo', Date.now())).toBe(false)
      const dry = await sweep({ slug: 'demo', dryRun: true })
      expect(dry.dryRun).toBe(true)
    })
  })

  test('the commands page follows the repository', async () => {
    await withBrain(async ({ repo }) => {
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'bun test' } }))
      writeFileSync(join(repo, 'bun.lock'), '')
      await resolveProject(repo)
      await sweep({ slug: 'demo', person: false })
      const cmd = async () => (await listAll(projectRef('demo'))).find(i => i.id === 'core-commands')?.body ?? ''
      expect(await cmd()).toContain('`bun run test`')
      await update(agentCtx(repo), { id: 'core-commands', patch: { body: 'Run the tests before every push.\n\n' + await cmd() } })
      writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'bun test', lint: 'biome check' } }))
      const { scanStateDir } = await import('../../src/memory/layout')
      unlinkSync(join(scanStateDir(), 'demo.json'))
      await sweep({ slug: 'demo', person: false })
      const body = await cmd()
      expect(body).toContain('Run the tests before every push.')
      expect(body).toContain('`bun run lint`')
      expect(body.match(/buracle:detected:start/g)).toHaveLength(1)
    })
  })

  test('a verified memory whose cited file changed, or is gone, enters the upkeep queue', async () => {
    await withBrain(async ({ repo }) => {
      writeFileSync(join(repo, 'a.ts'), 'export const a = 1\n')
      writeFileSync(join(repo, 'b.ts'), 'export const b = 1\n')
      git(repo, 'add', '-A')
      git(repo, 'commit', '-q', '-m', 'files')
      const ctx = agentCtx(repo)
      const a = await write(ctx, { type: 'knowledge', title: 'The alpha module exports a constant', summary: 'alpha is 1', body: '', sources: ['a.ts:1'], review: 'ok' })
      const b = await write(ctx, { type: 'knowledge', title: 'Beta lives in its own file', summary: 'see b.ts', body: '', sources: ['b.ts'], review: 'ok' })
      expect(b.action).toBe('created')
      writeFileSync(join(repo, 'a.ts'), 'export const a = 2\n')
      git(repo, 'commit', '-q', '-am', 'change a')
      git(repo, 'rm', '-q', 'b.ts')
      git(repo, 'commit', '-q', '-m', 'drop b')
      await sweep({ slug: 'demo', person: false })
      const items = readUpkeep('demo')?.items ?? []
      expect(items.find(u => u.id === a.id)?.reasons).toEqual(['source-changed'])
      expect(items.find(u => u.id === b.id)?.reasons).toContain('source-missing')
      await update(ctx, { id: a.id, patch: { review: 'ok' } })
      expect((readUpkeep('demo')?.items ?? []).find(u => u.id === a.id)).toBeUndefined()
    })
  })

  test('memory links follow: a link to a memory that is gone is dropped, one to a merged memory goes to its survivor, a retired target keeps its link', async () => {
    await withBrain(async ({ repo }) => {
      const ctx = agentCtx(repo)
      const ref = projectRef('demo')
      const gone = (await write(ctx, { type: 'knowledge', title: 'Orders are written through the outbox', summary: 'outbox' })).id
      const survivor = (await write(ctx, { type: 'knowledge', title: 'The outbox relay runs every second', summary: 'relay' })).id
      const merged = (await write(ctx, { type: 'knowledge', title: 'The relay interval is one second', summary: 'interval', force: true })).id
      const retired = (await write(ctx, { type: 'gotcha', title: 'The relay once lost events on restart', summary: 'lost' })).id
      const linker = (await write(ctx, { type: 'decision', title: 'Keep the outbox relay', summary: 'keep it', sources: [`memory:${gone}`, `memory:${merged}`, `memory:${retired}`, 'src/relay.ts'] })).id
      await update(ctx, { id: merged, patch: { merge_into: survivor } })
      await update(ctx, { id: retired, patch: { status: 'deprecated' } })
      await deleteItem(ref, gone)
      const r = await sweepLayer(ref, { nowMs: Date.now() })
      expect(r.links).toEqual([{ id: linker, dropped: [gone], repointed: [{ from: merged, to: survivor }] }])
      const l = (await getStored(ref, linker))?.item
      expect(l?.sources).toEqual([`memory:${survivor}`, `memory:${retired}`, 'src/relay.ts'])
      expect(l?.history.at(-1)?.what).toBe(`links to gone memories dropped: ${gone}; link followed: ${merged} is now ${survivor}`)
      expect((await sweepLayer(ref, { nowMs: Date.now() })).links).toBeUndefined()
    })
  })

  test('the person layer is swept too', async () => {
    await withBrain(async ({ repo }) => {
      await saveItem(personRef(), { ...episode('capture-old', { kind: 'capture', layer: 'person', review: 'pending' }) })
      const r = await sweep({ slug: (await resolveProject(repo))?.slug as string })
      expect(r.layers.find(l => l.layer === 'person')?.upkeep).toBe(1)
    })
  })
})

describe('a folder project a repository took over', () => {
  test('the sweep moves its live memories into the repository\'s brain, once; the old file is kept aside', async () => {
    await withBrain(async ({ root }) => {
      const folder = join(root, 'folders', 'shopfolder')
      mkdirSync(folder, { recursive: true })
      const adhoc = await resolveProject(folder)
      expect(adhoc?.scope).toBe('adhoc')
      const old = adhoc?.slug as string
      const kept = await write(agentCtx(folder), { type: 'gotcha', title: 'The export times out after 30 s', summary: 'raise the proxy timeout', body: '' })
      const decision = await write(agentCtx(folder), { type: 'decision', title: 'Exports run at night', summary: 'off-peak only', body: '' })
      await saveItem(projectRef(old), episode('session-old-folder', { expires: new Date(Date.now() + DAY).toISOString() }))
      makeRepo(join(folder, 'app'), 'git@github.com:me/shop.git')
      const cache = JSON.parse(readFileSync(projectsFile(), 'utf8')) as { projects: Record<string, { checkedMs?: number }> }
      for (const r of Object.values(cache.projects)) r.checkedMs = 0
      writeFileSync(projectsFile(), JSON.stringify(cache))
      const repo = await resolveProject(folder)
      expect(repo?.scope).toBe('project')
      const slug = repo?.slug as string
      expect(mergedProjects(slug)).toEqual([old])

      const r = await sweep({ slug })
      const absorbed = r.layers.find(l => l.project === slug)?.absorbed
      expect(absorbed?.map(a => a.from)).toEqual([old])
      expect([...(absorbed?.[0]?.copied ?? [])].sort()).toEqual([decision.id, kept.id].sort())
      const items = await listAll(projectRef(slug))
      const moved = items.find(i => i.id === kept.id)
      expect(moved?.history.at(-1)?.what).toBe(`taken over from the folder project ${old}`)
      expect(items.some(i => i.id === 'session-old-folder')).toBe(false)
      expect(existsSync(projectRef(old).db)).toBe(false)
      expect(existsSync(join(brainAbsorbedDir(), `${old}.db`))).toBe(true)
      expect(mergedProjects(slug)).toEqual([])

      await update(agentCtx(join(folder, 'app')), { id: kept.id, patch: { status: 'deprecated' } })
      const again = await sweep({ slug })
      expect(again.layers.find(l => l.project === slug)?.absorbed).toBeUndefined()
      expect((await listAll(projectRef(slug))).find(i => i.id === kept.id)?.status).toBe('deprecated')
    })
  })
})
