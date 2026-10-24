import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import { mcpEntry } from '../../src/adapters/omp/build'
import { loadCanonicalSync } from '../../src/engine/canonical'
import * as paths from '../../src/engine/paths'
import { spawnArgv } from '../../src/engine/platform'
import { probeStdio, type McpProbe } from '../../src/engine/update/mcp'
import { CLAUDE_PLUGIN, installShim, REPO, withBunOnPath } from '../helpers/wire'
import { withSandbox } from '../helpers/sandbox'

// "Wire" tests for MCP: the buracle-memory entry each harness config gets from its generator is started as written
// (command and args, the way the harness starts it), the MCP handshake (initialize, tools/list) is run over stdio, and the
// memory tools must be listed. The server runs offline on the fake CortexDB of the test preload. probeStdio ends the
// server's whole process group afterwards; the tests check that no `mcp memory` process of the run is left.

const MEMORY_ARGS = 'mcp memory'

function memoryPids(): number[] | undefined {
  if (process.platform === 'win32') return undefined
  const r = Bun.spawnSync(['pgrep', '-f', MEMORY_ARGS], { env: { ...process.env } })
  return r.stdout.toString().split('\n').map(Number).filter(n => Number.isInteger(n) && n > 0 && n !== process.pid)
}

async function expectMemoryTools(argv: string[], cwd: string): Promise<McpProbe> {
  const before = memoryPids()
  const probe = await probeStdio(argv, { env: withBunOnPath(), timeoutMs: 60_000, cwd })
  expect({ status: probe.status, error: probe.error }).toEqual({ status: 'ok', error: undefined })
  expect(probe.serverName).toBe('buracle-memory')
  expect(probe.toolNames).toContain('memory_search')
  expect(probe.toolNames?.filter(n => n.startsWith('memory_')).length).toBeGreaterThanOrEqual(2)
  if (before !== undefined) {
    // the group kill is asynchronous on the OS side: give the processes a moment to go
    for (let i = 0; i < 40; i++) {
      const left = (memoryPids() ?? []).filter(p => !before.includes(p))
      if (left.length === 0) break
      await Bun.sleep(100)
    }
    expect((memoryPids() ?? []).filter(p => !before.includes(p))).toEqual([])
  }
  return probe
}

describe('mcp wire: the generated buracle-memory entry starts, answers tools/list and exits', () => {
  test('Claude Code: the exec-form entry of the plugin\'s .mcp.json (every OS)', () => withSandbox(async ({ home }) => {
    installShim()
    const file = JSON.parse(readFileSync(join(CLAUDE_PLUGIN, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string, args: string[] }> }
    const entry = file.mcpServers['buracle-memory']
    if (entry === undefined) throw new Error('no buracle-memory in harness/claude/.mcp.json')
    await expectMemoryTools([entry.command, ...entry.args.map(a => a.replaceAll('${CLAUDE_PLUGIN_ROOT}', CLAUDE_PLUGIN))], home)
  }), 120_000)

  test.skipIf(process.platform === 'win32')('Codex: command and args of harness/codex/config.fragment.toml with {buracle} set to the shim', () => withSandbox(async ({ home }) => {
    installShim()
    const fragment = Bun.TOML.parse(readFileSync(join(REPO, 'harness', 'codex', 'config.fragment.toml'), 'utf8')) as { mcp_servers: Record<string, { command: string, args: string[] }> }
    const entry = fragment.mcp_servers['buracle-memory']
    if (entry === undefined) throw new Error('no buracle-memory in harness/codex/config.fragment.toml')
    expect(entry.command).toBe('{buracle}')
    await expectMemoryTools([paths.shimPath(), ...entry.args], home)
  }), 120_000)

  test.skipIf(process.platform === 'win32')('OpenCode: the command array of opencode.fragment.jsonc, {env:HOME} expanded', () => withSandbox(async ({ home }) => {
    installShim()
    const fragment = parseJsonc(readFileSync(join(REPO, 'harness', 'opencode', 'config', 'opencode.fragment.jsonc'), 'utf8')) as { mcp: { servers: Record<string, { command: string[] }> } }
    const entry = fragment.mcp.servers['buracle-memory']
    if (entry === undefined) throw new Error('no buracle-memory in opencode.fragment.jsonc')
    await expectMemoryTools(entry.command.map(a => a.replaceAll('{env:HOME}', home)), home)
  }), 120_000)

  test.skipIf(process.platform === 'win32')('Oh My Pi on macOS and Linux: the /bin/sh entry of harness/omp/.mcp.json', () => withSandbox(async ({ home }) => {
    installShim()
    const file = JSON.parse(readFileSync(join(REPO, 'harness', 'omp', '.mcp.json'), 'utf8')) as { mcpServers: Record<string, { command: string, args: string[] }> }
    const entry = file.mcpServers['buracle-memory']
    if (entry === undefined) throw new Error('no buracle-memory in harness/omp/.mcp.json')
    await expectMemoryTools([entry.command, ...entry.args], home)
  }), 120_000)

  test.skipIf(process.platform !== 'win32')('Oh My Pi on Windows: the entry omp/install.ts writes to mcp.json, pointing at buracle.cmd', () => withSandbox(async ({ home }) => {
    installShim()
    const spec = loadCanonicalSync(join(REPO, 'canonical')).mcp.servers['buracle-memory']
    if (spec === undefined) throw new Error('no buracle-memory in canonical/mcp.yaml')
    const entry = mcpEntry('buracle-memory', spec, paths.shimPath()) as { command: string, args: string[] }
    await expectMemoryTools(spawnArgv([entry.command, ...entry.args]), home)
  }), 120_000)
})
