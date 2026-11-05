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
// node:child_process functions that start a process; each takes its options as an object argument.
const NODE_SPAWN = new Set(['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'])

const ALLOWED_CALLS: Readonly<Record<string, string>> = {}

const ALLOWED_TEXT: Readonly<Record<string, string>> = {
  'src/adapters/opencode/install.ts': 'SERVICE_ENV_CHECK is code a separate `bun -e` process runs; there the environment it started with is the one its parent passed',
}

// Files whose calls may pass windowsHide: false, each with the reason the child must keep its window.
const ALLOWED_SHOWN: Readonly<Record<string, string>> = {
  'src/memory/ui.ts': 'openInBrowser starts rundll32, a GUI program that hands its show state to ShellExecute: hidden, the browser would open hidden',
}

// `env`: the child gets the HOME this process set. `windowsHide`: on Windows a console program started by a process
// without a console (the detached background jobs a session start launches) opens a console window of its own; Bun
// and Node default the option to false.
interface Finding { at: string; kind: 'env' | 'windowsHide'; problem: string }

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

function property(o: ts.ObjectLiteralExpression, key: string): ts.ObjectLiteralElementLike | undefined {
  return o.properties.find(p => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name !== undefined && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === key)
}

function hasKey(o: ts.ObjectLiteralExpression, key: string): boolean {
  return property(o, key) !== undefined
}

const HIDE = 'pass windowsHide: true, or on Windows the child can open a console window of its own'

/** windowsHide must be the literal true; false only in a file ALLOWED_SHOWN names. */
function hideProblem(o: ts.ObjectLiteralExpression, rel: string): string | undefined {
  const p = property(o, 'windowsHide')
  if (p === undefined) return `options without \`windowsHide\`: ${HIDE}`
  const v = ts.isPropertyAssignment(p) ? p.initializer : undefined
  if (v?.kind === ts.SyntaxKind.TrueKeyword) return undefined
  if (v?.kind === ts.SyntaxKind.FalseKeyword && ALLOWED_SHOWN[rel] !== undefined) return undefined
  return `windowsHide is not the literal true: ${HIDE} (a child that must keep its window goes in ALLOWED_SHOWN with the reason)`
}

function callProblems(call: ts.CallExpression, rel: string): Array<Pick<Finding, 'kind' | 'problem'>> {
  const [first, second] = call.arguments
  const options = first !== undefined && ts.isObjectLiteralExpression(first) ? first : second
  if (options === undefined) return [{ kind: 'env', problem: 'no options: the child gets the environment this process started with; pass env: { ...process.env }' }, { kind: 'windowsHide', problem: `no options: ${HIDE}` }]
  if (!ts.isObjectLiteralExpression(options)) return [{ kind: 'env', problem: 'options are not an object literal, so this check cannot see `env`; pass env inline' }, { kind: 'windowsHide', problem: `options are not an object literal, so this check cannot see \`windowsHide\`; ${HIDE}` }]
  const out: Array<Pick<Finding, 'kind' | 'problem'>> = []
  if (!hasKey(options, 'env')) out.push({ kind: 'env', problem: 'options without `env`: the child gets the environment this process started with; pass env: { ...process.env }' })
  const hide = hideProblem(options, rel)
  if (hide !== undefined) out.push({ kind: 'windowsHide', problem: hide })
  return out
}

/** The names a file imports from node:child_process: plain names map to the function, a namespace maps to '*'. */
function nodeSpawnImports(sf: ts.SourceFile): Map<string, string> {
  const names = new Map<string, string>()
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !/^(?:node:)?child_process$/.test(st.moduleSpecifier.text)) continue
    if (st.importClause?.name !== undefined) names.set(st.importClause.name.text, '*')
    const b = st.importClause?.namedBindings
    if (b !== undefined && ts.isNamespaceImport(b)) names.set(b.name.text, '*')
    if (b !== undefined && ts.isNamedImports(b)) for (const el of b.elements) names.set(el.name.text, (el.propertyName ?? el.name).text)
  }
  return names
}

function nodeSpawnName(n: ts.Expression, imports: ReadonlyMap<string, string>): string | undefined {
  if (ts.isIdentifier(n)) { const f = imports.get(n.text); return f !== undefined && f !== '*' && NODE_SPAWN.has(f) ? f : undefined }
  if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && imports.get(n.expression.text) === '*' && NODE_SPAWN.has(n.name.text)) return n.name.text
  return undefined
}

function nodeCallProblem(call: ts.CallExpression, rel: string): string | undefined {
  const options = call.arguments.find(a => ts.isObjectLiteralExpression(a))
  if (options === undefined || !ts.isObjectLiteralExpression(options)) return `no options object literal: ${HIDE}`
  return hideProblem(options, rel)
}

function scanFile(file: string): Finding[] {
  return scanText(relative(ROOT, file).split('\\').join('/'), readFileSync(file, 'utf8'))
}

