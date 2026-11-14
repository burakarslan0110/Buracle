import { describe, expect, test } from 'bun:test'
import type { Harness, ToolCall } from '../../../src/core/events'
import { classifyTool } from '../../../src/core/events'
import { isGuardContinuation } from '../../../src/core/policy/intents'
import type { PathRuleSource } from '../../../src/core/policy/path-rules'
import type { PromptRoute } from '../../../src/core/policy/skill-router'
import type { ReminderContext, UsageLedger, WorkspaceFacts } from '../../../src/core/policy/usage'
import {
  emptyLedger, ledgerAudited, ledgerCall, ledgerMcpResult, ledgerPrompt, MCP_SESSION_DOWN_ERRORS, parseLedger, reminders, rootProblem, sessionMcpHealth, skillOf, turnAudit,
} from '../../../src/core/policy/usage'
import { routeTool } from '../../../src/core/policy/routing'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'

const MCP_IDS = ['buracle-memory', 'chrome-devtools', 'codegraph', 'context7', 'grep', 'semble', 'web-fetch', 'web-search']
const POLICY = loadCanonicalSync(paths.canonicalDir()).routing
const NOW = 1_800_000_000_000

function call(harness: Harness, tool: string, input: Record<string, unknown>, cwd = '/repo'): ToolCall {
  return { harness, sessionId: 's', cwd, tool, input, ...classifyTool(harness, tool, input, cwd, MCP_IDS) }
}
const route = (p: Partial<PromptRoute> = {}): PromptRoute => ({ invoked: [], load: [], candidates: [], categories: [], memory: { recall: false, write: false }, ...p })
const ctx = (over: Partial<ReminderContext> = {}): ReminderContext => ({
  strictness: 'enforce', available: MCP_IDS, policy: POLICY,
  facts: { root: '/Users/u/code/app', home: '/Users/u', excluded: ['/Users/u/Documents/Buracle', '/Users/u/.buracle'], codegraphIndexed: true },
  ...over,
})
const fresh = (r: PromptRoute = route()): UsageLedger => ledgerPrompt(emptyLedger(), r, NOW)
const mcp = (server: string, tool: string, input: Record<string, unknown> = {}): ToolCall => call('claude', `mcp__plugin_buracle_${server}__${tool}`, input)

