import { isAbsPath, isRootPath, isWindowsPath, nativePath, normalizePath, pathRoot } from '../events'
import type { CodeLang } from './code-scan'
import { scanCode } from './code-scan'
import { CONSENT_RUN_REASON, consentRunCall, isStartupFile, mentionsRelocation, renderPrintf, selfDisabling, UI_SETTINGS_REASON, uiSettingsCall } from './self-disable'
import type { Redirect, Script, ShellWord, SimpleCommand, Unwrapped, VarRef } from './shell'
import { DYN, HOME, SHELL_NAMES, commandName, parseShell, rawFromText, simpleCommands, unwrap } from './shell'
import type { SelfArea, SelfPaths, WriteGuardContext } from './write-guard'
import { decodeEncodedCommand, looksLikePowerShell } from './powershell'
import { msysPath, windowsRawDevice, windowsTarget } from './windows-paths'
import type { Dialect } from './windows-shell'
import { translateCmd, translatePowerShell } from './windows-shell'
import { checkWrite, selfProtectedArea, selfProtectionText } from './write-guard'

const HOME_ABS = '/Users/home'

const TOP_LEVEL = new Set([
  'applications', 'bin', 'boot', 'cores', 'dev', 'etc', 'home', 'lib', 'lib32', 'lib64', 'libx32', 'library',
  'media', 'mnt', 'network', 'nix', 'opt', 'private', 'proc', 'root', 'run', 'sbin', 'snap', 'srv', 'sys',
  'system', 'tmp', 'users', 'usr', 'var', 'volumes',
])
const CRITICAL_SECOND_LEVEL = new Set([
  '/usr/bin', '/usr/sbin', '/usr/lib', '/usr/libexec', '/usr/local', '/usr/share', '/usr/include',
  '/opt/homebrew', '/private/etc', '/private/var', '/private/tmp', '/var/lib', '/var/db',
  '/system/library', '/system/applications', '/library/apple',
])
const HOME_FOLDERS = new Set(['applications', 'desktop', 'documents', 'downloads', 'library', 'movies', 'music', 'pictures', 'public', '.config', '.ssh', '.gnupg', '.aws'])
const SAFE_DEVICE = /^\/dev\/(?:null|zero|stdin|stdout|stderr|tty[\w.-]*|cu\.[\w.-]+|pts\/\d+|ptmx|random|urandom|fd\/\d+|shm\/.+|tcp\/.+|udp\/.+)$/
const CREDENTIAL_DIR = /^(?:\/(?:(?:users|home)\/[^/]+|root|var\/root)|[A-Za-z]:\/users\/[^/]+)\/\.(ssh|aws|gnupg)(?:\/|$)/i
const DOWNLOADERS = new Set(['curl', 'wget', 'fetch', 'http', 'https', 'xh', 'aria2c'])
const PROTECTED_BRANCH = /^(?:main|master|release.*)$/i
const OUTPUT_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>', '<>', '>&'])
const FORK_BOMB = /(?:^|[^\w-])([A-Za-z_][\w-]*|:)\s*\(\s*\)\s*\{[^}]{0,200}?\1\s*\|\s*\1\s*&/
const PERL_FORK_BOMB = /\bfork\s*(?:\(\s*\))?\s*while\s+fork\b/
const ASSIGN_PARTS = /^([A-Za-z_][A-Za-z0-9_]*)(\[[^\]]*\])?(\+?)=/

type Mode = 'rm' | 'perm' | 'find'

const GLOB_ALL = /^(?:\.?\*|\?+\*|\*\/|\*\*(?:\/\*)?|\.\?\?\*|\.\[[!^]\.\]\*)$/
const GLOB_IN_DIR = /^(.*)\/(?:\.?\*|\?+\*|\*\/|\*\*(?:\/\*)?|\.\?\?\*|\.\[[!^]\.\]\*)$/

interface Walk {
  lines: string[]; env: Map<string, string>; budget: number; cwd?: string
  home: string; selfPaths?: SelfPaths; session?: string; windows?: boolean; psVars?: Map<string, string>
  vault?: string; protect?: string[]; buracleRepo?: string; realpath?: (p: string) => string | undefined
  visit?: (argv: readonly ShellWord[]) => boolean
}
interface Cx { walk: Walk; depth: number; history?: SimpleCommand[][] }

const TOO_DEEP = 'The guard could not check this command because it nests shells, `eval`, substitutions, wrappers or code deeper than the guard follows; split it into simpler commands.'
const MAX_DEPTH = 8

function display(words: ShellWord[]): string {
  const s = words.map(w => w.raw).join(' ').replace(/\s+/g, ' ').trim()
  return s.length > 80 ? `${s.slice(0, 77)}...` : s
}

function q(s: string): string {
  return '`' + s.replace(/`/g, "'") + '`'
}

function pathText(w: ShellWord): string | undefined {
  const t = w.text
  if (t === '' || t.includes(DYN)) return undefined
  if (t.startsWith(HOME)) return HOME_ABS + t.slice(1)
  const m = /^\/+/.exec(t)
  return m ? HOME_ABS + t.slice(m[0].length) : t
}

// `~\x` is a home path in PowerShell and in code; the backslash spelling is judged as well as the POSIX one.
function homeBackslashes(w: ShellWord): ShellWord | undefined {
  return w.text.startsWith(HOME) && w.text.includes('\\') ? { ...w, text: w.text.replace(/\\/g, '/'), raw: w.raw.replace(/\\/g, '/') } : undefined
}

function dangerousTarget(w: ShellWord, mode: Mode): string | undefined {
  const own = dangerousSpelling(w, mode)
  const alt = own === undefined ? homeBackslashes(w) : undefined
  return alt !== undefined ? dangerousSpelling(alt, mode) : own
}

function dangerousSpelling(w: ShellWord, mode: Mode): string | undefined {
  let t = pathText(w)
  if (t === undefined) return undefined
  t = msysPath(t)
  if (isWindowsPath(t)) t = normalizePath(t)
  let glob = false
  if (/[*?\]/]$/.test(w.raw) && !/['"]$/.test(w.raw) && /[*?]/.test(w.raw)) {
    if (GLOB_ALL.test(t)) { glob = true; t = '.' }
    else {
      const m = GLOB_IN_DIR.exec(t)
      if (m) { glob = true; t = m[1] === '' ? '/' : (m[1] as string) }
    }
  }
  const p = normalizePath(t)
  if (p === '') return undefined
  const lower = p.toLowerCase()
  const what = (s: string): string => (glob ? `everything in ${s}` : s)
  if (isWindowsPath(p)) return windowsTarget(p, glob, what)
  if (lower === '/') return glob ? 'everything under /' : '/ (the whole filesystem)'
  if (lower === HOME_ABS.toLowerCase()) return what('your home directory')
  if (p.startsWith('/')) {
    const segs = p.split('/').filter(s => s !== '')
    const first = (segs[0] ?? '').toLowerCase()
    if (segs.length === 1 && TOP_LEVEL.has(first)) return what(`the system directory /${segs[0]}`)
    if (segs.length === 2 && (first === 'users' || first === 'home')) return what(`the home directory ${p}`)
    if (CRITICAL_SECOND_LEVEL.has(lower)) return what(`the system directory ${p}`)
    if (first === 'users' || first === 'home') {
      const shown = lower.startsWith(HOME_ABS.toLowerCase() + '/') ? `~${p.slice(HOME_ABS.length)}` : p
      if (segs.length === 3 && HOME_FOLDERS.has((segs[2] as string).toLowerCase())) return what(`the home folder ${shown}`)
      if (segs.length === 4 && (segs[2] as string).toLowerCase() === 'documents' && (segs[3] as string).toLowerCase() === 'buracle') return what(`the Buracle memory vault ${shown}`)
    }
    return undefined
  }
  if (mode !== 'rm') return undefined
  if (p === '.') return glob ? 'everything in the current directory' : 'the current directory'
  if (p.split('/').every(s => s === '..')) return what('a parent directory')
  if (lower === '.git') return "the repository's .git directory"
  return undefined
}

function inDir(w: ShellWord, base: string | undefined): ShellWord | undefined {
  if (base === undefined || w.text === '' || w.text.startsWith(HOME) || w.text.includes(DYN) || isWindowsPath(w.text)) return undefined
  if (isWindowsPath(base) && /^[\\/](?![\\/])/.test(w.text)) return { text: `${pathRoot(normalizePath(base)).replace(/\/$/, '')}${w.text}`, raw: w.raw, quoted: w.quoted, dynamic: false }
  if (w.text.startsWith('/')) return undefined
  return { text: `${base.replace(/\/+$/, '')}/${w.text}`, raw: w.raw, quoted: w.quoted, dynamic: false }
}

function dangerousIn(w: ShellWord, mode: Mode, base: string | undefined): string | undefined {
  const own = dangerousTarget(w, mode)
  if (own !== undefined) return own
  const r = inDir(w, base)
  return r === undefined ? undefined : dangerousTarget(r, mode)
}

function pathWord(text: string): ShellWord {
  return { text, raw: `'${text}'`, quoted: true, dynamic: text.includes(DYN) }
}

export function catastrophicPath(text: string, mode: 'rm' | 'perm' = 'rm'): string | undefined {
  return typeof text === 'string' ? dangerousTarget(pathWord(text), mode) : undefined
}

function forbiddenWrite(w: ShellWord): string | undefined {
  const own = forbiddenSpelling(w)
  const alt = own === undefined ? homeBackslashes(w) : undefined
  return alt !== undefined ? forbiddenSpelling(alt) : own
}

function forbiddenSpelling(w: ShellWord): string | undefined {
  const t = pathText(w)
  if (t === undefined) return undefined
  const p = normalizePath(msysPath(t))
  if (p.startsWith('/dev/') && !SAFE_DEVICE.test(p)) return `the raw device ${p}`
  if (windowsRawDevice(t) || windowsRawDevice(p)) return `the raw device ${nativePath(windowsRawDevice(p) ? p : t.replace(/\//g, '\\'))}`
  const m = CREDENTIAL_DIR.exec(p)
  if (m) return `~/.${(m[1] as string).toLowerCase()}`
  return undefined
}

export function forbiddenWritePath(text: string): string | undefined {
  return typeof text === 'string' ? forbiddenWrite(pathWord(text)) : undefined
}

function forbiddenIn(w: ShellWord, base: string | undefined): string | undefined {
  const own = forbiddenWrite(w)
  if (own !== undefined) return own
  const r = inDir(w, base)
  return r === undefined ? undefined : forbiddenWrite(r)
}

function credentialReason(where: string): string {
  return `Writing into ${where} changes the user's credentials; ask the user to make this change themselves.`
}

function deviceReason(cmd: string, where: string): string {
  return `${q(cmd)} writes to ${where} and destroys its data; write to a regular file instead.`
}

const SELF_ENV: Readonly<Record<string, string>> = {
  BURACLE_HOME: '/.buracle', CLAUDE_CONFIG_DIR: '/.claude', CODEX_HOME: '/.codex', XDG_CONFIG_HOME: '/.config', PI_CODING_AGENT_DIR: '/.omp/agent',
}

function selfPathText(w: ShellWord): string | undefined {
  if (!w.text.startsWith(DYN)) return pathText(w)
  const ref = w.vars?.[0]
  const name = ref?.name ?? (ref?.src !== undefined ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)(?:\}|:?[-=?])/.exec(ref.src)?.[1] : undefined)
  const under = name !== undefined ? SELF_ENV[name] : undefined
  const rest = w.text.slice(DYN.length)
  return under === undefined || rest.includes(DYN) ? undefined : HOME_ABS + under + rest
}

function homeSpellings(p: string, home: string): string[] {
  if (home === '' || (p !== HOME_ABS && !p.startsWith(`${HOME_ABS}/`))) return [p]
  return [p, normalizePath(home.replace(/\/+$/, '') + p.slice(HOME_ABS.length))]
}

