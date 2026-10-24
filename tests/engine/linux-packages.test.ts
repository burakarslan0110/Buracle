import { describe, expect, test } from 'bun:test'
import type { ToolSpec } from '../../src/core/catalog'
import { UV_INSTALL_SCRIPT, linuxInstallHint, linuxInstallPlan, linuxPackageManager, type LinuxEnv } from '../../src/engine/toolchain/linux-packages'
import { installAdvice, installSources } from '../../src/engine/toolchain/system'

const osRelease = (id: string, idLike = '') => `NAME="x"\nID=${id}\n${idLike === '' ? '' : `ID_LIKE="${idLike}"\n`}VERSION_ID="1"\n`
const env = (onPath: string[], text?: string, root = false): LinuxEnv => ({ have: c => onPath.includes(c), osRelease: text, root })

const node: ToolSpec = { name: 'node', check: ['node', '--version'], version_regex: 'v(\\d+)', required: true, brew: 'node', winget: 'OpenJS.NodeJS.LTS', scoop: 'nodejs-lts' }
const uv: ToolSpec = { name: 'uv', check: ['uv', '--version'], version_regex: 'uv (\\d+)', required: true, brew: 'uv', winget: 'astral-sh.uv', scoop: 'uv' }
const rg: ToolSpec = { name: 'rg', check: ['rg', '--version'], version_regex: 'ripgrep (\\d+)', required: true, brew: 'ripgrep', winget: 'BurntSushi.ripgrep.MSVC', scoop: 'ripgrep' }
const astGrep: ToolSpec = { name: 'ast-grep', check: ['ast-grep', '--version'], version_regex: 'ast-grep (\\d+)', required: false, brew: 'ast-grep', npm: '@ast-grep/cli' }
const gh: ToolSpec = { name: 'gh', check: ['gh', '--version'], version_regex: 'gh version (\\d+)', required: false, brew: 'gh', winget: 'GitHub.cli' }

describe('linuxPackageManager', () => {
  test('follows the distribution named in os-release, through ID_LIKE, when its manager is installed', () => {
    expect(linuxPackageManager(env(['apt-get', 'yum'], osRelease('ubuntu', 'debian')))).toBe('apt-get')
    expect(linuxPackageManager(env(['dnf', 'yum', 'apt-get'], osRelease('fedora')))).toBe('dnf')
    expect(linuxPackageManager(env(['yum'], osRelease('centos', 'rhel fedora')))).toBe('yum')
    expect(linuxPackageManager(env(['pacman'], osRelease('endeavouros', 'arch')))).toBe('pacman')
    expect(linuxPackageManager(env(['apk'], osRelease('alpine')))).toBe('apk')
    expect(linuxPackageManager(env(['zypper'], osRelease('opensuse-tumbleweed', 'opensuse suse')))).toBe('zypper')
  })

  test('without os-release, or with a distribution whose manager is absent, the first installed manager is used', () => {
    expect(linuxPackageManager(env(['pacman']))).toBe('pacman')
    expect(linuxPackageManager(env(['dnf'], osRelease('debian')))).toBe('dnf')
    expect(linuxPackageManager(env(['yum', 'dnf'], osRelease('some-unknown-distro')))).toBe('dnf')
    expect(linuxPackageManager(env([], osRelease('ubuntu')))).toBeUndefined()
  })
})

