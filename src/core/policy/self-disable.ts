import type { ShellWord } from './shell'
import { DYN, HOME, commandName, parseShell, simpleCommands } from './shell'

export const RELOCATION_VARS: readonly string[] = ['BURACLE_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'PI_CODING_AGENT_DIR', 'BURACLE_CORTEXDB_BIN']

const RELOCATION = new RegExp(RELOCATION_VARS.map(v => [...v].map(c => c.replace(/[^A-Za-z0-9]/g, '\\$&')).join(`['"\\\\{}$:+-]*`)).join('|'), 'i')

function decodeEscapes(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|0[0-7]{1,3}|[0-7]{1,3}|.)/g, (_m, e: string) => {
    if (e.startsWith('x') || e.startsWith('u')) return String.fromCharCode(parseInt(e.slice(1), 16))
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8))
    return e === 'n' ? '\n' : e === 't' ? '\t' : e
  })
}

export function renderPrintf(format: string, args: readonly string[]): string {
  const DIRECTIVE = /%(?:%|[-+ #0]*(?:\d+|\*)?(?:\.(?:\d+|\*))?[a-zA-Z])/g
  let out = ''
  let k = 0
  for (let round = 0; round < 64; round++) {
    out += format.replace(DIRECTIVE, d => (d === '%%' ? '%' : args[k++] ?? ''))
    if (k === 0 || k >= args.length) break
  }
  return out
}

export function mentionsRelocation(text: string): boolean {
  if (typeof text !== 'string' || text === '') return false
  const t = text.length > 65_536 ? text.slice(0, 65_536) : text
  const forms = [t, decodeEscapes(t)]
  for (const f of forms) {
    if (RELOCATION.test(f)) return true
    const parsed = parseShell(f)
    const words: string[] = []
    for (const src of [f, ...parsed.subs.slice(0, 32)]) {
      for (const c of simpleCommands(src === f ? parsed.script : parseShell(src).script)) {
        for (const w of [...c.assigns, ...c.words]) words.push(w.text)
        for (const r of c.redirects) if (r.body !== undefined) words.push(r.body)
      }
    }
    if (RELOCATION.test(words.join(' '))) return true
  }
  return false
}

const STARTUP_NAMES = new Set(['.zshrc', '.zprofile', '.zshenv', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.kshrc', '.mkshrc', '.cshrc', '.tcshrc', '.login', '.envrc', '.pam_environment', '.xprofile', '.xsessionrc'])
const SYSTEM_STARTUP = new Set(['zshrc', 'zprofile', 'zshenv', 'zlogin', 'profile', 'bashrc', 'bash.bashrc', 'environment', 'csh.cshrc', 'csh.login', 'launchd.conf'])

export function isStartupFile(path: string): boolean {
  if (typeof path !== 'string' || path === '' || path.includes(DYN)) return false
  const p = path.replace(/\/+$/, '')
  const segs = p.split('/').filter(s => s !== '')
  const base = (segs[segs.length - 1] ?? '').toLowerCase()
  if (STARTUP_NAMES.has(base)) return true
  const dirs = segs.slice(0, -1).map(s => s.toLowerCase())
  const inEtc = dirs[0] === 'etc' || (dirs[0] === 'private' && dirs[1] === 'etc')
  if (inEtc && p.startsWith('/') && (SYSTEM_STARTUP.has(base) || dirs.includes('profile.d') || dirs.includes('zsh'))) return true
  if (dirs.includes('environment.d')) return true
  return /\.(?:zsh|sh|bash|fish|ksh)$/.test(base) && (p.startsWith(`${HOME}/.`) || /^\/(?:(?:users|home)\/[^/]+|root|var\/root)\/\.[^./]/i.test(p))
}

const GUARDED_KEYS: readonly string[][] = [['guards'], ['permissions'], ['harnesses'], ['routing'], ['plan', 'stopguard'], ['plan', 'runaway'], ['plan', 'planapproval'], ['plan', 'resultapproval'], ['plan', 'reviews'], ['plan', 'goalverification'], ['repo']]

function keySegments(key: string): string[] | undefined {
  if (key.includes(DYN)) return undefined
  const segs: string[] = []
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^.]+))\s*(?:\.|$)/gy
  let m: RegExpExecArray | null
  while (re.lastIndex < key.length && (m = re.exec(key)) !== null) {
    segs.push((m[1] ?? m[2] ?? m[3] ?? '').trim().toLowerCase())
    if (m[0] === '') return undefined
  }
  return segs.length === 0 ? undefined : segs
}

function guardedKey(segs: readonly string[]): boolean {
  return GUARDED_KEYS.some(g => g.slice(0, segs.length).every((s, i) => s === segs[i]) || segs.slice(0, g.length).every((s, i) => s === g[i]))
}

function isBuracleWord(w: ShellWord | undefined): boolean {
  if (w === undefined) return false
  return /(?:^|\/)buracle(?:\.cmd)?$/i.test(w.text)
}

function isBuracleEntry(t: string): boolean {
  return /(?:^|\/)src\/cli\/main\.ts$/.test(t) || /(?:^|\/)bin\/buracle\.ts$/.test(t)
}

const SHELL_RUNNERS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'source', '.'])
const SCRIPT_RUNNERS = new Set(['bun', 'node', 'nodejs', 'tsx', 'ts-node', 'deno', 'parallel'])
const SHELL_OPTION_WITH_VALUE = new Set(['-o', '+o', '-O', '+O'])