describe('ledger records', () => {
  test('a prompt advances the turn, resets the turn counters and keeps the route', () => {
    let l = fresh(route({ invoked: ['plan-build'] }))
    expect(l.turn).toBe(1)
    expect(l.skills['plan-build']).toEqual({ n: 1, turn: 1 })
    l = ledgerCall(l, call('claude', 'Grep', { pattern: 'x' }))
    expect(l.turnTools.search).toBe(1)
    l = ledgerPrompt(l, route({ load: ['bugfix'] }), NOW + 1)
    expect(l.turn).toBe(2)
    expect(l.turnTools).toEqual({ calls: 0, search: 0, read: [], graph: 0, memory: 0 })
    expect(l.prompt).toEqual({ turn: 2, at: NOW + 1, route: route({ load: ['bugfix'] }) })
    expect(l.streak.search).toBe(1)
  })

  test('skill loads are recognized on every harness', () => {
    expect(skillOf(call('claude', 'Skill', { skill: 'buracle:research' }), 'claude')).toBe('research')
    expect(skillOf(call('claude', 'Skill', { skill: 'research', args: 'x' }), 'claude')).toBe('research')
    expect(skillOf(call('claude', 'Skill', { skill: 'anthropic-skills:pdf' }), 'claude')).toBeUndefined()
    expect(skillOf(call('claude', 'Read', { file_path: '/Users/u/.claude/plugins/cache/buracle/skills/plan-build/SKILL.md' }), 'claude')).toBe('plan-build')
    expect(skillOf(call('claude', 'Read', { file_path: '/repo/src/skills.ts' }), 'claude')).toBeUndefined()
    expect(skillOf(call('codex', 'Bash', { command: 'cat ~/.codex/skills/plan-build/SKILL.md' }), 'codex')).toBe('plan-build')
    expect(skillOf(call('codex', 'Bash', { command: "sed -n '1,120p' /Users/u/.agents/skills/bugfix/SKILL.md" }), 'codex')).toBe('bugfix')
    expect(skillOf(call('opencode', 'skill', { id: 'research' }), 'opencode')).toBe('research')
    expect(skillOf(call('omp', 'read', { path: 'skill://research' }), 'omp')).toBe('research')
    expect(skillOf(call('omp', 'read', { path: 'skill://plan-build/references/phases.md' }), 'omp')).toBe('plan-build')
    expect(skillOf(call('codex', 'Bash', { command: 'ls skills' }), 'codex')).toBeUndefined()
  })

  test('MCP calls: semble and codegraph reset the search streak', () => {
    let l = fresh()
    l = ledgerCall(l, call('claude', 'Bash', { command: 'rg -n parseConfig src' }))
    l = ledgerCall(l, call('claude', 'Grep', { pattern: 'x' }))
    expect(l.streak.search).toBe(2)
    l = ledgerCall(l, mcp('codegraph', 'codegraph_callers', { symbol: 'routePrompt' }))
    expect(l.mcp['codegraph']).toEqual({ n: 1, turn: 1 })
    expect(l.streak.search).toBe(0)
    expect(l.turnTools.graph).toBe(1)
  })

  test('searches, reads and memory searches are counted per turn', () => {
    let l = fresh()
    for (const c of [call('claude', 'Grep', { pattern: 'a' }), call('claude', 'Glob', { pattern: '**/*.ts' }), call('codex', 'Bash', { command: 'git grep -n foo' }), call('codex', 'Bash', { command: 'find . -name x' })]) l = ledgerCall(l, c)
    expect(l.turnTools.search).toBe(4)
    l = ledgerCall(l, call('claude', 'LS', { path: '/repo' }))
    l = ledgerCall(l, call('codex', 'Bash', { command: 'ls -la' }))
    expect(l.turnTools.search).toBe(4)
    for (const f of ['a.ts', 'b.ts', 'a.ts']) l = ledgerCall(l, call('claude', 'Read', { file_path: `/repo/${f}` }))
    expect(l.turnTools.read).toEqual(['/repo/a.ts', '/repo/b.ts'])
    l = ledgerCall(l, call('codex', 'Bash', { command: 'buracle mem search "cache layer"' }))
    expect(l.turnTools.memory).toBe(1)
    expect(l.mcp['buracle-memory']?.n).toBe(1)
    expect(l.turnTools.calls).toBe(10)
  })

  test('an MCP server that failed two calls in a row counts as down for the session; a success clears it', () => {
    let l = fresh()
    l = ledgerMcpResult(l, 'web-search', false)
    expect(sessionMcpHealth({ 'web-search': 'ok' }, l)).toEqual({ 'web-search': 'ok' })
    l = ledgerMcpResult(l, 'web-search', false)
    const health = sessionMcpHealth({ 'web-search': 'ok', context7: 'unknown' }, l)
    expect(health).toEqual({ 'web-search': 'down', context7: 'unknown' })
    const search = call('claude', 'WebSearch', { query: 'bun 1.4 changelog' })
    const redirected = routeTool(search, { ...POLICY, strictness: 'enforce' }, health)
    expect(redirected.action === 'deny' ? redirected.reason : '').toContain('mcp__plugin_buracle_web-fetch__fetch_url')
    const both = ledgerMcpResult(ledgerMcpResult(l, 'web-fetch', false), 'web-fetch', false)
    expect(routeTool(search, { ...POLICY, strictness: 'enforce' }, sessionMcpHealth({ 'web-search': 'ok' }, both)).action).toBe('allow')
    expect(routeTool(search, { ...POLICY, strictness: 'enforce' }, sessionMcpHealth({}, emptyLedger())).action).toBe('deny')
    expect(parseLedger(JSON.parse(JSON.stringify(l))).mcpErrors).toEqual({ 'web-search': MCP_SESSION_DOWN_ERRORS })
    l = ledgerMcpResult(l, 'web-search', true)
    expect(sessionMcpHealth({ 'web-search': 'ok' }, l)).toEqual({ 'web-search': 'ok' })
    expect(l.mcpErrors).toBeUndefined()
  })

  test('parseLedger reads what it wrote and drops malformed parts', () => {
    let l = fresh(route({ load: ['plan-build'], memory: { recall: true, write: false, cli: true }, libs: ['zod'] }))
    l = ledgerCall(l, mcp('codegraph', 'codegraph_impact', { symbol: 'foo' }))
    expect(parseLedger(JSON.parse(JSON.stringify(l)))).toEqual(l)
    expect(parseLedger(null)).toEqual(emptyLedger())
    expect(parseLedger({ v: 2 })).toEqual(emptyLedger())
    const odd = parseLedger({ v: 1, turn: 'x', mcp: { a: { n: 1, turn: 1 }, b: 'no' }, prompt: { turn: 1, at: 2, route: 'bad' } })
    expect(odd.turn).toBe(0)
    expect(odd.mcp).toEqual({ a: { n: 1, turn: 1 } })
    expect(odd.prompt).toBeUndefined()
  })
})

