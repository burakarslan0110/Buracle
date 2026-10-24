import { readFileSync } from 'node:fs'
import { findExecutable } from '../platform'

// Linux has no package manager Buracle may drive: installing system packages needs root, so Buracle only tells the
// user which command installs a missing tool on their distribution. It never runs sudo or a package manager.
// scripts/install.sh prints the same commands from its own table (a test keeps the two in step).

export type LinuxPackageManager = 'apt-get' | 'dnf' | 'yum' | 'pacman' | 'apk' | 'zypper'

export const LINUX_PACKAGE_MANAGERS: readonly LinuxPackageManager[] = ['apt-get', 'dnf', 'yum', 'pacman', 'apk', 'zypper']

// Tool name (as in canonical/tools.yaml, plus curl and unzip, which only the installer script needs) to the package(s)
// each manager installs for it. uv is in no distribution's main repositories alike, so Astral's own installer is used.
const PACKAGES: Readonly<Record<string, Readonly<Partial<Record<LinuxPackageManager, string>>>>> = {
  git: { 'apt-get': 'git', dnf: 'git', yum: 'git', pacman: 'git', apk: 'git', zypper: 'git' },
  curl: { 'apt-get': 'curl', dnf: 'curl', yum: 'curl', pacman: 'curl', apk: 'curl', zypper: 'curl' },
  unzip: { 'apt-get': 'unzip', dnf: 'unzip', yum: 'unzip', pacman: 'unzip', apk: 'unzip', zypper: 'unzip' },
  jq: { 'apt-get': 'jq', dnf: 'jq', yum: 'jq', pacman: 'jq', apk: 'jq', zypper: 'jq' },
  rg: { 'apt-get': 'ripgrep', dnf: 'ripgrep', yum: 'ripgrep', pacman: 'ripgrep', apk: 'ripgrep', zypper: 'ripgrep' },
  node: { 'apt-get': 'nodejs npm', dnf: 'nodejs npm', yum: 'nodejs npm', pacman: 'nodejs npm', apk: 'nodejs npm', zypper: 'nodejs-default npm-default' },
}

export const UV_INSTALL_SCRIPT = 'curl -LsSf https://astral.sh/uv/install.sh | sh'

// Distributions by the ID and ID_LIKE words of /etc/os-release; a family with two managers lists the newer first.
const FAMILIES: ReadonlyArray<readonly [RegExp, readonly LinuxPackageManager[]]> = [
  [/^(debian|ubuntu|linuxmint|pop|raspbian|kali|elementary|neon|zorin)$/, ['apt-get']],
  [/^(fedora|rhel|centos|rocky|almalinux|ol|amzn|nobara)$/, ['dnf', 'yum']],
  [/^(arch|archarm|manjaro|endeavouros|cachyos|garuda|artix)$/, ['pacman']],
  [/^alpine$/, ['apk']],
  [/^(opensuse.*|suse|sles|sled)$/, ['zypper']],
]

export interface LinuxEnv {
  /** Is this command on PATH? */
  have(cmd: string): boolean
  /** The text of /etc/os-release, when there is one. */
  osRelease?: string | undefined
  /** Running as root: no sudo in the printed command. */
  root?: boolean
}

export function defaultLinuxEnv(have: (cmd: string) => boolean = c => findExecutable(c) !== undefined): LinuxEnv {
  return { have, osRelease: readOsRelease(), root: typeof process.getuid === 'function' && process.getuid() === 0 }
}

export function readOsRelease(): string | undefined {
  for (const file of ['/etc/os-release', '/usr/lib/os-release']) {
    try { return readFileSync(file, 'utf8') } catch { /* try the next */ }
  }
  return undefined
}

function osReleaseWords(text: string | undefined): string[] {
  const words: string[] = []
  for (const line of (text ?? '').split(/\r?\n/)) {
    const m = /^(ID|ID_LIKE)=(.*)$/.exec(line.trim())
    if (m === null) continue
    words.push(...(m[2] as string).replace(/^["']|["']$/g, '').toLowerCase().split(/\s+/).filter(w => w !== ''))
  }
  return words
}

/** The package manager of this distribution: the one its os-release names when that one is installed, else the first installed of the known ones. */
export function linuxPackageManager(env: LinuxEnv): LinuxPackageManager | undefined {
  for (const word of osReleaseWords(env.osRelease)) {
    const family = FAMILIES.find(([re]) => re.test(word))
    const found = family?.[1].find(m => env.have(m))
    if (found !== undefined) return found
  }
  return LINUX_PACKAGE_MANAGERS.find(m => env.have(m))
}

function installLine(manager: LinuxPackageManager, packages: string, root: boolean): string {
  const sudo = root ? '' : 'sudo '
  switch (manager) {
    case 'apt-get': return `${sudo}apt-get update && ${sudo}apt-get install -y ${packages}`
    case 'dnf': return `${sudo}dnf install -y ${packages}`
    case 'yum': return `${sudo}yum install -y ${packages}`
    case 'pacman': return `${sudo}pacman -S --needed ${packages}`
    case 'apk': return `${sudo}apk add ${packages}`
    case 'zypper': return `${sudo}zypper install -y ${packages}`
  }
}

/**
 * The command that installs these tools on this distribution, to print. Tools no table knows go in `unknown`;
 * `script` lists commands that are not a package manager's (uv). `command` is undefined when no manager is installed.
 */
export function linuxInstallPlan(tools: readonly string[], env: LinuxEnv): { manager?: LinuxPackageManager, command?: string, script: string[], unknown: string[] } {
  const manager = linuxPackageManager(env)
  const out: { manager?: LinuxPackageManager, command?: string, script: string[], unknown: string[] } = { script: [], unknown: [] }
  if (manager !== undefined) out.manager = manager
  const packages: string[] = []
  for (const tool of tools) {
    if (tool === 'uv') { out.script.push(UV_INSTALL_SCRIPT); continue }
    const pkg = Object.hasOwn(PACKAGES, tool) && manager !== undefined ? PACKAGES[tool]?.[manager] : undefined
    if (pkg === undefined) out.unknown.push(tool)
    else packages.push(pkg)
  }
  if (manager !== undefined && packages.length > 0) out.command = installLine(manager, [...new Set(packages.join(' ').split(' '))].join(' '), env.root === true)
  return out
}

/** What to print for one missing tool on Linux, or undefined when nothing is known for it. */
export function linuxInstallHint(tool: string, env: LinuxEnv): string | undefined {
  const plan = linuxInstallPlan([tool], env)
  const line = plan.script[0] ?? plan.command
  return line === undefined ? undefined : `install it with: ${line}`
}
