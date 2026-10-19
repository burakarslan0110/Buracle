import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectBinary, parseVersion, run, which } from '../../src/engine/proc'
import { fakeExe, narrowPath } from '../helpers/fake-exe'
import { withEnv, withSandbox } from '../helpers/sandbox'

describe('proc.run', () => {
  test('captures stdout, stderr and the exit code without a shell', async () => {
    const r = await run(['sh', '-c', 'echo out; echo err >&2; exit 3'])
    expect(r).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n', timedOut: false })
    const literal = await run([process.execPath, '-e', "process.stdout.write(process.argv.slice(1).join(' ') + '\\n')", '$HOME', '*'])
    expect(literal.stdout).toBe('$HOME *\n')
  })

  test('feeds stdin', async () => {
    expect((await run(['cat'], { stdin: 'piped text' })).stdout).toBe('piped text')
    expect((await run(['wc', '-c'], { stdin: new Uint8Array([1, 2, 3]) })).stdout.trim()).toBe('3')
  })

  test('cwd and env (undefined removes a variable)', () => withSandbox(async ({ root }) => {
    expect((await run([process.execPath, '-e', 'process.stdout.write(process.cwd())'], { cwd: root })).stdout).toBe(root)
    const r = await withEnv({ BURACLE_PROC_TEST: 'inherited' }, () => run(['sh', '-c', 'echo "$BURACLE_PROC_TEST/$EXTRA"'], { env: { EXTRA: 'x' } }))
    expect(r.stdout).toBe('inherited/x\n')
    const removed = await withEnv({ BURACLE_PROC_TEST: 'inherited' }, () => run(['sh', '-c', 'echo "[${BURACLE_PROC_TEST-unset}]"'], { env: { BURACLE_PROC_TEST: undefined } }))
    expect(removed.stdout).toBe('[unset]\n')
  }))

  test('missing executables return 127 instead of throwing', async () => {
    const r = await run(['definitely-not-a-real-binary-xyz'])
    expect(r.code).toBe(127)
    expect(r.timedOut).toBe(false)
    expect((await run([])).code).toBe(127)
  })

  test('timeouts kill the process', async () => {
    const t0 = Date.now()
    const r = await run(['sleep', '5'], { timeoutMs: 150 })
    expect(r.timedOut).toBe(true)
    expect(r.code).toBe(124)
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  test('orphaned grandchildren holding the pipe do not hang the call', async () => {
    const t0 = Date.now()
    const r = await run(['sh', '-c', '(sleep 5 &) ; echo done'], { timeoutMs: 4000 })
    expect(r.stdout).toContain('done')
    expect(Date.now() - t0).toBeLessThan(3000)
  })

  test.skipIf(process.platform === 'win32')('processGroup: a timeout also stops the children the process started', async () => {
    const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
    const r = await run(['sh', '-c', 'sleep 30 & echo $!; wait'], { timeoutMs: 300, processGroup: true })
    const child = Number(r.stdout.trim())
    expect(r.timedOut).toBe(true)
    expect(Number.isInteger(child) && child > 0).toBe(true)
    try {
      for (let i = 0; i < 40 && alive(child); i++) await Bun.sleep(50)
      expect(alive(child)).toBe(false)
    } finally {
      if (alive(child)) process.kill(child, 'SIGKILL')
    }
  })
})

describe('proc.run on Windows', () => {
  async function spawnedBy(argv: string[], env: Record<string, string> = {}): Promise<{ argv: string[], verbatim: unknown }> {
    const original = Bun.spawn
    let seen: { argv: string[], verbatim: unknown } | undefined
    Bun.spawn = ((cmd: string[], o: { windowsVerbatimArguments?: boolean }) => {
      seen = { argv: cmd, verbatim: o.windowsVerbatimArguments }
      throw new Error('not spawned in this test')
    }) as unknown as typeof Bun.spawn
    try {
      expect((await withEnv({ BURACLE_PLATFORM: 'win32' }, () => run(argv, { env }))).code).toBe(127)
    } finally {
      Bun.spawn = original
    }
    if (seen === undefined) throw new Error('Bun.spawn was not called')
    return seen
  }

  test('an npm .cmd shim, by path or found on the PATH, starts through cmd.exe with its line passed verbatim', () => withSandbox(async ({ root }) => {
    expect(await spawnedBy(['C:\\npm\\claude.cmd', '-p', '--tools', ''])).toEqual({ argv: ['cmd.exe', '/d', '/s', '/c', '"C:\\npm\\claude.cmd -p --tools """'], verbatim: true })
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'codex.cmd'), '@echo off\n')
    chmodSync(join(bin, 'codex.cmd'), 0o755)
    expect(await spawnedBy(['codex.cmd', '--version'], { PATH: bin })).toEqual({ argv: ['cmd.exe', '/d', '/s', '/c', `${join(bin, 'codex.cmd')} --version`], verbatim: true })
  }))

  test('any other program is spawned as given', async () => {
    expect(await spawnedBy(['git', 'status'])).toEqual({ argv: ['git', 'status'], verbatim: false })
  })
})

describe('versions and detection', () => {
  test('parseVersion handles real-world outputs', () => {
    expect(parseVersion('2.1.293 (Claude Code)')).toBe('2.1.293')
    expect(parseVersion('codex-cli 0.161.0')).toBe('0.161.0')
    expect(parseVersion('opencode v2.0.24')).toBe('2.0.24')
    expect(parseVersion('omp/18.8.3')).toBe('18.8.3')
    expect(parseVersion('git version 2.54.0 (Apple Git-157)')).toBe('2.54.0')
    expect(parseVersion('tmux 3.5a')).toBe('3.5')
    expect(parseVersion('1.2.3-beta.1 build')).toBe('1.2.3-beta.1')
    expect(parseVersion('no digits')).toBeUndefined()
  })

  test('which and detectBinary use PATH', () => withSandbox(async ({ root }) => {
    const bin = join(root, 'bin')
    const fake = fakeExe(join(bin, 'fakeharness'), "console.log('fakeharness/9.8.7')")
    const broken = fakeExe(join(bin, 'brokenharness'), 'process.exit(1)')
    await withEnv({ PATH: narrowPath(bin) }, async () => {
      expect(which('fakeharness')).toBe(fake)
      expect(await detectBinary('fakeharness')).toEqual({ installed: true, version: '9.8.7', path: fake })
      expect(await detectBinary('brokenharness')).toEqual({ installed: true, path: broken })
      expect(await detectBinary('nothere-xyz')).toEqual({ installed: false })
    })
  }))
})
