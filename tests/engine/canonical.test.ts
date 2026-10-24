import { describe, expect, test } from 'bun:test'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { catalogMcp, catalogSkills, envRef, expandMcpCommand, mcpEnvFor, validateMcpCatalog, validatePluginsCatalog, validateToolsCatalog, type McpServerSpec } from '../../src/core/catalog'
import { defaultConfig, validateConfig } from '../../src/core/config'
import { CanonicalError, loadCanonicalSync, parseFrontmatter } from '../../src/engine/canonical'
import * as paths from '../../src/engine/paths'
import { withSandbox } from '../helpers/sandbox'

const REAL = paths.canonicalDir()

describe('the real canonical/ tree', () => {
  const bundle = loadCanonicalSync(REAL)

  test('buracle.yaml matches defaultConfig()', () => {
    expect(bundle.config).toEqual(defaultConfig())
    const raw = parseYaml(readFileSync(join(REAL, 'buracle.yaml'), 'utf8')) as unknown
    expect(validateConfig(raw)).toEqual({ ok: true, config: defaultConfig() })
  })

  test('mcp.yaml has the nine servers; packages follow their latest release through the launcher', () => {
    expect(Object.keys(bundle.mcp.servers).sort()).toEqual(['buracle-memory', 'chrome-devtools', 'codegraph', 'context7', 'grep', 'lsp', 'semble', 'web-fetch', 'web-search'])
    const pins = Object.fromEntries(Object.entries(bundle.mcp.servers).map(([id, s]) => [id, s.package ? `${s.package.registry}:${s.package.name}@${s.package.version}` : s.url ?? s.command]))
    expect(pins).toEqual({
      context7: 'npm:@upstash/context7-mcp@latest',
      codegraph: 'npm:@colbymchenry/codegraph@latest',
      'web-search': 'npm:open-websearch@latest',
      'web-fetch': 'npm:fetcher-mcp@latest',
      grep: 'https://mcp.grep.app',
      semble: 'pypi:semble@latest',
      'chrome-devtools': 'npm:chrome-devtools-mcp@latest',
      'buracle-memory': '{buracle}',
      lsp: '{buracle}',
    })
    for (const s of Object.values(bundle.mcp.servers)) if (s.package !== undefined) expect(s.pin).toBe('latest')
    expect(bundle.mcp.servers['grep']?.pin).toBe('monitor')
    expect(bundle.mcp.servers['codegraph']?.env).toEqual({ CODEGRAPH_TELEMETRY: '0', CODEGRAPH_NO_UPDATE_CHECK: '1', CODEGRAPH_MCP_TOOLS: 'explore,search,node,callers,callees,impact,status,files' })
    expect(bundle.mcp.servers['semble']?.package?.extras).toEqual(['mcp'])
    expect(expandMcpCommand(bundle.mcp.servers['codegraph']!, { buracle: '/b', id: 'codegraph' })).toEqual({ command: '/b', args: ['mcp', 'run', 'codegraph'] })
    expect(expandMcpCommand(bundle.mcp.servers['semble']!, { buracle: '/b', id: 'semble' })).toEqual({ command: '/b', args: ['mcp', 'run', 'semble'] })
    expect(expandMcpCommand(bundle.mcp.servers['buracle-memory']!, { buracle: '/h/.buracle/bin/buracle', id: 'buracle-memory' })).toEqual({ command: '/h/.buracle/bin/buracle', args: ['mcp', 'memory'] })
    expect(expandMcpCommand(bundle.mcp.servers['lsp']!, { buracle: '/h/.buracle/bin/buracle', id: 'lsp' })).toEqual({ command: '/h/.buracle/bin/buracle', args: ['lsp', 'mcp'] })
    expect(bundle.mcp.servers['lsp']).toMatchObject({ harnesses: ['codex', 'opencode'], critical: true, pin: 'hard', routing: ['language-server'] })
  })

  test('web-fetch: a 180 s tool timeout that is a wall on every harness (a fetch whose browser never answers ends there)', () => {
    const wf = bundle.mcp.servers['web-fetch']
    expect(wf?.tool_timeout_sec).toBe(180)
    expect(wf?.tool_timeout_hard).toBe(true)
    expect(Object.entries(bundle.mcp.servers).filter(([, s]) => s.tool_timeout_hard === true).map(([id]) => id)).toEqual(['web-fetch'])
  })

  test('plugins.yaml and tools.yaml', () => {
    expect(bundle.plugins.claude.marketplaces).toEqual([{ id: 'claude-plugins-official', source: 'anthropics/claude-plugins-official' }])
    expect(bundle.plugins.claude.plugins).toEqual([])
    expect(bundle.plugins.claude.retired).toEqual(['pyright-lsp@claude-plugins-official', 'typescript-lsp@claude-plugins-official', 'gopls-lsp@claude-plugins-official'])
    expect(bundle.tools.tools.map(t => t.name)).toEqual(['bun', 'git', 'node', 'uv', 'rg', 'ast-grep', 'jq', 'gh', 'tmux', 'ruff', 'shellcheck', 'golangci-lint', 'codegraph', 'semble', 'pyright', 'typescript-language-server', 'gopls', 'rust-analyzer', 'csharp-ls', 'jdtls'])
    expect(bundle.tools.tools.find(t => t.name === 'tmux')?.required).toBe(false)
    expect(bundle.tools.tools.filter(t => t.requires !== undefined).map(t => [t.name, t.requires])).toEqual([['golangci-lint', ['go']]])
    expect(bundle.tools.tools.flatMap(t => (t.lsp !== undefined ? [t.lsp.id] : []))).toEqual(['pyright', 'typescript', 'gopls', 'rust-analyzer', 'csharp-ls', 'jdtls'])
    expect(bundle.tools.tools.filter(t => t.kind === 'lsp' && !t.required).map(t => t.name)).toEqual(['gopls', 'rust-analyzer', 'csharp-ls', 'jdtls'])
    expect(bundle.tools.tools.find(t => t.name === 'jdtls')?.lsp?.startup_timeout_ms).toBe(120000)
    expect(bundle.tools.tools.find(t => t.name === 'csharp-ls')?.dotnet).toBe('csharp-ls')
    expect(bundle.tools.tools.filter(t => t.lsp !== undefined).map(t => [t.lsp?.id, t.lsp?.replaces])).toEqual([
      ['pyright', ['pyright-lsp@claude-plugins-official']],
      ['typescript', ['typescript-lsp@claude-plugins-official']],
      ['gopls', ['gopls-lsp@claude-plugins-official']],
      ['rust-analyzer', ['rust-analyzer-lsp@claude-plugins-official']],
      ['csharp-ls', ['csharp-lsp@claude-plugins-official']],
      ['jdtls', ['jdtls-lsp@claude-plugins-official']],
    ])
    expect(bundle.tools.tools.find(t => t.name === 'typescript-language-server')?.npm_with).toEqual(['typescript@6'])
    const samples: Record<string, [string, string]> = {
      bun: ['1.4.2', '1.4.2'],
      git: ['git version 2.54.0 (Apple Git-157)', '2.54.0'],
      gh: ['gh version 2.80.0 (2026-09-01)\nhttps://github.com/cli/cli/releases/tag/v2.80.0', '2.80.0'],
      jq: ['jq-1.7.1-apple', '1.7.1'],
      rg: ['ripgrep 15.2.0\n\nfeatures:+pcre2', '15.2.0'],
      'ast-grep': ['ast-grep 0.39.5', '0.39.5'],
      node: ['v24.15.0', '24.15.0'],
      uv: ['uv 0.12.23 (Homebrew 2026-09-30)', '0.12.23'],
      tmux: ['tmux 3.5a', '3.5a'],
      ruff: ['ruff 0.14.3', '0.14.3'],
      shellcheck: ['ShellCheck - shell script analysis tool\nversion: 0.10.0\nlicense: GNU General Public License, version 3', '0.10.0'],
      'golangci-lint': ['golangci-lint has version 2.5.0 built with go1.25.1 from ff63786 on 2025-09-21T12:00:00Z', '2.5.0'],
      semble: ['semble 0.6.2', '0.6.2'],
      codegraph: ['1.6.2', '1.6.2'],
      pyright: ['pyright 1.1.414', '1.1.414'],
      'typescript-language-server': ['6.0.1', '6.0.1'],
      gopls: ['golang.org/x/tools/gopls v0.21.0\n    golang.org/x/tools/gopls@v0.21.0 h1:abc=', '0.21.0'],
      'rust-analyzer': ['rust-analyzer 0.0.0 (65ac641199 2026-10-04)', '2026-10-04'],
      'csharp-ls': ['csharp-ls, 0.28.0 (Klebiškis)+72671fc7fa810c158864e72485db68e8b9b25c3d', '0.28.0'],
    }
    expect(new RegExp(bundle.tools.tools.find(t => t.name === 'rust-analyzer')?.version_regex ?? '').exec('rust-analyzer 1.90.0 (1159e78c 2025-09-14)')?.[1]).toBe('2025-09-14')
    expect(new RegExp(bundle.tools.tools.find(t => t.name === 'jdtls')?.version_regex ?? '').exec('usage: jdtls [-h] [--validate-java-version] [--no-validate-java-version]\n             [-data DATA]')).toBeNull()
    for (const t of bundle.tools.tools.filter(t => t.name !== 'jdtls')) {
      const [output, version] = samples[t.name] ?? ['', '']
      expect(new RegExp(t.version_regex).exec(output)?.[1]).toBe(version)
    }
  })

  test('prose documents are parsed (skills carry their files)', () => {
    for (const s of bundle.skills) {
      expect(s.files.some(f => f.path === 'SKILL.md')).toBe(true)
      expect(s.dir).toBe(`skills/${s.id}`)
    }
    for (const r of bundle.rules) expect(['always', 'paths']).toContain(r.scope)
    expect([...bundle.skills.map(s => s.id)]).toEqual([...bundle.skills.map(s => s.id)].sort())
  })

  test('catalog helpers are sorted and filterable', () => {
    const all = catalogMcp(bundle.mcp)
    expect(all.map(m => m.id)).toEqual([...all.map(m => m.id)].sort())
    expect(catalogMcp(bundle.mcp, 'omp').some(m => m.id === 'chrome-devtools')).toBe(false)
    expect(catalogMcp(bundle.mcp, 'claude').some(m => m.id === 'chrome-devtools')).toBe(true)
    const skills = catalogSkills(bundle.skills)
    expect(skills.map(s => s.id)).toEqual(bundle.skills.map(s => s.id).sort())
  })

  test('skills carry their short description, invocation and router triggers', () => {
    const skills = catalogSkills(bundle.skills)
    for (const s of skills) {
      expect({ id: s.id, short: typeof s.short === 'string', invocation: s.invocation === 'explicit' || s.invocation === 'implicit', triggers: (s.triggers?.ask?.length ?? 0) > 0 }).toEqual({ id: s.id, short: true, invocation: true, triggers: true })
    }
    expect(bundle.triggers).toBeDefined()
    expect(bundle.routing.categories.filter(c => c.triggers !== undefined).map(c => c.id).sort()).toEqual(['browser', 'code-examples', 'code-search', 'code-structure', 'language-server', 'library-docs', 'memory', 'web-search'])
  })
})

