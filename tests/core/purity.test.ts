import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

const REPO = join(import.meta.dir, '..', '..')
const CORE = join(REPO, 'src', 'core')

const WORKER_GLOBALS = `
declare class TextEncoder { encode(input?: string): Uint8Array }
declare class TextDecoder { constructor(label?: string, options?: { fatal?: boolean, ignoreBOM?: boolean }); decode(input?: ArrayBufferView | ArrayBuffer, options?: { stream?: boolean }): string }
declare class URLSearchParams implements Iterable<[string, string]> {
  constructor(init?: string | Record<string, string> | Array<[string, string]>)
  get(name: string): string | null; getAll(name: string): string[]; has(name: string): boolean
  set(name: string, value: string): void; append(name: string, value: string): void; delete(name: string): void
  toString(): string; [Symbol.iterator](): IterableIterator<[string, string]>
}
declare class URL {
  constructor(url: string, base?: string | URL)
  href: string; origin: string; protocol: string; username: string; password: string; host: string; hostname: string
  port: string; pathname: string; search: string; hash: string; readonly searchParams: URLSearchParams
  toString(): string; toJSON(): string
}
declare class AbortSignal { readonly aborted: boolean; readonly reason: unknown }
declare class AbortController { readonly signal: AbortSignal; abort(reason?: unknown): void }
declare function atob(data: string): string
declare function btoa(data: string): string
declare function structuredClone<T>(value: T): T
declare const crypto: { readonly subtle: { digest(algorithm: string, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer> }; randomUUID(): string }
`

function tscWithoutRuntimeTypes(include: string[]): { code: number, output: string } {
  const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'buracle-core-tsc-')))
  try {
    writeFileSync(join(dir, 'worker-globals.d.ts'), WORKER_GLOBALS)
    include = [...include, join(dir, 'worker-globals.d.ts')]
    const tsconfig = join(dir, 'tsconfig.json')
    writeFileSync(tsconfig, JSON.stringify({
      compilerOptions: {
        target: 'es2023', lib: ['es2023'], module: 'esnext', moduleResolution: 'bundler', types: [],
        strict: true, noUncheckedIndexedAccess: true, jsx: 'react', jsxFactory: 'h', noEmit: true,
        skipLibCheck: true, verbatimModuleSyntax: true, isolatedModules: true,
      },
      include,
    }))
    const r = Bun.spawnSync([join(REPO, 'node_modules', '.bin', 'tsc'), '-p', tsconfig], { cwd: REPO, stdout: 'pipe', stderr: 'pipe' })
    return { code: r.exitCode ?? 1, output: `${r.stdout.toString()}${r.stderr.toString()}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function strip(src: string, blankStrings: boolean): string {
  let out = ''
  let i = 0
  const n = src.length
  const templates: number[] = []
  const readQuoted = (q: string) => {
    let j = i + 1
    while (j < n && src[j] !== q && src[j] !== '\n') { if (src[j] === '\\') j++; j++ }
    out += blankStrings ? q + ' '.repeat(Math.max(0, j - i - 1)) + q : src.slice(i, j + 1)
    i = j + 1
  }
  const readTemplateText = () => {
    let j = i
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue }
      if (src[j] === '`') break
      if (src[j] === '$' && src[j + 1] === '{') break
      j++
    }
    out += blankStrings ? ' '.repeat(j - i) : src.slice(i, j)
    if (j >= n) { i = n; return }
    if (src[j] === '`') { out += '`'; i = j + 1; templates.pop(); return }
    out += '${'
    i = j + 2
    templates[templates.length - 1] = 0
  }
  while (i < n) {
    const c = src[i] as string
    const d = src[i + 1]
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue }
    if (c === '"' || c === "'") { readQuoted(c); continue }
    if (c === '`') { out += '`'; i++; templates.push(0); readTemplateText(); continue }
    if (templates.length > 0) {
      if (c === '{') templates[templates.length - 1] = (templates[templates.length - 1] as number) + 1
      if (c === '}') {
        const depth = templates[templates.length - 1] as number
        if (depth === 0) { out += '}'; i++; readTemplateText(); continue }
        templates[templates.length - 1] = depth - 1
      }
    }
    out += c
    i++
  }
  return out
}

