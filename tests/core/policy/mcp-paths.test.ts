import { describe, expect, test } from 'bun:test'
import { mcpWritePaths } from '../../../src/core/policy/mcp-paths'
import { checkWrite } from '../../../src/core/policy/write-guard'

const DEVTOOLS = 'mcp__plugin_buracle_chrome-devtools__'

describe('mcpWritePaths', () => {
  test("chrome-devtools' file outputs are found in every spelling of the argument", () => {
    expect(mcpWritePaths(`${DEVTOOLS}take_heapsnapshot`, { filePath: '~/.claude/settings.json' })).toEqual(['~/.claude/settings.json'])
    expect(mcpWritePaths(`${DEVTOOLS}take_screenshot`, { format: 'png', filePath: '/tmp/a.png', fullPage: true })).toEqual(['/tmp/a.png'])
    expect(mcpWritePaths(`${DEVTOOLS}lighthouse_audit`, { outputDirPath: '/tmp/out' })).toEqual(['/tmp/out'])
    expect(mcpWritePaths('mcp__fs__write_file', { path: 'a.txt', content: 'x' })).toEqual(['a.txt'])
    expect(mcpWritePaths('mcp__x__save', { file_path: 'a', 'output-path': 'b', SavePath: 'c', destination: 'd', filename: 'e', dest: 'a' })).toEqual(['a', 'b', 'c', 'd', 'e'])
  })

  test('one object level down counts; deeper levels, arrays and non-strings do not', () => {
    expect(mcpWritePaths('mcp__x__export', { options: { outputPath: '/tmp/o.json', name: 'n' } })).toEqual(['/tmp/o.json'])
    expect(mcpWritePaths('mcp__x__export', { a: { b: { path: '/deep' } }, list: [{ path: '/in-array' }], path: 3, filePath: '' })).toEqual([])
  })

  test('read-only servers and tools, and tools that are not MCP tools, give nothing', () => {
    expect(mcpWritePaths('mcp__plugin_buracle_semble__find_related', { file_path: '.env', line: 1 })).toEqual([])
    expect(mcpWritePaths('mcp__plugin_buracle_codegraph__codegraph_files', { path: 'src' })).toEqual([])
    expect(mcpWritePaths('mcp__plugin_buracle_context7__query-docs', { file_path: '/x' })).toEqual([])
    expect(mcpWritePaths(`${DEVTOOLS}upload_file`, { uid: '1', filePath: '/tmp/a.png' })).toEqual([])
    expect(mcpWritePaths('Grep', { path: '/x' })).toEqual([])
    expect(mcpWritePaths('Write', { file_path: '/x' })).toEqual([])
    expect(mcpWritePaths('mcp__srv__tool', { path: '/x' }, { server: 'semble', tool: 'search' })).toEqual([])
  })

  test("another harness's spelling counts when the caller passes the parsed server and tool", () => {
    expect(mcpWritePaths('chrome-devtools_take_screenshot', { filePath: '/tmp/a.png' })).toEqual([])
    expect(mcpWritePaths('chrome-devtools_take_screenshot', { filePath: '/tmp/a.png' }, { server: 'chrome-devtools', tool: 'take_screenshot' })).toEqual(['/tmp/a.png'])
    expect(mcpWritePaths('semble_find_related', { file_path: '.env' }, { server: 'semble', tool: 'find_related' })).toEqual([])
  })

  test('with checkWrite: a protected target is refused at the path, an ordinary one passes', () => {
    const ctx = { cwd: '/Users/u/code/app', home: '/Users/u', vault: '', protect: [] }
    expect(checkWrite(mcpWritePaths(`${DEVTOOLS}take_heapsnapshot`, { filePath: '~/.claude/settings.json' }), ctx).deny).toContain("Claude Code's own configuration")
    expect(checkWrite(mcpWritePaths(`${DEVTOOLS}take_screenshot`, { filePath: '.claude/settings.local.json' }), ctx).deny).toContain('file edit or whole-file write tool')
    expect(checkWrite(mcpWritePaths(`${DEVTOOLS}take_screenshot`, { filePath: 'shots/a.png' }), ctx)).toEqual({})
  })
})
