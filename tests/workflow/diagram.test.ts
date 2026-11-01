import { describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { textWidth } from '../../src/core/status/format'
import { diagramSvgs, drawDiagram, drawDiagrams } from '../../src/workflow/diagram'
import { withSandbox } from '../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..')

// beautiful-mermaid 1.1.3's text renderer stalls once a chain reaches about 25 boxes (24 draws in a
// few ms); these sources exercise the time limit with a real input instead of a test hook.
function chain(n: number, dir = 'TD', prefix = 'N'): string {
  let s = `flowchart ${dir}\n`
  for (let i = 0; i < n; i++) s += `  ${prefix}${i} --> ${prefix}${i + 1}\n`
  return s
}

const SOURCES: Record<string, string> = {
  flowchart: 'flowchart TD\n  A[Start] --> B{Ok?}\n  B -->|yes| C[Done]\n  B -->|no| A',
  sequence: 'sequenceDiagram\n  Alice->>Bob: Hello\n  Bob-->>Alice: Hi',
  state: 'stateDiagram-v2\n  [*] --> Open\n  Open --> Closed: last session ends\n  Closed --> Open: session starts',
  class: 'classDiagram\n  class Animal {\n    +name: string\n    +speak()\n  }\n  Animal <|-- Dog',
  er: 'erDiagram\n  USER ||--o{ ORDER : places\n  ORDER ||--|{ LINE : contains',
}

