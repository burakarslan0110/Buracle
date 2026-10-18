import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Harness, ToolCall } from '../../../src/core/events'
import { HARNESSES, classifyTool, parseMcpName } from '../../../src/core/events'
import type { CatalogMcp, CatalogSkill } from '../../../src/core/catalog'
import { catalogMcp, catalogSkills } from '../../../src/core/catalog'
import type { McpHealth, RoutingPolicy } from '../../../src/core/policy/routing'
import {
  CAPABILITY_CARD_MAX_LINES, bashNudge, capabilityCard, harnessMcpPattern, harnessMcpToolName, isDocsUrl, mcpHealthOf, parseRouteRef, routeTool, validateRoutingPolicy,
  withDisabledServers,
} from '../../../src/core/policy/routing'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'

const CANON = paths.canonicalDir()
const POLICY = parseYaml(readFileSync(join(CANON, 'routing.yaml'), 'utf8')) as RoutingPolicy
const MCP_IDS = ['buracle-memory', 'chrome-devtools', 'codegraph', 'context-mode', 'context7', 'grep', 'semble', 'web-fetch', 'web-search']

function call(harness: Harness, tool: string, input: Record<string, unknown>): ToolCall {
  return { harness, sessionId: 's', cwd: '/repo', tool, input, ...classifyTool(harness, tool, input, '/repo', MCP_IDS) }
}
const WEB_SEARCH: Record<Harness, string> = { claude: 'WebSearch', codex: 'web_search', opencode: 'websearch', omp: 'web_search' }
const WEB_FETCH: Record<Exclude<Harness, 'codex'>, string> = { claude: 'WebFetch', opencode: 'webfetch', omp: 'fetch' }
const withStrictness = (s: RoutingPolicy['strictness']): RoutingPolicy => ({ ...POLICY, strictness: s })

describe('canonical/routing.yaml', () => {
  test('uses exactly the category ids mcp.yaml refers to', () => {
    const bundle = loadCanonicalSync(CANON)
    const fromMcp = new Set(Object.values(bundle.mcp.servers).flatMap(s => s.routing))
    expect(POLICY.categories.map(c => c.id).sort()).toEqual([...fromMcp].sort())
    expect([...fromMcp].sort()).toEqual(['browser', 'code-examples', 'code-search', 'code-structure', 'context-saving', 'language-server', 'library-docs', 'memory', 'web-fetch', 'web-search'])
    expect(bundle.warnings).toEqual([])
  })

  test('validates, and every mcp: entry names a server that lists the category', () => {
    const bundle = loadCanonicalSync(CANON)
    expect(validateRoutingPolicy(POLICY, Object.keys(bundle.mcp.servers))).toEqual([])
    for (const cat of POLICY.categories) {
      const first = parseRouteRef(cat.prefer[0] as string)
      expect(first?.kind).toBe('mcp')
      if (first?.kind === 'mcp') expect(bundle.mcp.servers[first.server]?.routing).toContain(cat.id)
    }
  })

  test('default strictness matches buracle.yaml', () => {
    expect(POLICY.strictness).toBe(loadCanonicalSync(CANON).config.routing.strictness)
  })

  test('agrees with the prose routing table in rules/always/tooling.md', () => {
    const tooling = readFileSync(join(CANON, 'rules', 'always', 'tooling.md'), 'utf8')
    for (const id of MCP_IDS) expect(tooling).toContain(`\`${id}\``)
    expect(tooling).toContain('Tool routing (strict)')
  })

  test('every category has an English one-line reminder for the prompt router and the usage reminders', () => {
    for (const cat of POLICY.categories) {
      expect({ id: cat.id, ok: typeof cat.reminder === 'string' && cat.reminder.length > 20 && cat.reminder.length <= 200 && !cat.reminder.endsWith('.') }).toEqual({ id: cat.id, ok: true })
      expect(cat.reminder).not.toMatch(/[ğüşıöçĞÜŞİÖÇ]/)
    }
  })

  test('tooling.md is English and states the index, root and routing-note rules', () => {
    const tooling = readFileSync(join(CANON, 'rules', 'always', 'tooling.md'), 'utf8')
    expect(tooling).not.toMatch(/[ğüşıöçĞÜŞİÖÇ]/)
    for (const needle of ['`buracle index ensure --cwd <root>`', 'never conclude that codegraph is unusable', 'codegraph `projectPath`', 'semble `repo`', '`/<id>`', '`$<id>` on Codex', 'Buracle routing for this prompt', 'decide YES or NO', 'denied once']) {
      expect(tooling.toLowerCase()).toContain(needle.toLowerCase())
    }
  })
})

