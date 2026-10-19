import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { cmForward, cmBridgeProjectDir, cmCaptureDetached, cmIsSubagentPayload, cmRestore, cmSnapshotDetached, cmStartupDetached } from '../../../src/adapters/shared/context-mode/bridge'
import type { CmChildRequest } from '../../../src/adapters/shared/context-mode/client'
import { cmChildArgs, cmCliArgv, cmRunSessionChild, cmSpawnSession, cmTmpDir, parseCmOutcome, takeCmInput, writeCmInput } from '../../../src/adapters/shared/context-mode/client'
import { CM_LIBRARY_MODULES, cmPackageVersion, loadCmLibrary } from '../../../src/adapters/shared/context-mode/library'
import type { CmSessionDb } from '../../../src/adapters/shared/context-mode/library'
import { CM_BUSY_TIMEOUT_MS, cmIdleSessions, cmReadEvents, cmRestoreOp, cmRunOp, cmTargetProblem, cmWriterLock, openCmSessionDb, type CmTarget } from '../../../src/adapters/shared/context-mode/session'
import { defaultConfig, type BuracleConfig } from '../../../src/core/config'
import { cmClaudeEvent, cmPromptEvent, cmToolEvent, type CmEvent } from '../../../src/core/context-mode'
import { cmSessionsDir, cmStorageRoot, type CmPackage } from '../../../src/engine/context-mode'
import { spawnArgv, windowsVerbatim } from '../../../src/engine/platform'
import { CM_FIXTURE_PACKAGE, installCmFixture, recordCmFixture, stopCmFixture } from '../../fixtures/context-mode/fixture'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { makeRepo } from '../../memory/helpers'

const REPO = realpathSync(join(import.meta.dir, '..', '..', '..'))
const cfg = (enabled = true, capture = true): BuracleConfig => ({ ...defaultConfig(), contextMode: { enabled, capture } })
const ON = { config: cfg(), env: {} }

function project(root: string, name = 'app'): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function events(dir: string): CmEvent[] {
  return [
    cmPromptEvent('Add input validation to src/app.ts, then run the tests.'),
    cmToolEvent('Read', { file_path: join(dir, 'src/app.ts') }, 'source text', 'ok'),
    cmToolEvent('Edit', { file_path: join(dir, 'src/app.ts'), old_string: 'a', new_string: 'b' }, '', 'ok'),
    cmToolEvent('Bash', { command: 'bun test' }, ' 3 pass\n FAIL 0 (nothing failed)', 'ok'),
    cmToolEvent('Bash', { command: 'bun test src/app.test.ts' }, 'error: expected 1 to be 2', 'error'),
    cmToolEvent('Bash', { command: 'git commit -m "feat: validate input"' }, '', 'ok'),
  ].filter((e): e is CmEvent => e !== undefined)
}

beforeEach(() => { stopCmFixture() })
afterEach(() => { stopCmFixture() })