function selfTarget(w: ShellWord, walk: Walk, ancestor = false): SelfArea | undefined {
  for (const c of [w, inDir(w, walk.cwd)]) {
    const raw = c === undefined ? undefined : selfPathText(c)
    const t = raw === undefined ? undefined : msysPath(raw)
    if (t === undefined || !isAbsPath(t)) continue
    for (const p of homeSpellings(normalizePath(t), walk.home)) {
      const area = selfProtectedArea(p, walk.home, walk.selfPaths, ancestor, walk.session)
      if (area !== undefined) return area
    }
  }
  return undefined
}

function selfReason(cmd: string, area: SelfArea): string {
  const t = selfProtectionText(area)
  const shown = cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd
  return `${q(shown)} would change ${t.what}; ${t.remedy}.`
}

function selfWords(words: readonly ShellWord[], cmd: string, walk: Walk, ancestor = false): string | undefined {
  for (const w of words) {
    const area = selfTarget(w, walk, ancestor)
    if (area !== undefined) return selfReason(cmd, area)
  }
  return undefined
}

function checkRedirects(redirects: Redirect[], cmd: string, walk: Walk, visible?: () => string): string | undefined {
  for (const r of redirects) {
    if (!OUTPUT_REDIRECTS.has(r.op) || !r.target) continue
    if ((r.op === '>&') && /^(?:\d+|-)$/.test(r.target.text)) continue
    const bad = forbiddenIn(r.target, walk.cwd)
    if (bad) return bad.startsWith('~') ? credentialReason(bad) : deviceReason(cmd, bad)
    const area = selfTarget(r.target, walk)
    if (area !== undefined) return selfReason(`${cmd} ${r.op} ${r.target.raw}`.trim(), area)
    const h02 = protectedWrite([r.target], 'write', `${cmd} ${r.op} ${r.target.raw}`.trim(), walk, visible)
    if (h02) return h02
  }
  return undefined
}

function writePath(w: ShellWord, walk: Walk): string | undefined {
  const t = w.text
  if (t === '' || t.includes(DYN)) return undefined
  const home = walk.home !== '' ? walk.home.replace(/\/+$/, '') : '~'
  const abs = (x: string): string => (x.startsWith(HOME) ? home + x.slice(HOME.length) : walk.windows === true ? msysPath(x) : x)
  if (isAbsPath(t) || t.startsWith(HOME)) return abs(t)
  const base = walk.cwd
  if (base === undefined || base.includes(DYN)) return t
  return `${abs(base).replace(/\/+$/, '')}/${t}`
}

function writeContext(walk: Walk): WriteGuardContext {
  const ctx: WriteGuardContext = { cwd: walk.cwd !== undefined ? walk.session ?? '' : '', home: walk.home, vault: walk.vault ?? '', protect: walk.protect ?? [] }
  if (walk.selfPaths !== undefined) ctx.selfPaths = walk.selfPaths
  if (walk.buracleRepo !== undefined) ctx.buracleRepo = walk.buracleRepo
  if (walk.realpath !== undefined) ctx.realpath = walk.realpath
  return ctx
}

function protectedWrite(targets: readonly ShellWord[], verb: 'write' | 'delete' | 'move', shown: string, walk: Walk, visible?: () => string): string | undefined {
  for (const w of targets) {
    const path = writePath(w, walk)
    if (path === undefined) continue
    const startup = verb === 'write' && visible !== undefined && (isStartupFile(path) || isStartupFile(w.text))
    if (startup && mentionsRelocation(visible())) {
      return `${q(clip(shown))} would make the shell startup file ${q(path)} set a variable that relocates Buracle or the harness settings, which can run them without the guard hooks; only the user may do that, so ask them to make this change themselves.`
    }
    const ctx = writeContext(walk)
    if (startup) ctx.contents = { [path]: { after: visible(), before: '' } }
    let r: { deny?: string }
    try { r = checkWrite([path], ctx) } catch { r = {} }
    if (r.deny !== undefined) return `${q(clip(shown))} would ${verb} a protected path: ${r.deny}`
  }
  return undefined
}

function clip(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s
}

function visibleText(cmd: SimpleCommand, history: SimpleCommand[][] | undefined, walk?: Walk): string {
  const parts: string[] = []
  if (cmd.words.length === 0 && walk !== undefined) parts.push(...walk.lines)
  const add = (c: SimpleCommand): void => {
    const argv = unwrap(c.words).argv
    for (const w of [...c.assigns, ...c.words]) parts.push(w.text, w.raw)
    if (commandName(argv[0]) === 'printf') {
      const args = argv.slice(1).filter(w => w.text !== '--')
      const fmt = args[0]?.text === '-v' ? args.slice(2) : args
      if (fmt[0] !== undefined) parts.push(renderPrintf(fmt[0].text, fmt.slice(1).map(w => w.text)))
    }
    for (const r of c.redirects) {
      if (r.body !== undefined) parts.push(r.body)
      if (r.op === '<<<' && r.target !== undefined) parts.push(r.target.text)
    }
  }
  add(cmd)
  if (history !== undefined) {
    for (const c of history[history.length - 1] ?? []) add(c)
    for (const h of [history, [...history, [cmd]]]) {
      const decoded = decodedFeed(h)
      if (decoded !== undefined) parts.push(decoded)
    }
  }
  return parts.join('\n')
}

const MAX_SUBST = 1_000_000

function refValue(ref: VarRef | undefined, walk: Walk): string | undefined {
  if (ref === undefined) return undefined
  if (ref.name !== undefined) return walk.env.get(ref.name)
  return ref.src !== undefined && /^(?:\$\(\s*pwd\s*\)|`\s*pwd\s*`)$/.test(ref.src) ? '.' : undefined
}

function substituteText(text: string, vars: readonly VarRef[] | undefined, walk: Walk): string {
  if (!vars || vars.length === 0 || !text.includes(DYN)) return text
  let out = ''
  let k = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string
    if (ch !== DYN) { out += ch; continue }
    const ref = vars[k++]
    const val = refValue(ref, walk)
    if (val === undefined || walk.budget < val.length) { out += DYN; continue }
    walk.budget -= val.length
    out += val
  }
  return out
}

function substituteWord(w: ShellWord, walk: Walk): ShellWord[] {
  const refs = w.vars
  if (!refs || refs.length === 0 || !w.text.includes(DYN)) return [w]
  if (!refs.some(r => refValue(r, walk) !== undefined)) return [w]
  const out: ShellWord[] = []
  let text = ''
  let vars: VarRef[] = []
  let started = false
  let split = false
  const flush = (): void => {
    if (started || text !== '') {
      const word: ShellWord = { text, raw: '', quoted: w.quoted, dynamic: text.includes(DYN) }
      if (vars.length > 0) word.vars = vars
      out.push(word)
    }
    text = ''
    vars = []
    started = false
  }
  let k = 0
  for (let i = 0; i < w.text.length; i++) {
    const ch = w.text[i] as string
    if (ch !== DYN) { text += ch; started = true; continue }
    const ref = refs[k++] ?? { quoted: false }
    const val = refValue(ref, walk)
    if (val === undefined || walk.budget < val.length) { text += DYN; vars.push(ref); started = true; continue }
    walk.budget -= val.length
    if (ref.quoted) { text += val; started = true; continue }
    const fields = splitFields(val, walk)
    fields.forEach((f, idx) => {
      if (idx > 0) { split = true; flush() }
      text += f
      if (f !== '') started = true
    })
  }
  flush()
  for (const word of out) word.raw = !split && out.length === 1 ? w.raw : rawFromText(word.text, word.vars)
  return out
}

function splitFields(val: string, walk: Walk): string[] {
  const ifs = walk.env.get('IFS')
  if (ifs === undefined) return val.split(/[ \t\n]+/)
  if (ifs === '') return [val]
  return val.split(new RegExp(`[${ifs.replace(/[\\\]^-]/g, '\\$&')}]+`))
}

function resolveCommand(cmd: SimpleCommand, walk: Walk): SimpleCommand {
  if (walk.env.size === 0) return cmd
  const words = cmd.words.flatMap(w => substituteWord(w, walk))
  const redirects = cmd.redirects.map(r => (r.target ? { ...r, target: substituteWord(r.target, walk)[0] ?? r.target } : r))
  return { assigns: cmd.assigns, words, redirects }
}

const DECLARE = new Set(['export', 'declare', 'typeset', 'local', 'readonly'])

function assignVar(w: ShellWord, walk: Walk): void {
  const m = ASSIGN_PARTS.exec(w.raw)
  if (!m) return
  const name = m[1] as string
  if (m[2] !== undefined || (walk.env.size >= 256 && !walk.env.has(name))) { walk.env.delete(name); return }
  const prefix = m[0].length
  let value = substituteText(w.text.slice(prefix), w.vars, walk)
  if (value.includes(DYN)) { walk.env.delete(name); return }
  if (w.raw.slice(prefix).startsWith('~') && /^~(?:\/|:|$)/.test(value)) value = HOME + value.slice(1)
  if (m[3] === '+') value = (walk.env.get(name) ?? '') + value
  if (value.length > 4096) { walk.env.delete(name); return }
  walk.env.set(name, value)
}

function recordDirectory(cmd: SimpleCommand, walk: Walk): void {
  const u = unwrap(cmd.words)
  const name = commandName(u.argv[0])
  if (name !== 'cd' && name !== 'pushd' && name !== 'popd' && name !== 'chdir') return
  if (name === 'popd') { delete walk.cwd; return }
  const target = u.argv.slice(1).find(w => !/^-[LPe@]+$/.test(w.text))
  if (target === undefined) {
    if (name === 'pushd') delete walk.cwd
    else walk.cwd = HOME
    return
  }
  const t = target.text
  if (t.includes(DYN) || t === '-' || /^[+-]\d/.test(t)) { delete walk.cwd; return }
  if (isAbsPath(t) || t.startsWith(HOME)) { walk.cwd = t; return }
  if (walk.cwd !== undefined) walk.cwd = `${walk.cwd.replace(/\/+$/, '')}/${t}`
}

function recordAssignments(cmd: SimpleCommand, walk: Walk): void {
  if (cmd.words.length === 0) { for (const a of cmd.assigns) assignVar(a, walk); return }
  const name = commandName(cmd.words[0])
  if (name === undefined) return
  if (DECLARE.has(name)) {
    for (const w of cmd.words.slice(1)) if (ASSIGN_PARTS.test(w.raw)) assignVar(w, walk)
    return
  }
  if (name === 'read') {
    const names = cmd.words.slice(1).filter(w => /^[A-Za-z_][A-Za-z0-9_]*$/.test(w.text))
    const here = cmd.redirects.find(r => r.op === '<<<')?.target
    const value = here !== undefined ? substituteText(here.text, here.vars, walk) : undefined
    for (const w of names) walk.env.delete(w.text)
    const only = names[0]
    if (names.length === 1 && only !== undefined && value !== undefined && !value.includes(DYN) && cmd.words.slice(1).every(w => w === only || /^-[rs]+$/.test(w.text))) walk.env.set(only.text, value.trim())
    return
  }
  if (name === 'printf' && cmd.words[1]?.text === '-v') {
    const target = cmd.words[2]
    const fmt = cmd.words[3]
    if (target === undefined) return
    walk.env.delete(target.text)
    if (fmt !== undefined && cmd.words.length === 4 && !fmt.text.includes('%') && !fmt.text.includes('\\')) {
      const v = substituteText(fmt.text, fmt.vars, walk)
      if (!v.includes(DYN)) walk.env.set(target.text, v)
    }
    return
  }
  if (name === 'unset' || name === 'mapfile' || name === 'readarray' || name === 'getopts') {
    for (const w of cmd.words.slice(1)) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(w.text)) walk.env.delete(w.text)
  }
}