describe('gate: the semble repo and codegraph projectPath', () => {
  test('home, /, an excluded folder or a parent of the project is denied and the root named', () => {
    for (const [server, key, value] of [['semble', 'repo', '/Users/u'], ['semble', 'repo', '/'], ['codegraph', 'projectPath', '/Users/u/code'], ['semble', 'repo', '/Users/u/Documents/Buracle/projects'], ['semble', 'repo', '~']] as const) {
      const c = mcp(server, server === 'semble' ? 'search' : 'codegraph_callers', { [key]: value, query: 'x' })
      const r = reminders(fresh(), c, ctx())
      expect({ value, deny: r.deny?.key }).toEqual({ value, deny: 'root' })
      expect(r.deny?.reason).toContain('/Users/u/code/app')
      expect(r.next.mcp[server]).toBeUndefined()
    }
  })

  test('the root, a folder inside it or no argument are fine; nudge mode only reminds', () => {
    for (const value of ['/Users/u/code/app', '/Users/u/code/app/packages/core', undefined]) {
      const r = reminders(fresh(), mcp('semble', 'search', value === undefined ? { query: 'x' } : { repo: value, query: 'x' }), ctx())
      expect(r.deny).toBeUndefined()
      expect(r.next.mcp['semble']?.n).toBe(1)
    }
    const nudge = reminders(fresh(), mcp('semble', 'search', { repo: '/Users/u' }), ctx({ strictness: 'nudge' }))
    expect(nudge.deny).toBeUndefined()
    expect(nudge.context).toContain('Pass the project root /Users/u/code/app instead')
    const ci = reminders(fresh(), mcp('semble', 'search', { repo: '/users/U/' }), ctx({ facts: { home: '/Users/u', caseInsensitive: true } }))
    expect(ci.deny?.key).toBe('root')
  })

  test('one rule for every harness: a folder of projects, parents of home, index.exclude names and globs, the real path', () => {
    const exclusion = { home: '/Users/u', buracleHome: '/Users/u/.buracle', vault: '/Users/u/Documents/Buracle', exclude: ['vendor', '**/build'], caseInsensitive: false }
    const folder: WorkspaceFacts = { home: '/Users/u', exclusion, cwd: '/Users/u/dev', children: ['/Users/u/dev/alpha', '/Users/u/dev/beta'] }
    const deny = (repo: string, facts: WorkspaceFacts = folder) => reminders(fresh(), mcp('semble', 'search', { repo, query: 'x' }), ctx({ facts })).deny?.reason
    expect(deny('/Users/u/dev')).toContain('/Users/u/dev, a folder of projects, not a project')
    expect(deny('/Users/u/dev/')).toContain('Pass one of its projects instead (alpha, beta), as /Users/u/dev/<name>.')
    expect(deny('/Users')).toContain('a parent of your home folder')
    expect(deny('/Users/u/dev/alpha/vendor')).toContain('excluded by index.exclude (vendor)')
    expect(deny('/Users/u/dev/beta/app/build')).toContain('excluded by index.exclude (**/build)')
    expect(deny('/Users/u/Documents/Buracle/projects')).toContain('inside the memory vault')
    expect(deny('/Users/u/dev/alpha')).toBeUndefined()
    expect(deny('alpha')).toBeUndefined()
    const linked: WorkspaceFacts = { ...folder, realpath: p => (p === '/link/home' ? '/Users/u' : p) }
    expect(deny('/link/home', linked)).toContain('your home folder')
    expect(deny('/Users/u/dev', { ...folder, root: '/Users/u/dev/alpha', children: [] })).toContain('a parent folder of the project; indexing it is slow and searches the wrong tree. Pass the project root /Users/u/dev/alpha instead.')
    expect(rootProblem('/Users/u/dev', folder)).toBe('a folder of projects, not a project')
    expect(rootProblem('~', { home: '/Users/u' })).toBe('your home folder')
    expect(rootProblem('/Users/u/dev', undefined)).toBeUndefined()
  })
})

