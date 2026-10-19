import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as paths from '../../src/engine/paths'
import { withSandbox } from '../helpers/sandbox'
import { write } from '../workflow/fixture'

const SCRIPT = join(paths.repoRoot(), 'canonical', 'skills', 'dead-code', 'scripts', 'graph-candidates.ts')
const PLATFORM = `codegraph-${process.platform}-${process.arch}`

const FAKE_SDK = `
const fs = require('fs')
class CodeGraph {
  static async open(root, opts) {
    if (process.env.FAKE_CG_LOG) fs.writeFileSync(process.env.FAKE_CG_LOG, JSON.stringify({ root, opts }))
    if (process.env.FAKE_CG_OPEN_FAIL === '1') throw new Error('unable to open database file')
    return new CodeGraph()
  }
  getIndexState() { return process.env.FAKE_CG_STATE || 'complete' }
  isIndexStale() { return process.env.FAKE_CG_STALE === '1' }
  getPendingReferenceCount() { return Number(process.env.FAKE_CG_PENDING || '0') }
  getIndexBuildInfo() { return { version: '9.9.9', extractionVersion: 1 } }
  findDeadCode() {
    return [
      { name: 'rawOne', kind: 'function', filePath: 'src/a.ts', startLine: 3, endLine: 5 },
      { name: 'inTests', kind: 'function', filePath: 'tests/a.test.ts', startLine: 1, endLine: 1 },
    ]
  }
  close() { if (process.env.FAKE_CG_CLOSED) fs.writeFileSync(process.env.FAKE_CG_CLOSED, 'closed') }
}
module.exports = { CodeGraph }
`

const FAKE_REPORT = `
exports.buildDeadCodeReport = (cg, q) => {
  if (process.env.FAKE_CG_QUERY) require('fs').writeFileSync(process.env.FAKE_CG_QUERY, JSON.stringify(q))
  return {
    entries: [
      { node: { name: 'orphan', kind: 'function', qualifiedName: 'orphan', filePath: 'src/util/a.ts', startLine: 3, endLine: 4 }, members: [], lines: 2, exported: false },
      { node: { name: 'Gone', kind: 'class', filePath: 'src/util/gen/b.ts', startLine: 1, endLine: 9 }, members: [{}, {}], lines: 9, exported: false },
      { node: { name: 'other', kind: 'method', filePath: 'lib/c.ts', startLine: 7, endLine: 7 }, members: [], lines: 1, exported: false },
    ],
    total: 3, candidates: 12, excluded: { exported: 5, tests: 4 }, corroborated: true, bounded: false,
  }
}
`

function fakeSdk(root: string, withReport: boolean): string {
  const dir = join(root, 'sdk', 'node_modules')
  write(join(dir, '@colbymchenry', 'codegraph', 'package.json'), JSON.stringify({ name: '@colbymchenry/codegraph', version: '9.9.9', main: 'index.js' }))
  write(join(dir, '@colbymchenry', 'codegraph', 'index.js'), FAKE_SDK)
  if (withReport) {
    write(join(dir, '@colbymchenry', PLATFORM, 'package.json'), JSON.stringify({ name: `@colbymchenry/${PLATFORM}`, version: '9.9.9' }))
    write(join(dir, '@colbymchenry', PLATFORM, 'lib', 'dist', 'graph', 'dead-code.js'), FAKE_REPORT)
  }
  return dir
}

function project(root: string): string {
  const p = join(root, 'proj')
  write(join(p, '.codegraph', 'codegraph.db'), '')
  write(join(p, 'src', 'util', 'a.ts'), 'x\n')
  return p
}

function run(args: string[], env: Record<string, string> = {}): { code: number, out: Record<string, unknown>, text: string } {
  const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' })
  const text = r.stdout.toString()
  let out: Record<string, unknown> = {}
  try { out = JSON.parse(text) as Record<string, unknown> } catch {  }
  return { code: r.exitCode ?? -1, out, text: text + r.stderr.toString() }
}