function rmRule(argv: ShellWord[], walk: Walk): string | undefined {
  const base = walk.cwd
  let recursive = false
  let endOpts = false
  const targets: ShellWord[] = []
  for (const a of argv.slice(1)) {
    const t = a.text
    if (!endOpts && t === '--') { endOpts = true; continue }
    if (!endOpts && t.startsWith('--')) { if (t === '--recursive') recursive = true; continue }
    if (!endOpts && t.startsWith('-') && t.length > 1) { if (/[rR]/.test(t.slice(1))) recursive = true; continue }
    targets.push(a)
  }
  if (recursive) {
    for (const w of targets) {
      const what = dangerousIn(w, 'rm', base) ?? vaultTarget(w, walk)
      if (what) return `${q(display(argv))} would delete ${what}; remove only the specific files or directories you need, inside the project.`
    }
  }
  return selfWords(targets, display(argv), walk, recursive) ?? protectedWrite(targets, 'delete', display(argv), walk)
}

function vaultTarget(w: ShellWord, walk: Walk): string | undefined {
  const vault = walk.vault === undefined || walk.vault === '' ? '' : walk.vault.startsWith('~/') && walk.home !== '' ? `${walk.home.replace(/\/+$/, '')}${walk.vault.slice(1)}` : walk.vault
  if (!isAbsPath(vault)) return undefined
  const path = writePath(w, walk)
  if (path === undefined || !isAbsPath(path)) return undefined
  const a = normalizePath(path).toLowerCase()
  const v = normalizePath(vault).toLowerCase()
  return isRootPath(a) || v === a || v.startsWith(`${a.replace(/\/$/, '')}/`) ? 'the Buracle memory vault' : undefined
}

function unlinkRule(argv: ShellWord[], walk: Walk): string | undefined {
  const operands = argv.slice(1).filter(w => !w.text.startsWith('-'))
  return selfWords(operands, display(argv), walk) ?? protectedWrite(operands, 'delete', display(argv), walk)
}

function permRule(name: string, argv: ShellWord[], walk: Walk): string | undefined {
  let recursive = false
  let endOpts = false
  const operands: ShellWord[] = []
  for (const a of argv.slice(1)) {
    const t = a.text
    if (!endOpts && t === '--') { endOpts = true; continue }
    if (!endOpts && t === '--recursive') { recursive = true; continue }
    if (!endOpts && t.startsWith('--')) continue
    if (!endOpts && /^-[RHLPfvhc]+$/.test(t)) { if (t.includes('R')) recursive = true; continue }
    operands.push(a)
  }
  if (recursive) {
    for (const w of operands.slice(1)) {
      const what = dangerousIn(w, 'perm', walk.cwd)
      if (what) return `${q(display(argv))} would change ownership or permissions of ${what} and can break the system; ${name} only the files you own inside the project.`
    }
  }
  return selfWords(operands.slice(1), display(argv), walk, recursive)
}

function truncateRule(argv: ShellWord[], walk: Walk): string | undefined {
  const files: ShellWord[] = []
  const args = argv.slice(1)
  for (let k = 0; k < args.length; k++) {
    const t = (args[k] as ShellWord).text
    if (t === '-s' || t === '-r' || t === '--size' || t === '--reference') { k++; continue }
    if (t.startsWith('-') && t.length > 1) continue
    files.push(args[k] as ShellWord)
  }
  return selfWords(files, display(argv), walk) ?? protectedWrite(files, 'write', display(argv), walk)
}

const IN_PLACE: Readonly<Record<string, RegExp>> = { sed: /^-[nErsuz]*i/, perl: /^-[npaslw0-9]*i/, ruby: /^-[npalswvd]*i/ }

function inPlaceRule(name: string, argv: ShellWord[], walk: Walk): string | undefined {
  const args = argv.slice(1)
  const kind = name === 'gsed' ? 'sed' : name.replace(/[0-9.]+$/, '')
  const cluster = IN_PLACE[kind]
  const inPlace = cluster !== undefined && args.some(a => cluster.test(a.text) || (kind === 'sed' && (a.text === '--in-place' || a.text.startsWith('--in-place='))))
  if (!inPlace) return undefined
  const operands = args.filter(a => !a.text.startsWith('-'))
  return selfWords(operands, display(argv), walk) ?? protectedWrite(operands, 'write', display(argv), walk, () => args.map(a => `${a.text}\n${a.raw}`).join('\n'))
}

function downloadRule(name: string, argv: ShellWord[], walk: Walk): string | undefined {
  const short = name === 'curl' ? 'oDc' : 'OPoa'
  const long = name === 'curl'
    ? ['--output', '--output-dir', '--dump-header', '--cookie-jar', '--stderr', '--trace', '--trace-ascii']
    : ['--output-document', '--directory-prefix', '--output-file', '--append-output']
  const args = argv.slice(1)
  const outs: ShellWord[] = []
  for (let k = 0; k < args.length; k++) {
    const w = args[k] as ShellWord
    const t = w.text
    const eq = t.indexOf('=')
    if (t.startsWith('--')) {
      const opt = eq < 0 ? t : t.slice(0, eq)
      if (!long.includes(opt)) continue
      if (eq >= 0) outs.push({ text: t.slice(eq + 1), raw: w.raw, quoted: w.quoted, dynamic: w.dynamic })
      else if (args[k + 1]) { outs.push(args[k + 1] as ShellWord); k++ }
      continue
    }
    if (!t.startsWith('-') || t.length < 2) continue
    const at = [...t.slice(1)].findIndex(l => short.includes(l))
    if (at < 0) continue
    const rest = t.slice(at + 2)
    if (rest !== '') outs.push({ text: rest, raw: rest, quoted: w.quoted, dynamic: w.dynamic })
    else if (args[k + 1]) { outs.push(args[k + 1] as ShellWord); k++ }
  }
  return selfWords(outs, display(argv), walk) ?? protectedWrite(outs, 'write', display(argv), walk)
}

function findRule(argv: ShellWord[], walk: Walk): string | undefined {
  const base = walk.cwd
  const args = argv.slice(1)
  let k = 0
  const roots: ShellWord[] = []
  while (k < args.length) {
    const t = (args[k] as ShellWord).text
    if (/^-[HLPEXdsx]+$/.test(t)) { k++; continue }
    if (t === '-f' && args[k + 1]) { roots.push(args[k + 1] as ShellWord); k += 2; continue }
    break
  }
  while (k < args.length) {
    const t = (args[k] as ShellWord).text
    if (t.startsWith('-') || t === '(' || t === '!' || t === ')') break
    roots.push(args[k] as ShellWord)
    k++
  }
  const expr = args.slice(k)
  const deletes = expr.some(w => w.text === '-delete')
  const unfiltered = deletes && expr.every(w => /^-(?:delete|depth|d|print|print0|mindepth|maxdepth|xdev|mount|follow|ignore_readdir_race)$/.test(w.text) || /^\d+$/.test(w.text))
  if (unfiltered) {
    for (const r of roots.length > 0 ? roots : [{ text: '.', raw: '.', quoted: false, dynamic: false }]) {
      const what = dangerousIn(r, 'rm', base)
      if (what) return `${q(display(argv))} would delete ${what}; add a filter such as \`-name\` or \`-type\`, or delete only the specific paths you need.`
    }
  }
  const removes = findExecs(expr).some(e => {
    const u = unwrap(e)
    const n = commandName(u.argv[0])
    return n === 'rm' || n === 'shred' || n === 'unlink' || u.scripts.some(runsRemoval)
  })
  if (!deletes && !removes) return undefined
  for (const r of roots) {
    const what = dangerousIn(r, 'find', base) ?? vaultTarget(r, walk)
    if (what) return `${q(display(argv))} would delete files across ${what}; limit find to a directory inside the project, or delete the files you need by name.`
  }
  return selfWords(roots.length > 0 ? roots : [{ text: '.', raw: '.', quoted: false, dynamic: false }], display(argv), walk, true)
}

function runsRemoval(src: string): boolean {
  return simpleCommands(parseShell(src).script).some(c => {
    const n = commandName(unwrap(c.words).argv[0])
    return n === 'rm' || n === 'shred' || n === 'unlink'
  })
}

function findExecs(expr: ShellWord[]): ShellWord[][] {
  const out: ShellWord[][] = []
  for (let k = 0; k < expr.length; k++) {
    const t = (expr[k] as ShellWord).text
    if (t !== '-exec' && t !== '-execdir' && t !== '-ok' && t !== '-okdir') continue
    const cmd: ShellWord[] = []
    k++
    while (k < expr.length && (expr[k] as ShellWord).text !== ';' && (expr[k] as ShellWord).text !== '+') { cmd.push(expr[k] as ShellWord); k++ }
    if (cmd.length > 0) out.push(cmd)
  }
  return out
}

function ddRule(argv: ShellWord[], walk: Walk): string | undefined {
  for (const a of argv.slice(1)) {
    const m = /^of=(.+)$/i.exec(a.text)
    if (!m) continue
    const target: ShellWord = { text: m[1] as string, raw: m[1] as string, quoted: a.quoted, dynamic: a.dynamic, ...(a.vars ? { vars: a.vars } : {}) }
    const bad = forbiddenIn(target, walk.cwd)
    if (bad) return bad.startsWith('~') ? credentialReason(bad) : deviceReason(display(argv), bad)
    const self = selfWords([target], display(argv), walk) ?? protectedWrite([target], 'write', display(argv), walk)
    if (self) return self
  }
  return undefined
}

const GIT_GLOBAL_WITH_ARG = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--attr-source', '--list-cmds'])
const PUSH_LONG = ['verbose', 'quiet', 'repo', 'all', 'branches', 'mirror', 'delete', 'tags', 'dry-run', 'porcelain', 'force', 'force-with-lease',
  'force-if-includes', 'recurse-submodules', 'thin', 'receive-pack', 'exec', 'set-upstream', 'progress', 'prune', 'no-verify', 'verify', 'follow-tags',
  'signed', 'atomic', 'push-option', 'ipv4', 'ipv6']
const PUSH_LONG_ARG = new Set(['repo', 'receive-pack', 'exec', 'push-option', 'recurse-submodules'])
const FORCE_FAMILY = new Set(['force', 'force-with-lease', 'force-if-includes'])

const MIRROR_REASON = '`git push --mirror` overwrites and deletes branches on the remote, main included; push the specific branch you changed instead.'
const ALL_REASON = 'Force-pushing every branch rewrites the remote main branch too; force-push only your feature branch, or ask the user.'
const IMPLICIT_REASON = 'Force-pushing without naming the branch rewrites whatever branch is checked out, main included; name it explicitly, for example `git push --force-with-lease origin <feature-branch>`.'
const CURRENT_BRANCH = /^["']?\+?["']?(?:\$\(|`)\s*git\s+(?:branch\s+--show-current|rev-parse\s+--abbrev-ref\s+(?:HEAD|@)|symbolic-ref\s+(?:--short\s+|-q\s+)*HEAD|name-rev\s+--name-only\s+HEAD)\s*(?:\)|`)["']?$/
const MATCHING_REASON = 'Force-pushing the matching refspec ":" rewrites every branch the remote shares with you, main included; push the specific feature branch instead.'

function pushOption(name: string): string | undefined {
  if (PUSH_LONG.includes(name)) return name
  const cands = PUSH_LONG.filter(o => o.startsWith(name))
  if (cands.length === 1) return cands[0]
  if (cands.length > 1 && name.length >= 3 && cands.every(c => FORCE_FAMILY.has(c))) return 'force'
  return undefined
}

function globRegExp(pattern: string): RegExp {
  return new RegExp('^' + pattern.split('*').map(s => s.replace(/[\\^$.+?()[\]{}|/]/g, '\\$&')).join('.*') + '$', 'i')
}

