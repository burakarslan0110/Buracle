import { describe, expect, test } from 'bun:test'
import { classifyTool, classifyToolFor, mcpServerToken, parseMcpName } from '../../../src/core/events'
import {
  CANONICAL_EVENTS, HARNESSES, HARNESS_LABEL, HARNESS_PROFILES, NEUTRAL_SKILL_HARNESSES, configDirOf, defineHarnesses, harnessProfile, harnessesWhere,
  isHarness, mcpClientMatches, mcpToolName, mcpToolPattern, missingEvents, parseMcpToolName, processMatches, shellTools, toolKindOf,
  type HarnessProfile,
} from '../../../src/core/harness/index'
import { harnessMcpPattern, harnessMcpToolName } from '../../../src/core/policy/routing'

// A fifth harness that exists only here: nothing outside this object knows it. Its facts differ from the four real
// ones on purpose (its own MCP prefix, separator and token rule, its own tool names, a canonical event it lacks).
const quill: HarnessProfile = {
  id: 'quill',
  label: 'Quill',
  shortLabel: 'QL',
  noteName: 'quill-cli',
  bin: 'quill',
  proc: { base: /^quill(?:-nightly)?$/, pidEnv: 'QUILL_PID' },
  runtime: 'command',
  editBudgetMs: 15_000,
  configDir: { key: 'quillDir', env: 'QUILL_HOME', envSubdir: 'cfg', under: '.quill' },
  relocationEnv: ['QUILL_HOME'],
  sessionEnv: ['QUILL_SESSION'],
  protectedDirs: [{ key: 'quillDir', under: '.quill', entries: ['settings.toml', 'hooks/'] }],
  selfText: { what: "Quill's own configuration", remedy: 'ask the user' },
  skills: {
    readsAgentsDir: false,
    linkDir: 'skills',
    readsClaudeUserDir: false,
    readsClaudeProjectDir: false,
    invoke: { slash: true, namespace: 'q', dollar: false, at: false, commandTag: false },
    mention: (id, invocable) => invocable ? `/${id}` : `/q:${id}`,
    agentPrefix: 'q-',
    howto: 'the user starts a workflow with /<id>',
    load: id => `open skill ${id}`,
    candidateHow: 'open skill <id>',
  },
  plan: { enter: 'ask the user to type /plan', readOnly: { name: "Quill's plan mode", leave: 'leave plan mode' }, approval: false },
  mcp: {
    prefix: 'srv.',
    separator: '::',
    token: part => part.toUpperCase().replace(/[^A-Z0-9]/g, ''),
    syntax: 'srv.<SERVER>::<TOOL>',
    hiddenNote: '* = may be hidden',
  },
  mcpClient: { includes: ['quill'], exact: ['ql'] },
  events: {
    map: { sessionStart: ['boot'], prompt: ['ask'], preTool: ['before'], postTool: ['after'], stop: ['done'], preCompact: null, sessionEnd: ['bye'] },
    native: ['boot', 'ask', 'before', 'after', 'done', 'bye', 'tick'],
  },
  tools: {
    kinds: { run: 'bash', script: 'eval', change: 'edit', put: 'write', get: 'read', spawn: 'agent', poll: 'bash' },
    names: { ask_user: 'confirm', todo: 'list', spawn_agent: 'spawn' },
    deviceScheme: 'dev',
    readFetchesUrls: true,
    editTakesPatch: true,
    stringCommandOnly: ['poll'],
  },
}

