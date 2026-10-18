import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { selfPaths, type SelfPathsSource } from '../../../src/adapters/shared/self-paths'
import * as paths from '../../../src/engine/paths'
import { withEnv, withSandbox } from '../../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..', '..')

function checkout(dir: string): string {
  mkdirSync(join(dir, 'canonical'), { recursive: true })
  writeFileSync(join(dir, 'canonical', 'buracle.yaml'), 'version: 1\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'buracle' }))
  return dir
}

describe('selfPaths', () => {
  test('the default layout under the home folder, and the checkout these hooks run from', () => withSandbox(({ home, buracleHome }) => {
    expect(selfPaths()).toEqual({
      buracleHome, localBinDir: join(home, '.local', 'bin'), claudeDir: join(home, '.claude'), codexHome: join(home, '.codex'),
      opencodeConfigDir: join(home, '.config', 'opencode'), ompAgentDir: join(home, '.omp', 'agent'), ompHome: join(home, '.omp'), repo: REPO,
    })
    expect(selfPaths(undefined, paths)).toEqual(selfPaths())
  }))

  test('relocated roots follow the environment as it is now', () => withSandbox(({ root }) => withEnv({
    BURACLE_HOME: join(root, 'bh'), CLAUDE_CONFIG_DIR: join(root, 'cc'), CODEX_HOME: join(root, 'cx'), XDG_CONFIG_HOME: join(root, 'xdg'), PI_CODING_AGENT_DIR: join(root, 'pi'),
  }, () => {
    expect(selfPaths()).toMatchObject({
      buracleHome: join(root, 'bh'), claudeDir: join(root, 'cc'), codexHome: join(root, 'cx'), opencodeConfigDir: join(root, 'xdg', 'opencode'), ompAgentDir: join(root, 'pi'),
    })
  })))

  test('config `repo` names the installed checkout when it is one (`~` and home-relative allowed); otherwise the running checkout', () => withSandbox(({ root, home }) => {
    const other = checkout(join(home, 'src', 'buracle'))
    expect(selfPaths(other).repo).toBe(other)
    expect(selfPaths('~/src/buracle').repo).toBe(other)
    expect(selfPaths('src/buracle').repo).toBe(other)
    expect(selfPaths(join(root, 'not-a-checkout')).repo).toBe(REPO)
    expect(selfPaths('  ').repo).toBe(REPO)
  }))

  test('no checkout anywhere: no repo; a lookup that throws or answers nonsense is left out, never thrown', () => {
    const fake = (over: Partial<SelfPathsSource>): SelfPathsSource => ({
      home: () => '/h', buracleHome: () => '/h/.buracle', localBinDir: () => '/h/.local/bin', claudeDir: () => '/h/.claude', codexHome: () => '/h/.codex',
      opencodeConfigDir: () => '/h/.config/opencode', ompAgentDir: () => '/h/.omp/agent', ompHome: () => '/h/.omp', repoRoot: () => '/opt/bundle',
      isCheckout: () => false, expandHome: (p: string) => p, ...over,
    })
    expect(selfPaths(undefined, fake({})).repo).toBeUndefined()
    const broken = selfPaths(undefined, fake({ claudeDir: () => { throw new Error('EACCES') }, codexHome: () => 'relative/codex', repoRoot: () => { throw new Error('no checkout') } }))
    expect(broken).toEqual({ buracleHome: '/h/.buracle', localBinDir: '/h/.local/bin', opencodeConfigDir: '/h/.config/opencode', ompAgentDir: '/h/.omp/agent', ompHome: '/h/.omp' })
  })
})
