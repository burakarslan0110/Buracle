import { describe, expect, test } from 'bun:test'
import { HOOK_IDS, classifyTool, isHarness, mcpServerToken, normalizePath, parseApplyPatch, parseMcpName, resolvePath } from '../../src/core/events'
import type { Harness, ToolKind } from '../../src/core/events'

const CWD = '/work/repo'
const KNOWN = ['context7', 'codegraph', 'context-mode', 'web-search', 'web-fetch', 'grep', 'semble', 'chrome-devtools', 'buracle-memory']

describe('tool tables', () => {
  const cases: Array<[Harness, string, ToolKind]> = [
    ['claude', 'Bash', 'bash'], ['claude', 'Edit', 'edit'], ['claude', 'Write', 'write'], ['claude', 'NotebookEdit', 'edit'],
    ['claude', 'Read', 'read'], ['claude', 'WebSearch', 'web_search'], ['claude', 'WebFetch', 'web_fetch'],
    ['claude', 'AskUserQuestion', 'ask_user'], ['claude', 'ExitPlanMode', 'plan_exit'], ['claude', 'EnterPlanMode', 'plan_enter'],
    ['claude', 'TodoWrite', 'todo'], ['claude', 'Agent', 'agent'], ['claude', 'Task', 'agent'], ['claude', 'Grep', 'search'],
    ['codex', 'shell', 'bash'], ['codex', 'exec_command', 'bash'], ['codex', 'Bash', 'bash'], ['codex', 'apply_patch', 'patch'],
    ['codex', 'request_user_input', 'ask_user'], ['codex', 'request_user_input_async', 'ask_user'], ['codex', 'update_plan', 'todo'],
    ['codex', 'spawn_agent', 'agent'], ['codex', 'webrun', 'web_search'],
    ['opencode', 'bash', 'bash'], ['opencode', 'edit', 'edit'], ['opencode', 'write', 'write'], ['opencode', 'patch', 'patch'],
    ['opencode', 'read', 'read'], ['opencode', 'webfetch', 'web_fetch'], ['opencode', 'websearch', 'web_search'],
    ['opencode', 'question', 'ask_user'], ['opencode', 'todowrite', 'todo'], ['opencode', 'task', 'agent'], ['opencode', 'grep', 'search'],
    ['omp', 'bash', 'bash'], ['omp', 'edit', 'edit'], ['omp', 'write', 'write'], ['omp', 'read', 'read'], ['omp', 'fetch', 'web_fetch'],
    ['omp', 'ask', 'ask_user'], ['omp', 'task', 'agent'], ['omp', 'web_search', 'web_search'], ['omp', 'todo', 'todo'],
  ]
  for (const [h, tool, kind] of cases) {
    test(`${h} ${tool} → ${kind}`, () => {
      expect(classifyTool(h, tool, {}, CWD).kind).toBe(kind)
    })
  }

  test('unknown names map to other', () => {
    expect(classifyTool('claude', 'SomethingNew', {}, CWD)).toEqual({ kind: 'other', paths: [] })
    expect(classifyTool('codex', 'mystery', {}, CWD).kind).toBe('other')
    expect(classifyTool('opencode', 'lonely', {}, CWD).kind).toBe('other')
    expect(classifyTool('omp', 'ssh', {}, CWD).kind).toBe('other')
    expect(classifyTool('claude', 'constructor', {}, CWD).kind).toBe('other')
    expect(classifyTool('claude', 'bash', {}, CWD).kind).toBe('other')
  })

  test('missing or malformed input is tolerated', () => {
    expect(classifyTool('claude', 'Bash', undefined as unknown as Record<string, unknown>, CWD)).toEqual({ kind: 'bash', paths: [] })
    expect(classifyTool('codex', 'apply_patch', null as unknown as Record<string, unknown>, CWD)).toEqual({ kind: 'patch', paths: [] })
    expect(classifyTool('opencode', 'edit', { filePath: 42, paths: ['a', 7] }, CWD)).toEqual({ kind: 'edit', paths: ['/work/repo/a'] })
  })

  test('isHarness', () => {
    expect(isHarness('codex')).toBe(true)
    expect(isHarness('cursor')).toBe(false)
    expect(isHarness(undefined)).toBe(false)
  })
})