describe('the hint for a missing tool on Linux', () => {
  const managers: Array<[string, string, string[]]> = [
    ['apt-get', osRelease('debian'), ['apt-get']],
    ['dnf', osRelease('fedora'), ['dnf']],
    ['yum', osRelease('rhel'), ['yum']],
    ['pacman', osRelease('arch'), ['pacman']],
    ['apk', osRelease('alpine'), ['apk']],
    ['zypper', osRelease('opensuse-leap', 'opensuse suse'), ['zypper']],
  ]
  const nodeLine: Record<string, string> = {
    'apt-get': 'sudo apt-get update && sudo apt-get install -y nodejs npm',
    dnf: 'sudo dnf install -y nodejs npm',
    yum: 'sudo yum install -y nodejs npm',
    pacman: 'sudo pacman -S --needed nodejs npm',
    apk: 'sudo apk add nodejs npm',
    zypper: 'sudo zypper install -y nodejs-default npm-default',
  }

  test('names the command of the distribution, with sudo unless root', () => {
    for (const [manager, text, onPath] of managers) {
      expect(linuxInstallHint('node', env(onPath, text))).toBe(`install it with: ${nodeLine[manager]}`)
      expect(linuxInstallHint('node', env(onPath, text, true))).toBe(`install it with: ${(nodeLine[manager] as string).replaceAll('sudo ', '')}`)
    }
    expect(linuxInstallHint('rg', env(['apt-get'], osRelease('ubuntu', 'debian')))).toBe('install it with: sudo apt-get update && sudo apt-get install -y ripgrep')
    for (const tool of ['jq', 'git', 'curl', 'unzip']) {
      expect(linuxInstallHint(tool, env(['dnf'], osRelease('fedora')))).toBe(`install it with: sudo dnf install -y ${tool}`)
    }
  })

  test('uv comes from Astral\'s installer on every distribution; it needs neither a package manager nor root', () => {
    for (const [, text, onPath] of managers) expect(linuxInstallHint('uv', env(onPath, text))).toBe(`install it with: ${UV_INSTALL_SCRIPT}`)
    expect(linuxInstallHint('uv', env([]))).toBe(`install it with: ${UV_INSTALL_SCRIPT}`)
  })

  test('one command for several tools; a tool no table knows is reported apart; no manager means no package command', () => {
    const plan = linuxInstallPlan(['node', 'uv', 'rg', 'jq', 'gh'], env(['pacman'], osRelease('arch')))
    expect(plan).toEqual({ manager: 'pacman', command: 'sudo pacman -S --needed nodejs npm ripgrep jq', script: [UV_INSTALL_SCRIPT], unknown: ['gh'] })
    expect(linuxInstallPlan(['node'], env([]))).toEqual({ script: [], unknown: ['node'] })
    expect(linuxInstallHint('node', env([]))).toBeUndefined()
  })
})

describe('installAdvice and installSources on Linux', () => {
  const none = () => false
  const apt = env(['apt-get'], osRelease('ubuntu', 'debian'))

  test('without Homebrew a missing tool gets the distribution\'s command, never `brew install`', () => {
    expect(installAdvice(node, 'linux', none, apt)).toBe('install it with: sudo apt-get update && sudo apt-get install -y nodejs npm')
    expect(installAdvice(uv, 'linux', none, apt)).toBe(`install it with: ${UV_INSTALL_SCRIPT}`)
    expect(installAdvice(rg, 'linux', none, env(['dnf'], osRelease('fedora')))).toBe('install it with: sudo dnf install -y ripgrep')
    expect(installAdvice(astGrep, 'linux', none, apt)).toBe('buracle install (installs it into the Buracle toolchain)')
    expect(installAdvice(gh, 'linux', none, apt)).toBe('install it with your package manager')
    expect(installAdvice(node, 'linux', none, env([]))).toBe('install it with your package manager')
  })

  test('with Homebrew on Linux, and on macOS and Windows, the advice is what it was', () => {
    expect(installAdvice(node, 'linux', c => c === 'brew', apt)).toBe('brew install node')
    expect(installAdvice(node, 'darwin', none, apt)).toBe('brew install node')
    expect(installAdvice(node, 'win32', none)).toBe('winget install --id OpenJS.NodeJS.LTS -e --scope user')
    expect(installAdvice(uv, 'win32', none)).toBe('winget install --id astral-sh.uv -e --scope user')
  })

  test('Buracle has no installer to run on Linux other than Homebrew, so a missing system tool is only reported', () => {
    expect(installSources(node, 'linux', c => c === 'apt-get' || c === 'dnf' || c === 'pacman')).toEqual([])
    expect(installSources(node, 'linux', c => c === 'brew').map(s => s.kind)).toEqual(['brew'])
  })
})
