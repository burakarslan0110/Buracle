import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CommandIO } from '../../src/cli/router'
import { runDiagram, usage } from '../../src/cli/commands/diagram'
import { withSandbox } from '../helpers/sandbox'

const FLOW = 'flowchart LR\n  A[Kurulum başlar] --> B[İnceleme sayfası]\n'

interface FakeIO { io: CommandIO, out(): string, err(): string, stdinRead(): boolean }

function fakeIO(stdin: string, opts: { tty?: boolean, json?: boolean } = {}): FakeIO {
  let out = ''
  let err = ''
  let read = false
  const io: CommandIO = {
    stdout: { write: (s: string) => { out += s } },
    stderr: { write: (s: string) => { err += s } },
    stdin: { isTTY: opts.tty === true, text: async () => { read = true; return stdin } },
    flags: { json: opts.json === true, verbose: false },
  }
  return { io, out: () => out, err: () => err, stdinRead: () => read }
}

async function call(argv: string[], stdin = '', opts: { tty?: boolean, json?: boolean, cwd?: string } = {}): Promise<{ code: number, out: string, err: string, stdinRead: boolean }> {
  const f = fakeIO(stdin, opts)
  const code = await runDiagram(argv, f.io, { cwd: opts.cwd ?? process.cwd(), now: Date.now(), env: process.env })
  return { code, out: f.out(), err: f.err(), stdinRead: f.stdinRead() }
}

describe('buracle diagram', () => {
  test('draws Mermaid from stdin as box drawing on stdout and exits 0', async () => {
    const r = await call([], FLOW)
    expect(r.code).toBe(0)
    expect(r.out).toContain('│ Kurulum başlar ├')
    expect(r.out.endsWith('\n')).toBe(true)
    expect(r.err).toBe('')
  })

  test('reads a file relative to the working directory, and - means stdin', async () => {
    await withSandbox(async sb => {
      writeFileSync(join(sb.home, 'flow.mmd'), FLOW)
      const fromStdin = await call([], FLOW)
      const fromFile = await call(['flow.mmd'], '', { cwd: sb.home })
      expect(fromFile.code).toBe(0)
      expect(fromFile.out).toBe(fromStdin.out)
      expect(fromFile.stdinRead).toBe(false)
      const dash = await call(['-'], FLOW, { cwd: sb.home })
      expect(dash.out).toBe(fromStdin.out)
      const missing = await call(['nope.mmd'], '', { cwd: sb.home })
      expect(missing.code).toBe(1)
      expect(missing.out).toBe('')
      expect(missing.err).toStartWith('buracle diagram: cannot read nope.mmd: ')
    })
  })

  test('with no file and a terminal on stdin it stops at once with a usage error', async () => {
    const r = await call([], '', { tty: true })
    expect(r.code).toBe(1)
    expect(r.stdinRead).toBe(false)
    expect(r.err).toContain('buracle diagram:')
  })

  test('a source the library rejects prints no drawing, the error on stderr, and exits 1', async () => {
    const r = await call([], 'gantt\n  title A\n')
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toStartWith('buracle diagram: Invalid mermaid header')
  })

  test('a source with a valid header but a dangling edge draws in part and exits 0', async () => {
    const r = await call([], 'flowchart TD\n  A --> \n')
    expect(r.code).toBe(0)
    expect(r.out).toContain('│ A │')
  })

  test('warns on stderr above 100 columns and keeps exit 0; exactly 100 columns gives no warning', async () => {
    const node = (n: number) => `flowchart LR\n  A[${'x'.repeat(n)}]\n`
    const at100 = await call(['--json'], node(96), { json: true })
    expect((JSON.parse(at100.out) as { width: number }).width).toBe(100)
    expect(at100.err).toBe('')
    const wide = await call([], node(97))
    expect(wide.code).toBe(0)
    expect(wide.out).toContain('x'.repeat(97))
    expect(wide.err).toBe('buracle diagram: warning: the drawing is 101 columns wide (over 100); a top-down layout (flowchart TD) is narrower\n')
  })

  test('--ascii prints ASCII only, an unknown flag exits 1, and --json reports the drawing', async () => {
    const ascii = await call(['--ascii'], 'flowchart LR\n  A[Start] --> B[Done]\n')
    expect(ascii.code).toBe(0)
    expect([...ascii.out].every(ch => (ch.codePointAt(0) ?? 0) < 128)).toBe(true)
    const bad = await call(['--wide'], FLOW)
    expect(bad.code).toBe(1)
    expect(bad.err).toContain('unknown option --wide')
    const json = await call(['--json'], FLOW, { json: true })
    expect(json.code).toBe(0)
    const data = JSON.parse(json.out) as { ok: boolean, text: string, width: number, warnings: string[] }
    expect(data).toMatchObject({ ok: true, warnings: [] })
    expect(data.text).toContain('Kurulum başlar')
    expect(data.width).toBeGreaterThan(10)
  })

  test('a drawing that does not finish in 5 s exits 1 with the time limit and the advice to split it', async () => {
    let src = 'flowchart TD\n'
    for (let i = 0; i < 30; i++) src += `  N${i} --> N${i + 1}\n`
    const t0 = performance.now()
    const r = await call([], src)
    expect(performance.now() - t0).toBeLessThan(7000)
    expect(r.code).toBe(1)
    expect(r.out).toBe('')
    expect(r.err).toContain('did not finish within 5 s')
    expect(r.err).toContain('split')
  }, 15_000)

  test('the help names the five diagram types and what counts as invalid', () => {
    expect(usage).toContain('buracle diagram')
    for (const word of ['flowchart', 'sequenceDiagram', 'stateDiagram-v2', 'classDiagram', 'erDiagram', '--ascii', 'in part']) expect(usage).toContain(word)
  })
})