describe('gate R5: the first edit of a file a path rule covers (Codex, OpenCode)', () => {
  const RULE_DIR = '/Users/u/.buracle/rules/paths'
  const BODIES: Record<string, string> = {
    typescript: '---\npaths:\n  - "**/*.ts"\n---\n# TypeScript\n\n- Keep strict on.\n',
    frontend: '---\npaths:\n  - "**/*.tsx"\n---\n# Frontend\n\n- Semantic elements first.\n',
    go: '# Go\n\n- gofmt every file.\n',
  }
  const rules = (over: Partial<PathRuleSource> = {}): PathRuleSource => ({
    rules: [{ id: 'frontend', globs: ['**/*.tsx'] }, { id: 'go', globs: ['**/*.go'] }, { id: 'typescript', globs: ['**/*.ts', '**/*.tsx'] }],
    dir: RULE_DIR, body: id => BODIES[id], ...over,
  })
  const APP = '/Users/u/code/app'
  const write = (file: string, h: Harness = 'opencode'): ToolCall => call(h, 'write', { filePath: file, content: 'x' }, APP)
  const patch = (path: string): ToolCall => call('codex', 'apply_patch', { input: ['*** Begin Patch', `*** Add File: ${path}`, '+package main', '*** End Patch'].join('\n') }, APP)

  test('enforce denies the first edit with every matching rule in one denial; the retry runs; one delivery per rule', () => {
    const first = reminders(fresh(), write(`${APP}/src/App.tsx`), ctx({ pathRules: rules() }))
    expect(first.deny?.key).toBe('R5:frontend')
    expect(first.deny?.reason).toContain('src/App.tsx matches the path rules `frontend`, `typescript`')
    expect(first.deny?.reason).toContain('# Frontend\n\n- Semantic elements first.')
    expect(first.deny?.reason).toContain('# TypeScript\n\n- Keep strict on.')
    expect(first.deny?.reason).not.toContain('paths:')
    expect(first.next.usedOnce).toEqual(['R5:frontend', 'R5:typescript'])
    const retry = reminders(first.next, write(`${APP}/src/App.tsx`), ctx({ pathRules: rules() }))
    expect(retry.deny).toBeUndefined()
    expect(retry.context).toBeUndefined()
    expect(reminders(retry.next, write(`${APP}/src/util.ts`), ctx({ pathRules: rules() })).deny).toBeUndefined()
    expect(reminders(retry.next, write(`${APP}/cmd/main.go`), ctx({ pathRules: rules() })).deny?.key).toBe('R5:go')
  })

  test('a Codex patch is judged on its files, relative ones under the working folder', () => {
    const r = reminders(fresh(), patch('cmd/main.go'), ctx({ pathRules: rules() }))
    expect(r.deny?.key).toBe('R5:go')
    expect(r.deny?.reason).toContain('cmd/main.go matches the path rule `go`, which this session has not read yet')
    expect(reminders(fresh(), patch('README.md'), ctx({ pathRules: rules() })).deny).toBeUndefined()
  })

  test('deleting a file is no edit: a patch that only deletes passes, its other files are still judged', () => {
    const del = (...lines: string[]): ToolCall => call('codex', 'apply_patch', { input: ['*** Begin Patch', ...lines, '*** End Patch'].join('\n') }, APP)
    const gone = reminders(fresh(), del('*** Delete File: cmd/old.go'), ctx({ pathRules: rules() }))
    expect(gone.deny).toBeUndefined()
    expect(gone.next.usedOnce).toEqual([])
    const moved = reminders(fresh(), del('*** Delete File: cmd/old.go', '*** Add File: src/new.ts', '+export {}'), ctx({ pathRules: rules() }))
    expect(moved.deny?.key).toBe('R5:typescript')
    expect(moved.deny?.reason).toContain('src/new.ts matches the path rule `typescript`')
    const diff = call('opencode', 'apply_patch', { patchText: ['--- a/cmd/old.go', '+++ /dev/null', '@@ -1 +0,0 @@', '-package main'].join('\n') }, APP)
    expect(reminders(fresh(), diff, ctx({ pathRules: rules() })).deny).toBeUndefined()
  })

  test('reading the rule file counts as delivery: Codex shell reads and file-tool reads', () => {
    const cat = reminders(fresh(), call('codex', 'Bash', { command: 'cat ~/.buracle/rules/paths/go.md' }, APP), ctx({ pathRules: rules() }))
    expect(cat.next.usedOnce).toEqual(['R5:go'])
    expect(reminders(cat.next, patch('cmd/main.go'), ctx({ pathRules: rules() })).deny).toBeUndefined()
    const shell = (command: string): string[] => reminders(fresh(), call('codex', 'Bash', { command }, APP), ctx({ pathRules: rules() })).next.usedOnce
    expect(shell('cat "$BURACLE_HOME/rules/paths/go.md"')).toEqual(['R5:go'])
    expect(shell("sed -n '1,80p' ${BURACLE_HOME}/rules/paths/go.md")).toEqual(['R5:go'])
    expect(shell('head -n 100 "$HOME/.buracle/rules/paths/go.md" | tail -n 50')).toEqual(['R5:go'])
    expect(shell(`nl ${RULE_DIR}/frontend.md`)).toEqual(['R5:frontend'])
    expect(shell('echo ~/.buracle/rules/paths/go.md')).toEqual([])
    expect(shell('ls -l ~/.buracle/rules/paths/go.md')).toEqual([])
    expect(shell('rg -n gofmt ~/.buracle/rules/paths/go.md')).toEqual([])
    expect(shell('cat "$OTHER/rules/paths/go.md"')).toEqual([])
    expect(shell("cat '~/.buracle/rules/paths/go.md'")).toEqual([])
    expect(shell('cat "~/.buracle/rules/paths/go.md"')).toEqual([])
    expect(shell('cat /tmp/x/.buracle/rules/paths/go.md')).toEqual([])
    expect(shell('cat "${HOME}/.buracle/rules/paths/go.md"')).toEqual(['R5:go'])
    const read = reminders(fresh(), call('opencode', 'read', { filePath: `${RULE_DIR}/frontend.md` }, APP), ctx({ pathRules: rules() }))
    expect(read.next.usedOnce).toEqual(['R5:frontend'])
    expect(reminders(read.next, write(`${APP}/src/App.tsx`), ctx({ pathRules: rules() })).deny?.reason).toContain('the path rule `typescript`')
  })

  test('OpenCode delivers the rules with the first read of a matching file, so the edit passes', () => {
    const read = reminders(fresh(), call('opencode', 'read', { filePath: `${APP}/src/App.tsx` }, APP), ctx({ pathRules: rules({ onRead: true }) }))
    expect(read.deny).toBeUndefined()
    expect(read.context).toContain('src/App.tsx matches the path rules `frontend`, `typescript`; follow them when you change files like this one.')
    expect(reminders(read.next, write(`${APP}/src/App.tsx`), ctx({ pathRules: rules() })).deny).toBeUndefined()
    expect(reminders(fresh(), call('opencode', 'read', { filePath: `${APP}/src/App.tsx` }, APP), ctx({ pathRules: rules() })).context).toBeUndefined()
  })

  test('nudge gives the rule text as context once; off, reminders off and no source leave edits alone', () => {
    const nudge = reminders(fresh(), write(`${APP}/cmd/main.go`), ctx({ strictness: 'nudge', pathRules: rules() }))
    expect(nudge.deny).toBeUndefined()
    expect(nudge.context).toContain('cmd/main.go matches the path rule `go`; follow it for this change.\n\n# Go')
    expect(reminders(nudge.next, write(`${APP}/cmd/main.go`), ctx({ strictness: 'nudge', pathRules: rules() })).context).toBeUndefined()
    expect(reminders(fresh(), write(`${APP}/cmd/main.go`), ctx({ strictness: 'nudge', reminders: false, pathRules: rules() })).context).toBeUndefined()
    expect(reminders(fresh(), write(`${APP}/cmd/main.go`), ctx({ strictness: 'off', pathRules: rules() })).deny).toBeUndefined()
    expect(reminders(fresh(), write(`${APP}/cmd/main.go`), ctx()).deny).toBeUndefined()
  })

  test('a rule whose file is not installed is not delivered and stays pending', () => {
    const missing = rules({ body: id => (id === 'typescript' ? undefined : BODIES[id]) })
    const r = reminders(fresh(), write(`${APP}/src/App.tsx`), ctx({ pathRules: missing }))
    expect(r.deny?.reason).toContain('src/App.tsx matches the path rule `frontend`, which')
    expect(r.next.usedOnce).toEqual(['R5:frontend'])
    expect(reminders(fresh(), write(`${APP}/src/a.ts`), ctx({ pathRules: missing })).deny).toBeUndefined()
    expect(reminders(r.next, write(`${APP}/src/a.ts`), ctx({ pathRules: rules() })).deny?.key).toBe('R5:typescript')
  })
})

