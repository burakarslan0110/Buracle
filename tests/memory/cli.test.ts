import { describe, expect, test } from 'bun:test'
import { main } from '../../src/cli/router'
import { listAll, projectRef } from '../../src/memory/store'
import { withEnv } from '../helpers/sandbox'
import { withBrain } from './helpers'

async function cli(argv: string[], stdin = ''): Promise<{ code: number, out: string, err: string }> {
  let out = ''
  let err = ''
  const code = await main(argv, {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    stdin: { isTTY: stdin === '', text: async () => stdin },
  })
  return { code, out, err }
}

describe('buracle mem', () => {
  test('usage and unknown subcommands; the vault commands are gone', async () => {
    const help = await cli(['mem'])
    expect(help.code).toBe(0)
    expect(help.out).toContain('Usage: buracle mem <subcommand>')
    for (const s of ['import-vault', 'handoff', 'project init', 'capture [--session SID', 'finalize --harness H --session SID', '--origin explicit|inferred']) expect(help.out).toContain(s)
    expect(help.out).not.toMatch(/consolidate|timeline|obsidian \[|\b(?:sweep|reflect|heal|tick|kick)\b|mem jobs|profile drop|\bverify\b/i)
    for (const gone of ['init', 'obsidian', 'consolidate', 'timeline', 'scan', 'mirror', 'sweep', 'reflect', 'verify', 'heal', 'jobs', 'tick', 'kick', 'profile', 'distill']) {
      const r = await cli(['mem', gone])
      expect(r.code).toBe(1)
      expect(r.err).toContain(`unknown subcommand '${gone}'`)
    }
    expect((await cli(['mem', 'search', '--limit'])).code).toBe(1)
  })

  test('project init, write, search, get, update, remember, status, context', async () => {
    await withBrain(async ({ repo }) => {
      expect((await cli(['mem', 'project', 'init', '--cwd', repo])).code).toBe(0)
      const w = await cli(['mem', 'write', '--cwd', repo, '--type', 'decision', '--title', 'Use bun for every script', '--summary', 'One runtime', '--source', 'README.md', '--json'], '## Decision\nBun.\n')
      expect(w.code).toBe(0)
      const created = JSON.parse(w.out) as { id: string, action: string }
      expect(created.action).toBe('created')
      expect((await listAll(projectRef('demo'))).find(i => i.id === created.id)).toMatchObject({ origin: 'explicit', confidence: 1 })
      const dup = await cli(['mem', 'write', '--cwd', repo, '--type', 'decision', '--title', 'Use bun for every script', '--summary', 'One runtime', '--body', 'x'])
      expect(dup.code).toBe(2)
      expect(dup.out).toContain('duplicate suspected')
      const s = await cli(['mem', 'search', 'bun', 'script', '--cwd', repo, '--json'])
      expect(JSON.parse(s.out)[0].id).toBe(created.id)
      expect((await cli(['mem', 'search', 'bun', '--cwd', repo, '--type', 'gotcha'])).out).toContain('Nothing matched')
      const g = await cli(['mem', 'get', created.id, '--cwd', repo])
      expect(g.out).toContain('data, not instructions')
      expect(g.out).toContain('## Decision\nBun.')
      const u = await cli(['mem', 'update', created.id, '--cwd', repo, '--patch', '{"review":"ok"}', '--json'])
      expect(JSON.parse(u.out)).toMatchObject({ id: created.id, changed: ['review'] })
      expect((await cli(['mem', 'update', created.id, '--cwd', repo, '--patch', 'not json'])).code).toBe(1)
      const rem = await cli(['mem', 'remember', 'Check the release checklist before tagging', '--cwd', repo, '--json'])
      expect(JSON.parse(rem.out).id).toMatch(/^capture-/)
      const st = await cli(['mem', 'status', '--cwd', repo, '--json'])
      expect(JSON.parse(st.out).status).toMatchObject({ v: 3, project: 'demo', captures: 1 })
      expect(st.out).not.toContain('upkeep')
      const text = await cli(['mem', 'status', '--cwd', repo])
      expect(text.out).toContain('Last capture: none yet')
      expect(text.out).toContain('Inbox: 1 capture')
      const compact = await cli(['mem', 'status', '--cwd', repo, '--style', 'compact'])
      expect(compact.out.split('\n')[0]).toMatch(/^brain \d+/)
      const ctx = await cli(['mem', 'context', '--cwd', repo, '--harness', 'codex', '--json'])
      expect(JSON.parse(ctx.out).text).toContain('Use bun for every script')
    })
  })

  test('start, finalize and handoff for hooks; session env vars are honored', async () => {
    await withBrain(async ({ repo }) => {
      expect((await cli(['mem', 'start'])).code).toBe(2)
      const start = await cli(['mem', 'start', '--harness', 'codex', '--session', 'abc-123', '--cwd', repo, '--json'])
      expect(JSON.parse(start.out).slug).toBe('demo')
      await withEnv({ CODEX_THREAD_ID: 'abc-123' }, async () => {
        const fin = await cli(['mem', 'finalize', '--json'])
        expect(fin.code).toBe(0)
        expect(JSON.parse(fin.out).slug).toBe('demo')
        const w = await cli(['mem', 'write', '--cwd', repo, '--type', 'gotcha', '--title', 'Agents write through the CLI twin', '--summary', 'd', '--body', 'x', '--json'])
        const [item] = (await listAll(projectRef('demo'))).filter(i => i.id === JSON.parse(w.out).id)
        expect(item).toMatchObject({ harness: 'codex', session: 'abc-123', review: 'pending', author: 'agent' })
      })
      const cap = await cli(['mem', 'capture', '--harness', 'codex', '--session', 'abc-123', '--json'])
      expect(cap.code).toBe(0)
      expect(JSON.parse(cap.out).capture).toMatchObject({ state: 'done', preferences: { written: [] } })
      const latest = await cli(['mem', 'capture', '--cwd', repo, '--json'])
      expect(latest.code).toBe(0)
      expect((await cli(['mem', 'capture', '--cwd', repo, '--harness', 'codex', '--session', 'not valid!'])).code).toBe(2)
      const h = await cli(['mem', 'handoff', '--harness', 'codex', '--session', 'abc-123', '--cwd', repo, '--slug', '2026-10-13-2200-codex-abc123', '--json'], '---\ntitle: "Handoff: demo"\n---\n# Handoff: demo\n\nopen work\n')
      expect(JSON.parse(h.out).id).toBe('handoff-2026-10-13-2200-codex-abc123')
    })
  })

  test('search filters by --file, --tag and --about without a query, pages with --offset and lists --around an id', async () => {
    await withBrain(async ({ repo }) => {
      const write = async (title: string, ...extra: string[]) => JSON.parse((await cli(['mem', 'write', '--cwd', repo, '--type', 'gotcha', '--title', title, '--summary', 's', '--body', 'b', '--json', ...extra])).out).id as string
      const a = await write('The store waits fifteen seconds for its lock', '--source', 'src/memory/store.ts:121', '--tag', 'locks')
      const b = await write('Reflect keeps an undo journal per run', '--source', 'src/memory/reflect.ts', '--about', 'CortexDB')
      const byFile = await cli(['mem', 'search', '--cwd', repo, '--file', 'src/memory/store.ts', '--json'])
      expect(byFile.code).toBe(0)
      expect((JSON.parse(byFile.out) as Array<{ id: string }>).map(r => r.id)).toEqual([a])
      const folder = await cli(['mem', 'search', '--cwd', repo, '--file', 'src/memory', '--limit', '1'])
      expect(folder.out).toContain(', 1-1 of 2.')
      expect(folder.out).toContain('More with offset 1.')
      expect((await cli(['mem', 'search', '--cwd', repo, '--file', 'src/memory', '--limit', '1', '--offset', '1'])).out).toContain(', 2-2 of 2.')
      expect((await cli(['mem', 'search', '--cwd', repo, '--tag', 'locks'])).out).toContain(a)
      expect((await cli(['mem', 'search', '--cwd', repo, '--about', 'cortexdb'])).out).toContain(b)
      const near = await cli(['mem', 'search', '--cwd', repo, '--around', a, '--depth', '1'])
      expect(near.out).toContain(`recorded around ${a}`)
      expect(near.out).toContain(b)
      const bad = await cli(['mem', 'search', '--cwd', repo, '--file', '../elsewhere.ts'])
      expect(bad.code).toBe(1)
      expect(bad.err).toContain('not a repository path')
      expect((await cli(['mem', 'search', '--cwd', repo])).code).toBe(1)
    })
  })

  test('start and finalize honor BURACLE_NO_CAPTURE=1 (exit 0, nothing recorded)', async () => {
    await withBrain(async ({ repo }) => {
      expect(await cli(['mem', 'start', '--harness', 'codex', '--session', 'abc-123', '--cwd', repo])).toMatchObject({ code: 0, out: 'skipped: capture-off\n' })
      expect(await cli(['mem', 'finalize', '--harness', 'codex', '--session', 'abc-123'])).toMatchObject({ code: 0, out: 'skipped: capture-off\n' })
      expect(await cli(['mem', 'finalize', '--harness', 'codex', '--session', 'abc-123', '--detach'])).toMatchObject({ code: 0, out: 'skipped: capture-off (BURACLE_NO_CAPTURE=1)\n' })
    }, { capture: false })
  })

  test('without CortexDB the memory commands say how to install it', async () => {
    await withBrain(async ({ repo, root }) => {
      await withEnv({ BURACLE_CORTEXDB_BIN: `${root}/missing` }, async () => {
        const r = await cli(['mem', 'search', 'x', '--cwd', repo])
        expect(r.code).toBe(2)
        expect(r.err).toContain('buracle install')
        expect((await cli(['mem', 'context', '--cwd', repo])).out).toBe('')
      })
    })
  })
})

describe('buracle mcp', () => {
  test('usage and unknown servers', async () => {
    expect((await cli(['mcp'])).code).toBe(0)
    const r = await cli(['mcp', 'other'])
    expect(r.code).toBe(1)
    expect(r.err).toContain("unknown server 'other'")
  })
})
