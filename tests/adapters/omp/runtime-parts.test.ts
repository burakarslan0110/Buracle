import { describe, expect, test } from 'bun:test'
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { renderCommand } from '../../../src/adapters/omp/build'
import { OMP_BUILTIN_COMMANDS, OMP_UTILITY_COMMANDS, statusViewOf } from '../../../src/adapters/omp/runtime/commands'
import { editTargets } from '../../../src/adapters/omp/runtime/edits'
import { FLOW_WIDGET_KEY, FlowWidget, flowWidgetLines } from '../../../src/adapters/omp/runtime/flow-widget'
import { workflowCommandBody, workflowOfExpanded, workflowOfInput } from '../../../src/adapters/omp/runtime/flow-track'
import { isModelPrompt, noTurnCommand } from '../../../src/adapters/omp/runtime/prompt'
import { reviewAgentOf, reviewProblems, reviewYieldReason, yieldReport } from '../../../src/adapters/omp/runtime/review'
import { availableServers, createDepsReader, isDeviceWrite, promptRouting, routerData } from '../../../src/adapters/omp/runtime/routing'
import { fitParts, workspaceFacts } from '../../../src/adapters/shared/pipeline/index'
import { defaultConfig } from '../../../src/core/config'
import type { RoutingPolicy } from '../../../src/core/policy/routing'
import { emptyLedger, reminders, rootProblem as coreRootProblem, type WorkspaceFacts } from '../../../src/core/policy/usage'
import * as paths from '../../../src/engine/paths'
import { codegraphDataDir } from '../../../src/workflow/workspace'
import type { BandView } from '../../../src/core/flow/band'
import { bandView } from '../../../src/core/flow/band'
import { flowStart } from '../../../src/core/flow/record'
import type { ToolCall } from '../../../src/core/events'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import { withSandbox } from '../../helpers/sandbox'

const ESC = String.fromCharCode(27)

