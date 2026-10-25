import { describe, expect, test } from 'bun:test'
import type { McpCatalog, McpServerSpec, ToolSpec } from '../../src/core/catalog'
import { canProbe, FRESH_MS, isFresh, staleServers, staleTools, updatesStale } from '../../src/engine/update/refresh'
import type { HealthFile } from '../../src/engine/update/mcp'

const NOW = Date.parse('2026-10-25T12:00:00Z')
const ago = (ms: number): string => new Date(NOW - ms).toISOString()
const H = 3_600_000

const pkgServer = (name: string, registry: 'npm' | 'pypi' = 'npm'): McpServerSpec =>
  ({ description: name, transport: 'stdio', package: { registry, name, version: 'latest' }, harnesses: ['claude'], pin: 'latest', critical: true, routing: [] }) as McpServerSpec
const shimServer: McpServerSpec = { description: 'mem', transport: 'stdio', command: '{buracle}', args: ['mcp', 'memory'], harnesses: ['claude'], pin: 'hard', critical: true, routing: [] } as McpServerSpec
const httpServer: McpServerSpec = { description: 'grep', transport: 'http', url: 'https://mcp.example.test', harnesses: ['claude'], pin: 'monitor', critical: false, routing: [] } as McpServerSpec

const toolchain = (...keys: string[]) => ({ packages: Object.fromEntries(keys.map(k => [k, { registry: 'npm', name: k.split(':')[1], version: '1.0.0', dir: '/x', bins: {}, installed_at: '' }])) }) as never

describe('what counts as fresh', () => {
  test('a verification or update check is fresh for six hours', () => {
    expect(FRESH_MS).toBe(6 * H)
    expect(isFresh(ago(5 * H + 59 * 60_000), NOW)).toBe(true)
    expect(isFresh(ago(6 * H), NOW)).toBe(false)
    expect(isFresh(ago(48 * H), NOW)).toBe(false)
  })

  test('a missing, unreadable or future timestamp is never fresh', () => {
    expect(isFresh(undefined, NOW)).toBe(false)
    expect(isFresh('', NOW)).toBe(false)
    expect(isFresh('yesterday', NOW)).toBe(false)
    expect(isFresh(new Date(NOW + 60_000).toISOString(), NOW)).toBe(false)
  })
})

describe('a handshake that cannot download anything', () => {
  test('a package server is started only when the toolchain holds the package and the shim exists', () => {
    expect(canProbe(pkgServer('@demo/a'), toolchain('npm:@demo/a'), true)).toBe(true)
    expect(canProbe(pkgServer('@demo/a'), toolchain(), true)).toBe(false)
    expect(canProbe(pkgServer('@demo/a'), toolchain('npm:@demo/a'), false)).toBe(false)
    expect(canProbe(pkgServer('semble', 'pypi'), toolchain('pypi:semble'), true)).toBe(true)
    expect(canProbe(pkgServer('semble', 'pypi'), toolchain('npm:semble'), true)).toBe(false)
  })

  test('a server Buracle itself runs needs the shim; a remote one needs nothing local', () => {
    expect(canProbe(shimServer, toolchain(), true)).toBe(true)
    expect(canProbe(shimServer, toolchain(), false)).toBe(false)
    expect(canProbe(httpServer, toolchain(), false)).toBe(true)
  })
})

describe('which MCP servers get a handshake', () => {
  const catalog = { servers: { alpha: pkgServer('@demo/a'), beta: pkgServer('@demo/b'), memory: shimServer, grep: httpServer, gamma: pkgServer('@demo/g') } } as unknown as McpCatalog
  const health = (mcp: HealthFile['mcp']): HealthFile => ({ v: 1, checked_at: ago(0), mcp })
  const tc = toolchain('npm:@demo/a', 'npm:@demo/b')

  test('without any record every launchable server is checked, in id order; the one that would download is left out', () => {
    expect(staleServers(catalog, undefined, tc, true, NOW, false)).toEqual(['alpha', 'beta', 'grep', 'memory'])
  })

  test('a fresh ok is trusted; a stale ok, a down, an unknown and a missing record are checked again', () => {
    const h = health({
      alpha: { status: 'ok', checked_at: ago(1 * H) },
      beta: { status: 'ok', checked_at: ago(7 * H) },
      memory: { status: 'down', checked_at: ago(1 * H), error: 'exited' },
      grep: { status: 'unknown' },
    })
    expect(staleServers(catalog, h, tc, true, NOW, false)).toEqual(['beta', 'grep', 'memory'])
  })

  test('force checks every launchable server, fresh or not', () => {
    const h = health({ alpha: { status: 'ok', checked_at: ago(1 * H) } })
    expect(staleServers(catalog, h, tc, true, NOW, true)).toEqual(['alpha', 'beta', 'grep', 'memory'])
  })

  test('with no shim only the remote server can be checked', () => {
    expect(staleServers(catalog, undefined, tc, false, NOW, false)).toEqual(['grep'])
  })
})

describe('which tools get a version check', () => {
  const tool = (name: string): ToolSpec => ({ name, kind: 'cli', check: [name, '--version'], version_regex: '(\\d+)', required: true }) as ToolSpec
  const tools = [tool('bun'), tool('jq'), tool('rg')]

  test('a tool with a fresh ok is trusted; a missing record, a stale ok and a failed check are repeated', () => {
    const h: HealthFile = { v: 1, checked_at: ago(0), mcp: {}, tools: { bun: { status: 'ok', checked_at: ago(1 * H) }, jq: { status: 'ok', checked_at: ago(9 * H) }, rg: { status: 'error', checked_at: ago(1 * H) } } }
    expect(staleTools(tools, h, NOW, false).map(t => t.name)).toEqual(['jq', 'rg'])
    expect(staleTools(tools, undefined, NOW, false).map(t => t.name)).toEqual(['bun', 'jq', 'rg'])
    expect(staleTools(tools, h, NOW, true).map(t => t.name)).toEqual(['bun', 'jq', 'rg'])
  })
})

describe('when the update check is repeated', () => {
  test('when it never ran, ran more than six hours ago, or is forced', () => {
    expect(updatesStale(undefined, NOW, false)).toBe(true)
    expect(updatesStale({ checked_at: ago(7 * H) }, NOW, false)).toBe(true)
    expect(updatesStale({ checked_at: ago(1 * H) }, NOW, false)).toBe(false)
    expect(updatesStale({ checked_at: ago(1 * H) }, NOW, true)).toBe(true)
  })
})
