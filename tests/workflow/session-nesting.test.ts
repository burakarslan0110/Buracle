import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Harness } from '../../src/core/events'
import {
  SESSION_ALIASES_MAX, claimedHarnesses, harnessOfProcess, harnessSessionIds, nearestHarnessAncestor, pruneSessionAliases,
  readSessionAliases, recordSessionAlias, resolveSession, sessionAliasesPath, sessionMaint, statePath, saveState, freshState,
} from '../../src/workflow/session-store'
import { withSandbox } from '../helpers/sandbox'

const nearest = (h: Harness | undefined) => ({ ancestor: () => h })

const CODEX_IN_CLAUDE = {
  BURACLE_SESSION_ID: 'claude-parent', BURACLE_HARNESS: 'claude', CLAUDE_CODE_SESSION_ID: 'claude-parent',
  CODEX_THREAD_ID: 'codex-root', CODEX_SESSION_ID: 'codex-root',
}

describe('nested harnesses: the nearest harness process decides', () => {
  test('Codex started from a Claude Code shell resolves to the Codex session, not the inherited Claude one', () => {
    expect(claimedHarnesses(CODEX_IN_CLAUDE)).toEqual(['claude', 'codex'])
    expect(resolveSession({}, CODEX_IN_CLAUDE, nearest('codex'))).toEqual({ harness: 'codex', sessionId: 'codex-root', source: 'CODEX_SESSION_ID' })
    expect(resolveSession({}, CODEX_IN_CLAUDE, nearest('claude'))).toEqual({ harness: 'claude', sessionId: 'claude-parent', source: 'BURACLE_SESSION_ID' })
  })

  test('the reviewer case: inherited BURACLE_* without CLAUDE_CODE_SESSION_ID plus a Codex thread', () => {
    const env = { BURACLE_SESSION_ID: 'claude-parent-sid', BURACLE_HARNESS: 'claude', CODEX_THREAD_ID: '019a-codex-thread' }
    expect(resolveSession({}, env, nearest('codex'))).toEqual({ harness: 'codex', sessionId: '019a-codex-thread', source: 'CODEX_THREAD_ID' })
  })

  test('the nearest harness without ids of its own means no session (never an outer one)', () => {
    expect(resolveSession({}, CODEX_IN_CLAUDE, nearest('omp'))).toBeUndefined()
    expect(resolveSession({ session: 'mine' }, CODEX_IN_CLAUDE, nearest('omp'))).toEqual({ harness: 'omp', sessionId: 'mine', source: '--session' })
  })

  test('no harness process found (no ps): the old order, BURACLE_HARNESS first', () => {
    expect(resolveSession({}, CODEX_IN_CLAUDE, nearest(undefined))).toEqual({ harness: 'claude', sessionId: 'claude-parent', source: 'BURACLE_SESSION_ID' })
    expect(resolveSession({}, { CLAUDE_CODE_SESSION_ID: 'c1', OMP_SESSION_ID: 'o1' }, nearest(undefined))).toEqual({ harness: 'claude', sessionId: 'c1', source: 'CLAUDE_CODE_SESSION_ID' })
  })

  test('a Codex BURACLE_HARNESS relabel never turns an inherited BURACLE_SESSION_ID into the Codex session', () => {
    const env = { ...CODEX_IN_CLAUDE, BURACLE_HARNESS: 'codex' }
    expect(resolveSession({}, env, nearest('codex'))).toEqual({ harness: 'codex', sessionId: 'codex-root', source: 'CODEX_SESSION_ID' })
    expect(harnessSessionIds('codex', env).map(x => x.source)).toEqual(['CODEX_SESSION_ID', 'CODEX_THREAD_ID', 'BURACLE_SESSION_ID'])
  })
})