function protectedRef(dst: string): string | undefined {
  if (dst === '') return undefined
  if (!dst.includes('*')) {
    const name = dst.replace(/^refs\/heads\//, '')
    return PROTECTED_BRANCH.test(name) ? name : undefined
  }
  const re = globRegExp(dst)
  const probes = ['main', 'master', 'release', 'release/1.0', 'release-1.0']
  return probes.some(p => re.test(p) || re.test(`refs/heads/${p}`)) ? dst : undefined
}

function pushRule(rest: ShellWord[], define: boolean): string | undefined {
  let force = false
  let dry = false
  let mirror = false
  let all = false
  let del = false
  let tags = false
  const positional: ShellWord[] = []
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k] as ShellWord
    const t = w.text
    if (t === '--') { positional.push(...rest.slice(k + 1)); break }
    if (t.startsWith('--') && t.length > 2) {
      const eq = t.indexOf('=')
      const raw = (eq < 0 ? t : t.slice(0, eq)).slice(2)
      let name = pushOption(raw)
      let neg = false
      if (name === undefined && raw.startsWith('no-')) { name = pushOption(raw.slice(3)); neg = true }
      if (name === undefined) continue
      if (name === 'force' || name === 'force-with-lease') force = !neg
      else if (name === 'dry-run') dry = !neg
      else if (name === 'mirror') mirror = !neg
      else if (name === 'all' || name === 'branches') all = !neg
      else if (name === 'delete') del = !neg
      else if (name === 'tags') tags = !neg
      else if (PUSH_LONG_ARG.has(name) && eq < 0 && !neg) k++
      continue
    }
    if (t.startsWith('-') && t.length > 1) {
      const letters = t.slice(1)
      for (let j = 0; j < letters.length; j++) {
        const l = letters[j]
        if (l === 'f') force = true
        else if (l === 'n') dry = true
        else if (l === 'd') del = true
        else if (l === 'o') { if (j === letters.length - 1) k++; break }
      }
      continue
    }
    positional.push(w)
  }
  if (dry) return undefined
  if (mirror) return MIRROR_REASON
  if (force && all) return ALL_REASON
  const specs = positional.slice(1)
  if (specs.length === 0) return force && !all && !tags && !define ? IMPLICIT_REASON : undefined
  for (const w of specs) {
    const spec = w.text
    if (spec.includes(DYN)) {
      if ((force || /^["']?\+/.test(w.raw)) && !define && CURRENT_BRANCH.test(w.raw)) return IMPLICIT_REASON
      continue
    }
    let s = spec
    let plus = false
    if (s.startsWith('+')) { plus = true; s = s.slice(1) }
    if (s.startsWith('^')) continue
    if (s === ':' || s === '') {
      if (force || plus) return MATCHING_REASON
      continue
    }
    const colon = s.lastIndexOf(':')
    const src = colon >= 0 ? s.slice(0, colon) : s
    const dst = colon >= 0 ? s.slice(colon + 1) : s
    if (colon < 0 && (src === 'HEAD' || src === '@')) {
      if ((force || plus) && !define) return IMPLICIT_REASON
      continue
    }
    const hit = protectedRef(dst)
    if (hit === undefined) continue
    if (del || (colon >= 0 && src === '')) return `Deleting the remote "${hit}" branch cannot be undone from here; ask the user to do it themselves.`
    if (force || plus) {
      return hit.includes('*')
        ? `Force-pushing "${hit}" rewrites every branch it matches, main included; push the specific feature branch instead.`
        : `Force-pushing to "${hit}" rewrites the shared branch history; push to a feature branch instead, or ask the user to do it.`
    }
  }
  return undefined
}

function cleanRule(rest: ShellWord[]): string | undefined {
  let force = 0
  let ignored = false
  let dry = false
  let interactive = false
  let endOpts = false
  const paths: string[] = []
  for (let k = 0; k < rest.length; k++) {
    const t = (rest[k] as ShellWord).text
    if (!endOpts && t === '--') { endOpts = true; continue }
    if (!endOpts && t.startsWith('--')) {
      const name = t.split('=')[0]
      if (name === '--force') force++
      else if (name === '--dry-run') dry = true
      else if (name === '--interactive') interactive = true
      else if (name === '--exclude' && !t.includes('=')) k++
      continue
    }
    if (!endOpts && t.startsWith('-') && t.length > 1) {
      const letters = t.slice(1)
      for (const l of letters) {
        if (l === 'f') force++
        else if (l === 'x' || l === 'X') ignored = true
        else if (l === 'n') dry = true
        else if (l === 'i') interactive = true
      }
      if (letters.endsWith('e')) k++
      continue
    }
    paths.push(t)
  }
  if (dry || interactive || force === 0 || !ignored) return undefined
  const whole = paths.length === 0 || paths.every(p => ['.', './', ':/', ':/:', '*', ':(top)'].includes(p))
  if (!whole) return undefined
  return '`git clean -fdx` without a path deletes every untracked and ignored file in the repository, including .env files and local settings; preview with `git clean -ndx`, then clean a specific path such as `git clean -fdx -- build/`.'
}

function gitEnvConfig(cmd: SimpleCommand, walk: Walk): Map<string, string | undefined> {
  const vars = new Map<string, string>()
  for (const [k, v] of walk.env) if (k.startsWith('GIT_CONFIG_')) vars.set(k, v)
  for (const w of [...cmd.assigns, ...cmd.words]) {
    const m = /^(GIT_CONFIG_[A-Z0-9_]+)=/.exec(w.raw)
    if (m) vars.set(m[1] as string, substituteText(w.text, w.vars, walk).slice((m[1] as string).length + 1))
  }
  const out = new Map<string, string | undefined>()
  const count = Number(vars.get('GIT_CONFIG_COUNT') ?? 'NaN')
  for (const [k, v] of vars) {
    const m = /^GIT_CONFIG_KEY_(\d+)$/.exec(k)
    if (!m || (Number.isFinite(count) && Number(m[1]) >= count)) continue
    const val = vars.get(`GIT_CONFIG_VALUE_${m[1] as string}`)
    out.set(v.toLowerCase(), val === undefined || val.includes(DYN) ? undefined : val)
  }
  const params = vars.get('GIT_CONFIG_PARAMETERS')
  if (params !== undefined) {
    for (const m of params.matchAll(/'([^']*)'(?:='([^']*)')?/g)) {
      const pair = m[2] !== undefined ? [m[1] as string, m[2]] : [(m[1] as string).split('=')[0] as string, (m[1] as string).split('=').slice(1).join('=')]
      out.set((pair[0] as string).toLowerCase(), pair[1])
    }
  }
  return out
}

function gitWords(value: string): ShellWord[] {
  const [first] = simpleCommands(parseShell(value).script)
  return first ? [...first.assigns, ...first.words] : []
}

const GIT_WORD: ShellWord = { text: 'git', raw: 'git', quoted: false, dynamic: false }

function gitRule(argv: ShellWord[], cx: Cx, cmd: SimpleCommand, define = false, depth = 0, inherited?: Map<string, string | undefined>, seen: ReadonlySet<string> = new Set()): string | undefined {
  if (depth > 4) return 'The guard could not check this git command because its aliases expand deeper than the guard follows; run the git command the alias stands for instead.'
  const config = new Map<string, string | undefined>(inherited ?? gitEnvConfig(cmd, cx.walk))
  const args = argv.slice(1)
  let k = 0
  const note = (pair: ShellWord | string | undefined, fromEnv: boolean): void => {
    if (pair === undefined) return
    const text = typeof pair === 'string' ? pair : pair.text
    const eq = text.indexOf('=')
    if (eq <= 0) return
    const key = text.slice(0, eq).toLowerCase()
    const value = text.slice(eq + 1)
    if (fromEnv) {
      const prefix = cmd.assigns.find(a => a.raw.startsWith(`${value}=`))
      const v = prefix !== undefined ? substituteText(prefix.text, prefix.vars, cx.walk).slice(value.length + 1) : cx.walk.env.get(value)
      config.set(key, v === undefined || v.includes(DYN) ? undefined : v)
      return
    }
    config.set(key, value.includes(DYN) ? undefined : value)
  }
  while (k < args.length) {
    const t = (args[k] as ShellWord).text
    if (t === '-c') { note(args[k + 1], false); k += 2; continue }
    if (t === '--config-env') { note(args[k + 1], true); k += 2; continue }
    if (t.startsWith('--config-env=')) { note(t.slice('--config-env='.length), true); k++; continue }
    if (GIT_GLOBAL_WITH_ARG.has(t)) { k += 2; continue }
    if (t.startsWith('-')) { k++; continue }
    break
  }
  const sub = args[k]?.text.toLowerCase()
  const rest = args.slice(k + 1)
  if (sub === undefined) return undefined
  if (sub === 'push') return pushRule(rest, define)
  if (sub === 'clean') return cleanRule(rest)
  if (sub === 'config') return gitConfigRule(rest, cx, cmd)
  if (!config.has(`alias.${sub}`)) return undefined
  if (seen.has(sub)) return undefined
  const value = config.get(`alias.${sub}`)
  if (value === undefined) return undefined
  const v = value.trim()
  if (v.startsWith('!')) {
    return analyze([v.slice(1), ...rest.map(w => w.raw)].join(' '), cx.depth + 1, cx.walk)
  }
  const expanded = [GIT_WORD, ...gitWords(v), ...rest]
  if (!define && visited(expanded, cx.walk)) return VISIT_DONE
  return gitRule(expanded, cx, cmd, define, depth + 1, config, new Set([...seen, sub]))
}

const GIT_CONFIG_WITH_ARG = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value', '--fixed-value'])

function gitConfigRule(rest: ShellWord[], cx: Cx, cmd: SimpleCommand): string | undefined {
  const pos: ShellWord[] = []
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k] as ShellWord
    if (w.text === '--') { pos.push(...rest.slice(k + 1)); break }
    if (w.text.startsWith('-') && w.text.length > 1) { if (GIT_CONFIG_WITH_ARG.has(w.text)) k++; continue }
    pos.push(w)
  }
  const first = pos[0]?.text
  const at = first === 'set' || first === 'add' ? 1 : 0
  const key = pos[at]
  const value = pos[at + 1]
  if (key === undefined || value === undefined || value.dynamic) return undefined
  const m = /^alias\.([^.]+)$/i.exec(key.text)
  if (!m) return undefined
  const v = value.text.trim()
  const inner = v.startsWith('!') ? analyze(v.slice(1), cx.depth + 1, cx.walk) : gitRule([GIT_WORD, ...gitWords(v)], cx, cmd, true, 1, new Map())
  return inner ? `The git alias "${m[1] as string}" would run a refused command: ${inner}` : undefined
}

