import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { handoffNote } from '../../src/core/compact'
import { contextText } from '../../src/memory/context'
import { finalize } from '../../src/memory/finalize'
import { latestHandoff, writeHandoff } from '../../src/memory/handoff'
import { readSessionRecord, sessionStart } from '../../src/memory/session-record'
import { appendSpool } from '../../src/memory/spool'
import { listAll, projectRef } from '../../src/memory/store'
import { withBrain } from './helpers'

const REPO = resolve(import.meta.dir, '..', '..')
const SID = '11111111-2222-4333-8444-555555555555'

describe('session capture through the adapter seams', () => {
  test('start, spool and finalize leave one session memory that expires', async () => {
    await withBrain(async sb => {
      const started = await sessionStart('claude', SID, sb.repo)
      expect(started.slug).toBe('demo')
      expect(readSessionRecord('claude', SID)?.status).toBe('active')
      const t = Date.now()
      appendSpool('claude', SID, [
        { ts: t, ev: 'prompt' },
        { ts: t + 1, ev: 'tool', tool: 'Bash', kind: 'bash', cmd: 'bun test', exit: 0 },
        { ts: t + 2, ev: 'stop', excerpt: 'Fixed the parser.' },
      ])
      const r = await finalize('claude', SID)
      expect(r.memoryId).toBe('session-claude-code-555555')
      const again = await finalize('claude', SID)
      expect(again.memoryId).toBe(r.memoryId)
      const sessions = (await listAll(projectRef('demo'))).filter(i => i.kind === 'session')
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.body).toContain('Fixed the parser.')
      expect(Date.parse(sessions[0]?.expires as string)).toBeGreaterThan(Date.now() + 40 * 86_400_000)
      expect(readSessionRecord('claude', SID)?.status).toBe('ended')
    })
  })

  test('a session without a model turn leaves no memory', async () => {
    await withBrain(async sb => {
      await sessionStart('codex', SID, sb.repo)
      appendSpool('codex', SID, [{ ts: Date.now(), ev: 'prompt' }])
      const r = await finalize('codex', SID)
      expect(r.empty).toBe(true)
      expect((await listAll(projectRef('demo'))).filter(i => i.kind === 'session')).toEqual([])
    })
  })

  test('BURACLE_NO_CAPTURE=1 writes nothing', async () => {
    await withBrain(async sb => {
      expect((await sessionStart('omp', SID, sb.repo)).skipped).toBe('capture-off')
      expect((await finalize('omp', SID)).skipped).toBe('capture-off')
    }, { capture: false })
  })
})

describe('handoffs', () => {
  test('a handoff becomes a memory the next session points at', async () => {
    await withBrain(async sb => {
      const note = handoffNote({ state: { v: 1, guard: { blocksForPlan: 0, blocksInChain: 0 } }, project: 'demo', harness: 'claude', sessionId: SID, branch: 'main', now: Date.now(), todo: ['finish T3'] })
      const w = await writeHandoff({ harness: 'claude', sessionId: SID, cwd: sb.repo, branch: 'main', slug: note.slug, markdown: note.markdown })
      expect(w?.id.startsWith('handoff-')).toBe(true)
      expect((await latestHandoff({ project: 'demo', branch: 'main' }))?.id).toBe(w?.id)
      expect(await latestHandoff({ project: 'demo', branch: 'other' })).toBeUndefined()
      expect((await latestHandoff({ project: 'demo', branch: 'main', session: SID }))?.id).toBe(w?.id)
      expect(await latestHandoff({ project: 'demo', branch: 'main', session: 'a-parallel-session' })).toBeUndefined()
      const text = await contextText({ cwd: sb.repo, sweep: false })
      expect(text).toContain(`${w?.id} \u2014 memory_get it`)
      const [h] = (await listAll(projectRef('demo'))).filter(i => i.kind === 'handoff')
      expect(h?.body).toContain('finish T3')
    })
  })
})

const LIGHT_GRAPH = [/^src\/core\//, /^src\/engine\/(paths|config|fsx|log|platform|git|proc|lockfile)\.ts$/, /^src\/memory\/(spool|layout|session-record|session-open|spawn|project|lock|upkeep-file|jobs|tick-start)\.ts$/, /^src\/workflow\/(workspace|gitx|non-project)\.ts$/]
const LIGHT_EXTERNAL = ['node:fs', 'node:path', 'node:os', 'node:crypto', 'node:child_process', 'yaml', 'jsonc-parser']

function importGraph(entry: string): { files: string[], external: string[] } {
  const transpiler = new Bun.Transpiler({ loader: 'tsx' })
  const files = new Set<string>()
  const external = new Set<string>()
  const stack = [entry]
  while (stack.length > 0) {
    const file = stack.pop() as string
    if (files.has(file)) continue
    files.add(file)
    for (const imp of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      if (!imp.path.startsWith('.')) { external.add(imp.path); continue }
      const base = resolve(dirname(file), imp.path)
      const hit = [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(p => existsSync(p) && /\.tsx?$/.test(p))
      if (hit === undefined) throw new Error(`unresolved import ${imp.path} in ${file}`)
      stack.push(hit)
    }
  }
  return { files: [...files].map(f => relative(REPO, f)).sort(), external: [...external].sort() }
}

describe('the bundled memory modules stay light', () => {
  for (const mod of ['spool.ts', 'session-record.ts', 'upkeep-file.ts']) {
    test(`src/memory/${mod} reaches no CortexDB client, store or API`, () => {
      const g = importGraph(join(REPO, 'src', 'memory', mod))
      expect(g.files).toContain(`src/memory/${mod}`)
      expect(g.files.filter(f => !LIGHT_GRAPH.some(re => re.test(f)))).toEqual([])
      expect(g.external.filter(x => !LIGHT_EXTERNAL.includes(x))).toEqual([])
    })
  }

  test('the spool alone stays within core, engine basics and its own layout', () => {
    const g = importGraph(join(REPO, 'src', 'memory', 'spool.ts'))
    expect(g.files.filter(f => f.startsWith('src/memory/'))).toEqual(['src/memory/layout.ts', 'src/memory/spool.ts'])
  })

  test('the upkeep reader needs no project resolution (the omp extension bundles it)', () => {
    const g = importGraph(join(REPO, 'src', 'memory', 'upkeep-file.ts'))
    expect(g.files.filter(f => f.startsWith('src/memory/'))).toEqual(['src/memory/layout.ts', 'src/memory/upkeep-file.ts'])
  })
})
