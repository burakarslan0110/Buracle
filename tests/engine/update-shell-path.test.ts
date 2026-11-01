import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as paths from '../../src/engine/paths'
import { addLocalBinToPath, removeLocalBinFromPath, startupFile } from '../../src/engine/update/shell-path'
import { IS_WINDOWS, KEEPS_MODES } from '../helpers/fake-exe'
import { withSandbox } from '../helpers/sandbox'

const BLOCK = '# >>> buracle >>>\nexport PATH="$HOME/.local/bin:$PATH"\n# <<< buracle <<<\n'

describe.skipIf(IS_WINDOWS)('the PATH line in the shell startup file', () => {
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

  test.skipIf(!KEEPS_MODES)('the file keeps its mode', () => withSandbox(({ home }) => {
    const rc = join(home, '.zshrc')
    writeFileSync(rc, 'x\n')
    chmodSync(rc, 0o600)
    addLocalBinToPath({ env: { SHELL: '/bin/zsh', PATH: '/usr/bin' } })
    expect(statSync(rc).mode & 0o777).toBe(0o600)
  }))

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

describe.skipIf(!IS_WINDOWS)('on Windows', () => {
  test('install.ps1 owns the user PATH, so nothing happens here', () => withSandbox(() => {
    expect(addLocalBinToPath({ env: { PATH: 'C:\\Windows' } })).toMatchObject({ changed: false, skipped: 'windows' })
  }))
})