describe('the session library loader', () => {
  test('loads the five-or-fewer modules the bridge uses, never the hook helpers, loaders, platform bridge or adapters', async () => {
    expect(CM_LIBRARY_MODULES).toEqual(['build/session/db.js', 'build/session/extract.js', 'build/session/snapshot.js', 'hooks/session-directive.mjs'])
    for (const m of CM_LIBRARY_MODULES) expect(m).not.toMatch(/session-helpers|session-loaders|platform-bridge|adapters\//)
    const lib = await loadCmLibrary(CM_FIXTURE_PACKAGE)
    expect(lib?.version).toBe('0.0.0-fixture')
    expect(lib?.root).toBe(CM_FIXTURE_PACKAGE)
    expect(loadCmLibrary(CM_FIXTURE_PACKAGE)).toBe(loadCmLibrary(CM_FIXTURE_PACKAGE))
    expect(cmPackageVersion('/nonexistent')).toBe('unknown')
  })

  test('a missing package or a library without an export the bridge uses gives undefined, never an error', async () => {
    await withSandbox(async sb => {
      expect(await loadCmLibrary(join(sb.root, 'missing'))).toBeUndefined()
      const pkg = installCmFixture(sb, { copy: true })
      writeFileSync(join(pkg.root, 'hooks', 'session-directive.mjs'), 'export function somethingElse() {}\n')
      expect(await loadCmLibrary(pkg.root)).toBeUndefined()
    })
  })
})

describe('session ops', () => {
  test('capture stores the rows in order in the project root of the harness, after the session row, with a short busy_timeout', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const t: CmTarget = { harness: 'claude', sessionId: 'sess-1', projectDir: dir }
      const rec = recordCmFixture()
      const r = await cmRunOp({ op: 'capture', target: t, events: events(dir) }, { ...ON, pkg })
      expect(r).toEqual({ ok: true, rows: 7 })
      const lib = await loadCmLibrary(pkg.root)
      const rows = cmReadEvents(lib!, t)?.map(e => `${e.type}:${e.data}`)
      expect(rows).toEqual([
        'user_prompt:Add input validation to src/app.ts, then run the tests.',
        'decision:Add input validation to src/app.ts, then run the tests.',
        'intent:implement',
        `file_read:${join(dir, 'src/app.ts')}`,
        `file_edit:${join(dir, 'src/app.ts')}`,
        'error_tool:error: expected 1 to be 2',
        'git_commit:feat: validate input',
      ])
      const names = rec.calls.map(c => c[0])
      expect(names.indexOf('ensureSession')).toBeLessThan(names.indexOf('bulkInsertEvents'))
      expect(rec.calls).toContainEqual(['pragma', `busy_timeout = ${CM_BUSY_TIMEOUT_MS}`])
      expect(rec.calls.filter(c => c[0] === 'bulkInsertEvents').map(c => c[3])).toEqual(['UserPromptSubmit', 'PostToolUse'])
      const sessions = cmSessionsDir(cmStorageRoot('claude', dir))
      expect(rec.calls.find(c => c[0] === 'open')?.[1]).toStartWith(sessions)
      if (process.platform !== 'win32') expect(statSync(sessions).mode & 0o777).toBe(0o700)
      expect(cmStorageRoot('codex', dir)).not.toBe(cmStorageRoot('claude', dir))
      expect(cmReadEvents(lib!, { ...t, projectDir: project(sb.root, 'other') })).toEqual([])
    })
  })

  test("snapshot records the buffered events, stores context-mode's snapshot with the harness's search tool and returns the restore text", async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const t: CmTarget = { harness: 'omp', sessionId: 'omp-1', projectDir: dir }
      const rec = recordCmFixture()
      const r = await cmRunOp({ op: 'snapshot', target: t, events: events(dir) }, { ...ON, pkg })
      expect(r.ok).toBe(true)
      expect(r.rows).toBe(7)
      expect(r.snapshot).toStartWith('<session_resume events="7" compact_count="1">')
      expect(r.snapshot).toContain('mcp__context_mode_ctx_search(queries')
      expect(r.text).toContain('Last request (the user\'s words): "Add input validation to src/app.ts, then run the tests."')
      expect(r.text).toContain('Files changed (newest first): src/app.ts')
      expect(rec.calls.map(c => c[0])).toContain('incrementCompactCount')
      const second = await cmRunOp({ op: 'snapshot', target: t }, { ...ON, pkg })
      expect(second.snapshot).toStartWith('<session_resume events="7" compact_count="2">')
    })
  })

  test("the snapshot leaves out a rule file's contents", async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const t: CmTarget = { harness: 'opencode', sessionId: 'ses_1', projectDir: dir }
      await cmRunOp({ op: 'capture', target: t, events: events(dir).slice(0, 1) }, { ...ON, pkg })
      const lib = (await loadCmLibrary(pkg.root))!
      const o = openCmSessionDb(lib, t)
      o.db.bulkInsertEvents('ses_1', [{ type: 'rule_content', category: 'rule', data: 'ALL THE RULES', priority: 1 }], 'PostToolUse')
      o.close()
      const r = await cmRunOp({ op: 'snapshot', target: t }, { ...ON, pkg })
      expect(r.snapshot).not.toContain('ALL THE RULES')
      expect(r.snapshot).toContain('Add input validation')
    })
  })

  test('restore marks the snapshot used, writes the events file for ctx_search and renders the text', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const t: CmTarget = { harness: 'codex', sessionId: 'cx-1', projectDir: dir }
      await cmRunOp({ op: 'snapshot', target: t, events: events(dir) }, { ...ON, pkg })
      const r = await cmRunOp({ op: 'restore', target: t, source: 'resume' }, { ...ON, pkg })
      expect(r.ok).toBe(true)
      expect(r.text).toStartWith('<context_mode_restore source="resume">')
      expect(r.text).toContain('mcp__context_mode__ctx_search(queries: [...], source: "session-events")')
      expect(r.text).toContain('- error: expected 1 to be 2')
      const sessions = cmSessionsDir(cmStorageRoot('codex', dir))
      const db = new Database(join(sessions, (await import('node:fs')).readdirSync(sessions).find(n => n.endsWith('.db')) as string), { readonly: true })
      expect(db.query('SELECT consumed FROM session_resume WHERE session_id = ?').get('cx-1')).toEqual({ consumed: 1 })
      db.close()
      const md = (await import('node:fs')).readdirSync(sessions).find(n => n.endsWith('-events.md'))
      expect(readFileSync(join(sessions, md as string), 'utf8')).toContain('## Last User Prompt\n\nAdd input validation to src/app.ts, then run the tests.')
      expect((await cmRunOp({ op: 'restore', target: { ...t, sessionId: 'nobody' } }, { ...ON, pkg })).text).toBe('')
    })
  })

  test('restore past its deadline skips the events file but still renders', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const t: CmTarget = { harness: 'claude', sessionId: 'late', projectDir: dir }
      await cmRunOp({ op: 'capture', target: t, events: events(dir) }, { ...ON, pkg })
      const lib = (await loadCmLibrary(pkg.root))!
      const r = cmRestoreOp(lib, t, 'compact', { deadline: 10, now: () => 20 })
      expect(r.text).toContain('Last request')
      expect((await import('node:fs')).readdirSync(cmSessionsDir(cmStorageRoot('claude', dir))).some(n => n.endsWith('-events.md'))).toBe(false)
    })
  })

  test('startup opens the session and drops only sessions nobody recorded into for 7 days, never its own', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const target = (sessionId: string): CmTarget => ({ harness: 'omp', sessionId, projectDir: dir })
      expect(await cmRunOp({ op: 'startup', target: target('o1') }, { ...ON, pkg })).toEqual({ ok: true, removed: 0 })
      for (const sid of ['idle', 'active', 'o1']) expect((await cmRunOp({ op: 'capture', target: target(sid), events: events(dir).slice(0, 1) }, { ...ON, pkg })).ok).toBe(true)
      const lib = (await loadCmLibrary(pkg.root))!
      const db = new Database(lib.resolveSessionDbPath({ projectDir: dir, sessionsDir: cmSessionsDir(cmStorageRoot('omp', dir)) }))
      const age = (sid: string, startedDays: number, lastDays: number | null): void => {
        db.query("UPDATE session_meta SET started_at = datetime('now', ?), last_event_at = IIF(? IS NULL, NULL, datetime('now', ?)) WHERE session_id = ?")
          .run(`-${startedDays} days`, lastDays, `-${lastDays ?? 0} days`, sid)
      }
      age('idle', 9, 8)
      age('active', 30, 0)
      age('o1', 20, 10)
      db.query("INSERT INTO session_meta (session_id, project_dir, started_at) VALUES ('opened', ?, datetime('now', '-8 days'))").run(dir)
      db.close()
      expect(await cmRunOp({ op: 'startup', target: target('o1') }, { ...ON, pkg })).toEqual({ ok: true, removed: 2 })
      const rows = (sid: string): number | undefined => cmReadEvents(lib, target(sid))?.length
      expect({ idle: rows('idle'), active: rows('active'), o1: rows('o1') }).toEqual({ idle: 0, active: 3, o1: 3 })
      const left = new Database(lib.resolveSessionDbPath({ projectDir: dir, sessionsDir: cmSessionsDir(cmStorageRoot('omp', dir)) }), { readonly: true })
      expect(left.query('SELECT session_id FROM session_meta ORDER BY session_id').all()).toEqual([{ session_id: 'active' }, { session_id: 'o1' }])
      left.close()
    })
  })

  test('the ops stand down, with the reason, while a switch is off, without the toolchain copy and for a bad target', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const t: CmTarget = { harness: 'claude', sessionId: 's', projectDir: dir }
      const rec = recordCmFixture()
      expect(await cmRunOp({ op: 'capture', target: t, events: events(dir) }, { config: cfg(true, false), env: {}, pkg })).toEqual({ ok: false, skipped: 'contextMode.capture is false' })
      expect(await cmRunOp({ op: 'restore', target: t }, { config: cfg(false, true), env: {}, pkg })).toEqual({ ok: false, skipped: 'contextMode.enabled is false' })
      expect(await cmRunOp({ op: 'startup', target: t }, { config: cfg(), env: { BURACLE_NO_CAPTURE: '1' }, pkg })).toEqual({ ok: false, skipped: 'BURACLE_NO_CAPTURE=1' })
      expect(await cmRunOp({ op: 'startup', target: t }, { ...ON, pkg: null })).toEqual({ ok: false, skipped: 'context-mode is not installed in the toolchain' })
      expect(await cmRunOp({ op: 'startup', target: t }, { ...ON, pkg: { ...pkg, root: join(sb.root, 'gone') } })).toEqual({ ok: false, skipped: 'the context-mode session library is unavailable' })
      expect(rec.calls).toEqual([])
      expect((await cmRunOp({ op: 'startup', target: { ...t, sessionId: '../x' } }, { ...ON, pkg })).skipped).toBe('invalid session id')
      expect((await cmRunOp({ op: 'startup', target: { ...t, projectDir: 'relative/dir' } }, { ...ON, pkg })).skipped).toBe('the project folder must be an absolute path')
      expect(cmTargetProblem({ harness: 'kilo' as never, sessionId: 's', projectDir: dir })).toBe("unknown harness 'kilo'")
      expect((await cmRunOp({ op: 'startup', target: t }, { config: cfg(), pkg })).skipped).toBe('BURACLE_NO_CAPTURE=1')
    })
  })

  test('every op stands down for a project memory.exclude keeps out: a folder in the config it gets, an owner/repo in config.yaml', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const t: CmTarget = { harness: 'opencode', sessionId: 'ses_x', projectDir: dir }
      const rec = recordCmFixture()
      const kept = { ...cfg(), memory: { ...cfg().memory, exclude: [dir] } }
      for (const op of ['capture', 'snapshot', 'restore', 'startup'] as const) {
        expect(await cmRunOp({ op, target: t, events: events(dir) }, { config: kept, env: {}, pkg })).toEqual({ ok: false, skipped: `excluded by memory.exclude (${dir})` })
      }
      const repo = makeRepo(join(sb.root, 'clients', 'secret'), 'git@github.com:acme/secret.git')
      writeFileSync(join(sb.buracleHome, 'config.yaml'), 'memory:\n  exclude: [acme/*]\n')
      expect(await cmRunOp({ op: 'capture', target: { ...t, projectDir: repo }, events: events(repo) }, { ...ON, pkg })).toEqual({ ok: false, skipped: 'excluded by memory.exclude (acme/*)' })
      expect(rec.calls).toEqual([])
      expect(await cmRunOp({ op: 'capture', target: t, events: events(dir) }, { ...ON, pkg })).toEqual({ ok: true, rows: 7 })
    })
  })

  test('a failing library call is reported, never thrown', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      recordCmFixture().fail = 'bulkInsertEvents'
      const r = await cmRunOp({ op: 'capture', target: { harness: 'codex', sessionId: 'c', projectDir: dir }, events: events(dir) }, { ...ON, pkg })
      expect(r).toEqual({ ok: false, skipped: 'failed: fixture: bulkInsertEvents failed' })
    })
  })

  test('writers queue on the storage root lock and write anyway once the wait is over', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const t: CmTarget = { harness: 'claude', sessionId: 'locked', projectDir: dir }
      const lock = cmWriterLock(t)
      mkdirSync(join(lock, '..'), { recursive: true })
      writeFileSync(lock, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      const start = Date.now()
      const r = await cmRunOp({ op: 'capture', target: t, events: events(dir) }, { ...ON, pkg, lockWaitMs: 150 })
      expect(Date.now() - start).toBeGreaterThanOrEqual(140)
      expect(r.ok).toBe(true)
      expect(existsSync(lock)).toBe(true)
      unlinkSync(lock)
      expect((await cmRunOp({ op: 'capture', target: t, events: events(dir) }, { ...ON, pkg })).ok).toBe(true)
      expect(existsSync(lock)).toBe(false)
    })
  })

  test('cmIdleSessions: the idle query through the raw handle, never the session it keeps; undefined without a raw handle', () => {
    const asked: unknown[][] = []
    const rows = [{ session_id: 'old-1' }, { session_id: 'keep-me' }, { session_id: 42 }, null, { session_id: 'old-2' }]
    const db = { db: { prepare: (sql: string) => ({ all: (...params: unknown[]) => { asked.push([sql, ...params]); return rows } }) } } as unknown as CmSessionDb
    expect(cmIdleSessions(db, 'keep-me')).toEqual(['old-1', 'old-2'])
    expect(asked).toEqual([[expect.stringContaining('COALESCE(last_event_at, started_at)'), '-7 days', 'keep-me']])
    expect(cmIdleSessions({} as unknown as CmSessionDb, 'keep-me')).toBeUndefined()
    expect(cmIdleSessions({ db: {} } as unknown as CmSessionDb, 'keep-me')).toBeUndefined()
  })
})

