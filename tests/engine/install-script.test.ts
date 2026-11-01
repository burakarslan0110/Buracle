import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ITEM_NAME_WIDTH, NAME_WIDTH, SECTION_ORDER } from '../../src/cli/ui/sections'
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
  for (const tool of ['sed', 'awk', 'date', 'mkdir', 'dirname']) {
    const real = Bun.which(tool)
    if (real !== null) symlinkSync(real, join(dir, tool))
  }
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
    const tools = ['node', 'uv', 'rg', 'jq', 'git', 'curl', 'unzip', 'libatomic']
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
    const bin = stubDir(root, ['sudo', 'apt-get', 'curl', 'node'])
    const proc = Bun.spawn([BASH as string, SCRIPT, '--no-install'], { env: { ...process.env, PATH: bin, HOME: root, BURACLE_OS_RELEASE: osRelease, LANG: 'C.UTF-8', LC_ALL: '' }, stdout: 'pipe', stderr: 'pipe' })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(1)
    expect(out).toContain('✖ Prerequisites   missing git, unzip · this script runs no sudo and no package manager')
    expect(out).toContain('    ✖ install      sudo apt-get update && sudo apt-get install -y git unzip')
    expect(existsSync(join(root, 'ran.log'))).toBe(false)
  }))

  test('without node, a missing libatomic.so.1 (the downloaded Node.js needs it) is a prerequisite with its package command; one that is there passes', () => withSandbox(async ({ root }) => {
    const osRelease = join(root, 'os-release')
    writeFileSync(osRelease, OS_RELEASES['apt-get'] as string)
    const bin = stubDir(root, ['sudo', 'apt-get', 'curl', 'git', 'bun'])
    const libs = join(root, 'libroot')
    mkdirSync(libs, { recursive: true })
    const run = async () => {
      const proc = Bun.spawn([BASH as string, SCRIPT, '--no-install'], { env: { ...process.env, PATH: bin, HOME: root, BURACLE_OS_RELEASE: osRelease, BURACLE_LIB_ROOT: libs, LANG: 'C.UTF-8', LC_ALL: '' }, stdout: 'pipe', stderr: 'pipe' })
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return { out, code }
    }
    const missing = await run()
    expect(missing.code).toBe(1)
    expect(missing.out).toContain('✖ Prerequisites   missing libatomic · this script runs no sudo and no package manager')
    expect(missing.out).toContain('    ✖ install      sudo apt-get update && sudo apt-get install -y libatomic1')
    mkdirSync(join(libs, 'usr', 'lib', 'x86_64-linux-gnu'), { recursive: true })
    writeFileSync(join(libs, 'usr', 'lib', 'x86_64-linux-gnu', 'libatomic.so.1'), '')
    expect((await run()).out).not.toContain('libatomic')
    expect(existsSync(join(root, 'ran.log')) ? readFileSync(join(root, 'ran.log'), 'utf8') : '').not.toContain('apt-get')
  }))

  test('libatomic.so.1 found early in a long `ldconfig -p` list counts as there (pipefail must not read a SIGPIPE as missing)', () => withSandbox(async ({ root }) => {
    const bin = stubDir(root, [])
    symlinkSync(Bun.which('grep') as string, join(bin, 'grep'))
    writeFileSync(join(bin, 'ldconfig'), `#!${BASH}\necho "\tlibatomic.so.1 (libc6,x86-64) => /opt/gcc/lib/libatomic.so.1"\nfor ((i = 0; i < 200000; i++)); do echo "\tlibfake$i.so.1 (libc6) => /opt/x/libfake$i.so.1"; done\n`)
    chmodSync(join(bin, 'ldconfig'), 0o755)
    const proc = Bun.spawn([BASH as string, '-c', `. "${SCRIPT}"; if have_libatomic; then echo found; else echo missing; fi`], { env: { ...process.env, PATH: bin, HOME: root, BURACLE_INSTALL_SOURCED: '1', BURACLE_LIB_ROOT: '' }, stdout: 'pipe', stderr: 'pipe' })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect({ out: out.trim(), code }).toEqual({ out: 'found', code: 0 })
  }))

  test('with no package manager at all it says so instead of guessing one', () => withSandbox(async ({ root }) => {
    const bin = stubDir(root, ['curl'])
    const proc = Bun.spawn([BASH as string, SCRIPT, '--no-install'], { env: { ...process.env, PATH: bin, HOME: root, BURACLE_OS_RELEASE: join(root, 'none') }, stdout: 'pipe', stderr: 'pipe' })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(1)
    expect(out).toContain('No package manager was found')
    expect(readFileSync(SCRIPT, 'utf8')).not.toMatch(/^\s*(sudo|apt-get|dnf|yum|pacman|apk|zypper)\s+(install|add|-S|update)/m)
  }))
})