// The root check, the workspace facts and the fitting of the prompt context are the shared pipeline's and core's
// (H24, H10): omp has no copy of them, so these read them the way the extension's calls reach them.
interface RootEnv { home: string, caseInsensitive: boolean, canonical: (p: string) => string, excluded: (d: string) => string | undefined }
function rootFacts(info: WorkspaceInfo | undefined, env: RootEnv): WorkspaceFacts {
  const facts: WorkspaceFacts = { home: env.home, caseInsensitive: env.caseInsensitive, realpath: env.canonical, excludedReason: env.excluded }
  if (info !== undefined) {
    facts.cwd = info.cwd
    if (info.children.length > 0) facts.children = [...info.children]
    if (info.root !== undefined) facts.root = info.root
  }
  return facts
}
const rootProblem = (value: string, info: WorkspaceInfo | undefined, env: RootEnv): string | undefined => coreRootProblem(value, rootFacts(info, env))
function rootCheck(call: ToolCall, info: WorkspaceInfo | undefined, strictness: RoutingPolicy['strictness'], env: RootEnv): { deny?: string, context?: string } {
  const r = reminders(emptyLedger(), call, { strictness, available: [], facts: rootFacts(info, env) })
  return { ...(r.deny !== undefined ? { deny: r.deny.reason } : {}), ...(r.context !== undefined ? { context: r.context } : {}) }
}
const stripAnsi = (s: string) => s.split(ESC).map((part, i) => (i === 0 ? part : part.replace(/^\[[0-9;]*m/, ''))).join('')

// The workspace and the home folder are this platform's absolute paths, as omp hands them over.
describe('omp edit targets (line-anchored edit formats)', () => {
  const W = resolve('/w')
  const H = resolve('/h')
  const w = (...p: string[]) => join(W, ...p)
  const h = (...p: string[]) => join(H, ...p)
  const files: Record<string, string> = {
    [w('src', 'a.ts')]: 'line 1\nexport function foo(a: string): number {\n  return 1\n}\nline 5\n',
    [w('.env')]: 'A=1\n',
  }
  const read = (p: string) => files[p]

  test('hashline: section files, MV destinations, replaced lines and added rows', () => {
    const input = ['*** Begin Patch', '[src/a.ts#1A2B]', 'PUT 2.=4:', '+export function foo(a: string, b: number): number {', '+  return b', '+}', 'MV src/b.ts', `[${w('.env')}#00FF]`, 'PUT >$:', '+B=2', '*** End Patch'].join('\n')
    const t = editTargets({ input }, W, read)
    expect(t?.paths).toEqual([w('src', 'a.ts'), w('src', 'b.ts'), w('.env')])
    expect(t?.changes).toEqual([
      { file: w('src', 'a.ts'), removed: 'export function foo(a: string): number {\n  return 1\n}', added: 'export function foo(a: string, b: number): number {\n  return b\n}' },
      { file: w('.env'), removed: '', added: 'B=2' },
    ])
  })

  test('hashline: block anchors take the opener line, REM removes the whole file, CUT removes without adding', () => {
    expect(editTargets({ input: '[src/a.ts#1A2B]\nPUT 2*:\n+export const x = 1' }, W, read)?.changes[0]?.removed).toBe('export function foo(a: string): number {')
    expect(editTargets({ input: '[src/a.ts#1A2B]\nREM' }, W, read)?.changes[0]?.removed).toBe(files[w('src', 'a.ts')])
    expect(editTargets({ input: '[src/a.ts#1A2B]\nCUT 5.=5' }, W, read)?.changes[0]).toEqual({ file: w('src', 'a.ts'), removed: 'line 5', added: '' })
    expect(editTargets({ input: '[gone.ts#ABCD]\nPUT 1.=1:\n+x' }, W, read)).toEqual({ paths: [w('gone.ts')], changes: [{ file: w('gone.ts'), removed: '', added: 'x' }] })
  })

  test('sloppy: `*** Edit File:` sections with find and replace bodies', () => {
    const input = ['*** Edit File: src/a.ts', '*** Find', 'return 1', '*** Replace', 'return 2', '*** Edit File: notes/b.md all', '*** Insert After', 'tail'].join('\n')
    expect(editTargets({ input }, W, read)).toEqual({
      paths: [w('src', 'a.ts'), w('notes', 'b.md')],
      changes: [{ file: w('src', 'a.ts'), removed: 'return 1', added: 'return 2' }, { file: w('notes', 'b.md'), removed: '', added: 'tail' }],
    })
  })

  test('`~/` is the home folder, as omp resolves it (other formats: core classifyTool homeTilde)', () => {
    expect(editTargets({ input: '[~/notes/a.md#ABCD]\nPUT >$:\n+x\nMV ~/b.md' }, W, read, H)?.paths).toEqual([h('notes', 'a.md'), h('b.md')])
    expect(editTargets({ input: '*** Edit File: ~/c.md\n*** Find\nx\n*** Replace\ny' }, W, read, H)?.paths).toEqual([h('c.md')])
    expect(editTargets({ input: '[~/notes/a.md#ABCD]\nPUT >$:\n+x' }, W, read)?.paths).toEqual([w('~', 'notes', 'a.md')])
  })

  test('other inputs are left to core classifyTool (apply_patch, replace, patch)', () => {
    expect(editTargets({ input: '*** Begin Patch\n*** Update File: a.ts\n@@\n-x\n+y\n*** End Patch' }, W, read)).toBeUndefined()
    expect(editTargets({ path: 'a.ts', old_string: 'x', new_string: 'y' }, W, read)).toBeUndefined()
    expect(editTargets({ input: '' }, W, read)).toBeUndefined()
  })
})

describe('omp workflow detection (H25)', () => {
  test('typed workflow commands and /skill:<id>; other commands and unknown workflows are not workflows', () => {
    const commands = ['plan-build', 'goal-build', 'research']
    expect(workflowOfInput('/plan-build add rate limiting\nwith tests', commands)).toEqual({ workflow: 'plan-build', args: 'add rate limiting\nwith tests', via: 'command' })
    expect(workflowOfInput('  /goal-build  ', commands)).toEqual({ workflow: 'goal-build', args: '', via: 'command' })
    expect(workflowOfInput('/skill:bugfix the parser crash', commands)).toEqual({ workflow: 'bugfix', args: 'the parser crash', via: 'skill' })
    expect(workflowOfInput('/bugfix it', commands)).toBeUndefined()
    expect(workflowOfInput('/memory search', ['memory'])).toBeUndefined()
    expect(workflowOfInput('please /plan-build this', commands)).toBeUndefined()
    expect(workflowOfInput('/plan-build-x', commands)).toBeUndefined()
  })

  test('an expanded workflow command is recognized by its first line (print mode); the command file renders that body', () => {
    const body = workflowCommandBody('bugfix').replace('$ARGUMENTS', 'the parser crashes on empty input')
    expect(workflowOfExpanded(body)).toEqual({ workflow: 'bugfix', args: 'the parser crashes on empty input' })
    expect(workflowOfExpanded('Run the tests please')).toBeUndefined()
    expect(workflowOfExpanded("Run Buracle Stack's `nope` workflow for the request below;")).toBeUndefined()
    const file = renderCommand({ id: 'bugfix', dir: 'skills/bugfix', frontmatter: { name: 'bugfix', description: 'Fix a bug.' }, body: '', files: [] })
    expect(file.content.endsWith(workflowCommandBody('bugfix'))).toBe(true)
  })
})

describe('omp prompt parts (H10, H22)', () => {
  test('no-turn commands: omp built-ins (split at whitespace or `:`) and Buracle Stack utility commands', () => {
    for (const t of ['/model', '/model:probe y', '/compact keep it', '/remember x', '/brain', '/buracle-status flow', '/buracle', '/aside what is 2+2', '/buracle-ping']) expect(noTurnCommand(t)).toBe(true)
    for (const t of ['/plan-build x', '/skill:research y', 'hello', '/research']) expect(noTurnCommand(t)).toBe(false)
    expect(isModelPrompt('!ls -la')).toBe(false)
    expect(isModelPrompt('  ')).toBe(false)
    expect(isModelPrompt('/plan-build add x')).toBe(true)
    expect(OMP_UTILITY_COMMANDS.every(c => !OMP_BUILTIN_COMMANDS.has(c))).toBe(true)
  })

  test('the prompt context is fitted by the pipeline: parts in reading order within the budget, the first always stays', () => {
    const parts = ['C'.repeat(10), 'R'.repeat(100), ' ', 'N'.repeat(5), 'W'.repeat(10)]
    expect(fitParts(parts, 1_000)).toEqual(['C'.repeat(10), 'R'.repeat(100), 'N'.repeat(5), 'W'.repeat(10)])
    expect(fitParts(parts, 31)).toEqual(['C'.repeat(10), 'N'.repeat(5), 'W'.repeat(10)])
    expect(fitParts(parts, 28)).toEqual(['C'.repeat(10), 'N'.repeat(5)])
    expect(fitParts(['X'.repeat(50)], 10)).toEqual(['X'.repeat(50)])
  })
})

describe('omp review gate (H19)', () => {
  const valid = { verdict: 'pass', summary: 'docs/plans/x.md looks complete', findings: [] }

  test('only Buracle Stack review agents; yield data as JSON or text; errors are not reports', () => {
    expect(reviewAgentOf('changes-review')).toBe('changes-review')
    expect(reviewAgentOf('buracle:plan-build-review')).toBe('plan-build-review')
    expect(reviewAgentOf('task')).toBeUndefined()
    expect(reviewAgentOf(undefined)).toBeUndefined()
    expect(yieldReport({ data: valid })).toBe(JSON.stringify(valid))
    expect(yieldReport({ data: '{"a":1}' })).toBe('{"a":1}')
    expect(yieldReport({ error: 'gave up' })).toBeUndefined()
    expect(yieldReport({})).toBeUndefined()
  })

  test('problems come from core validateReviewJson for that agent; the reason tells the reviewer what to do', () => {
    expect(reviewProblems('plan-build-review', JSON.stringify(valid))).toEqual([])
    const bad = reviewProblems('plan-build-review', JSON.stringify({ verdict: 'maybe', summary: 'x', findings: [] }))
    expect(bad.length).toBeGreaterThan(0)
    expect(bad.join(' ')).toContain('verdict')
    expect(reviewProblems('changes-review', JSON.stringify(valid))).toContain('changes-review must include `truths`')
    const reason = reviewYieldReason('plan-build-review', bad)
    expect(reason).toStartWith('your report as plan-build-review is not valid review JSON (')
    expect(reason).toContain('Call yield again with exactly one JSON object')
  })
})

describe('omp routing helpers (H03, H22, H24)', () => {
  test('device writes, available servers', () => {
    expect(isDeviceWrite('write', { path: 'xd://mcp__semble_search', content: '{}' })).toBe(true)
    expect(isDeviceWrite('write', { path: 'src/a.ts' })).toBe(false)
    expect(isDeviceWrite('read', { path: 'xd://mcp__semble_search' })).toBe(false)
    const mcp = [{ id: 'context7', description: '', transport: 'stdio' as const, critical: true, routing: [], harnesses: ['omp' as const] }, { id: 'semble', description: '', transport: 'stdio' as const, critical: true, routing: [], harnesses: ['omp' as const] }]
    expect(availableServers(mcp, { semble: 'down', context7: 'unknown' })).toEqual(['context7'])
  })

  test('the root check: home, a parent of the project, a folder of projects; relative paths are not judged', () => {
    const env = { home: '/h', caseInsensitive: false, canonical: (p: string) => p.replace(/\/+$/, ''), excluded: (d: string) => (d === '/h' ? 'your home folder' : undefined) }
    const info: WorkspaceInfo = { cwd: '/h/code/app/src', root: '/h/code/app', children: [], index: { codegraph: { state: 'ready' }, semble: { state: 'ready' } } }
    expect(rootProblem('/h', info, env)).toBe('your home folder')
    expect(rootProblem('~', info, env)).toBe('your home folder')
    expect(rootProblem('/h/code', info, env)).toBe('a parent folder of the project')
    expect(rootProblem('/h/code/app', info, env)).toBeUndefined()
    expect(rootProblem('/h/code/app/src', info, env)).toBeUndefined()
    expect(rootProblem('app', info, env)).toBeUndefined()
    const folder: WorkspaceInfo = { cwd: '/h/code', children: ['/h/code/a', '/h/code/b'], index: { codegraph: { state: 'none' }, semble: { state: 'none' } } }
    expect(rootProblem('/h/code', folder, env)).toBe('a folder of projects, not a project')
    const call = (input: Record<string, unknown>): ToolCall => ({ harness: 'omp', sessionId: 's', cwd: '/h/code/app', tool: 'mcp__semble_search', kind: 'mcp', input, paths: [], mcp: { server: 'semble', tool: 'search' } })
    expect(rootCheck(call({ repo: '/h' }), info, 'enforce', env).deny).toBe('Buracle Stack: semble `repo` is /h, your home folder; indexing it is slow and searches the wrong tree. Pass the project root /h/code/app instead.')
    expect(rootCheck(call({ repo: '/h' }), info, 'nudge', env).context).toStartWith('Buracle Stack: semble `repo` is /h')
    expect(rootCheck(call({ repo: '/h' }), info, 'off', env)).toEqual({})
    expect(rootCheck(call({ repo: '/h/code' }), folder, 'enforce', env).deny).toContain('Pass one of its projects instead (a, b), as /h/code/<name>.')
    expect(rootCheck(call({ query: 'x' }), info, 'enforce', env)).toEqual({})
  })

  test('workspace facts: the root, home, excluded folders; codegraph only counts with an index and the tool on', () => {
    return withSandbox(async sb => {
      const root = join(sb.root, 'w')
      mkdirSync(join(root, codegraphDataDir(root)), { recursive: true })
      writeFileSync(join(root, codegraphDataDir(root), 'codegraph.db'), '')
      const info: WorkspaceInfo = { cwd: root, root, children: [], index: { codegraph: { state: 'ready' }, semble: { state: 'ready' } } }
      const ctx = () => ({ paths: { ...paths, home: () => '/h', oldVaultRoot: () => '/v' }, config: defaultConfig() })
      expect(workspaceFacts(ctx(), info)).toMatchObject({ home: '/h', codegraphIndexed: true, root, cwd: root })
      expect(workspaceFacts(ctx(), info).exclusion?.vault).toBe('/v')
      expect(workspaceFacts(ctx(), { ...info, root: join(sb.root, 'unindexed') }).codegraphIndexed).toBe(false)
      const none = workspaceFacts(ctx(), undefined)
      expect({ home: none.home, indexed: none.codegraphIndexed, root: none.root }).toEqual({ home: '/h', indexed: false, root: undefined })
    })
  })

  test('the project deps reader reads the manifests and re-reads only when one changes', () => withSandbox(async sb => {
    const root = join(sb.root, 'proj')
    mkdirSync(root, { recursive: true })
    const read = createDepsReader()
    expect(read(root)).toBeUndefined()
    expect(read(undefined)).toBeUndefined()
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { zod: '1' }, devDependencies: { typescript: '6' } }))
    expect(read(root)).toEqual(['typescript', 'zod'])
    writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { zod: '1', yaml: '2' } }))
    utimesSync(join(root, 'package.json'), new Date(), new Date(Date.now() + 5000))
    expect(read(root)).toEqual(['yaml', 'zod'])
  }))

  test('the project deps reader reads the members of an npm workspace, as on every other harness', () => withSandbox(async sb => {
    const mono = join(sb.root, 'mono')
    mkdirSync(join(mono, 'packages', 'app'), { recursive: true })
    writeFileSync(join(mono, 'package.json'), JSON.stringify({ private: true, workspaces: ['packages/*'], devDependencies: { turbo: '2', typescript: '6' } }))
    writeFileSync(join(mono, 'packages', 'app', 'package.json'), JSON.stringify({ dependencies: { 'lodash-es': '4', zod: '4' } }))
    expect(createDepsReader()(mono)).toEqual(['lodash-es', 'turbo', 'typescript', 'zod'])
  }))

  test('the root check is core\'s: the extension\'s exclusion decides what is never indexed (index.exclude names too)', () => {
    const env = { home: '/h', caseInsensitive: false, canonical: (p: string) => p.replace(/\/+$/, ''), excluded: (d: string) => (d === '/h' ? 'your home folder' : /\/vendor(?:\/|$)/.test(d) ? 'excluded by index.exclude (vendor)' : undefined) }
    const info: WorkspaceInfo = { cwd: '/w/app', root: '/w/app', children: [], index: { codegraph: { state: 'ready' }, semble: { state: 'ready' } } }
    expect(rootProblem('/w/app/vendor', info, env)).toBe('excluded by index.exclude (vendor)')
    expect(rootProblem('/w', info, env)).toBe('a parent folder of the project')
  })

  test('promptRouting: an explicit ask loads the skill through skill://; a native invocation loads nothing more', () => {
    const data = routerData([{ id: 'research', description: 'Research with sources.', userInvocable: true, invocation: 'implicit' }], { strictness: 'enforce', categories: [] }, 'enforce')
    const on = promptRouting('$research compare zod and valibot', data, { loaded: [], available: ['buracle-memory'], strictness: 'enforce' })
    expect(on.route.load).toEqual(['research'])
    expect(on.text).toContain('(read skill://research)')
    const invoked = promptRouting('/skill:research zod', data, { loaded: [], available: [], strictness: 'enforce' })
    expect(invoked.route.invoked).toEqual(['research'])
    expect(invoked.text).toBeUndefined()
  })
})