describe('paths and commands', () => {
  test('Claude Bash command and file paths', () => {
    expect(classifyTool('claude', 'Bash', { command: 'rm -rf build' }, CWD)).toEqual({ kind: 'bash', command: 'rm -rf build', paths: [] })
    expect(classifyTool('claude', 'Edit', { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' }, CWD).paths).toEqual(['/work/repo/src/a.ts'])
    expect(classifyTool('claude', 'Write', { file_path: '/abs/../abs2/b.md', content: '' }, CWD).paths).toEqual(['/abs2/b.md'])
    expect(classifyTool('claude', 'NotebookEdit', { notebook_path: 'nb.ipynb' }, CWD).paths).toEqual(['/work/repo/nb.ipynb'])
  })

  test('relative paths stay relative without a cwd', () => {
    expect(classifyTool('claude', 'Read', { file_path: './x/../y.txt' }, '').paths).toEqual(['y.txt'])
  })

  test('Codex shell argv and unified exec', () => {
    expect(classifyTool('codex', 'shell', { command: ['bash', '-lc', 'git status'] }, CWD).command).toBe('git status')
    expect(classifyTool('codex', 'shell', { command: ['/bin/zsh', '-c', 'ls'] }, CWD).command).toBe('ls')
    expect(classifyTool('codex', 'shell', { command: ['git', 'log', '--format=%H %s'] }, CWD).command).toBe("git log '--format=%H %s'")
    expect(classifyTool('codex', 'exec_command', { cmd: 'npm test' }, CWD).command).toBe('npm test')
    expect(classifyTool('codex', 'Bash', { command: 'echo hi' }, CWD).command).toBe('echo hi')
  })

  test('Codex apply_patch payloads', () => {
    const patch = '*** Begin Patch\n*** Update File: src/app.ts\n@@\n-old\n+new\n*** End Patch\n'
    expect(classifyTool('codex', 'apply_patch', { command: patch }, CWD)).toEqual({ kind: 'patch', paths: ['/work/repo/src/app.ts'] })
    expect(classifyTool('codex', 'shell', { command: ['apply_patch', patch] }, CWD)).toEqual({ kind: 'patch', paths: ['/work/repo/src/app.ts'] })
    expect(classifyTool('codex', 'apply_patch', { command: `apply_patch <<'EOF'\n${patch}EOF\n` }, CWD).paths).toEqual(['/work/repo/src/app.ts'])
  })

  test('OpenCode fields', () => {
    expect(classifyTool('opencode', 'edit', { filePath: 'a/b.ts', oldString: '1', newString: '2' }, CWD).paths).toEqual(['/work/repo/a/b.ts'])
    const patchText = '*** Begin Patch\n*** Add File: new.txt\n+hello\n*** End Patch'
    expect(classifyTool('opencode', 'patch', { patchText }, CWD)).toEqual({ kind: 'patch', paths: ['/work/repo/new.txt'] })
    expect(classifyTool('opencode', 'bash', { command: 'ls', description: 'list' }, CWD).command).toBe('ls')
  })

  test('omp edit modes, URL reads and device writes', () => {
    expect(classifyTool('omp', 'edit', { path: 'x.ts', old_string: 'a', new_string: 'b' }, CWD)).toEqual({ kind: 'edit', paths: ['/work/repo/x.ts'] })
    expect(classifyTool('omp', 'edit', { path: 'x.ts', edits: [{ op: 'update', rename: 'y.ts', diff: '' }] }, CWD).paths).toEqual(['/work/repo/x.ts', '/work/repo/y.ts'])
    expect(classifyTool('omp', 'edit', { input: '*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch' }, CWD)).toEqual({ kind: 'patch', paths: ['/work/repo/gone.txt'] })
    expect(classifyTool('omp', 'read', { path: 'https://example.com/docs' }, CWD)).toEqual({ kind: 'web_fetch', paths: [] })
    expect(classifyTool('omp', 'read', { path: 'xd://' }, CWD).kind).toBe('read')
    expect(classifyTool('omp', 'read', { path: 'xd://mcp__context7_query_docs' }, CWD).kind).toBe('other')
    expect(classifyTool('omp', 'write', { path: 'xd://mcp__context7_query_docs', content: '{}' }, CWD, KNOWN)).toEqual({ kind: 'mcp', paths: [], mcp: { server: 'context7', tool: 'query_docs' } })
    expect(classifyTool('omp', 'read', { path: 'skill://goal-build/SKILL.md' }, CWD)).toEqual({ kind: 'read', paths: [] })
  })
})

describe('MCP names', () => {
  test('Claude direct and plugin servers', () => {
    expect(classifyTool('claude', 'mcp__context7__query-docs', {}, CWD)).toEqual({ kind: 'mcp', paths: [], mcp: { server: 'context7', tool: 'query-docs' } })
    expect(parseMcpName('claude', 'mcp__plugin_buracle_context7__query-docs')).toEqual({ server: 'context7', tool: 'query-docs' })
    expect(parseMcpName('claude', 'mcp__plugin_buracle_buracle-memory__memory_search')).toEqual({ server: 'buracle-memory', tool: 'memory_search' })
    expect(parseMcpName('claude', 'mcp__plugin_buracle_web-search__search', KNOWN)).toEqual({ server: 'web-search', tool: 'search' })
    expect(parseMcpName('claude', 'mcp__github__create_issue')).toEqual({ server: 'github', tool: 'create_issue' })
    expect(parseMcpName('claude', 'mcp__broken')).toBeUndefined()
    expect(parseMcpName('claude', 'Bash')).toBeUndefined()
  })

  test('Codex', () => {
    expect(classifyTool('codex', 'mcp__web-search__search', {}, CWD).mcp).toEqual({ server: 'web-search', tool: 'search' })
  })

  test('OpenCode <server>_<tool>', () => {
    expect(classifyTool('opencode', 'context7_query-docs', {}, CWD).mcp).toEqual({ server: 'context7', tool: 'query-docs' })
    expect(classifyTool('opencode', 'web-search_search', {}, CWD).mcp).toEqual({ server: 'web-search', tool: 'search' })
    expect(parseMcpName('opencode', 'buracle-memory_memory_search', KNOWN)).toEqual({ server: 'buracle-memory', tool: 'memory_search' })
    expect(classifyTool('opencode', 'apply_patch', {}, CWD).kind).toBe('patch')
  })

  test('omp mcp__<server>_<tool> (servers are lower-cased with _ separators)', () => {
    expect(mcpServerToken('omp', 'web-search')).toBe('web_search')
    expect(mcpServerToken('omp', 'Chrome DevTools')).toBe('chrome_devtools')
    expect(parseMcpName('omp', 'mcp__context7_query_docs')).toEqual({ server: 'context7', tool: 'query_docs' })
    expect(parseMcpName('omp', 'mcp__web_search_search', KNOWN)).toEqual({ server: 'web-search', tool: 'search' })
    expect(parseMcpName('omp', 'mcp__buracle_memory_memory_search', KNOWN)).toEqual({ server: 'buracle-memory', tool: 'memory_search' })
    expect(parseMcpName('omp', 'mcp__web_search_search')).toEqual({ server: 'web', tool: 'search_search' })
    expect(classifyTool('omp', 'mcp__web_search_search', {}, CWD, KNOWN).mcp).toEqual({ server: 'web-search', tool: 'search' })
  })

  test('context-mode on every harness, beside context7', () => {
    const want = { server: 'context-mode', tool: 'ctx_execute' }
    expect(parseMcpName('claude', 'mcp__plugin_buracle_context-mode__ctx_execute')).toEqual(want)
    expect(parseMcpName('claude', 'mcp__plugin_buracle_context-mode__ctx_execute', KNOWN)).toEqual(want)
    expect(parseMcpName('codex', 'mcp__context_mode__ctx_execute', KNOWN)).toEqual(want)
    expect(parseMcpName('opencode', 'context-mode_ctx_execute', KNOWN)).toEqual(want)
    expect(parseMcpName('omp', 'mcp__context_mode_ctx_execute', KNOWN)).toEqual(want)
    expect(classifyTool('codex', 'mcp__context_mode__ctx_batch_execute', {}, CWD, KNOWN)).toEqual({ kind: 'mcp', paths: [], mcp: { server: 'context-mode', tool: 'ctx_batch_execute' } })
    expect(classifyTool('opencode', 'context-mode_ctx_fetch_and_index', {}, CWD, KNOWN).mcp).toEqual({ server: 'context-mode', tool: 'ctx_fetch_and_index' })
    expect(classifyTool('omp', 'mcp__context_mode_ctx_execute_file', {}, CWD, KNOWN).mcp).toEqual({ server: 'context-mode', tool: 'ctx_execute_file' })
    expect(parseMcpName('claude', 'mcp__plugin_buracle_context7__query-docs', KNOWN)).toEqual({ server: 'context7', tool: 'query-docs' })
    expect(parseMcpName('codex', 'mcp__context7__query_docs', KNOWN)).toEqual({ server: 'context7', tool: 'query_docs' })
    expect(parseMcpName('opencode', 'context7_query-docs', KNOWN)).toEqual({ server: 'context7', tool: 'query-docs' })
    expect(parseMcpName('omp', 'mcp__context7_query_docs', KNOWN)).toEqual({ server: 'context7', tool: 'query_docs' })
  })
})

describe('MCP names: sanitized Codex spellings, OpenCode v2 built-ins, known servers only', () => {
  test('Codex replaces every character outside [A-Za-z0-9_] with _, so canonical ids with - resolve', () => {
    expect(mcpServerToken('codex', 'web-search')).toBe('web_search')
    expect(mcpServerToken('codex', 'buracle-memory')).toBe('buracle_memory')
    expect(mcpServerToken('claude', 'web-search')).toBe('web-search')
    expect(parseMcpName('codex', 'mcp__web_search__search', KNOWN)).toEqual({ server: 'web-search', tool: 'search' })
    expect(parseMcpName('codex', 'mcp__buracle_memory__memory_search', KNOWN)).toEqual({ server: 'buracle-memory', tool: 'memory_search' })
    expect(parseMcpName('codex', 'mcp__context7__query_docs', KNOWN)).toEqual({ server: 'context7', tool: 'query_docs' })
    expect(parseMcpName('codex', 'mcp__github__create_issue', KNOWN)).toEqual({ server: 'github', tool: 'create_issue' })
    expect(classifyTool('codex', 'mcp__web_search__search', {}, CWD, KNOWN)).toEqual({ kind: 'mcp', paths: [], mcp: { server: 'web-search', tool: 'search' } })
  })

  test('OpenCode v2 built-ins are never MCP', () => {
    for (const [tool, kind] of [['list_mcp_resources', 'other'], ['read_mcp_resource', 'other'], ['skill', 'other'], ['execute', 'other'], ['subagent', 'agent'], ['shell', 'bash'], ['glob', 'search'], ['question', 'ask_user']] as const) {
      expect({ tool, kind: classifyTool('opencode', tool, {}, CWD).kind }).toEqual({ tool, kind })
      expect({ tool, kind: classifyTool('opencode', tool, {}, CWD, KNOWN).kind }).toEqual({ tool, kind })
    }
  })

  test('with known servers, OpenCode and omp names that match none are not split at their first underscore', () => {
    expect(parseMcpName('opencode', 'my_tool', KNOWN)).toBeUndefined()
    expect(classifyTool('opencode', 'my_tool', {}, CWD, KNOWN).kind).toBe('other')
    expect(parseMcpName('opencode', 'my_tool')).toEqual({ server: 'my', tool: 'tool' })
    expect(parseMcpName('omp', 'mcp__someone_else_tool', KNOWN)).toBeUndefined()
    expect(parseMcpName('omp', 'mcp__someone_else_tool')).toEqual({ server: 'someone', tool: 'else_tool' })
    expect(parseMcpName('opencode', 'web-search_search', KNOWN)).toEqual({ server: 'web-search', tool: 'search' })
  })
})

describe('parseApplyPatch', () => {
  test('add, update, delete and move', () => {
    const patch = [
      '*** Begin Patch',
      '*** Add File: docs/new.md',
      '+# Title',
      '+',
      '+body',
      '*** Update File: src/a.ts',
      '@@ function a()',
      ' keep',
      '-old line',
      '+new line',
      '*** Delete File: old/b.ts',
      '*** Update File: src/c.ts',
      '*** Move to: src/d.ts',
      '@@',
      '-x',
      '+y',
      '*** End of File',
      '*** End Patch',
    ].join('\n')
    const r = parseApplyPatch(patch, CWD)
    expect(r.paths).toEqual(['/work/repo/docs/new.md', '/work/repo/src/a.ts', '/work/repo/old/b.ts', '/work/repo/src/c.ts', '/work/repo/src/d.ts'])
    expect(r.added).toEqual({
      '/work/repo/docs/new.md': '# Title\n\nbody',
      '/work/repo/src/a.ts': 'new line',
      '/work/repo/src/d.ts': 'y',
    })
  })

  test('CRLF, absolute paths, duplicates and empty added files', () => {
    const patch = '*** Begin Patch\r\n*** Add File: /tmp/empty.txt\r\n*** Update File: ../up.txt\r\n+a\r\n*** Update File: ../up.txt\r\n+b\r\n*** End Patch\r\n'
    const r = parseApplyPatch(patch, CWD)
    expect(r.paths).toEqual(['/tmp/empty.txt', '/work/up.txt'])
    expect(r.added).toEqual({ '/tmp/empty.txt': '', '/work/up.txt': 'a\nb' })
  })

  test('unified diff fallback', () => {
    const diff = 'diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1 +1 @@\n-a\n+b\n--- a/gone.py\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n'
    const r = parseApplyPatch(diff, CWD)
    expect(r.paths).toEqual(['/work/repo/x.py', '/work/repo/gone.py'])
    expect(r.added).toEqual({ '/work/repo/x.py': 'b' })
  })

  test('garbage yields nothing', () => {
    expect(parseApplyPatch('hello world', CWD)).toEqual({ paths: [], added: {} })
  })

  test('large and hostile input stays fast', () => {
    const lines = Array.from({ length: 100_000 }, (_, i) => `+line ${i} ${'x'.repeat(40)}`)
    const patch = `*** Begin Patch\n*** Add File: big.txt\n${lines.join('\n')}\n${'*'.repeat(100_000)}\n*** End Patch`
    const t0 = performance.now()
    const r = parseApplyPatch(patch, CWD)
    expect(performance.now() - t0).toBeLessThan(2000)
    expect(r.paths).toEqual(['/work/repo/big.txt'])
    expect(r.added['/work/repo/big.txt']?.split('\n').length).toBe(100_000)
    const t1 = performance.now()
    classifyTool('claude', 'Bash', { command: 'x'.repeat(1_000_000) }, CWD)
    parseMcpName('omp', `mcp__${'a_'.repeat(50_000)}`, ['a', 'a-a'])
    expect(performance.now() - t1).toBeLessThan(2000)
  })
})

describe('path helpers', () => {
  test('normalizePath', () => {
    expect(normalizePath('/a//b/./c/../d/')).toBe('/a/b/d')
    expect(normalizePath('/../x')).toBe('/x')
    expect(normalizePath('../a/./b')).toBe('../a/b')
    expect(normalizePath('a/..')).toBe('.')
  })
  test('resolvePath', () => {
    expect(resolvePath('/w', 'f.txt')).toBe('/w/f.txt')
    expect(resolvePath('/w', 'file:///etc/hosts')).toBe('/etc/hosts')
    expect(resolvePath('/w', 'https://x.y/z')).toBeUndefined()
    expect(resolvePath('/w', '  ')).toBeUndefined()
  })
})

describe('`~` paths: the homeTilde option for harnesses whose tools resolve them against the home folder', () => {
  const HOME = '/Users/u'
  const o = { homeTilde: HOME }

  test('resolvePath: with a home, `~` and `~/x` are the home folder; without one they stay cwd-relative', () => {
    expect(resolvePath('/w', '~/.ssh/config', HOME)).toBe('/Users/u/.ssh/config')
    expect(resolvePath('/w', '~', HOME)).toBe('/Users/u')
    expect(resolvePath('/w', '~/', HOME)).toBe('/Users/u')
    expect(resolvePath('/w', ' ~/a/../b ', HOME)).toBe('/Users/u/b')
    expect(resolvePath('/w', '~/x', '/Users/u/')).toBe('/Users/u/x')
    expect(resolvePath('/w', '~user/x', HOME)).toBe('/w/~user/x')
    expect(resolvePath('/w', 'src/~x', HOME)).toBe('/w/src/~x')
    expect(resolvePath('/w', '~/x', '')).toBe('/w/~/x')
    expect(resolvePath('/w', '~/.ssh/config')).toBe('/w/~/.ssh/config')
  })

  test('classifyTool: the paths of file tools (path fields, path lists, edits[]) and of patches', () => {
    expect(classifyTool('opencode', 'write', { path: '~/.ssh/authorized_keys', content: 'k' }, CWD, undefined, o).paths).toEqual(['/Users/u/.ssh/authorized_keys'])
    expect(classifyTool('opencode', 'edit', { path: '~/notes.md', oldString: 'a', newString: 'b' }, CWD, undefined, o).paths).toEqual(['/Users/u/notes.md'])
    expect(classifyTool('opencode', 'read', { path: '~' }, CWD, undefined, o).paths).toEqual(['/Users/u'])
    expect(classifyTool('opencode', 'grep', { pattern: 'x', path: '~/code' }, CWD, undefined, o).paths).toEqual(['/Users/u/code'])
    expect(classifyTool('opencode', 'edit', { paths: ['~/a.md', 'b.md'] }, CWD, undefined, o).paths).toEqual(['/Users/u/a.md', '/work/repo/b.md'])
    expect(classifyTool('omp', 'edit', { edits: [{ path: '~/a.ts', rename: '~/b.ts' }] }, CWD, undefined, o).paths).toEqual(['/Users/u/a.ts', '/Users/u/b.ts'])
    const patch = '*** Begin Patch\n*** Update File: ~/.zshrc\n*** Move to: ~/.zshrc.bak\n@@\n-a\n+b\n*** Add File: src/new.ts\n+x\n*** End Patch'
    expect(classifyTool('opencode', 'patch', { patchText: patch }, CWD, undefined, o).paths).toEqual(['/Users/u/.zshrc', '/Users/u/.zshrc.bak', '/work/repo/src/new.ts'])
    expect(classifyTool('omp', 'edit', { input: patch }, CWD, undefined, o)).toEqual({ kind: 'patch', paths: ['/Users/u/.zshrc', '/Users/u/.zshrc.bak', '/work/repo/src/new.ts'] })
    expect(classifyTool('opencode', 'web-search_search', {}, CWD, KNOWN, o)).toEqual({ kind: 'mcp', paths: [], mcp: { server: 'web-search', tool: 'search' } })
  })

  test('classifyTool without the option keeps `~/` cwd-relative (Codex apply_patch writes exactly there)', () => {
    const patch = '*** Begin Patch\n*** Add File: ~/x.md\n+y\n*** End Patch'
    expect(classifyTool('codex', 'apply_patch', { command: patch }, CWD).paths).toEqual(['/work/repo/~/x.md'])
    expect(classifyTool('codex', 'shell', { command: ['apply_patch', patch] }, CWD).paths).toEqual(['/work/repo/~/x.md'])
    expect(classifyTool('opencode', 'write', { path: '~/.ssh/authorized_keys' }, CWD).paths).toEqual(['/work/repo/~/.ssh/authorized_keys'])
  })

  test('parseApplyPatch: headers, move destinations and the added text follow the home folder', () => {
    const patch = '*** Begin Patch\n*** Add File: ~/notes/a.md\n+hello\n*** Update File: ~/b.txt\n*** Move to: ~/c.txt\n@@\n-x\n+y\n*** End Patch'
    expect(parseApplyPatch(patch, CWD, o)).toEqual({ paths: ['/Users/u/notes/a.md', '/Users/u/b.txt', '/Users/u/c.txt'], added: { '/Users/u/notes/a.md': 'hello', '/Users/u/c.txt': 'y' } })
    expect(parseApplyPatch(patch, CWD).paths).toEqual(['/work/repo/~/notes/a.md', '/work/repo/~/b.txt', '/work/repo/~/c.txt'])
    expect(parseApplyPatch('--- a/~/x.py\n+++ b/~/x.py\n@@ -1 +1 @@\n-a\n+b\n', CWD, o).paths).toEqual(['/work/repo/~/x.py'])
    expect(parseApplyPatch('--- ~/x.py\n+++ ~/x.py\n@@ -1 +1 @@\n-a\n+b\n', CWD, o)).toEqual({ paths: ['/Users/u/x.py'], added: { '/Users/u/x.py': 'b' } })
  })
})

describe('classifyTool: shell and code tools outside Bash', () => {
  test('Claude Monitor with a command is a bash call carrying that command', () => {
    expect(classifyTool('claude', 'Monitor', { command: 'rm -rf ~', description: 'watch', timeout_ms: 1000 }, CWD)).toEqual({ kind: 'bash', command: 'rm -rf ~', paths: [] })
    expect(classifyTool('claude', 'Monitor', { command: 'tail -f log.txt | grep ERROR', description: 'x', timeout_ms: 1 }, CWD).command).toBe('tail -f log.txt | grep ERROR')
  })

  test('a WebSocket Monitor (no command) is not a shell call', () => {
    expect(classifyTool('claude', 'Monitor', { ws: { url: 'wss://x' }, description: 'x', timeout_ms: 1 }, CWD)).toEqual({ kind: 'other', paths: [] })
    expect(classifyTool('claude', 'Monitor', {}, CWD)).toEqual({ kind: 'other', paths: [] })
    expect(classifyTool('codex', 'Monitor', { command: 'x' }, CWD).kind).toBe('other')
  })

  test('omp eval is its own kind; its code goes to checkEval', () => {
    const cases: Array<[Harness, string, ToolKind]> = [['omp', 'eval', 'eval'], ['claude', 'eval', 'other'], ['opencode', 'eval', 'other']]
    for (const [h, tool, kind] of cases) expect({ h, tool, kind: classifyTool(h, tool, { language: 'js', code: 'x' }, CWD).kind }).toEqual({ h, tool, kind })
    expect(classifyTool('omp', 'eval', { language: 'py', code: 'import os' }, CWD)).toEqual({ kind: 'eval', paths: [] })
  })
})

describe('logical hook ids', () => {
  test('H01 to H28 in order; H27 context.session came with Context Mode, H28 project.assets with 0.5.0', () => {
    expect(HOOK_IDS.length).toBe(28)
    expect(HOOK_IDS).toEqual(Array.from({ length: 28 }, (_, i) => `H${String(i + 1).padStart(2, '0')}`) as typeof HOOK_IDS)
    expect(HOOK_IDS[HOOK_IDS.length - 1]).toBe('H28')
  })
})
