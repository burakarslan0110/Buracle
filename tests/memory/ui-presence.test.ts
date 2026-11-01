import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as paths from '../../src/engine/paths'
import { openSessionCount, sessionClosed, sessionOpened, sessionSeen, startUiSoon, UI_SESSION_STALE_MS } from '../../src/memory/ui-presence'
import { withEnv, withSandbox } from '../helpers/sandbox'

// The preload sets BURACLE_NO_AUTOSTART=1 for every test; these tests exercise the autostart itself.
const live = { BURACLE_NO_AUTOSTART: undefined, BURACLE_MEMORY_RUNNER: undefined }
const it = (name: string, fn: () => unknown): void => {
  test(name, () => withSandbox(() => withEnv(live, fn)))
}

function age(file: string, ms: number): void {
  const t = new Date(Date.now() - ms)
  utimesSync(file, t, t)
}

function spawner(): { spawn: (args: readonly string[]) => number | undefined, calls: string[][] } {
  const calls: string[][] = []
  return { calls, spawn: args => { calls.push([...args]); return 4242 } }
}

/** A UI record whose pid is this test process, so it reads as alive. */
function liveRecord(build = 'b1'): void {
  mkdirSync(paths.stateDir(), { recursive: true })
  writeFileSync(paths.memoryUiStateFile(), JSON.stringify({ v: 1, pid: process.pid, port: 41777, host: '127.0.0.1', url: 'http://127.0.0.1:41777', startedAt: 't', version: '0', build, brain: '' }))
}

describe('the session presence the memory UI counts', () => {
  it('opened writes one record, closed removes it, the count skips stale ones and bad ids', () => {
    sessionOpened('claude', 's1')
    sessionOpened('codex', 's2')
    sessionOpened('claude', '../escape')
    expect(readdirSync(paths.uiSessionsDir()).sort()).toEqual(['claude-s1', 'codex-s2'])
    expect(openSessionCount(Date.now())).toBe(2)
    age(join(paths.uiSessionsDir(), 'codex-s2'), UI_SESSION_STALE_MS + 1000)
    expect(openSessionCount(Date.now())).toBe(1)
    // A stale record belongs to a harness that was killed: the count removes it, so they do not pile up.
    expect(existsSync(join(paths.uiSessionsDir(), 'codex-s2'))).toBe(false)
    sessionClosed('claude', 's1')
    expect(openSessionCount(Date.now())).toBe(0)
    expect(existsSync(join(paths.uiSessionsDir(), 'claude-s1'))).toBe(false)
  })

  it('seen refreshes a record at most every 10 minutes and says when the session had counted as ended', () => {
    expect(sessionSeen('omp', 's1', Date.now())).toBe('revived')
    const file = join(paths.uiSessionsDir(), 'omp-s1')
    expect(sessionSeen('omp', 's1', Date.now())).toBe('fresh')
    // A three-hour session with only tool calls stays open: each call past ten minutes refreshes the record.
    for (let i = 0; i < 18; i++) {
      age(file, 10 * 60_000 + 1)
      expect(sessionSeen('omp', 's1', Date.now())).toBe('fresh')
      expect(openSessionCount(Date.now())).toBe(1)
    }
    age(file, UI_SESSION_STALE_MS + 1)
    expect(sessionSeen('omp', 's1', Date.now())).toBe('revived')
  })

  it('a memory-runner child or BURACLE_NO_AUTOSTART writes nothing', async () => {
    await withEnv({ BURACLE_MEMORY_RUNNER: '1' }, () => {
      sessionOpened('claude', 'r1')
      expect(sessionSeen('claude', 'r1', Date.now())).toBe('fresh')
    })
    await withEnv({ BURACLE_NO_AUTOSTART: '1' }, () => { sessionOpened('claude', 'r2') })
    expect(openSessionCount(Date.now())).toBe(0)
  })
})

describe('starting the UI from a hook', () => {
  it('a live UI starts nothing; none starts one detached `mem ui --serve`, without waiting', () => {
    const s = spawner()
    liveRecord()
    expect(startUiSoon({ spawn: s.spawn, autostart: true })).toBe('running')
    expect(s.calls).toEqual([])
    writeFileSync(paths.memoryUiStateFile(), '{}\n')
    expect(startUiSoon({ spawn: s.spawn, autostart: true })).toBe('started')
    expect(s.calls).toEqual([['mem', 'ui', '--serve']])
  })

  it('two hooks at once start one UI; a start marker older than 15 s is stale', () => {
    const s = spawner()
    expect([startUiSoon({ spawn: s.spawn, autostart: true }), startUiSoon({ spawn: s.spawn, autostart: true })]).toEqual(['started', 'busy'])
    expect(s.calls).toHaveLength(1)
    age(paths.memoryUiSpawnMarker(), 16_000)
    expect(startUiSoon({ spawn: s.spawn, autostart: true })).toBe('started')
    expect(s.calls).toHaveLength(2)
  })

  it('at a session start a UI of another build is replaced (the new server stops it); otherwise it stays', () => {
    const s = spawner()
    liveRecord('old-build')
    expect(startUiSoon({ spawn: s.spawn, autostart: true, build: 'new-build' })).toBe('started')
    age(paths.memoryUiSpawnMarker(), 16_000)
    expect(startUiSoon({ spawn: s.spawn, autostart: true })).toBe('running')
    expect(startUiSoon({ spawn: s.spawn, autostart: true, build: 'old-build' })).toBe('running')
    expect(s.calls).toHaveLength(1)
  })

  it('autostart off, BURACLE_NO_AUTOSTART or a memory-runner child: nothing starts', async () => {
    const s = spawner()
    expect(startUiSoon({ spawn: s.spawn, autostart: false })).toBe('off')
    await withEnv({ BURACLE_NO_AUTOSTART: '1' }, () => { expect(startUiSoon({ spawn: s.spawn, autostart: true })).toBe('off') })
    await withEnv({ BURACLE_MEMORY_RUNNER: '1' }, () => { expect(startUiSoon({ spawn: s.spawn, autostart: true })).toBe('off') })
    expect(s.calls).toEqual([])
  })

  it('the setting is read from config.yaml when not given', () => {
    const s = spawner()
    mkdirSync(paths.buracleHome(), { recursive: true })
    writeFileSync(paths.userConfigFile(), 'memory:\n  ui:\n    autostart: false\n')
    expect(startUiSoon({ spawn: s.spawn })).toBe('off')
    writeFileSync(paths.userConfigFile(), 'memory:\n  ui:\n    autostart: true\n')
    expect(startUiSoon({ spawn: s.spawn })).toBe('started')
  })

  it('a spawn that fails or throws is reported, never thrown, and frees the marker', () => {
    expect(startUiSoon({ spawn: () => undefined, autostart: true })).toBe('failed')
    expect(existsSync(paths.memoryUiSpawnMarker())).toBe(false)
    expect(startUiSoon({ spawn: () => { throw new Error('EAGAIN') }, autostart: true })).toBe('failed')
    expect(existsSync(paths.memoryUiSpawnMarker())).toBe(false)
  })
})
