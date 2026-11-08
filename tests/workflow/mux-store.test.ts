import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tryLock } from '../../src/memory/lock'
import { listBoards } from '../../src/workflow/board-store'
import type { MuxRecord, MuxStore } from '../../src/workflow/mux-store'
import { addPanes, bindPane, findPane, muxStorePath, panesOf, readMuxStore, removeMuxStore, removePanes, updateMuxStore, writeMuxStore } from '../../src/workflow/mux-store'
import { withEnv, withSandbox } from '../helpers/sandbox'

const A: MuxRecord = { id: '%7', harness: 'claude', title: 'buracle rate-limit claude 1', server: '/tmp/tmux-501/default', pid: '4242', openedAt: 1 }
const B: MuxRecord = { id: '%8', harness: 'codex', title: 'buracle rate-limit codex 2', server: '/tmp/tmux-501/default', pid: '4243', openedAt: 2 }
const W1 = { harness: 'claude' as const, session: 'worker-1' }

function sandbox<T>(fn: (root: string) => Promise<T>): Promise<T> {
  return withSandbox(({ root }) => withEnv({ BURACLE_LOCK_TIMEOUT_MS: '200' }, () => fn(root)))
}

function store(panes: MuxRecord[] = []): MuxStore { return { v: 1, slug: 'rate-limit', mux: 'tmux', panes } }

describe('mux store path and shape', () => {
  test('the sidecar lives under board/mux and is never listed as a board; the slug is validated', () => sandbox(async root => {
    const common = join(root, '.git')
    const path = muxStorePath(common, 'rate-limit')
    expect(path).toBe(join(common, 'buracle', 'board', 'mux', 'rate-limit.json'))
    writeMuxStore(path, store([A]))
    expect(listBoards(common)).toEqual([])
    expect(() => muxStorePath(common, 'Bad Slug')).toThrow()
  }))

  test('readMuxStore is undefined for a missing, broken or foreign file and drops panes with a bad id or no server', () => sandbox(async root => {
    const path = join(root, 'mux', 'rate-limit.json')
    expect(readMuxStore(path)).toBeUndefined()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '{not json')
    expect(readMuxStore(path)).toBeUndefined()
    writeFileSync(path, JSON.stringify({ v: 2, slug: 'rate-limit', mux: 'tmux', panes: [] }))
    expect(readMuxStore(path)).toBeUndefined()
    writeFileSync(path, JSON.stringify({ v: 1, slug: 'rate-limit', mux: 'screen', panes: [] }))
    expect(readMuxStore(path)).toBeUndefined()
    writeFileSync(path, JSON.stringify(store([A, { ...B, id: '-t' }, { ...B, id: '%9', server: '' }, { ...B, id: 'w1:p1' }])))
    expect(readMuxStore(path)).toEqual(store([A]))
    const herdr: MuxStore = { v: 1, slug: 's', mux: 'herdr', panes: [{ id: 'w2:p5', harness: 'omp', title: 't', server: '/s.sock', openedAt: 3, session: W1 }] }
    writeFileSync(path, JSON.stringify(herdr))
    expect(readMuxStore(path)).toEqual(herdr)
  }))
})

describe('mux store updates', () => {
  test('addPanes creates the store, bindPane binds a known id (also through ids), removePanes and panesOf work; the file round-trips', () => sandbox(async root => {
    const path = join(root, 'mux', 'rate-limit.json')
    const added = updateMuxStore(path, s => addPanes(s, { slug: 'rate-limit', mux: 'tmux' }, [A, B]))
    expect(added).toMatchObject({ ok: true })
    expect(readMuxStore(path)).toEqual(store([A, B]))

    const bound = updateMuxStore(path, s => {
      if (s === undefined) return undefined
      const r = bindPane(s, '%8', W1)
      expect(r.bound).toBe(true)
      expect(bindPane(s, '%99', W1).bound).toBe(false)
      return r.store
    })
    expect(bound).toMatchObject({ ok: true })
    const after = readMuxStore(path)
    expect(after?.panes[1]).toEqual({ ...B, session: W1 })
    expect(panesOf(after as MuxStore, W1).map(p => p.id)).toEqual(['%8'])
    expect(panesOf(after as MuxStore, { harness: 'omp', session: 'x' })).toEqual([])
    expect(findPane(after as MuxStore, '%7')?.title).toBe(A.title)

    const cm = store([{ id: 'aaaaaaaa-0000-4000-8000-000000000004', ids: ['pane:3', 'surface:4', 'aaaaaaaa-0000-4000-8000-000000000004'], harness: 'claude', title: 't', server: 'cmux', openedAt: 1 }])
    expect(bindPane({ ...cm, mux: 'cmux' }, 'surface:4', W1).bound).toBe(true)
    expect(findPane({ ...cm, mux: 'cmux' }, 'pane:3')?.id).toBe('aaaaaaaa-0000-4000-8000-000000000004')

    const removed = updateMuxStore(path, s => (s === undefined ? undefined : removePanes(s, ['%7'])))
    expect(removed).toMatchObject({ ok: true })
    expect(readMuxStore(path)?.panes.map(p => p.id)).toEqual(['%8'])
    expect(JSON.parse(readFileSync(path, 'utf8')).v).toBe(1)
  }))

  test('addPanes keeps the multiplexer of a store that still has panes and takes the new one when the store is empty', () => {
    const empty: MuxStore = { v: 1, slug: 'rate-limit', mux: 'herdr', panes: [] }
    expect(addPanes(empty, { slug: 'rate-limit', mux: 'tmux' }, [A]).mux).toBe('tmux')
    const full: MuxStore = { ...empty, panes: [{ ...A, id: 'w2:p1' }] }
    expect(addPanes(full, { slug: 'rate-limit', mux: 'tmux' }, [A]).mux).toBe('herdr')
  })

  test('a held lock makes updateMuxStore return locked without touching the file; a released lock lets it through', () => sandbox(async root => {
    const path = join(root, 'mux', 'rate-limit.json')
    writeMuxStore(path, store([A]))
    const release = tryLock(`${path}.lock`)
    expect(release).toBeDefined()
    try {
      const r = updateMuxStore(path, s => (s === undefined ? undefined : removePanes(s, ['%7'])))
      expect(r).toMatchObject({ ok: false, code: 'locked' })
      expect(readMuxStore(path)).toEqual(store([A]))
    } finally {
      release?.()
    }
    const r2 = updateMuxStore(path, s => (s === undefined ? undefined : removePanes(s, ['%7'])))
    expect(r2).toMatchObject({ ok: true })
    expect(readMuxStore(path)?.panes).toEqual([])
  }))

  test('removeMuxStore deletes the file and its lock and is quiet when nothing is there; an unreadable file is left alone by updates', () => sandbox(async root => {
    const path = join(root, 'mux', 'rate-limit.json')
    writeMuxStore(path, store([A]))
    writeFileSync(`${path}.lock`, '{}')
    removeMuxStore(path)
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.lock`)).toBe(false)
    removeMuxStore(path)
    writeFileSync(path, '{broken')
    const r = updateMuxStore(path, s => addPanes(s, { slug: 'rate-limit', mux: 'tmux' }, [A]))
    expect(r).toMatchObject({ ok: false, code: 'unreadable' })
    expect(readFileSync(path, 'utf8')).toBe('{broken')
  }))
})
