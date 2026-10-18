import { describe, expect, test } from 'bun:test'
import { appendFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CursorStore, UsageEvent } from '../../src/usage/scan'
import { aggregateMonth, cursorFile, emptyStore, loadStore, saveStore, scanFiles } from '../../src/usage/scan'
import { withSandbox } from '../helpers/sandbox'

const NOW = Date.parse('2026-10-08T09:00:00.000Z')

function parse(line: string, carry: { lines: number }): UsageEvent[] | undefined {
  const o = JSON.parse(line) as { ts: string, model: string, key?: string, in: number, out: number, cost?: number, fb?: boolean }
  carry.lines++
  const ev: UsageEvent = { ts: Date.parse(o.ts), model: o.model, input: o.in, output: o.out, cacheRead: 0, cacheWrite: 0 }
  if (o.key !== undefined) ev.key = o.key
  if (o.cost !== undefined) ev.costUsd = o.cost
  if (o.fb) ev.fallback = true
  return [ev]
}
const line = (o: Record<string, unknown>) => JSON.stringify({ ts: '2026-10-05T10:00:00Z', model: 'm', in: 1, out: 1, ...o }) + '\n'
const PRICING = { m: { input: 1, output: 1 } }

async function scan(store: CursorStore<{ lines: number }>, files: Array<{ path: string, order?: number, id?: string, compressed?: boolean }>, readCompressed?: (p: string) => Promise<Uint8Array | undefined>) {
  return scanFiles(store, {
    files: files.map((f, i) => ({ order: i, ...f })),
    parse,
    initCarry: () => ({ lines: 0 }),
    nowMs: NOW,
    ...(readCompressed ? { readCompressed } : {}),
  })
}