describe('omp workflow widget', () => {
  const view = (now: number): BandView => bandView({ nowMs: now, foldAfterSec: 8, flow: flowStart(undefined, { workflow: 'plan-build', title: 'rate limiting', source: 'command' }, 1_000).record })

  test('lines fit the terminal minus omp\'s padding; narrow terminals get fewer rows, none below 24 columns', () => {
    const wide = flowWidgetLines(view(2_000), 120, { emoji: true, ansi: false })
    expect(wide.length).toBe(2)
    expect(wide[0]).toContain('plan-build')
    expect(wide[0]).toContain('rate limiting')
    expect(wide.every(l => l.length <= 118)).toBe(true)
    expect(flowWidgetLines(view(2_000), 40, { emoji: true, ansi: false }).length).toBe(1)
    expect(flowWidgetLines(view(2_000), 25, { emoji: true, ansi: false })).toEqual([])
    const colored = flowWidgetLines(view(2_000), 120, { emoji: true, ansi: true })
    expect(colored.join('\n')).toContain(ESC)
    expect(colored.map(stripAnsi)).toEqual(wide)
    expect(flowWidgetLines(bandView({ nowMs: 0, foldAfterSec: 8 }), 120, { emoji: true, ansi: false })).toEqual([])
  })

  test('the widget draws above the editor only when its text changes, and removes itself when empty', () => {
    const calls: unknown[][] = []
    const ui = { setWidget: (...a: unknown[]) => { calls.push(a) } }
    const w = new FlowWidget()
    expect(w.draw(ui, ['a', 'b'])).toBe(true)
    expect(w.draw(ui, ['a', 'b'])).toBe(false)
    expect(w.draw(ui, [])).toBe(true)
    expect(w.draw(ui, [])).toBe(false)
    w.reset()
    expect(w.draw(ui, ['a'])).toBe(true)
    expect(calls).toEqual([
      [FLOW_WIDGET_KEY, ['a', 'b'], { placement: 'aboveEditor' }],
      [FLOW_WIDGET_KEY, undefined, { placement: 'aboveEditor' }],
      [FLOW_WIDGET_KEY, ['a'], { placement: 'aboveEditor' }],
    ])
  })

  test('an ended run folds once, foldAfterSec after its end', () => {
    const ended = bandView({ nowMs: 10_000, foldAfterSec: 8, flow: { v: 1, updatedAt: 9_000, stack: [{ workflow: 'bugfix', source: 'command', startedAt: 1_000, ended: { outcome: 'done', at: 9_000 } }] } })
    const w = new FlowWidget()
    expect(w.foldDue(ended, 8)).toBe(17_000)
    expect(w.foldDue(ended, 8)).toBeUndefined()
    expect(w.foldDue(view(2_000), 8)).toBeUndefined()
  })
})

describe('omp utility command names', () => {
  test('/buracle-status views', () => {
    expect(statusViewOf('')).toBe('status')
    expect(statusViewOf(' Status ')).toBe('status')
    expect(statusViewOf('mem')).toBe('memory')
    expect(statusViewOf('memory')).toBe('memory')
    expect(statusViewOf('plan')).toBe('plan')
    expect(statusViewOf('flow')).toBe('flow')
    expect(statusViewOf('nope')).toBeUndefined()
  })
})