describe('the harness registry', () => {
  test('the four harnesses, in the order every table and loop uses', () => {
    expect([...HARNESSES]).toEqual(['claude', 'codex', 'opencode', 'omp'])
    for (const h of HARNESSES) expect(harnessProfile(h).id).toBe(h)
    expect(isHarness('omp')).toBe(true)
    expect(isHarness('quill')).toBe(false)
    expect(isHarness(undefined)).toBe(false)
  })

  test('the derived tables hold what the hand-written ones held', () => {
    expect(HARNESS_LABEL).toEqual({ claude: 'Claude Code', codex: 'Codex', opencode: 'OpenCode', omp: 'Oh My Pi' })
    expect([...NEUTRAL_SKILL_HARNESSES]).toEqual(['codex', 'opencode', 'omp'])
    expect(harnessesWhere(p => p.runtime === 'command')).toEqual(['claude', 'codex'])
    expect(harnessesWhere(p => p.skills.readsClaudeProjectDir)).toEqual(['claude', 'opencode', 'omp'])
    expect(harnessesWhere(p => p.skills.readsClaudeUserDir)).toEqual(['claude', 'opencode'])
    expect(harnessesWhere(p => !p.plan.approval)).toEqual(['opencode'])
    expect(HARNESSES.map(h => harnessProfile(h).editBudgetMs)).toEqual([28_000, 40_000, 20_000, 20_000])
    expect(HARNESSES.map(h => harnessProfile(h).noteName)).toEqual(['claude-code', 'codex', 'opencode', 'omp'])
    expect(HARNESSES.map(h => shellTools(harnessProfile(h)))).toEqual([
      ['Bash', 'Monitor', 'PowerShell'],
      ['Bash', 'shell', 'shell_command', 'exec_command', 'local_shell', 'unified_exec', 'container.exec'],
      ['bash', 'shell'],
      ['bash', 'eval'],
    ])
  })

  test('the MCP names of the four hosts, written and read back', () => {
    expect(HARNESSES.map(h => harnessMcpToolName(h, 'web-search', 'search'))).toEqual([
      'mcp__plugin_buracle_web-search__search', 'mcp__web_search__search', 'web-search_search', 'mcp__web_search_search',
    ])
    expect(HARNESSES.map(h => harnessMcpPattern(h, 'web-search'))).toEqual([
      'mcp__plugin_buracle_web-search__*', 'mcp__web_search__*', 'web-search_*', 'mcp__web_search_*',
    ])
    expect(harnessMcpToolName('omp', 'Context7', 'context7_resolve-id')).toBe('mcp__context7_resolve_id')
    expect(mcpServerToken('omp', '--')).toBe('server')
    for (const h of HARNESSES) {
      const name = harnessMcpToolName(h, 'web-search', 'search')
      expect({ h, parsed: parseMcpName(h, name, ['web', 'web-search']) }).toEqual({ h, parsed: { server: 'web-search', tool: 'search' } })
    }
    expect(parseMcpName('opencode', 'unknown_tool', ['web-search'])).toBeUndefined()
    expect(parseMcpName('codex', 'mcp__unknown__tool', ['web-search'])).toEqual({ server: 'unknown', tool: 'tool' })
    expect(parseMcpName('claude', 'mcp__plugin_other_srv__tool')).toEqual({ server: 'srv', tool: 'tool' })
  })

  test('a profile registered under another name is refused', () => {
    expect(() => defineHarnesses({ pen: quill })).toThrow('harness profile "quill" is registered as "pen"')
  })
})