function fixture(root: string): string {
  const dir = join(root, 'canonical')
  mkdirSync(dir)
  for (const f of ['buracle.yaml', 'mcp.yaml', 'plugins.yaml', 'tools.yaml']) cpSync(join(REAL, f), join(dir, f))
  return dir
}

function problemsOf(fn: () => unknown): string[] {
  try { fn() } catch (e) { if (e instanceof CanonicalError) return e.problems; throw e }
  return []
}

describe('loader on fixture trees', () => {
  test('minimal tree: optional data files are listed as missing', () => withSandbox(({ root }) => {
    const dir = fixture(root)
    const b = loadCanonicalSync(dir)
    expect(b.missing).toEqual(['hooks.yaml', 'routing.yaml', 'skill-triggers.yaml', 'statusline.yaml', 'pricing.yaml', 'notices.yaml'])
    expect(b.notices).toEqual([])
    expect(b.routing).toEqual({ strictness: 'enforce', categories: [] })
    expect(b.hooks).toEqual({ hooks: [] })
    expect(b.skills).toEqual([])
    expect(b.triggers).toBeUndefined()
  }))

  test('skill-triggers.yaml: attached to skills and routing categories, findings are warnings', () => withSandbox(({ root }) => {
    const dir = fixture(root)
    mkdirSync(join(dir, 'skills', 'alpha'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: Alpha workflow\ninvocation: explicit\n---\n# Alpha\n')
    writeFileSync(join(dir, 'routing.yaml'), 'strictness: enforce\ncategories:\n  - { id: library-docs, intent: docs, prefer: [mcp:context7/query-docs], fallback: [], deny_builtin: [], reminder: use context7 }\n')
    writeFileSync(join(dir, 'skill-triggers.yaml'), [
      'version: 1',
      'skills:',
      '  alpha: { ask: { en: [run alpha now], tr: [alpha ile yap] } }',
      '  ghost: { ask: [boo] }',
      'categories:',
      '  library-docs: { topic: [official docs], deps: [api] }',
      '',
    ].join('\n'))
    const b = loadCanonicalSync(dir)
    expect(b.skills[0]?.triggers).toEqual({ ask: ['run alpha now', 'alpha ile yap'] })
    expect(b.triggers?.skills['ghost']).toEqual({ ask: ['boo'] })
    expect(b.routing.categories[0]?.triggers).toEqual({ topic: ['official docs'], deps: ['api'] })
    expect(b.routing.categories[0]?.reminder).toBe('use context7')
    expect(catalogSkills(b.skills)[0]).toEqual({ id: 'alpha', description: 'Alpha workflow', userInvocable: true, invocation: 'explicit', triggers: { ask: ['run alpha now', 'alpha ile yap'] } })
    expect(b.warnings.filter(w => w.startsWith('skill-triggers.yaml'))).toEqual(['skill-triggers.yaml: skills.ghost: no canonical skill has this id'])

    writeFileSync(join(dir, 'skill-triggers.yaml'), '- not a mapping\n')
    expect(problemsOf(() => loadCanonicalSync(dir))).toContain('skill-triggers.yaml: expected a mapping with version, skills and categories')
  }))

  test('required files and YAML syntax', () => withSandbox(({ root }) => {
    const dir = fixture(root)
    rmSync(join(dir, 'tools.yaml'))
    writeFileSync(join(dir, 'plugins.yaml'), 'claude: [unclosed\n')
    const problems = problemsOf(() => loadCanonicalSync(dir))
    expect(problems).toContain('tools.yaml: missing')
    expect(problems.some(p => p.startsWith('plugins.yaml: invalid YAML'))).toBe(true)
  }))

  test('buracle.yaml must be a valid config', () => withSandbox(({ root }) => {
    const dir = fixture(root)
    writeFileSync(join(dir, 'buracle.yaml'), 'version: 1\nrouting:\n  strictness: sometimes\n')
    expect(problemsOf(() => loadCanonicalSync(dir)).join('\n')).toContain('routing.strictness')
  }))

  test('skills, rules and agents', () => withSandbox(({ root }) => {
    const dir = fixture(root)
    mkdirSync(join(dir, 'skills', 'good', 'scripts'), { recursive: true })
    writeFileSync(join(dir, 'skills', 'good', 'SKILL.md'), '---\nname: good\ndescription: A good skill\n---\n# Good\n')
    writeFileSync(join(dir, 'skills', 'good', 'scripts', 'run.sh'), '#!/bin/sh\n')
    writeFileSync(join(dir, 'skills', 'good', '.DS_Store'), 'junk')
    mkdirSync(join(dir, 'skills', 'empty', 'references'), { recursive: true })
    mkdirSync(join(dir, 'rules', 'always'), { recursive: true })
    writeFileSync(join(dir, 'rules', 'always', 'core.md'), '# Core\n')
    mkdirSync(join(dir, 'rules', 'paths'), { recursive: true })
    writeFileSync(join(dir, 'rules', 'paths', 'py.md'), '---\npaths: ["**/*.py"]\n---\n# Py\n')
    mkdirSync(join(dir, 'agents'))
    writeFileSync(join(dir, 'agents', 'rev.md'), '---\nname: rev\n---\nReview.\n')
    const b = loadCanonicalSync(dir)
    expect(b.skills.map(s => s.id)).toEqual(['good'])
    expect(b.skills[0]?.frontmatter).toEqual({ name: 'good', description: 'A good skill' })
    expect(b.skills[0]?.files.map(f => f.path)).toEqual(['SKILL.md', 'scripts/run.sh'])
    expect(b.rules.map(r => `${r.scope}/${r.id}`)).toEqual(['always/core', 'paths/py'])
    expect(b.rules[1]?.frontmatter).toEqual({ paths: ['**/*.py'] })
    expect(b.agents).toEqual([{ id: 'rev', file: 'agents/rev.md', frontmatter: { name: 'rev' }, body: 'Review.\n' }])

    mkdirSync(join(dir, 'skills', 'broken'))
    writeFileSync(join(dir, 'skills', 'broken', 'notes.md'), 'no SKILL.md here')
    writeFileSync(join(dir, 'agents', 'bad.md'), '---\nname: [unclosed\n---\n')
    const problems = problemsOf(() => loadCanonicalSync(dir))
    expect(problems).toContain('skills/broken: SKILL.md is missing')
    expect(problems.some(p => p.startsWith('agents/bad.md:'))).toBe(true)
  }))

  test('routing categories are cross-checked as warnings', () => withSandbox(({ root }) => {
    const dir = fixture(root)
    writeFileSync(join(dir, 'routing.yaml'), 'strictness: enforce\ncategories:\n  - { id: library-docs, intent: docs, prefer: [context7], fallback: [], deny_builtin: [] }\n')
    const b = loadCanonicalSync(dir)
    expect(b.routing.categories.map(c => c.id)).toEqual(['library-docs'])
    expect(b.warnings.some(w => w.includes('"web-search"'))).toBe(true)
    expect(b.warnings.some(w => w.includes('"library-docs"'))).toBe(false)
  }))

  test('hooks.yaml and routing.yaml go through their full validators; findings are warnings', () => withSandbox(({ root }) => {
    const dir = fixture(root)
    writeFileSync(join(dir, 'routing.yaml'), 'strictness: enforce\ncategories:\n  - { id: library-docs, intent: docs, prefer: [mcp:nope], fallback: [context7], deny_builtin: [WebSearch] }\n')
    writeFileSync(join(dir, 'hooks.yaml'), 'hooks:\n  - { id: H01, name: guard.bash, blocking: none, failure: open, contract_test: tests/x.test.ts, bindings: {} }\n')
    const b = loadCanonicalSync(dir)
    expect(b.hooks.hooks.map(h => h.id)).toEqual(['H01'])
    const w = b.warnings.join('\n')
    expect(w).toContain('routing.yaml: categories[0].prefer[0]: unknown MCP server "nope"')
    expect(w).toContain('routing.yaml: categories[0].fallback[0]: expected mcp:<server>')
    expect(w).toContain('routing.yaml: categories[0].deny_builtin[0]: expected a built-in tool kind')
    expect(w).toContain('hooks.yaml: hooks: expected exactly H01')
    expect(w).toContain('hooks.yaml: hooks[0](H01).blocking: expected deny')
    expect(loadCanonicalSync(paths.canonicalDir()).warnings).toEqual([])
  }))
})

describe('frontmatter', () => {
  test('parses, tolerates absence and rejects broken blocks', () => {
    expect(parseFrontmatter('---\na: 1\n---\nbody\n')).toEqual({ frontmatter: { a: 1 }, body: 'body\n' })
    expect(parseFrontmatter('﻿---\r\nb: x\r\n---\r\nrest')).toEqual({ frontmatter: { b: 'x' }, body: 'rest' })
    expect(parseFrontmatter('---\n---\nempty')).toEqual({ frontmatter: {}, body: 'empty' })
    expect(parseFrontmatter('# no frontmatter\n')).toEqual({ frontmatter: {}, body: '# no frontmatter\n' })
    expect(() => parseFrontmatter('---\na: 1\nno closing\n')).toThrow(/not closed/)
    expect(() => parseFrontmatter('---\n- list\n---\n')).toThrow(/mapping/)
  })
})

describe('catalog validators', () => {
  test('mcp.yaml rules', () => {
    const errors = validateMcpCatalog({
      servers: {
        Bad_Id: { description: 'x', transport: 'stdio', command: 'npx', args: [], harnesses: ['claude'], pin: 'hard', critical: true, routing: [] },
        loose: { description: 'x', transport: 'stdio', package: { registry: 'npm', name: 'p', version: '^1.0.0' }, command: 'npx', args: ['p@{version}'], harnesses: ['claude'], pin: 'hard', critical: false, routing: [] },
        nopin: { description: 'x', transport: 'stdio', package: { registry: 'npm', name: 'p', version: '1.0.0' }, command: 'npx', args: ['p@latest'], harnesses: ['claude'], pin: 'hard', critical: false, routing: [] },
        soft: { description: 'x', transport: 'http', url: 'https://x.y', harnesses: ['codex'], pin: 'soft', critical: false, routing: [] },
        plain: { description: 'x', transport: 'http', url: 'http://insecure', harnesses: ['nope'], pin: 'hard', critical: false, routing: [], env: { TOKEN: 'abc${ENV:X}' } },
      },
    })
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining('servers.Bad_Id: server id must match'),
      expect.stringContaining('servers.Bad_Id.package: stdio servers must name an npm or PyPI package'),
      expect.stringContaining('servers.loose.package.version: must be latest or an exact version'),
      expect.stringContaining('servers.nopin: command/args must use {version}'),
      expect.stringContaining('servers.soft.pin_reason: required for soft pins'),
      expect.stringContaining('servers.plain.url: required https URL'),
      expect.stringContaining('servers.plain.harnesses'),
      expect.stringContaining('servers.plain.env.TOKEN: only whole-value'),
    ]))
    expect(validateMcpCatalog({})).toEqual(['servers: expected a mapping of server id → spec'])
  })

  test('mcp.yaml: harness_env and tool_timeout_sec (with tool_timeout_hard); the retired runtime, scripts and tool-list keys no longer validate', () => {
    const base = { description: 'x', transport: 'stdio', package: { registry: 'npm', name: 'p', version: 'latest' }, harnesses: ['claude', 'codex'], pin: 'latest', critical: false, routing: [] }
    const good = {
      ...base,
      env: { SHARED: '1' },
      harness_env: { claude: { WHO: 'claude', TOKEN: '${ENV:TOKEN}' }, codex: { WHO: 'codex' } },
      tool_timeout_sec: 600,
      tool_timeout_hard: true,
    }
    expect(validateMcpCatalog({ servers: { good } })).toEqual([])
    const errors = validateMcpCatalog({
      servers: {
        stranger: { ...base, harness_env: { omp: { A: '1' }, claude: 'x' } },
        overlap: { ...base, env: { A: '1' }, harness_env: { codex: { A: '2', 'bad-name': '3', B: 4, C: 'x${ENV:Y}' } } },
        remote: { ...base, package: undefined, transport: 'http', url: 'https://x.y', harness_env: { claude: { A: '1' } } },
        timeout: { ...base, tool_timeout_sec: 1.5 },
        zero: { ...base, tool_timeout_sec: 0 },
        hardType: { ...base, tool_timeout_sec: 180, tool_timeout_hard: 'yes' },
        hardAlone: { ...base, tool_timeout_hard: true },
        shape: { ...base, harness_env: ['claude'] },
        retired: { ...base, package: { ...base.package, runtime: 'bun', scripts: false }, enabled_tools: ['a_tool'], disabled_tools: ['b_tool'] },
      },
    })
    expect(errors).toEqual(expect.arrayContaining([
      'servers.stranger.harness_env.omp: not one of this server\'s harnesses',
      'servers.stranger.harness_env.claude: expected a mapping',
      'servers.overlap.harness_env.codex.A: also in env (a variable is set either for every harness or per harness)',
      'servers.overlap.harness_env.codex.bad-name: invalid variable name',
      'servers.overlap.harness_env.codex.B: expected string',
      'servers.overlap.harness_env.codex.C: only whole-value "${ENV:NAME}" forwarding is supported',
      'servers.remote.harness_env: only valid for stdio',
      'servers.timeout.tool_timeout_sec: expected a positive whole number of seconds',
      'servers.zero.tool_timeout_sec: expected a positive whole number of seconds',
      'servers.hardType.tool_timeout_hard: expected a boolean',
      'servers.hardAlone.tool_timeout_hard: needs tool_timeout_sec',
      'servers.shape.harness_env: expected a mapping of harness to variables',
      'servers.retired.enabled_tools: unknown key',
      'servers.retired.disabled_tools: unknown key',
      'servers.retired.package.runtime: unknown key',
      'servers.retired.package.scripts: unknown key',
    ]))
  })

  test('mcpEnvFor: env plus the harness\'s own variables, in key order; nothing of another harness', () => {
    const spec = { description: 'x', transport: 'stdio', package: { registry: 'npm', name: 'p', version: 'latest' }, env: { Z: 'z', A: 'a' }, harness_env: { codex: { M: 'm' }, omp: { B: '${ENV:B}' } }, harnesses: ['claude', 'codex', 'omp'], pin: 'latest', critical: false, routing: [] } as McpServerSpec
    expect(Object.entries(mcpEnvFor(spec, 'codex'))).toEqual([['A', 'a'], ['M', 'm'], ['Z', 'z']])
    expect(mcpEnvFor(spec, 'omp')).toEqual({ A: 'a', B: '${ENV:B}', Z: 'z' })
    expect(mcpEnvFor(spec, 'claude')).toEqual({ A: 'a', Z: 'z' })
    expect(mcpEnvFor({ ...spec, env: undefined, harness_env: undefined }, 'claude')).toEqual({})
  })

  test('plugins.yaml and tools.yaml rules', () => {
    expect(validatePluginsCatalog({ claude: { marketplaces: [{ id: 'm', source: 'o/r' }], plugins: [{ id: 'x@other', enabled: true }, { id: 'noat', enabled: 'yes' }] }, omp: { plugins: [] }, opencode: { plugins: [] } })).toEqual([
      'claude.plugins[1].enabled: required boolean',
      'claude.plugins[0].id: unknown marketplace "other"',
      'claude.plugins[1].id: expected <plugin>@<marketplace>',
    ])
    expect(validatePluginsCatalog({ claude: { marketplaces: [{ id: 'm', source: 'o/r' }], plugins: [{ id: 'a@m', enabled: true }], retired: ['a@m', 'bad', 7] }, omp: { plugins: [] }, opencode: { plugins: [] } })).toEqual([
      'claude.retired[0]: a@m is also in claude.plugins',
      'claude.retired[1]: expected <plugin>@<marketplace>',
      'claude.retired[2]: expected <plugin>@<marketplace>',
    ])
    expect(validateToolsCatalog({ tools: [{ name: 'a', check: [], version_regex: '(', required: true }, { name: 'a', check: ['a'], version_regex: 'no group', required: 'x' }] })).toEqual([
      'tools[0].check: required non-empty argv list',
      'tools[0].version_regex: invalid regular expression',
      'tools[1].name: duplicate "a"',
      'tools[1].version_regex: needs a capture group for the version',
      'tools[1].required: required boolean',
    ])
    const ls = (lsp: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ tools: [{ name: 'x', check: ['x'], version_regex: '(x)', required: false, lsp: { id: 'x', extensions: { '.x': 'x' }, ...lsp }, ...extra }] })
    expect(validateToolsCatalog(ls({ startup_timeout_ms: 120000 }, { dotnet: 'csharp-ls' }))).toEqual([])
    expect(validateToolsCatalog(ls({ startup_timeout_ms: 0 }, { dotnet: 7 }))).toEqual([
      'tools[0].lsp.startup_timeout_ms: expected a positive integer',
      'tools[0].dotnet: expected string',
    ])
    expect(validateToolsCatalog(ls({ startup_timeout_ms: '2m' }))).toEqual(['tools[0].lsp.startup_timeout_ms: expected a positive integer'])
    expect(validateToolsCatalog(ls({ replaces: ['pyright-lsp@claude-plugins-official'] }))).toEqual([])
    expect(validateToolsCatalog(ls({ replaces: ['pyright-lsp'] }))).toEqual(['tools[0].lsp.replaces: expected a list of <plugin>@<marketplace>'])
    expect(validateToolsCatalog(ls({ replaces: 'pyright-lsp@claude-plugins-official' }))).toEqual(['tools[0].lsp.replaces: expected a list of <plugin>@<marketplace>'])
    expect(validateToolsCatalog(ls({}, { requires: ['go'] }))).toEqual([])
    for (const requires of [[], 'go', [''], [1]]) expect(validateToolsCatalog(ls({}, { requires }))).toEqual(['tools[0].requires: expected a non-empty list of command names'])
  })

  test('envRef', () => {
    expect(envRef('${ENV:CONTEXT7_API_KEY}')).toBe('CONTEXT7_API_KEY')
    expect(envRef('plain')).toBeUndefined()
  })
})
