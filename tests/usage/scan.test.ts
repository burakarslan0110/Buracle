import { describe, expect, test } from 'bun:test'
import { appendFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CursorStore } from '../../src/usage/scan'
import { cursorFile, emptyStore, loadStore, saveStore, scanFiles } from '../../src/usage/scan'
import { withSandbox } from '../helpers/sandbox'

interface Carry { lines: number; sum: number }

function parse(line: string, carry: Carry): void {
  const o = JSON.parse(line) as { n: number }
  carry.lines++
  carry.sum += o.n
}
const line = (n: number) => JSON.stringify({ n }) + '\n'

async function scan(store: CursorStore<Carry>, files: Array<{ path: string, order?: number, id?: string, compressed?: boolean }>, readCompressed?: (p: string) => Promise<Uint8Array | undefined>) {
  return scanFiles(store, {
    files: files.map((f, i) => ({ order: i, ...f })),
    parse,
    initCarry: () => ({ lines: 0, sum: 0 }),
    ...(readCompressed ? { readCompressed } : {}),
  })
}

describe('scanFiles', () => {
  test('reads only appended complete lines; a partial last line waits', () => withSandbox(async ({ root }) => {
    const f = join(root, 'a.jsonl')
    writeFileSync(f, line(10) + line(20))
    const store = emptyStore<Carry>('t')
    let s = await scan(store, [{ path: f }])
    expect(s).toMatchObject({ read: 1, reset: 0 })
    expect(store.files[f]?.carry).toEqual({ lines: 2, sum: 30 })

    appendFileSync(f, line(1) + '{"n":')
    await scan(store, [{ path: f }])
    expect(store.files[f]?.carry).toEqual({ lines: 3, sum: 31 })

    appendFileSync(f, '100}\n')
    await scan(store, [{ path: f }])
    expect(store.files[f]?.carry).toEqual({ lines: 4, sum: 131 })

    s = await scan(store, [{ path: f }])
    expect(s).toMatchObject({ read: 0 })
  }))

  test('a rewritten or truncated file is rescanned from scratch', () => withSandbox(async ({ root }) => {
    const f = join(root, 'a.jsonl')
    writeFileSync(f, line(10) + line(20))
    const store = emptyStore<Carry>('t')
    await scan(store, [{ path: f }])
    writeFileSync(f, line(10))
    let s = await scan(store, [{ path: f }])
    expect(s.reset).toBe(1)
    expect(store.files[f]?.carry).toEqual({ lines: 1, sum: 10 })
    writeFileSync(f, line(7) + line(9) + line(1))
    s = await scan(store, [{ path: f }])
    expect(s.reset).toBe(1)
    expect(store.files[f]?.carry).toEqual({ lines: 3, sum: 17 })
  }))

  test('a line the parser throws on is skipped; a file that is gone loses its cursor', () => withSandbox(async ({ root }) => {
    const f = join(root, 'a.jsonl')
    const g = join(root, 'b.jsonl')
    writeFileSync(f, line(1) + 'not json\n' + line(2))
    writeFileSync(g, line(5))
    const store = emptyStore<Carry>('t')
    await scan(store, [{ path: f }, { path: g }])
    expect(store.files[f]?.carry).toEqual({ lines: 2, sum: 3 })
    await scan(store, [{ path: f }])
    expect(Object.keys(store.files)).toEqual([f])
  }))

  test('compressed copies: skipped when their .jsonl was seen, else read through readCompressed', () => withSandbox(async ({ root }) => {
    const plain = join(root, 'r.jsonl')
    writeFileSync(plain, line(10))
    const store = emptyStore<Carry>('t')
    await scan(store, [{ path: plain }])
    rmSync(plain)
    const zst = join(root, 'r.jsonl.zst')
    writeFileSync(zst, 'compressed bytes')
    let calls = 0
    const reader = async () => { calls++; return new TextEncoder().encode(line(10)) }
    await scan(store, [{ path: zst, id: plain, compressed: true }], reader)
    expect(calls).toBe(0)
    expect(store.files[plain]?.carry).toEqual({ lines: 1, sum: 10 })
    const other = join(root, 's.jsonl.zst')
    writeFileSync(other, 'compressed bytes')
    await scan(store, [{ path: zst, id: plain, compressed: true }, { path: other, id: join(root, 's.jsonl'), compressed: true }], async () => { calls++; return new TextEncoder().encode(line(4)) })
    expect(calls).toBe(1)
    expect(store.files[join(root, 's.jsonl')]?.carry).toEqual({ lines: 1, sum: 4 })
  }))

  test('stores round-trip; foreign, older or broken stores start fresh', () => withSandbox(async ({ root }) => {
    const f = join(root, 'a.jsonl')
    writeFileSync(f, line(10))
    const store = emptyStore<Carry>('t')
    await scan(store, [{ path: f }])
    saveStore(store)
    expect(loadStore('t')).toEqual(JSON.parse(JSON.stringify(store)))
    expect(loadStore('other', cursorFile('t'))).toEqual(emptyStore('other'))
    writeFileSync(cursorFile('t'), JSON.stringify({ v: 1, collector: 't', files: {}, meta: {} }))
    expect(loadStore('t')).toEqual(emptyStore('t'))
    writeFileSync(cursorFile('t'), '{broken')
    expect(loadStore('t')).toEqual(emptyStore('t'))
  }))
})
