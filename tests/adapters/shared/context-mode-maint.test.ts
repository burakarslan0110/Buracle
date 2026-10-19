import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { cmPrune } from '../../../src/adapters/shared/context-mode/maint'
import { cmSmokeTest } from '../../../src/adapters/shared/context-mode/smoke'
import { CM_STATS_MAX_AGE_MS, harnessPidFromAncestors, parseCmStats, readCmStats } from '../../../src/adapters/shared/context-mode/stats'
import { cmHome, cmProbeRoot, cmSentinelDir, cmSessionsDir, cmStorageRoot } from '../../../src/engine/context-mode'
import { lockTestHooks } from '../../../src/engine/lockfile'
import { cmTmpDir } from '../../../src/adapters/shared/context-mode/client'
import { installCmFixture } from '../../fixtures/context-mode/fixture'
import { narrowPath } from '../../helpers/fake-exe'
import { makeSandboxDirs, withSandbox } from '../../helpers/sandbox'

const REPO = realpathSync(join(import.meta.dir, '..', '..', '..'))
const NOW = Date.UTC(2026, 9, 10, 12, 0, 0)
const MIN = 60_000
const DAY = 24 * 60 * MIN

function payload(updatedAt: number, keptOut = 81_920, returned = 4096): Record<string, unknown> {
  return {
    schemaVersion: 2, version: '1.0.169', updated_at: updatedAt, session_start: updatedAt - 60_000, uptime_ms: 60_000, total_calls: 12,
    bytes_returned: returned, bytes_indexed: 40_000, bytes_sandboxed: keptOut - 40_000, cache_hits: 0, cache_bytes_saved: 0,
    kept_out: keptOut, total_processed: keptOut + returned, reduction_pct: Math.round((keptOut / (keptOut + returned)) * 100), tokens_saved: Math.round(keptOut / 4),
    dollars_saved_session: 0.1, tokens_saved_lifetime: 1000, dollars_saved_lifetime: 0.2,
    by_tool: { ctx_batch_execute: { calls: 7, bytes: 3000 }, ctx_search: { calls: 5, bytes: 1096 } },
  }
}

function writeStats(dir: string, name: string, body: unknown, mtimeMs: number): string {
  mkdirSync(dir, { recursive: true })
  const f = join(dir, name)
  writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body))
  utimesSync(f, mtimeMs / 1000, mtimeMs / 1000)
  return f
}

function fileAt(p: string, mtimeMs: number, body = 'x'): string {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, body)
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
  return p
}

function foldersAt(mtimeMs: number, ...dirs: string[]): void {
  for (const d of dirs) utimesSync(d, mtimeMs / 1000, mtimeMs / 1000)
}

