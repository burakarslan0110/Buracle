import { existsSync, lstatSync, readdirSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { Harness } from '../../core/events'
import { bunExecutable } from '../config'
import { isWindows } from '../platform'
import { denyJson, failClosedReason } from '../hook-fail'
import { windowsLauncher, type ToolLink } from '../toolchain/links'
import { atomicWriteSync, readJsonSafeSync, realPath } from '../fsx'
import { parseKeyPath } from '../merge'
import * as paths from '../paths'
import { applyPlans, cleanupLedgerKey, isTxnInterrupted, ledgerKey, listLedgerKey, pointerOf, type ApplyOptions, type ApplyResult, type Ledger, type Op, type Plan } from '../txn'
import { errText, isInside, tilde } from './output'

export const CORE_OWNER = 'core'
export const AGENTS_SKILLS_OWNER = 'agents-skills'
export const AGENTS_SKILLS_CONSUMERS: readonly Harness[] = ['codex', 'opencode', 'omp']

export const INSTALL_RECORD_REL = 'state/install-record.json'
export function installRecordFile(): string {
  return join(paths.buracleHome(), INSTALL_RECORD_REL)
}

export interface InstallPhase { id: string; title: string; detail: string }

export const INSTALL_PHASES: readonly InstallPhase[] = [
  { id: 'preflight', title: 'Preflight', detail: '`HOME` must be an absolute path other than `/`. `BURACLE_HOME` cannot be the home directory itself, a directory that contains it, or a directory other programs share (such as `~/.local`, `~/.config` or `~/Library`). The configuration is loaded live.' },
  { id: 'toolchain', title: 'Toolchain', detail: 'Installs everything the harnesses need: missing system tools (git, Node.js, uv, rg, ast-grep, jq, gh) through Homebrew on macOS and winget or scoop on Windows; MCP server packages and the pyright and typescript-language-server language servers under `~/.buracle/toolchain`; the gopls, rust-analyzer, csharp-ls and jdtls language servers through Homebrew, scoop, `go install` or `dotnet tool install`. npm and PyPI packages, CortexDB and the system tools take their newest release, and packages that are already installed move to it (`toolchain.upgrade`); a new CortexDB is used only after it passed the memory check, with the brains backed up first. `update.minReleaseAgeDays` (0 by default) can make Buracle wait that many days after an npm or PyPI release, as `buracle update` does then too. An npm package is installed into a staging folder and swapped in only after it passed its check, so a server that starts meanwhile never sees a half-written copy; the copy it replaced is kept for `buracle rollback toolchain`. `--dry-run` only reports; `toolchain.autoInstall: false` or `BURACLE_NO_TOOLCHAIN=1` skips this step.' },
  { id: 'detect', title: 'Harness detection', detail: 'Every harness enabled in the configuration is looked up with `detect()`. A harness that is not installed or is turned off is skipped and reported.' },
  { id: 'compose', title: 'Composing the plans', detail: 'Collects the core plan (the shim, the `~/.local/bin/buracle` link, `repo` in `config.yaml`, and the path rules Codex and OpenCode read, `~/.buracle/rules/paths/<id>.md`), the shared skills plan when Codex, OpenCode or Oh My Pi is installed (the symlinks `~/.agents/skills/<id>` → `harness/agents-skills/<id>`), and the `installPlan()` output of every harness adapter. While a harness that rewrites its own configuration is running (Codex, for example), its adapter skips it and asks you to quit it and try again; in a terminal `buracle install` asks whether to write its configuration anyway. Items an earlier install wrote that no plan produces any more get removal operations. When a target inside HOME passes through a symlink that leads outside HOME (a dotfiles repository elsewhere, for example), only that file is skipped and reported as a conflict; in a terminal `buracle install` asks whether to write through such links.' },
  { id: 'preview', title: 'Preview', detail: '`--dry-run` prints a unified diff for each plan and stops here; a plan that a running harness would skip shows as a warning. Otherwise the changes are counted: in a terminal they are applied at once, without a question, while each step shows on the screen; without a terminal nothing is written unless `--yes` is given, and the summary says how many changes wait.' },
  { id: 'runtime', title: 'Frozen runtime', detail: 'Hooks and the CLI run a frozen copy of the checkout, never the checkout itself. Under the transaction lock, the install copies `src/`, `canonical/`, `harness/`, `package.json`, `bun.lock`, `tsconfig.json` and the runtime packages (`yaml`, `jsonc-parser`, which must match `bun.lock`) into `~/.buracle/runtime/<id>` (the id is a hash of what is copied; an identical copy that passed its check is reused), checks the copy (`buracle --version`, and the Claude Code and Codex PreToolUse hooks must deny `rm -rf ~` and let `ls` through) and only then lets the core transaction point the shim at it. A copy that fails its check is removed, the shim keeps the old runtime and the install fails before any transaction. After the core transaction, the live runtime and the newest other one (for `buracle rollback`) are kept and older ones are removed. `BURACLE_RUNTIME=checkout` writes a shim that runs the checkout directly instead (tests, debugging; `buracle doctor` warns about it).' },
  { id: 'apply', title: 'Transactional apply', detail: 'The core and shared skills plans are applied first as one transaction, then each harness as its own transaction, in the order of the transaction steps below; the lock is held throughout. When a harness\'s transaction fails, only that transaction is rolled back, the other harnesses stay installed and the exit code is 2; when the core transaction fails, no harness is attempted. When another process changes a file during a transaction, the transaction is retried once. Ctrl-C rolls back the current transaction and stops the install. Items the user deleted are not recreated (they are reported as conflicts); in a terminal `buracle install` asks whether to put them back. A lost ownership ledger is rebuilt from the transaction journals; without journals, `buracle install` in a terminal asks whether to record the values that equal Buracle\'s as its own.' },
  { id: 'record', title: 'Record', detail: 'Writes the `runtime-config.json` snapshot (the configuration, plus the absolute paths the install saw, under `resolved.*`) and the install record, which the next install uses to find leftover items. Every command in Buracle\'s files that runs the shim is checked to point at a file that exists.' },
  { id: 'post', title: 'After the install', detail: 'Sets up the memory: reports a missing CortexDB binary, removes Buracle\'s pre-commit hook from the old Obsidian vault, imports the old vault\'s live notes into the brains once (`buracle mem import-vault`; the vault is only read) and takes back the Claude Code memory redirects an older Buracle wrote. Then lists the harness-specific last steps: approving the hooks once with `/hooks` in Codex (`buracle doctor codex` lists the ones still pending), the one-time restart of OpenCode\'s background service for `BURACLE_HOME`, linking the Oh My Pi plugin to the repository\'s `harness/omp` folder, and `/reload-plugins` in open Claude Code sessions. Conflicts, adopted values, failed optional commands and recovered transactions are reported.' },
]

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

export interface ShimOptions { bun: string, repoRoot: string, buracleHome?: string, runtime?: string }

export const SHIM_DENY_DETAIL = "the hook process failed, or the shim's bun or Buracle's runtime is missing"

export function shimContent(opts: ShimOptions): string {
  const fwd = (p: string) => (isWindows() ? p.replace(/\\/g, '/') : p)
  const frozen = opts.runtime !== undefined
  const main = join(opts.runtime ?? opts.repoRoot, 'src', 'cli', 'main.ts')
  const deny = denyJson(failClosedReason(SHIM_DENY_DETAIL)).trimEnd()
  const lines = [
    '#!/bin/sh',
    '# Buracle CLI shim written by `buracle install`. Re-run `buracle install` instead of editing it.',
    `# buracle-shim: ${frozen ? 'frozen' : 'checkout'}`,
    frozen
      ? '# It runs the frozen runtime `buracle install` copied from the checkout: edits in the checkout go live with `buracle install`.'
      : '# It runs the checkout directly (BURACLE_RUNTIME=checkout): every edit there is live at once.',
  ]
  if (opts.buracleHome !== undefined) lines.push(`if [ -z "\${BURACLE_HOME:-}" ]; then BURACLE_HOME=${shellQuote(fwd(opts.buracleHome))}; export BURACLE_HOME; fi`)
  lines.push(`b=${shellQuote(fwd(opts.bun))}`, `m=${shellQuote(fwd(main))}`)
  if (frozen) {
    lines.push(
      `c=${shellQuote(fwd(join(opts.repoRoot, 'src', 'cli', 'main.ts')))}`,
      'case "$1" in doctor|install|update|uninstall|rollback)',
      '  if [ -x "$b" ] && [ -f "$c" ] && ! "$b" "$m" "$1" --help >/dev/null 2>&1; then',
      '    echo "buracle: the runtime $m cannot run \\`buracle $1\\`; running the checkout instead (\\`buracle install\\` replaces the runtime)" >&2',
      '    exec "$b" "$c" "$@"',
      '  fi ;;',
      'esac',
    )
  }
  lines.push(
    'why=missing',
    'if [ -x "$b" ] && [ -f "$m" ]; then',
    '  case "$1:$2:$3" in',
    '    hook:claude:PreToolUse|hook:codex:PreToolUse)',
    '      out=$("$b" "$m" "$@"); rc=$?',
    '      if [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]; then',
    '        if [ -n "$out" ]; then printf \'%s\\n\' "$out"; fi',
    '        exit "$rc"',
    '      fi',
    '      why="exit $rc" ;;',
    '    *) exec "$b" "$m" "$@" ;;',
    '  esac',
    'fi',
    'if [ "$1" = hook ]; then',
    '  case "$2:$3" in claude:PreToolUse|codex:PreToolUse) res=fail-closed ;; *) res=fail-open ;; esac',
    '  f="${BURACLE_HOME:-$HOME/.buracle}/logs/buracle.log"',
    '  printf \'{"ts":"%s","level":"error","pid":%s,"msg":"hook runtime failed","data":{"harness":"%s","event":"%s","why":"%s","result":"%s"}}\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$$" "$2" "$3" "$why" "$res" 2>/dev/null >>"$f"',
    `  if [ "$res" = fail-closed ]; then printf '%s\\n' ${shellQuote(deny)}; fi`,
    '  exit 0',
    'fi',
  )
  if (frozen) lines.push('if [ -x "$b" ] && [ -f "$c" ]; then echo "buracle: the runtime $m is missing; running the checkout instead (run \\`buracle install\\` to restore the runtime)" >&2; exec "$b" "$c" "$@"; fi')
  lines.push(
    'echo "buracle: $m or $b is missing; run \\`bun src/cli/main.ts install\\` in the Buracle checkout" >&2',
    'exit 127',
  )
  return lines.join('\n') + '\n'
}

function cmdSafe(s: string): string {
  return s.replace(/[<>|&^%!]/g, ' ')
}

export function windowsShimContent(opts: ShimOptions): string {
  const main = join(opts.runtime ?? opts.repoRoot, 'src', 'cli', 'main.ts')
  const checkoutMain = join(opts.repoRoot, 'src', 'cli', 'main.ts')
  const lines = ['@echo off', 'rem Buracle CLI shim written by `buracle install`. Re-run `buracle install` instead of editing it.', `rem buracle-shim: ${opts.runtime !== undefined ? 'frozen' : 'checkout'}`]
  if (opts.buracleHome !== undefined) lines.push(`if not defined BURACLE_HOME set "BURACLE_HOME=${opts.buracleHome}"`)
  const deny = cmdSafe(denyJson(failClosedReason(SHIM_DENY_DETAIL)).trimEnd())
  lines.push(
    `if not exist "${main}" goto missing`,
    // A guard hook (PreToolUse) runs like the sh shim's: stdout is held back, an exit other than 0 or 2 (a crashed bun,
    // a missing bun.exe) is answered with the deny JSON instead, so the call is not let through.
    'if /i not "%~1"=="hook" goto run',
    'if /i not "%~3"=="PreToolUse" goto run',
    'if /i "%~2"=="claude" goto guard',
    'if /i "%~2"=="codex" goto guard',
    ':run',
    `"${opts.bun}" "${main}" %*`,
    'exit /b %ERRORLEVEL%',
    ':guard',
    'setlocal',
    'set "BURACLE_HOOK_OUT=%TEMP%\\buracle-hook-%RANDOM%%RANDOM%%RANDOM%.out"',
    `"${opts.bun}" "${main}" %* > "%BURACLE_HOOK_OUT%"`,
    'set "BURACLE_HOOK_RC=%ERRORLEVEL%"',
    'if "%BURACLE_HOOK_RC%"=="0" goto guardok',
    'if "%BURACLE_HOOK_RC%"=="2" goto guardok',
    'del "%BURACLE_HOOK_OUT%" 2>nul',
    `echo ${deny}`,
    'exit /b 0',
    ':guardok',
    'type "%BURACLE_HOOK_OUT%"',
    'del "%BURACLE_HOOK_OUT%" 2>nul',
    'exit /b %BURACLE_HOOK_RC%',
    ':missing',
    'if /i "%~1"=="hook" goto hook',
  )
  if (opts.runtime !== undefined) lines.push(`if exist "${checkoutMain}" "${opts.bun}" "${checkoutMain}" %*`, `if exist "${checkoutMain}" exit /b %ERRORLEVEL%`)
  lines.push(
    `echo buracle: ${cmdSafe(main)} is missing; run "bun src\\cli\\main.ts install" in the Buracle checkout 1>&2`,
    'exit /b 127',
    ':hook',
    'if /i not "%~3"=="PreToolUse" exit /b 0',
    'if /i "%~2"=="claude" goto deny',
    'if /i "%~2"=="codex" goto deny',
    'exit /b 0',
    ':deny',
    `echo ${deny}`,
    'exit /b 0',
  )
  return lines.join('\r\n') + '\r\n'
}

export function bunPath(): string {
  return bunExecutable()
}

export function shimBuracleHome(): string | undefined {
  const def = join(paths.home(), '.buracle')
  return paths.buracleHome() === def ? undefined : paths.buracleHome()
}

export function pathLink(): string {
  return join(paths.localBinDir(), 'buracle')
}

export function pathRulesDir(): string {
  return paths.pathRulesDir()
}

export interface PathRuleFile { id: string; content: string }

export function corePlan(opts: { repoRoot: string, bun: string, configExists: boolean, pathRules?: readonly PathRuleFile[], links?: readonly ToolLink[], runtime?: string }): Plan {
  const set: Record<string, unknown> = { repo: opts.repoRoot }
  const rules = [...(opts.pathRules ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const shimOps = shimPlanOps(opts.runtime === undefined ? { bun: opts.bun, repoRoot: opts.repoRoot } : { bun: opts.bun, repoRoot: opts.repoRoot, runtime: opts.runtime })
  const linkOps: Op[] = (opts.links ?? []).map((l): Op => (isWindows()
    ? { kind: 'file', path: l.path, content: windowsLauncher(l.target), owner: CORE_OWNER }
    : { kind: 'symlink', path: l.path, target: l.target, owner: CORE_OWNER }))
  return {
    id: 'core',
    harness: 'core',
    ops: [
      ...shimOps,
      { kind: 'yaml-merge', path: paths.userConfigFile(), set, owner: CORE_OWNER },
      ...rules.map((r): Op => ({ kind: 'file', path: join(pathRulesDir(), `${r.id}.md`), content: r.content, owner: CORE_OWNER })),
      ...linkOps,
    ],
  }
}

export function shimPlanOps(target: { bun: string, repoRoot: string, runtime?: string }): Op[] {
  const home = shimBuracleHome()
  const shimOpts: ShimOptions = { ...target, ...(home !== undefined ? { buracleHome: home } : {}) }
  return isWindows()
    ? [
        { kind: 'file', path: paths.shimPath(), content: windowsShimContent(shimOpts), owner: CORE_OWNER },
        { kind: 'file', path: join(paths.binDir(), 'buracle'), content: shimContent(shimOpts), mode: 0o755, owner: CORE_OWNER },
        { kind: 'file', path: `${pathLink()}.cmd`, content: windowsLauncher(paths.shimPath()), owner: CORE_OWNER },
      ]
    : [
        { kind: 'file', path: paths.shimPath(), content: shimContent(shimOpts), mode: 0o755, owner: CORE_OWNER },
        { kind: 'symlink', path: pathLink(), target: paths.shimPath(), owner: CORE_OWNER },
      ]
}

export function retargetShim(plan: Plan, target: { bun: string, repoRoot: string, runtime?: string }): Plan {
  const fresh = new Map<string, Op>()
  for (const op of shimPlanOps(target)) if (op.kind === 'file' || op.kind === 'symlink') fresh.set(resolve(op.path), op)
  return { ...plan, ops: plan.ops.map(op => ((op.kind === 'file' || op.kind === 'symlink') && fresh.has(resolve(op.path)) ? fresh.get(resolve(op.path)) as Op : op)) }
}

export function agentsSkillIds(repoRoot: string): string[] {
  const dir = join(repoRoot, 'harness', 'agents-skills')
  let names: string[]
  try { names = readdirSync(dir).sort() } catch { return [] }
  return names.filter(n => {
    if (n.startsWith('.')) return false
    try { return statSync(join(dir, n)).isDirectory() && statSync(join(dir, n, 'SKILL.md')).isFile() } catch { return false }
  })
}

export function agentsSkillsPlan(repoRoot: string): Plan {
  const src = join(repoRoot, 'harness', 'agents-skills')
  return {
    id: 'agents-skills',
    harness: 'core',
    ops: agentsSkillIds(repoRoot).map((id): Op => ({ kind: 'symlink', path: join(paths.agentsDir(), 'skills', id), target: join(src, id), owner: AGENTS_SKILLS_OWNER })),
  }
}

export function planKeys(plan: Plan): string[] {
  const keys = new Set<string>()
  for (const op of plan.ops) {
    switch (op.kind) {
      case 'file':
      case 'symlink':
        keys.add(ledgerKey(resolve(op.path)))
        break
      case 'json-merge':
      case 'jsonc-merge':
      case 'yaml-merge':
        for (const k of Object.keys(op.set)) keys.add(ledgerKey(resolve(op.path), pointerOf(parseKeyPath(k).map(String))))
        break
      case 'toml-tables':
        for (const k of Object.keys(op.tables)) keys.add(ledgerKey(resolve(op.path), `[${pointerOf(parseKeyPath(k).map(String))}]`))
        for (const k of Object.keys(op.keys ?? {})) keys.add(ledgerKey(resolve(op.path), pointerOf(parseKeyPath(k).map(String))))
        break
      case 'md-block':
        keys.add(ledgerKey(resolve(op.path), `md:${op.id}`))
        break
      case 'json-list-merge':
        if (op.items.length > 0) keys.add(listLedgerKey(resolve(op.path), op.pointer))
        break
      case 'remove':
      case 'exec':
      case 'toml-rekey':
        break
    }
  }
  for (const k of plan.cleanupKeys ?? []) keys.add(cleanupLedgerKey(resolve(k.path), k.pointer))
  return [...keys].sort()
}

export interface InstallRecord {
  v: 1
  plans: Record<string, { keys: string[] }>
  execUndone: Record<string, string>
}

export function emptyRecord(): InstallRecord {
  return { v: 1, plans: {}, execUndone: {} }
}

export function readInstallRecord(): { record: InstallRecord, warning?: string } {
  const r = readJsonSafeSync<InstallRecord>(installRecordFile())
  if (!r.ok) return r.code === 'missing' ? { record: emptyRecord() } : { record: emptyRecord(), warning: `install record unreadable (${r.error}); stale items from earlier installs are not pruned this time` }
  const v = r.value as Partial<InstallRecord> | null
  if (v === null || typeof v !== 'object' || typeof v.plans !== 'object' || v.plans === null) return { record: emptyRecord(), warning: 'install record has an unexpected shape; ignoring it' }
  const plans: InstallRecord['plans'] = {}
  for (const [k, p] of Object.entries(v.plans)) {
    if (p && Array.isArray((p as { keys?: unknown }).keys)) plans[k] = { keys: (p as { keys: unknown[] }).keys.filter((x): x is string => typeof x === 'string') }
  }
  const execUndone: Record<string, string> = {}
  if (v.execUndone && typeof v.execUndone === 'object') {
    for (const [k, t] of Object.entries(v.execUndone)) if (typeof t === 'string') execUndone[k] = t
  }
  return { record: { v: 1, plans, execUndone } }
}

export function writeInstallRecord(r: InstallRecord): void {
  const plans: InstallRecord['plans'] = {}
  for (const k of Object.keys(r.plans).sort()) plans[k] = { keys: [...(r.plans[k]?.keys ?? [])].sort() }
  const execUndone: Record<string, string> = {}
  for (const k of Object.keys(r.execUndone).sort()) execUndone[k] = r.execUndone[k] as string
  atomicWriteSync(installRecordFile(), JSON.stringify({ v: 1, plans, execUndone }, null, 2) + '\n', { mode: 0o600 })
}

export function keyPath(key: string): string {
  const i = key.indexOf('#')
  return i >= 0 ? key.slice(0, i) : key
}

export function pruneOps(planKey: string, plan: Plan, record: InstallRecord, ledger: Ledger, producedElsewhere: ReadonlySet<string> = new Set()): Op[] {
  const before = record.plans[planKey]?.keys ?? []
  if (before.length === 0) return []
  const now = new Set([...planKeys(plan), ...producedElsewhere])
  const userConfig = resolve(paths.userConfigFile())
  const ops: Op[] = []
  for (const k of before) {
    if (now.has(k) || resolve(keyPath(k)) === userConfig) continue
    const entry = ledger[k]
    if (!entry) continue
    ops.push({ kind: 'remove', path: k, owner: entry.owner })
  }
  const isLink = (op: Op) => op.kind === 'remove' && ledger[op.path]?.kind === 'symlink'
  return [...ops.filter(isLink), ...ops.filter(op => !isLink(op))]
}

const CONTENT_KINDS = new Set<Op['kind']>(['json-merge', 'jsonc-merge', 'yaml-merge', 'toml-tables', 'md-block', 'json-list-merge', 'toml-rekey'])

export function dropMixedRemovals(plans: Plan[], prunes: ReadonlySet<Op>): { plans: Plan[], dropped: Op[] } {
  const whole = new Set<string>()
  const content = new Set<string>()
  for (const p of plans) for (const op of p.ops) {
    if (op.kind === 'exec' || prunes.has(op)) continue
    if (op.kind === 'remove') (op.path.includes('#') ? content : whole).add(resolve(keyPath(op.path)))
    else (CONTENT_KINDS.has(op.kind) ? content : whole).add(resolve(op.path))
  }
  const dropped: Op[] = []
  const out = plans.map(p => ({
    ...p,
    ops: p.ops.filter(op => {
      if (!prunes.has(op) || op.kind !== 'remove') return true
      const file = resolve(keyPath(op.path))
      const isContent = op.path.includes('#')
      const clash = isContent ? whole.has(file) : content.has(file)
      if (clash) { dropped.push(op); return false }
      ;(isContent ? content : whole).add(file)
      return true
    }),
  }))
  return { plans: out, dropped }
}

// '/', or on Windows a drive root such as C:\\ (HOME=/ resolves to the current drive's root there).
const isFsRoot = (p: string): boolean => dirname(resolve(p)) === resolve(p)

export function checkHome(): string | undefined {
  const raw = process.env['HOME']
  if (raw !== undefined && raw.trim() !== '' && !isAbsolute(raw)) return `HOME must be an absolute path (got ${JSON.stringify(raw)})`
  const home = paths.home()
  if (isFsRoot(home)) return `HOME is ${JSON.stringify(resolve(home))}; refusing to install into the filesystem root`
  try {
    if (!statSync(home).isDirectory()) return `HOME (${home}) is not a directory`
  } catch {
    return `HOME (${home}) does not exist`
  }
  return undefined
}

function realpathOr(p: string): string {
  try { return realPath(p) } catch { return p }
}

const SHARED_HOME_DIRS = [
  '.local', '.local/share', '.local/state', '.local/bin', '.local/lib', '.config', '.cache', '.ssh', '.gnupg', 'bin',
  'Library', 'Library/Application Support', 'Library/Preferences', 'Library/Caches', 'Documents', 'Desktop', 'Downloads',
  '.npm', '.bun', '.cargo', '.claude', '.codex', '.agents', '.omp', '.omp/agent', '.config/opencode', '.local/share/opencode',
]
const SHARED_SYSTEM_DIRS = ['/usr', '/usr/local', '/opt', '/opt/homebrew', '/tmp', '/private/tmp', '/var', '/private/var', '/etc', '/Applications', '/Library', '/System', '/Users', '/home', '/Volumes']

export function buracleHomeProblem(): string | undefined {
  const bh = resolve(paths.buracleHome())
  const real = realpathOr(bh)
  const home = resolve(paths.home())
  const homeReal = realpathOr(home)
  const fix = 'point BURACLE_HOME at a directory of its own (e.g. ~/.buracle or ~/.config/buracle)'
  if (isFsRoot(bh) || isFsRoot(real)) return `BURACLE_HOME is ${JSON.stringify(bh)}; ${fix}`
  if (bh === home || real === homeReal) return `BURACLE_HOME is your home directory (${home}); ${fix}`
  if (isInside(home, bh) || isInside(homeReal, real)) return `BURACLE_HOME (${bh}) contains your home directory; ${fix}`
  const shared = new Set<string>([...SHARED_SYSTEM_DIRS, ...SHARED_HOME_DIRS.flatMap(rel => [join(home, rel), join(homeReal, rel)])])
  for (const d of [paths.claudeDir(), paths.codexHome(), paths.opencodeConfigDir(), paths.opencodeDataDir(), paths.ompAgentDir(), paths.ompHome(), paths.agentsDir(), paths.localBinDir()]) shared.add(resolve(d))
  if (shared.has(bh) || shared.has(real)) return `BURACLE_HOME (${tilde(bh)}) is a directory other programs share; ${fix}`
  return undefined
}

export const HOME_MARKER = '.buracle-home'

export function buracleHomeOwned(): boolean {
  const bh = resolve(paths.buracleHome())
  if (bh === resolve(join(paths.home(), '.buracle'))) return true
  return existsSync(join(bh, HOME_MARKER))
}

export function markBuracleHome(): void {
  const bh = paths.buracleHome()
  let names: string[] | undefined
  try { names = readdirSync(bh) } catch { names = undefined }
  if (names !== undefined && !names.every(n => n === 'config.yaml' || n === HOME_MARKER || /^\..*\.buracle-\d+-[0-9a-f]+\.tmp$/.test(n))) return
  try {
    if (!existsSync(join(bh, HOME_MARKER))) {
      atomicWriteSync(join(bh, HOME_MARKER), 'This directory was created by Buracle (BURACLE_HOME). `buracle uninstall --purge-state` removes its state directories.\n')
    }
  } catch {  }
}

function opTarget(op: Op): { path: string, throughFinal: boolean } | undefined {
  if (op.kind === 'exec') return undefined
  if (op.kind === 'remove') return { path: resolve(keyPath(op.path)), throughFinal: op.path.includes('#') }
  return { path: resolve(op.path), throughFinal: op.kind !== 'symlink' }
}

function escapeOf(t: { path: string, throughFinal: boolean }, home: string, homeReal: string): string | undefined {
  if (!isInside(t.path, home) || t.path === home) return undefined
  const segs = relative(home, t.path).split(sep)
  let cur = home
  for (let i = 0; i < segs.length; i++) {
    cur = join(cur, segs[i] as string)
    const last = i === segs.length - 1
    if (last && !t.throughFinal) break
    let st
    try { st = lstatSync(cur) } catch { break }
    if (!st.isSymbolicLink()) continue
    let real: string
    try { real = realPath(cur) } catch {
      if (!last) return `${cur} is a dangling symlink inside a target path`
      break
    }
    if (!isInside(real, homeReal)) return `${cur} is a symlink to ${real}, outside HOME`
  }
  return undefined
}

export function partitionEscapes(plans: readonly Plan[], allowOutside = false): { plans: Plan[], conflicts: Array<{ op: Op, detail: string }> } {
  if (allowOutside) return { plans: [...plans], conflicts: [] }
  const home = resolve(paths.home())
  const homeReal = realpathOr(home)
  const conflicts: Array<{ op: Op, detail: string }> = []
  const out = plans.map(p => ({
    ...p,
    ops: p.ops.filter(op => {
      const t = opTarget(op)
      const why = t === undefined ? undefined : escapeOf(t, home, homeReal)
      if (why === undefined) return true
      conflicts.push({ op, detail: `${why}; not touching it (\`buracle install\` in a terminal asks whether to write through such links)` })
      return false
    }),
  }))
  return { plans: out, conflicts }
}

export function isChangedOnDisk(e: unknown): boolean {
  return /changed on disk (during|while) the transaction/.test(errText(e))
}

export async function applyWithRetry(plans: Plan[], opts: ApplyOptions = {}): Promise<ApplyResult & { retried?: boolean }> {
  try {
    return await applyPlans(plans, opts)
  } catch (e) {
    if (isTxnInterrupted(e) || !isChangedOnDisk(e)) throw e
    const r = await applyPlans(plans, opts)
    return { ...r, retried: true }
  }
}
