import { describe, expect, test } from 'bun:test'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import ts from 'typescript'
import { buildClaude } from '../../../src/adapters/claude/build'
import { devContext } from '../../../src/adapters/claude/dev-build'
import { assembleFiles, driftOf, writeAssembly } from '../../../src/adapters/claude/template/dev-assemble'
import { KEEPS_MODES } from '../../helpers/fake-exe'
import { withSandbox } from '../../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..', '..')
const TEMPLATE = join(REPO, 'src', 'adapters', 'claude', 'template')

function walk(dir: string, rel = ''): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name)
    const relPath = rel === '' ? name : `${rel}/${name}`
    if (statSync(abs).isDirectory()) out.push(...walk(abs, relPath))
    else out.push(relPath)
  }
  return out
}

describe('dev-assemble', () => {
  test('the assembly is what `buracle build` writes to harness/claude', async () => {
    const built = await buildClaude(devContext())
    expect(assembleFiles(REPO)).toEqual(built)
  })

  test('the assembly is deterministic, in memory and on disk', async () => {
    const first = assembleFiles(REPO)
    expect(assembleFiles(REPO)).toEqual(first)
    await withSandbox(({ root }) => {
      const a = join(root, 'a')
      const b = join(root, 'b')
      writeAssembly(a, first)
      writeAssembly(b, assembleFiles(REPO))
      const files = walk(a)
      expect(walk(b)).toEqual(files)
      for (const file of files) expect(readFileSync(join(b, file))).toEqual(readFileSync(join(a, file)))
      if (KEEPS_MODES) expect(statSync(join(a, 'bin', 'buracle')).mode & 0o111).not.toBe(0)
    })
  })

  test('it holds every file the internal contract names; template and core are copied verbatim', () => {
    const files = new Map(assembleFiles(REPO).map(f => [f.path, f.content]))
    for (const path of ['.claude-plugin/plugin.json', 'hooks/hooks.json', 'hooks/register.tsx', 'types/index.d.ts', 'README.md', 'tests/register.test.tsx', 'tests/band.test.tsx', 'hooks/generated/catalog.ts', 'hooks/generated/meta.ts']) {
      expect(files.has(path), path).toBe(true)
    }
    expect(files.has('hooks/generated/aliases.ts')).toBe(false)
    const hooks = JSON.parse(files.get('hooks/hooks.json') ?? '{}') as { modules?: string[], hooks?: Record<string, unknown> }
    expect(hooks.modules).toEqual(['./register.tsx'])
    expect(Object.keys(hooks.hooks ?? {})).toContain('PreToolUse')
    const manifest = JSON.parse(files.get('.claude-plugin/plugin.json') ?? '{}') as Record<string, unknown>
    expect(manifest['name']).toBe('buracle')
    expect(manifest['types']).toBe('./types/index.d.ts')
    const core = walk(join(REPO, 'src', 'core')).filter(p => p.endsWith('.ts'))
    expect([...files.keys()].filter(p => p.startsWith('hooks/core/')).sort()).toEqual(core.map(p => `hooks/core/${p}`).sort())
    for (const p of core) expect(files.get(`hooks/core/${p}`)).toBe(readFileSync(join(REPO, 'src', 'core', p), 'utf8'))
    expect(files.get('hooks/register.tsx')).toBe(readFileSync(join(TEMPLATE, 'register.tsx'), 'utf8'))
    expect(files.get('types/index.d.ts')).toBe(readFileSync(join(TEMPLATE, 'types', 'index.d.ts'), 'utf8'))
    for (const name of readdirSync(join(TEMPLATE, 'tests'))) expect(files.get(`tests/${name}`)).toBe(readFileSync(join(TEMPLATE, 'tests', name), 'utf8'))
    expect([...files.keys()].some(p => p.endsWith('dev-assemble.ts'))).toBe(false)
  })

  test('generated modules are pure data with type-only imports from ../core/index', () => {
    const generated = assembleFiles(REPO).filter(f => f.path.startsWith('hooks/generated/'))
    expect(generated.length).toBeGreaterThan(0)
    for (const file of generated) {
      const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true)
      for (const statement of source.statements) {
        if (ts.isImportDeclaration(statement)) {
          expect(statement.importClause?.isTypeOnly).toBe(true)
          expect((statement.moduleSpecifier as ts.StringLiteral).text).toBe('../core/index')
          continue
        }
        expect(ts.isVariableStatement(statement), file.path).toBe(true)
      }
    }
  })

  test('the critical MCP tools the mod undefers are anchored to Buracle\'s own plugin servers', () => {
    const catalog = assembleFiles(REPO).find(f => f.path === 'hooks/generated/catalog.ts')?.content ?? ''
    const literal = catalog.slice(catalog.indexOf('= {') + 2).replace(/\s+as\s+[^\n]+\s*$/, '').trim()
    const patterns = (JSON.parse(literal) as { criticalToolPatterns: string[] }).criticalToolPatterns.map(p => new RegExp(p))
    expect(patterns.length).toBeGreaterThan(0)
    const pinned = (tool: string) => patterns.some(p => p.test(tool))
    expect(pinned('mcp__plugin_buracle_context7__query-docs')).toBe(true)
    expect(pinned('mcp__plugin_buracle_buracle-memory__memory_search')).toBe(true)
    expect(pinned('mcp__plugin_buracle_grep__searchGitHub')).toBe(false)
    expect(pinned('mcp__plugin_other_context7__query-docs')).toBe(false)
  })

  test('the output holds no absolute user paths', () => {
    const { homedir, username } = userInfo()
    const userDirs = [homedir, `/Users/${username}`, `/home/${username}`, REPO]
    for (const file of assembleFiles(REPO)) {
      for (const dir of userDirs) expect(file.content.includes(dir), `${file.path} names ${dir}`).toBe(false)
    }
  })

  test('drift is reported, and a re-assembly keeps the files the engine writes', async () => {
    await withSandbox(({ root }) => {
      const out = join(root, 'plugin')
      const files = assembleFiles(REPO)
      writeAssembly(out, files)
      expect(driftOf(out, files)).toEqual([])
      writeFileSync(join(out, 'hooks', 'register.tsx'), '// edited\n')
      writeFileSync(join(out, 'stray.txt'), 'x')
      expect(driftOf(out, files)).toEqual(['hooks/register.tsx', 'stray.txt'])
      mkdirSync(join(out, '.claude-plugin', 'types', 'claude-code'), { recursive: true })
      writeFileSync(join(out, '.claude-plugin', 'types', 'claude-code', 'index.d.ts'), '// engine')
      writeFileSync(join(out, 'tsconfig.json'), '{}')
      writeAssembly(out, files)
      expect(driftOf(out, files)).toEqual([])
      expect(readFileSync(join(out, '.claude-plugin', 'types', 'claude-code', 'index.d.ts'), 'utf8')).toBe('// engine')
      expect(readFileSync(join(out, 'tsconfig.json'), 'utf8')).toBe('{}')
    })
  })
})
