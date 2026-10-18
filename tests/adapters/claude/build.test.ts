import { describe, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { realpathSync } from 'node:fs'
import { tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { buildClaude, packageVersion, readTree } from '../../../src/adapters/claude/build'
import { CLASSIC_HOOKS, PLUGIN_NAME } from '../../../src/adapters/claude/constants'
import { RenderError } from '../../../src/adapters/claude/render'
import { devContext } from '../../../src/adapters/claude/dev-build'
import { classicHooks, generatePlugin, matcherOf, mcpJson, splitAlternatives, templateTarget, type GenFile } from '../../../src/adapters/claude/plugin'
import type { CanonicalBundle, HookSpec } from '../../../src/core/catalog'
import type { Harness } from '../../../src/core/events'
import { adapter } from '../../../src/adapters/claude/index'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'

const FIX = join(import.meta.dir, 'fixtures')
const SNAP = join(FIX, 'golden-mini.snap')

const CORE: GenFile[] = [
  { path: 'index.ts', content: "export * from './events'\n" },
  { path: 'events.ts', content: "export type Harness = 'claude'\n" },
  { path: 'notes.md', content: 'not copied\n' },
]
const TEMPLATE: GenFile[] = [
  { path: 'register.tsx', content: "export function register(): void {}\n", mode: 0o644 },
  { path: 'types/index.d.ts', content: 'export type BarModel = { harness: string }\n' },
  { path: 'tests/ping.test.ts', content: "import { test } from 'claude-code/testing'\n" },
  { path: 'core/index.d.ts', content: '// repo-only stand-in\n' },
  { path: 'generated/meta.d.ts', content: '// repo-only stand-in\n' },
  { path: 'tsconfig.json', content: '{}\n' },
]

function miniFiles(): GenFile[] {
  return generatePlugin({ canonical: loadCanonicalSync(join(FIX, 'canonical-mini')), buracleVersion: '9.9.9', coreFiles: CORE, templateFiles: TEMPLATE })
}

function snapshot(files: readonly GenFile[]): string {
  return files.map(f => `===== ${f.path}${f.mode !== undefined ? ` (mode ${f.mode.toString(8)})` : ''} =====\n${f.content}${f.content.endsWith('\n') ? '' : '\n<<no newline at end>>\n'}`).join('')
}

function file(files: readonly GenFile[], path: string): GenFile {
  const f = files.find(x => x.path === path)
  if (!f) throw new Error(`missing ${path}`)
  return f
}

function frontmatter(md: string): Record<string, unknown> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(md)
  if (!m) throw new Error('no frontmatter')
  return parseYaml(m[1] as string) as Record<string, unknown>
}

describe('golden output (canonical-mini)', () => {
  test('matches the committed snapshot', () => {
    const text = snapshot(miniFiles())
    if (process.env['UPDATE_GOLDEN'] === '1') writeFileSync(SNAP, text)
    expect(text).toBe(readFileSync(SNAP, 'utf8'))
  })

  test('is deterministic', () => {
    expect(snapshot(miniFiles())).toBe(snapshot(miniFiles()))
  })

  test('skill frontmatter: Claude keys only, explicit → disable-model-invocation', () => {
    const files = miniFiles()
    const alpha = frontmatter(file(files, 'skills/alpha/SKILL.md').content)
    expect(Object.keys(alpha)).toEqual(['name', 'description', 'when_to_use', 'argument-hint', 'disable-model-invocation'])
    expect(alpha['name']).toBe('alpha')
    expect(alpha['argument-hint']).toBe('<task>')
    expect(alpha['disable-model-invocation']).toBe(true)
    const beta = frontmatter(file(files, 'skills/beta/SKILL.md').content)
    expect(beta).toEqual({ name: 'beta', description: 'Beta helper: true: it answers yes/no questions about the repo # with a hash', 'user-invocable': false })
  })

  test('skill body: placeholders, code spans, escapes and harness blocks', () => {
    const body = file(miniFiles(), 'skills/alpha/SKILL.md').content
    expect(body).toContain('Track the phases with `TodoWrite` (or `TaskCreate`/`TaskUpdate`, whichever this session has, if any). Ask with `AskUserQuestion`: 2 to 4 options.')
    expect(body).toContain('Launch `buracle:reviewer` with the `Agent` tool, then continue in `/buracle:beta`.')
    expect(body).toContain('Inline code keeps one span: `/alpha <task>` and `AskUserQuestion`.')
    expect(body).toContain('A literal placeholder stays literal: {{ask_user}} and {{skill:alpha}}.')
    expect(body).toContain('Unknown placeholders are left alone: {{nope}} and {{skill:Bad Id}}.')
    expect(body).toContain('```text\nburacle:reviewer\nplan_file: docs/plans/x.md\n```')
    expect(body).toContain('\nClaude block line.\nInline claude marker.\n')
    expect(body).not.toContain('Codex block line')
    expect(body).not.toContain('omp block line')
    expect(body).not.toContain('<!--')
  })

  test('every .md in the skill folder is rendered; scripts and evals are copied with modes', () => {
    const files = miniFiles()
    expect(file(files, 'skills/alpha/references/ref.md').content).toBe('# Reference\n\nPhase notes: ask with `AskUserQuestion`, track with `TodoWrite` (or `TaskCreate`/`TaskUpdate`, whichever this session has, if any).\n')
    const script = file(files, 'skills/alpha/scripts/run.sh')
    expect(script.mode).toBe(0o755)
    expect(script.content).toContain('{{ask_user}}')
    expect(file(files, 'skills/alpha/evals/cases.json').content).toContain('"skill:alpha": true')
  })

  test('agent: abstract tools mapped, read-only writes disallowed, model for claude', () => {
    const md = file(miniFiles(), 'agents/reviewer.md').content
    const fm = frontmatter(md)
    expect(fm).toEqual({
      name: 'reviewer',
      description: 'Read-only reviewer for the golden test. Launch it from `/alpha` after implementation.',
      tools: 'Read, Bash, mcp__plugin_buracle_docs__*',
      disallowedTools: 'Write, Edit, NotebookEdit',
      model: 'sonnet',
    })
    expect(md).toContain('use `AskUserQuestion` never')
  })

  test('.mcp.json: claude servers only, pinned, env forwarded, Buracle servers through bun and the plugin\'s launcher, critical ones always loaded', () => {
    const mcp = JSON.parse(file(miniFiles(), '.mcp.json').content) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(Object.keys(mcp.mcpServers)).toEqual(['buracle-memory', 'docs', 'examples'])
    expect(mcp.mcpServers['docs']).toEqual({ command: 'npx', args: ['-y', '@acme/docs-mcp@1.2.3'], env: { DOCS_TOKEN: '${ACME_DOCS_TOKEN}', MODE: 'stdio' }, alwaysLoad: true })
    expect(mcp.mcpServers['examples']).toEqual({ type: 'http', url: 'https://mcp.example.com' })
    expect(mcp.mcpServers['buracle-memory']).toEqual({ command: 'bun', args: ['${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts', 'mcp', 'memory'], alwaysLoad: true })
    expect(file(miniFiles(), 'bin/buracle').content).toContain('b="${BURACLE_HOME:-$HOME/.buracle}/bin/buracle"')
    expect(JSON.stringify(mcp)).not.toContain('/.buracle/bin/buracle')
  })

  test('template: register.tsx, types, tests and README copied; repo-only stand-ins are not', () => {
    const files = miniFiles()
    const paths_ = files.map(f => f.path)
    expect(paths_).toContain('hooks/register.tsx')
    expect(paths_).toContain('types/index.d.ts')
    expect(paths_).toContain('tests/ping.test.ts')
    expect(paths_.filter(p => p.endsWith('.d.ts'))).toEqual(['types/index.d.ts'])
    expect(paths_).not.toContain('tsconfig.json')
    expect(templateTarget('README.md')).toBe('README.md')
    expect(templateTarget('core/index.d.ts')).toBeUndefined()
    expect(templateTarget('generated/routing.d.ts')).toBeUndefined()
    expect(JSON.parse(file(files, 'hooks/hooks.json').content).modules).toEqual(['./register.tsx'])
    expect(JSON.parse(file(files, '.claude-plugin/plugin.json').content).types).toBe('./types/index.d.ts')
  })

  test('without a template: no module, no types entry, generated README (English)', () => {
    const files = generatePlugin({ canonical: loadCanonicalSync(join(FIX, 'canonical-mini')), buracleVersion: '9.9.9', coreFiles: CORE, templateFiles: [] })
    const hooks = JSON.parse(file(files, 'hooks/hooks.json').content) as Record<string, unknown>
    expect('modules' in hooks).toBe(false)
    expect('types' in JSON.parse(file(files, '.claude-plugin/plugin.json').content)).toBe(false)
    const readme = file(files, 'README.md').content
    expect(readme).toStartWith('# buracle (Claude Code plugin)\n')
    expect(readme).toContain('there is no template yet, so this build loads no mod')
    expect(readme).toContain('buracle-memory (always loaded)')
    expect(readme).not.toMatch(/[çğıöşüÇĞİÖŞÜ]/)
  })

  test('hooks/core is a verbatim copy of the .ts files', () => {
    const files = miniFiles()
    expect(file(files, 'hooks/core/index.ts').content).toBe(CORE[0]?.content as string)
    expect(files.some(f => f.path === 'hooks/core/notes.md')).toBe(false)
  })

  test('generated modules: only what the mod imports (catalog and meta)', () => {
    const files = miniFiles()
    expect(files.filter(f => f.path.startsWith('hooks/generated/')).map(f => f.path)).toEqual(['hooks/generated/catalog.ts', 'hooks/generated/meta.ts'])
    const catalog = file(files, 'hooks/generated/catalog.ts').content
    expect(catalog).toContain('"^mcp__plugin_buracle_buracle-memory__"')
    expect(catalog).toContain('"^mcp__plugin_buracle_docs__"')
    expect(catalog).not.toContain('codex-only')
    expect(catalog).toContain('"lint-lsp@acme-market"')
    expect(catalog).not.toContain('off-plugin')
    const meta = file(files, 'hooks/generated/meta.ts').content
    expect(meta).toMatch(/"contentHash": "[0-9a-f]{64}"/)
    expect(meta).toContain('"buracleVersion": "9.9.9"')
    for (const f of files.filter(x => x.path.startsWith('hooks/generated/'))) {
      const imports = f.content.split('\n').filter(l => l.startsWith('import'))
      for (const l of imports) expect(l).toMatch(/^import type \{ [A-Za-z, ]+ \} from '\.\.\/core\/index'$/)
    }
  })
})

describe('classic fallback hooks from canonical/hooks.yaml', () => {
  const spec = (id: string, claude: unknown): HookSpec => ({ id, name: id, blocking: 'none', failure: 'open', bindings: { claude } as HookSpec['bindings'], contract_test: '' } as HookSpec)
  const bundle = (hooks: HookSpec[]): CanonicalBundle => ({ ...loadCanonicalSync(join(FIX, 'canonical-mini')), hooks: { hooks } })

  test('one handler per event and async-ness: the union of the matchers, the largest timeout, lifecycle order', () => {
    const c = bundle([
      spec('H08', { event: 'classic.Stop', timeoutMs: 15000 }),
      spec('H11', { event: 'classic.Stop', timeoutMs: 9000 }),
      spec('H01', { event: 'classic.PreToolUse', matcher: 'Bash', timeoutMs: 10000 }),
      spec('H02', { event: 'classic.PreToolUse', matcher: 'Edit|Write', timeoutMs: 12000 }),
      spec('H14', { event: 'classic.PostToolUse', matcher: 'mcp__.*', async: true, timeoutMs: 5000, also: [{ event: 'classic.SessionEnd', timeoutMs: 2500 }] }),
      spec('H04', { event: 'classic.PostToolUse', matcher: 'Edit', timeoutMs: 30000 }),
      spec('H05', { event: 'session.measure' }),
      spec('H06', { event: 'classic.PreCompact', matcher: 'auto', also: [{ event: 'classic.PreCompact' }, { event: 'session.compact' }] }),
      spec('H07', { event: 'classic.SessionStart', matcher: 'compact', timeoutMs: 10000 }),
      spec('H13', { event: 'classic.SessionStart', timeoutMs: 10000 }),
    ])
    expect(classicHooks(c)).toEqual([
      { event: 'SessionStart', timeout: 10 },
      { event: 'PreToolUse', matcher: 'Bash|Edit|Write|Monitor', timeout: 12 },
      { event: 'PostToolUse', matcher: 'Edit', timeout: 30 },
      { event: 'PostToolUse', matcher: 'mcp__.*', timeout: 5, async: true },
      { event: 'PreCompact', timeout: 10 },
      { event: 'Stop', timeout: 15 },
      { event: 'SessionEnd', timeout: 3 },
    ])
  })

  test('legacy fallback bindings still count and merge with the classic ones', () => {
    const c = bundle([
      spec('H01', { event: 'tool.call', fallback: { event: 'PreToolUse', matcher: 'Bash' } }),
      spec('H02', { fallback: { event: 'PreToolUse', matcher: 'Edit|Write|NotebookEdit', timeoutMs: 12000 } }),
      spec('H09', { event: 'classic.PreToolUse', matcher: 'AskUserQuestion' }),
    ])
    expect(classicHooks(c)).toEqual([{ event: 'PreToolUse', matcher: 'Bash|Edit|Write|NotebookEdit|AskUserQuestion|Monitor', timeout: 12 }])
  })

  test('names next to a pattern are anchored, so Claude Code (which tests such a matcher as an unanchored RegExp) starts the hook only for the named tools', () => {
    const c = bundle([
      spec('H01', { event: 'classic.PreToolUse', matcher: 'Bash|Write', timeoutMs: 10000 }),
      spec('H24', { event: 'classic.PreToolUse', matcher: 'Skill|mcp__plugin_buracle_.*', timeoutMs: 10000 }),
      spec('H25', { event: 'classic.UserPromptExpansion', matcher: '^buracle:(?:spec|build)$', timeoutMs: 5000 }),
    ])
    const [upe, pre] = classicHooks(c)
    expect(pre).toEqual({ event: 'PreToolUse', matcher: '^(?:Bash|Write|Skill|Monitor)$|mcp__plugin_buracle_.*', timeout: 10 })
    expect(upe).toEqual({ event: 'UserPromptExpansion', matcher: '^buracle:(?:spec|build)$', timeout: 5 })
    const fires = (m: string, name: string) => new RegExp(m).test(name)
    for (const name of ['Bash', 'Monitor', 'Write', 'Skill', 'mcp__plugin_buracle_semble__search']) expect(fires(pre?.matcher as string, name), name).toBe(true)
    for (const name of ['TodoWrite', 'NotebookEdit', 'BashOutput', 'mcp__other__x']) expect(fires(pre?.matcher as string, name), name).toBe(false)
    expect(matcherOf(['Edit', 'Write'])).toBe('Edit|Write')
    expect(splitAlternatives('a|(b|c)|[|]|d\\|e')).toEqual(['a', '(b|c)', '[|]', 'd\\|e'])
  })

  test('without fallbacks in the matrix the built-in set is used; malformed ones fail the build', () => {
    const builtIn = classicHooks(bundle([]))
    expect(builtIn.map(h => h.event)).toEqual(['SessionStart', 'UserPromptExpansion', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd'])
    expect(builtIn.map(h => h.timeout)).toEqual(CLASSIC_HOOKS.map(h => h.timeout))
    expect(builtIn.find(h => h.event === 'PreToolUse')?.matcher).toBe('^(?:Bash|Monitor|Edit|Write|MultiEdit|NotebookEdit|WebSearch|WebFetch|AskUserQuestion|Grep|Glob|Skill)$|mcp__.*')
    expect(() => classicHooks(bundle([spec('H01', { fallback: { event: 'tool.call' } })]))).toThrow(RenderError)
    expect(() => classicHooks(bundle([spec('H01', { fallback: { event: 'PreToolUse', matcher: { tool: 'Bash' } } })]))).toThrow(/matcher must be a string/)
    expect(() => classicHooks(bundle([spec('H01', { event: 'classic.pre-tool' })]))).toThrow(RenderError)
  })
})

describe('real repository build', () => {
  const ctx = devContext()
  let first: GenFile[] = []

  test('build(ctx) is deterministic', async () => {
    first = await adapter.build(ctx)
    const second = await adapter.build(ctx)
    expect(snapshot(second)).toBe(snapshot(first))
    expect(first.map(f => f.path)).toEqual([...first.map(f => f.path)].sort())
  })

  test('output holds no machine-specific absolute path', async () => {
    const files = first.length > 0 ? first : await buildClaude(ctx)
    const needles = [...new Set([ctx.repoRoot, userInfo().homedir, paths.home(), realpathSync(tmpdir())])].filter(n => n.length > 1)
    for (const f of files) for (const n of needles) {
      if (f.content.includes(n)) throw new Error(`${f.path} contains ${n}`)
    }
  })

  test('every canonical skill and agent is rendered without leftover placeholders or markers', async () => {
    const files = first.length > 0 ? first : await buildClaude(ctx)
    for (const s of ctx.canonical.skills) {
      const fm = frontmatter(file(files, `skills/${s.id}/SKILL.md`).content)
      expect(fm['name']).toBe(s.id)
      expect(typeof fm['description']).toBe('string')
      expect(fm['disable-model-invocation'] === true).toBe(s.frontmatter['invocation'] === 'explicit')
      for (const cf of s.files) {
        const out = file(files, `skills/${s.id}/${cf.path}`)
        if (!cf.path.endsWith('.md')) { expect(out.content).toBe(cf.content); continue }
        const escaped = (cf.content.match(/\\\{\{/g) ?? []).length
        expect((out.content.match(/\{\{/g) ?? []).length).toBe(escaped)
        expect(out.content).not.toMatch(/<!--\s*\/?harness/)
      }
    }
    for (const a of ctx.canonical.agents) {
      const fm = frontmatter(file(files, `agents/${a.id}.md`).content)
      expect(fm['name']).toBe(a.id)
      expect(String(fm['tools'])).toContain('Read')
      if (a.frontmatter['access'] !== 'read-write') expect(fm['disallowedTools']).toBe('Write, Edit, NotebookEdit')
    }
  })

  test('plugin manifest, hooks, settings, MCP servers and bin shims', async () => {
    const files = first.length > 0 ? first : await buildClaude(ctx)
    const manifest = JSON.parse(file(files, '.claude-plugin/plugin.json').content) as Record<string, unknown>
    expect(manifest['name']).toBe(PLUGIN_NAME)
    expect(manifest['version']).toBe(packageVersion(ctx.repoRoot))
    expect(manifest['version']).toMatch(/^\d+\.\d+\.\d+/)
    expect(typeof manifest['description']).toBe('string')
    expect(manifest['author']).toEqual({ name: 'burakarslan0110' })

    const hooks = JSON.parse(file(files, 'hooks/hooks.json').content) as { modules?: string[], hooks: Record<string, Array<{ matcher?: string, hooks: Array<Record<string, unknown>> }>> }
    const classic = classicHooks(ctx.canonical)
    expect(classic.map(h => h.event)).toEqual(['SessionStart', 'UserPromptExpansion', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'Stop', 'SubagentStart', 'SubagentStop', 'SessionEnd', 'PostToolUseFailure', 'PostToolUseFailure'])
    expect(classic.find(h => h.event === 'SubagentStart')).toEqual({ event: 'SubagentStart', timeout: 5 })
    const fires = (m: string | undefined, name: string): boolean => m === undefined || (/^[A-Za-z0-9_ ,|-]+$/.test(m) ? m.split(/[|,]/).map(x => x.trim()).includes(name) : new RegExp(m).test(name))
    const pre = classic.find(h => h.event === 'PreToolUse')?.matcher
    for (const t of ['Bash', 'Monitor', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'WebSearch', 'WebFetch', 'AskUserQuestion', 'Skill', 'Grep', 'Glob', 'mcp__plugin_buracle_codegraph__codegraph_explore', 'mcp__plugin_buracle_semble__search']) expect(fires(pre, t), `PreToolUse ${t}`).toBe(true)
    for (const t of ['mcp__claude_ai_Gmail__authenticate']) expect(fires(pre, t), `PreToolUse ${t}`).toBe(true)
    for (const t of ['TodoWrite', 'Read', 'Agent']) expect(fires(pre, t), `PreToolUse ${t}`).toBe(false)
    const post = classic.filter(h => h.event === 'PostToolUse')
    const sync = post.find(h => h.async !== true)?.matcher
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode', 'AskUserQuestion']) expect(fires(sync, t), `PostToolUse ${t}`).toBe(true)
    for (const t of ['Read', 'Bash', 'TodoWrite']) expect(fires(sync, t), `PostToolUse ${t}`).toBe(false)
    const async_ = post.find(h => h.async === true)?.matcher
    for (const t of ['TodoWrite', 'TaskCreate', 'TaskUpdate', 'Bash', 'Monitor', 'WebSearch', 'WebFetch', 'Read', 'Skill', 'mcp__plugin_buracle_context7__query-docs']) expect(fires(async_, t), `async PostToolUse ${t}`).toBe(true)
    for (const t of ['Glob', 'Grep', 'EnterPlanMode', 'Agent', 'EnterWorktree']) expect(fires(async_, t), `async PostToolUse ${t}`).toBe(true)
    for (const t of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'ExitPlanMode', 'AskUserQuestion', 'ReadMcpResourceTool']) expect(fires(async_, t), `async PostToolUse ${t}`).toBe(false)
    const failure = classic.find(h => h.event === 'PostToolUseFailure')
    expect(failure).toEqual({ event: 'PostToolUseFailure', matcher: 'mcp__plugin_buracle_.*', timeout: 5 })
    for (const t of ['mcp__plugin_buracle_web-search__search', 'mcp__plugin_buracle_web-fetch__fetch_url']) expect(fires(failure?.matcher, t), `PostToolUseFailure ${t}`).toBe(true)
    for (const t of ['Bash', 'WebSearch', 'mcp__claude_ai_Gmail__search_threads']) expect(fires(failure?.matcher, t), `PostToolUseFailure ${t}`).toBe(false)
    const cmFailure = classic.filter(h => h.event === 'PostToolUseFailure').find(h => h.async === true)
    expect(cmFailure?.async).toBe(true)
    for (const t of ['Bash', 'Monitor', 'Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep', 'Agent', 'Skill']) expect(fires(cmFailure?.matcher, t), `async PostToolUseFailure ${t}`).toBe(true)
    for (const t of ['WebSearch', 'mcp__plugin_buracle_web-fetch__fetch_url']) expect(fires(cmFailure?.matcher, t), `async PostToolUseFailure ${t}`).toBe(false)
    const upe = classic.find(h => h.event === 'UserPromptExpansion')
    expect(upe?.matcher).toBe('^buracle:')
    for (const name of ['buracle:plan-build', 'buracle:new-skill']) expect(fires(upe?.matcher, name), `UserPromptExpansion ${name}`).toBe(true)
    for (const name of ['simplify', 'my-skill', 'other:buracle:plan-build', 'review']) expect(fires(upe?.matcher, name), `UserPromptExpansion ${name}`).toBe(false)
    for (const h of classic.filter(x => !['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptExpansion'].includes(x.event))) expect(h.matcher).toBeUndefined()
    expect(Object.keys(hooks.hooks)).toEqual([...new Set(classic.map(h => h.event))])
    for (const h of classic) {
      const group = hooks.hooks[h.event]?.find(g => g.matcher === h.matcher)
      expect(group?.matcher).toBe(h.matcher)
      const handler: Record<string, unknown> = { type: 'command', command: `"\${CLAUDE_PLUGIN_ROOT}/bin/buracle" hook claude ${h.event}`, timeout: h.timeout }
      if (h.async === true) handler['async'] = true
      expect(group?.hooks).toEqual([handler])
      expect(h.timeout).toBeGreaterThanOrEqual(1)
    }
    if (files.some(f => f.path === 'hooks/register.tsx')) expect(hooks.modules).toEqual(['./register.tsx'])

    const settings = JSON.parse(file(files, 'settings.json').content) as Record<string, unknown>
    for (const k of Object.keys(settings)) expect(['agent', 'subagentStatusLine']).toContain(k)

    const mcp = JSON.parse(file(files, '.mcp.json').content) as { mcpServers: Record<string, Record<string, unknown>> }
    const expected = Object.keys(ctx.canonical.mcp.servers).filter(id => ctx.canonical.mcp.servers[id]?.harnesses.includes('claude')).sort()
    expect(Object.keys(mcp.mcpServers)).toEqual(expected)
    expect(JSON.stringify(mcp)).not.toContain('{version}')
    expect(JSON.stringify(mcp)).not.toContain('{buracle}')
    for (const [id, entry] of Object.entries(mcp.mcpServers)) {
      if (entry['type'] === 'http') continue
      expect(entry['command'], id).toBe('bun')
      const args = entry['args'] as string[]
      expect(args[0]).toBe('${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts')
      expect(args.slice(1)).toEqual(id === 'buracle-memory' ? ['mcp', 'memory'] : ['mcp', 'run', id])
    }

    const lsp = JSON.parse(file(files, '.lsp.json').content) as Record<string, { command: string, args: string[], extensionToLanguage: Record<string, string> }>
    const lspIds = ctx.canonical.tools.tools.flatMap(t => (t.lsp !== undefined ? [t.lsp.id] : [])).sort()
    expect(Object.keys(lsp)).toEqual(lspIds)
    for (const id of lspIds) {
      expect(lsp[id]?.command).toBe('bun')
      expect(lsp[id]?.args).toEqual(['${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts', 'lsp', 'run', id])
      for (const ext of Object.keys(lsp[id]?.extensionToLanguage ?? {})) expect(ext).toMatch(/^\.[a-z]+$/)
    }

    const sh = file(files, 'bin/buracle')
    expect(sh.mode).toBe(0o755)
    expect(sh.content.startsWith('#!/bin/sh\n')).toBe(true)
    expect(sh.content).toContain('if [ -x "$b" ]; then exec "$b" "$@"; fi')
    expect(sh.content).toContain('exec bun "$d/buracle.ts" "$@"')
    expect(sh.content).toContain('if [ "$3" = PreToolUse ]; then printf')
    expect(sh.content).toContain('"permissionDecision":"deny"')
    const launcher = file(files, 'bin/buracle.ts')
    expect(launcher.mode).toBe(0o755)
    expect(launcher.content.startsWith('#!/usr/bin/env bun\n')).toBe(true)
    expect(launcher.content).toContain('process.exit(await runProcess(argv))')
    expect(launcher.content).toContain('const root = shimTree() ?? checkout()')
    expect(launcher.content).toContain("if (argv[0] === 'hook') failHook('no Buracle runtime or checkout was found')")
    expect(file(files, 'bin/buracle.cmd').content).toContain('bun "%~dp0buracle.ts" %*\r\n')
    expect(files.some(f => f.path === 'bin/buracle-hook')).toBe(false)
  })

  test('hooks/core mirrors src/core (.ts only)', async () => {
    const files = first.length > 0 ? first : await buildClaude(ctx)
    const core = readTree(join(ctx.repoRoot, 'src', 'core'), rel => rel.endsWith('.ts'))
    const copied = files.filter(f => f.path.startsWith('hooks/core/'))
    expect(copied.map(f => f.path)).toEqual(core.map(f => `hooks/core/${f.path}`))
    for (const c of core) expect(file(files, `hooks/core/${c.path}`).content).toBe(c.content)
  })

  test('no short-alias module: Claude Code reserves a plugin skill\'s bare name for that skill (D4)', async () => {
    const files = first.length > 0 ? first : await buildClaude(ctx)
    expect(files.some(f => f.path === 'hooks/generated/aliases.ts')).toBe(false)
    expect(files.filter(f => f.path.startsWith('hooks/generated/')).map(f => f.path)).toEqual(['catalog', 'meta'].map(n => `hooks/generated/${n}.ts`))
    const mod = files.find(f => f.path === 'hooks/register.tsx')?.content ?? ''
    for (const m of mod.matchAll(/from '\.\/generated\/([a-z-]+)'/g)) expect(['catalog', 'meta']).toContain(m[1] as string)
  })

  test('.mcp.json: every critical server loads upfront (alwaysLoad: true), the others stay behind tool search', async () => {
    const files = first.length > 0 ? first : await buildClaude(ctx)
    const mcp = JSON.parse(file(files, '.mcp.json').content) as { mcpServers: Record<string, Record<string, unknown>> }
    for (const [id, entry] of Object.entries(mcp.mcpServers)) {
      const critical = ctx.canonical.mcp.servers[id]?.critical === true
      expect(entry['alwaysLoad'], id).toBe(critical ? true : undefined)
    }
    expect(Object.entries(mcp.mcpServers).filter(([, e]) => e['alwaysLoad'] === true).map(([id]) => id)).toEqual(expect.arrayContaining(['buracle-memory', 'codegraph', 'context7', 'semble']))
  })

  test('.mcp.json: context-mode with its Claude platform and no timeout (Claude Code\'s own limit is longer than its 600 s); no tool lists (Claude cannot filter a server\'s tools)', async () => {
    const files = first.length > 0 ? first : await buildClaude(ctx)
    const mcp = JSON.parse(file(files, '.mcp.json').content) as { mcpServers: Record<string, Record<string, unknown>> }
    expect(mcp.mcpServers['context-mode']).toEqual({
      command: 'bun',
      args: ['${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts', 'mcp', 'run', 'context-mode'],
      env: { CONTEXT_MODE_PLATFORM: 'claude-code' },
      alwaysLoad: true,
    })
  })

  test('.mcp.json from the mcp.yaml fields: env plus harness_env.claude only, ${ENV:NAME} forwarded; tool_timeout_sec only above Claude Code\'s MCP_TOOL_TIMEOUT default (100,000,000 ms) or with tool_timeout_hard, on stdio and http', () => {
    const base = { description: 'd', harnesses: ['claude', 'codex'] as Harness[], pin: 'latest' as const, critical: false, routing: [] }
    const mcp = mcpJson({
      servers: {
        sandbox: {
          ...base, transport: 'stdio', package: { registry: 'npm', name: 'sandbox-mcp', version: 'latest', runtime: 'bun', scripts: false },
          env: { SHARED: '1' }, harness_env: { claude: { WHO: 'claude', TOKEN: '${ENV:SANDBOX_TOKEN}' }, codex: { WHO: 'codex' } },
          tool_timeout_sec: 90, enabled_tools: ['run'], disabled_tools: ['upgrade'],
        },
        remote: { ...base, transport: 'http', url: 'https://mcp.example.com', tool_timeout_sec: 5 },
        atDefault: { ...base, transport: 'http', url: 'https://a.example.com', tool_timeout_sec: 100_000 },
        longer: { ...base, transport: 'stdio', command: 'long-mcp', tool_timeout_sec: 100_001 },
        capped: { ...base, transport: 'stdio', command: 'fetch-mcp', tool_timeout_sec: 180, tool_timeout_hard: true },
        softCap: { ...base, transport: 'http', url: 'https://s.example.com', tool_timeout_sec: 180, tool_timeout_hard: false },
        elsewhere:{ ...base, harnesses: ['codex'], transport: 'stdio', package: { registry: 'npm', name: 'x', version: 'latest' }, harness_env: { codex: { A: '1' } } },
      },
    })
    expect(mcp).toEqual({
      mcpServers: {
        atDefault: { type: 'http', url: 'https://a.example.com' },
        capped: { command: 'fetch-mcp', timeout: 180_000 },
        longer: { command: 'long-mcp', timeout: 100_001_000 },
        remote: { type: 'http', url: 'https://mcp.example.com' },
        softCap: { type: 'http', url: 'https://s.example.com' },
        sandbox: { command: 'bun', args: ['${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts', 'mcp', 'run', 'sandbox'], env: { SHARED: '1', TOKEN: '${SANDBOX_TOKEN}', WHO: 'claude' } },
      },
    })
  })

  test('agents list only tools Claude Code 2.1.293 registers (no Grep or Glob)', async () => {
    const files = first.length > 0 ? first : await buildClaude(ctx)
    for (const a of ctx.canonical.agents) {
      const tools = String(frontmatter(file(files, `agents/${a.id}.md`).content)['tools']).split(',').map(t => t.trim())
      expect(tools.filter(t => t === 'Grep' || t === 'Glob')).toEqual([])
      expect(tools.filter(t => !t.startsWith('mcp__plugin_buracle_'))).toEqual(expect.arrayContaining(['Read', 'Bash']))
    }
  })

  test('the repo-root marketplace serves ./harness/claude', () => {
    const m = JSON.parse(readFileSync(join(ctx.repoRoot, '.claude-plugin', 'marketplace.json'), 'utf8')) as Record<string, unknown>
    expect(m['name']).toBe('buracle')
    expect(m['owner']).toEqual({ name: 'burakarslan0110' })
    expect(typeof m['description']).toBe('string')
    expect(m['plugins']).toEqual([{ name: 'buracle', source: './harness/claude', description: expect.any(String) }])
  })
})