function programName(w: ShellWord | undefined): string | undefined {
  if (w === undefined || w.text === '' || w.text.includes(DYN)) return undefined
  const base = w.text.slice(w.text.lastIndexOf('/') + 1).toLowerCase()
  return base === '' ? undefined : base
}

function cliIndex(argv: readonly ShellWord[], accepts: (w: ShellWord) => boolean): number {
  const first = argv[0]
  if (first === undefined) return -1
  if (accepts(first)) return 0
  const name = programName(first)
  if (name === undefined) return -1
  if (SHELL_RUNNERS.has(name)) {
    for (let k = 1; k < argv.length; k++) {
      const t = (argv[k] as ShellWord).text
      if (t === '--') return k + 1 < argv.length && accepts(argv[k + 1] as ShellWord) ? k + 1 : -1
      if (!t.startsWith('-') && !t.startsWith('+')) return accepts(argv[k] as ShellWord) ? k : -1
      if (SHELL_OPTION_WITH_VALUE.has(t)) k++
    }
    return -1
  }
  if (SCRIPT_RUNNERS.has(name)) {
    for (let k = 1; k < argv.length; k++) if (accepts(argv[k] as ShellWord)) return k
  }
  return -1
}

function literalCli(w: ShellWord): boolean {
  return isBuracleWord(w) || isBuracleEntry(w.text)
}

export function buracleArgs(argv: readonly ShellWord[]): string[] | undefined {
  const k = cliIndex(argv, literalCli)
  return k < 0 ? undefined : argv.slice(k + 1).map(w => w.text)
}

const LOOPBACK = /127\.0\.0\.1|\blocalhost\b|\[::1\]|0\.0\.0\.0/i
const UI_SETTINGS_PATH = /\/api\/+settings\b/i

export const UI_SETTINGS_REASON = "This would change Buracle's workflow settings through the brain web UI's settings API; those switches are the user's (the reviews, the verification, the approvals). Tell the user what to change; they flip it in the web UI's settings view or type `! buracle config set <key> <value>` themselves."