function scanText(rel: string, text: string): Finding[] {
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, rel.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const out: Finding[] = []
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1
  const nodeImports = nodeSpawnImports(sf)
  const visit = (n: ts.Node): void => {
    const name = bunSpawnName(n)
    if (name !== undefined) {
      const parent = n.parent
      if (ts.isCallExpression(parent) && parent.expression === n) {
        const at = `${rel}:${lineOf(parent)}`
        if (ALLOWED_CALLS[at] === undefined) for (const p of callProblems(parent, rel)) out.push({ at, kind: p.kind, problem: `Bun.${name}: ${p.problem}` })
      } else {
        for (const kind of ['env', 'windowsHide'] as const) out.push({ at: `${rel}:${lineOf(n)}`, kind, problem: `Bun.${name} is used without calling it here; call it directly with env and windowsHide so this check sees it` })
      }
    }
    if (ts.isCallExpression(n)) {
      const fn = nodeSpawnName(n.expression, nodeImports)
      const problem = fn !== undefined ? nodeCallProblem(n, rel) : undefined
      if (problem !== undefined) out.push({ at: `${rel}:${lineOf(n)}`, kind: 'windowsHide', problem: `child_process.${fn}: ${problem}` })
    }
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer !== undefined && ts.isIdentifier(n.initializer) && n.initializer.text === 'Bun') {
      for (const el of n.name.elements) {
        const key = el.propertyName ?? el.name
        if ((ts.isIdentifier(key) || ts.isStringLiteral(key)) && SPAWN.has(key.text)) for (const kind of ['env', 'windowsHide'] as const) out.push({ at: `${rel}:${lineOf(el)}`, kind, problem: `Bun.${key.text} is destructured from Bun; call Bun.${key.text}(...) directly with env and windowsHide so this check sees it` })
      }
    }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && /\bBun\.spawn(?:Sync)?\s*\(/.test(n.text) && ALLOWED_TEXT[rel] === undefined) {
      out.push({ at: `${rel}:${lineOf(n)}`, kind: 'env', problem: 'source text in a string calls Bun.spawn: list the file in ALLOWED_TEXT with the reason its child environment is right' })
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
    const findings = files.flatMap(scanFile).filter(f => f.kind === 'env')
    expect(findings.map(f => `${f.at} ${f.problem}`)).toEqual([])
  })

  test('every call under src/ names windowsHide in its options object (no console window flashes on Windows)', () => {
    const findings = files.flatMap(scanFile).filter(f => f.kind === 'windowsHide')
    expect(findings.map(f => `${f.at} ${f.problem}`)).toEqual([])
  })

  test('the windowsHide check: Bun and node:child_process calls without it are findings', () => {
    const probe = (code: string): string[] => scanText('src/probe.ts', code).filter(f => f.kind === 'windowsHide').map(f => f.problem)
    expect(probe("Bun.spawn(['ls'], { env: { ...process.env }, windowsHide: true })")).toEqual([])
    expect(probe("Bun.spawnSync({ cmd: ['ls'], env: process.env, windowsHide: true })")).toEqual([])
    expect(probe("Bun.spawn(['ls'], { env: { ...process.env } })")).toEqual([expect.stringContaining('options without `windowsHide`')])
    expect(probe("Bun.spawnSync(['ls'])")).toEqual([expect.stringContaining('no options')])
    expect(probe("import { spawn } from 'node:child_process'\nspawn('ls', [], { stdio: 'ignore', windowsHide: true })")).toEqual([])
    expect(probe("import { spawn } from 'node:child_process'\nspawn('ls', [], { stdio: 'ignore' })")).toEqual([expect.stringContaining('child_process.spawn: options without `windowsHide`')])
    expect(probe("import { execFile as ef } from 'child_process'\nef('ls')")).toEqual([expect.stringContaining('child_process.execFile: no options')])
    expect(probe("import * as cp from 'node:child_process'\ncp.spawnSync('ls', { env: {} })")).toEqual([expect.stringContaining('child_process.spawnSync: options without')])
    expect(probe("import cp from 'node:child_process'\ncp.execFile('ls', [], { env: {} })")).toEqual([expect.stringContaining('child_process.execFile: options without')])
    expect(probe("function spawn(a: string) {}\nspawn('ls')")).toEqual([])
    // Only the literal true counts; false only where ALLOWED_SHOWN gives the reason.
    expect(probe("Bun.spawn(['ls'], { env: {}, windowsHide: false })")).toEqual([expect.stringContaining('not the literal true')])
    expect(probe("const h = true; Bun.spawn(['ls'], { env: {}, windowsHide: h })")).toEqual([expect.stringContaining('not the literal true')])
    expect(scanText('src/memory/ui.ts', "Bun.spawn(['rundll32'], { env: {}, windowsHide: false })").filter(f => f.kind === 'windowsHide')).toEqual([])
  })

  test('every file allowed to show a window still passes windowsHide: false and has a reason', () => {
    for (const [file, reason] of Object.entries(ALLOWED_SHOWN)) {
      expect(reason.trim().length).toBeGreaterThan(20)
      expect(readFileSync(join(ROOT, file), 'utf8')).toContain('windowsHide: false')
    }
  })

  test('every allowlisted exception still exists and has a reason', () => {
    for (const [file, reason] of Object.entries(ALLOWED_TEXT)) {
      expect(reason.trim().length).toBeGreaterThan(20)
      expect(readFileSync(join(ROOT, file), 'utf8')).toMatch(/\bBun\.spawn(?:Sync)?\s*\(/)
    }
    for (const reason of Object.values(ALLOWED_CALLS)) expect(reason.trim().length).toBeGreaterThan(20)
  })

  test('the check itself: calls without env, opaque options, aliases and spawn code in strings are findings', () => {
    const probe = (code: string): string[] => scanText('src/probe.ts', code).filter(f => f.kind === 'env').map(f => f.problem)
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
