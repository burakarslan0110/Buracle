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

describe('hooks.json: PreToolUse matchers', () => {
  test('every MCP server, in every Claude spelling, reaches the write check; TodoWrite starts no PreToolUse hook', async () => {
    const files = await buildClaude(devContext())
    const hooksJson = files.find(f => f.path === 'hooks/hooks.json')
    expect(hooksJson).toBeDefined()
    const matchers = ((JSON.parse(hooksJson?.content ?? '{}') as HooksJson).hooks['PreToolUse'] ?? []).map(g => g.matcher)
    expect(matchers.length).toBeGreaterThan(0)
    for (const name of ['mcp__claude_ai_Gmail__authenticate', 'mcp__plugin_buracle_semble__search', 'mcp__other__save_file', 'mcp__context7__query-docs']) {
      expect({ name, fires: matchers.some(m => fires(m, name)) }).toEqual({ name, fires: true })
    }
    expect({ name: 'TodoWrite', fires: matchers.some(m => fires(m, 'TodoWrite')) }).toEqual({ name: 'TodoWrite', fires: false })
  })

  test('the PowerShell tool (Windows) starts the same PreToolUse guard hook as Bash, in exec form that blocks when the hook fails, and the spool after it', async () => {
    const files = await buildClaude(devContext())
    type Handler = { command?: string, args?: string[], onFailure?: string }
    const doc = JSON.parse(files.find(f => f.path === 'hooks/hooks.json')?.content ?? '{}') as { hooks: Record<string, Array<{ matcher?: string, hooks: Handler[] }>> }
    const pre = (doc.hooks['PreToolUse'] ?? []).filter(g => firesAnchored(g.matcher, 'Bash'))
    expect(pre.length).toBe(1)
    expect(firesAnchored(pre[0]?.matcher, 'PowerShell')).toBe(true)
    expect(pre[0]?.hooks).toEqual([expect.objectContaining({ command: 'bun', args: ['${CLAUDE_PLUGIN_ROOT}/bin/buracle.ts', 'hook', 'claude', 'PreToolUse'], onFailure: 'block' })])
    expect((doc.hooks['PostToolUse'] ?? []).some(g => firesAnchored(g.matcher, 'PowerShell'))).toBe(true)
    for (const groups of Object.values(doc.hooks)) for (const g of groups) for (const h of g.hooks) expect(h.command).toBe('bun')
  })
})
