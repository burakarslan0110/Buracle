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
  'HOMEBREW_NO_AUTO_UPDATE', 'HOMEBREW_NO_ENV_HINTS',
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
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
  // The runner's system git config (core.autocrlf=true on Windows) never reaches the git the tests or the product run.
  GIT_CONFIG_NOSYSTEM: '1',
}

function clearedKeys(): string[] {
  return [...ISOLATED_ENV, ...Object.keys(process.env).filter(k => k.startsWith('XDG_'))]
}

// Keys a running withEnv has set or unset, with how many withEnv calls hold each.
const overridden = new Map<string, number>()

// Puts back a quiet default that went missing (on Windows a value deleted and set again was seen to vanish),
// leaving the keys a running withEnv controls alone.
function reapplyDefaults(): void {
  for (const [k, v] of Object.entries(TEST_DEFAULT_ENV)) {
    if ((overridden.get(k) ?? 0) === 0 && process.env[k] !== v) process.env[k] = v
  }
}

// The path the product sees for `p`: resolved through links, with Windows 8.3 short names (RUNNER~1)
// expanded. The plain realpathSync is the fallback if the native one keeps a short name.
export function realPath(p: string): string {
  const native = realpathSync.native(p)
  return process.platform === 'win32' && native.includes('~') ? realpathSync(p) : native
}

export function makeSandboxDirs(prefix = 'buracle-sb-'): Sandbox {
  const root = realPath(mkdtempSync(join(realPath(tmpdir()), prefix)))
  const home = join(root, 'home')
  mkdirSync(home)
  return { root, home, buracleHome: join(home, '.buracle') }
}

const RM_RETRIES = process.platform === 'win32' ? { maxRetries: 20, retryDelay: 250 } : { maxRetries: 5, retryDelay: 100 }

export async function withSandbox<T>(fn: (sb: Sandbox) => T | Promise<T>): Promise<T> {
  const sb = makeSandboxDirs()
  const keys = ['HOME', 'BURACLE_HOME', ...clearedKeys()]
  const saved = new Map<string, string | undefined>(keys.map(k => [k, process.env[k]]))
  for (const k of clearedKeys()) delete process.env[k]
  process.env['HOME'] = sb.home
  process.env['BURACLE_HOME'] = sb.buracleHome
  reapplyDefaults()
  try {
    return await fn(sb)
  } finally {
    for (const k of new Set([...keys, ...clearedKeys()])) {
      const v = saved.get(k)
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    reapplyDefaults()
    // The retries only cover Windows' brief locks (an antivirus scan, a child that just exited), for up to 5 s there;
    // a handle a test leaves open still fails here.
    if (process.env['BURACLE_KEEP_SANDBOX'] !== '1') removeSandbox(sb.root)
  }
}

// When Windows still refuses, the error names the processes whose command line holds the sandbox path.
function removeSandbox(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true, ...RM_RETRIES })
  } catch (e) {
    if (process.platform !== 'win32') throw e
    const ps = Bun.spawnSync(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${root.replace(/'/g, "''")}*' } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`],
    { stdout: 'pipe', stderr: 'ignore', timeout: 15_000, env: { ...process.env } })
    const holders = ps.stdout.toString().trim()
    throw new Error(`${e instanceof Error ? e.message : String(e)}; processes naming the sandbox: ${holders === '' ? 'none (a handle this test process keeps open?)' : holders}`, { cause: e })
  }
}

export async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>(Object.keys(vars).map(k => [k, process.env[k]]))
  for (const k of saved.keys()) overridden.set(k, (overridden.get(k) ?? 0) + 1)
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
      const n = (overridden.get(k) ?? 1) - 1
      if (n > 0) overridden.set(k, n)
      else overridden.delete(k)
    }
    reapplyDefaults()
  }
}