export function purityViolations(src: string): string[] {
  const withStrings = strip(src, false)
  const code = strip(src, true)
  const problems: string[] = []
  const specifiers: string[] = []
  for (const m of withStrings.matchAll(/\bimport\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"]+)['"]/g)) specifiers.push(m[1] as string)
  for (const m of withStrings.matchAll(/\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+['"]([^'"]+)['"]/g)) specifiers.push(m[1] as string)
  for (const m of withStrings.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1] as string)
  if (/\bimport\s*\(\s*[^'"\s)]/.test(withStrings)) problems.push('dynamic import with a computed specifier')
  for (const s of specifiers) if (!s.startsWith('./') && !s.startsWith('../')) problems.push(`non-relative import '${s}'`)
  const banned: Array<[RegExp, string]> = [
    [/\bprocess\s*[.[]/, 'process.'],
    [/\bBun\s*[.[]/, 'Bun.'],
    [/\brequire\s*\(/, 'require('],
    [/\b(?:setTimeout|setInterval|setImmediate|clearTimeout|clearInterval|clearImmediate)\b/, 'timer function'],
    [/\bBuffer\s*\./, 'Buffer.'],
    [/\bDate\.now\s*\(/, 'Date.now() (time must be a parameter)'],
    [/\bnew\s+Date\s*\(\s*\)/, 'new Date() (time must be a parameter)'],
    [/\bMath\.random\s*\(/, 'Math.random() (randomness must be a parameter)'],
    [/\bcrypto\s*\.\s*(?:randomUUID|getRandomValues)\s*\(/, 'crypto randomness (randomness must be a parameter)'],
    [/\bperformance\s*\.\s*now\s*\(/, 'performance.now()'],
  ]
  for (const [re, label] of banned) if (re.test(code)) problems.push(`uses ${label}`)
  for (const m of code.matchAll(/(\bnew\s+)?\bDate\s*\(/g)) {
    if (m[1] === undefined) { problems.push('uses Date() without new (time must be a parameter)'); break }
  }
  if (specifiers.some(s => /^(?:node:)?timers(?:\/promises)?$/.test(s))) problems.push('uses timers module')
  return problems
}

describe('core purity scanner', () => {
  test('accepts relative imports and pure code', () => {
    const ok = [
      "import type { Harness } from './events'",
      "import { HARNESSES } from '../events'",
      "export * from './policy/index'",
      "export { a as b } from './x'",
      '// process.env is mentioned only in a comment',
      '/* Bun.spawn in a block comment */',
      "const s = 'process.env inside a string is not code'",
      'const t = `Date.now() in template text ${x + 1} is fine`',
      'const d = new Date(input)',
      'const u = Date.UTC(2026, 0, 1) + toDate(x) + isDate(y)',
    ].join('\n')
    expect(purityViolations(ok)).toEqual([])
  })

  test('flags non-relative imports, IO globals, timers and ambient time', () => {
    const bad = [
      "import { readFileSync } from 'node:fs'",
      "import { parse } from 'yaml'",
      "export * from 'bun:sqlite'",
      "const m = await import('os')",
      'const e = process.env.HOME',
      "Bun.spawn(['ls'])",
      "const x = require('fs')",
      'setTimeout(() => {}, 1)',
      'const now = Date.now()',
      'const r = Math.random()',
      "const b = Buffer.from('x')",
      'const t = `${process.pid}`',
      'const id = crypto.randomUUID()',
      'const stamp = Date()',
    ].join('\n')
    const v = purityViolations(bad)
    for (const needle of ["'node:fs'", "'yaml'", "'bun:sqlite'", "'os'", 'process.', 'Bun.', 'require(', 'timer function', 'Date.now()', 'Math.random()', 'Buffer.', 'crypto randomness', 'Date() without new']) {
      expect(v.some(p => p.includes(needle))).toBe(true)
    }
  })

  test('catches code inside template expressions', () => {
    expect(purityViolations('const t = `a ${Bun.version} b`')).toEqual(['uses Bun.'])
  })
})

describe('src/core', () => {
  const files = [...new Bun.Glob('**/*.ts').scanSync({ cwd: CORE, absolute: true })].sort()

  test('has every contract module', () => {
    const rel = files.map(f => relative(CORE, f).split(sep).join('/'))
    for (const m of ['index.ts', 'events.ts', 'config.ts', 'catalog.ts', 'compact.ts', 'checkers.ts', 'usage.ts',
      'policy/bash-guard.ts', 'policy/write-guard.ts', 'policy/routing.ts', 'policy/questions.ts', 'policy/intents.ts',
      'plan/format.ts', 'plan/state.ts', 'status/model.ts', 'status/git.ts', 'status/render.ts',
      'memory/note.ts', 'memory/text.ts', 'memory/status.ts']) {
      expect(rel).toContain(m)
    }
  })

  for (const file of files) {
    test(`${relative(CORE, file)} is pure`, () => {
      expect(purityViolations(readFileSync(file, 'utf8'))).toEqual([])
    })
  }

  test('type-checks under Claude mod compiler options without Bun/Node types', () => {
    const r = tscWithoutRuntimeTypes([join(CORE, '**', '*.ts')])
    expect(r.output).toBe('')
    expect(r.code).toBe(0)
  })

  test('controls: worker globals compile, Node/Bun globals do not', () => {
    const dir = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'buracle-core-neg-')))
    try {
      writeFileSync(join(dir, 'ok.ts'), 'export const n = new TextEncoder().encode(new URL("https://x.y/z").pathname).length + atob("eA==").length\n')
      expect(tscWithoutRuntimeTypes([join(dir, 'ok.ts')])).toEqual({ code: 0, output: '' })
      for (const bad of ['export const h = process.env.HOME', 'export const b = Buffer.from("x")', 'console.log(1)', 'export const v = Bun.version']) {
        writeFileSync(join(dir, 'bad.ts'), bad + '\n')
        expect(tscWithoutRuntimeTypes([join(dir, 'bad.ts')]).code).not.toBe(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