describe('the session child client', () => {
  test('a detached child gets its events through a private input file', async () => {
    await withSandbox(async sb => {
      const dir = project(sb.root)
      const seen: Array<{ argv: string[], cwd: string }> = []
      const req: CmChildRequest = { op: 'capture', target: { harness: 'claude', sessionId: 's1', projectDir: dir }, events: events(dir).slice(0, 2) }
      expect(cmSpawnSession(req, (argv, opts) => { seen.push({ argv, ...opts }) })).toBe(true)
      const argv = seen[0]?.argv ?? []
      const input = argv[argv.indexOf('--input') + 1] as string
      expect(argv).toEqual([...cmCliArgv(), 'ctx', 'session', 'capture', '--harness', 'claude', '--session', 's1', '--project-dir', dir, '--input', input, '--json'])
      expect(input.startsWith(cmTmpDir())).toBe(true)
      if (process.platform !== 'win32') expect(statSync(input).mode & 0o777).toBe(0o600)
      expect(JSON.parse(readFileSync(input, 'utf8'))).toEqual({ events: req.events })
      expect(cmSpawnSession(req, () => { throw new Error('no fork') })).toBe(false)
      expect((await import('node:fs')).readdirSync(cmTmpDir()).length).toBe(1)
      expect(cmSpawnSession({ op: 'startup', target: req.target }, (a) => { seen.push({ argv: a, cwd: '' }) })).toBe(true)
      expect(seen[1]?.argv).not.toContain('--input')
    })
  })

  test('from a checkout the child is this checkout\'s CLI; the arguments and the printed outcome', () => {
    expect(cmCliArgv().slice(-1)).toEqual([join(REPO, 'src', 'cli', 'main.ts')])
    expect(cmChildArgs({ op: 'restore', target: { harness: 'omp', sessionId: 's', projectDir: '/p' }, source: 'resume', maxBytes: 900 }))
      .toEqual(['ctx', 'session', 'restore', '--harness', 'omp', '--session', 's', '--project-dir', '/p', '--source', 'resume', '--max-bytes', '900', '--json'])
    expect(parseCmOutcome('noise\n{"ok":true,"text":"x"}\n')).toEqual({ ok: true, text: 'x' })
    expect(parseCmOutcome('{"text":"no ok"}')).toBeUndefined()
    expect(parseCmOutcome('not json')).toBeUndefined()
  })

  test('an input file is deleted after reading only when Buracle wrote it into its tmp folder', async () => {
    await withSandbox(async sb => {
      const mine = writeCmInput('{"events":[]}') as string
      expect(takeCmInput(mine)).toBe('{"events":[]}')
      expect(existsSync(mine)).toBe(false)
      const other = join(sb.root, 'in-1-abc.json')
      writeFileSync(other, '{"events":[]}')
      expect(takeCmInput(other)).toBe('{"events":[]}')
      expect(existsSync(other)).toBe(true)
      const named = join(cmTmpDir(), 'keep.json')
      writeFileSync(named, 'x')
      expect(takeCmInput(named)).toBe('x')
      expect(existsSync(named)).toBe(true)
      expect(takeCmInput(join(sb.root, 'missing.json'))).toBeUndefined()
    })
  })

  test('an awaited child (OpenCode, omp): capture on stdin, then the restore text; a timeout gives undefined', async () => {
    await withSandbox(async sb => {
      installCmFixture(sb)
      const dir = project(sb.root)
      const target: CmTarget = { harness: 'opencode', sessionId: 'ses_child', projectDir: dir }
      await withEnv({ BURACLE_NO_CAPTURE: undefined }, async () => {
        expect(await cmRunSessionChild({ op: 'capture', target, events: events(dir) }, { timeoutMs: 20_000 })).toEqual({ ok: true, rows: 7 })
        const r = await cmRunSessionChild({ op: 'restore', target, source: 'compact', maxBytes: 2000 }, { timeoutMs: 20_000 })
        expect(r?.ok).toBe(true)
        expect(r?.text).toContain('context-mode_ctx_search(queries')
        expect(await cmRunSessionChild({ op: 'restore', target }, { timeoutMs: 1 })).toBeUndefined()
        writeFileSync(join(sb.buracleHome, 'config.yaml'), `memory:\n  exclude: [${JSON.stringify(dir)}]\n`)
        const kept = { ok: false, skipped: `excluded by memory.exclude (${dir})` }
        expect(await cmRunSessionChild({ op: 'capture', target: { ...target, harness: 'omp' }, events: events(dir) }, { timeoutMs: 20_000 })).toEqual(kept)
        expect(await cmRunSessionChild({ op: 'restore', target, source: 'compact', maxBytes: 2000 }, { timeoutMs: 20_000 })).toEqual(kept)
      })
    })
  }, 60_000)
})

