import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { LOGO, TAGLINE } from '../../src/cli/ui/style'
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

// Both install scripts open with the logo of the buracle command. They run before Bun exists, so they cannot import it:
// each keeps its own copy, written with # (full block), _ (lower half) and ^ (upper half) so that the files stay ASCII
// (Windows PowerShell 5.1 reads a file without a BOM in the ANSI code page), and these tests keep the copies in step.
const PS1 = join(import.meta.dir, '..', '..', 'scripts', 'install.ps1')
const ASCII_LOGO = LOGO.map(l => l.trimEnd().replaceAll('█', '#').replaceAll('▄', '_').replaceAll('▀', '^'))

function quotedRows(text: string, opening: RegExp): string[] {
  const start = text.search(opening)
  const end = text.indexOf('\n)', start)
  return start < 0 || end < 0 ? [] : [...text.slice(start, end).matchAll(/'([^']*)'/g)].map(m => m[1] as string)
}

describe('the logo the install scripts show', () => {
  test('both scripts carry the logo and the tagline of the buracle command, and stay ASCII', () => {
    const sh = readFileSync(SCRIPT, 'utf8')
    const ps = readFileSync(PS1, 'utf8')
    expect(quotedRows(sh, /^LOGO_ROWS=\(/m)).toEqual(ASCII_LOGO)
    expect(quotedRows(ps, /^\$LogoRows = @\(/m)).toEqual(ASCII_LOGO)
    expect(/^TAGLINE='([^']*)'/m.exec(sh)?.[1]).toBe(TAGLINE)
    expect(/^\$Tagline = '([^']*)'/m.exec(ps)?.[1]).toBe(TAGLINE)
    expect(/[^\x00-\x7f]/.test(sh)).toBe(false)
    expect(/[^\x00-\x7f]/.test(ps)).toBe(false)
  })

  test('install.ps1 shows it before it installs or changes anything', () => {
    const ps = readFileSync(PS1, 'utf8')
    expect(ps).toMatch(/^Show-Banner$/m)
    expect(ps.search(/^Show-Banner$/m)).toBeLessThan(ps.search(/^Refresh-Path$/m))
  })
})

describe.skipIf(!run)('install.sh shows the logo', () => {
  const PLAIN = '\n' + LOGO.map(l => `  ${l.trimEnd()}`).join('\n') + `\n  ${TAGLINE}\n\n`
  const ESC = /\u001b\[[0-9;]*m/g

  // Sources the script and runs banner() with a clean colour and locale environment.
  async function banner(root: string, env: Record<string, string> = {}): Promise<string> {
    const base = { LANG: 'en_US.UTF-8', LC_ALL: '', LC_CTYPE: '', NO_COLOR: '', FORCE_COLOR: '', TERM: 'xterm-256color', COLUMNS: '100' }
    const proc = Bun.spawn([BASH as string, '-c', `BURACLE_INSTALL_SOURCED=1 . "${SCRIPT}"; banner`], { env: { ...process.env, HOME: root, ...base, ...env }, stdout: 'pipe', stderr: 'pipe' })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(0)
    return out
  }

  test('in a UTF-8 terminal: the logo in block characters, indented, then the tagline', () => withSandbox(async ({ root }) => {
    expect(await banner(root)).toBe(PLAIN)
  }))

  test('without UTF-8 the same logo comes in ASCII', () => withSandbox(async ({ root }) => {
    const out = await banner(root, { LANG: 'C', LC_ALL: 'C' })
    expect(out).toBe('\n' + ASCII_LOGO.map(l => `  ${l}`).join('\n') + `\n  ${TAGLINE}\n\n`)
    expect(/[^\x00-\x7f]/.test(out)).toBe(false)
  }))

  test('colour is three shades along each row, only when asked for or on a terminal, and never with NO_COLOR or a dumb terminal', () => withSandbox(async ({ root }) => {
    expect(await banner(root)).not.toContain('\u001b')
    const colored = await banner(root, { FORCE_COLOR: '1' })
    expect(colored).toContain('\u001b[95m')
    expect(colored).toContain('\u001b[94m')
    expect(colored).toContain('\u001b[96m')
    expect(colored.replace(ESC, '')).toBe(PLAIN)
    expect(await banner(root, { FORCE_COLOR: '1', NO_COLOR: '1' })).toBe(PLAIN)
    expect(await banner(root, { FORCE_COLOR: '1', TERM: 'dumb' })).toBe(PLAIN)
    expect(await banner(root, { FORCE_COLOR: '0' })).toBe(PLAIN)
  }))

  test('a terminal too narrow for the logo gets one line', () => withSandbox(async ({ root }) => {
    const out = await banner(root, { COLUMNS: '50' })
    expect(out).toBe(`\n  buracle  ${TAGLINE}\n\n`)
  }))

  test('it is the first thing the installer prints, and --help does not print it', () => withSandbox(async ({ root }) => {
    const bin = join(root, 'bin')
    mkdirSync(bin)
    stub(bin, 'uname', 'echo Plan9')
    const run1 = Bun.spawn([BASH as string, SCRIPT], { env: { ...process.env, PATH: bin, HOME: root, LANG: 'en_US.UTF-8', COLUMNS: '100', NO_COLOR: '', FORCE_COLOR: '' }, stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(run1.stdout).text(), new Response(run1.stderr).text(), run1.exited])
    expect(code).toBe(1)
    expect(out).toBe(PLAIN)
    expect(err).toContain('this script is for macOS and Linux')
    const help = Bun.spawn([BASH as string, SCRIPT, '--help'], { env: { ...process.env, PATH: process.env['PATH'] ?? '', HOME: root, LANG: 'en_US.UTF-8' }, stdout: 'pipe', stderr: 'pipe' })
    const [helpOut, helpCode] = await Promise.all([new Response(help.stdout).text(), help.exited])
    expect(helpCode).toBe(0)
    expect(helpOut).toContain('Installs Buracle on macOS and Linux')
    expect(helpOut).not.toContain('██')
  }))
})