describe('context reminders', () => {
  test('a built-in Grep that reads like a question points to semble, with a cooldown', () => {
    const r = reminders(fresh(), call('claude', 'Grep', { pattern: 'where is the config loaded' }), ctx())
    expect(r.context).toContain('semble search')
    expect(reminders(r.next, call('claude', 'Grep', { pattern: 'where is the token refreshed' }), ctx()).context).toBeUndefined()
    expect(reminders(fresh(), call('claude', 'Grep', { pattern: 'export (function|const) \\w+' }), ctx()).context).toBeUndefined()
    expect(reminders(fresh(), call('claude', 'Grep', { pattern: 'where is the config loaded' }), ctx({ available: ['codegraph'] })).context).toBeUndefined()
    const grep2 = call('claude', 'Grep', { pattern: 'where is the token refreshed' })
    expect(reminders(ledgerPrompt(r.next, route(), NOW + 1), grep2, ctx()).context).toBeUndefined()
    expect(reminders(ledgerPrompt(r.next, route({ categories: ['code-search'] }), NOW + 1), grep2, ctx()).context).toContain('semble search')
  })

  test('five reads or four searches in a turn without semble or codegraph', () => {
    let l = fresh()
    let context: string | undefined
    for (const f of ['a', 'b', 'c', 'd', 'e']) { const r = reminders(l, call('claude', 'Read', { file_path: `/repo/${f}.ts` }), ctx()); l = r.next; context = r.context ?? context }
    expect(context).toContain('5 files read this turn without codegraph')
    l = fresh()
    context = undefined
    for (const p of ['a', 'b', 'c', 'd']) { const r = reminders(l, call('claude', 'Bash', { command: `rg -n ${p} src` }), ctx()); l = r.next; context = r.context ?? context }
    expect(context).toContain('4 text searches this turn')
    expect(reminders(ledgerCall(fresh(), mcp('semble', 'search', { repo: '/Users/u/code/app', query: 'x' })), call('claude', 'Read', { file_path: '/repo/x.ts' }), ctx()).context).toBeUndefined()
  })

  test('the web-fetch server reading a documentation page points to context7', () => {
    const r = reminders(fresh(), mcp('web-fetch', 'fetch_url', { url: 'https://docs.rs/serde/latest/serde/' }), ctx())
    expect(r.context).toContain('context7')
    expect(reminders(fresh(), mcp('web-fetch', 'fetch_url', { url: 'https://example.com/post' }), ctx()).context).toBeUndefined()
  })

  test('routing.reminders off keeps only the gates; strictness off only records', () => {
    const grep = call('claude', 'Grep', { pattern: 'where is the config loaded' })
    expect(reminders(fresh(), grep, ctx({ reminders: false })).context).toBeUndefined()
    const root = mcp('codegraph', 'codegraph_callers', { symbol: 'f', projectPath: '/Users/u' })
    expect(reminders(fresh(), root, ctx({ reminders: false })).deny?.key).toBe('root')
    const off = reminders(fresh(), root, ctx({ strictness: 'off' }))
    expect(off.deny).toBeUndefined()
    expect(off.context).toBeUndefined()
    expect(off.next.turnTools.calls).toBe(1)
  })
})

