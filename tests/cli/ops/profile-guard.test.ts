import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { defaultConfig } from '../../../src/core/config'
import { runtimeConfigSnapshot } from '../../../src/engine/config'
import { liveHarnessDir, profileGuard } from '../../../src/workflow/session-store'
import { withEnv, withSandbox } from '../../helpers/sandbox'

const HOME = '/Users/me'
const SNAP = {
  v: 1,
  resolved: { claudeDir: `${HOME}/.claude`, codexHome: `${HOME}/.codex`, opencodeConfigDir: `${HOME}/.config/opencode`, ompAgentDir: `${HOME}/.omp/agent` },
}

describe('H17 profile.guard', () => {
  test('quiet when the live dir is the installed one (defaults or the same override)', () => {
    for (const h of ['claude', 'codex', 'opencode', 'omp'] as const) expect(profileGuard(h, SNAP, { HOME })).toBeUndefined()
    expect(profileGuard('claude', SNAP, { HOME, CLAUDE_CONFIG_DIR: `${HOME}/.claude/` })).toBeUndefined()
    expect(profileGuard('codex', { resolved: { codexHome: '/w/cx' } }, { HOME, CODEX_HOME: '/w/./cx' })).toBeUndefined()
  })

  test('warns, naming both dirs and the variable, when an override points elsewhere', () => {
    const w = profileGuard('claude', SNAP, { HOME, CLAUDE_CONFIG_DIR: '/work/profile-b' })
    expect(w).toBe('Buracle was installed for Claude Code into /Users/me/.claude, but this session reads /work/profile-b (CLAUDE_CONFIG_DIR), where Buracle\'s hooks, rules and settings are missing. Run `buracle install claude` with this environment, or start Claude Code without the override.')
    expect(profileGuard('codex', SNAP, { HOME, CODEX_HOME: '/tmp/cx' })).toContain('(CODEX_HOME)')
    expect(profileGuard('opencode', SNAP, { HOME, XDG_CONFIG_HOME: '/tmp/xdg' })).toContain('reads /tmp/xdg/opencode (XDG_CONFIG_HOME)')
    expect(profileGuard('omp', SNAP, { HOME, PI_CODING_AGENT_DIR: '/tmp/pi' })).toContain('`buracle install omp`')
    expect(profileGuard('codex', { resolved: { codexHome: '/tmp/cx' } }, { HOME })).toContain(`reads ${HOME}/.codex`)
  })

  test('says nothing when it cannot tell: no snapshot, no recorded dir, no HOME, relative overrides', () => {
    expect(profileGuard('claude', undefined, { HOME })).toBeUndefined()
    expect(profileGuard('claude', null, { HOME })).toBeUndefined()
    expect(profileGuard('claude', 'garbage', { HOME })).toBeUndefined()
    expect(profileGuard('claude', { v: 1, resolved: { repoRoot: '/r' } }, { HOME })).toBeUndefined()
    expect(profileGuard('claude', { resolved: { claudeDir: 'relative' } }, { HOME })).toBeUndefined()
    expect(profileGuard('claude', SNAP, {})).toBeUndefined()
    expect(liveHarnessDir('claude', { HOME, CLAUDE_CONFIG_DIR: 'rel/dir' })).toBe(`${HOME}/.claude`)
    expect(liveHarnessDir('opencode', { HOME, XDG_CONFIG_HOME: 'relative' })).toBe(`${HOME}/.config/opencode`)
  })

  test('the snapshot buracle install writes is what the guard reads', () => withSandbox(async ({ home, root }) => {
    await withEnv({ CODEX_HOME: join(root, 'codex-a') }, () => {
      const snap = JSON.parse(JSON.stringify(runtimeConfigSnapshot(defaultConfig()))) as unknown
      expect(profileGuard('codex', snap, { HOME: home, CODEX_HOME: join(root, 'codex-a') })).toBeUndefined()
      expect(profileGuard('codex', snap, { HOME: home })).toContain(`into ${join(root, 'codex-a')}, but this session reads ${join(home, '.codex')}`)
      expect(profileGuard('claude', snap, { HOME: home })).toBeUndefined()
    })
  }))
})