const ANSI = /\u001b\[/

async function text(source: string, ascii = false): Promise<string> {
  const r = await drawDiagram(source, { ascii })
  if (!r.ok) throw new Error(`expected a drawing, got: ${r.error}`)
  return r.text
}

function cpuMs(since: NodeJS.CpuUsage): number {
  const d = process.cpuUsage(since)
  return (d.user + d.system) / 1000
}

describe('drawDiagram: Mermaid to text', () => {
  test('draws the five supported diagram types as box drawing without ANSI codes', async () => {
    for (const [kind, source] of Object.entries(SOURCES)) {
      const r = await drawDiagram(source, {})
      expect(r.ok, kind).toBe(true)
      if (!r.ok) continue
      expect(r.text, kind).toMatch(/[┌│─]/u)
      expect(ANSI.test(r.text), kind).toBe(false)
    }
  })

  test('--ascii output holds ASCII characters only', async () => {
    for (const source of Object.values(SOURCES)) {
      const out = await text(source, true)
      expect([...out].every(ch => (ch.codePointAt(0) ?? 0) < 128)).toBe(true)
    }
  })

  test('an empty source and an unsupported header fail with the library message', async () => {
    for (const source of ['', '   \n\t\n']) {
      const r = await drawDiagram(source, {})
      expect(r.ok).toBe(false)
    }
    const gantt = await drawDiagram('gantt\n  title A\n  section S\n  Task :a1, 2024-01-01, 30d', {})
    expect(gantt.ok).toBe(false)
    if (!gantt.ok) expect(gantt.error).toContain('Invalid mermaid header')
  })

  test('a fenced block, a header ending in ";" and CRLF line ends draw like the plain source', async () => {
    const plain = await text(SOURCES['flowchart'] as string)
    expect(await text('```mermaid\n' + SOURCES['flowchart'] + '\n```\n')).toBe(plain)
    expect(await text((SOURCES['flowchart'] as string).replace('flowchart TD', 'flowchart TD;'))).toBe(plain)
    expect(await text((SOURCES['flowchart'] as string).replace(/\n/g, '\r\n'))).toBe(plain)
  })

  test('a source over 20000 characters fails without being drawn and names the limit, a huge one at once', async () => {
    const r = await drawDiagram('flowchart TD\n' + '  A --> B\n'.repeat(2500), {})
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('20000')
    const t0 = performance.now()
    const huge = await drawDiagram('flowchart TD' + ' '.repeat(5_000_000) + 'x', {})
    expect(performance.now() - t0).toBeLessThan(200)
    expect(huge).toMatchObject({ ok: false, reason: 'too_large' })
  })

  test('a worker that cannot load the library fails at once with the reason, not as a timeout', async () => {
    await withSandbox(async ({ root }) => {
      const copy = join(root, 'nolib')
      for (const rel of ['src/workflow/diagram.ts', 'src/workflow/diagram-worker.ts', 'src/core/status/format.ts']) {
        mkdirSync(dirname(join(copy, rel)), { recursive: true })
        copyFileSync(join(REPO, rel), join(copy, rel))
      }
      const mod = await import(join(copy, 'src/workflow/diagram.ts')) as typeof import('../../src/workflow/diagram')
      const t0 = performance.now()
      const r = await mod.drawDiagram('flowchart TD\n  A --> B', {})
      expect(performance.now() - t0).toBeLessThan(2000)
      expect(r).toMatchObject({ ok: false, reason: 'worker' })
      if (!r.ok) {
        expect(r.error).toContain('cannot load beautiful-mermaid')
        expect(r.error).not.toContain('did not finish')
      }
    })
  })

  test('width is the widest line, and Turkish labels keep every line the same width', async () => {
    const r = await drawDiagram('flowchart LR\n  A[Kurulum başlar] --> B[İnceleme sayfası] --> C[ışık ğüşöç]', {})
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const widths = r.text.split('\n').map(textWidth)
    expect(r.width).toBe(Math.max(...widths))
    expect(new Set(widths).size).toBe(1)
  })

  test('a drawing that stalls fails after the time limit, the stuck worker stops, and the next one draws', async () => {
    const t0 = performance.now()
    const r = await drawDiagram(chain(30), { timeoutMs: 500 })
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('did not finish within')
    const since = process.cpuUsage()
    await Bun.sleep(1000)
    expect(cpuMs(since)).toBeLessThan(300)
    expect((await drawDiagram(chain(5), {})).ok).toBe(true)
  }, 10_000)
})

// Limits of 1 s and more leave room for each fresh worker to import the library on a slow runner.
describe('drawDiagrams: one batch, one worker at a time', () => {
  test('only the stalled source fails; the sources after it draw in a fresh worker', async () => {
    const out = await drawDiagrams([chain(5, 'TD', 'P'), chain(30, 'TD', 'Q'), chain(5, 'TD', 'R')], { kind: 'text', timeoutMs: 1000 })
    expect(out.map(r => r.ok)).toEqual([true, false, true])
    const stalled = out[1]
    if (stalled !== undefined && !stalled.ok) expect(stalled.error).toContain('did not finish within')
  }, 15_000)

  test('the total budget turns the rest into a budget error, which is not cached', async () => {
    const out = await drawDiagrams([chain(30, 'TD', 'S'), chain(31, 'TD', 'S')], { kind: 'text', timeoutMs: 1000, totalMs: 1300 })
    expect(out.map(r => r.ok)).toEqual([false, false])
    const second = out[1]
    if (second !== undefined && !second.ok) expect(second.error).toContain('drawing budget')
    const skipped = chain(6, 'TD', 'T')
    const first = await drawDiagrams([chain(30, 'TD', 'U'), skipped], { kind: 'text', timeoutMs: 1000, totalMs: 1000 })
    expect(first[1]?.ok).toBe(false)
    const again = await drawDiagrams([skipped], { kind: 'text', timeoutMs: 1000 })
    expect(again[0]?.ok).toBe(true)
  }, 15_000)

  test("a timeout under a short limit is not the answer for a call with a longer limit", async () => {
    const src = chain(33, 'TD', 'W')
    const short = await drawDiagrams([src], { kind: 'text', timeoutMs: 400 })
    if (short[0] !== undefined && !short[0].ok) expect(short[0].error).toContain('within 0.4 s')
    const long = await drawDiagram(src, { timeoutMs: 1200 })
    expect(long.ok).toBe(false)
    if (!long.ok) expect(long.error).toContain('within 1.2 s')
  }, 15_000)

  test('a repeated stalled source comes from the cache, and two calls at once draw it once', async () => {
    const src = chain(32, 'TD', 'V')
    const t0 = performance.now()
    const [a, b] = await Promise.all([
      drawDiagrams([src], { kind: 'text', timeoutMs: 1000 }),
      drawDiagrams([src], { kind: 'text', timeoutMs: 1000 }),
    ])
    expect(performance.now() - t0).toBeLessThan(1800)
    expect(a[0]?.ok).toBe(false)
    expect(b[0]?.ok).toBe(false)
    const t1 = performance.now()
    const c = await drawDiagrams([src], { kind: 'text', timeoutMs: 1000 })
    expect(performance.now() - t1).toBeLessThan(100)
    expect(c[0]?.ok).toBe(false)
  }, 15_000)
})

describe('diagramSvgs: Mermaid to SVG for the review page', () => {
  test('draws a light and a dark SVG with the page colors and no script', async () => {
    const [r] = await diagramSvgs([SOURCES['flowchart'] as string])
    expect(r?.ok).toBe(true)
    if (r === undefined || !r.ok) return
    for (const svg of [r.light, r.dark]) {
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg).not.toContain('<script')
    }
    expect(r.light).toContain('#111827')
    expect(r.dark).toContain('#e7edf5')
  })

  test('an invalid source gets an error and the valid one next to it still draws', async () => {
    const out = await diagramSvgs(['pie title Pets\n  "Dogs" : 386', SOURCES['sequence'] as string])
    expect(out.map(r => r.ok)).toEqual([false, true])
    const bad = out[0]
    if (bad !== undefined && !bad.ok) expect(bad.error).toContain('Invalid mermaid header')
  })
})
