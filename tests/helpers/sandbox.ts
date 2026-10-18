import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface Sandbox {
  root: string
  home: string
  buracleHome: string
}

export const ISOLATED_ENV: readonly string[] = [
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'PI_CODING_AGENT_DIR', 'PI_CONFIG_DIR',
  'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR',
  'BURACLE_TXN_FAIL_AT', 'BURACLE_LOG_LEVEL', 'BURACLE_HOOK_TIMEOUT_MS',
  'BURACLE_SESSION_ID', 'BURACLE_HARNESS',
  'CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'OPENCODE_SESSION_ID', 'OMP_SESSION_ID', 'CLAUDE_PID',
  'CLAUDE_PROJECT_DIR', 'CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_ENV_FILE',
]

export const TEST_DEFAULT_ENV: Readonly<Record<string, string>> = {
  BURACLE_NO_NOTIFY: '1',
  BURACLE_NO_CAPTURE: '1',
  BURACLE_NO_TOOLCHAIN: '1',
  BURACLE_NO_AUTOSTART: '1',
  BURACLE_NO_DISTILL: '1',
  BURACLE_NO_REFLECT: '1',
  BURACLE_NO_VERIFY: '1',
  BURACLE_NO_EMBED: '1',
  BURACLE_NO_NOTICES: '1',
  BURACLE_RUNTIME: 'checkout',
}

function clearedKeys(): string[] {
  return [...ISOLATED_ENV, ...Object.keys(process.env).filter(k => k.startsWith('XDG_'))]
}

export function makeSandboxDirs(prefix = 'buracle-sb-'): Sandbox {
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), prefix)))
  const home = join(root, 'home')
  mkdirSync(home)
  return { root, home, buracleHome: join(home, '.buracle') }
}

export async function withSandbox<T>(fn: (sb: Sandbox) => T | Promise<T>): Promise<T> {
  const sb = makeSandboxDirs()
  const keys = ['HOME', 'BURACLE_HOME', ...clearedKeys()]
  const saved = new Map<string, string | undefined>(keys.map(k => [k, process.env[k]]))
  for (const k of clearedKeys()) delete process.env[k]
  process.env['HOME'] = sb.home
  process.env['BURACLE_HOME'] = sb.buracleHome
  try {
    return await fn(sb)
  } finally {
    for (const k of new Set([...keys, ...clearedKeys()])) {
      const v = saved.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    if (process.env['BURACLE_KEEP_SANDBOX'] !== '1') rmSync(sb.root, { recursive: true, force: true })
  }
}

export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    return await fn()
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}
