import { realpathSync } from 'node:fs'
import type { Harness } from '../../core/events'

export type InstallMethod = 'brew-formula' | 'brew-cask' | 'npm' | 'bun' | 'native' | 'unknown'
export interface Origin { method: InstallMethod; name?: string; prefix?: string }

export const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/
export const BREW_NAME = /^[a-z0-9][a-z0-9@+._-]*(\/[a-z0-9][a-z0-9@+._-]*){0,2}$/
export const RELEASE_VERSION = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

export const SELF_UPDATERS: Readonly<Record<Harness, readonly string[]>> = {
  claude: ['claude', 'update'],
  codex: ['codex', 'update'],
  opencode: ['opencode', 'upgrade'],
  omp: ['omp', 'update'],
}

export function isNpmName(name: string): boolean {
  return NPM_NAME.test(name) && !name.split('/').some(part => part === '..' || part === '.')
}

export function isBrewName(name: string): boolean {
  return BREW_NAME.test(name)
}

export function resolveBinary(path: string | undefined): string | undefined {
  if (path === undefined || path === '') return undefined
  try { return realpathSync(path) } catch { return undefined }
}

function packageAfter(segments: readonly string[], at: number): string | undefined {
  const first = segments[at]
  if (first === undefined || first === '') return undefined
  if (!first.startsWith('@')) return first
  const second = segments[at + 1]
  return second === undefined || second === '' ? undefined : `${first}/${second}`
}

function brewOrigin(segments: readonly string[], folder: 'Cellar' | 'Caskroom'): Origin | undefined {
  const at = segments.lastIndexOf(folder)
  if (at < 0) return undefined
  const name = segments[at + 1]
  if (name === undefined || segments[at + 2] === undefined) return undefined
  return isBrewName(name) ? { method: folder === 'Cellar' ? 'brew-formula' : 'brew-cask', name } : { method: 'unknown' }
}

export function detectOrigin(realPath: string): Origin {
  const unified = realPath.replace(/\\/g, '/')
  const segments = unified.split('/')
  const brew = brewOrigin(segments, 'Caskroom') ?? brewOrigin(segments, 'Cellar')
  if (brew !== undefined) return brew
  if (/\/\.local\/share\/claude\/versions\//.test(unified)) return { method: 'native' }
  const bunAt = unified.indexOf('/.bun/install/global/node_modules/')
  if (bunAt >= 0) {
    const rest = unified.slice(bunAt + '/.bun/install/global/node_modules/'.length).split('/')
    const name = packageAfter(rest, 0)
    return name !== undefined && isNpmName(name) ? { method: 'bun', name } : { method: 'unknown' }
  }
  const npm = /^(.*?)(\/lib|\/npm)\/node_modules\//.exec(unified)
  if (npm !== undefined && npm !== null) {
    const prefixLength = (npm[1] ?? '').length + (npm[2] === '/npm' ? '/npm'.length : 0)
    const rest = unified.slice((npm[0] ?? '').length).split('/')
    const name = packageAfter(rest, 0)
    if (name === undefined || !isNpmName(name) || prefixLength === 0) return { method: 'unknown' }
    return { method: 'npm', name, prefix: realPath.slice(0, prefixLength) }
  }
  return { method: 'unknown' }
}

export interface HarnessUpdate { action: string; command: string[]; source: string; measure: 'latest' | 'increase' }

function selfUpdate(h: Harness, method: InstallMethod): HarnessUpdate {
  const command = [...SELF_UPDATERS[h]]
  return { action: 'self-update', command, source: method === 'native' ? 'native installer' : `its own updater (${command.join(' ')})`, measure: 'increase' }
}

export function harnessUpdate(h: Harness, origin: Origin, latest: string, ownPackage?: string): HarnessUpdate | { error: string } {
  const name = origin.name
  switch (origin.method) {
    case 'brew-formula':
    case 'brew-cask': {
      if (name === undefined || !isBrewName(name)) return selfUpdate(h, 'unknown')
      const cask = origin.method === 'brew-cask'
      return { action: 'brew-upgrade', command: cask ? ['brew', 'upgrade', '--cask', name] : ['brew', 'upgrade', name], source: `Homebrew ${cask ? 'cask' : 'formula'} ${name}`, measure: 'latest' }
    }
    case 'npm':
    case 'bun': {
      if (name === undefined || !isNpmName(name) || name !== (ownPackage ?? defaultPackage(h))) return selfUpdate(h, 'unknown')
      if (!RELEASE_VERSION.test(latest)) return { error: `refusing version ${JSON.stringify(latest)}: not a release version` }
      if (origin.method === 'bun') return { action: 'bun-add', command: ['bun', 'add', '-g', `${name}@${latest}`], source: `bun ${name}`, measure: 'latest' }
      if (origin.prefix === undefined || origin.prefix === '') return selfUpdate(h, 'unknown')
      return { action: 'npm-install', command: ['npm', 'install', '-g', '--prefix', origin.prefix, `${name}@${latest}`], source: `npm ${name}`, measure: 'latest' }
    }
    case 'native':
    case 'unknown':
      return selfUpdate(h, origin.method)
    default: {
      const unreachable: never = origin.method
      return unreachable
    }
  }
}

const OWN_PACKAGES: Readonly<Partial<Record<Harness, string>>> = {
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  omp: '@oh-my-pi/pi-coding-agent',
}

function defaultPackage(h: Harness): string | undefined {
  return OWN_PACKAGES[h]
}