const DOT_SEGMENT = /\/\.(?=[/?#\s'"`]|$)/g
const PARENT_SEGMENT = /\/(?!\.\.(?:[/?#\s'"`]|$))[^/\s'"`?#]+\/\.\.(?=[/?#\s'"`]|$)/g

function percentDecoded(s: string): string {
  return s.replace(/%([0-9a-fA-F]{2})/g, (_m, x: string) => String.fromCharCode(parseInt(x, 16)))
}

function resolvedPaths(s: string): string {
  let out = s.replace(/\\/g, '/').replace(/(['"`])\s*\+\s*(['"`])/g, '')
  for (let k = 0; k < 16; k++) {
    const next = out.replace(DOT_SEGMENT, '').replace(PARENT_SEGMENT, '')
    if (next === out) break
    out = next
  }
  return out
}

function urlForms(text: string): string[] {
  const forms = [text]
  let cur = text
  for (let k = 0; k < 3; k++) {
    const next = percentDecoded(cur)
    if (next === cur) break
    forms.push(next)
    cur = next
  }
  return forms.flatMap(f => [f, resolvedPaths(f)])
}

const LOOPBACK_PATH = /(?:127\.0\.0\.1|\blocalhost\b|\[::1\]|0\.0\.0\.0)(?::[^/\s'"?#]*)?(\/[^\s'"?#]*)/gi
const EXPANSION = /[{}\[\]$`(]/

function expandedSettingsPath(form: string): boolean {
  for (const m of form.matchAll(LOOPBACK_PATH)) {
    const segs = (m[1] as string).split('/').filter(s => s !== '')
    const [first, second] = segs
    if (first === undefined) continue
    if (EXPANSION.test(first)) return true
    if (first.toLowerCase() !== 'api') continue
    if (second !== undefined && EXPANSION.test(second)) return true
    if (EXPANSION.test(m[1] as string) && segs.some(x => x.toLowerCase() === 'settings')) return true
  }
  return false
}

export function uiSettingsCall(texts: readonly string[], shell = false): boolean {
  return texts.some(t => {
    if (typeof t !== 'string' || t === '') return false
    const forms = urlForms(t.length > 65_536 ? t.slice(0, 65_536) : t)
    if (shell && forms.some(expandedSettingsPath)) return true
    return forms.some(f => UI_SETTINGS_PATH.test(f)) && forms.some(f => LOOPBACK.test(f))
  })
}

export const CONSENT_RUN_REASON = "`buracle consent run` is Buracle's own wrapper for a command the user is asked about; it runs only commands Buracle put there. Run the command itself: Buracle asks the user when it needs their say-so."

export function consentRunCall(argv: readonly ShellWord[]): boolean {
  const k = cliIndex(argv, w => literalCli(w) || w.text.includes(DYN))
  const pos = k < 0 ? [] : argv.slice(k + 1).map(w => w.text).filter(a => !a.startsWith('-'))
  return pos[0] === 'consent' && pos[1] === 'run'
}

function buracleSwitch(args: readonly string[]): string | undefined {
  const pre = args.indexOf('--')
  const flags = pre < 0 ? args : args.slice(0, pre)
  if (flags.includes('--help') || flags.includes('-h')) return undefined
  const pos = args.filter(a => !a.startsWith('-'))
  const command = pos[0]
  if (command === 'uninstall') return args.includes('--dry-run') ? undefined : 'it removes Buracle and its guard hooks from every harness'
  if (command === 'rollback') return args.includes('--list') ? undefined : 'it undoes the install that registered the guard hooks'
  if (command === 'config' && (pos[1] === 'set' || pos[1] === 'unset')) {
    const key = pos[2]
    if (key === undefined) return undefined
    const segs = keySegments(key)
    if (segs === undefined || guardedKey(segs)) return `the setting ${key} turns guards or hooks off or moves what they protect`
  }
  return undefined
}

function namesBuracle(words: readonly string[]): boolean {
  return words.some(w => /(?:^|[^a-z0-9])buracle(?:$|[^a-z0-9])/i.test(w) || w.includes(DYN))
}

const REMOVE_VERBS = new Set(['disable', 'uninstall', 'remove', 'rm', 'unlink'])

function pluginSwitch(pos: readonly string[], args: readonly string[]): string | undefined {
  const sub = pos[0]?.toLowerCase()
  if (sub !== 'plugin' && sub !== 'plugins') return undefined
  const verb = pos[1]?.toLowerCase() ?? ''
  if (verb === 'marketplace') return REMOVE_VERBS.has(pos[2]?.toLowerCase() ?? '') && namesBuracle(pos.slice(3)) ? 'it removes the marketplace Buracle\'s plugin comes from' : undefined
  if (!REMOVE_VERBS.has(verb)) return undefined
  if (namesBuracle(pos.slice(2)) || args.includes('--all') || args.includes('-a')) return "it removes or disables Buracle's plugin, which runs the guard hooks"
  return undefined
}

function optionValue(args: readonly string[], ...names: string[]): string | undefined {
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    for (const n of names) {
      if (a === n) return args[k + 1] ?? ''
      if (a.startsWith(`${n}=`)) return a.slice(n.length + 1)
    }
  }
  return undefined
}

function optionValues(args: readonly string[], ...names: string[]): string[] {
  const out: string[] = []
  for (let k = 0; k < args.length; k++) {
    const a = args[k] as string
    for (const n of names) {
      if (a === n && args[k + 1] !== undefined) out.push(args[k + 1] as string)
      else if (a.startsWith(`${n}=`)) out.push(a.slice(n.length + 1))
    }
  }
  return out
}

const HARNESS_HOME: Readonly<Record<string, readonly string[]>> = {
  claude: ['CLAUDE_CONFIG_DIR'], codex: ['CODEX_HOME'], opencode: ['XDG_CONFIG_HOME', 'OPENCODE_CONFIG_DIR'], omp: ['PI_CODING_AGENT_DIR'],
}

function onlyInfo(args: readonly string[]): boolean {
  return args.length > 0 && args.every(a => ['--version', '-v', '-V', '--help', '-h', 'help', 'version'].includes(a))
}

function harnessSwitch(name: string, args: readonly string[], env: ReadonlyMap<string, string>): string | undefined {
  const pos = args.filter(a => !a.startsWith('-'))
  const plugin = pluginSwitch(pos, args)
  if (plugin !== undefined) return plugin
  if (!onlyInfo(args)) {
    for (const v of [...(HARNESS_HOME[name] ?? []), 'BURACLE_HOME']) {
      if (env.has(v)) return `${v} makes it start without Buracle's setup and guard hooks`
    }
  }
  if (name === 'claude') {
    if (args.includes('--bare') || args.includes('--safe-mode')) return "it starts Claude Code without Buracle's guard hooks"
    const settings = optionValue(args, '--settings')
    if (settings !== undefined && /disableAllHooks|allowManagedHooksOnly|enabledPlugins/i.test(settings)) return "its settings switch Buracle's guard hooks off"
    const sources = optionValue(args, '--setting-sources')
    if (sources !== undefined && !sources.split(',').map(s => s.trim()).includes('user')) return "without the user settings Claude Code does not load Buracle's plugin"
    if (pos[0] === 'config' && /^(?:set|add|remove)$/.test(pos[1] ?? '') && /disableAllHooks|enabledPlugins|hooks/i.test(pos[2] ?? '')) return "it switches Buracle's guard hooks off"
  }
  if (name === 'codex') {
    if (pos[0] === 'features' && pos[1] === 'disable' && pos.slice(2).some(f => f === 'hooks' || f === 'codex_hooks')) return "it turns off Codex's hooks, which run Buracle's guards"
    const overrides = optionValues(args, '-c', '--config')
    if (overrides.some(o => /^\s*features\.(?:codex_)?hooks\s*=\s*["']?false/i.test(o) || /^\s*features\s*=.*hooks\s*=\s*false/i.test(o))) return "it turns off Codex's hooks, which run Buracle's guards"
    if (optionValues(args, '--disable').some(f => f === 'hooks' || f === 'codex_hooks')) return "it turns off Codex's hooks, which run Buracle's guards"
  }
  if (name === 'opencode' && (args.includes('--pure') || (env.get('OPENCODE_PURE') ?? '') !== '')) return "it starts OpenCode without plugins, Buracle's guard plugin included"
  if (name === 'omp') {
    if (args.includes('--no-extensions')) return "it starts omp without extensions, Buracle's guard extension included"
    if (pos[0] === 'config' && pos[1] === 'set' && /^(?:disabledExtensions|extensions)$/.test(pos[2] ?? '') && namesBuracle(pos.slice(3))) return "it disables Buracle's guard extension"
  }
  return undefined
}

function persistentEnv(name: string, words: readonly ShellWord[]): string | undefined {
  const args = words.map(w => w.text)
  const pos = args.filter(a => !a.startsWith('-'))
  const named = (w: string | undefined): boolean => w !== undefined && (w.includes(DYN) || mentionsRelocation(w))
  const reason = 'it sets a variable that relocates Buracle or the harness settings for every later session, which can run them without the guard hooks'
  if (name === 'launchctl' && pos[0] === 'setenv' && named(pos[1])) return reason
  if (name === 'set' && args.some(a => a === '--universal' || /^-[A-Za-z]*U/.test(a)) && named(pos[0])) return reason
  if (name === 'setx' && named(pos[0])) return reason
  if (name === 'systemctl' && pos[0] === 'set-environment' && pos.slice(1).some(named)) return reason
  return undefined
}

const ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)=/

export function selfDisabling(argv: readonly ShellWord[], shown: string, assigns: readonly ShellWord[] = [], env?: ReadonlyMap<string, string>): string | undefined {
  if (!Array.isArray(argv) || argv.length === 0) return undefined
  let what: string | undefined
  const cli = buracleArgs(argv)
  if (cli !== undefined) what = buracleSwitch(cli)
  const name = commandName(argv[0])
  if (what === undefined && name !== undefined) {
    if (Object.prototype.hasOwnProperty.call(HARNESS_HOME, name)) {
      const vars = new Map<string, string>()
      if (env !== undefined && typeof env.forEach === 'function') env.forEach((v, k) => { if (RELOCATION_VARS.includes(k) || k === 'OPENCODE_PURE' || k === 'OPENCODE_CONFIG_DIR') vars.set(k, v) })
      for (const a of assigns) {
        const m = ASSIGN.exec(a.text)
        if (m) vars.set(m[1] as string, a.text.slice(m[0].length))
      }
      what = harnessSwitch(name, argv.slice(1).map(w => w.text), vars)
    } else {
      what = persistentEnv(name, argv.slice(1))
    }
  }
  if (what === undefined) return undefined
  return `would switch off Buracle's guards (${what}); only the user may do that, so ask them to run it themselves by typing ${'`'}! ${shown.replace(/`/g, "'")}${'`'} in the prompt.`
}