function copyLikeRule(name: string, argv: ShellWord[], walk: Walk): string | undefined {
  const base = walk.cwd
  const args = argv.slice(1)
  const withArg = new Set(name === 'install' ? ['-m', '-o', '-g', '-t', '-S'] : name === 'rsync' ? ['-e', '--rsh', '--exclude', '--include', '--filter', '-f'] : ['-t', '-S'])
  const operands: ShellWord[] = []
  let targetDir: ShellWord | undefined
  let endOpts = false
  for (let k = 0; k < args.length; k++) {
    const w = args[k] as ShellWord
    const t = w.text
    if (!endOpts && t === '--') { endOpts = true; continue }
    if (!endOpts && t.startsWith('--target-directory=')) { targetDir = { text: t.slice('--target-directory='.length), raw: w.raw, quoted: w.quoted, dynamic: w.dynamic }; continue }
    if (!endOpts && (t === '-t' || t === '--target-directory') && args[k + 1]) { targetDir = args[k + 1] as ShellWord; k++; continue }
    if (!endOpts && t.startsWith('-') && t.length > 1) { if (withArg.has(t)) k++; continue }
    operands.push(w)
  }
  const dest = targetDir ?? (operands.length >= 2 ? operands[operands.length - 1] : undefined)
  const remote = (t: string): boolean => name === 'rsync' && /^[^/]*:/.test(t) && !isWindowsPath(t)
  if (dest && !remote(dest.text)) {
    const bad = forbiddenIn(dest, base)
    if (bad) return bad.startsWith('~') ? credentialReason(bad) : deviceReason(display(argv), bad)
    if (name === 'rsync' && args.some(a => /^--del(?:ete(?:-\w+)?)?$/.test(a.text))) {
      const what = dangerousIn(dest, 'perm', base)
      if (what) return `${q(display(argv))} would delete everything in ${what} that the source does not have; sync into a directory inside the project.`
    }
  }
  if (name === 'mv') {
    for (const src of operands.slice(0, targetDir ? operands.length : -1)) {
      const what = dangerousIn(src, 'perm', base)
      if (what) return `${q(display(argv))} would move ${what} away and break the system or the user's account; move only specific files inside the project.`
    }
  }
  const sources = operands.slice(0, targetDir ? operands.length : -1)
  if (dest && !remote(dest.text)) {
    const inside = dest.text.includes(DYN) ? [] : sources.flatMap(s => {
      const leaf = s.text.replace(/\/+$/, '').split('/').pop() ?? ''
      return leaf === '' || leaf.includes(DYN) || leaf.includes(HOME) || leaf === '.' || leaf === '..' ? [] : [{ ...dest, text: `${dest.text.replace(/\/+$/, '')}/${leaf}` }]
    })
    const self = selfWords([dest, ...inside], display(argv), walk, name === 'rsync' && args.some(a => /^--del(?:ete(?:-\w+)?)?$/.test(a.text)))
      ?? protectedWrite([dest, ...inside], 'write', display(argv), walk)
    if (self) return self
  }
  if (name !== 'mv') return undefined
  return selfWords(sources, display(argv), walk, true) ?? protectedWrite(sources, 'move', display(argv), walk)
}

const ALL_USER_PROCESSES = 'signals every process the user owns and would kill the harness too'

function killRule(argv: ShellWord[]): string | undefined {
  const args = argv.slice(1)
  let k = 0
  let signalSeen = false
  while (k < args.length) {
    const t = (args[k] as ShellWord).text
    if (t === '--') { k++; break }
    if (t === '-s' || t === '-n') { k += 2; signalSeen = true; continue }
    if (!signalSeen && t.startsWith('-') && t.length > 1) { k++; signalSeen = true; continue }
    break
  }
  if (args.slice(k).some(w => w.text === '-1')) return `${q(display(argv))} ${ALL_USER_PROCESSES}; kill specific process ids instead.`
  return undefined
}

const SIGNAL_NAME = /^-(?:\d+|(?:SIG)?(?:HUP|INT|QUIT|ILL|TRAP|ABRT|IOT|EMT|FPE|KILL|BUS|SEGV|SYS|PIPE|ALRM|TERM|URG|STOP|TSTP|CONT|CHLD|CLD|TTIN|TTOU|IO|POLL|XCPU|XFSZ|VTALRM|PROF|WINCH|INFO|PWR|USR1|USR2|RTMIN|RTMAX))$/i
function matchesEverything(p: string): boolean {
  return /^\^?(?:\.[*+]?)?\$?$/.test(p) || p === '.*' || p === '[^]*' || p === '(.*)'
}

function pkillRule(argv: ShellWord[]): string | undefined {
  const WITH_ARG = new Set(['F', 'G', 'M', 'N', 'P', 'U', 'c', 'g', 't', 'u', 's', 'J', 'j'])
  const NARROW = new Set(['F', 'G', 'P', 'c', 'g', 't', 's', 'J', 'j'])
  const LONG_ARG = new Set(['--signal', '--euid', '--uid', '--pgroup', '--parent', '--session', '--terminal', '--pidfile', '--group', '--ns', '--nslist', '--cgroup', '--env'])
  const LONG_NARROW = new Set(['--pgroup', '--parent', '--session', '--terminal', '--pidfile', '--group', '--ns', '--cgroup', '--env'])
  let user = false
  let narrowed = false
  let inverse = false
  const patterns: string[] = []
  const args = argv.slice(1)
  for (let k = 0; k < args.length; k++) {
    const t = (args[k] as ShellWord).text
    if (t === '--') { patterns.push(...args.slice(k + 1).map(w => w.text)); break }
    if (SIGNAL_NAME.test(t)) continue
    if (t.startsWith('--')) {
      const name = t.split('=')[0] as string
      if (name === '--euid' || name === '--uid') user = true
      else if (name === '--inverse') inverse = true
      else if (LONG_NARROW.has(name)) narrowed = true
      if (LONG_ARG.has(name) && !t.includes('=')) k++
      continue
    }
    if (t.startsWith('-') && t.length > 1) {
      const letters = t.slice(1)
      for (let j = 0; j < letters.length; j++) {
        const l = letters[j] as string
        if (l === 'u' || l === 'U') user = true
        else if (l === 'v') inverse = true
        else if (NARROW.has(l)) narrowed = true
        if (WITH_ARG.has(l)) { if (j === letters.length - 1) k++; break }
      }
      continue
    }
    patterns.push(t)
  }
  const reason = `${q(display(argv))} ${ALL_USER_PROCESSES}; kill specific processes by name or id instead.`
  if (inverse) return `${q(display(argv))} signals every process except the ones it names and would kill the harness too; kill specific processes by name or id instead.`
  if (narrowed) return undefined
  if (patterns.some(matchesEverything)) return reason
  if (user && patterns.length === 0) return reason
  return undefined
}

function killallRule(argv: ShellWord[]): string | undefined {
  let user = false
  let narrowed = false
  let regex = false
  let showOnly = false
  const names: string[] = []
  const args = argv.slice(1)
  for (let k = 0; k < args.length; k++) {
    const t = (args[k] as ShellWord).text
    if (t === '--') { names.push(...args.slice(k + 1).map(w => w.text)); break }
    if (SIGNAL_NAME.test(t)) continue
    if (t === '-u' || t === '--user') { user = true; k++; continue }
    if (t === '-t' || t === '-c' || t === '-o' || t === '-y' || t === '-Z' || t === '--older-than' || t === '--younger-than' || t === '--context') { narrowed = true; k++; continue }
    if (t === '-s' || t === '--signal') {
      const nx = args[k + 1]?.text
      if (nx !== undefined && (SIGNAL_NAME.test(`-${nx}`) || /^\d+$/.test(nx))) { k++; continue }
      showOnly = true
      continue
    }
    if (t === '-l' || t === '-help' || t === '--list' || t === '-V' || t === '--version') return undefined
    if (t.startsWith('-') && t.length > 1) {
      if (/[mr]/.test(t.slice(1))) regex = true
      if (/u/.test(t.slice(1))) { user = true; k++ }
      continue
    }
    names.push(t)
  }
  if (showOnly || narrowed) return undefined
  if (user && names.length === 0) return `${q(display(argv))} ${ALL_USER_PROCESSES}; kill specific processes by name instead.`
  if (regex && names.some(matchesEverything)) return `${q(display(argv))} ${ALL_USER_PROCESSES}; kill specific processes by name instead.`
  return undefined
}

interface Interp { name: string; lang: CodeLang; stdin: boolean; inline: ShellWord[]; script?: ShellWord; unreadable?: string }

function isStdinPath(t: string | undefined): boolean {
  return t === '-' || t === '/dev/stdin' || t === '/dev/fd/0'
}

function attached(w: ShellWord, from: number): ShellWord {
  return { text: w.text.slice(from), raw: w.raw.slice(from), quoted: w.quoted, dynamic: w.dynamic, ...(w.vars ? { vars: w.vars } : {}) }
}

function interp(name: string, lang: CodeLang, inline: ShellWord[], script: ShellWord | undefined, stdinWhenNoProgram: boolean): Interp {
  const stdin = script !== undefined ? isStdinPath(script.text) : inline.length === 0 && stdinWhenNoProgram
  return { name, lang, stdin, inline, ...(script !== undefined && !isStdinPath(script.text) ? { script } : {}) }
}

