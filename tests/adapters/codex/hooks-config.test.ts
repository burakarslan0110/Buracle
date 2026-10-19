import { describe, expect, test } from 'bun:test'
import {
  buracleHooksFile, CODEX_HOOK_EVENTS, duplicateBuracleHandlers, findBuracleHandlers, HOOK_COMMAND_PREFIX, HOOK_GROUP_IDENTITY, hookCommand, hookTrustHash, hookTrustKey, isBuracleCommand,
  LEGACY_HOOK_COMMAND_PREFIXES, POST_ANSWER_MATCHER, POST_CAPTURE_MATCHER, POST_MASK_HANDLER, POST_MASK_MATCHER, PRE_TOOL_MATCHER, windowsHookPrefix,
} from '../../../src/adapters/codex/hooks-config'

function codexMatches(pattern: string, tool: string, aliases: readonly string[] = []): boolean {
  const inputs = [tool, ...aliases]
  if (pattern === '' || pattern === '*') return true
  if (/^[A-Za-z0-9_|]+$/.test(pattern)) return inputs.some(i => pattern.split('|').includes(i))
  const re = new RegExp(pattern)
  return inputs.some(i => re.test(i))
}

describe('matchers (Codex matcher semantics)', () => {
  test('PreToolUse: the guarded tools and every MCP tool, nothing else (anchored, so unrelated names do not slip in)', () => {
    for (const tool of ['Bash', 'apply_patch', 'request_user_input', 'request_user_input_async', 'mcp__buracle_memory__memory_search', 'mcp__web_search__search']) expect({ tool, fires: codexMatches(PRE_TOOL_MATCHER, tool) }).toEqual({ tool, fires: true })
    for (const tool of ['webrun', 'spawn_agent', 'update_plan', 'view_image', 'Bash_extra', 'not_mcp__x__y', 'mcp__']) expect({ tool, fires: codexMatches(PRE_TOOL_MATCHER, tool) }).toEqual({ tool, fires: false })
    expect(codexMatches('Bash|apply_patch|mcp__.+', 'not_mcp__x__y')).toBe(true)
    expect(codexMatches('Bash|mcp__', 'mcp__buracle_memory__memory_search')).toBe(false)
  })

  test('PostToolUse capture: shell, MCP and the client-side web search, in the background', () => {
    for (const tool of ['Bash', 'webrun', 'mcp__context7__query_docs']) expect({ tool, fires: codexMatches(POST_CAPTURE_MATCHER, tool) }).toEqual({ tool, fires: true })
    expect(codexMatches(POST_CAPTURE_MATCHER, 'apply_patch', ['Write', 'Edit'])).toBe(false)
    const capture = (buracleHooksFile().hooks.PostToolUse ?? []).find(g => g.matcher === POST_CAPTURE_MATCHER)
    expect(capture?.hooks[0]?.async).toBe(true)
  })

  test('PostToolUse mask (guards.redact): shell and MCP results, synchronously (an async hook cannot replace a result)', () => {
    for (const tool of ['Bash', 'mcp__context7__query_docs']) expect({ tool, fires: codexMatches(POST_MASK_MATCHER, tool) }).toEqual({ tool, fires: true })
    for (const tool of ['apply_patch', 'webrun', 'update_plan', 'not_mcp__x__y']) expect({ tool, fires: codexMatches(POST_MASK_MATCHER, tool, tool === 'apply_patch' ? ['Write', 'Edit'] : []) }).toEqual({ tool, fires: false })
    const mask = (buracleHooksFile().hooks.PostToolUse ?? []).find(g => g.matcher === POST_MASK_MATCHER)
    expect(mask?.hooks[0]).toEqual({ type: 'command', command: `${HOOK_COMMAND_PREFIX}${POST_MASK_HANDLER}`, timeout: 10 })
  })
})
import { listIdentity } from '../../../src/engine/txn'