describe('validateRoutingPolicy', () => {
  test('reports malformed policies', () => {
    expect(validateRoutingPolicy(null)).toEqual(['(root): expected a mapping'])
    const errs = validateRoutingPolicy({
      strictness: 'sometimes', extra: 1,
      categories: [
        { id: 'Bad Id', intent: '', prefer: [], fallback: ['nope:x'], deny_builtin: ['mcp'], nudge: '' },
        { id: 'a', intent: 'x', prefer: ['mcp:ghost/tool'], fallback: ['builtin:teleport'], deny_builtin: 'web_search' },
        { id: 'a', intent: 'x', prefer: ['cli:rg'], fallback: [], deny_builtin: [] },
      ],
    }, MCP_IDS).join('\n')
    for (const needle of ['strictness', '(root).extra', 'kebab-case', 'intent', 'prefer: must name', 'fallback[0]', 'deny_builtin[0]', 'nudge', 'unknown MCP server "ghost"', 'unknown tool kind', 'deny_builtin: expected a list', 'duplicate "a"']) {
      expect(errs).toContain(needle)
    }
  })

  test('reminder and triggers are optional category keys with a shape', () => {
    const base = { id: 'a', intent: 'x', prefer: ['cli:rg'], fallback: [], deny_builtin: [] }
    expect(validateRoutingPolicy({ strictness: 'enforce', categories: [{ ...base, reminder: 'use rg', triggers: { topic: ['x'], not: ['y'], deps: ['api'] } }] })).toEqual([])
    const errs = validateRoutingPolicy({ strictness: 'enforce', categories: [{ ...base, reminder: '', triggers: { topic: 'x', ask: ['y'] } }] }).join('\n')
    for (const needle of ['reminder: expected one line', 'triggers.topic: expected a list', 'triggers.ask: unknown key']) expect(errs).toContain(needle)
  })

  test('parseRouteRef grammar', () => {
    expect(parseRouteRef('mcp:context7/query-docs')).toEqual({ kind: 'mcp', server: 'context7', tool: 'query-docs' })
    expect(parseRouteRef('mcp:chrome-devtools')).toEqual({ kind: 'mcp', server: 'chrome-devtools' })
    expect(parseRouteRef('cli:rg')).toEqual({ kind: 'cli', name: 'rg' })
    expect(parseRouteRef('builtin:web_search')).toEqual({ kind: 'builtin', tool: 'web_search' })
    expect(parseRouteRef('skill:plan-build')).toEqual({ kind: 'skill', id: 'plan-build' })
    for (const bad of ['context7', 'mcp:', 'cli:rg/x', 'mcp:a b', 'x:y']) expect(parseRouteRef(bad)).toBeUndefined()
  })
})

describe('harness MCP tool names', () => {
  test('match each harness convention and round-trip through parseMcpName', () => {
    expect(harnessMcpToolName('claude', 'web-search', 'search')).toBe('mcp__plugin_buracle_web-search__search')
    expect(harnessMcpToolName('claude', 'context7', 'query-docs')).toBe('mcp__plugin_buracle_context7__query-docs')
    expect(harnessMcpToolName('codex', 'web-search', 'search')).toBe('mcp__web_search__search')
    expect(harnessMcpToolName('codex', 'context7', 'query-docs')).toBe('mcp__context7__query_docs')
    expect(harnessMcpToolName('opencode', 'web-search', 'search')).toBe('web-search_search')
    expect(harnessMcpToolName('omp', 'context7', 'query-docs')).toBe('mcp__context7_query_docs')
    expect(harnessMcpToolName('omp', 'codegraph', 'codegraph_explore')).toBe('mcp__codegraph_explore')
    expect(harnessMcpToolName('omp', 'buracle-memory', 'memory_search')).toBe('mcp__buracle_memory_memory_search')
    for (const h of HARNESSES) {
      for (const [server, tool] of [['web-search', 'search'], ['context7', 'query-docs'], ['buracle-memory', 'memory_search'], ['chrome-devtools', 'take_snapshot']] as const) {
        expect({ h, server, parsed: parseMcpName(h, harnessMcpToolName(h, server, tool), MCP_IDS)?.server }).toEqual({ h, server, parsed: server })
      }
    }
    expect(harnessMcpPattern('claude', 'grep')).toBe('mcp__plugin_buracle_grep__*')
    expect(harnessMcpPattern('omp', 'web-fetch')).toBe('mcp__web_fetch_*')
  })
})

