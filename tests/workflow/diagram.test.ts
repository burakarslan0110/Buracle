import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { diagramSvgs, drawDiagrams } from '../../src/workflow/diagram'
import { withSandbox } from '../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..')

const SOURCES: Record<string, string> = {
  flowchart: 'flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]\n  B -->|no| A',
  sequence: 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi',
  state: 'stateDiagram-v2\n  [*] --> Open\n  Open --> Closed: last session ends\n  Closed --> Open: session starts',
  class: 'classDiagram\n  class Animal {\n    +name: string\n    +speak()\n  }\n  Animal <|-- Dog',
  er: 'erDiagram\n  USER ||--o{ ORDER : places\n  ORDER ||--|{ LINE : contains',
}

// Every batch starts a fresh worker that first imports the library, so a limit of 1 ms always
// passes before the first reply: that is how the tests exercise the time limit with a real worker.
function flow(label: string): string {
  return `flowchart TD\n  ${label}0 --> ${label}1\n  ${label}1 --> ${label}2`
}

async function svg(source: string): Promise<string> {
  const [r] = await diagramSvgs([source])
  if (r === undefined || !r.ok) throw new Error(`expected a drawing, got: ${r === undefined ? 'nothing' : r.error}`)
  return r.light
}

function cpuMs(since: NodeJS.CpuUsage): number {
  const d = process.cpuUsage(since)
  return (d.user + d.system) / 1000
}

describe('diagramSvgs: Mermaid to SVG for the review page', () => {
  test('draws the five supported diagram types as a light and a dark SVG with the page colors and no script', async () => {
    for (const [kind, source] of Object.entries(SOURCES)) {
      const [r] = await diagramSvgs([source])
      expect(r?.ok, kind).toBe(true)
      if (r === undefined || !r.ok) continue
      for (const out of [r.light, r.dark]) {
        expect(out.startsWith('<svg'), kind).toBe(true)
        expect(out, kind).not.toContain('<script')
      }
      expect(r.light, kind).toContain('#111827')
      expect(r.dark, kind).toContain('#e7edf5')
    }
  })

  test('an empty source and an unsupported header fail with the library message', async () => {
    for (const source of ['', '   \n\t\n']) {
      const [r] = await diagramSvgs([source])
      expect(r?.ok).toBe(false)
    }
    const [gantt] = await diagramSvgs(['gantt\n  title A\n  section S\n  Task :a1, 2024-01-01, 30d'])
    expect(gantt?.ok).toBe(false)
    if (gantt !== undefined && !gantt.ok) expect(gantt.error).toContain('Invalid mermaid header')
  })

  test('a fenced block, a header ending in ";" and CRLF line ends draw like the plain source', async () => {
    const plain = await svg(SOURCES['flowchart'] as string)
    expect(await svg('```mermaid\n' + SOURCES['flowchart'] + '\n```\n')).toBe(plain)
    expect(await svg((SOURCES['flowchart'] as string).replace('flowchart TD', 'flowchart TD;'))).toBe(plain)
    expect(await svg((SOURCES['flowchart'] as string).replace(/\n/g, '\r\n'))).toBe(plain)
  })

  test('Turkish labels stay intact in the drawing', async () => {
    const out = await svg('flowchart LR\n  A[Kurulum başlar] --> B[İnceleme sayfası] --> C[ışık ğüşöç]')
    for (const label of ['Kurulum başlar', 'İnceleme sayfası', 'ışık ğüşöç']) expect(out).toContain(label)
  })

  test('a source over 20000 characters fails without being drawn and names the limit, a huge one at once', async () => {
    const [r] = await diagramSvgs(['flowchart TD\n' + '  A --> B\n'.repeat(2500)])
    expect(r?.ok).toBe(false)
    if (r !== undefined && !r.ok) expect(r.error).toContain('20000')
    const t0 = performance.now()
    const [huge] = await diagramSvgs(['flowchart TD' + ' '.repeat(5_000_000) + 'x'])
    expect(performance.now() - t0).toBeLessThan(200)
    expect(huge).toMatchObject({ ok: false, reason: 'too_large' })
  })

  test('a worker that cannot load the library fails at once with the reason, not as a timeout', async () => {
    await withSandbox(async ({ root }) => {
      const copy = join(root, 'nolib')
      for (const rel of ['src/workflow/diagram.ts', 'src/workflow/diagram-worker.ts']) {
        mkdirSync(dirname(join(copy, rel)), { recursive: true })
        copyFileSync(join(REPO, rel), join(copy, rel))
      }
      const mod = await import(join(copy, 'src/workflow/diagram.ts')) as typeof import('../../src/workflow/diagram')
      const t0 = performance.now()
      const [r] = await mod.diagramSvgs(['flowchart TD\n  A --> B'])
      expect(performance.now() - t0).toBeLessThan(2000)
      expect(r).toMatchObject({ ok: false, reason: 'worker' })
      if (r !== undefined && !r.ok) {
        expect(r.error).toContain('cannot load beautiful-mermaid')
        expect(r.error).not.toContain('did not finish')
      }
    })
  })

  test('an invalid source gets an error and the valid one next to it still draws', async () => {
    const out = await diagramSvgs(['pie title Pets\n  "Dogs" : 386', SOURCES['sequence'] as string])
    expect(out.map(r => r.ok)).toEqual([false, true])
    const bad = out[0]
    if (bad !== undefined && !bad.ok) expect(bad.error).toContain('Invalid mermaid header')
  })
})