function interpreterOf(argv: ShellWord[]): Interp | undefined {
  const name = commandName(argv[0])
  if (name === undefined) return undefined
  const args = argv.slice(1)
  const inline: ShellWord[] = []
  if (/^(?:python[0-9.]*|pypy[0-9.]*)$/.test(name)) {
    for (let k = 0; k < args.length; k++) {
      const w = args[k] as ShellWord
      const t = w.text
      if (t === '--') return interp(name, 'python', inline, args[k + 1], true)
      if (!t.startsWith('-') || t === '-') return interp(name, 'python', inline, w, true)
      if (t.startsWith('--')) { if (t === '--check-hash-based-pycs') k++; continue }
      const letters = t.slice(1)
      for (let j = 0; j < letters.length; j++) {
        const l = letters[j]
        if (l === 'c') {
          const code = j < letters.length - 1 ? attached(w, j + 2) : args[k + 1]
          if (code) inline.push(code)
          return interp(name, 'python', inline, undefined, false)
        }
        if (l === 'm') return { name, lang: 'python', stdin: false, inline }
        if (l === 'W' || l === 'X') { if (j === letters.length - 1) k++; break }
      }
    }
    return interp(name, 'python', inline, undefined, true)
  }
  if (name === 'node' || name === 'nodejs' || name === 'bun' || name === 'deno') {
    let rest = args
    if (name === 'deno') {
      const sub = rest[0]?.text
      if (sub === 'eval') { const code = rest.find((w, i) => i > 0 && !w.text.startsWith('-')); return { name, lang: 'js', stdin: false, inline: code ? [code] : [] } }
      if (sub !== 'run') return undefined
      rest = rest.slice(1)
    }
    if (name === 'bun') {
      if (rest.length === 0) return undefined
      if (rest[0]?.text === 'run') rest = rest.slice(1)
      else if (['x', 'exec', 'install', 'add', 'remove', 'update', 'test', 'build', 'pm', 'create', 'init', 'link', 'unlink', 'upgrade', 'outdated', 'publish', 'patch'].includes(rest[0]?.text ?? '')) return undefined
    }
    const WITH_ARG = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader', '-C', '--conditions', '--env-file', '--input-type', '--title', '--cwd', '--preload', '--config', '--tsconfig-override', '-c', '--allow-read', '--allow-write'])
    for (let k = 0; k < rest.length; k++) {
      const w = rest[k] as ShellWord
      const t = w.text
      if (t === '--') return interp(name, 'js', inline, rest[k + 1], name !== 'bun')
      if (t === '-e' || t === '--eval' || t === '-p' || t === '--print' || t === '-pe' || t === '-ep') { const code = rest[k + 1]; if (code) inline.push(code); k++; continue }
      if (t.startsWith('--eval=') || t.startsWith('--print=')) { inline.push(attached(w, t.indexOf('=') + 1)); continue }
      if (!t.startsWith('-') || t === '-') {
        if (inline.length > 0) return { name, lang: 'js', stdin: false, inline }
        return interp(name, 'js', inline, w, name !== 'bun')
      }
      if (WITH_ARG.has(t)) k++
    }
    return interp(name, 'js', inline, undefined, name !== 'bun' && name !== 'deno')
  }
  if (/^perl[0-9.]*$/.test(name) || /^ruby[0-9.]*$/.test(name)) {
    const lang: CodeLang = name.startsWith('perl') ? 'perl' : 'ruby'
    const ATTACHED = lang === 'perl' ? new Set(['I', 'M', 'm', 'l', '0', 'i', 'x', 'C', 'd', 'D', 'V', 'F']) : new Set(['x', 'F', '0', 'W', 'T', 'i', 'K'])
    const NEXT = lang === 'ruby' ? new Set(['r', 'I', 'C', 'E']) : new Set<string>()
    for (let k = 0; k < args.length; k++) {
      const w = args[k] as ShellWord
      const t = w.text
      if (t === '--') return interp(name, lang, inline, args[k + 1], true)
      if (!t.startsWith('-') || t === '-') return inline.length > 0 ? { name, lang, stdin: false, inline } : interp(name, lang, inline, w, true)
      if (t.startsWith('--')) continue
      const letters = t.slice(1)
      for (let j = 0; j < letters.length; j++) {
        const l = letters[j] as string
        if (l === 'e' || l === 'E' && lang === 'perl') {
          const code = j < letters.length - 1 ? attached(w, j + 2) : args[k + 1]
          if (code) inline.push(code)
          if (j === letters.length - 1) k++
          break
        }
        if (NEXT.has(l)) { if (j === letters.length - 1) k++; break }
        if (ATTACHED.has(l)) break
      }
    }
    return interp(name, lang, inline, undefined, true)
  }
  if (/^php[0-9.]*$/.test(name)) {
    for (let k = 0; k < args.length; k++) {
      const w = args[k] as ShellWord
      const t = w.text
      if (t === '-r' || t === '-B' || t === '-R' || t === '-E') { const code = args[k + 1]; if (code) inline.push(code); k++; continue }
      if (t === '-f') return interp(name, 'php', inline, args[k + 1], true)
      if (t === '-c' || t === '-d' || t === '-z' || t === '-t' || t === '-S') { k++; continue }
      if (t === '--') return interp(name, 'php', inline, args[k + 1], true)
      if (!t.startsWith('-') || t === '-') return inline.length > 0 ? { name, lang: 'php', stdin: false, inline } : interp(name, 'php', inline, w, true)
    }
    return interp(name, 'php', inline, undefined, true)
  }
  if (/^(?:lua[0-9.]*|luajit)$/.test(name) || name === 'osascript' || name === 'expect') {
    const lang: CodeLang = name === 'osascript' ? 'applescript' : name === 'expect' ? 'tcl' : 'lua'
    const inlineFlag = name === 'expect' ? '-c' : '-e'
    for (let k = 0; k < args.length; k++) {
      const w = args[k] as ShellWord
      const t = w.text
      if (t === inlineFlag) { const code = args[k + 1]; if (code) inline.push(code); k++; continue }
      if (t === '-l' || t === '-s' || t === '-f') { if (t === '-f' && name === 'expect') return interp(name, lang, inline, args[k + 1], true); k++; continue }
      if (t === '--') return interp(name, lang, inline, args[k + 1], true)
      if (!t.startsWith('-') || t === '-') return inline.length > 0 ? { name, lang, stdin: false, inline } : interp(name, lang, inline, w, true)
    }
    return interp(name, lang, inline, undefined, true)
  }
  if (/^(?:tclsh[0-9.]*|wish[0-9.]*)$/.test(name)) {
    const script = args.find(w => !w.text.startsWith('-') || w.text === '-')
    return interp(name, 'tcl', inline, script, true)
  }
  if (name === 'pwsh' || name === 'powershell' || name === 'pwsh-preview' || name === 'powershell_ise') {
    const code = (from: number): Interp => {
      const rest = args.slice(from)
      if (rest.length === 1 && isStdinPath(rest[0]?.text)) return { name, lang: 'powershell', stdin: true, inline }
      if (rest.length > 0) inline.push({ text: rest.map(c => c.text).join(' '), raw: rest.map(c => c.raw).join(' '), quoted: true, dynamic: rest.some(c => c.dynamic) })
      return { name, lang: 'powershell', stdin: false, inline }
    }
    for (let k = 0; k < args.length; k++) {
      const t = (args[k] as ShellWord).text.toLowerCase().replace(/^\//, '-')
      if (t === '-c' || (t.length >= 4 && '-command'.startsWith(t)) || t === '-cwa' || t === '-commandwithargs') return code(k + 1)
      if (t === '-f' || t === '-file') return interp(name, 'powershell', inline, args[k + 1], true)
      if (t === '-e' || t === '-ec' || (t.length >= 3 && '-encodedcommand'.startsWith(t))) {
        const text = args[k + 1]?.text
        const decoded = text !== undefined && !text.includes(DYN) ? decodeEncodedCommand(text) : undefined
        if (decoded === undefined) return { name, lang: 'powershell', stdin: false, inline, unreadable: 'its -EncodedCommand does not decode to readable text' }
        inline.push({ text: decoded, raw: `'${decoded}'`, quoted: true, dynamic: false })
        return { name, lang: 'powershell', stdin: false, inline }
      }
      if (/^-(?:noprofile|nop|noninteractive|noni|nologo|nol|noexit|noe|mta|sta|interactive|i|login|l)$/.test(t)) continue
      if (/^-(?:executionpolicy|ex|ep|windowstyle|w|inputformat|in|if|outputformat|o|of|workingdirectory|wd|configurationname|config|settingsfile|settings|version|v|psconsolefile)$/.test(t)) { k++; continue }
      if (!t.startsWith('-')) return code(k)
    }
    return interp(name, 'powershell', inline, undefined, true)
  }
  if (/^(?:awk|gawk|mawk|nawk)$/.test(name)) {
    for (let k = 0; k < args.length; k++) {
      const w = args[k] as ShellWord
      const t = w.text
      if (t === '-f' || t === '--file') return isStdinPath(args[k + 1]?.text) ? { name, lang: 'awk', stdin: true, inline } : { name, lang: 'awk', stdin: false, inline }
      if (t === '-F' || t === '-v' || t === '--assign' || t === '--field-separator') { k++; continue }
      if (t === '--') { const prog = args[k + 1]; return { name, lang: 'awk', stdin: false, inline: prog ? [prog] : [] } }
      if (t.startsWith('-') && t.length > 1) continue
      return { name, lang: 'awk', stdin: false, inline: [w] }
    }
    return undefined
  }
  return undefined
}

function sourcesStdin(name: string | undefined, argv: ShellWord[]): boolean {
  return (name === 'source' || name === '.') && isStdinPath(argv[1]?.text)
}

function codeReason(code: string, lang: CodeLang, cx: Cx): string | undefined {
  if (typeof code !== 'string' || code.trim() === '') return undefined
  if (cx.depth > 6) return TOO_DEEP
  for (const op of scanCode(code, lang)) {
    if (op.kind === 'unreadable') return `The guard could not check all of the ${lang === 'unknown' ? '' : `${lang} `}code this command runs (${op.why}); run it in smaller steps.`
    if (op.kind === 'shell') {
      const r = analyze(op.command, cx.depth + 1, cx.walk)
      if (r) return r
      continue
    }
    if (op.kind === 'delete-tree' && op.target !== undefined) {
      const what = catastrophicPath(op.target, 'rm')
      if (what) return `${q(op.api)} would delete ${what}; delete only the specific paths you need, inside the project.`
    }
    if (op.kind === 'move' && op.src !== undefined) {
      const what = catastrophicPath(op.src, 'perm')
      if (what) return `${q(op.api)} would move ${what} away and break the system or the user's account; move only specific files inside the project.`
    }
    const dst = op.kind === 'write' ? op.target : op.kind === 'move' ? op.dst : undefined
    if (dst !== undefined) {
      const bad = forbiddenWritePath(dst)
      if (bad) return bad.startsWith('~') ? credentialReason(bad) : deviceReason(op.api, bad)
    }
    const touched: Array<[string | undefined, boolean]> = op.kind === 'move' ? [[op.dst, false], [op.src, true]]
      : op.kind === 'write' || op.kind === 'delete' ? [[op.target, false]] : op.kind === 'delete-tree' ? [[op.target, true]] : []
    for (const [p, ancestor] of touched) {
      const self = p === undefined ? undefined : selfWords([pathWord(p)], op.api, cx.walk, ancestor)
      if (self) return self
    }
  }
  return undefined
}

function runsDownloader(src: string, depth = 0): boolean {
  if (depth > 4) return true
  const { script, subs } = parseShell(src)
  for (const c of simpleCommands(script)) {
    const u = unwrap(c.words)
    const n = commandName(u.argv[0])
    if (n !== undefined && DOWNLOADERS.has(n)) return true
    if (u.scripts.some(s => runsDownloader(s, depth + 1))) return true
  }
  return subs.some(s => runsDownloader(s, depth + 1))
}

function expandsDownload(raw: string): boolean {
  return parseShell(raw).subs.some(s => runsDownloader(s))
}

const FETCH_REASON = 'Running a script straight from the network executes unreviewed remote code; download it to a file, read it, then run it.'

const VISIT_DONE = '\u0000visit-done'

function visited(argv: readonly ShellWord[], walk: Walk): boolean {
  return walk.visit !== undefined && walk.visit(argv)
}

function checkCommand(u: Unwrapped, cmd: SimpleCommand, cx: Cx): string | undefined {
  const argv = u.argv
  if (visited(argv, cx.walk)) return VISIT_DONE
  if (u.tooDeep === true) return TOO_DEEP
  const shown = display(argv.length > 0 ? argv : cmd.words)
  const base = cx.walk.cwd
  const visible = (): string => visibleText(cmd, cx.history, cx.walk)
  const red = checkRedirects(cmd.redirects, shown, cx.walk, visible)
  if (red) return red
  const before = cmd.words.slice(0, Math.max(0, cmd.words.length - argv.length))
  const off = selfDisabling(argv, shown, [...cmd.assigns, ...before], cx.walk.env)
  if (off) return `${q(shown)} ${off}`
  if (consentRunCall(argv)) return CONSENT_RUN_REASON
  const name = commandName(argv[0])
  if (name === undefined) return undefined
  const args = argv.slice(1)
  const native = windowsNative(name, args)
  if (native === 'disk') return `${q(shown)} formats a disk or partition and destroys its data; ask the user to run it themselves if it is really needed.`
  if (native !== undefined) return checkCommand(unwrap(native), { assigns: [], words: native, redirects: cmd.redirects }, cx)
  switch (name) {
    case 'cmd': return cmdRule(args, cx)
    case 'rm': return rmRule(argv, cx.walk)
    case 'unlink': case 'rmdir': case 'shred': case 'srm': return unlinkRule(argv, cx.walk)
    case 'chmod': case 'chown': case 'chgrp': case 'chflags': return permRule(name, argv, cx.walk)
    case 'truncate': return truncateRule(argv, cx.walk)
    case 'sed': case 'gsed': return inPlaceRule(name, argv, cx.walk)
    case 'curl': case 'wget': return downloadRule(name, argv, cx.walk)
    case 'find': {
      const r = findRule(argv, cx.walk)
      if (r) return r
      for (const e of findExecs(args)) {
        const u = unwrap(e)
        const inner = checkCommand(u, { assigns: [], words: e, redirects: [] }, cx)
        if (inner) return inner
        for (const s of u.scripts) {
          const nested = analyze(s, cx.depth + 1, cx.walk)
          if (nested) return nested
        }
      }
      return undefined
    }
    case 'dd': return ddRule(argv, cx.walk)
    case 'git': return gitRule(argv, cx, cmd)
    case 'tee': case 'sponge': {
      for (const a of args) {
        if (a.text.startsWith('-')) continue
        const bad = forbiddenIn(a, base)
        if (bad) return bad.startsWith('~') ? credentialReason(bad) : deviceReason(shown, bad)
      }
      const files = args.filter(a => !a.text.startsWith('-'))
      return selfWords(files, shown, cx.walk) ?? protectedWrite(files, 'write', shown, cx.walk, visible)
    }
    case 'cp': case 'mv': case 'install': case 'ln': case 'rsync': case 'ditto': return copyLikeRule(name, argv, cx.walk)
    case 'diskutil': {
      const ops = args.filter(a => !a.text.startsWith('-')).map(a => a.text.toLowerCase())
      const sub = ops[0] ?? ''
      const erases = sub.startsWith('erase') || ['zerodisk', 'randomdisk', 'secureerase', 'partitiondisk', 'reformat'].includes(sub)
        || (sub === 'apfs' && /^(?:delete|erase)/.test(ops[1] ?? ''))
      return erases ? `${q(shown)} erases a disk or volume and destroys its data; ask the user to do it themselves.` : undefined
    }
    case 'security':
      return (args[0]?.text ?? '').startsWith('delete-') ? `${q(shown)} removes items from the user's keychain; ask the user to do it themselves.` : undefined
    case 'kill': return killRule(argv)
    case 'pkill': return pkillRule(argv)
    case 'killall': return killallRule(argv)
    case 'killall5': return `${q(shown)} ${ALL_USER_PROCESSES}; kill specific process ids instead.`
    case 'shutdown': case 'reboot': case 'halt': case 'poweroff':
      return `${q(shown)} would turn off or restart the user's machine; ask the user to do it themselves.`
    case 'systemctl':
      return args.some(a => ['reboot', 'poweroff', 'halt', 'kexec'].includes(a.text)) ? `${q(shown)} would turn off or restart the machine; ask the user to do it themselves.` : undefined
    case 'launchctl':
      return args[0]?.text === 'reboot' ? `${q(shown)} would restart the machine; ask the user to do it themselves.` : undefined
    case 'crontab':
      return args.some(a => /^-[a-z]*r/.test(a.text)) ? '`crontab -r` deletes all of the user\'s cron jobs; edit the specific entry with `crontab -e` or ask the user.' : undefined
    case 'gh':
      return args[0]?.text === 'repo' && args[1]?.text === 'delete' ? `${q(shown)} permanently deletes a GitHub repository; ask the user to do it themselves.` : undefined
    case 'source': case '.':
      if (args[0] && args[0].dynamic && expandsDownload(args[0].raw)) return FETCH_REASON
      return args[0] && args[0].dynamic ? echoedScriptReason(args[0].raw, cx) : undefined
    case 'alias': {
      for (const a of args) {
        const eq = a.text.indexOf('=')
        if (eq <= 0 || a.dynamic) continue
        const r = analyze(a.text.slice(eq + 1), cx.depth + 1, cx.walk)
        if (r) return `The shell alias "${a.text.slice(0, eq)}" would run a refused command: ${r}`
      }
      return undefined
    }
    default:
      break
  }
  if (name.startsWith('mkfs') || name.startsWith('newfs')) {
    return `${q(shown)} formats a disk or partition and destroys its data; ask the user to run it themselves if it is really needed.`
  }
  if (/^(?:perl|ruby)[0-9.]*$/.test(name)) return inPlaceRule(name, argv, cx.walk)
  return undefined
}

function analyze(src: string, depth: number, walk: Walk): string | undefined {
  if (depth > MAX_DEPTH) return TOO_DEEP
  if (FORK_BOMB.test(src) || PERL_FORK_BOMB.test(src)) return 'This is a fork bomb that would hang the machine; do not run it.'
  const { script, subs, truncated } = parseShell(src)
  const r = analyzeScript(script, depth, walk)
  if (r) return r
  for (const s of subs) {
    const inner = analyze(s, depth + 1, walk)
    if (inner) return inner
  }
  return truncated === true ? TOO_DEEP : undefined
}

function analyzeWindows(src: string, dialect: Dialect, depth: number, walk: Walk, lenient = false, item?: string): string | undefined {
  if (depth > MAX_DEPTH) return TOO_DEEP
  const t = dialect === 'cmd' ? translateCmd(src) : translatePowerShell(src, { lenient, vars: walk.psVars ??= new Map(), ...(item !== undefined ? { item } : {}) })
  if (t.fetch === true) return FETCH_REASON
  const r = analyzeScript(t.script, depth, walk)
  if (r) {
    for (const o of t.origins) {
      const restated = q(display(o.cmd.words))
      if (r.includes(restated)) return r.replace(restated, q(clip(o.text.replace(/\s+/g, ' ').trim())))
    }
    return r
  }
  for (const n of t.nested) {
    const inner = analyzeWindows(n.src, n.dialect, depth + 1, walk, lenient && n.dialect === 'powershell', n.item)
    if (inner) return inner
  }
  return 'truncated' in t && t.truncated === true ? TOO_DEEP : undefined
}

function cmdRule(args: ShellWord[], cx: Cx): string | undefined {
  const at = args.findIndex(a => /^(?:\/{1,2}|-)[ck]$/i.test(a.text))
  if (at < 0) return undefined
  const rest = args.slice(at + 1)
  if (rest.length === 0) return undefined
  return analyzeWindows(rest.map(w => (w.dynamic ? w.raw : w.text)).join(' '), 'cmd', cx.depth + 1, cx.walk)
}

const ENVIRONMENT_KEY = /^(?:hkcu|hkey_current_user|hklm|hkey_local_machine)[\\/]?(?:system[\\/]currentcontrolset[\\/]control[\\/]session manager[\\/])?environment[\\/]?$/i

// Windows programs every shell can start: they restate as the POSIX commands with the same effect.
function windowsNative(name: string, args: ShellWord[]): ShellWord[] | 'disk' | undefined {
  const flags = args.map(a => a.text.toLowerCase().replace(/^\/\//, '/'))
  if (flags.includes('/?')) return undefined
  const word = (t: string): ShellWord => ({ text: t, raw: t, quoted: false, dynamic: false })
  if (name === 'format' && args.some(a => /^[a-z]:\\?$/i.test(a.text))) return 'disk'
  if (name === 'diskpart') return 'disk'
  if (name === 'reg' && flags[0] === 'add' && ENVIRONMENT_KEY.test(args[1]?.text ?? '')) {
    const v = flags.indexOf('/v')
    const value = v >= 0 ? args[v + 1] : undefined
    return value !== undefined ? [word('setx'), value] : undefined
  }
  if (name === 'robocopy') {
    const operands = args.filter(a => !/^\/{1,2}[a-z]/i.test(a.text))
    const [src, dst] = operands
    if (src === undefined || dst === undefined) return undefined
    if (flags.includes('/mir') || flags.includes('/purge')) return [word('rsync'), word('-a'), word('--delete'), src, dst]
    if (flags.includes('/move') || flags.includes('/mov')) return [word('mv'), src, dst]
    return [word('cp'), word('-r'), src, dst]
  }
  return undefined
}

function echoedText(src: string): string | undefined {
  const cmds = simpleCommands(parseShell(src).script)
  if (cmds.length === 0) return undefined
  const parts: string[] = []
  for (const c of cmds) {
    const u = unwrap(c.words)
    const n = commandName(u.argv[0])
    if (n !== 'echo' && n !== 'printf') return undefined
    parts.push(u.argv.slice(1).filter(w => !/^-[neE]+$/.test(w.text)).map(w => w.text).join(' ').replace(/\\n/g, '\n'))
  }
  return parts.join('\n')
}

function echoedScriptReason(raw: string, cx: Cx, lang?: CodeLang): string | undefined {
  for (const sub of parseShell(raw).subs) {
    const text = echoedText(sub)
    if (text === undefined) continue
    const r = lang === undefined ? analyze(text, cx.depth + 1, cx.walk) : codeReason(text, lang, cx)
    if (r) return r
  }
  return undefined
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

export function decodeBase64(s: string): string | undefined {
  const t = s.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '')
  if (t === '' || t.length > 65_536 || /[^A-Za-z0-9+/]/.test(t) || t.length % 4 === 1) return undefined
  const bytes: number[] = []
  let buf = 0
  let bits = 0
  for (const ch of t) {
    buf = (buf << 6) | B64.indexOf(ch)
    bits += 6
    if (bits >= 8) { bits -= 8; bytes.push((buf >> bits) & 0xff) }
  }
  for (const b of bytes) if (b === 0 || (b < 0x20 && b !== 0x0a && b !== 0x09 && b !== 0x0d)) return undefined
  return utf8(bytes)
}

function utf8(bytes: number[]): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] as number
    const need = b < 0x80 ? 0 : b >= 0xf0 && b < 0xf8 ? 3 : b >= 0xe0 ? 2 : b >= 0xc0 ? 1 : -1
    if (need < 0) { out += '\uFFFD'; continue }
    let cp = need === 0 ? b : b & (0x3f >> need)
    let ok = true
    for (let k = 1; k <= need; k++) {
      const c = bytes[i + k]
      if (c === undefined || (c & 0xc0) !== 0x80) { ok = false; break }
      cp = (cp << 6) | (c & 0x3f)
    }
    if (!ok || cp > 0x10ffff) { out += '\uFFFD'; continue }
    out += String.fromCodePoint(cp)
    i += need
  }
  return out
}