describe('routeTool: built-in web tools', () => {
  test('enforce denies a built-in web search while web-search is healthy, naming the MCP tool per harness', () => {
    for (const h of HARNESSES) {
      const d = routeTool(call(h, WEB_SEARCH[h], { query: 'bun 1.4 release notes' }), POLICY, { 'web-search': 'ok', context7: 'ok' })
      expect(d.action).toBe('deny')
      if (d.action !== 'deny') continue
      expect(d.hook).toBe('H03')
      expect(d.reason).toContain(harnessMcpToolName(h, 'web-search', 'search'))
      expect(d.reason).toContain(harnessMcpToolName(h, 'context7', 'resolve-library-id'))
    }
  })

  test('unknown health counts as available; down allows the built-in with a fallback note', () => {
    const c = call('claude', 'WebSearch', { query: 'x' })
    expect(routeTool(c, POLICY, {}).action).toBe('deny')
    const down = routeTool(c, POLICY, { 'web-search': 'down', 'web-fetch': 'down' })
    expect(down.action).toBe('allow')
    expect(down.action === 'allow' ? down.context?.join(' ') : '').toContain('fallback')
  })

  test('web-search down: a built-in web search goes to web-fetch first (a search results page), the built-in only when web-fetch is down too', () => {
    const cat = POLICY.categories.find(c => c.id === 'web-search')
    expect([...(cat?.prefer ?? []), ...(cat?.fallback ?? [])]).toEqual(['mcp:web-search/search', 'mcp:web-fetch/fetch_url', 'builtin:web_search'])
    for (const h of HARNESSES) {
      const c = call(h, WEB_SEARCH[h], { query: 'bun 1.4 changelog' })
      const d = routeTool(c, POLICY, { 'web-search': 'down' })
      expect({ h, action: d.action }).toEqual({ h, action: 'deny' })
      if (d.action === 'deny') {
        expect(d.reason).toContain(harnessMcpToolName(h, 'web-fetch', 'fetch_url'))
        expect(d.reason).not.toContain(harnessMcpToolName(h, 'web-search', 'search'))
      }
      const both = routeTool(c, POLICY, { 'web-search': 'down', 'web-fetch': 'down' })
      expect({ h, action: both.action }).toEqual({ h, action: 'allow' })
      expect(both.action === 'allow' ? both.context?.join(' ') : '').toContain('the built-in web search is allowed as a fallback')
    }
    const nudge = routeTool(call('claude', 'WebSearch', { query: 'x' }), withStrictness('nudge'), { 'web-search': 'down' })
    const text = nudge.action === 'allow' ? nudge.context?.join(' ') ?? '' : ''
    expect(text).toContain('mcp__plugin_buracle_web-fetch__fetch_url')
    expect(text).toContain('search results page')
  })

  test('built-in fetch follows web-fetch health, then context-mode; claude.ai pages need the built-in session', () => {
    for (const h of ['claude', 'opencode', 'omp'] as const) {
      const d = routeTool(call(h, WEB_FETCH[h], { url: 'https://docs.example.com/x' }), POLICY, { 'web-fetch': 'ok' })
      expect(d.action).toBe('deny')
      if (d.action === 'deny') expect(d.reason).toContain(harnessMcpToolName(h, 'web-fetch', 'fetch_url'))
    }
    const bothDown = { 'web-fetch': 'down', 'context-mode': 'down' } as const
    expect(routeTool(call('claude', 'WebFetch', { url: 'https://docs.example.com/x' }), POLICY, bothDown).action).toBe('allow')
    expect(routeTool(call('claude', 'WebFetch', { url: 'https://claude.ai/code/artifact/123' }), POLICY, {}).action).toBe('allow')
    expect(routeTool(call('omp', 'read', { path: 'https://docs.example.com/x' }), POLICY, {}).action).toBe('deny')
    const blog = routeTool(call('claude', 'WebFetch', { url: 'https://example.com/blog/post' }), POLICY, bothDown)
    expect(blog.action).toBe('allow')
    expect(blog.action === 'allow' ? blog.context?.join(' ') : '').toContain('allowed as a fallback')
  })

  test('web-fetch down: a built-in fetch goes to context-mode\'s ctx_fetch_and_index (then ctx_search), the built-in only when both are down', () => {
    const cat = POLICY.categories.find(c => c.id === 'web-fetch')
    expect([...(cat?.prefer ?? []), ...(cat?.fallback ?? [])]).toEqual(['mcp:web-fetch/fetch_url', 'mcp:context-mode/ctx_fetch_and_index', 'builtin:web_fetch'])
    for (const h of ['claude', 'opencode', 'omp'] as const) {
      const d = routeTool(call(h, WEB_FETCH[h], { url: 'https://example.com/blog/post' }), POLICY, { 'web-fetch': 'down' })
      expect({ h, action: d.action }).toEqual({ h, action: 'deny' })
      if (d.action !== 'deny') continue
      expect(d.reason).toContain(harnessMcpToolName(h, 'context-mode', 'ctx_fetch_and_index'))
      expect(d.reason).toContain(harnessMcpToolName(h, 'context-mode', 'ctx_search'))
      expect(d.reason).not.toContain(harnessMcpToolName(h, 'web-fetch', 'fetch_url'))
    }
    expect(routeTool(call('claude', 'WebFetch', { url: 'https://example.com/blog/post' }), POLICY, withDisabledServers({ 'web-fetch': 'down' }, ['context-mode'])).action).toBe('allow')
    const docs = routeTool(call('claude', 'WebFetch', { url: 'https://docs.rs/serde' }), POLICY, { 'web-fetch': 'down' })
    expect(docs.action === 'deny' ? docs.reason : '').toContain('mcp__plugin_buracle_context7__resolve-library-id')
    expect(docs.action === 'deny' ? docs.reason : '').toContain('mcp__plugin_buracle_context-mode__ctx_fetch_and_index')
  })

  test('the web-fetch redirect names ctx_fetch_and_index then ctx_search for long pages while context-mode is available', () => {
    for (const h of ['claude', 'opencode', 'omp'] as const) {
      const d = routeTool(call(h, WEB_FETCH[h], { url: 'https://example.com/blog/post' }), POLICY, { 'web-fetch': 'ok' })
      const reason = d.action === 'deny' ? d.reason : ''
      expect(reason).toContain(harnessMcpToolName(h, 'web-fetch', 'fetch_url'))
      expect(reason).toContain(`For a long page you need only parts of, call \`${harnessMcpToolName(h, 'context-mode', 'ctx_fetch_and_index')}\` and then \`${harnessMcpToolName(h, 'context-mode', 'ctx_search')}\``)
    }
    const nudge = routeTool(call('claude', 'WebFetch', { url: 'https://example.com/blog/post' }), withStrictness('nudge'), {})
    expect(nudge.action === 'allow' ? nudge.context?.[0] : '').toContain('mcp__plugin_buracle_context-mode__ctx_fetch_and_index')
    for (const health of [{ 'context-mode': 'down' } as McpHealth, withDisabledServers({}, ['context-mode'])]) {
      const off = routeTool(call('claude', 'WebFetch', { url: 'https://example.com/blog/post' }), POLICY, health)
      expect(off.action === 'deny' ? off.reason : 'x').not.toContain('ctx_fetch_and_index')
    }
    const search = routeTool(call('claude', 'WebSearch', { query: 'x' }), POLICY, {})
    expect(search.action === 'deny' ? search.reason : 'x').not.toContain('context-mode')
  })

  test('library documentation pages go to context7 first', () => {
    for (const url of ['https://zod.readthedocs.io/en/latest/', 'https://docs.python.org/3/library/re.html', 'https://www.npmjs.com/package/zod', 'https://pypi.org/project/httpx/', 'https://pkg.go.dev/net/http', 'https://docs.rs/serde', 'https://developer.mozilla.org/en-US/docs/Web/API/fetch']) {
      expect({ url, docs: isDocsUrl(url) }).toEqual({ url, docs: true })
    }
    for (const url of ['https://example.com/docs', 'https://github.com/colinhacks/zod', 'https://www.npmjs.com/', 'not a url']) expect({ url, docs: isDocsUrl(url) }).toEqual({ url, docs: false })
    for (const h of ['claude', 'opencode', 'omp'] as const) {
      const d = routeTool(call(h, WEB_FETCH[h], { url: 'https://docs.rs/serde' }), POLICY, { 'web-fetch': 'ok', context7: 'ok' })
      expect(d.action).toBe('deny')
      if (d.action === 'deny') {
        expect(d.hook).toBe('H03')
        expect(d.reason).toContain('library documentation')
        expect(d.reason).toContain(harnessMcpToolName(h, 'context7', 'resolve-library-id'))
        expect(d.reason).toContain(harnessMcpToolName(h, 'web-fetch', 'fetch_url'))
      }
    }
    const fallback = routeTool(call('claude', 'WebFetch', { url: 'https://docs.rs/serde' }), POLICY, { 'web-fetch': 'down', 'context-mode': 'down' })
    expect(fallback.action).toBe('allow')
    expect(fallback.action === 'allow' ? fallback.context?.[0] : '').toContain('mcp__plugin_buracle_context7__resolve-library-id')
    const noDocs = routeTool(call('claude', 'WebFetch', { url: 'https://docs.rs/serde' }), POLICY, { context7: 'down' })
    expect(noDocs.action === 'deny' ? noDocs.reason : '').not.toContain('context7')
    const nudge = routeTool(call('claude', 'WebFetch', { url: 'https://docs.rs/serde' }), withStrictness('nudge'), {})
    expect(nudge.action === 'allow' ? nudge.context?.[0] : '').toContain('library documentation')
  })

  test('nudge allows with guidance; off allows silently', () => {
    const c = call('claude', 'WebSearch', { query: 'x' })
    const nudge = routeTool(c, withStrictness('nudge'), {})
    expect(nudge.action).toBe('allow')
    expect(nudge.action === 'allow' ? nudge.context?.[0] : '').toContain('mcp__plugin_buracle_web-search__search')
    expect(routeTool(c, withStrictness('off'), {})).toEqual({ action: 'allow' })
  })

  test('MCP calls and other tools are never routed', () => {
    const mcp = call('claude', 'mcp__plugin_buracle_web-search__search', { query: 'x' })
    expect(mcp.kind).toBe('mcp')
    expect(routeTool(mcp, POLICY, {})).toEqual({ action: 'allow' })
    expect(routeTool(call('claude', 'Read', { file_path: 'a.ts' }), POLICY, {})).toEqual({ action: 'allow' })
    expect(routeTool(call('claude', 'Edit', { file_path: 'a.ts' }), POLICY, {})).toEqual({ action: 'allow' })
  })

  test('health.json: a failed start keeps a server down only until its `until`; then the MCP route holds again', () => {
    const now = Date.UTC(2026, 9, 10, 12, 0, 0)
    const raw = {
      v: 1, checked_at: '2026-10-10T11:00:00.000Z',
      mcp: {
        'web-search': { status: 'down', source: 'launch', error: 'exited with code 1 while starting', until: new Date(now + 60_000).toISOString() },
        'web-fetch': { status: 'down', source: 'launch', until: new Date(now - 1).toISOString() },
        context7: { status: 'down', error: 'handshake failed' },
        semble: 'ok', codegraph: { status: 'bogus' }, grep: { status: 'down', until: 'not a date' },
      },
    }
    const health = mcpHealthOf(raw, now)
    expect(health).toEqual({ 'web-search': 'down', 'web-fetch': 'unknown', context7: 'down', semble: 'ok', grep: 'down' })
    const search = call('claude', 'WebSearch', { query: 'bun 1.4 changelog' })
    const redirected = routeTool(search, POLICY, health)
    expect(redirected.action === 'deny' ? redirected.reason : '').toContain('mcp__plugin_buracle_web-fetch__fetch_url')
    const again = routeTool(search, POLICY, mcpHealthOf(raw, now + 60_000))
    expect(again.action === 'deny' ? again.reason : '').toContain('mcp__plugin_buracle_web-search__search')
    expect(mcpHealthOf({ servers: { a: true, b: { ok: false } } }, now)).toEqual({ a: 'ok', b: 'down' })
    expect(mcpHealthOf({ v: 1, checked_at: 'x', a: 'down', b: 'unknown' }, now)).toEqual({ a: 'down', b: 'unknown' })
    expect(mcpHealthOf(null, now)).toEqual({})
  })

  test('a custom category can redirect to a healthy fallback server', () => {
    const policy: RoutingPolicy = { strictness: 'enforce', categories: [{ id: 'x', intent: 'x', prefer: ['mcp:web-search/search'], fallback: ['mcp:grep/searchGitHub', 'builtin:web_search'], deny_builtin: ['web_search'] }] }
    const health: McpHealth = { 'web-search': 'down', grep: 'ok' }
    const d = routeTool(call('claude', 'WebSearch', { query: 'x' }), policy, health)
    expect(d.action === 'deny' ? d.reason : '').toContain('mcp__plugin_buracle_grep__searchGitHub')
  })
})