describe('Codex subagents resolve to the root session', () => {
  test('CODEX_SESSION_ID (the root) wins over the subagent CODEX_THREAD_ID', () => {
    const env = { CODEX_THREAD_ID: '01a11983-2331-sub', CODEX_SESSION_ID: '01a11983-1dc3-root' }
    expect(resolveSession({}, env, nearest('codex'))).toEqual({ harness: 'codex', sessionId: '01a11983-1dc3-root', source: 'CODEX_SESSION_ID' })
  })

  test('without CODEX_SESSION_ID the alias map (I7) maps the thread to its root', () => withSandbox(() => {
    expect(resolveSession({}, { CODEX_THREAD_ID: 'sub-1' })).toEqual({ harness: 'codex', sessionId: 'sub-1', source: 'CODEX_THREAD_ID' })
    expect(recordSessionAlias('codex', 'sub-1', 'root-1')).toBe(true)
    expect(JSON.parse(readFileSync(sessionAliasesPath('codex'), 'utf8'))).toEqual({ 'sub-1': 'root-1' })
    expect(resolveSession({}, { CODEX_THREAD_ID: 'sub-1' })).toEqual({ harness: 'codex', sessionId: 'root-1', source: 'CODEX_THREAD_ID (aliases.json)' })
    expect(resolveSession({}, { CODEX_THREAD_ID: 'root-1' })).toEqual({ harness: 'codex', sessionId: 'root-1', source: 'CODEX_THREAD_ID' })
  }))

  test('the alias map rejects bad ids, keeps the newest entries and drops aliases of pruned sessions', () => withSandbox(() => {
    expect(recordSessionAlias('codex', '../x', 'root')).toBe(false)
    expect(recordSessionAlias('codex', 'same', 'same')).toBe(false)
    mkdirSync(dirname(sessionAliasesPath('codex')), { recursive: true })
    writeFileSync(sessionAliasesPath('codex'), JSON.stringify({ ok: 'root-a', bad: '../etc', '': 'x', num: 5 }))
    expect(readSessionAliases('codex')).toEqual({ ok: 'root-a' })
    for (let i = 0; i < SESSION_ALIASES_MAX + 5; i++) recordSessionAlias('codex', `t-${i}`, 'root-a')
    const all = readSessionAliases('codex')
    expect(Object.keys(all).length).toBe(SESSION_ALIASES_MAX)
    expect(all[`t-${SESSION_ALIASES_MAX + 4}`]).toBe('root-a')
    expect(all['ok']).toBeUndefined()
    recordSessionAlias('codex', 'keep-me', 'root-b')
    saveState('codex', 'root-b', freshState())
    expect(existsSync(statePath('codex', 'root-b'))).toBe(true)
    expect(pruneSessionAliases('codex')).toBe(SESSION_ALIASES_MAX - 1)
    expect(readSessionAliases('codex')).toEqual({ 'keep-me': 'root-b' })
    recordSessionAlias('codex', 'gone', 'root-gone')
    sessionMaint('codex', Date.now())
    expect(readSessionAliases('codex')).toEqual({ 'keep-me': 'root-b' })
  }))
})

describe('harness processes', () => {
  test('process names of the four harness CLIs, including the native Claude build and platform binaries', () => {
    expect(harnessOfProcess('claude')).toBe('claude')
    expect(harnessOfProcess('/Users/x/.local/share/claude/versions/2.1.293')).toBe('claude')
    expect(harnessOfProcess('node', 4242, { CLAUDE_PID: '4242' })).toBe('claude')
    expect(harnessOfProcess('/opt/homebrew/bin/codex')).toBe('codex')
    expect(harnessOfProcess('codex-aarch64-apple-darwin')).toBe('codex')
    expect(harnessOfProcess('/opt/homebrew/Cellar/opencode-v2/2.0.24/bin/opencode')).toBe('opencode')
    expect(harnessOfProcess('omp')).toBe('omp')
    for (const other of ['/bin/zsh', '-zsh', 'bun', 'node', 'claude-monitor', 'codexx', 'Claude', '/work/codex-tools/run']) {
      expect({ other, h: harnessOfProcess(other) }).toEqual({ other, h: undefined })
    }
  })

  test('the real walk is cheap; pid 1 has no ancestors', () => {
    const t0 = performance.now()
    nearestHarnessAncestor({}, { startPid: process.pid, maxDepth: 3 })
    expect(performance.now() - t0).toBeLessThan(500)
    expect(nearestHarnessAncestor({}, { startPid: 1 })).toBeUndefined()
  })
})
