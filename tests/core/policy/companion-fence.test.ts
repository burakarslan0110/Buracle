import { describe, expect, test } from 'bun:test'
import { companionAgent, companionToolDenial, companionToolProblem } from '../../../src/core/policy/companion-fence'

describe('the second-opinion fence (BURACLE_REVIEWER_AGENT)', () => {
  test('only a review agent name switches it on', () => {
    for (const a of ['plan-build-review', 'changes-review', 'goal-build-review', 'buracle:changes-review']) expect(companionAgent(a)).toBe(a)
    for (const a of [undefined, '', '1', 'general-purpose', 'build', 'plan-build-review; rm -rf /']) expect(companionAgent(a)).toBeUndefined()
  })

  test('Claude Code: edit tools, shell writes and other MCP servers are refused; Read, read-only shell and the three review servers pass', () => {
    const p = (tool: string, input: Record<string, unknown> = {}) => companionToolProblem('claude', tool, input)
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit']) expect(p(tool, { file_path: '/r/a.ts' })).toContain('changes files')
    for (const command of ['touch pwned.txt', 'git commit -am x', 'git diff > out.patch', 'echo $(rm -rf x)', 'git diff --output=x']) expect({ command, why: p('Bash', { command }) }).toEqual({ command, why: expect.any(String) })
    for (const command of ['git diff HEAD~1', 'git -C "/r with space" log -3', 'rg -n foo src']) expect(p('Bash', { command })).toBeUndefined()
    expect(p('Monitor', { command: 'touch x' })).toBeDefined()
    for (const tool of ['mcp__plugin_buracle_buracle-memory__memory_write', 'mcp__plugin_buracle_context-mode__ctx_execute', 'mcp__memtest__memory_write', 'mcp__plugin_buracle_codegraphx__run', 'mcp__codegraph_admin__drop']) {
      expect(p(tool)).toBe(`\`${tool}\` is not a codegraph, semble or context7 tool`)
    }
    for (const tool of ['mcp__plugin_buracle_codegraph__codegraph_explore', 'mcp__plugin_buracle_semble__search', 'mcp__plugin_buracle_context7__query-docs', 'mcp__codegraph__codegraph_node', 'Read', 'Grep', 'Glob', 'ToolSearch']) expect(p(tool)).toBeUndefined()
  })

  test('Claude Code PowerShell: the write forms are refused like their Bash equivalents; git reads still pass', () => {
    const p = (command: string) => companionToolProblem('claude', 'PowerShell', { command })
    for (const command of ['Remove-Item x', 'Set-Content x y', "'a' | Out-File x", 'Get-Content a > b.txt', 'git diff >> d.txt', 'New-Item x', 'Move-Item a b', 'Copy-Item a b', 'ni x', 'rm -r -fo x']) {
      expect({ command, problem: p(command) }).toEqual({ command, problem: expect.any(String) })
    }
    for (const command of ['git diff', 'git log --oneline -5', 'rg -n foo src']) expect({ command, problem: p(command) }).toEqual({ command, problem: undefined })
  })

  test('omp: only read, grep, glob and the three review servers pass, natively or through an xd:// device', () => {
    const p = (tool: string, input: Record<string, unknown> = {}) => companionToolProblem('omp', tool, input)
    for (const tool of ['read', 'grep', 'glob', 'mcp__codegraph_codegraph_explore', 'mcp__semble_search', 'mcp__context7_query_docs']) expect(p(tool)).toBeUndefined()
    expect(p('write', { path: 'xd://mcp__codegraph_codegraph_explore', content: '{}' })).toBeUndefined()
    expect(p('write', { path: ' XD://mcp__semble_search', content: '{}' })).toBeUndefined()
    expect(p('mcp__memtest_memory_write')).toBe('`mcp__memtest_memory_write` is not a codegraph, semble or context7 tool')
    expect(p('mcp__buracle_memory_memory_write')).toContain('is not a codegraph, semble or context7 tool')
    expect(p('write', { path: 'xd://mcp__memtest_memory_write', content: '{}' })).toBe('`xd://mcp__memtest_memory_write` is not a codegraph, semble or context7 tool')
    expect(p('write', { path: 'xd://propose', content: '{}' })).toContain('is not a codegraph, semble or context7 tool')
    expect(p('write', { path: '/r/pwned.txt', content: 'x' })).toBe('`write` changes files')
    expect(p('write', {})).toBe('`write` changes files')
    for (const tool of ['bash', 'edit', 'eval', 'python', 'task', 'browser', 'ast_edit', 'find']) expect(p(tool)).toBe(`\`${tool}\` is not one of its read tools (read, grep, glob)`)
  })

  test('a look-alike MCP server does not pass: Claude Code takes only Buracle\'s plugin or the bare server, omp only the named tools of the three servers', () => {
    const denied = (tool: string) => `\`${tool}\` is not a codegraph, semble or context7 tool`
    for (const tool of ['mcp__plugin_evil_codegraph__write', 'mcp__plugin_buracle2_semble__search', 'mcp__plugin_x_context7__query-docs']) expect(companionToolProblem('claude', tool, {})).toBe(denied(tool))
    for (const tool of ['mcp__semble_evil_write', 'mcp__codegraph_admin_delete', 'mcp__context7_admin_write', 'mcp__semble_search_all', 'mcp__codegraph_codegraph_drop']) expect(companionToolProblem('omp', tool, {})).toBe(denied(tool))
    expect(companionToolProblem('omp', 'write', { path: 'xd://mcp__semble_evil_write', content: '{}' })).toBe(denied('xd://mcp__semble_evil_write'))
    for (const tool of ['mcp__codegraph_explore', 'mcp__codegraph_callers', 'mcp__codegraph_status', 'mcp__semble_find_related', 'mcp__context7_resolve_library_id', 'mcp__context7_query_docs']) expect(companionToolProblem('omp', tool, {})).toBeUndefined()
    expect(companionToolProblem('omp', 'write', { path: 'xd://mcp__codegraph_impact', content: '{}' })).toBeUndefined()
  })

  test('Codex and OpenCode keep their own fences (the sandbox, the scratch agent\'s policies); the denial names the agent', () => {
    expect(companionToolProblem('codex', 'shell', { command: ['touch', 'x'] })).toBeUndefined()
    expect(companionToolProblem('opencode', 'edit', {})).toBeUndefined()
    expect(companionToolDenial('omp', 'changes-review', 'read', {})).toBeUndefined()
    expect(companionToolDenial('omp', 'changes-review', 'bash', { command: 'ls' })).toBe('Buracle: this run is a read-only second opinion (changes-review) and `bash` is not one of its read tools (read, grep, glob). Read files, search, see the change with git diff, log or show, and use codegraph, semble or context7; change nothing and write no memory.')
  })
})
