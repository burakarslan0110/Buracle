import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'

const PATH = join(import.meta.dir, '..', '..', '..', 'src', 'adapters', 'claude', 'template', 'register.tsx')
const FILE = ts.createSourceFile(PATH, readFileSync(PATH, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

function nodes(root: ts.Node = FILE): ts.Node[] {
  const out: ts.Node[] = []
  const visit = (n: ts.Node) => {
    out.push(n)
    ts.forEachChild(n, visit)
  }
  visit(root)
  return out
}

const ALL = nodes()
const CALLS = ALL.filter(ts.isCallExpression)

function dollarCallee(call: ts.CallExpression): string | undefined {
  const callee = call.expression
  if (!ts.isPropertyAccessExpression(callee) || !ts.isPropertyAccessExpression(callee.expression)) return undefined
  const base = callee.expression.expression
  return ts.isIdentifier(base) && base.text === '$' ? `${callee.expression.name.text}.${callee.name.text}` : undefined
}

function line(n: ts.Node): number {
  return FILE.getLineAndCharacterOfPosition(n.getStart(FILE)).line + 1
}

const TOP_LEVEL_FUNCTIONS = new Set(FILE.statements.filter(ts.isFunctionDeclaration).map(f => f.name?.text ?? ''))

interface Registration { event: string; matcher: string; call: ts.CallExpression; hook?: ts.Expression; handler?: ts.Expression }

function registrations(): Registration[] {
  return CALLS.filter(c => ts.isIdentifier(c.expression) && c.expression.text === 'on').map(call => {
    const [event, second] = call.arguments
    const parent = call.parent
    const handler = ts.isPropertyAccessExpression(parent) && parent.name.text === 'catch' && ts.isCallExpression(parent.parent) ? parent.parent.arguments[0] : undefined
    const r: Registration = {
      event: event !== undefined && ts.isStringLiteral(event) ? event.text : '<not a literal>',
      matcher: call.arguments.length === 3 && second !== undefined ? second.getText(FILE) : '',
      call,
    }
    const hook = call.arguments[call.arguments.length - 1]
    if (hook !== undefined) r.hook = hook
    if (handler !== undefined) r.handler = handler
    return r
  })
}

const REGS = registrations()

function isFunctionLike(n: ts.Node): boolean {
  return ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)
}

function enclosingFunction(n: ts.Node): ts.Node | undefined {
  for (let p = n.parent; p !== undefined; p = p.parent) if (isFunctionLike(p)) return p
  return undefined
}

describe('register.tsx source rules', () => {
  test('imports only ./core/index, ./generated/* and claude-code; no dynamic import, require or eval', () => {
    const specifiers = FILE.statements.filter(ts.isImportDeclaration).map(d => (d.moduleSpecifier as ts.StringLiteral).text)
    expect(specifiers.length).toBeGreaterThan(0)
    for (const spec of specifiers) expect(spec === 'claude-code' || spec === './core/index' || /^\.\/generated\/[a-z]+$/.test(spec)).toBe(true)
    for (const call of CALLS) {
      expect(call.expression.kind === ts.SyntaxKind.ImportKeyword).toBe(false)
      if (ts.isIdentifier(call.expression)) expect(['require', 'eval']).not.toContain(call.expression.text)
    }
    expect(ALL.some(n => ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Function')).toBe(false)
  })

  test('every $ use is a spelled-out $.noun.method(…) call or $ handed to a top-level helper or the state library', () => {
    const uses = ALL.filter((n): n is ts.Identifier => ts.isIdentifier(n) && n.text === '$')
    expect(uses.length).toBeGreaterThan(30)
    for (const id of uses) {
      const parent = id.parent
      if (ts.isParameter(parent) && parent.name === id) continue
      if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
        const outer = parent.parent
        const ok = ts.isPropertyAccessExpression(outer) && ts.isCallExpression(outer.parent) && outer.parent.expression === outer
        expect(ok, `${id.getText(FILE)}.${parent.name.text} at ${line(id)} must be called as written`).toBe(true)
        continue
      }
      if (ts.isCallExpression(parent) && parent.arguments.includes(id) && ts.isIdentifier(parent.expression)) {
        const callee = parent.expression.text
        expect(TOP_LEVEL_FUNCTIONS.has(callee) || callee === 'read' || callee === 'update', `$ passed to ${callee}`).toBe(true)
        continue
      }
      throw new Error(`$ used as a value at line ${line(id)}`)
    }
  })

  test('environment names are literals; $.state only through the state library (atom, read, update); no environment writes', () => {
    for (const call of CALLS) {
      const callee = dollarCallee(call)
      const first = call.arguments[0]
      if (callee === 'env.get') expect(first !== undefined && ts.isStringLiteral(first)).toBe(true)
      expect(callee === 'env.set' || callee === 'state.get' || callee === 'state.set', `${callee} at ${line(call)}`).toBe(false)
    }
    const imports = FILE.statements.filter(ts.isImportDeclaration).filter(d => (d.moduleSpecifier as ts.StringLiteral).text === 'claude-code' && d.importClause?.isTypeOnly !== true)
    const names = imports.flatMap(d => (d.importClause?.namedBindings !== undefined && ts.isNamedImports(d.importClause.namedBindings) ? d.importClause.namedBindings.elements.map(e => e.name.text) : []))
    expect(names.sort()).toEqual(['atom', 'read', 'update'])
    const atoms = CALLS.filter(c => ts.isIdentifier(c.expression) && c.expression.text === 'atom')
    expect(atoms.map(a => a.arguments[0]?.getText(FILE))).toEqual(["{ plugin: 'buracle', key: 'band' } as const"])
  })

  test('event names are literals and nothing is named h or Fragment', () => {
    for (const r of REGS) expect(r.event).not.toBe('<not a literal>')
    for (const n of ALL) {
      if ((ts.isVariableDeclaration(n) || ts.isFunctionDeclaration(n) || ts.isParameter(n)) && n.name !== undefined && ts.isIdentifier(n.name)) {
        expect(n.name.text === 'h' || n.name.text === 'Fragment', `${n.name.text} at line ${line(n)}`).toBe(false)
      }
    }
  })

  test('every hook of the mod fails open; nothing the command hooks own is done again', () => {
    for (const r of REGS.filter(x => ['tool.call', 'session.compact', 'command.run', 'turn.start', 'turn.complete', 'prompt.suggest'].includes(x.event))) {
      expect(r.handler?.getText(FILE), `${r.event} ${r.matcher}`).toBe('($, e, next) => next(e)')
    }
    for (const r of REGS) expect(r.handler?.getText(FILE) ?? '').not.toContain('deny')
    for (const event of ['classic.Stop', 'classic.SubagentStop', 'classic.SessionStart', 'classic.PostCompact', 'prompt.submit', 'prompt.context', 'prompt.compose', 'skill.prompt']) {
      expect(REGS.some(r => r.event === event), event).toBe(false)
    }
  })

  test('the band: exactly one AbovePrompt drawing, which yields to a survey, reads $.state and never writes it', () => {
    const bands = REGS.filter(r => r.event === 'ui.render' && r.matcher.includes('AbovePrompt'))
    expect(bands).toHaveLength(1)
    const hook = bands[0]?.hook as ts.Expression
    const body = hook.getText(FILE)
    expect(body).toContain('e.props.hasSurvey')
    expect(body).toContain('e.props.bodyColumns')
    expect(body).toContain('read($, BAND)')
    expect(body).toContain('await next(e)')
    for (const call of nodes(hook).filter(ts.isCallExpression)) {
      const writes = (ts.isIdentifier(call.expression) && call.expression.text === 'update') || dollarCallee(call) === 'state.set'
      if (writes) expect(enclosingFunction(call), `a write at line ${line(call)} runs while drawing`).not.toBe(hook)
    }
    expect(CALLS.some(c => dollarCallee(c) === 'ui.status')).toBe(false)
    expect(REGS.some(r => r.event === 'ui.render' && /PromptHint|SessionMode/.test(r.matcher))).toBe(false)
  })

  test('an unreadable runtime config never makes a guard throw: runtime() has no strict mode', () => {
    const runtime = FILE.statements.filter(ts.isFunctionDeclaration).find(f => f.name?.text === 'runtime')
    expect(runtime?.parameters.map(p => p.name.getText(FILE))).toEqual(['$', 'S'])
    expect(CALLS.some(c => ts.isIdentifier(c.expression) && c.expression.text === 'runtime' && c.arguments.length > 2)).toBe(false)
  })

  test('commands: no short aliases (D4); the mod answers only what it registered, and only observes workflow starts', () => {
    const specifiers = FILE.statements.filter(ts.isImportDeclaration).map(d => (d.moduleSpecifier as ts.StringLiteral).text)
    expect(specifiers).not.toContain('./generated/aliases')
    const runs = REGS.filter(r => r.event === 'command.run')
    expect(runs.map(r => r.matcher)).toEqual([
      "{ command: ['buracle-ping', 'buracle-status', 'buracle', 'remember', 'buracle-remember', 'brain', 'buracle-brain', 'aside', 'buracle-aside'] }",
      "{ command: 'buracle:buracle' }",
      '{ command: /^buracle:[a-z][a-z0-9-]*$/ }',
    ])
    expect(runs[0]?.hook?.getText(FILE) ?? '').toContain('if (!S.registered.has(e.command)) return next(e)')
    expect(runs[1]?.hook?.getText(FILE) ?? '').toContain('statusCommand($, S, e.args)')
    expect(runs[1]?.hook?.getText(FILE) ?? '').not.toContain('next(')
    const observer = runs[2]?.hook?.getText(FILE) ?? ''
    expect(observer).toContain('recordStart($, S, workflow, e.args, \'command\')')
    expect(observer).toContain('return next(e)')
    expect(CALLS.some(c => dollarCallee(c) === 'command.run' || dollarCallee(c) === 'prompt.submit')).toBe(false)
  })

  test('the mod runs no git (the status line and the hooks do) and masks within a size bound', () => {
    const gitCalls = CALLS.filter(c => dollarCallee(c) === 'process.run' && ts.isArrayLiteralExpression(c.arguments[0] ?? FILE) && (c.arguments[0] as ts.ArrayLiteralExpression).elements[0]?.getText(FILE) === "'git'")
    expect(gitCalls).toHaveLength(0)
    const masked = FILE.statements.filter(ts.isFunctionDeclaration).find(f => f.name?.text === 'masked')
    expect(masked?.getText(FILE)).toContain('Core.maskSecrets(ran.result, MASK_MAX_CHARS)')
  })

  test('every registration at a site that can refuse has a .catch (DESIGN §15)', () => {
    const gating = /^(?:tool\.call|tool\.check|prompt\.submit|prompt\.mention|prompt\.suggest|agent\.spawn|session\.compact|command\.run|classic\.)/
    for (const r of REGS) {
      if (!gating.test(r.event)) continue
      expect(r.handler, `${r.event} ${r.matcher}`).toBeDefined()
    }
  })

  test('each event without a matcher is registered once', () => {
    const plain = REGS.filter(r => r.matcher === '').map(r => r.event)
    expect(new Set(plain).size).toBe(plain.length)
  })

  test('everything the mod shows is English: no Turkish letters in its strings', () => {
    for (const n of ALL) {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) {
        expect(/[çğıöşüÇĞİÖŞÜ]/.test(n.getText(FILE)), `line ${line(n)}: ${n.getText(FILE)}`).toBe(false)
      }
    }
  })
})