// The whole run with stub programs: git and bun record what they were asked and print what the real ones would.
const GIT_STUB = [
  'echo "git $*" >> "$STUB_ROOT/ran.log"',
  'case "$1" in',
  '  ls-remote) exit 0 ;;',
  '  clone) for last; do :; done; mkdir -p "$last/.git"; echo "Cloning into \'$last\'..."; exit 0 ;;',
  '  -C) shift 2; case "$*" in',
  '    "rev-parse --abbrev-ref HEAD") echo main ;;',
  '    "rev-parse --short HEAD") echo abc1234 ;;',
  '    "pull --ff-only") echo "Already up to date." ;;',
  '  esac; exit 0 ;;',
  'esac',
].join('\n')
const BUN_STUB = [
  'case "$1" in',
  '  --version) echo 1.4.3 ;;',
  '  install) echo "bun install v1.4.3 (120 packages)"; exit "${BUN_INSTALL_EXIT:-0}" ;;',
  '  src/cli/main.ts) printf "%s\\n" "$*" > "$STUB_ROOT/bun-args"; echo "✔ Harnesses       claude"; exit "${BUN_EXIT:-0}" ;;',
  'esac',
].join('\n')

function today(): string {
  const d = new Date()
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

async function installRun(root: string, env: Record<string, string> = {}): Promise<{ out: string, err: string, code: number }> {
  const bin = stubDir(root, ['curl', 'node'])
  stub(bin, 'git', GIT_STUB)
  stub(bin, 'bun', BUN_STUB)
  const proc = Bun.spawn([BASH as string, SCRIPT], {
    env: { ...process.env, PATH: bin, HOME: root, STUB_ROOT: root, BURACLE_CHECKOUT: join(root, 'co'), BURACLE_REPO: 'https://example.test/buracle.git', BURACLE_HOME: '', LANG: 'C.UTF-8', LC_ALL: '', LC_CTYPE: '', NO_COLOR: '', FORCE_COLOR: '', TERM: 'xterm', COLUMNS: '100', ...env },
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { out: out.slice(out.indexOf(`${TAGLINE}\n\n`) + TAGLINE.length + 2), err, code }
}

describe.skipIf(!run)('install.sh: two sections, the log and the hand-over to `buracle install --script`', () => {
  test('without a terminal: Prerequisites and Buracle as one line each, the child output in the log, `--script --yes` with the log and the start time', () => withSandbox(async ({ root }) => {
    const r = await installRun(root)
    expect(r.code).toBe(0)
    expect(r.out).toBe('✔ Prerequisites   git, curl, Bun 1.4.3\n✔ Buracle         ~/co · main @ abc1234\n✔ Harnesses       claude\n')
    expect(r.out).not.toContain('\u001b')
    const log = join(root, '.buracle', 'logs', `install-${today()}.log`)
    const text = readFileSync(log, 'utf8')
    expect(text).toContain("Cloning into '")
    expect(text).toContain('bun install v1.4.3 (120 packages)')
    expect(readFileSync(join(root, 'bun-args'), 'utf8').trim()).toMatch(new RegExp(`^src/cli/main\\.ts install --script --log ${log.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} --started \\d{13} --yes$`))
    const again = await installRun(root)
    expect(again.out.split('\n')[1]).toBe('✔ Buracle         ~/co · main @ abc1234')
    expect(readFileSync(join(root, 'ran.log'), 'utf8')).toContain('pull --ff-only')
  }))

  test('the install log is private to the user and never holds the credentials of BURACLE_REPO', () => withSandbox(async ({ root }) => {
    const r = await installRun(root, { BURACLE_REPO: 'https://ada:s3cr3t-token@example.test/buracle.git' })
    expect(r.code).toBe(0)
    const log = join(root, '.buracle', 'logs', `install-${today()}.log`)
    const text = readFileSync(log, 'utf8')
    expect(text).toContain('https://example.test/buracle.git')
    expect(text).not.toContain('s3cr3t-token')
    expect(statSync(log).mode & 0o777).toBe(0o600)
  }))

  test('a C locale gets the ASCII icons and separator', () => withSandbox(async ({ root }) => {
    const r = await installRun(root, { LANG: 'C', LC_ALL: 'C' })
    expect(r.out.split('\n').slice(0, 2)).toEqual(['+ Prerequisites   git, curl, Bun 1.4.3', '+ Buracle         ~/co - main @ abc1234'])
  }))

  test('`buracle install` exit 2 (installed with warnings) ends the script with 0; any other code with 1 and the log path', () => withSandbox(async ({ root }) => {
    expect((await installRun(root, { BUN_EXIT: '2' })).code).toBe(0)
    const failed = await installRun(root, { BUN_EXIT: '1' })
    expect(failed.code).toBe(1)
    expect(failed.out).toContain(`✖ buracle install exited 1 · log ~/.buracle/logs/install-${today()}.log`)
  }))

  test('a failed Bun download stops at Prerequisites with the log path, not with "installed but not on PATH"', () => withSandbox(async ({ root }) => {
    const bin = stubDir(root, ['node', 'unzip'])
    stub(bin, 'git', GIT_STUB)
    stub(bin, 'curl', 'echo "curl: (6) Could not resolve host: bun.sh" >&2; exit 6')
    symlinkSync(BASH as string, join(bin, 'bash'))
    const proc = Bun.spawn([BASH as string, SCRIPT], {
      env: { ...process.env, PATH: bin, HOME: root, STUB_ROOT: root, BURACLE_CHECKOUT: join(root, 'co'), BURACLE_REPO: 'https://example.test/buracle.git', BURACLE_HOME: '', LANG: 'C.UTF-8', LC_ALL: '', LC_CTYPE: '', NO_COLOR: '', FORCE_COLOR: '', TERM: 'xterm', COLUMNS: '100' },
      stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
    })
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    expect(code).toBe(1)
    expect(out).toContain(`✖ Prerequisites   Bun could not be installed · log ~/.buracle/logs/install-${today()}.log`)
    expect(readFileSync(join(root, '.buracle', 'logs', `install-${today()}.log`), 'utf8')).toContain('Could not resolve host: bun.sh')
  }))

  test('a failed `bun install` stops at Buracle with the log path', () => withSandbox(async ({ root }) => {
    const r = await installRun(root, { BUN_INSTALL_EXIT: '1' })
    expect(r.code).toBe(1)
    expect(r.out.split('\n')[1]).toBe(`✖ Buracle         bun install failed · log ~/.buracle/logs/install-${today()}.log`)
    expect(existsSync(join(root, 'bun-args'))).toBe(false)
  }))

  test('the section names, their order and widths are the ones of src/cli/ui/sections.ts', () => {
    const sh = readFileSync(SCRIPT, 'utf8')
    expect(/^SECTION_ORDER=\(([^)]*)\)/m.exec(sh)?.[1]?.split(' ')).toEqual([...SECTION_ORDER])
    expect(sh).toContain(`'%s %-${NAME_WIDTH}s%s\\n'`)
    expect(sh).toContain(`'    %s %-${ITEM_NAME_WIDTH}s %s\\n'`)
  })
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

  test('install.ps1 prints the same sections as install.sh: the same names in the same order, the same widths and icons, and hands over to `install --script`', () => {
    const ps = readFileSync(PS1, 'utf8')
    const sh = readFileSync(SCRIPT, 'utf8')
    const order = /^\$SectionOrder = @\(([^)]*)\)/m.exec(ps)?.[1]?.split(',').map(s => s.trim().replace(/'/g, ''))
    expect(order).toEqual([...SECTION_ORDER])
    expect(ps).toContain(`$Name.PadRight(${NAME_WIDTH})`)
    expect(ps).toContain(`$Name.PadRight(${ITEM_NAME_WIDTH}) + ' '`)
    // The icons: the same code points in both scripts, the same ASCII fallback.
    const shIcons = /I_OK=\$'([^']*)'; I_WARN=\$'([^']*)'; I_FAIL=\$'([^']*)'; I_INFO=\$'([^']*)'/.exec(sh)?.slice(1).map(esc => Buffer.from(esc.split('\\x').filter(Boolean).map(h => Number.parseInt(h, 16))).toString('utf8'))
    const psIcons = /ok = \[string\]\[char\]0x([0-9A-F]+); warn = \[string\]\[char\]0x([0-9A-F]+); fail = \[string\]\[char\]0x([0-9A-F]+); info = \[string\]\[char\]0x([0-9A-F]+)/.exec(ps)?.slice(1).map(h => String.fromCodePoint(Number.parseInt(h, 16)))
    expect(shIcons).toEqual(['✔', '▲', '✖', 'ℹ'])
    expect(psIcons).toEqual(shIcons as string[])
    expect(sh).toContain("I_OK='+' I_WARN='!' I_FAIL='x' I_INFO='i'")
    expect(ps).toContain("@{ ok = '+'; warn = '!'; fail = 'x'; info = 'i'")
    // Both hand over to the same command; Node.js, uv, ripgrep and jq are the toolchain's job now, not the script's.
    expect(ps).toContain("@('src/cli/main.ts', 'install', '--script', '--log', $Log, '--started', \"$Started\")")
    expect(sh).toContain('(src/cli/main.ts install --script --log "$LOG" --started "$started")')
    expect(ps).not.toMatch(/OpenJS\.NodeJS|astral-sh\.uv|BurntSushi\.ripgrep|jqlang\.jq/)
    expect(ps).toMatch(/Write-Item 'warn' 'vcredist'/)
    expect(ps).not.toMatch(/buracle doctor|install --yes/)
  })

  test('install.ps1 never calls exit: README runs it as `irm … | iex`, where exit closes the user\'s PowerShell window', () => {
    const ps = readFileSync(PS1, 'utf8')
    const code = ps.split('\n').filter(l => !/^\s*#/.test(l)).join('\n')
    expect(code).not.toMatch(/(^|[\s;{(])exit(\s+-?\d+)?\s*($|[;})])/m)
    // A failure throws instead: the script ends, the session stays, and `pwsh -File` still exits 1.
    expect(code).toMatch(/^function Stop-Install \{ throw /m)
    expect(code).toMatch(/Write-Item 'fail' 'install' .*\n\s+Stop-Install/)
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