function decodeHex(s: string): string | undefined {
  const t = s.replace(/\s+/g, '')
  if (t === '' || t.length % 2 !== 0 || /[^0-9a-fA-F]/.test(t) || t.length > 131_072) return undefined
  let out = ''
  for (let i = 0; i < t.length; i += 2) out += String.fromCharCode(parseInt(t.slice(i, i + 2), 16))
  return out
}

function decodedFeed(history: SimpleCommand[][]): string | undefined {
  const last = history[history.length - 1]
  const before = history[history.length - 2]
  if (last === undefined || before === undefined || last.length !== 1 || before.length !== 1) return undefined
  const u = unwrap((last[0] as SimpleCommand).words)
  const n = commandName(u.argv[0])
  const flags = u.argv.slice(1).map(w => w.text)
  const b64 = (n === 'base64' || n === 'gbase64') && flags.some(f => f === '-d' || f === '-D' || f === '--decode')
  const b64ssl = n === 'openssl' && flags[0] === 'base64' && flags.includes('-d')
  const hex = n === 'xxd' && flags.some(f => /^-[a-z]*r/.test(f)) && flags.some(f => /^-[a-z]*p/.test(f))
  if (!b64 && !b64ssl && !hex) return undefined
  const text = echoedText((before[0] as SimpleCommand).words.map(w => w.raw).join(' '))
  if (text === undefined) return undefined
  return hex ? decodeHex(text) : decodeBase64(text)
}

function xargsReason(cmd: SimpleCommand, u: Unwrapped, history: SimpleCommand[][], cx: Cx): string | undefined {
  const wrappers = cmd.words.slice(0, cmd.words.length - u.argv.length)
  if (!wrappers.some(w => commandName(w) === 'xargs') || u.argv.length === 0) return undefined
  const items: ShellWord[] = []
  const split = wrappers.some(w => /^-(?:0|d.*)$|^--(?:null|delimiter)/.test(w.text)) ? undefined
    : wrappers.some(w => /^-[IiL]|^--(?:replace|max-lines)/.test(w.text)) ? /\n+/ : /\s+/
  for (const red of cmd.redirects) {
    if (red.op !== '<<<' || red.target === undefined) continue
    const t = red.target
    if (split === undefined || t.text.includes(DYN) || !split.test(t.text.trim())) { items.push(t); continue }
    for (const part of t.text.trim().split(split)) items.push({ text: part, raw: rawFromText(part, undefined), quoted: true, dynamic: false })
  }
  const prev = history[history.length - 1] ?? []
  for (const p of prev) {
    const pu = unwrap(p.words)
    const pn = commandName(pu.argv[0])
    if (pn === 'echo' || pn === 'printf') items.push(...pu.argv.slice(1).filter(w => !/^-[neE]+$/.test(w.text)))
    if (pn === 'find' && runsRemoval(u.argv.map(w => w.raw).join(' '))) {
      const roots = pu.argv.slice(1).filter(w => !w.text.startsWith('-') && w.text !== '(' && w.text !== '!')
      for (const r of roots.slice(0, roots.findIndex(w => w.text.startsWith('-')) < 0 ? roots.length : undefined)) {
        const what = dangerousTarget(r, 'find') ?? vaultTarget(r, cx.walk)
        if (what) return `${q(display([...pu.argv]))} | xargs ${q(display(u.argv))} would delete files across ${what}; limit the search to a directory inside the project.`
      }
    }
  }
  if (items.length === 0) return undefined
  const argv = [...u.argv, ...items]
  return checkCommand(unwrap(argv), { assigns: [], words: argv, redirects: [] }, cx)
}

