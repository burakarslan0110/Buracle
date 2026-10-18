import { describe, expect, test } from 'bun:test'
import { buildClaude } from '../../../src/adapters/claude/build'
import { devContext } from '../../../src/adapters/claude/dev-build'

type HooksJson = { hooks: Record<string, Array<{ matcher?: string }>> }

function fires(matcher: string | undefined, name: string): boolean {
  if (matcher === undefined) return true
  return /^[A-Za-z0-9_ ,|-]+$/.test(matcher) ? matcher.split(/[|,]/).map(x => x.trim()).includes(name) : new RegExp(matcher).test(name)
}

function firesAnchored(matcher: string | undefined, name: string): boolean {
  return matcher === undefined || new RegExp(`^(?:${matcher})$`).test(name)
}

describe('hooks.json: PreToolUse for context-mode in every Claude spelling', () => {
  test('a context-mode server outside Buracle starts the guards; every other MCP server reaches the write check only', async () => {
    const files = await buildClaude(devContext())
    const hooksJson = files.find(f => f.path === 'hooks/hooks.json')
    expect(hooksJson).toBeDefined()
    const matchers = ((JSON.parse(hooksJson?.content ?? '{}') as HooksJson).hooks['PreToolUse'] ?? []).map(g => g.matcher)
    expect(matchers.length).toBeGreaterThan(0)
    for (const name of [
      'mcp__context-mode__ctx_execute', 'mcp__context-mode__ctx_batch_execute', 'mcp__plugin_context-mode_context-mode__ctx_batch_execute',
      'mcp__plugin_context-mode_context-mode__ctx_execute_file', 'mcp__plugin_cm_context-mode__ctx_purge',
      'mcp__plugin_buracle_context-mode__ctx_execute', 'mcp__plugin_buracle_context-mode__ctx_index',
    ]) {
      expect({ name, fires: matchers.some(m => fires(m, name)), anchored: matchers.some(m => firesAnchored(m, name)) }).toEqual({ name, fires: true, anchored: true })
    }
    for (const name of ['mcp__claude_ai_Gmail__authenticate', 'mcp__other__ctx_execute', 'mcp__context7__query-docs']) {
      expect({ name, fires: matchers.some(m => fires(m, name)) }).toEqual({ name, fires: true })
    }
    expect({ name: 'TodoWrite', fires: matchers.some(m => fires(m, 'TodoWrite')) }).toEqual({ name: 'TodoWrite', fires: false })
  })
})
