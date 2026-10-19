import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { defaultConfig } from '../../src/core/config'
import { run } from '../../src/engine/proc'
import { startIndexRun } from '../../src/workflow/workspace'
import { withSandbox } from '../helpers/sandbox'

const ROOT = join(import.meta.dir, '..', '..')
const SRC = join(ROOT, 'src')
const SPAWN = new Set(['spawn', 'spawnSync'])

const ALLOWED_CALLS: Readonly<Record<string, string>> = {}

const ALLOWED_TEXT: Readonly<Record<string, string>> = {
  'src/adapters/opencode/install.ts': 'SERVICE_ENV_CHECK is code a separate `bun -e` process runs; there the environment it started with is the one its parent passed',
}

interface Finding { at: string; problem: string }

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(?:ts|tsx|mts|cts|js|mjs)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

function bunSpawnName(n: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Bun' && SPAWN.has(n.name.text)) return n.name.text
  if (ts.isElementAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Bun' && ts.isStringLiteralLike(n.argumentExpression) && SPAWN.has(n.argumentExpression.text)) return n.argumentExpression.text
  return undefined
}

function hasEnv(o: ts.ObjectLiteralExpression): boolean {
  return o.properties.some(p => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === 'env')
}

function callProblem(call: ts.CallExpression): string | undefined {
  const [first, second] = call.arguments
  const options = first !== undefined && ts.isObjectLiteralExpression(first) ? first : second
  if (options === undefined) return 'no options: the child gets the environment this process started with; pass env: { ...process.env }'
  if (!ts.isObjectLiteralExpression(options)) return 'options are not an object literal, so this check cannot see `env`; pass env inline'
  return hasEnv(options) ? undefined : 'options without `env`: the child gets the environment this process started with; pass env: { ...process.env }'
}

function scanFile(file: string): Finding[] {
  return scanText(relative(ROOT, file).split('\\').join('/'), readFileSync(file, 'utf8'))
}

function scanText(rel: string, text: string): Finding[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Finding[] = []
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const visit = (n: ts.Node): void => {
    const name = bunSpawnName(n)
    if (name !== undefined) {
      const parent = n.parent
      if (ts.isCallExpression(parent) && parent.expression === n) {
        const problem = callProblem(parent)
        const at = `${rel}:${lineOf(parent)}`
        if (problem !== undefined && ALLOWED_CALLS[at] === undefined) out.push({ at, problem: `Bun.${name}: ${problem}` })
      } else {
        out.push({ at: `${rel}:${lineOf(n)}`, problem: `Bun.${name} is used without calling it here; call it directly with env so this check sees it` })
      }
    }
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer !== undefined && ts.isIdentifier(n.initializer) && n.initializer.text === 'Bun') {
      for (const el of n.name.elements) {
        const key = el.propertyName ?? el.name
        if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && SPAWN.has(key.text)) out.push({ at: `${rel}:${lineOf(el)}`, problem: `Bun.${key.text} is destructured from Bun; call Bun.${key.text}(...) directly with env so this check sees it` })
      }
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && /\bBun\.spawn(?:Sync)?\s*\(/.test(n.text) && ALLOWED_TEXT[rel] === undefined) {
      out.push({ at: `${rel}:${lineOf(n)}`, problem: 'source text in a string calls Bun.spawn: list the file in ALLOWED_TEXT with the reason its child environment is right' })
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return out
}

describe('Bun.spawn and Bun.spawnSync under src/ pass env', () => {
  const files = sourceFiles(SRC)

  test('the scan sees the source tree', () => {
    expect(files.length).toBeGreaterThan(100)
    expect(readFileSync(join(SRC, 'engine', 'proc.ts'), 'utf8')).toContain('Bun.spawn(')
  })

  test('every call names env in its options object', () => {
    const findings = files.flatMap(scanFile)
    expect(findings.map(f => `${f.at} ${f.problem}`)).toEqual([])
  })

  test('every allowlisted exception still exists and has a reason', () => {
    for (const [file, reason] of Object.entries(ALLOWED_TEXT)) {
      expect(reason.trim().length).toBeGreaterThan(20)
      expect(readFileSync(join(ROOT, file), 'utf8')).toMatch(/\bBun\.spawn(?:Sync)?\s*\(/)
    }
    for (const reason of Object.values(ALLOWED_CALLS)) expect(reason.trim().length).toBeGreaterThan(20)
  })

  test('the check itself: calls without env, opaque options, aliases and spawn code in strings are findings', () => {
    const probe = (code: string): string[] => scanText('src/probe.ts', code).map(f => f.problem)
    expect(probe("Bun.spawn(['ls'], { stdout: 'pipe', env: { ...process.env } })")).toEqual([])
    expect(probe("const env = {}; Bun.spawnSync(['ls'], { env, stdout: 'pipe' })")).toEqual([])
    expect(probe("Bun.spawn({ cmd: ['ls'], env: process.env })")).toEqual([])
    expect(probe("Bun.spawn(['ls'])")).toEqual([expect.stringContaining('Bun.spawn: no options')])
    expect(probe("Bun.spawn(['ls'], { stdout: 'pipe' })")).toEqual([expect.stringContaining('options without `env`')])
    expect(probe("Bun.spawn({ cmd: ['ls'], ...rest })")).toEqual([expect.stringContaining('options without `env`')])
    expect(probe("Bun.spawnSync(['ls'], opts)")).toEqual([expect.stringContaining('options are not an object literal')])
    expect(probe("Bun['spawn'](['ls'], {})")).toEqual([expect.stringContaining('options without `env`')])
    expect(probe("const run = Bun.spawn; run(['ls'])")).toEqual([expect.stringContaining('used without calling it here')])
    expect(probe("const { spawnSync: s } = Bun; s(['ls'])")).toEqual([expect.stringContaining('destructured from Bun')])
    expect(probe("const code = 'Bun.spawnSync([\"ls\"])'")).toEqual([expect.stringContaining('source text in a string')])
    expect(probe("// Bun.spawn(['ls']) without env\nchild.spawn(['ls'])")).toEqual([])
  })
})

describe('a child sees the HOME this process set after it started', () => {
  test('engine/proc run()', () => withSandbox(async sb => {
    expect(process.env['HOME']).toBe(sb.home)
    const r = await run([process.execPath, '-e', "process.stdout.write(process.env.HOME ?? '')"])
    expect(r.code).toBe(0)
    expect(r.stdout).toBe(sb.home)
  }))

  test('the detached background index run (workflow/workspace startIndexRun)', () => withSandbox(async sb => {
    const project = join(sb.root, 'project')
    mkdirSync(project, { recursive: true })
    const out = join(sb.root, 'child-home.txt')
    const argv = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(out)}, process.env.HOME ?? '')`]
    expect(startIndexRun({ cwd: project, root: project, children: [] }, defaultConfig(), Date.now(), argv)).toEqual([project])
    const deadline = Date.now() + 5_000
    while (!existsSync(out) && Date.now() < deadline) await Bun.sleep(25)
    await Bun.sleep(50)
    expect(readFileSync(out, 'utf8')).toBe(sb.home)
  }), 15_000)
})