describe('the stats reader', () => {
  test('parses the schema-2 numbers; anything without them is no stats', () => {
    const s = parseCmStats(payload(NOW), '/f')
    expect(s).toEqual({
      file: '/f', schemaVersion: 2, version: '1.0.169', updatedAt: NOW, keptOut: 81_920, totalProcessed: 86_016, reductionPct: 95, tokensSaved: 20_480,
      totalCalls: 12, bytesReturned: 4096, byTool: { ctx_batch_execute: { calls: 7, bytes: 3000 }, ctx_search: { calls: 5, bytes: 1096 } },
    })
    expect(parseCmStats({ kept_out: 1, total_processed: 2 }, '/f')).toBeUndefined()
    expect(parseCmStats([1], '/f')).toBeUndefined()
    expect(parseCmStats('x', '/f')).toBeUndefined()
    expect(parseCmStats({ updated_at: NOW, kept_out: 10, total_processed: 40 }, '/f')).toMatchObject({ reductionPct: 25, tokensSaved: 3, bytesReturned: 30, totalCalls: 0, schemaVersion: 0 })
  })

  test("a session's or the harness process's own file, else the freshest one written within 15 minutes", async () => {
    await withSandbox(async sb => {
      const proj = join(sb.root, 'app')
      const dir = cmSessionsDir(cmStorageRoot('claude', proj))
      writeStats(dir, 'stats-pid-4242.json', payload(NOW - 30 * MIN, 1000), NOW - 30 * MIN)
      writeStats(dir, 'stats-sess-1.json', payload(NOW - 60 * MIN, 2000), NOW - 60 * MIN)
      writeStats(dir, 'stats-pid-7.json', payload(NOW - 2 * MIN, 3000), NOW - 2 * MIN)
      writeStats(dir, 'stats-pid-8.json', payload(NOW - 5 * MIN, 4000), NOW - 5 * MIN)
      writeStats(dir, 'stats-pid-9.json', '{broken', NOW - MIN)
      expect(readCmStats('claude', proj, { pid: 4242, nowMs: NOW })?.keptOut).toBe(1000)
      expect(readCmStats('claude', proj, { sessionId: 'sess-1', nowMs: NOW })?.keptOut).toBe(2000)
      expect(readCmStats('claude', proj, { nowMs: NOW })?.keptOut).toBe(3000)
      expect(readCmStats('claude', proj, { pid: 999, nowMs: NOW })?.keptOut).toBe(3000)
      expect(readCmStats('claude', proj, { nowMs: NOW + CM_STATS_MAX_AGE_MS })).toBeUndefined()
      expect(readCmStats('claude', proj, { sessionId: '../x', nowMs: NOW })?.keptOut).toBe(3000)
      expect(readCmStats('codex', proj, { nowMs: NOW })).toBeUndefined()
      expect(readCmStats('claude', join(sb.root, 'other'), { nowMs: NOW })).toBeUndefined()
    })
  })

  test('the harness process among the ancestors, walked on a process table', () => {
    const table: Record<number, [number, string]> = { 700: [600, 'bun'], 600: [500, '-zsh'], 500: [400, '/opt/homebrew/bin/omp'], 400: [1, 'login'], 800: [800, 'bun'] }
    const asked: number[] = []
    const ps = (pid: number): { ppid: number, comm: string } | undefined => {
      asked.push(pid)
      const row = table[pid]
      return row === undefined ? undefined : { ppid: row[0], comm: row[1] }
    }
    const walk = (h: 'omp' | 'codex' | 'claude', opts: { startPid: number, maxDepth?: number, env?: Record<string, string> }): number | undefined =>
      harnessPidFromAncestors(h, { ps, env: {}, budgetMs: 60_000, ...opts })
    expect(walk('omp', { startPid: 700 })).toBe(500)
    expect(asked).toEqual([700, 600, 500])
    expect(walk('codex', { startPid: 700 })).toBeUndefined()
    asked.length = 0
    expect(walk('omp', { startPid: 1 })).toBeUndefined()
    expect(asked).toEqual([])
    expect(walk('omp', { startPid: 700, maxDepth: 2 })).toBeUndefined()
    expect(walk('omp', { startPid: 700, maxDepth: 3 })).toBe(500)
    asked.length = 0
    expect(walk('omp', { startPid: 800 })).toBeUndefined()
    expect(asked).toEqual([800])
    expect(walk('omp', { startPid: 999 })).toBeUndefined()
    expect(harnessPidFromAncestors('omp', { startPid: 700, ps: () => undefined, budgetMs: 60_000 })).toBeUndefined()
    expect(walk('claude', { startPid: 700, env: { CLAUDE_PID: '600' } })).toBe(600)
  })
})