describe('routeTool and bashNudge: shell searches', () => {
  const NUDGED = [
    'grep -r foo src', 'grep -rn "TODO" .', 'grep -R x .', 'grep -nr x', 'grep --recursive x .', 'egrep -r "a|b" lib', 'fgrep -r x .', 'rgrep x',
    'grep -d recurse x .', 'find . -name "*.ts" -exec grep -l foo {} +', 'find . -type f | xargs grep foo', 'find . -print0 | xargs -0 grep -n foo',
    'sudo grep -r secret /etc', "bash -c 'grep -r foo .'", 'cd src && grep -rl foo .',
  ]
  const QUIET = ['rg -n foo src', 'grep foo file.txt', 'ps aux | grep node', 'git grep foo', 'grep -e -r file', 'grep -n foo a.ts b.ts', 'find . -name "*.ts"', 'ls | xargs wc -l', 'cat a | grep -v b', 'grep -E "x|y" f']

  for (const cmd of NUDGED) {
    test(`nudges: ${cmd}`, () => {
      const n = bashNudge(cmd)
      expect(n).toBeDefined()
      expect(n).toContain('rg')
      expect(n).toContain('semble')
      expect(n).toContain('codegraph')
    })
  }
  for (const cmd of QUIET) test(`quiet: ${cmd}`, () => expect(bashNudge(cmd)).toBeUndefined())

  test('routeTool adds the nudge as context for shell calls, even when enforcing', () => {
    const d = routeTool(call('claude', 'Bash', { command: 'grep -r foo src' }), POLICY, {})
    expect(d.action).toBe('allow')
    expect(d.action === 'allow' ? d.context?.length : 0).toBe(1)
    expect(routeTool(call('codex', 'Bash', { command: 'rg foo' }), POLICY, {})).toEqual({ action: 'allow' })
    expect(routeTool(call('claude', 'Bash', { command: 'grep -r foo' }), withStrictness('off'), {})).toEqual({ action: 'allow' })
  })

  test('never throws on odd input', () => {
    expect(bashNudge('')).toBeUndefined()
    expect(bashNudge(undefined as unknown as string)).toBeUndefined()
    expect(() => bashNudge('$('.repeat(10_000))).not.toThrow()
  })

  test("Claude's Monitor command gets the same nudge as Bash; omp eval is never routed", () => {
    const d = routeTool(call('claude', 'Monitor', { command: 'grep -r ERROR logs', description: 'x', timeout_ms: 1 }), POLICY, {})
    expect(d.action === 'allow' ? d.context?.[0] : '').toContain('rg')
    expect(routeTool(call('omp', 'eval', { language: 'js', code: 'x' }), POLICY, {})).toEqual({ action: 'allow' })
    expect(validateRoutingPolicy({ ...POLICY, categories: [{ ...(POLICY.categories[0] as RoutingPolicy['categories'][number]), prefer: ['builtin:eval'] }] })).toEqual([])
  })
})