describe('drawDiagrams: time limit, budget and cache', () => {
  test('a job whose limit passes fails with a timeout, its worker stops, and the next batch draws', async () => {
    const t0 = performance.now()
    const [r] = await drawDiagrams([flow('T')], { kind: 'svg', timeoutMs: 1 })
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(r?.ok).toBe(false)
    if (r !== undefined && !r.ok) expect(r.error).toContain('did not finish within')
    const since = process.cpuUsage()
    await Bun.sleep(500)
    expect(cpuMs(since)).toBeLessThan(300)
    expect((await diagramSvgs([flow('T2')]))[0]?.ok).toBe(true)
  }, 10_000)

  test('the total budget turns the rest into a budget error, which is not cached', async () => {
    const out = await drawDiagrams([flow('S'), flow('S2')], { kind: 'svg', timeoutMs: 1000, totalMs: 1 })
    expect(out.map(r => r.ok)).toEqual([false, false])
    for (const r of out) if (!r.ok) expect(r.error).toContain('drawing budget')
    const again = await diagramSvgs([flow('S2')])
    expect(again[0]?.ok).toBe(true)
  }, 15_000)

  test('a timeout under a short limit is not the answer for a call with a longer limit', async () => {
    const src = flow('W')
    const [short] = await drawDiagrams([src], { kind: 'svg', timeoutMs: 1 })
    expect(short?.ok).toBe(false)
    if (short !== undefined && !short.ok) expect(short.error).toContain('within 0 s')
    const [long] = await diagramSvgs([src])
    expect(long?.ok).toBe(true)
  }, 15_000)

  test('a repeated timed-out source comes from the cache, and two calls at once draw it once', async () => {
    const src = flow('V')
    const t0 = performance.now()
    const [a, b] = await Promise.all([
      drawDiagrams([src], { kind: 'svg', timeoutMs: 1 }),
      drawDiagrams([src], { kind: 'svg', timeoutMs: 1 }),
    ])
    expect(performance.now() - t0).toBeLessThan(1800)
    expect(a[0]?.ok).toBe(false)
    expect(b[0]?.ok).toBe(false)
    const t1 = performance.now()
    const c = await drawDiagrams([src], { kind: 'svg', timeoutMs: 1 })
    expect(performance.now() - t1).toBeLessThan(100)
    expect(c[0]?.ok).toBe(false)
  }, 15_000)
})