describe('the Claude Code and Codex bridge', () => {
  function spy(): { reqs: CmChildRequest[], spawn: (r: CmChildRequest) => boolean } {
    const reqs: CmChildRequest[] = []
    return { reqs, spawn: r => { reqs.push(r); return true } }
  }

  test('prompts and tool calls go to a detached capture child; a session start to startup, a compaction to snapshot', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const s = spy()
      const opts = { ...ON, pkg, spawn: s.spawn }
      const base = { session_id: 'cl-1', cwd: dir }
      expect(await cmForward('claude', 'UserPromptSubmit', { ...base, prompt: 'Rename the parser, then fix the callers.' }, opts)).toEqual({ action: 'capture' })
      expect(await cmForward('claude', 'PostToolUse', { ...base, tool_name: 'Edit', tool_input: { file_path: `${dir}/a.ts` }, tool_response: {} }, opts)).toEqual({ action: 'capture' })
      expect(await cmForward('claude', 'PostToolUseFailure', { ...base, tool_name: 'Read', tool_input: { file_path: `${dir}/x` }, error: 'File does not exist.' }, opts)).toEqual({ action: 'capture' })
      expect(await cmForward('claude', 'SessionStart', { ...base, source: 'startup' }, opts)).toEqual({ action: 'startup' })
      expect(await cmForward('claude', 'SessionStart', { ...base, source: 'clear' }, opts)).toEqual({ action: 'startup' })
      expect(await cmForward('claude', 'PreCompact', { ...base, trigger: 'auto' }, opts)).toEqual({ action: 'snapshot' })
      const target: CmTarget = { harness: 'claude', sessionId: 'cl-1', projectDir: realpathSync(dir) }
      expect(s.reqs).toEqual([
        { op: 'capture', target, events: [{ kind: 'prompt', text: 'Rename the parser, then fix the callers.' }] },
        { op: 'capture', target, events: [{ kind: 'tool', tool: 'Edit', input: { file_path: `${dir}/a.ts` }, response: '', status: 'ok' }] },
        { op: 'capture', target, events: [{ kind: 'tool', tool: 'failed:Read', input: {}, response: 'Read error: File does not exist.', status: 'error' }] },
        { op: 'startup', target },
        { op: 'startup', target },
        { op: 'snapshot', target },
      ])
      expect(await cmForward('claude', 'UserPromptSubmit', { ...base, prompt: 'Buracle stop guard: continue with task 2.' }, opts)).toEqual({ action: 'none', skipped: 'nothing to record' })
      expect(await cmForward('claude', 'PostToolUse', { ...base, tool_name: 'mcp__plugin_buracle_codegraph__codegraph_explore', tool_input: {}, tool_response: 'x' }, opts)).toEqual({ action: 'none', skipped: 'nothing to record' })
      expect(await cmForward('claude', 'Stop', { ...base, last_assistant_message: 'done' }, opts)).toEqual({ action: 'none', skipped: 'not a bridged event' })
      expect(await cmForward('codex', 'PostToolUse', { ...base, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'a.ts' }, opts)).toEqual({ action: 'capture' })
      expect(await cmForward('codex', 'SessionStart', { ...base, source: 'fork' }, opts)).toEqual({ action: 'startup' })
      expect(s.reqs.length).toBe(8)
    })
  })

  test('SessionStart(compact|resume) restores in process within its budget', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const target: CmTarget = { harness: 'claude', sessionId: 'cl-2', projectDir: dir }
      await cmRunOp({ op: 'capture', target, events: events(dir) }, { ...ON, pkg })
      const env = { CLAUDE_PROJECT_DIR: dir }
      const r = await cmForward('claude', 'SessionStart', { session_id: 'cl-2', cwd: `${dir}/src`, source: 'compact' }, { ...ON, env, pkg })
      expect(r.action).toBe('restore')
      expect(r.text).toContain('Last request (the user\'s words): "Add input validation to src/app.ts, then run the tests."')
      expect(r.text).toContain('More: mcp__plugin_buracle_context-mode__ctx_search(queries: [...], source: "session-events")')
      expect(await cmForward('claude', 'SessionStart', { session_id: 'cl-new', cwd: dir, source: 'resume' }, { ...ON, env, pkg })).toEqual({ action: 'restore', text: '' })
      let t = 0
      const late = await cmForward('claude', 'SessionStart', { session_id: 'cl-2', cwd: dir, source: 'compact' }, { ...ON, env, pkg, restoreBudgetMs: 5, now: () => (t += 10) })
      expect(late).toEqual({ action: 'restore', skipped: 'the restore was unavailable or over its time budget' })
      expect(await cmRestore(target, 'compact', { pkg: null })).toBeUndefined()
      expect(await cmRestore({ ...target, sessionId: 'bad id' }, 'compact', { pkg })).toBeUndefined()
    })
  })

  test('the bridge stands down for subagents, invalid ids, the switches and a missing toolchain copy', async () => {
    await withSandbox(async sb => {
      const pkg = installCmFixture(sb)
      const dir = project(sb.root)
      const s = spy()
      const p = { session_id: 'x1', cwd: dir, prompt: 'go on, please' }
      expect(await cmForward('claude', 'UserPromptSubmit', { ...p, agent_id: 'a1' }, { ...ON, pkg, spawn: s.spawn })).toEqual({ action: 'none', skipped: 'subagent' })
      expect(await cmForward('codex', 'UserPromptSubmit', { ...p, agent_type: 'worker' }, { ...ON, pkg, spawn: s.spawn })).toEqual({ action: 'none', skipped: 'subagent' })
      expect(await cmForward('claude', 'UserPromptSubmit', { ...p, session_id: 42 }, { ...ON, pkg, spawn: s.spawn })).toEqual({ action: 'none', skipped: 'invalid session id' })
      expect(await cmForward('claude', 'UserPromptSubmit', p, { config: cfg(true, false), env: {}, pkg, spawn: s.spawn })).toEqual({ action: 'none', skipped: 'contextMode.capture is false' })
      expect(await cmForward('claude', 'UserPromptSubmit', p, { config: cfg(), env: { BURACLE_NO_CAPTURE: '1' }, pkg, spawn: s.spawn })).toEqual({ action: 'none', skipped: 'BURACLE_NO_CAPTURE=1' })
      expect(await cmForward('claude', 'UserPromptSubmit', p, { ...ON, pkg: null, spawn: s.spawn })).toEqual({ action: 'none', skipped: 'context-mode is not installed in the toolchain' })
      expect(await cmForward('claude', 'UserPromptSubmit', p, { ...ON, pkg, spawn: () => false })).toEqual({ action: 'capture', skipped: 'the child could not be started' })
      const kept = { config: { ...cfg(), memory: { ...cfg().memory, exclude: [dir] } }, env: {}, pkg, spawn: s.spawn }
      const why = { action: 'none' as const, skipped: `excluded by memory.exclude (${dir})` }
      expect(await cmForward('claude', 'UserPromptSubmit', p, kept)).toEqual(why)
      expect(await cmForward('codex', 'PostToolUse', { session_id: 'x1', cwd: dir, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'a.ts' }, kept)).toEqual(why)
      expect(await cmForward('claude', 'PostToolUse', { session_id: 'x1', cwd: dir, tool_name: 'mcp__docs__search', tool_input: { q: 'x' } }, kept)).toEqual({ action: 'none', skipped: 'nothing to record' })
      expect(await cmForward('claude', 'SessionStart', { session_id: 'x1', cwd: dir, source: 'startup' }, kept)).toEqual(why)
      expect(await cmForward('claude', 'PreCompact', { session_id: 'x1', cwd: dir, trigger: 'auto' }, kept)).toEqual(why)
      await cmRunOp({ op: 'capture', target: { harness: 'claude', sessionId: 'x1', projectDir: dir }, events: events(dir) }, { ...ON, pkg })
      expect(await cmForward('claude', 'SessionStart', { session_id: 'x1', cwd: dir, source: 'compact' }, kept)).toEqual(why)
      expect(await cmForward('claude', 'SessionStart', { session_id: 'x1', cwd: `${dir}/src`, source: 'resume' }, { ...kept, env: { CLAUDE_PROJECT_DIR: dir } })).toEqual(why)
      expect(s.reqs).toEqual([])
      expect(cmIsSubagentPayload('claude', { agent_type: 'x' })).toBe(false)
      expect(cmCaptureDetached({ harness: 'claude', sessionId: 's', projectDir: 'rel' }, [cmPromptEvent('x') as CmEvent], s.spawn)).toBe(false)
      expect(cmCaptureDetached({ harness: 'claude', sessionId: 's', projectDir: dir }, [], s.spawn)).toBe(false)
      expect(cmStartupDetached({ harness: 'claude', sessionId: '', projectDir: dir }, s.spawn)).toBe(false)
      expect(cmSnapshotDetached({ harness: 'codex', sessionId: 's', projectDir: dir }, s.spawn)).toBe(true)
    })
  })

  test("the project folder: Claude's CLAUDE_PROJECT_DIR as given, else the real path of the payload's cwd", async () => {
    await withSandbox(async sb => {
      const real = project(sb.root, 'real')
      const link = join(sb.root, 'link')
      symlinkSync(real, link)
      expect(cmBridgeProjectDir('claude', { cwd: `${link}` }, { CLAUDE_PROJECT_DIR: link })).toBe(link)
      expect(cmBridgeProjectDir('claude', { cwd: link }, {})).toBe(real)
      expect(cmBridgeProjectDir('codex', { cwd: link }, { CLAUDE_PROJECT_DIR: '/elsewhere' })).toBe(real)
    })
  })

  test('a detached capture child really records (the Claude/Codex path end to end)', async () => {
    await withSandbox(async sb => {
      installCmFixture(sb)
      const dir = project(sb.root)
      await withEnv({ BURACLE_NO_CAPTURE: undefined }, async () => {
        const ev = cmClaudeEvent('PostToolUse', { session_id: 'live', tool_name: 'Write', tool_input: { file_path: `${dir}/new.ts`, content: 'x' }, tool_response: {} })
        const target: CmTarget = { harness: 'claude', sessionId: 'live', projectDir: dir }
        // The child runs detached, as in the product, but the test keeps its handle: its cwd is the sandbox HOME,
        // which Windows cannot remove while the child still runs.
        const children: Array<ReturnType<typeof Bun.spawn>> = []
        const stderrs: Array<Promise<string>> = []
        const spawn = (req: CmChildRequest) => cmSpawnSession(req, (argv, opts) => {
          const spawned = spawnArgv(argv)
          const child = Bun.spawn(spawned, { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe', detached: true, cwd: opts.cwd, env: { ...process.env }, windowsVerbatimArguments: windowsVerbatim(spawned) })
          children.push(child)
          stderrs.push(new Response(child.stderr).text())
        })
        expect(cmCaptureDetached(target, [ev as CmEvent], spawn)).toBe(true)
        const deadline = Date.now() + 20_000
        let text = ''
        while (Date.now() < deadline) {
          text = (await cmRestore(target, 'compact', { budgetMs: 3000 })) ?? ''
          if (text.includes('new.ts')) break
          await Bun.sleep(100)
        }
        await Promise.all(children.map(c => c.exited))
        expect(children).toHaveLength(1)
        // When nothing was recorded, the child's stderr says why.
        const recorded = text.includes('Files changed (newest first): new.ts')
        expect({ recorded, childStderr: recorded ? [] : await Promise.all(stderrs) }).toEqual({ recorded: true, childStderr: [] })
        expect(text).toContain('Files changed (newest first): new.ts')
        expect((await import('node:fs')).readdirSync(cmTmpDir())).toEqual([])
      })
    })
  }, 60_000)
})

describe('the toolchain copy as installed', () => {
  test('installCmFixture writes the package entry cmPackage reads', async () => {
    await withSandbox(async sb => {
      const pkg: CmPackage = installCmFixture(sb)
      const { cmPackage } = await import('../../../src/engine/context-mode')
      expect(cmPackage()).toEqual(pkg)
    })
  })
})