describe('routeTool: context-mode sandbox hints for shell output (hints only, never denials)', () => {
  const hintOf = (command: string, h: Harness = 'claude', policy: RoutingPolicy = POLICY, health: McpHealth = {}): string | undefined => {
    const d = routeTool(call(h, h === 'claude' ? 'Bash' : h === 'codex' ? 'Bash' : 'bash', { command }), policy, health)
    expect(d.action).toBe('allow')
    return d.action === 'allow' ? d.context?.find(c => c.includes('context')) : undefined
  }
  const REMOTE = [
    'curl https://api.github.com/repos/oven-sh/bun/releases/latest', 'curl -sSL https://example.com/page.html', 'curl -s https://example.com 2>/dev/null',
    'curl -o - https://example.com/data.json', 'curl --url https://example.com/x', 'curl -H "Accept: application/json" example.com/api',
    'wget -qO- https://example.com/install.txt', 'wget -O - https://example.com/a', 'wget --output-document=- https://example.com/a',
    'http GET https://api.example.com/users', 'xh https://example.com/feed', 'cd /tmp && curl https://example.com/report.csv',
    "bash -c 'curl https://example.com/big.json'",
  ]
  const BUILDS = ['./gradlew test', 'gradle build --info', 'mvn -q verify', './mvnw clean install', 'sbt compile', 'cd app && ./gradlew assemble 2>&1']
  const QUIET = [
    'curl -s https://api.github.com/repos/x/y | jq .tag_name', 'curl -o page.html https://example.com', 'curl -O https://example.com/a.tgz',
    'curl https://example.com > page.html', 'curl -I https://example.com', 'curl --version', 'curl -fsSL https://example.com/install.sh -o install.sh',
    'wget https://example.com/file.tar.gz', 'wget -q https://example.com/x', 'http --download https://example.com/big.iso', 'http -o out.json example.com/api',
    'curl localhost:3000/health', 'curl http://127.0.0.1:8080/api', 'curl -i http://[::1]:3000/', 'http :3000/health', 'xh :8080/api', 'curl http://0.0.0.0:5000',
    'curl "$URL"', 'curl $(cat url.txt)',
    'mvn -v', './gradlew --version', 'sbt --help', './gradlew test | tail -40', 'mvn test > build.log',
    'git log --oneline -5', 'ls -la', 'echo https://example.com',
  ]

  for (const cmd of REMOTE) {
    test(`remote response: ${cmd}`, () => {
      const hint = hintOf(cmd)
      expect(hint).toContain('remote response')
      expect(hint).toContain('`mcp__plugin_buracle_context-mode__ctx_fetch_and_index`')
      expect(hint).toContain('`mcp__plugin_buracle_context-mode__ctx_search`')
      expect(hint).toContain('`mcp__plugin_buracle_context-mode__ctx_execute`')
    })
  }
  for (const cmd of BUILDS) {
    test(`goal-build: ${cmd}`, () => {
      const hint = hintOf(cmd)
      expect(hint).toContain('Build output is long')
      expect(hint).toContain('`mcp__plugin_buracle_context-mode__ctx_batch_execute`')
      expect(hint).toContain('every failure with its message')
    })
  }
  for (const cmd of QUIET) test(`no hint: ${cmd}`, () => expect(hintOf(cmd)).toBeUndefined())

  test('every harness names its own tools; enforce and nudge both hint and never deny', () => {
    for (const h of HARNESSES) {
      for (const s of ['enforce', 'nudge'] as const) {
        const hint = hintOf('curl https://example.com/changelog', h, withStrictness(s))
        expect({ h, s, hint }).toEqual({ h, s, hint: expect.stringContaining(`\`${harnessMcpToolName(h, 'context-mode', 'ctx_fetch_and_index')}\``) })
      }
    }
    expect(harnessMcpToolName('codex', 'context-mode', 'ctx_execute')).toBe('mcp__context_mode__ctx_execute')
    expect(harnessMcpToolName('opencode', 'context-mode', 'ctx_execute')).toBe('context-mode_ctx_execute')
    expect(harnessMcpToolName('omp', 'context-mode', 'ctx_execute')).toBe('mcp__context_mode_ctx_execute')
  })

  test('no hint while context-mode is down, switched off or not in the policy, nor under strictness off', () => {
    expect(hintOf('./gradlew test', 'claude', POLICY, { 'context-mode': 'down' })).toBeUndefined()
    expect(hintOf('./gradlew test', 'claude', POLICY, withDisabledServers({ 'context-mode': 'ok' }, ['context-mode']))).toBeUndefined()
    const without: RoutingPolicy = { ...POLICY, categories: POLICY.categories.filter(c => c.id !== 'context-saving').map(c => ({ ...c, fallback: c.fallback.filter(f => !f.includes('context-mode')) })) }
    expect(hintOf('./gradlew test', 'claude', without)).toBeUndefined()
    expect(routeTool(call('claude', 'Bash', { command: './gradlew test' }), withStrictness('off'), {})).toEqual({ action: 'allow' })
  })

  test('the grep nudge and the sandbox hint come together, nudge first', () => {
    const d = routeTool(call('claude', 'Bash', { command: 'grep -r TODO src && curl https://example.com/x' }), POLICY, {})
    expect(d.action === 'allow' ? d.context?.length : 0).toBe(2)
    expect(d.action === 'allow' ? d.context?.[0] : '').toContain('rg')
  })
})

