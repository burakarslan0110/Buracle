import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from '../../src/engine/proc'
import { fakeExe, launcherText, narrowPath, onlyPath, pathOf, SYSTEM_PATH_DIRS } from './fake-exe'
import { withEnv, withSandbox } from './sandbox'

describe('fakeExe', () => {
  test('runs its script with the arguments, the exit code and the names the preamble gives', () => withSandbox(async ({ root }) => {
    const log = join(root, 'calls.log')
    const exe = fakeExe(join(root, 'bin', 'tool'), `append(${JSON.stringify(log)}, self + ' ' + argv.join(' '))\nprocess.stdout.write('out:' + argv.length)\nprocess.stderr.write('err')\nprocess.exit(argv[0] === 'fail' ? 3 : 0)`)
    expect(exe).toBe(join(root, 'bin', 'tool'))
    expect(await run([exe, 'a b', 'c'])).toEqual({ code: 0, stdout: 'out:2', stderr: 'err', timedOut: false })
    expect((await run([exe, 'fail'])).code).toBe(3)
    expect(readFileSync(log, 'utf8')).toBe('tool a b c\ntool fail\n')
    expect(readdirSync(join(root, 'bin'))).toEqual(['tool'])
  }))

  test('is found by name on a PATH built with pathOf, as the product looks it up', () => withSandbox(async ({ root }) => {
    const exe = fakeExe(join(root, 'bin', 'fakeharness'), "console.log('fakeharness/9.8.7')")
    await withEnv({ PATH: narrowPath(join(root, 'bin')) }, async () => {
      expect(Bun.which('fakeharness', { PATH: process.env['PATH'] ?? '' })).toBe(exe)
      expect((await run(['fakeharness', '--version'])).stdout.trim()).toBe('fakeharness/9.8.7')
    })
  }))

  test('the launcher is an sh script that execs Bun on the script with every argument', () => {
    expect(launcherText("/o'b/bun", '/t/x.mjs')).toBe("#!/bin/sh\nexec '/o'\\''b/bun' --no-env-file '/t/x.mjs' \"$@\"\n")
  })

  test('the PATH helpers join with a colon and keep the system folders', () => {
    expect(pathOf('a', 'b')).toBe('a:b')
    expect(narrowPath('x')).toBe(pathOf('x', ...SYSTEM_PATH_DIRS))
    expect(SYSTEM_PATH_DIRS).toEqual(['/usr/bin', '/bin'])
    expect(onlyPath('x')).toBe('x')
  })

  test('a narrowed PATH still finds git, as /usr/bin does on macOS and Linux', async () => {
    await withEnv({ PATH: narrowPath() }, async () => {
      expect((await run(['git', '--version'])).stdout).toMatch(/^git version /)
    })
  })
})
