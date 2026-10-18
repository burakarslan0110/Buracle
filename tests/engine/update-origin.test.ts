import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectOrigin, harnessUpdate, resolveBinary } from '../../src/engine/update/origin'
import { withSandbox } from '../helpers/sandbox'

describe('detectOrigin', () => {
  test('Homebrew formulae and casks by their Cellar or Caskroom folder', () => {
    expect(detectOrigin('/opt/homebrew/Cellar/omp/18.12.1/bin/omp')).toEqual({ method: 'brew-formula', name: 'omp' })
    expect(detectOrigin('/opt/homebrew/Cellar/opencode-v2/2.0.30/bin/opencode')).toEqual({ method: 'brew-formula', name: 'opencode-v2' })
    expect(detectOrigin('/opt/homebrew/Caskroom/codex/0.163.0/bin/codex')).toEqual({ method: 'brew-cask', name: 'codex' })
    expect(detectOrigin('/home/linuxbrew/.linuxbrew/Cellar/ripgrep/14.1.1/bin/rg')).toEqual({ method: 'brew-formula', name: 'ripgrep' })
    expect(detectOrigin('/Users/a b/brew/Caskroom/claude-code/2.1.302/claude')).toEqual({ method: 'brew-cask', name: 'claude-code' })
  })

  test('npm and bun global packages, scoped names and the npm prefix', () => {
    expect(detectOrigin('/usr/local/lib/node_modules/@openai/codex/bin/codex.js')).toEqual({ method: 'npm', name: '@openai/codex', prefix: '/usr/local' })
    expect(detectOrigin('/Users/a b/.nvm/versions/node/v24.1.0/lib/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js'))
      .toEqual({ method: 'npm', name: '@oh-my-pi/pi-coding-agent', prefix: '/Users/a b/.nvm/versions/node/v24.1.0' })
    expect(detectOrigin('C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js'))
      .toEqual({ method: 'npm', name: '@openai/codex', prefix: 'C:\\Users\\a\\AppData\\Roaming\\npm' })
    expect(detectOrigin('/Users/a/.bun/install/global/node_modules/@anthropic-ai/claude-code/cli.js')).toEqual({ method: 'bun', name: '@anthropic-ai/claude-code' })
  })

  test('the Claude Code native installer and everything else', () => {
    expect(detectOrigin('/Users/a/.local/share/claude/versions/2.1.302')).toEqual({ method: 'native' })
    expect(detectOrigin('C:\\Users\\a\\.local\\share\\claude\\versions\\2.1.302\\claude.exe')).toEqual({ method: 'native' })
    expect(detectOrigin('/usr/local/bin/omp')).toEqual({ method: 'unknown' })
    expect(detectOrigin('')).toEqual({ method: 'unknown' })
  })

  test('names that would reach a command as an option or a path are refused', () => {
    expect(detectOrigin('/opt/homebrew/Cellar/--greedy/1.0/bin/codex')).toEqual({ method: 'unknown' })
    expect(detectOrigin('/opt/homebrew/Caskroom/Codex/1.0/bin/codex')).toEqual({ method: 'unknown' })
    expect(detectOrigin('/usr/local/lib/node_modules/--registry=http:/x/bin/x.js')).toEqual({ method: 'unknown' })
    expect(detectOrigin('/usr/local/lib/node_modules/@scope/../x/bin/x.js')).toEqual({ method: 'unknown' })
  })
})

describe('resolveBinary', () => {
  test('follows the PATH link to the real file; a dangling or missing link is undefined', () => withSandbox(({ root }) => {
    const real = join(root, 'Caskroom', 'codex', '0.1.0', 'bin', 'codex')
    mkdirSync(join(real, '..'), { recursive: true })
    writeFileSync(real, '#!/bin/sh\n')
    mkdirSync(join(root, 'bin'))
    symlinkSync(join('..', 'Caskroom', 'codex', '0.1.0', 'bin', 'codex'), join(root, 'bin', 'codex'))
    symlinkSync(join(root, 'nowhere'), join(root, 'bin', 'gone'))
    const resolved = resolveBinary(join(root, 'bin', 'codex'))
    expect(resolved).toBeDefined()
    expect(detectOrigin(resolved as string)).toEqual({ method: 'brew-cask', name: 'codex' })
    expect(resolveBinary(join(root, 'bin', 'gone'))).toBeUndefined()
    expect(resolveBinary(undefined)).toBeUndefined()
  }))
})