describe('withDisabledServers', () => {
  test('marks the given servers down and keeps the rest', () => {
    expect(withDisabledServers({ 'context-mode': 'ok', semble: 'unknown' }, ['context-mode'])).toEqual({ 'context-mode': 'down', semble: 'unknown' })
    expect(withDisabledServers({}, ['context-mode'])).toEqual({ 'context-mode': 'down' })
    const h: McpHealth = { a: 'ok' }
    expect(withDisabledServers(h, [])).toBe(h)
    expect(withDisabledServers(h, ['', 3 as unknown as string])).toBe(h)
  })
})

describe('capabilityCard (H15)', () => {
  const bundle = loadCanonicalSync(CANON)
  const card = (h: Harness, extra: Partial<{ mcp: CatalogMcp[], skills: CatalogSkill[], plugins: string[], policy: RoutingPolicy }> = {}): string =>
    capabilityCard({ policy: extra.policy ?? POLICY, mcp: extra.mcp ?? catalogMcp(bundle.mcp, h), skills: extra.skills ?? catalogSkills(bundle.skills), plugins: extra.plugins ?? bundle.plugins.claude.plugins.map(p => p.id), harness: h })

  test('fits in 30 lines for every harness with the real catalog', () => {
    expect(CAPABILITY_CARD_MAX_LINES).toBe(30)
    for (const h of HARNESSES) expect(card(h).split("\n").length).toBeLessThanOrEqual(CAPABILITY_CARD_MAX_LINES)
  })

  test('the real card of each harness (Claude with its LSP line) fits in 30 lines with every server and skill on its own line', () => {
    const skills = catalogSkills(bundle.skills)
    const lsp = bundle.tools.tools.flatMap(t => (t.lsp !== undefined ? [t.lsp.id] : []))
    expect(lsp.length).toBeGreaterThan(0)
    const plugins: Record<Harness, string[]> = {
      claude: bundle.plugins.claude.plugins.filter(p => p.enabled).map(p => p.id),
      codex: [],
      opencode: bundle.plugins.opencode.plugins.filter(p => p.enabled).map(p => p.id),
      omp: bundle.plugins.omp.plugins.filter(p => p.enabled).map(p => p.id),
    }
    for (const h of HARNESSES) {
      const mcp = catalogMcp(bundle.mcp, h)
      const c = capabilityCard({ policy: POLICY, mcp, skills, plugins: plugins[h], harness: h, ...(h === 'claude' ? { lsp } : {}) })
      const lines = c.split('\n')
      expect({ h, lines: lines.length, fits: lines.length <= CAPABILITY_CARD_MAX_LINES }).toEqual({ h, lines: lines.length, fits: true })
      for (const m of mcp) expect({ h, server: m.id, listed: lines.some(l => l.startsWith(`- ${m.id}${m.critical ? '' : '*'}: `)) }).toEqual({ h, server: m.id, listed: true })
      for (const s of skills) expect({ h, skill: s.id, oneLiner: lines.includes(`- ${s.id}: ${s.short}${s.invocation === 'explicit' ? ' (on request)' : ''}`) }).toEqual({ h, skill: s.id, oneLiner: true })
      expect(c).not.toContain('more lines omitted')
    }
    expect(catalogMcp(bundle.mcp, 'claude').map(m => m.id)).toContain('context-mode')
    const claude = capabilityCard({ policy: POLICY, mcp: catalogMcp(bundle.mcp, 'claude'), skills, plugins: plugins.claude, harness: 'claude', lsp })
    expect(claude).toContain('Language servers (LSP tool: definitions, references, hover, diagnostics): ')
    expect(claude.split('\n')[0]).toBe('Buracle capabilities (Claude Code). Tool routing is enforced: follow "Tool routing (strict)" in your rules. Buracle names the skills and MCP servers each prompt calls for and holds a few calls until the right tool has run; when it denies a call, use the tool the denial names.')
  })

  test('context-mode drops off the card while it is switched off (withDisabledServers, as the adapters filter down servers)', () => {
    const health = withDisabledServers({}, ['context-mode'])
    const c = card('codex', { mcp: catalogMcp(bundle.mcp, 'codex').filter(m => health[m.id] !== 'down') })
    expect(c).not.toContain('- context-mode')
    expect(card('codex')).toContain('- context-mode: ')
  })

  test('lists installed servers and skills with the harness syntax and points to the routing rules', () => {
    const c = card('claude')
    expect(c).toContain('Tool routing (strict)')
    expect(c).toContain('mcp__plugin_buracle_<server>__<tool>')
    expect(c).toContain('Skills (the user starts a workflow with /<id>; you load the others with the Skill tool as buracle:<id>):')
    for (const id of MCP_IDS) expect(c).toContain(`- ${id}`)
    expect(c).not.toContain('Plugins:')
    expect(card('claude', { plugins: ['lint-lsp@acme-market'] })).toContain('Plugins: lint-lsp')
    expect(capabilityCard({ policy: POLICY, mcp: [], skills: [], plugins: [], harness: 'claude', lsp: ['typescript', 'pyright', 'gopls'] })).toContain('Language servers (LSP tool: definitions, references, hover, diagnostics): gopls, pyright, typescript')
    expect(card('omp')).not.toContain('chrome-devtools')
    expect(card('codex')).toContain('Skills (the user starts a workflow with $<id>; you load one by reading ~/.agents/skills/<id>/SKILL.md):')
    expect(card('omp')).toContain('Skills (the user starts a workflow with /<id>; you load one by reading skill://<id>):')
    expect(c).toContain('Buracle names the skills and MCP servers each prompt calls for')
  })

  test('skill lines use the short description and mark the workflows that start on request', () => {
    const c = card('claude')
    const skills = catalogSkills(bundle.skills)
    for (const s of skills) {
      expect(s.short).toBeDefined()
      expect(c).toContain(`- ${s.id}: ${s.short}${s.invocation === 'explicit' ? ' (on request)' : ''}`)
    }
    expect(skills.filter(s => s.invocation === 'explicit').map(s => s.id)).toEqual(['bugfix', 'dead-code', 'goal-build', 'inspect', 'plan-build', 'requirements'])
    expect(card('codex', { skills: [{ id: 'x', description: 'Does one thing well. Then more.', userInvocable: true }] })).toContain('- x: Does one thing well')
  })

  test('OpenCode v2: skills load through the skill tool; non-critical servers sit behind Code Mode', () => {
    const c = card('opencode')
    expect(c).toContain('Skills (the user starts a workflow with /<id>; you load one with the skill tool):')
    expect(c).toContain('execute tool')
    expect(c).not.toContain('tool search')
    expect(c).toMatch(/^- grep\*: /m)
    expect(c).toMatch(/^- context7: /m)
    expect(card('claude')).toContain('find its tools with tool search')
  })

  test('Codex and omp: the * of a non-critical server says how the harness hides it', () => {
    expect(card('codex')).toContain('may be deferred: find its tools with tool_search')
    expect(card('codex')).toMatch(/^- grep\*: /m)
    expect(card('codex')).toMatch(/^- context7: /m)
    expect(card('omp')).toContain('may be an xd:// device instead of a tool')
    expect(card('omp')).toMatch(/^- grep\*: /m)
  })

  test('does not repeat the routing table of tooling.md', () => {
    const c = card('claude')
    expect(c).not.toContain('| Need |')
    expect(c).not.toContain('Fallback')
    for (const cat of POLICY.categories) expect(c).not.toContain(cat.intent)
  })

  test('is deterministic: input order and duplicates do not change the text', () => {
    const mcp = catalogMcp(bundle.mcp, 'claude')
    const skills = catalogSkills(bundle.skills)
    const a = card('claude', { mcp, skills, plugins: ['b@m', 'a@m'] })
    const b = card('claude', { mcp: [...mcp].reverse().concat(mcp[0] as CatalogMcp), skills: [...skills].reverse(), plugins: ['a@m', 'b@m', 'a@m'] })
    expect(a).toBe(b)
    expect(card('claude')).toBe(card('claude'))
  })

  test('reflects strictness in one line', () => {
    expect(card('claude', { policy: { ...POLICY, strictness: 'nudge' } })).toContain('advisory')
    expect(card('claude', { policy: { ...POLICY, strictness: 'off' } })).toContain('off')
  })

  test('compacts long catalogs instead of exceeding the limit', () => {
    const many: CatalogSkill[] = Array.from({ length: 60 }, (_, i) => ({ id: `skill-${String(i).padStart(2, '0')}`, description: `Skill number ${i} does a thing.`, userInvocable: true }))
    const mcp: CatalogMcp[] = Array.from({ length: 30 }, (_, i) => ({ id: `srv-${String(i).padStart(2, '0')}`, description: 'A server.', transport: 'stdio', critical: true, routing: [], harnesses: ['claude'] }))
    const c = card('claude', { skills: many, mcp })
    expect(c.split('\n').length).toBeLessThanOrEqual(CAPABILITY_CARD_MAX_LINES)
    expect(c).toContain('skill-00')
    expect(c).toContain('srv-00')
  })

  test('works with empty inputs', () => {
    const c = capabilityCard({ policy: POLICY, mcp: [], skills: [], plugins: [], harness: 'codex' })
    expect(c.split('\n').length).toBe(1)
    expect(c).toStartWith('Buracle capabilities (Codex). ')
    expect(c).toContain('Tool routing (strict)')
  })
})