describe('H23 turn audit', () => {
  test('an explicit request that was not loaded blocks once, with a continuation marker', () => {
    const l = fresh(route({ load: ['plan-build'] }))
    const d = turnAudit(l)
    expect(d.action).toBe('block')
    if (d.action !== 'block') return
    expect(d.hook).toBe('H23')
    expect(d.reason).toContain('the user asked for plan-build')
    expect(isGuardContinuation(d.reason)).toBe(true)
    expect(turnAudit(ledgerAudited(l))).toEqual({ action: 'allow' })
    expect(turnAudit(ledgerCall(l, call('claude', 'Read', { file_path: '/plugin/skills/plan-build/SKILL.md' })))).toEqual({ action: 'allow' })
  })

  test('nothing required, no prompt, or the next prompt: allow', () => {
    expect(turnAudit(emptyLedger())).toEqual({ action: 'allow' })
    expect(turnAudit(fresh(route({ candidates: ['research'], categories: ['library-docs'] })))).toEqual({ action: 'allow' })
    const audited = ledgerAudited(fresh(route({ load: ['plan-build'] })))
    expect(turnAudit(ledgerPrompt(audited, route({ load: ['bugfix'] }), NOW + 5)).action).toBe('block')
  })
})

describe('H23 and the memory backlog', () => {
  test('the memory backlog never blocks a stop: only a skill the user asked for does', () => {
    expect(turnAudit(fresh())).toEqual({ action: 'allow' })
    expect(ledgerAudited(fresh(), { action: 'allow' }).prompt?.audited).toBe(true)
    expect(parseLedger({ v: 1, upkeepTouched: true, upkeepAudited: true })).toEqual(emptyLedger())
  })
})