describe('harnessUpdate', () => {
  test('each install method gets the command of the installer that installed it', () => {
    expect(harnessUpdate('omp', { method: 'brew-formula', name: 'omp' }, '18.13.0')).toEqual({ action: 'brew-upgrade', command: ['brew', 'upgrade', 'omp'], source: 'Homebrew formula omp', measure: 'latest' })
    expect(harnessUpdate('codex', { method: 'brew-cask', name: 'codex' }, '0.165.0')).toEqual({ action: 'brew-upgrade', command: ['brew', 'upgrade', '--cask', 'codex'], source: 'Homebrew cask codex', measure: 'latest' })
    expect(harnessUpdate('codex', { method: 'npm', name: '@openai/codex', prefix: '/usr/local' }, '0.165.0'))
      .toEqual({ action: 'npm-install', command: ['npm', 'install', '-g', '--prefix', '/usr/local', '@openai/codex@0.165.0'], source: 'npm @openai/codex', measure: 'latest' })
    expect(harnessUpdate('claude', { method: 'bun', name: '@anthropic-ai/claude-code' }, '2.1.305'))
      .toEqual({ action: 'bun-add', command: ['bun', 'add', '-g', '@anthropic-ai/claude-code@2.1.305'], source: 'bun @anthropic-ai/claude-code', measure: 'latest' })
    expect(harnessUpdate('claude', { method: 'native' }, '2.1.305')).toEqual({ action: 'self-update', command: ['claude', 'update'], source: 'native installer', measure: 'increase' })
    expect(harnessUpdate('opencode', { method: 'unknown' }, '2.0.31')).toEqual({ action: 'self-update', command: ['opencode', 'upgrade'], source: 'its own updater (opencode upgrade)', measure: 'increase' })
    expect(harnessUpdate('omp', { method: 'unknown' }, '18.13.0')).toMatchObject({ command: ['omp', 'update'] })
    expect(harnessUpdate('codex', { method: 'unknown' }, '0.165.0')).toMatchObject({ command: ['codex', 'update'] })
  })

  test('an npm package that is not the harness\'s own falls back to its own updater', () => {
    expect(harnessUpdate('codex', { method: 'npm', name: 'evil-codex', prefix: '/usr/local' }, '0.165.0')).toMatchObject({ action: 'self-update', command: ['codex', 'update'] })
    expect(harnessUpdate('opencode', { method: 'bun', name: 'opencode-ai' }, '2.0.31')).toMatchObject({ action: 'self-update', command: ['opencode', 'upgrade'] })
  })

  test('a version that is not a plain release never reaches npm or bun', () => {
    for (const bad of ['--registry=http://x', '../x', '1.2.3 && rm', 'latest', '1.2']) {
      expect(harnessUpdate('codex', { method: 'npm', name: '@openai/codex', prefix: '/usr/local' }, bad)).toEqual({ error: `refusing version ${JSON.stringify(bad)}: not a release version` })
      expect(harnessUpdate('claude', { method: 'bun', name: '@anthropic-ai/claude-code' }, bad)).toMatchObject({ error: expect.stringContaining('not a release version') })
    }
    expect(harnessUpdate('codex', { method: 'npm', name: '@openai/codex', prefix: '/usr/local' }, '0.166.0-alpha.1')).toMatchObject({ command: ['npm', 'install', '-g', '--prefix', '/usr/local', '@openai/codex@0.166.0-alpha.1'] })
  })
})