const CMD = '"$HOME/.buracle/bin/buracle" hook codex '
const NOW_CMD = HOOK_COMMAND_PREFIX

describe('trust identity (matches Codex 0.161.0)', () => {
  test('hash vectors from codex app-server hooks/list', () => {
    expect(hookTrustHash('PreToolUse', { matcher: 'Bash|apply_patch' }, { type: 'command', command: `${CMD}PreToolUse`, timeout: 10 }))
      .toBe('sha256:8d67ace33acd8e8d71fde201f708376f062e1d4bda085df980ec1ad05e602bb7')
    expect(hookTrustHash('SessionEnd', {}, { type: 'command', command: `${CMD}SessionEnd`, timeout: 3 }))
      .toBe('sha256:f929011d9c49d8679f610c573b0b897b43f645d31f0ccd42ab51a492b0e72b61')
    expect(hookTrustHash('Stop', { matcher: 'ignored' }, { type: 'command', command: 'echo hi', timeout: 15 }))
      .toBe('sha256:10d5f0c710adb08a62a307365e25552668e13e147dfcf1f841b97392ec190ae2')
    expect(hookTrustHash('PostToolUse', { matcher: 'Bash' }, { type: 'command', command: 'echo post', timeout: 10, async: true, statusMessage: 'Buracle: x' }))
      .toBe('sha256:6fbc1c79a0447b08233c0380f9cd109ea977768cf56da5efffb30c1e397500a7')
  })

  test('normalisation: default and clamped timeouts, default context limit dropped', () => {
    const h = { type: 'command', command: 'x' }
    expect(hookTrustHash('PreToolUse', {}, h)).toBe(hookTrustHash('PreToolUse', {}, { ...h, timeout: 600 }))
    expect(hookTrustHash('SessionEnd', {}, { ...h, timeout: 30 })).toBe(hookTrustHash('SessionEnd', {}, { ...h, timeout: 3 }))
    expect(hookTrustHash('SessionEnd', {}, h)).toBe(hookTrustHash('SessionEnd', {}, { ...h, timeout: 1 }))
    expect(hookTrustHash('SessionStart', {}, { ...h, additionalContextLimit: 2500 })).toBe(hookTrustHash('SessionStart', {}, h))
    expect(hookTrustHash('SessionStart', {}, { ...h, additionalContextLimit: 6000 })).not.toBe(hookTrustHash('SessionStart', {}, h))
    expect(hookTrustHash('Stop', {}, { ...h, additionalContextLimit: 6000 })).toBe(hookTrustHash('Stop', {}, h))
    expect(hookTrustHash('PreToolUse', {}, { type: 'mcp_tool', server: 's', tool: 't' })).toBeUndefined()
  })

  test('Windows: commandWindows is the command Codex hashes there; elsewhere it changes nothing (checked with hooks/list)', () => {
    const plain = { type: 'command', command: `${NOW_CMD}PreToolUse`, timeout: 10 }
    const win = { ...plain, commandWindows: `${windowsHookPrefix('C:/Users/me/.buracle/bin/buracle.cmd')}PreToolUse` }
    expect(win.commandWindows).toBe('"C:\\Users\\me\\.buracle\\bin\\buracle.cmd" hook codex PreToolUse')
    expect(hookTrustHash('PreToolUse', { matcher: 'Bash' }, win, 'darwin')).toBe(hookTrustHash('PreToolUse', { matcher: 'Bash' }, plain, 'darwin'))
    expect(hookTrustHash('PreToolUse', { matcher: 'Bash' }, plain, 'darwin')).toBe('sha256:d1ec728a5b6776fc0ff5580aeafbe8659c8148c48f9d6601ed9acf7e418d8af9')
    expect(hookTrustHash('PreToolUse', { matcher: 'Bash' }, win, 'win32')).toBe(hookTrustHash('PreToolUse', { matcher: 'Bash' }, { ...plain, command: win.commandWindows }, 'darwin'))
    expect(hookTrustHash('PreToolUse', { matcher: 'Bash' }, win, 'win32')).not.toBe(hookTrustHash('PreToolUse', { matcher: 'Bash' }, plain, 'win32'))
    const file = buracleHooksFile(HOOK_COMMAND_PREFIX, windowsHookPrefix('C:\\b\\buracle.cmd'))
    for (const e of CODEX_HOOK_EVENTS) for (const g of file.hooks[e] ?? []) for (const h of g.hooks) expect(h.commandWindows).toBe(`"C:\\b\\buracle.cmd" hook codex ${e === 'PostToolUse' && g.matcher === POST_MASK_MATCHER ? POST_MASK_HANDLER : e}`)
    expect(JSON.stringify(buracleHooksFile())).not.toContain('commandWindows')
  })

  test('trust key format', () => {
    expect(hookTrustKey('/h/.codex/hooks.json', 'PreToolUse', 2, 0)).toBe('/h/.codex/hooks.json:pre_tool_use:2:0')
    expect(hookTrustKey('/h/.codex/hooks.json', 'SubagentStop', 0, 1)).toBe('/h/.codex/hooks.json:subagent_stop:0:1')
  })

  test('findBuracleHandlers locates Buracle handlers with keys and hashes', () => {
    const file = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine.sh' }] }, ...(buracleHooksFile().hooks.PreToolUse ?? [])] } }
    const found = findBuracleHandlers(file, '/h/hooks.json')
    expect(found).toHaveLength(1)
    expect(found[0]).toMatchObject({ event: 'PreToolUse', groupIndex: 1, handlerIndex: 0, key: '/h/hooks.json:pre_tool_use:1:0', command: hookCommand('PreToolUse') })
    expect(found[0]?.hash).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('Buracle command detection, list identity and duplicates', () => {
  test('I8: the command honours BURACLE_HOME through shell default syntax; older spellings stay recognised', () => {
    expect(NOW_CMD).toBe('"${BURACLE_HOME:-$HOME/.buracle}/bin/buracle" hook codex ')
    expect(hookCommand('Stop')).toBe(`${NOW_CMD}Stop`)
    expect(LEGACY_HOOK_COMMAND_PREFIXES).toContain(CMD)
    for (const prefix of [NOW_CMD, ...LEGACY_HOOK_COMMAND_PREFIXES]) expect(isBuracleCommand(`${prefix}PreToolUse`)).toBe(true)
  })

  test('recognises every spelling of the Buracle hook command', () => {
    expect(isBuracleCommand(`${CMD}Stop`)).toBe(true)
    expect(isBuracleCommand('/Users/x/.buracle/bin/buracle hook codex Stop')).toBe(true)
    expect(isBuracleCommand('buracle hook codex PreToolUse')).toBe(true)
    expect(isBuracleCommand('my-buracle hook codex Stop')).toBe(false)
    expect(isBuracleCommand('buracle hook claude Stop')).toBe(false)
    expect(isBuracleCommand('python3 ~/hooks/guard.py')).toBe(false)
  })

  test('every Buracle group has a json-list-merge identity, unique within its event', () => {
    const idOf = listIdentity(HOOK_GROUP_IDENTITY)
    for (const e of CODEX_HOOK_EVENTS) {
      const ids = (buracleHooksFile().hooks[e] ?? []).map(g => idOf(g))
      expect({ event: e, missing: ids.some(id => id === undefined) }).toEqual({ event: e, missing: false })
      expect(new Set(ids).size).toBe(ids.length)
    }
    expect((buracleHooksFile().hooks.PostToolUse ?? []).map(g => idOf(g))).toEqual([
      JSON.stringify(['apply_patch', `${NOW_CMD}PostToolUse`]), JSON.stringify([POST_CAPTURE_MATCHER, `${NOW_CMD}PostToolUse`]),
      JSON.stringify([POST_MASK_MATCHER, `${NOW_CMD}${POST_MASK_HANDLER}`]), JSON.stringify([POST_ANSWER_MATCHER, `${NOW_CMD}PostToolUse`]),
    ])
    expect(idOf({ hooks: [{ type: 'command', command: `${NOW_CMD}Stop` }] })).toBe(JSON.stringify([null, `${NOW_CMD}Stop`]))
  })

  test('duplicate Buracle handlers per event and matcher are reported', () => {
    const ours = buracleHooksFile().hooks
    const handWritten = { hooks: [{ type: 'command', command: '/Users/x/.buracle/bin/buracle hook codex Stop', timeout: 5 }] }
    const file = { hooks: { ...ours, Stop: [handWritten, ...(ours.Stop ?? [])] } }
    const found = findBuracleHandlers(file, '/h/hooks.json')
    expect(duplicateBuracleHandlers(found, file)).toEqual(['Stop#1'])
    expect(duplicateBuracleHandlers(findBuracleHandlers({ hooks: ours }, '/h/hooks.json'), { hooks: ours })).toEqual([])
  })
})

describe('consistency with canonical/hooks.yaml', () => {
  test('every supported Codex binding is served by a registered event and matcher', async () => {
    const { loadCanonicalSync } = await import('../../../src/engine/canonical')
    const { join } = await import('node:path')
    const bundle = loadCanonicalSync(join(import.meta.dir, '..', '..', '..', 'canonical'))
    const groups = buracleHooksFile().hooks
    const names = (m: string) => m.replace(/^\^\(\?:|^\^\(|\)\$$|^\^|\$$/g, '').split('|')
    let checked = 0
    for (const spec of bundle.hooks.hooks) {
      const b = spec.bindings.codex as { event?: string, matcher?: unknown, also?: Array<{ event: string, matcher?: unknown }> } | { unsupported: string } | undefined
      if (b === undefined || 'unsupported' in b) continue
      for (const x of [b, ...(b.also ?? [])] as Array<{ event?: string, matcher?: unknown }>) {
        const ours = groups[x.event as keyof typeof groups]
        expect({ hook: spec.id, event: x.event, registered: ours !== undefined }).toEqual({ hook: spec.id, event: x.event, registered: true })
        if (ours === undefined || typeof x.matcher !== 'string') continue
        if (ours.some(g => g.matcher === undefined)) continue
        const covered = new Set(ours.flatMap(g => names(g.matcher as string)))
        for (const n of names(x.matcher)) expect({ hook: spec.id, tool: n, covered: covered.has(n) }).toEqual({ hook: spec.id, tool: n, covered: true })
        checked++
      }
    }
    if (bundle.hooks.hooks.length > 0) expect(checked).toBeGreaterThan(0)
  })

  test('H21 binds Codex\'s SubagentStart synchronously, as the adapter registers it (the subagent\'s workspace lines)', async () => {
    const { loadCanonicalSync } = await import('../../../src/engine/canonical')
    const { join } = await import('node:path')
    const bundle = loadCanonicalSync(join(import.meta.dir, '..', '..', '..', 'canonical'))
    const b = bundle.hooks.hooks.find(h => h.id === 'H21')?.bindings.codex as { also?: Array<Record<string, unknown>> } | undefined
    expect((b?.also ?? []).find(a => a['event'] === 'SubagentStart')).toEqual({ event: 'SubagentStart', timeoutMs: 10000 })
    for (const spec of bundle.hooks.hooks) {
      const c = spec.bindings.codex as { event?: string, async?: boolean, also?: Array<{ event: string, async?: boolean }> } | { unsupported: string } | undefined
      if (c === undefined || 'unsupported' in c) continue
      for (const x of [c, ...(c.also ?? [])]) if (x.event === 'SubagentStart') expect({ hook: spec.id, async: x.async ?? false }).toEqual({ hook: spec.id, async: false })
    }
    const group = buracleHooksFile().hooks.SubagentStart ?? []
    expect(group.map(g => ({ matcher: g.matcher, async: g.hooks[0]?.async, timeout: g.hooks[0]?.timeout }))).toEqual([{ matcher: undefined, async: undefined, timeout: 10 }])
  })

  test('H14 names the async PostToolUse capture group exactly as the adapter registers it', async () => {
    const { loadCanonicalSync } = await import('../../../src/engine/canonical')
    const { join } = await import('node:path')
    const bundle = loadCanonicalSync(join(import.meta.dir, '..', '..', '..', 'canonical'))
    const b = bundle.hooks.hooks.find(h => h.id === 'H14')?.bindings.codex as { also?: Array<Record<string, unknown>> } | undefined
    const capture = (b?.also ?? []).find(a => a['event'] === 'PostToolUse')
    expect(capture).toEqual({ event: 'PostToolUse', matcher: POST_CAPTURE_MATCHER, async: true, timeoutMs: 15000 })
    const group = (buracleHooksFile().hooks.PostToolUse ?? []).find(g => g.matcher === capture?.['matcher'])
    expect(group?.hooks[0]).toMatchObject({ async: true, timeout: 15 })
  })
})

describe('F03: trust state when Buracle groups are removed (trustMigration)', () => {
  test('user handlers after a removed Buracle group move their approval; Buracle\'s own entries are dropped', async () => {
    const { trustMigration } = await import('../../../src/adapters/codex/hooks-config')
    const P = '/h/.codex/hooks.json'
    const user1 = { hooks: [{ type: 'command', command: 'echo user-audit-1', timeout: 5 }] }
    const ours = (buracleHooksFile().hooks.PreToolUse ?? [])[0] as unknown as { matcher?: string, hooks: Array<Record<string, unknown>> }
    const user2 = { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-audit-2', timeout: 5 }, { type: 'command', command: 'echo user-audit-2b' }] }
    const user3 = { hooks: [{ type: 'command', command: 'echo stale-approval' }] }
    const file = { hooks: { PreToolUse: [user1, ours, user2, user3] } }
    const hash = (g: object, h: Record<string, unknown>) => hookTrustHash('PreToolUse', g as { matcher?: unknown }, h) as string
    const state: Record<string, unknown> = {
      [hookTrustKey(P, 'PreToolUse', 0, 0)]: { trusted_hash: hash(user1, user1.hooks[0]!) },
      [hookTrustKey(P, 'PreToolUse', 1, 0)]: { trusted_hash: hash(ours, ours.hooks[0]!) },
      [hookTrustKey(P, 'PreToolUse', 2, 0)]: { trusted_hash: hash(user2, user2.hooks[0]!) },
      [hookTrustKey(P, 'PreToolUse', 2, 1)]: { enabled: false },
      [hookTrustKey(P, 'PreToolUse', 3, 0)]: { trusted_hash: 'sha256:old' },
    }
    const m = trustMigration(P, file, [{ event: 'PreToolUse', groupIndex: 1 }], state)
    expect(m.drops).toEqual([{ key: hookTrustKey(P, 'PreToolUse', 1, 0), state: { trusted_hash: hash(ours, ours.hooks[0]!) } }])
    expect(m.moves).toEqual([
      { from: hookTrustKey(P, 'PreToolUse', 2, 0), to: hookTrustKey(P, 'PreToolUse', 1, 0), state: { trusted_hash: hash(user2, user2.hooks[0]!) } },
      { from: hookTrustKey(P, 'PreToolUse', 2, 1), to: hookTrustKey(P, 'PreToolUse', 1, 1), state: { enabled: false } },
    ])
    expect(trustMigration(P, file, [{ event: 'PreToolUse', groupIndex: 3 }], {}).moves).toEqual([])
    expect(trustMigration(P, file, [], state)).toEqual({ moves: [], drops: [] })
  })
})
