import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { linuxInstallPlan, type LinuxPackageManager } from '../../src/engine/toolchain/linux-packages'
import { withSandbox } from '../helpers/sandbox'

// scripts/install.sh runs on macOS and Linux, and prints the command for a missing system tool on Linux. These
// tests run it (bash) with a PATH that holds only stub programs, so no real package manager or sudo can run, and
// compare what it prints with the TypeScript table that `buracle doctor` uses.

const SCRIPT = join(import.meta.dir, '..', '..', 'scripts', 'install.sh')
const BASH = Bun.which('bash')
const run = process.platform !== 'win32' && BASH !== null

function stub(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, name), 0o755)
}

function stubDir(root: string, programs: string[], uid = '1000'): string {
  const dir = join(root, `bin-${Math.random().toString(36).slice(2)}`)
  mkdirSync(dir)
  for (const p of programs) stub(dir, p, `echo "$0 $*" >> "${root}/ran.log"`)
  stub(dir, 'id', `echo ${uid}`)
  stub(dir, 'uname', 'echo Linux')
  const sed = Bun.which('sed')
  if (sed !== null) symlinkSync(sed, join(dir, 'sed'))
  return dir
}

const OS_RELEASES: Record<string, string> = {
  'apt-get': 'ID=ubuntu\nID_LIKE="debian"\n',
  dnf: 'ID=fedora\n',
  yum: 'ID="rhel"\nID_LIKE="fedora"\n',
  pacman: 'ID=arch\n',
  apk: 'ID=alpine\n',
  zypper: 'ID="opensuse-tumbleweed"\nID_LIKE="opensuse suse"\n',
}

describe.skipIf(!run)('scripts/install.sh on Linux', () => {
  test('its install commands are the ones buracle doctor prints, for every package manager and tool set', () => withSandbox(async ({ root }) => {
    const tools = ['node', 'uv', 'rg', 'jq', 'git', 'curl', 'unzip']
    for (const uid of ['1000', '0']) {
      for (const manager of Object.keys(OS_RELEASES) as LinuxPackageManager[]) {
        const osRelease = join(root, `os-release-${manager}`)
        writeFileSync(osRelease, OS_RELEASES[manager] as string)
        const bin = stubDir(root, [manager], uid)
        for (const set of [tools, ['node'], ['uv'], ['rg', 'jq'], ['git', 'curl', 'unzip']]) {
          const proc = Bun.spawn([BASH as string, '-c', `. "${SCRIPT}"; install_lines ${set.join(' ')}`], { env: { ...process.env, PATH: bin, HOME: root, BURACLE_INSTALL_SOURCED: '1', BURACLE_OS_RELEASE: osRelease }, stdout: 'pipe', stderr: 'pipe' })
          const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
          expect({ manager, set, err, code }).toEqual({ manager, set, err: '', code: 0 })
          const plan = linuxInstallPlan(set, { have: c => c === manager, osRelease: OS_RELEASES[manager] as string, root: uid === '0' })
          expect(out.trimEnd().split('\n').filter(l => l !== '')).toEqual([...(plan.command !== undefined ? [plan.command] : []), ...plan.script])
        }
      }
    }
  }))

  test('with git missing it prints the command for this distribution and stops; sudo and the package manager are never run', () => withSandbox(async ({ root }) => {
    const osRelease = join(root, 'os-release')
    writeFileSync(osRelease, OS_RELEASES['apt-get'] as string)
    const bin = stubDir(root, ['sudo', 'apt-get', 'curl'])
    const proc = Bun.spawn([BASH as string, SCRIPT, '--no-install'], { env: { ...process.env, PATH: bin, HOME: root, BURACLE_OS_RELEASE: osRelease }, stdout: 'pipe', stderr: 'pipe' })
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(code).toBe(1)
    expect(err).toContain('Missing on this machine: git unzip')
    expect(err).toContain('does not run sudo or a package manager')
    expect(err).toContain('sudo apt-get update && sudo apt-get install -y git unzip')
    expect(existsSync(join(root, 'ran.log'))).toBe(false)
  }))

  test('with no package manager at all it says so instead of guessing one', () => withSandbox(async ({ root }) => {
    const bin = stubDir(root, ['curl'])
    const proc = Bun.spawn([BASH as string, SCRIPT, '--no-install'], { env: { ...process.env, PATH: bin, HOME: root, BURACLE_OS_RELEASE: join(root, 'none') }, stdout: 'pipe', stderr: 'pipe' })
    const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
    expect(code).toBe(1)
    expect(err).toContain('No package manager was found')
    expect(readFileSync(SCRIPT, 'utf8')).not.toMatch(/^\s*(sudo|apt-get|dnf|yum|pacman|apk|zypper)\s+(install|add|-S|update)/m)
  }))
})
