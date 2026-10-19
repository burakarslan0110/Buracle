import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnArgv } from '../../src/engine/platform'
import { run } from '../../src/engine/proc'
import { exePath, fakeExe, IS_WINDOWS, launcherText, narrowPath, onlyPath, pathOf, systemPathDirs, unwrapCmd } from './fake-exe'
import { withEnv, withSandbox } from './sandbox'

describe('fakeExe', () => {
  test('runs its script with the arguments, the exit code and the names the preamble gives', () => withSandbox(async ({ root }) => {
    const log = join(root, 'calls.log')
    const exe = fakeExe(join(root, 'bin', 'tool'), `append(${JSON.stringify(log)}, self + ' ' + argv.join(' '))\nprocess.stdout.write('out:' + argv.length)\nprocess.stderr.write('err')\nprocess.exit(argv[0] === 'fail' ? 3 : 0)`)
    expect(exe).toBe(exePath(join(root, 'bin', 'tool')))
    expect(await run([exe, 'a b', 'c'])).toEqual({ code: 0, stdout: 'out:2', stderr: 'err', timedOut: false })
    expect((await run([exe, 'fail'])).code).toBe(3)
    expect(readFileSync(log, 'utf8')).toBe('tool a b c\ntool fail\n')
    expect(readdirSync(join(root, 'bin'))).toEqual([IS_WINDOWS ? 'tool.cmd' : 'tool'])
  }))

  test('is found by name on a PATH built with pathOf, as the product looks it up', () => withSandbox(async ({ root }) => {
    const exe = fakeExe(join(root, 'bin', 'fakeharness'), "console.log('fakeharness/9.8.7')")
    await withEnv({ PATH: narrowPath(join(root, 'bin')) }, async () => {
      expect(Bun.which('fakeharness', { PATH: process.env['PATH'] ?? '' })).toBe(exe)
      expect((await run(spawnArgv(['fakeharness', '--version']))).stdout.trim()).toBe('fakeharness/9.8.7')
    })
  }))

  test('the Windows launcher is a .cmd that runs Bun on the script with every argument and keeps the exit code', () => {
    expect(exePath('C:\\t\\bin\\npm', 'win32')).toBe('C:\\t\\bin\\npm.cmd')
    expect(exePath('/t/bin/npm', 'posix')).toBe('/t/bin/npm')
    expect(launcherText('C:\\Program Files\\bun\\bun.exe', 'C:\\t\\fake-exe\\1-npm.mjs', 'win32'))
      .toBe('@echo off\r\n"C:\\Program Files\\bun\\bun.exe" --no-env-file "C:\\t\\fake-exe\\1-npm.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n')
    expect(() => launcherText('C:\\b\\bun.exe', 'C:\\100%\\x.mjs', 'win32')).toThrow()
    expect(launcherText("/o'b/bun", '/t/x.mjs', 'posix')).toBe("#!/bin/sh\nexec '/o'\\''b/bun' --no-env-file '/t/x.mjs' \"$@\"\n")
  })

  test('the PATH helpers join with the platform delimiter and keep the system folders', () => {
    expect(pathOf('a', 'b')).toBe(IS_WINDOWS ? 'a;b' : 'a:b')
    expect(narrowPath('x')).toBe(pathOf('x', ...systemPathDirs()))
    if (IS_WINDOWS) {
      expect(systemPathDirs()[0]).toMatch(/System32$/i)
      expect(onlyPath('x')).toBe(pathOf('x', systemPathDirs()[0] as string))
    } else {
      expect(systemPathDirs()).toEqual(['/usr/bin', '/bin'])
      expect(onlyPath('x')).toBe('x')
    }
  })

  test('a narrowed PATH still finds git, as /usr/bin does on macOS and Linux', async () => {
    await withEnv({ PATH: narrowPath() }, async () => {
      expect((await run(['git', '--version'])).stdout).toMatch(/^git version /)
    })
  })
})

describe('unwrapCmd', () => {
  test('gives back the words of the line spawnArgv wraps a .cmd in on Windows', () => withEnv({ BURACLE_PLATFORM: 'win32' }, () => {
    const words = ['C:\\Program Files\\nodejs\\npm.cmd', 'install', '--prefix', 'C:\\a b\\stage', 'say "hi"', '', '50%']
    const wrapped = spawnArgv(words)
    expect(wrapped.slice(0, 4)).toEqual(['cmd.exe', '/d', '/s', '/c'])
    expect(unwrapCmd(wrapped)).toEqual(words)
  }))

  test('reads the line in either form: wrapped in one more pair of quotes (cmd /s strips them) or as it is', () => {
    const cmd = (line: string) => ['cmd.exe', '/d', '/s', '/c', line]
    expect(unwrapCmd(cmd('""C:\\x\\npm.cmd" install --prefix "C:\\a b""'))).toEqual(['C:\\x\\npm.cmd', 'install', '--prefix', 'C:\\a b'])
    expect(unwrapCmd(cmd('"C:\\x\\npm.cmd install "say ""hi""""'))).toEqual(['C:\\x\\npm.cmd', 'install', 'say "hi"'])
    expect(unwrapCmd(cmd('"C:\\Program Files\\npm.cmd" install "a b"'))).toEqual(['C:\\Program Files\\npm.cmd', 'install', 'a b'])
    expect(unwrapCmd(cmd('C:\\x\\npm.cmd install --prefix C:\\stage'))).toEqual(['C:\\x\\npm.cmd', 'install', '--prefix', 'C:\\stage'])
    expect(unwrapCmd(['C:\\Windows\\System32\\cmd.exe', '/d', '/s', '/c', '""C:\\x\\a.cmd" """'])).toEqual(['C:\\x\\a.cmd', ''])
    expect(unwrapCmd(cmd('"C:\\x\\a.cmd "50"^%"" "a"^%"b""'))).toEqual(['C:\\x\\a.cmd', '50%', 'a%b'])
  })

  test('leaves any other argv as it is', () => {
    expect(unwrapCmd(['npm', 'install', '--prefix', '/x'])).toEqual(['npm', 'install', '--prefix', '/x'])
    expect(unwrapCmd(['cmd.exe', '/c', 'dir'])).toEqual(['cmd.exe', '/c', 'dir'])
  })
})