describe('housekeeping (H16)', () => {
  test('removes expired session files, stale stats, unread input files and old sentinels; keeps everything else', async () => {
    await withSandbox(async sb => {
      const old = NOW - 8 * DAY
      const file = (p: string, mtime: number, body = 'x'): string => {
        mkdirSync(join(p, '..'), { recursive: true })
        writeFileSync(p, body)
        utimesSync(p, mtime / 1000, mtime / 1000)
        return p
      }
      const root = cmStorageRoot('claude', join(sb.root, 'app'))
      const s = cmSessionsDir(root)
      const gone = [
        file(join(s, '0123456789abcdef.db'), old), file(join(s, '0123456789abcdef.db-wal'), old), file(join(s, '0123456789abcdef.db-shm'), old),
        file(join(s, '0123456789abcdef-events.md'), old), file(join(s, 'stats-pid-1.json'), NOW - 2 * DAY), file(join(s, 'stats-pid-1.json.tmp'), NOW - 2 * DAY),
        file(join(s, 'fedcba9876543210.db.corrupt-1790000000000'), old),
        file(join(cmTmpDir(), 'in-123-abcdef.json'), NOW - 20 * MIN), file(join(cmSentinelDir(), 'context-mode-mcp-ready-77'), old),
      ]
      const kept = [
        file(join(s, 'aaaaaaaaaaaaaaaa.db'), old), file(join(s, 'aaaaaaaaaaaaaaaa.db-wal'), NOW - MIN),
        file(join(s, 'bbbbbbbbbbbbbbbb__1a2b3c4d.db'), NOW - DAY), file(join(s, 'bbbbbbbbbbbbbbbb-events.md'), NOW - DAY),
        file(join(s, 'stats-pid-2.json'), NOW - MIN), file(join(s, 'notes.txt'), old),
        file(join(cmTmpDir(), 'in-124-abcdef.json'), NOW - MIN), file(join(cmTmpDir(), 'other.json'), old),
        file(join(root, 'content', 'fedcba9876543210.db'), old),
        file(join(cmSessionsDir(cmProbeRoot()), 'stats-pid-3.json'), NOW - MIN),
      ]
      const probeOld = file(join(cmSessionsDir(cmProbeRoot()), '1111111111111111.db'), old)
      const outside = file(join(sb.root, 'outside.db'), old)
      symlinkSync(outside, join(s, 'cccccccccccccccc.db'))
      const idle = cmStorageRoot('codex', join(sb.root, 'idle'))
      mkdirSync(cmSessionsDir(idle), { recursive: true })
      utimesSync(cmSessionsDir(idle), old / 1000, old / 1000)
      utimesSync(idle, old / 1000, old / 1000)
      const fresh = cmStorageRoot('omp', join(sb.root, 'fresh'))
      mkdirSync(cmSessionsDir(fresh), { recursive: true })
      const r = cmPrune(NOW)
      for (const p of [...gone, probeOld]) expect({ p, exists: existsSync(p) }).toEqual({ p, exists: false })
      for (const p of [...kept, outside, join(s, 'cccccccccccccccc.db')]) expect({ p, exists: existsSync(p) }).toEqual({ p, exists: true })
      expect(existsSync(idle)).toBe(false)
      expect(existsSync(cmSessionsDir(fresh))).toBe(true)
      expect(r.removed).toContain(idle)
      expect(r.removed).toContain(gone[0] as string)
    })
  })

  test('a folder that is a symbolic link is never listed: what sessions/, tmp/, sentinel/ or a harness folder point at stays', async () => {
    if (process.platform === 'win32') return
    await withSandbox(async sb => {
      const old = NOW - 30 * DAY
      const outside = join(sb.root, 'outside')
      const root = cmStorageRoot('claude', join(sb.root, 'linked'))
      mkdirSync(root, { recursive: true })
      const kept = [
        fileAt(join(outside, 'sessions', '0123456789abcdef.db'), old), fileAt(join(outside, 'sessions', '0123456789abcdef-events.md'), old),
        fileAt(join(outside, 'sessions', 'stats-pid-1.json'), NOW - 2 * DAY),
        fileAt(join(outside, 'tmp', 'in-1-abcdef.json'), NOW - 20 * MIN),
        fileAt(join(outside, 'sent', 'notes.txt'), old),
        fileAt(join(outside, 'codex', 'proj-0123456789ab', 'sessions', 'fedcba9876543210.db'), old),
      ]
      symlinkSync(join(outside, 'sessions'), cmSessionsDir(root))
      symlinkSync(join(outside, 'tmp'), cmTmpDir())
      symlinkSync(join(outside, 'sent'), cmSentinelDir())
      symlinkSync(join(outside, 'codex'), join(cmHome(), 'codex'))
      const r = cmPrune(NOW)
      for (const p of kept) expect({ p, exists: existsSync(p) }).toEqual({ p, exists: true })
      expect(r.removed).toEqual([])
    })
  })

  test("content stores unused for 14 days go (context-mode's own rule), also of a project never opened again; a fresh store and a live server's root stay", async () => {
    await withSandbox(async sb => {
      const old = NOW - 30 * DAY
      const abandoned = cmStorageRoot('codex', join(sb.root, 'abandoned'))
      const gone = [
        fileAt(join(abandoned, 'sessions', '0123456789abcdef.db'), old),
        fileAt(join(abandoned, 'content', 'fedcba9876543210.db'), old), fileAt(join(abandoned, 'content', 'fedcba9876543210.db-wal'), old),
        fileAt(join(abandoned, 'content', 'fedcba9876543210.db-shm'), old),
      ]
      foldersAt(old, join(abandoned, 'sessions'), join(abandoned, 'content'), abandoned)
      const recent = cmStorageRoot('claude', join(sb.root, 'recent'))
      const stale = fileAt(join(recent, 'content', '3333333333333333__wt.db'), NOW - 15 * DAY)
      const kept = [
        fileAt(join(recent, 'content', '1111111111111111.db'), NOW - 13 * DAY),
        fileAt(join(recent, 'content', '2222222222222222.db'), old), fileAt(join(recent, 'content', '2222222222222222.db-wal'), NOW - DAY),
        fileAt(join(recent, 'content', 'notes.db'), old),
        fileAt(join(sb.root, 'outside.db'), old),
      ]
      symlinkSync(join(sb.root, 'outside.db'), join(recent, 'content', '5555555555555555.db'))
      kept.push(join(recent, 'content', '5555555555555555.db'))
      const live = cmStorageRoot('omp', join(sb.root, 'live'))
      kept.push(fileAt(join(live, 'content', '4444444444444444.db'), old), fileAt(join(cmSessionsDir(live), 'stats-pid-7.json'), NOW - 60 * MIN))
      const r = cmPrune(NOW)
      for (const p of [...gone, stale]) expect({ p, exists: existsSync(p) }).toEqual({ p, exists: false })
      for (const p of kept) expect({ p, exists: existsSync(p) }).toEqual({ p, exists: true })
      expect(existsSync(abandoned)).toBe(false)
      expect(r.removed).toContain(gone[1] as string)
      expect(r.removed).toContain(abandoned)
    })
  })

  test('O11: a writer lock a day old goes, unless a session op broke it and took a fresh one meanwhile', async () => {
    await withSandbox(async sb => {
      const a = cmStorageRoot('claude', join(sb.root, 'a'))
      const b = cmStorageRoot('codex', join(sb.root, 'b'))
      const lockA = fileAt(join(a, 'writer.lock'), NOW - 2 * DAY)
      const lockB = fileAt(join(b, 'writer.lock'), NOW - 2 * DAY)
      const fresh = '{"pid":1,"token":"fresh"}'
      lockTestHooks.beforeBreak = path => { if (path === lockB) { unlinkSync(path); writeFileSync(path, fresh) } }
      let r: { removed: string[] }
      try { r = cmPrune(NOW) } finally { delete lockTestHooks.beforeBreak }
      expect(existsSync(lockA)).toBe(false)
      expect(r.removed).toContain(lockA)
      expect(readFileSync(lockB, 'utf8')).toBe(fresh)
      expect(r.removed).not.toContain(lockB)
    })
  })

  test('nothing to do without a context-mode folder; never throws', async () => {
    await withSandbox(async () => {
      expect(existsSync(cmHome())).toBe(false)
      expect(cmPrune(NOW)).toEqual({ removed: [] })
    })
  })
})

