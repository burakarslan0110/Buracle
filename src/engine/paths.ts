import os from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Harness } from '../core/events'
import { osName } from './platform'
import { parseYaml } from './yaml'

export function env(name: string): string | undefined {
  const v = process.env[name]
  return v !== undefined && v.trim() !== '' ? v : undefined
}

function absEnv(name: string): string | undefined {
  const v = env(name)
  return v === undefined ? undefined : resolve(v)
}

export function home(): string {
  return absEnv('HOME') ?? os.homedir()
}

export function expandHome(p: string): string {
  if (p === '~') return home()
  if (p.startsWith('~/')) return join(home(), p.slice(2))
  return p
}

export function buracleHome(): string {
  return absEnv('BURACLE_HOME') ?? join(home(), '.buracle')
}

export function oldVaultRoot(): string {
  return join(home(), 'Documents', 'Buracle')
}

export function claudeDir(): string {
  return absEnv('CLAUDE_CONFIG_DIR') ?? join(home(), '.claude')
}

export function claudeJson(): string {
  const dir = absEnv('CLAUDE_CONFIG_DIR')
  return dir ? join(dir, '.claude.json') : join(home(), '.claude.json')
}

export function codexHome(): string {
  return absEnv('CODEX_HOME') ?? join(home(), '.codex')
}

export function agentsDir(): string {
  return join(home(), '.agents')
}

function xdg(name: 'XDG_CONFIG_HOME' | 'XDG_DATA_HOME'): string | undefined {
  const v = env(name)
  return v !== undefined && isAbsolute(v) ? v : undefined
}

export function opencodeConfigDir(): string {
  return join(xdg('XDG_CONFIG_HOME') ?? join(home(), '.config'), 'opencode')
}

export function opencodeDataDir(): string {
  return join(xdg('XDG_DATA_HOME') ?? join(home(), '.local', 'share'), 'opencode')
}

export function ompAgentDir(): string {
  return absEnv('PI_CODING_AGENT_DIR') ?? join(home(), '.omp', 'agent')
}

export function ompHome(): string {
  return join(home(), '.omp')
}

export function localBinDir(): string {
  return join(home(), '.local', 'bin')
}

export function isCheckout(dir: string): boolean {
  return existsSync(join(dir, 'canonical', 'buracle.yaml')) && existsSync(join(dir, 'package.json'))
}

export function findCheckout(start: string): string | undefined {
  let dir = resolve(start)
  for (let i = 0; i < 8; i++) {
    if (isCheckout(dir)) return dir
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  return undefined
}

export function configuredRepoRoot(): string | undefined {
  try {
    const raw = parseYaml(readFileSync(userConfigFile(), 'utf8')) as unknown
    const repo = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)['repo'] : undefined
    if (typeof repo === 'string' && repo.trim() !== '') {
      const expanded = expandHome(repo.trim())
      const dir = isAbsolute(expanded) ? resolve(expanded) : resolve(home(), expanded)
      if (isCheckout(dir)) return dir
    }
  } catch {  }
  try {
    const snap = JSON.parse(readFileSync(runtimeConfigFile(), 'utf8')) as { resolved?: { repoRoot?: unknown } } | null
    const r = snap?.resolved?.repoRoot
    if (typeof r === 'string' && isAbsolute(r) && isCheckout(r)) return resolve(r)
  } catch {  }
  return undefined
}

let cachedCheckout: string | null | undefined

export function repoRoot(): string {
  if (cachedCheckout === undefined) cachedCheckout = findCheckout(import.meta.dir) ?? null
  if (cachedCheckout !== null) return cachedCheckout
  return configuredRepoRoot() ?? resolve(import.meta.dir, '..', '..')
}

export const RUNTIME_MARKER = '.buracle-runtime.json'

export function runtimeRoot(): string { return join(buracleHome(), 'runtime') }

export function isFrozenRuntime(dir: string = repoRoot()): boolean {
  return existsSync(join(dir, RUNTIME_MARKER))
}

export function checkoutRoot(): string | undefined {
  const here = repoRoot()
  if (!isFrozenRuntime(here)) return here
  const ok = (dir: string | undefined): dir is string => dir !== undefined && isCheckout(dir) && !isFrozenRuntime(dir) && resolve(dir) !== resolve(here)
  const configured = configuredRepoRoot()
  if (ok(configured)) return configured
  try {
    const m = JSON.parse(readFileSync(join(here, RUNTIME_MARKER), 'utf8')) as { checkout?: unknown } | null
    const c = m?.checkout
    if (typeof c === 'string' && isAbsolute(c) && ok(c)) return resolve(c)
  } catch {  }
  return undefined
}

export function canonicalDir(): string {
  return join(repoRoot(), 'canonical')
}

