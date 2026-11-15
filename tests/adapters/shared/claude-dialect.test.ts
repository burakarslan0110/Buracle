import { describe, expect, test } from 'bun:test'
import { blockOut, contextOut, denyOut, isObj, out, parsePayload, QUIET, str } from '../../../src/adapters/shared/claude-dialect'
import { availableServers, capabilityCardText, promptRouting } from '../../../src/adapters/shared/routing'
import { catalogMcp } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import { join } from 'node:path'

describe('the Claude-dialect command-hook codec', () => {
  test('out is one JSON line with exit 0; QUIET says nothing', () => {
    expect(out({ a: 1 })).toEqual({ stdout: '{"a":1}\n', exitCode: 0 })
    expect(QUIET).toEqual({ stdout: '', exitCode: 0 })
  })

  test('parsePayload takes a JSON object and nothing else', () => {
    expect(parsePayload('{"a":1}')).toEqual({ a: 1 })
    for (const bad of ['', 'nope', '[]', '3', 'null', '"x"']) expect(parsePayload(bad)).toBeUndefined()
    expect([str('x'), str(''), str(3), isObj({}), isObj([]), isObj(null)]).toEqual(['x', undefined, undefined, true, false, false])
  })

  test('context goes in hookSpecificOutput.additionalContext of the event; no context is no output', () => {
    expect(JSON.parse(contextOut('SessionStart', ['a', ' ', 'b']).stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'a\n\nb' } })
    expect(JSON.parse(contextOut('Stop', ['a'], 'note').stdout)).toMatchObject({ systemMessage: 'note' })
    expect(contextOut('Stop', ['', ' '])).toEqual(QUIET)
  })

  test('a denial and a stop block have the shapes Claude Code and Qwen Code read', () => {
    expect(JSON.parse(denyOut('no').stdout)).toEqual({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } })
    expect(JSON.parse(blockOut('keep going').stdout)).toEqual({ decision: 'block', reason: 'keep going' })
  })
})

describe('the shared capability card and prompt routing', () => {
  const canonical = loadCanonicalSync(join(import.meta.dir, '..', '..', '..', 'canonical'))
  const ctx = { repoRoot: '.', config: defaultConfig(), canonical, paths, buracleBin: '/x' }

  test('the card and the available servers are the harness\'s own', () => {
    expect(capabilityCardText(ctx, 'qwen', {})).toContain('mcp__')
    expect(availableServers(ctx, 'qwen', {})).toEqual(catalogMcp(canonical.mcp, 'qwen').map(m => m.id))
    expect(availableServers(ctx, 'qwen', { 'web-search': 'down', semble: 'off', context7: 'ok' })).toEqual(catalogMcp(canonical.mcp, 'qwen').map(m => m.id).filter(id => id !== 'web-search' && id !== 'semble'))
  })

  test('a named workflow routes to its skill with the harness\'s load phrase; plain text routes nowhere', () => {
    const r = promptRouting(ctx, 'qwen', '$plan-build add x', { ledger: { skills: {} } as never, available: [], skillsDir: '/s' })
    expect(r.route.load).toEqual(['plan-build'])
    expect(r.text).toContain('skill tool, plan-build')
    expect(promptRouting(ctx, 'qwen', 'hello there', { ledger: { skills: {} } as never, available: [], skillsDir: '/s' }).route.load).toEqual([])
  })
})
