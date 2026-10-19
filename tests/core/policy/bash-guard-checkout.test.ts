import { describe, expect, test } from 'bun:test'
import { checkBash, type BashGuardOptions } from '../../../src/core/policy/bash-guard'

const INSTALL = "Buracle's own installation"
const SHIM = '`buracle` command on PATH'
const SOURCE = "Buracle's own source code"
const home = '/Users/me'
const repo = '/Users/me/Desktop/Buracle Plugin/buracle'

const from = (cwd: string | undefined, cmd: string): string | undefined =>
  checkBash(cmd, { extraDeny: [], home, selfPaths: { repo }, ...(cwd !== undefined ? { cwd } : {}) } as BashGuardOptions).deny

describe("checkBash: Buracle's checkout from an unrelated session", () => {
  test('shell writes, deletes, moves and permission changes in the checkout are refused', () => {
    const other = '/Users/me/code/app'
    for (const cmd of [
      `echo x > '${repo}/src/cli/main.ts'`, `cp evil.ts "${repo}/src/core/policy/bash-guard.ts"`, `rm -rf "${repo}/src"`, `rm -rf "/Users/me/Desktop/Buracle Plugin"`,
      `sed -i '' s/deny/allow/ "${repo}/src/core/policy/write-guard.ts"`, `mv "${repo}" /tmp/b`, `echo x > ~/'Desktop/Buracle Plugin/buracle/package.json'`,
      `cd "${repo}" && echo x > src/cli/main.ts`, `echo x > "../../Desktop/Buracle Plugin/buracle/src/a.ts"`, `python3 -c "open('${repo}/src/a.ts', 'w').write('x')"`,
      `ln -sf /tmp/evil "${repo}/harness/omp/extensions/buracle.js"`, `chmod -R 000 "${repo}"`, `tee "${repo}/canonical/hooks.yaml" < x`,
    ]) {
      expect({ cmd, reason: from(other, cmd) }).toEqual({ cmd, reason: expect.stringContaining(SOURCE) })
    }
  })

  test('the reason is one sentence that names the way out', () => {
    const reason = from('/Users/me/code/app', `echo x > '${repo}/src/cli/main.ts'`) as string
    expect(reason).toContain('every Buracle hook runs')
    expect(reason).toContain('a session opened in the Buracle repository')
    expect(reason).toContain('ask the user')
    expect(reason.includes('\n')).toBe(false)
    expect(reason.trim().endsWith('.')).toBe(true)
  })

  test('reads, runs and copies out of the checkout stay allowed', () => {
    for (const cmd of [`cat "${repo}/src/cli/main.ts"`, `ls "${repo}"`, `cp "${repo}/README.md" /tmp/r.md`, `git -C "${repo}" status`, `bun "${repo}/src/cli/main.ts" doctor`,
      `rg -n checkBash "${repo}/src"`, `diff "${repo}/a" /tmp/a`, `echo x > "${repo}-notes.md"`]) {
      expect({ cmd, reason: from('/Users/me/code/app', cmd) }).toEqual({ cmd, reason: undefined })
    }
  })

  test('inside the checkout, from a folder that holds it, or without a known session folder, the normal rules apply', () => {
    const write = `echo x > '${repo}/src/cli/main.ts'`
    for (const cwd of [repo, `${repo}/src`, '/Users/me/Desktop/Buracle Plugin', home, '/', undefined]) {
      expect({ cwd, reason: from(cwd, write) }).toEqual({ cwd, reason: undefined })
    }
    expect(from(repo, 'echo x > src/cli/main.ts')).toBeUndefined()
    expect(from(repo, 'rm -rf build && rm -rf node_modules')).toBeUndefined()
  })
})

describe('checkBash: relative paths resolve against the session folder', () => {
  test('like after a literal cd', () => {
    expect(from(home, 'echo {} > .claude/settings.json')).toContain('Claude Code')
    expect(from(`${home}/.buracle`, 'echo x > config.yaml')).toContain(INSTALL)
    expect(from(`${home}/.local/bin`, 'rm buracle')).toContain(SHIM)
    expect(from(home, 'rm -rf Library')).toContain('home folder')
    expect(from('/', 'rm -rf usr')).toContain('/usr')
    expect(from(`${home}/code/app`, 'echo x > .claude/settings.json')).toContain('switch off plugins and hooks')
    expect(from(`${home}/code/app`, 'rm -rf Library build node_modules')).toBeUndefined()
  })

  test('a later cd moves away from it, an unknown cd forgets it, and a relative session folder is ignored', () => {
    expect(from(`${home}/code/app`, 'cd ~ && echo {} > .claude/settings.json')).toContain('Claude Code')
    expect(from(home, 'cd "$DIR" && echo {} > .claude/settings.json')).toBeUndefined()
    expect(from('code/app', 'echo {} > .claude/settings.json')).toBeUndefined()
  })
})

describe('checkBash: relocated roots spelled through the home folder', () => {
  test('~ and $HOME reach a relocated root under the home folder when the guard knows it', () => {
    const opts: BashGuardOptions = { extraDeny: [], home, selfPaths: { claudeDir: `${home}/.config/claude`, buracleHome: `${home}/tools/buracle` } }
    expect(checkBash('echo {} > ~/.config/claude/settings.json', opts).deny).toContain('Claude Code')
    expect(checkBash('rm "$HOME/tools/buracle/bin/buracle"', opts).deny).toContain(INSTALL)
    expect(checkBash('echo x > ~/.config/claude/CLAUDE.md', opts)).toEqual({})
    expect(checkBash('echo {} > ~/.config/claude/settings.json', { extraDeny: [], selfPaths: { claudeDir: `${home}/.config/claude` } } as BashGuardOptions)).toEqual({})
  })
})