export function harnessDir(h?: Harness): string {
  return h === undefined ? join(repoRoot(), 'harness') : join(repoRoot(), 'harness', h)
}

export function userConfigFile(): string { return join(buracleHome(), 'config.yaml') }
export function secretsDir(): string { return join(buracleHome(), 'secrets') }
export function binDir(): string { return join(buracleHome(), 'bin') }
export function shimPath(): string { return join(binDir(), osName() === 'win32' ? 'buracle.cmd' : 'buracle') }
export function stateDir(): string { return join(buracleHome(), 'state') }
export function ownedLedgerFile(): string { return join(stateDir(), 'owned.json') }
export function healthFile(): string { return join(stateDir(), 'health.json') }
export function updatesFile(): string { return join(stateDir(), 'updates.json') }
export function usageFile(): string { return join(stateDir(), 'usage.json') }
export function runtimeConfigFile(): string { return join(stateDir(), 'runtime-config.json') }
export function txnLockFile(): string { return join(stateDir(), 'txn.lock') }
export function memoryStateDir(): string { return join(stateDir(), 'memory') }
export function brainDir(): string { return join(buracleHome(), 'brain') }
export function pathRulesDir(): string { return join(buracleHome(), 'rules', 'paths') }
export function toolchainDir(): string { return join(buracleHome(), 'toolchain') }
/** The system tools Buracle downloaded itself (node, uv, rg, jq), one folder each (src/engine/toolchain/system-download.ts). */
export function systemToolsDir(): string { return join(toolchainDir(), 'system') }
/** The folders that hold the downloaded tools' programs: Node keeps them in bin/ except on Windows. */
export function systemToolBinDirs(): string[] {
  const root = systemToolsDir()
  return [osName() === 'win32' ? join(root, 'node') : join(root, 'node', 'bin'), join(root, 'uv'), join(root, 'rg'), join(root, 'jq')]
}
export function toolchainBinDirs(): string[] { return [join(toolchainDir(), 'go', 'bin'), join(toolchainDir(), 'dotnet', 'tools'), ...systemToolBinDirs()] }
export function toolchainStateFile(): string { return join(stateDir(), 'toolchain.json') }
export function memoryUiStateFile(): string { return join(stateDir(), 'memory-ui.json') }
/** One empty file per open harness session, refreshed by its hooks; the memory UI counts them (src/memory/ui-presence.ts). */
export function uiSessionsDir(): string { return join(stateDir(), 'ui-sessions') }
/** Taken (O_EXCL) by the hook that starts the memory UI, so two sessions starting at once start one UI. */
export function memoryUiSpawnMarker(): string { return join(stateDir(), 'memory-ui.spawn') }
/** Which shell startup file holds the PATH block the install added (src/engine/update/shell-path.ts). */
export function shellPathStateFile(): string { return join(stateDir(), 'shell-path.json') }
export function indexStateDir(): string { return join(stateDir(), 'index') }
export function ompPlanStagingDir(): string { return join(stateDir(), 'omp-plans') }
export function noticesDir(): string { return join(stateDir(), 'notices') }
export function reviewNotesDir(): string { return join(stateDir(), 'review') }
export function reviewInboxFile(): string { return join(reviewNotesDir(), 'inbox.json') }
export function installedSkillsFile(): string { return join(stateDir(), 'skills.json') }
export function skillsCacheDir(): string { return join(buracleHome(), 'cache', 'skills') }
export function sessionsDir(h?: Harness): string { return h === undefined ? join(buracleHome(), 'sessions') : join(buracleHome(), 'sessions', h) }
export function runDir(h?: Harness): string { return h === undefined ? join(buracleHome(), 'run') : join(buracleHome(), 'run', h) }
export function backupsDir(): string { return join(buracleHome(), 'backups') }
export function journalDir(): string { return join(buracleHome(), 'journal') }
export function journalFile(txn: string): string { return join(journalDir(), `${txn}.json`) }
export function logsDir(): string { return join(buracleHome(), 'logs') }
export function logFile(): string { return join(logsDir(), 'buracle.log') }
/** The install log of one day (local date): the scripts and `buracle install --script` append to it. */
export function installLogFile(now: Date): string {
  const two = (n: number) => String(n).padStart(2, '0')
  return join(logsDir(), `install-${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}.log`)
}
export const INSTALL_LOG_RE = /^install-\d{4}-\d{2}-\d{2}\.log$/

export const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id) && id !== '.' && id !== '..'
}

function checkedSession(id: string): string {
  if (!isValidSessionId(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`)
  return id
}

export function sessionDir(h: Harness, sessionId: string): string {
  return join(sessionsDir(h), checkedSession(sessionId))
}

export function heartbeatFile(h: Harness, sessionId: string): string {
  return join(runDir(h), `${checkedSession(sessionId)}.json`)
}