describe('the smoke test', () => {
  test('the fixture passes; the result names the package and its version', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const r = await cmSmokeTest({ pkg })
      expect(r).toMatchObject({ ok: true, root: pkg.root, version: '0.0.0-fixture', problems: [] })
      expect(r.ms).toBeGreaterThanOrEqual(0)
      expect(await cmSmokeTest({ root: pkg.root })).toMatchObject({ ok: true })
    })
  })

  test('a library whose extractor changed, or a missing one, fails with the reason', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb, { copy: true })
      writeFileSync(join(pkg.root, 'build', 'session', 'extract.js'), 'export function extractEvents() { return [] }\nexport function extractUserEvents() { return [] }\n')
      const r = await cmSmokeTest({ pkg })
      expect(r.ok).toBe(false)
      expect(r.problems).toContain('extractEvents(Edit) gave no file_edit row of category file')
      expect(r.problems.some(p => p.includes('the restore text lacks'))).toBe(true)
      expect(await cmSmokeTest({ pkg: null })).toMatchObject({ ok: false, problems: ['context-mode is not installed in the toolchain'] })
      expect((await cmSmokeTest({ root: join(sb.root, 'nothing') })).problems[0]).toStartWith('the session library cannot be loaded')
    })
  })

  test("passes with TMPDIR inside a dot-folder of random names, as in context-mode's own sandbox", async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const tmp = join(sb.root, '.ctx-mode-JzLi3O', 'Qx7Lm2Np', 'Rt5Yk8Wz')
      mkdirSync(tmp, { recursive: true })
      const before = process.env['TMPDIR']
      process.env['TMPDIR'] = tmp
      try {
        expect(await cmSmokeTest({ pkg })).toMatchObject({ ok: true, problems: [] })
      } finally {
        if (before === undefined) delete process.env['TMPDIR']
        else process.env['TMPDIR'] = before
      }
    })
  })
})