function stdinFeeds(cmd: SimpleCommand, history: SimpleCommand[][], check: (text: string) => string | undefined): string | undefined {
  const previous = history[history.length - 1] ?? []
  const decoded = decodedFeed(history)
  if (decoded !== undefined) {
    const r = check(decoded)
    if (r) return r
  }
  for (const red of cmd.redirects) {
    if (red.op === '<<<' && red.target !== undefined) {
      if (red.target.dynamic && expandsDownload(red.target.raw)) return FETCH_REASON
      const r = check(red.target.text)
      if (r) return r
    } else if ((red.op === '<<' || red.op === '<<-') && red.body !== undefined) {
      if (red.bodyExpands === true && expandsDownload(red.body)) return FETCH_REASON
      const r = check(red.body)
      if (r) return r
    } else if (red.op === '<' && red.target !== undefined && red.target.dynamic && expandsDownload(red.target.raw)) {
      return FETCH_REASON
    }
  }
  for (const prev of previous) {
    const pu = unwrap(prev.words)
    const pn = commandName(pu.argv[0])
    if (pn === 'echo' || pn === 'printf') {
      const text = pu.argv.slice(1).filter(w => !/^-[neE]+$/.test(w.text)).map(w => w.text).join(' ')
      const r = check(text.replace(/\\n/g, '\n'))
      if (r) return r
    }
  }
  return undefined
}

function topLevelCommands(script: Script): SimpleCommand[] {
  const out: SimpleCommand[] = []
  for (const pl of script.pipelines) for (const st of pl.stages) if (st.kind === 'cmd') out.push(st.cmd)
  return out
}

function stdinChecks(cmd: SimpleCommand, u: Unwrapped, name: string | undefined, it: Interp | undefined, downloader: boolean, history: SimpleCommand[][], cx: Cx): string | undefined {
  if (u.shellReadsStdin || sourcesStdin(name, u.argv)) {
    if (downloader) return 'Piping a download straight into a shell runs unreviewed remote code; save it to a file, read it, then run it.'
    return stdinFeeds(cmd, history, text => analyze(text, cx.depth + 1, cx.walk))
  }
  if (it !== undefined && it.stdin) {
    if (downloader) return `Piping a download straight into ${it.name} runs unreviewed remote code; save it to a file, read it, then run it.`
    return stdinFeeds(cmd, history, text => (it.lang === 'powershell' ? analyzeWindows(text, 'powershell', cx.depth + 1, cx.walk) : undefined) ?? codeReason(text, it.lang, cx))
  }
  return undefined
}

function analyzeScript(script: Script, depth: number, walk: Walk): string | undefined {
  const cx: Cx = { walk, depth }
  for (const pl of script.pipelines) {
    let downloader = false
    const history: SimpleCommand[][] = []
    for (const stage of pl.stages) {
      if (stage.kind === 'group') {
        const cwd = walk.cwd
        const inner = analyzeScript(stage.body, depth + 1, walk)
        if (inner) return inner
        if (cwd === undefined) delete walk.cwd
        else walk.cwd = cwd
        const red = checkRedirects(stage.redirects, '( … )', walk, () => simpleCommands(stage.body).map(c => visibleText(c, undefined)).join('\n'))
        if (red) return red
      }
      const cmds = (stage.kind === 'cmd' ? [stage.cmd] : topLevelCommands(stage.body)).map(c => resolveCommand(c, walk))
      for (const cmd of cmds) {
        const u = unwrap(cmd.words)
        const name = commandName(u.argv[0])
        const isShell = name !== undefined && SHELL_NAMES.has(name)
        const it = isShell ? undefined : interpreterOf(u.argv)
        if (stage.kind === 'group') {
          const r = stdinChecks(cmd, u, name, it, downloader, history, cx)
          if (r) return r
          continue
        }
        walk.lines.push(u.argv.map(w => (w.dynamic ? w.raw : w.text)).join(' '))
        const r = checkCommand(u, cmd, { walk, depth, history })
        if (r) return r
        if ((isShell || name === 'eval' || u.argv.length === 0) && u.scripts.length > 0) {
          for (const s of u.scripts) {
            if (/[$`]/.test(s) && /^\s*["'$<`]/.test(s) && expandsDownload(s)) return FETCH_REASON
          }
        }
        if (isShell && !u.shellReadsStdin && u.scripts.length === 0) {
          const operand = u.argv.slice(1).find(w => !w.text.startsWith('-'))
          if (operand && operand.dynamic && expandsDownload(operand.raw)) return FETCH_REASON
          if (operand && operand.dynamic) {
            const r = echoedScriptReason(operand.raw, cx)
            if (r) return r
          }
        }
        for (const s of u.scripts) {
          const inner = analyze(s, depth + 1, walk)
          if (inner) return inner
          if (/[$`]/.test(s)) {
            const r = echoedScriptReason(s, cx)
            if (r) return r
          }
        }
        const xr = xargsReason(cmd, u, history, cx)
        if (xr) return xr
        const sr = stdinChecks(cmd, u, name, it, downloader, history, cx)
        if (sr) return sr
        if (it !== undefined) {
          if (it.unreadable !== undefined) return `The guard could not check the code this command runs (${it.unreadable}); run it in smaller steps.`
          for (const code of it.inline) {
            if (code.dynamic && expandsDownload(code.raw)) return FETCH_REASON
            const ps = it.lang === 'powershell' ? analyzeWindows(code.text, 'powershell', depth + 1, walk) : undefined
            if (ps) return ps
            const r = codeReason(code.text, it.lang, cx)
            if (r) return r
          }
          if (it.script !== undefined && it.script.dynamic) {
            if (expandsDownload(it.script.raw)) return FETCH_REASON
            const r = echoedScriptReason(it.script.raw, cx, it.lang)
            if (r) return r
          }
        }
        recordAssignments(stage.cmd, walk)
        recordDirectory(cmd, walk)
      }
      if (cmds.some(c => { const n = commandName(unwrap(c.words).argv[0]); return n !== undefined && DOWNLOADERS.has(n) })) downloader = true
      history.push(cmds)
    }
  }
  return undefined
}

const patternCache = new Map<string, RegExp | null>()

function compile(pattern: string): RegExp | null {
  const cached = patternCache.get(pattern)
  if (cached !== undefined) return cached
  let re: RegExp | null = null
  try {
    const m = /^\/(.+)\/([dgimsuvy]*)$/s.exec(pattern)
    re = m ? new RegExp(m[1] as string, (m[2] as string).replace(/[gy]/g, '')) : new RegExp(pattern)
  } catch {
    re = null
  }
  if (patternCache.size > 256) patternCache.clear()
  patternCache.set(pattern, re)
  return re
}

function fallbackScreen(command: string): string {
  if (/\brm\s+(?:-[A-Za-z]*\s+)*-[A-Za-z]*[rR][A-Za-z]*\s+(?:-[A-Za-z-]+\s+)*(?:["']?(?:\/|~|\$HOME|\$\{HOME\}|[A-Za-z]:[\\/]?)[\\/]?["']?)(?:\s|$)/.test(command)) {
    return 'This command would recursively delete the filesystem root or your home directory; remove only the specific paths you need.'
  }
  if (/\b(?:curl|wget)\b[^|]*\|\s*(?:sudo\s+)?(?:ba|z|da|k)?sh\b/.test(command)) {
    return 'Piping a download straight into a shell runs unreviewed remote code; save it to a file, read it, then run it.'
  }
  return 'The guard could not read this command (it is nested too deeply); split it into simpler commands.'
}

function newWalk(opts?: { home?: unknown, selfPaths?: unknown, cwd?: unknown, vault?: unknown, protect?: unknown, buracleRepo?: unknown, realpath?: unknown }): Walk {
  const walk: Walk = { lines: [], env: new Map([['HOME', HOME], ['PWD', '.']]), budget: MAX_SUBST, home: '' }
  if (typeof opts?.home === 'string' && isAbsPath(opts.home)) walk.home = isWindowsPath(opts.home) ? normalizePath(opts.home) : opts.home
  if (opts?.selfPaths !== null && typeof opts?.selfPaths === 'object') walk.selfPaths = opts.selfPaths as SelfPaths
  const cwd = opts?.cwd
  if (typeof cwd === 'string' && isAbsPath(cwd) && !cwd.includes(DYN) && !cwd.includes(HOME)) {
    walk.cwd = normalizePath(cwd)
    walk.session = walk.cwd
  }
  if (isWindowsPath(walk.home) || (walk.cwd !== undefined && isWindowsPath(walk.cwd))) {
    walk.windows = true
    walk.env.set('USERPROFILE', HOME)
  }
  if (typeof opts?.vault === 'string' && opts.vault !== '') walk.vault = opts.vault
  if (Array.isArray(opts?.protect)) walk.protect = opts.protect.filter((x): x is string => typeof x === 'string')
  if (typeof opts?.buracleRepo === 'string' && opts.buracleRepo !== '') walk.buracleRepo = opts.buracleRepo
  if (typeof opts?.realpath === 'function') walk.realpath = opts.realpath as (p: string) => string | undefined
  return walk
}

// The shell a command line is written for: the POSIX shell unless the harness says PowerShell or
// cmd (the Claude Code PowerShell tool). A POSIX line that looks like PowerShell is read both ways.
export type ShellDialect = 'posix' | 'powershell' | 'cmd'

export interface BashGuardOptions {
  extraDeny: string[]; home?: string; selfPaths?: SelfPaths; cwd?: string
  vault?: string; protect?: string[]; buracleRepo?: string; realpath?: (p: string) => string | undefined
  shell?: ShellDialect
}

function dialectOf(x: unknown): Dialect | undefined {
  return x === 'powershell' || x === 'cmd' ? x : undefined
}

function analyzeCommand(command: string, opts: BashGuardOptions | undefined, walk: Walk, fresh: () => Walk): string | undefined {
  const dialect = dialectOf(opts?.shell)
  if (dialect !== undefined) return analyzeWindows(command, dialect, 0, walk)
  return analyze(command, 0, walk) ?? (looksLikePowerShell(command) ? analyzeWindows(command, 'powershell', 0, fresh(), true) : undefined)
}

export function checkBash(command: string, cfg: { extraDeny: string[] }): { deny?: string } {
  if (typeof command !== 'string' || command.trim() === '') return {}
  const opts = cfg !== null && typeof cfg === 'object' ? cfg as BashGuardOptions : undefined
  const walk = newWalk(opts)
  let reason: string | undefined
  try {
    reason = analyzeCommand(command, opts, walk, () => {
      const w = newWalk(opts)
      w.lines = walk.lines
      return w
    })
  } catch {
    reason = fallbackScreen(command)
  }
  if (reason) return { deny: reason }
  if (uiSettingsCall([command, ...walk.lines], true)) return { deny: UI_SETTINGS_REASON }
  const extra = extraDenyReason(cfg?.extraDeny, [command, ...walk.lines])
  return extra !== undefined ? { deny: extra } : {}
}

export function extraDenyReason(patterns: readonly string[] | undefined, texts: readonly string[]): string | undefined {
  for (const pattern of Array.isArray(patterns) ? patterns : []) {
    if (typeof pattern !== 'string' || pattern.trim() === '') continue
    const re = compile(pattern)
    if (re !== null && texts.some(t => re.test(t))) return `Blocked by the guards.bash.extraDeny pattern ${q(pattern)} in your Buracle config; ask the user before running this command.`
  }
  return undefined
}

export function visitShellCommands(command: string, visit: (argv: readonly ShellWord[]) => boolean, opts?: { shell?: ShellDialect }): void {
  if (typeof command !== 'string' || command.trim() === '' || typeof visit !== 'function') return
  const visitor = (argv: readonly ShellWord[]): boolean => {
    try { return visit(argv) === true } catch { return false }
  }
  const walked = (): Walk => {
    const w = newWalk()
    w.visit = visitor
    return w
  }
  try {
    analyzeCommand(command, { extraDeny: [], ...(opts?.shell !== undefined ? { shell: opts.shell } : {}) }, walked(), walked)
  } catch {  }
}
