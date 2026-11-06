import { describe, expect, test } from 'bun:test'
import { existsSync, rmSync } from 'node:fs'
import { backendFiles, backendKey } from '../../../src/engine/mcp-share/common'
import { classifyMcpProcesses, orphanChecks, parsePs, type BackendState } from '../../../src/engine/mcp-share/procs'
import * as paths from '../../../src/engine/paths'
import { run as mcpRun } from '../../../src/cli/commands/mcp'
import { withSandbox } from '../../helpers/sandbox'
import { memoryIO } from '../../cli/ops/helpers'
import { alive, installStub, MAIN, readJson, session, until, VERSION } from './helpers'

const PS = [
  '  100     1  40960 01:02:03 bun /r/src/cli/main.ts mcp backend web-search',
  '  101   100 120000    05:00 node /t/open-websearch/build/index.js',
  '  200    50  21000    09:00 bun /r/harness/claude/bin/buracle.ts mcp run web-search',
  '  202    50  20000    09:00 bun /r/harness/claude/bin/buracle.ts mcp run chrome-devtools',
  '  201   202 110000    01:00 node /t/chrome-devtools-mcp/build/src/index.js --isolated',
  '  300    50  38000    09:00 bun /r/harness/claude/bin/buracle.ts mcp memory',
  '  301    60  39000    09:00 /home/u/.buracle/bin/buracle lsp mcp',
  '  400    50  85000    09:00 /t/codegraph-darwin-arm64/node --liftoff-only /t/codegraph-darwin-arm64/lib/dist/bin/codegraph.js serve --mcp',
  '  401     1 290000 01:00:00 /t/codegraph-darwin-arm64/node --liftoff-only /t/codegraph-darwin-arm64/lib/dist/bin/codegraph.js serve --mcp --path /p',
  '  500    50   9000    09:00 vim notes.md',
  '  600     1  21000    40:00 bun /r/src/cli/main.ts mcp run semble',
].join('\n')

describe('Buracle MCP processes', () => {
  test('parsePs reads pid, ppid, RSS in KB, elapsed time and the command line, and skips junk', () => {
    const rows = parsePs(`${PS}\nnot a row\n`)
    expect(rows).toHaveLength(11)
    expect(rows[0]).toEqual({ pid: 100, ppid: 1, rssKb: 40960, etime: '01:02:03', command: 'bun /r/src/cli/main.ts mcp backend web-search' })
  })

  test('each Buracle MCP process gets its role and server; other processes are left out', () => {
    const procs = classifyMcpProcesses(parsePs(PS), new Set(['chrome-devtools']))
    const byPid = Object.fromEntries(procs.map(p => [p.pid, `${p.role}:${p.server}`]))
    expect(byPid).toEqual({
      100: 'backend:web-search', 101: 'upstream:web-search', 200: 'forwarder:web-search', 202: 'forwarder:chrome-devtools', 201: 'lazy:chrome-devtools',
      300: 'session:buracle-memory', 301: 'session:lsp', 400: 'codegraph:codegraph', 401: 'codegraph:codegraph', 600: 'forwarder:semble',
    })
  })

  test('orphans: a per-session process without a harness, a backend idle past the linger time plus 15 s, and an upstream whose backend is gone; codegraph\'s per-project daemon never', () => {
    const procs = classifyMcpProcesses(parsePs(PS), new Set(['chrome-devtools']))
    const now = 1_000_000
    const states: BackendState[] = [
      { file: '/s/a.json', id: 'web-search', key: 'web-search-1-p1', pid: 100, upstreamPid: 101, clients: [], idleSince: now - 80_000 },
      { file: '/s/b.json', id: 'semble', key: 'semble-1-p1', pid: 999, upstreamPid: 600, clients: [] },
    ]
    const checks = orphanChecks(procs, states, { now, lingerMs: 60_000, hasHarness: pid => pid !== 600, alive: pid => pid !== 999 })
    const warn = checks.filter(c => c.level === 'warn').map(c => c.detail)
    expect(warn.some(d => d.includes('web-search') && d.includes('`buracle mcp stop web-search`'))).toBe(true)
    expect(warn.some(d => d.includes('600') && d.includes('`kill 600`'))).toBe(true)
    expect(warn.some(d => d.includes('401'))).toBe(false)
    const calm = orphanChecks(procs.filter(p => p.pid !== 600), [{ ...states[0] as BackendState, idleSince: now - 10_000 }], { now, lingerMs: 60_000, hasHarness: () => true, alive: () => true })
    expect(calm).toEqual([expect.objectContaining({ level: 'ok', check: 'processes' })])
    expect(calm[0]?.detail).toContain('backend')
  })
})

describe('buracle mcp status and stop (R19, R21)', () => {
  test('status lists the backend with its sessions, RSS, uptime and log; stop ends it, and the next call starts it again', () => withSandbox(async ({ root }) => {
    installStub(root)
    const files = backendFiles(backendKey('web-search', VERSION))
    const b = Bun.spawn([process.execPath, MAIN, 'mcp', 'backend', 'web-search'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', env: { ...process.env } })
    try {
      await until(() => existsSync(files.socket))
      const c = await session(files.socket, 4321)
      await until(() => (readJson(files.state)?.['clients'] as number[] | undefined)?.includes(4321))
      const j = memoryIO()
      expect(await mcpRun(['status', '--json'], j)).toBe(0)
      const rows = (JSON.parse(j.out()) as { processes: Array<{ pid: number, role: string, server: string, sessions: unknown, rssMb: number, uptime: string, log?: string }> }).processes
      const backend = rows.find(r => r.pid === b.pid)
      expect(backend).toMatchObject({ role: 'backend', server: 'web-search', sessions: [4321], log: paths.mcpLogFile('web-search') })
      expect(backend?.rssMb).toBeGreaterThan(0)
      expect(rows.some(r => r.role === 'upstream' && r.server === 'web-search')).toBe(true)
      const t = memoryIO()
      expect(await mcpRun(['status'], t)).toBe(0)
      expect(t.out()).toMatch(/web-search\s+backend/)
      c.close()
      const s = memoryIO()
      expect(await mcpRun(['stop', 'web-search'], s)).toBe(0)
      expect(s.out()).toContain(String(b.pid))
      await until(() => !alive(b.pid), 6_000)
      const none = memoryIO()
      expect(await mcpRun(['stop'], none)).toBe(0)
      expect(none.out()).toContain('no shared backend')
    } finally {
      try { b.kill('SIGKILL') } catch { /* gone */ }
      rmSync(paths.mcpFallbackRunDir(), { recursive: true, force: true })
    }
  }), 40_000)
})