describe('a fifth harness is one profile', () => {
  const five = defineHarnesses({ ...HARNESS_PROFILES, quill })

  test('it joins the set and every table over it', () => {
    expect([...five.ids]).toEqual(['claude', 'codex', 'opencode', 'omp', 'quill'])
    expect(five.is('quill')).toBe(true)
    expect(five.of('quill')).toBe(quill)
    expect(five.table(p => p.label)).toEqual({ ...HARNESS_LABEL, quill: 'Quill' })
    expect(five.table(p => p.bin)['quill']).toBe('quill')
    expect(five.where(p => p.skills.readsAgentsDir)).toEqual(['codex', 'opencode', 'omp'])
    expect(five.where(p => p.skills.linkDir !== undefined)).toEqual(['quill'])
    expect(five.where(p => p.runtime === 'command')).toEqual(['claude', 'codex', 'quill'])
  })

  test('its tools are classified from its table and its flags', () => {
    expect(toolKindOf(quill, 'run')).toBe('bash')
    expect(toolKindOf(quill, 'constructor')).toBeUndefined()
    expect(shellTools(quill)).toEqual(['run', 'script', 'poll'])
    expect(classifyToolFor(quill, 'run', { command: 'ls -la' }, '/w')).toEqual({ kind: 'bash', command: 'ls -la', paths: [] })
    expect(classifyToolFor(quill, 'change', { path: 'a.ts' }, '/w')).toEqual({ kind: 'edit', paths: ['/w/a.ts'] })
    expect(classifyToolFor(quill, 'put', { path: '~/x' }, '/w', undefined, { homeTilde: '/home/u' })).toEqual({ kind: 'write', paths: ['/home/u/x'] })
    expect(classifyToolFor(quill, 'nothing', {}, '/w')).toEqual({ kind: 'other', paths: [] })
    expect(classifyToolFor(quill, 'get', { path: 'https://example.com/a' }, '/w')).toEqual({ kind: 'web_fetch', paths: [] })
    expect(classifyToolFor(quill, 'get', { path: 'dev://anything/x' }, '/w')).toEqual({ kind: 'other', paths: [] })
    expect(classifyToolFor(quill, 'put', { path: 'dev://srv.DOCS::find' }, '/w', ['docs'])).toEqual({ kind: 'mcp', paths: [], mcp: { server: 'docs', tool: 'find' } })
    expect(classifyToolFor(quill, 'change', { input: '*** Begin Patch\n*** Add File: n.ts\n+x\n*** End Patch' }, '/w')).toEqual({ kind: 'patch', paths: ['/w/n.ts'] })
    expect(classifyToolFor(quill, 'poll', { command: ['sleep', '1'] }, '/w')).toEqual({ kind: 'other', paths: [] })
    expect(classifyToolFor(quill, 'poll', { command: 'sleep 1' }, '/w')).toEqual({ kind: 'bash', command: 'sleep 1', paths: [] })
  })

  test('the flags are the profile\'s: a host without them reads the same input as a file', () => {
    expect(classifyTool('claude', 'Read', { path: 'https://example.com/a' }, '/w').kind).toBe('read')
    expect(classifyTool('opencode', 'read', { path: 'xd://srv/x' }, '/w').kind).toBe('read')
    expect(classifyTool('omp', 'read', { path: 'xd://srv/x' }, '/w')).toEqual({ kind: 'other', paths: [] })
    expect(classifyTool('opencode', 'edit', { input: '*** Begin Patch\n*** Add File: n.ts\n+x\n*** End Patch' }, '/w').kind).toBe('edit')
  })

  test('its MCP names are written and read with its dialect', () => {
    expect(mcpToolName(quill.mcp, 'web-search', 'find')).toBe('srv.WEBSEARCH::FIND')
    expect(mcpToolPattern(quill.mcp, 'web-search')).toBe('srv.WEBSEARCH::*')
    expect(parseMcpToolName(quill.mcp, 'srv.WEBSEARCH::FIND', ['web', 'web-search'])).toEqual({ server: 'web-search', tool: 'FIND' })
    expect(parseMcpToolName(quill.mcp, 'srv.OTHER::go')).toEqual({ server: 'OTHER', tool: 'go' })
    expect(parseMcpToolName(quill.mcp, 'mcp__other__go')).toBeUndefined()
    expect(parseMcpToolName(quill.mcp, 'srv.OTHER::')).toBeUndefined()
    expect(classifyToolFor(quill, 'srv.DOCS::find', {}, '/w', ['docs'])).toEqual({ kind: 'mcp', paths: [], mcp: { server: 'docs', tool: 'find' } })
  })

  test('its event map names its native events, and the event it lacks is null', () => {
    expect(missingEvents(quill)).toEqual(['preCompact'])
    for (const e of CANONICAL_EVENTS) for (const name of quill.events.map[e] ?? []) expect(quill.events.native).toContain(name)
    expect(five.table(p => p.events.map.preTool ?? [])['quill']).toEqual(['before'])
    expect(five.where(p => missingEvents(p).length > 0)).toEqual(['quill'])
  })

  test('its paths, process and MCP client are looked up from the profile', () => {
    expect(configDirOf(quill, { HOME: '/home/u' })).toBe('/home/u/.quill')
    expect(configDirOf(quill, { HOME: '/home/u', QUILL_HOME: '/opt/q/' })).toBe('/opt/q/cfg')
    expect(configDirOf(quill, { HOME: '/home/u', QUILL_HOME: 'relative' })).toBe('/home/u/.quill')
    expect(configDirOf(quill, {})).toBeUndefined()
    expect(processMatches(quill, '/usr/local/bin/quill-nightly')).toBe(true)
    expect(processMatches(quill, '-quill')).toBe(true)
    expect(processMatches(quill, '/usr/bin/quilt')).toBe(false)
    expect(processMatches(quill, 'node', 42, { QUILL_PID: '42' })).toBe(true)
    expect(mcpClientMatches(quill, 'Quill-CLI 1.0')).toBe(true)
    expect(mcpClientMatches(quill, 'QL')).toBe(true)
    expect(mcpClientMatches(quill, 'sql')).toBe(false)
    expect(five.ids.find(h => processMatches(five.of(h), '/opt/quill'))).toBe('quill')
    expect(five.ids.flatMap(h => five.of(h).protectedDirs.map(d => `${h}:${d.under}`))).toEqual(['claude:.claude', 'codex:.codex', 'opencode:.config/opencode', 'omp:.omp/agent', 'omp:.omp', 'quill:.quill'])
    expect(five.ids.flatMap(h => five.of(h).sessionEnv)).toContain('QUILL_SESSION')
  })

  test('the real hosts\' config folders', () => {
    const env = { HOME: '/home/u' }
    expect(HARNESSES.map(h => configDirOf(harnessProfile(h), env))).toEqual(['/home/u/.claude', '/home/u/.codex', '/home/u/.config/opencode', '/home/u/.omp/agent'])
    expect(configDirOf(harnessProfile('opencode'), { ...env, XDG_CONFIG_HOME: '/x/../y' })).toBe('/y/opencode')
    expect(configDirOf(harnessProfile('claude'), { ...env, CLAUDE_CONFIG_DIR: ' /c/alt ' })).toBe('/c/alt')
  })
})