describe('scanFiles', () => {
  test('reads only appended complete lines; a partial last line waits', () => withSandbox(async ({ root }) => {
    const f = join(root, 'a.jsonl')
    writeFileSync(f, line({ key: 'k1', in: 10, out: 5 }) + line({ key: 'k2', in: 20, out: 5 }))
    const store = emptyStore<{ lines: number }>('t')
    let s = await scan(store, [{ path: f }])
    expect(s).toMatchObject({ read: 1, events: 2, reset: 0 })
    expect(store.files[f]?.carry.lines).toBe(2)
    expect(aggregateMonth(store, '2026-10', PRICING)).toEqual({ tokens: 40, usd: 0.00004, byModel: { m: { tokens: 40, usd: 0.00004 } } })

    appendFileSync(f, line({ key: 'k3', in: 1, out: 1 }) + '{"ts":"2026-10-05T10:00:00Z","model":"m","in":100,')
    s = await scan(store, [{ path: f }])
    expect(s.events).toBe(1)
    expect(store.files[f]?.carry.lines).toBe(3)

    appendFileSync(f, '"out":0}\n')
    s = await scan(store, [{ path: f }])
    expect(s.events).toBe(1)
    expect(aggregateMonth(store, '2026-10', PRICING).tokens).toBe(142)

    s = await scan(store, [{ path: f }])
    expect(s).toMatchObject({ read: 0, events: 0 })
  }))

  test('a rewritten or truncated file is rescanned from scratch', () => withSandbox(async ({ root }) => {
    const f = join(root, 'a.jsonl')
    writeFileSync(f, line({ key: 'k1', in: 10, out: 0 }) + line({ key: 'k2', in: 20, out: 0 }))
    const store = emptyStore<{ lines: number }>('t')
    await scan(store, [{ path: f }])
    writeFileSync(f, line({ key: 'k1', in: 10, out: 0 }))
    let s = await scan(store, [{ path: f }])
    expect(s.reset).toBe(1)
    expect(aggregateMonth(store, '2026-10', PRICING).tokens).toBe(10)
    writeFileSync(f, line({ key: 'x1', in: 7, out: 0 }) + line({ key: 'x2', in: 9, out: 0 }) + line({ key: 'x3', in: 1, out: 0 }))
    s = await scan(store, [{ path: f }])
    expect(s.reset).toBe(1)
    expect(aggregateMonth(store, '2026-10', PRICING).tokens).toBe(17)
  }))

  test('keys deduplicate across files; the earlier file owns them', () => withSandbox(async ({ root }) => {
    const a = join(root, 'a.jsonl')
    const b = join(root, 'b.jsonl')
    writeFileSync(a, line({ key: 'k1', in: 10, out: 0 }) + line({ key: 'k1', in: 10, out: 0 }) + line({ in: 1, out: 0 }))
    writeFileSync(b, line({ key: 'k1', in: 10, out: 0 }) + line({ key: 'k2', in: 5, out: 0 }) + line({ in: 1, out: 0 }))
    const store = emptyStore<{ lines: number }>('t')
    await scan(store, [{ path: b, order: 2 }, { path: a, order: 1 }])
    expect(store.files[a]?.keys['2026-10']).toEqual(['k1'])
    expect(store.files[b]?.keys['2026-10']).toEqual(['k2'])
    expect(aggregateMonth(store, '2026-10', PRICING).tokens).toBe(10 + 1 + 5 + 1)
  }))

  test('vanished files keep their totals until they age out', () => withSandbox(async ({ root }) => {
    const a = join(root, 'a.jsonl')
    writeFileSync(a, line({ key: 'k1', in: 10, out: 0 }))
    const store = emptyStore<{ lines: number }>('t')
    await scan(store, [{ path: a }])
    rmSync(a)
    await scan(store, [])
    expect(aggregateMonth(store, '2026-10', PRICING).tokens).toBe(10)
    const moved = join(root, 'moved.jsonl')
    writeFileSync(moved, line({ key: 'k1', in: 10, out: 0 }))
    await scan(store, [{ path: moved }])
    expect(aggregateMonth(store, '2026-10', PRICING).tokens).toBe(10)
  }))

  test('months are bucketed in local time and old data is pruned', () => withSandbox(async ({ root }) => {
    const f = join(root, 'a.jsonl')
    writeFileSync(f, line({ ts: '2026-09-15T12:00:00Z', key: 'sep', in: 3, out: 0 }) + line({ ts: '2025-01-15T12:00:00Z', key: 'old', in: 99, out: 0 }) + line({ key: 'oct', in: 4, out: 0 }))
    const store = emptyStore<{ lines: number }>('t')
    await scan(store, [{ path: f }])
    expect(aggregateMonth(store, '2026-09', PRICING).tokens).toBe(3)
    expect(aggregateMonth(store, '2026-10', PRICING).tokens).toBe(4)
    expect(aggregateMonth(store, '2025-01', PRICING).tokens).toBe(0)
    expect(Object.keys(store.files[f]?.keys ?? {}).sort()).toEqual(['2026-09', '2026-10'])
  }))

  test('reported cost wins over list prices; unknown models stay unpriced', () => withSandbox(async ({ root }) => {
    const f = join(root, 'a.jsonl')
    writeFileSync(f, line({ key: 'a', in: 1_000_000, out: 0, cost: 0.5 }) + line({ key: 'b', in: 1_000_000, out: 0 }) + line({ key: 'c', model: 'other', in: 10, out: 0 }))
    const store = emptyStore<{ lines: number }>('t')
    await scan(store, [{ path: f }])
    expect(aggregateMonth(store, '2026-10', PRICING)).toEqual({
      tokens: 2_000_010,
      usd: 1.5,
      byModel: { m: { tokens: 2_000_000, usd: 1.5 }, other: { tokens: 10 } },
    })
    expect(aggregateMonth(store, '2026-10', {}).usd).toBe(0.5)
  }))

  test('fallback events count only for files without primary events', () => withSandbox(async ({ root }) => {
    const a = join(root, 'a.jsonl')
    const b = join(root, 'b.jsonl')
    writeFileSync(a, line({ fb: true, key: 'c1', in: 5, out: 0 }) + line({ key: 'r1', in: 50, out: 0 }))
    writeFileSync(b, line({ fb: true, key: 'c2', in: 7, out: 0 }) + line({ fb: true, key: 'c3', in: 3, out: 0 }))
    const store = emptyStore<{ lines: number }>('t')
    await scan(store, [{ path: a }, { path: b }])
    expect(aggregateMonth(store, '2026-10', PRICING).tokens).toBe(50 + 10)
  }))

  test('compressed copies: skipped when their .jsonl was seen, else read through readCompressed', () => withSandbox(async ({ root }) => {
    const plain = join(root, 'r.jsonl')
    writeFileSync(plain, line({ key: 'k1', in: 10, out: 0 }))
    const store = emptyStore<{ lines: number }>('t')
    await scan(store, [{ path: plain }])
    rmSync(plain)
    const zst = join(root, 'r.jsonl.zst')
    writeFileSync(zst, 'compressed bytes')
    let calls = 0
    const reader = async () => { calls++; return new TextEncoder().encode(line({ key: 'k1', in: 10, out: 0 })) }
    await scan(store, [{ path: zst, id: plain, compressed: true }], reader)
    expect(calls).toBe(0)
    expect(aggregateMonth(store, '2026-10', PRICING).tokens).toBe(10)
    const other = join(root, 's.jsonl.zst')
    writeFileSync(other, 'compressed bytes')
    await scan(store, [{ path: zst, id: plain, compressed: true }, { path: other, id: join(root, 's.jsonl'), compressed: true }], async () => { calls++; return new TextEncoder().encode(line({ key: 'k9', in: 4, out: 0 })) })
    expect(calls).toBe(1)
    expect(aggregateMonth(store, '2026-10', PRICING).tokens).toBe(14)
  }))

  test('stores round-trip; foreign or broken stores start fresh', () => withSandbox(async ({ root }) => {
    const f = join(root, 'a.jsonl')
    writeFileSync(f, line({ key: 'k1', in: 10, out: 0 }))
    const store = emptyStore<{ lines: number }>('t')
    await scan(store, [{ path: f }])
    saveStore(store)
    expect(loadStore('t')).toEqual(JSON.parse(JSON.stringify(store)))
    expect(loadStore('other', cursorFile('t'))).toEqual(emptyStore('other'))
    writeFileSync(cursorFile('t'), '{broken')
    expect(loadStore('t')).toEqual(emptyStore('t'))
  }))
})