describe('dead-code graph-candidates.ts', () => {
  test('opens the index read-only without sync, scopes and excludes the report rows, and closes it', () => withSandbox(({ root }) => {
    const sdk = fakeSdk(root, true)
    const proj = project(root)
    const log = join(root, 'open.json')
    const query = join(root, 'query.json')
    const closed = join(root, 'closed')
    const r = run(['--root', proj, '--scope', 'src/util', '--exclude', 'src/util/gen/**', '--json'], { BURACLE_CODEGRAPH_SDK: sdk, FAKE_CG_LOG: log, FAKE_CG_QUERY: query, FAKE_CG_CLOSED: closed })
    expect(r.code).toBe(0)
    expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual({ root: proj, opts: { sync: false, readOnly: true } })
    expect(JSON.parse(readFileSync(query, 'utf8'))).toMatchObject({ includeExported: false, includeTests: false })
    expect(existsSync(closed)).toBe(true)
    expect(r.out).toMatchObject({
      sdk: { version: '9.9.9', report: 'buildDeadCodeReport' },
      index: { present: true, state: 'complete', stale: false, pendingReferences: 0 },
      total: 1, candidates: 12, excluded: { exported: 5, tests: 4 }, corroborated: true,
      rows: [{ name: 'orphan', kind: 'function', path: 'src/util/a.ts', line: 3, lines: 2, members: 0, exported: false }],
      warnings: [],
    })
    const all = run(['--root', proj, '--limit', '1'], { BURACLE_CODEGRAPH_SDK: sdk })
    expect(all.code).toBe(2)
    expect(all.text).toContain('src/util/a.ts:3  function orphan')
    expect(all.text).toContain('2 more row(s) past --limit 1')
  }))

  test('without buildDeadCodeReport it falls back to the raw list with a warning (exit 2), tests filtered out', () => withSandbox(({ root }) => {
    const sdk = fakeSdk(root, false)
    const r = run(['--root', project(root), '--json'], { BURACLE_CODEGRAPH_SDK: sdk })
    expect(r.code).toBe(2)
    expect(r.out['sdk']).toEqual({ version: '9.9.9', report: 'findDeadCode' })
    expect((r.out['rows'] as Array<{ name: string }>).map(x => x.name)).toEqual(['rawOne'])
    expect((r.out['warnings'] as string[])[0]).toContain('raw unreferenced list')
  }))

  test('index health: a partial, stale or unresolved index warns (exit 2)', () => withSandbox(({ root }) => {
    const sdk = fakeSdk(root, true)
    const r = run(['--root', project(root), '--json'], { BURACLE_CODEGRAPH_SDK: sdk, FAKE_CG_STATE: 'partial', FAKE_CG_STALE: '1', FAKE_CG_PENDING: '4' })
    expect(r.code).toBe(2)
    const w = (r.out['warnings'] as string[]).join('\n')
    expect(w).toContain('index state is partial')
    expect(w).toContain('older extraction engine')
    expect(w).toContain('4 reference(s) were never resolved')
  }))

  test('degrades with exit 2 when there is no index, no SDK or the index cannot be opened; never builds one', () => withSandbox(({ root }) => {
    const bare = join(root, 'bare')
    write(join(bare, 'src', 'a.ts'), 'x\n')
    const none = run(['--root', bare, '--json'], { BURACLE_CODEGRAPH_SDK: fakeSdk(root, true) })
    expect(none.code).toBe(2)
    expect((none.out['warnings'] as string[])[0]).toContain('buracle index ensure --cwd')
    expect(existsSync(join(bare, '.codegraph'))).toBe(false)
    const missing = run(['--root', project(root), '--json'], { BURACLE_CODEGRAPH_SDK: join(root, 'nowhere') })
    expect(missing.code).toBe(2)
    expect((missing.out['warnings'] as string[])[0]).toContain('the codegraph SDK is not available')
    const broken = run(['--root', project(root), '--json'], { BURACLE_CODEGRAPH_SDK: fakeSdk(root, true), FAKE_CG_OPEN_FAIL: '1' })
    expect(broken.code).toBe(2)
    expect((broken.out['warnings'] as string[])[0]).toContain('could not open the codegraph index read-only')
  }))

  test('usage: --help exits 0, a bad option or limit exits 1', () => {
    expect(run(['--help']).code).toBe(0)
    expect(run(['--nope']).code).toBe(1)
    expect(run(['--limit', '0']).code).toBe(1)
  })
})