const REAL = process.env['BURACLE_CM_SMOKE']

describe.skipIf(REAL === undefined || REAL === '')('OPT-IN: a real context-mode package (BURACLE_CM_SMOKE)', () => {
  test('smoke, capture, snapshot, restore and a detached capture through the CLI, all inside a sandbox', async () => {
    const sb = makeSandboxDirs('buracle-cm-real-')
    const dirs = ['xdg-config', 'xdg-data', 'xdg-cache', 'tmp', 'cmdir', 'proj/src', 'home/.claude', 'home/.codex', 'home/.buracle/state', 'tc/node_modules']
    for (const d of dirs) mkdirSync(join(sb.root, d), { recursive: true })
    symlinkSync(realpathSync(REAL as string), join(sb.root, 'tc', 'node_modules', 'context-mode'))
    writeFileSync(join(sb.buracleHome, 'state', 'toolchain.json'), JSON.stringify({
      v: 1, updated_at: 'x', system: {},
      packages: { 'npm:context-mode': { registry: 'npm', name: 'context-mode', version: 'real', dir: join(sb.root, 'tc'), bins: {}, installed_at: 'x' } },
    }))
    const env: Record<string, string> = {
      PATH: process.env['PATH'] ?? narrowPath(), HOME: sb.home, BURACLE_HOME: sb.buracleHome, CLAUDE_CONFIG_DIR: join(sb.home, '.claude'),
      CODEX_HOME: join(sb.home, '.codex'), XDG_CONFIG_HOME: join(sb.root, 'xdg-config'), XDG_DATA_HOME: join(sb.root, 'xdg-data'),
      XDG_CACHE_HOME: join(sb.root, 'xdg-cache'), TMPDIR: join(sb.root, 'tmp'), CONTEXT_MODE_DIR: join(sb.root, 'cmdir'),
      PI_CODING_AGENT_DIR: join(sb.home, '.omp', 'agent'), BURACLE_NO_TOOLCHAIN: '1', BURACLE_NO_AUTOSTART: '1', BURACLE_NO_NOTIFY: '1',
    }
    const proj = join(sb.root, 'proj')
    const cli = async (args: string[], stdin?: string): Promise<{ code: number, out: string, err: string }> => {
      const p = Bun.spawn(['bun', join(REPO, 'src', 'cli', 'main.ts'), ...args], { cwd: sb.root, env, stdin: stdin !== undefined ? new Blob([stdin]) : 'ignore', stdout: 'pipe', stderr: 'pipe' })
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()])
      return { code: await p.exited, out, err }
    }
    try {
      const smoke = await cli(['ctx', 'smoke', '--json'])
      expect({ code: smoke.code, err: smoke.err }).toEqual({ code: 0, err: '' })
      expect(JSON.parse(smoke.out)).toMatchObject({ ok: true, problems: [] })
      const target = ['--harness', 'opencode', '--session', 'ses_real', '--cwd', proj, '--json']
      const evs = { events: [
        { kind: 'prompt', text: 'Export the report as CSV, keep the header row.' },
        { kind: 'tool', tool: 'Write', input: { file_path: join(proj, 'src', 'csv.ts'), content: 'SECRET' }, response: '', status: 'ok' },
        { kind: 'tool', tool: 'Bash', input: { command: 'bun test' }, response: 'error: expected 3 columns, got 2', status: 'error' },
        { kind: 'tool', tool: 'TodoWrite', input: { todos: [{ content: 'Write the CSV test', status: 'in_progress' }] }, response: '', status: 'ok' },
      ] }
      const cap = await cli(['ctx', 'session', 'capture', ...target], JSON.stringify(evs))
      expect(cap.code).toBe(0)
      expect(JSON.parse(cap.out)).toMatchObject({ ok: true })
      const snap = await cli(['ctx', 'session', 'snapshot', ...target], JSON.stringify({ events: [{ kind: 'prompt', text: 'Then wire it into the CLI.' }] }))
      const s = JSON.parse(snap.out) as { ok: boolean, snapshot?: string, text?: string }
      expect(s.ok).toBe(true)
      expect(s.snapshot).toContain('context-mode_ctx_search')
      expect(s.text).toContain('Last request (the user\'s words): "Then wire it into the CLI."')
      const rest = await cli(['ctx', 'session', 'restore', ...target])
      const text = (JSON.parse(rest.out) as { text: string }).text
      expect(text).toContain('Open tasks:\n- [in progress] Write the CSV test')
      expect(text).toContain('Files changed (newest first): src/csv.ts')
      expect(text).toContain('- error: expected 3 columns, got 2')
      expect(text).not.toContain('SECRET')
      const sessions = cmSessionsDir(join(sb.buracleHome, 'context-mode', 'opencode', readdirSync(join(sb.buracleHome, 'context-mode', 'opencode'))[0] as string))
      expect(readdirSync(sessions).some(n => n.endsWith('.db'))).toBe(true)
      expect(readdirSync(sessions).some(n => n.endsWith('-events.md'))).toBe(true)
      expect(readdirSync(join(sb.root, 'cmdir'))).toEqual([])
      expect(readdirSync(join(sb.home, '.claude'))).toEqual([])
      expect(readdirSync(join(sb.home, '.codex'))).toEqual([])
      const script = join(sb.root, 'forward.ts')
      writeFileSync(script, [
        `import { cmForward } from ${JSON.stringify(join(REPO, 'src/adapters/shared/context-mode/bridge.ts'))}`,
        `import { defaultConfig } from ${JSON.stringify(join(REPO, 'src/core/config.ts'))}`,
        `const p = { session_id: 'cl-real', cwd: ${JSON.stringify(proj)} }`,
        `console.log(JSON.stringify(await cmForward('claude', 'PostToolUse', { ...p, tool_name: 'Edit', tool_input: { file_path: ${JSON.stringify(join(proj, 'src', 'x.ts'))} }, tool_response: {} }, { config: defaultConfig() })))`,
        'let r = { action: "none" }',
        'for (let i = 0; i < 100; i++) { await Bun.sleep(100); r = await cmForward("claude", "SessionStart", { ...p, source: "compact" }, { config: defaultConfig() }); if (r.text?.includes("x.ts")) break }',
        'console.log(JSON.stringify(r))',
      ].join('\n'))
      const fwd = Bun.spawn(['bun', script], { cwd: sb.root, env, stdout: 'pipe', stderr: 'pipe' })
      const lines = (await new Response(fwd.stdout).text()).trim().split('\n')
      expect(await fwd.exited).toBe(0)
      expect(JSON.parse(lines[0] as string)).toEqual({ action: 'capture' })
      expect(JSON.parse(lines[1] as string).text).toContain('Files changed (newest first): src/x.ts')
    } finally {
      if (process.env['BURACLE_KEEP_SANDBOX'] !== '1') (await import('node:fs')).rmSync(sb.root, { recursive: true, force: true })
    }
  }, 120_000)
})
