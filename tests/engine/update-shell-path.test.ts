import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import * as paths from '../../src/engine/paths'
import { addLocalBinToOtherShells, addLocalBinToPath, probeLoginPath, removeLocalBinFromPath, startupFile } from '../../src/engine/update/shell-path'

import { withSandbox } from '../helpers/sandbox'

const BLOCK = '# >>> buracle >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< buracle <<<\n'

describe('the PATH line in the shell startup file', () => {
  test('the startup file follows the shell', () => {
    const home = '/h'
    expect(startupFile({ SHELL: '/bin/zsh' }, 'darwin', home)).toBe('/h/.zshrc')
    expect(startupFile({ SHELL: '/bin/zsh', ZDOTDIR: '/h/.config/zsh' }, 'linux', home)).toBe('/h/.config/zsh/.zshrc')
    expect(startupFile({ SHELL: '/bin/bash' }, 'linux', home)).toBe('/h/.bashrc')
    expect(startupFile({ SHELL: '/bin/bash' }, 'darwin', home)).toBe('/h/.bash_profile')
    expect(startupFile({ SHELL: '/usr/bin/fish' }, 'linux', home)).toBe('/h/.config/fish/config.fish')
    expect(startupFile({ SHELL: '/bin/ksh' }, 'linux', home)).toBe('/h/.profile')
    expect(startupFile({}, 'linux', home)).toBe('/h/.profile')
  })

  test('bash on macOS: the first login file that exists gets the block, so a new ~/.bash_profile never hides ~/.profile', () => withSandbox(({ home }) => {
    const env = { SHELL: '/bin/bash', PATH: '/usr/bin:/bin' }
    writeFileSync(join(home, '.profile'), 'export EDITOR=vi\n')
    expect(startupFile(env, 'darwin', home)).toBe(join(home, '.profile'))
    expect(addLocalBinToPath({ env, os: 'darwin' })).toEqual({ changed: true, file: join(home, '.profile') })
    expect(existsSync(join(home, '.bash_profile'))).toBe(false)
    writeFileSync(join(home, '.bash_login'), '')
    expect(startupFile(env, 'darwin', home)).toBe(join(home, '.bash_login'))
    writeFileSync(join(home, '.bash_profile'), '')
    expect(startupFile(env, 'darwin', home)).toBe(join(home, '.bash_profile'))
  }))

  test('a block whose record is gone (a wiped ~/.buracle) gets its record back, so uninstall still finds it', () => withSandbox(({ home }) => {
    const rc = join(home, '.zshrc')
    const env = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }
    expect(addLocalBinToPath({ env })).toEqual({ changed: true, file: rc })
    rmSync(paths.shellPathStateFile())
    expect(addLocalBinToPath({ env })).toMatchObject({ changed: false, skipped: 'in-file' })
    expect(JSON.parse(readFileSync(paths.shellPathStateFile(), 'utf8'))).toMatchObject({ v: 1, file: rc })
    expect(removeLocalBinFromPath()).toEqual({ removed: true, file: rc })
    expect(readFileSync(rc, 'utf8')).toBe('')
  }))

  test('zsh: one block is added once, after what the file holds; a second run changes nothing', () => withSandbox(({ home }) => {
    const rc = join(home, '.zshrc')
    writeFileSync(rc, 'alias ll="ls -l"')
    const env = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }
    expect(addLocalBinToPath({ env })).toEqual({ changed: true, file: rc })
    expect(readFileSync(rc, 'utf8')).toBe(`alias ll="ls -l"\n${BLOCK}`)
    expect(addLocalBinToPath({ env })).toMatchObject({ changed: false, skipped: 'in-file' })
    expect(readFileSync(rc, 'utf8')).toBe(`alias ll="ls -l"\n${BLOCK}`)
    expect(JSON.parse(readFileSync(paths.shellPathStateFile(), 'utf8'))).toMatchObject({ v: 1, file: rc })
  }))

  test('fish gets fish_add_path; the folder of its config is created', () => withSandbox(({ home }) => {
    const rc = join(home, '.config', 'fish', 'config.fish')
    expect(addLocalBinToPath({ env: { SHELL: '/usr/local/bin/fish', PATH: '/usr/bin' } })).toEqual({ changed: true, file: rc })
    expect(readFileSync(rc, 'utf8')).toBe('# >>> buracle >>>\nfish_add_path "$HOME/.local/bin"\n# <<< buracle <<<\n')
  }))

  test('nothing changes when PATH already has ~/.local/bin, or the file already puts it on PATH', () => withSandbox(({ home }) => {
    const rc = join(home, '.bashrc')
    expect(addLocalBinToPath({ env: { SHELL: '/bin/bash', PATH: `/usr/bin:${join(home, '.local', 'bin')}` }, os: 'linux' })).toMatchObject({ changed: false, skipped: 'on-path' })
    expect(existsSync(rc)).toBe(false)
    writeFileSync(rc, 'export PATH=$PATH:~/.local/bin\n')
    expect(addLocalBinToPath({ env: { SHELL: '/bin/bash', PATH: '/usr/bin' }, os: 'linux' })).toMatchObject({ changed: false, skipped: 'in-file' })
    expect(readFileSync(rc, 'utf8')).toBe('export PATH=$PATH:~/.local/bin\n')
  }))

  test('a broken link or a link out of the home folder is never written through', () => withSandbox(({ home, root }) => {
    const rc = join(home, '.zshrc')
    symlinkSync(join(home, 'gone'), rc)
    const broken = addLocalBinToPath({ env: { SHELL: '/bin/zsh', PATH: '/usr/bin' } })
    expect(broken).toMatchObject({ changed: false, skipped: 'unsafe' })
    expect(broken.reason).toContain('broken')
    const outside = join(root, 'dotfiles', 'zshrc')
    mkdirSync(join(root, 'dotfiles'), { recursive: true })
    writeFileSync(outside, '# mine\n')
    const rc2 = join(home, '.bashrc')
    symlinkSync(outside, rc2)
    const r = addLocalBinToPath({ env: { SHELL: '/bin/bash', PATH: '/usr/bin' }, os: 'linux' })
    expect(r).toMatchObject({ changed: false, skipped: 'unsafe' })
    expect(r.reason).toContain('outside your home folder')
    expect(readFileSync(outside, 'utf8')).toBe('# mine\n')
  }))

  test('the file keeps its mode', () => withSandbox(({ home }) => {
    const rc = join(home, '.zshrc')
    writeFileSync(rc, 'x\n')
    chmodSync(rc, 0o600)
    addLocalBinToPath({ env: { SHELL: '/bin/zsh', PATH: '/usr/bin' } })
    expect(statSync(rc).mode & 0o777).toBe(0o600)
  }))

  // A terminal opened in bash (or zsh) never reads the startup file of the other one. The install ran in zsh, put
  // ~/.local/bin on PATH there, and `omp`, `codex`, `claude` and `buracle` were "command not found" in a bash terminal.
  describe('the other shell', () => {
    const localBin = (home: string): string => join(home, '.local', 'bin')
    const answers = (paths: Partial<Record<'zsh' | 'bash', string>>) => (shell: 'zsh' | 'bash'): string | undefined => paths[shell]

    test('a shell other than $SHELL whose fresh login PATH lacks ~/.local/bin gets the block in its own startup file; a second run and uninstall are exact', () => withSandbox(({ home }) => {
      const env = { SHELL: '/bin/zsh', PATH: `/usr/bin:${localBin(home)}` }
      const probe = answers({ bash: '/usr/bin:/bin' })
      const bp = join(home, '.bash_profile')
      expect(addLocalBinToOtherShells({ env, os: 'darwin', probe })).toEqual([{ changed: true, file: bp }])
      expect(readFileSync(bp, 'utf8')).toBe(BLOCK)
      expect(addLocalBinToOtherShells({ env, os: 'darwin', probe })).toEqual([{ changed: false, file: bp, skipped: 'in-file' }])
      expect(readFileSync(bp, 'utf8')).toBe(BLOCK)
      // The zsh file is the install's own business (addLocalBinToPath); here it is not touched.
      expect(existsSync(join(home, '.zshrc'))).toBe(false)
      expect(removeLocalBinFromPath()).toEqual({ removed: true, file: bp })
      expect(readFileSync(bp, 'utf8')).toBe('')
      expect(existsSync(paths.shellPathStateFile())).toBe(false)
    }))

    test('a shell that is not installed, or whose login PATH already has the folder, is left alone', () => withSandbox(({ home }) => {
      const env = { SHELL: '/bin/zsh', PATH: '/usr/bin' }
      expect(addLocalBinToOtherShells({ env, os: 'linux', probe: answers({}) })).toEqual([])
      expect(addLocalBinToOtherShells({ env, os: 'linux', probe: answers({ bash: `/usr/bin:${localBin(home)}` }) })).toEqual([{ changed: false, file: join(home, '.bashrc'), skipped: 'on-path' }])
      expect(existsSync(join(home, '.bashrc'))).toBe(false)
    }))

    test('the probe (a login shell that reads the whole rc file) runs only when a block would be written, not on every install', () => withSandbox(({ home }) => {
      const env = { SHELL: '/bin/zsh', PATH: '/usr/bin' }
      const asked: string[] = []
      const probe = (shell: 'zsh' | 'bash'): string | undefined => { asked.push(shell); return '/usr/bin' }
      const bp = join(home, '.bash_profile')
      writeFileSync(bp, `alias ll="ls -l"\n${BLOCK}`)
      expect(addLocalBinToOtherShells({ env, os: 'darwin', probe })).toEqual([{ changed: false, file: bp, skipped: 'in-file' }])
      // The record of a block whose record is gone comes back without asking a shell either.
      expect(JSON.parse(readFileSync(paths.shellPathStateFile(), 'utf8'))).toMatchObject({ v: 1, file: bp })
      writeFileSync(bp, 'export PATH="$HOME/.local/bin:$PATH"\n')
      expect(addLocalBinToOtherShells({ env, os: 'darwin', probe })).toEqual([{ changed: false, file: bp, skipped: 'in-file' }])
      expect(asked).toEqual([])
      // With no block and no PATH line in the file, the shell is asked.
      writeFileSync(bp, '# nothing\n')
      addLocalBinToOtherShells({ env, os: 'darwin', probe })
      expect(asked).toEqual(['bash'])
    }))

    test('a state record from an earlier Buracle ({v:1,file} alone) still finds and removes its block', () => withSandbox(({ home }) => {
      const rc = join(home, '.zshrc')
      writeFileSync(rc, `export A=1\n${BLOCK}`)
      mkdirSync(dirname(paths.shellPathStateFile()), { recursive: true })
      writeFileSync(paths.shellPathStateFile(), JSON.stringify({ v: 1, file: rc }) + '\n')
      expect(removeLocalBinFromPath()).toEqual({ removed: true, file: rc })
      expect(readFileSync(rc, 'utf8')).toBe('export A=1\n')
      expect(existsSync(paths.shellPathStateFile())).toBe(false)
    }))

    test('both blocks are recorded: removal takes out the one of $SHELL and the one of the other shell', () => withSandbox(({ home }) => {
      const rc = join(home, '.zshrc')
      const bp = join(home, '.bash_profile')
      const env = { SHELL: '/bin/zsh', PATH: '/usr/bin:/bin' }
      expect(addLocalBinToPath({ env, os: 'darwin' })).toEqual({ changed: true, file: rc })
      expect(addLocalBinToOtherShells({ env, os: 'darwin', probe: answers({ bash: '/usr/bin' }) })).toEqual([{ changed: true, file: bp }])
      expect(JSON.parse(readFileSync(paths.shellPathStateFile(), 'utf8'))).toEqual({ v: 1, file: rc, others: [bp] })
      expect(removeLocalBinFromPath()).toEqual({ removed: true, file: rc, also: [bp] })
      expect([readFileSync(rc, 'utf8'), readFileSync(bp, 'utf8')]).toEqual(['', ''])
    }))

    test.skipIf(Bun.which('bash') === null)('the real probe asks a clean login shell for its PATH', () => withSandbox(({ home }) => {
      const got = probeLoginPath('bash', home)
      expect(got).toContain('/usr/bin')
      expect(got).not.toContain(join(home, '.local', 'bin'))
      writeFileSync(join(home, '.bash_profile'), 'export PATH="$HOME/.local/bin:$PATH"\n')
      expect(probeLoginPath('bash', home)).toContain(join(home, '.local', 'bin'))
    }))
  })

  test('removal takes out exactly the block, keeps every other line and the last newline; an unmatched marker is left alone', () => withSandbox(({ home }) => {
    const rc = join(home, '.zshrc')
    writeFileSync(rc, 'a\r\nb\n')
    addLocalBinToPath({ env: { SHELL: '/bin/zsh', PATH: '/usr/bin' } })
    writeFileSync(rc, readFileSync(rc, 'utf8') + 'c\n')
    expect(removeLocalBinFromPath()).toMatchObject({ removed: true, file: rc })
    expect(readFileSync(rc, 'utf8')).toBe('a\r\nb\nc\n')
    expect(existsSync(paths.shellPathStateFile())).toBe(false)

    addLocalBinToPath({ env: { SHELL: '/bin/zsh', PATH: '/usr/bin' } })
    writeFileSync(rc, readFileSync(rc, 'utf8').replace('# <<< buracle <<<\n', ''))
    const before = readFileSync(rc, 'utf8')
    const r = removeLocalBinFromPath()
    expect(r).toMatchObject({ removed: false, file: rc })
    expect(r.note).toContain('# >>> buracle >>>')
    expect(readFileSync(rc, 'utf8')).toBe(before)
    rmSync(paths.shellPathStateFile())
    expect(removeLocalBinFromPath()).toEqual({ removed: false })
  }))
})
