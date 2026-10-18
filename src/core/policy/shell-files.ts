import type { Redirect, Script, ShellWord, SimpleCommand } from './shell'
import { commandName, DYN, HOME, parseShell, unwrap } from './shell'

export interface ShellFileWrite { label: string; file?: string }
export interface ShellScope { cwd?: string; root?: string; home?: string }
type Base = { path: string } | 'temp' | 'unknown'
interface Scope extends ShellScope { base?: Base; found?: boolean }

const WRITE_REDIRECTS = new Set(['>', '>>', '>|', '&>', '&>>'])
const TEMP_PREFIX = /^(?:\/tmp\/|\/private\/tmp\/|\/var\/folders\/|\/private\/var\/folders\/|\/dev\/|\/proc\/)/
const TEMP_ROOT = /^(?:\/tmp|\/private\/tmp|\/var\/folders(?:\/[^/]+){0,3}|\/private\/var\/folders(?:\/[^/]+){0,3})$/
const DEVICE_PREFIX = /^\/(?:dev|proc)\//
const POSITIONAL = /^\$\{?(?:[0-9]|@|\*)\}?$/
const SYSTEM_PREFIX = /^(?:\/etc\/|\/private\/etc\/|\/usr\/|\/System\/|\/Library\/|[A-Za-z]:\/(?:Windows|Program Files|Program Files \(x86\)|ProgramData)\/)/i
const TEMP_VARS = new Set(['TMPDIR', 'TMP', 'TEMP', 'RUNNER_TEMP', 'XDG_RUNTIME_DIR'])
const INTERPRETER = /^(?:python[0-9.]*|pypy[0-9.]*|node|nodejs|bun|deno|ruby|perl[0-9.]*)$/
const WRITE_IDIOM = /write_text\(|write_bytes\(|open\([^)]*['"](?:[wax]\+?b?|r\+b?)['"]|open\([^)]*['"]>|writeFileSync|writeFile\(|appendFileSync|appendFile\(|createWriteStream\(|Bun\.write\(|Deno\.write|File\.(?:write|open)\(|IO\.write\(|shutil\.(?:copy|move)|os\.replace\(|os\.rename\(|\.to_csv\(|json\.dump\(/
const IN_PLACE: Readonly<Record<string, RegExp>> = { sed: /^-[nErsuzE]*i/, perl: /^-[npaslw0-9]*i/, ruby: /^-[npalswvd]*i/ }
const SELF = new Set(['buracle'])
const CODE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  sed: new Set(['-e', '-f', '--expression', '--file']),
  perl: new Set(['-e', '-E']),
  ruby: new Set(['-e']),
  awk: new Set(['-e', '-E', '-f', '--file', '--source']),
}
const CODE_CLUSTER: Readonly<Record<string, RegExp>> = { sed: /^-[A-Za-z]+e$/, perl: /^-[A-Za-z0-9]+[eE]$/, ruby: /^-[A-Za-z0-9]+e$/ }
const EXEC_FLAGS = new Set(['-exec', '-execdir', '-ok', '-okdir'])
const FIND_PLACEHOLDER = '{}'

function words(cmd: SimpleCommand): ShellWord[] {
  return unwrap(cmd.words).argv
}

function tempWord(w: ShellWord): boolean {
  const t = w.text
  if (t.startsWith(DYN)) {
    const name = w.vars?.[0]?.name
    return name !== undefined && TEMP_VARS.has(name)
  }
  return TEMP_PREFIX.test(t) || t === '/dev/null'
}

function shownPath(w: ShellWord): string {
  return w.text.replace(HOME, '~')
}

function lexical(p: string): string {
  const s = p.replace(/\\/g, '/')
  const lead = /^(?:[A-Za-z]:)?\//.exec(s)?.[0] ?? ''
  const parts: string[] = []
  for (const seg of s.slice(lead.length).split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') { if (parts.length > 0) parts.pop(); continue }
    parts.push(seg)
  }
  return lead + parts.join('/')
}

function area(dir: string | undefined): string | undefined {
  if (dir === undefined || dir.trim() === '') return undefined
  const d = lexical(dir).replace(/\/+$/, '')
  return d === '' || /^[A-Za-z]:$/.test(d) ? undefined : d
}

function within(p: string, d: string | undefined): boolean {
  if (d === undefined) return false
  const ci = /^[A-Za-z]:/.test(d)
  const a = ci ? p.toLowerCase() : p
  const b = ci ? d.toLowerCase() : d
  return a === b || a.startsWith(`${b}/`)
}

function absolute(p: string): boolean {
  return /^(?:[A-Za-z]:)?[\\/]/.test(p)
}

function baseOf(scope: Scope | undefined): Base {
  if (scope?.base !== undefined) return scope.base
  return scope?.cwd !== undefined && absolute(scope.cwd) ? { path: lexical(scope.cwd) } : 'unknown'
}

function afterCd(args: readonly ShellWord[], scope: Scope | undefined): Scope {
  const w = args.filter(a => !/^-[LPe@]+$/.test(a.text) && a.text !== '--')[0]
  const home = area(scope?.home)
  const cur = baseOf(scope)
  let base: Base
  if (w === undefined) base = home !== undefined ? { path: home } : 'unknown'
  else if (w.text.includes(DYN)) base = tempWord(w) ? 'temp' : 'unknown'
  else if (w.text.startsWith(HOME)) base = home !== undefined ? { path: lexical(`${home}/${w.text.slice(HOME.length)}`) } : 'unknown'
  else if (w.text === '-') base = 'unknown'
  else if (absolute(w.text)) base = { path: lexical(w.text) }
  else base = typeof cur === 'object' ? { path: lexical(`${cur.path}/${w.text}`) } : cur
  return { ...scope, base }
}

function outsideProject(text: string, scope: Scope | undefined): boolean {
  const home = area(scope?.home)
  let target: string
  if (text.startsWith(HOME)) {
    const rest = text.slice(HOME.length)
    if (home === undefined) return rest === '' || /^[\\/]\./.test(rest)
    target = lexical(`${home}/${rest}`)
  } else if (absolute(text)) target = lexical(text)
  else {
    const base = baseOf(scope)
    if (base === 'temp') return true
    if (base === 'unknown') return false
    target = lexical(`${base.path}/${text}`)
  }
  const root = area(scope?.root)
  const cwd = area(scope?.cwd)
  const ownRoot = root !== undefined && root !== home && within(target, root)
  if (home !== undefined && within(target, home) && !ownRoot && target.slice(home.length + 1).startsWith('.')) return true
  if (root === undefined && cwd === undefined) return SYSTEM_PREFIX.test(target) || TEMP_PREFIX.test(target)
  return !(within(target, root) || within(target, cwd))
}

function projectTemp(w: ShellWord, scope: Scope | undefined): boolean {
  const t = w.text
  if (t.includes(DYN) || !absolute(t) || DEVICE_PREFIX.test(t)) return false
  const target = lexical(t)
  return [scope?.root, scope?.cwd].some(d => {
    const a = area(d)
    return a !== undefined && !TEMP_ROOT.test(a) && within(target, a)
  })
}

function foundFile(w: ShellWord, scope: Scope | undefined): boolean {
  if (w.text === FIND_PLACEHOLDER) return true
  const vars = w.vars ?? []
  return scope?.found === true && w.dynamic && vars.length > 0 && vars.every(v => v.name === undefined && POSITIONAL.test(v.src ?? ''))
}

function fileTarget(w: ShellWord | undefined, scope: Scope | undefined): ShellWord | undefined {
  if (w === undefined || w.text === '' || w.text === '-' || w.text === FIND_PLACEHOLDER) return undefined
  if (tempWord(w) && !projectTemp(w, scope)) return undefined
  if (w.text.includes(DYN) || outsideProject(w.text, scope)) return undefined
  return w
}

function firstTarget(ws: readonly ShellWord[], scope: Scope | undefined): ShellWord | undefined {
  for (const w of ws) { const t = fileTarget(w, scope); if (t !== undefined) return t }
  return undefined
}

function redirectWrite(redirects: readonly Redirect[], scope: Scope | undefined): ShellFileWrite | undefined {
  for (const r of redirects) {
    if (!WRITE_REDIRECTS.has(r.op) || r.target === undefined) continue
    if (/^&?\d*$/.test(r.target.text)) continue
    const t = fileTarget(r.target, scope)
    if (t !== undefined) return { label: `a \`${r.op}\` redirect`, file: shownPath(t) }
  }
  return undefined
}

function heredocText(cmd: SimpleCommand): string {
  return cmd.redirects.filter(r => r.op === '<<' || r.op === '<<-' || r.op === '<<<').map(r => r.body ?? r.target?.text ?? '').join('\n')
}

function codeFlag(kind: string, text: string): boolean {
  if (CODE_FLAGS[kind]?.has(text) === true) return true
  const cluster = CODE_CLUSTER[kind]
  return cluster !== undefined && cluster.test(text) && !text.slice(1, -1).includes('i')
}

function execScriptWrite(inner: readonly ShellWord[], scope: Scope | undefined, depth: number): ShellFileWrite | undefined {
  for (const s of unwrap([...inner]).scripts) {
    const w = scriptWrite(parseShell(s).script, { ...scope, found: true }, depth + 1)
    if (w !== undefined) return w
  }
  return undefined
}

function execWrite(args: readonly ShellWord[], scope: Scope | undefined, depth: number): ShellFileWrite | undefined {
  for (let i = 0; i < args.length; i++) {
    if (!EXEC_FLAGS.has((args[i] as ShellWord).text)) continue
    const end = args.findIndex((a, j) => j > i && (a.text === ';' || a.text === '+'))
    const inner = args.slice(i + 1, end < 0 ? args.length : end)
    const w = inner.length > 0 ? commandWrite({ assigns: [], words: [...inner], redirects: [] }, scope, depth + 1) ?? execScriptWrite(inner, scope, depth) : undefined
    if (w !== undefined) return { label: `find ${(args[i] as ShellWord).text} ${w.label}`, ...(w.file !== undefined ? { file: w.file } : {}) }
    if (end < 0) break
    i = end
  }
  return undefined
}

function commandWrite(cmd: SimpleCommand, scope: Scope | undefined, depth = 0): ShellFileWrite | undefined {
  const argv = words(cmd)
  const name = commandName(argv[0])
  if (name !== undefined && SELF.has(name)) return undefined
  const redirected = redirectWrite(cmd.redirects, scope)
  if (redirected !== undefined || name === undefined) return redirected
  const args = argv.slice(1)
  if (name === 'find' && depth < 4) return execWrite(args, scope, depth)
  const kind = name === 'gsed' ? 'sed' : name === 'gawk' ? 'awk' : name.replace(/[0-9.]+$/, '')
  const values = new Set(args.flatMap((a, i) => (codeFlag(kind, a.text) ? [i + 1] : [])))
  const operands = args.filter((a, i) => !a.text.startsWith('-') && a.text !== '' && !values.has(i))
  if (name === 'tee' || name === 'sponge') {
    const t = firstTarget(operands, scope)
    return t !== undefined ? { label: name, file: shownPath(t) } : undefined
  }
  const cluster = IN_PLACE[kind]
  if (cluster !== undefined && args.some(a => cluster.test(a.text) || (kind === 'sed' && (a.text === '--in-place' || a.text.startsWith('--in-place='))))) {
    const files = values.size === 0 ? operands.slice(1) : operands
    const t = firstTarget(files, scope)
    if (t !== undefined) return { label: `${kind} -i in place`, file: shownPath(t) }
    return files.some(f => foundFile(f, scope)) ? { label: `${kind} -i in place` } : undefined
  }
  if (kind === 'awk' && args.some((a, i) => (a.text === '-i' && args[i + 1]?.text === 'inplace') || a.text === '--include=inplace')) {
    const data = operands.filter(a => a.text !== 'inplace')
    const t = firstTarget(values.size === 0 ? data.slice(1) : data, scope)
    return t !== undefined ? { label: 'awk -i inplace', file: shownPath(t) } : undefined
  }
  if (INTERPRETER.test(name)) {
    const inline: string[] = []
    for (const [i, a] of args.entries()) {
      if ((a.text === '-c' || a.text === '-e' || a.text === '--eval' || a.text === '-E' || codeFlag(kind, a.text)) && args[i + 1] !== undefined) inline.push((args[i + 1] as ShellWord).text)
      if (name === 'deno' && a.text === 'eval' && args[i + 1] !== undefined) inline.push((args[i + 1] as ShellWord).text)
    }
    inline.push(heredocText(cmd))
    if (inline.some(code => WRITE_IDIOM.test(code))) return { label: `inline ${name} code` }
  }
  return undefined
}

function scriptWrite(script: Script, scope: Scope | undefined, depth: number): ShellFileWrite | undefined {
  if (depth > 8) return undefined
  let at = scope
  for (const pl of script.pipelines) {
    for (const st of pl.stages) {
      if (st.kind === 'group') {
        const g = redirectWrite(st.redirects, at) ?? scriptWrite(st.body, at, depth + 1)
        if (g !== undefined) return g
        continue
      }
      const w = commandWrite(st.cmd, at)
      if (w !== undefined) return w
      for (const s of unwrap(st.cmd.words).scripts) {
        const inner = scriptWrite(parseShell(s).script, at, depth + 1)
        if (inner !== undefined) return inner
      }
    }
    const only = pl.stages.length === 1 ? pl.stages[0] : undefined
    if (only?.kind === 'cmd') {
      const argv = words(only.cmd)
      if (commandName(argv[0]) === 'cd') at = afterCd(argv.slice(1), at)
    }
  }
  return undefined
}

export function shellFileWrite(command: string, scope?: ShellScope): ShellFileWrite | undefined {
  if (typeof command !== 'string' || command.trim() === '') return undefined
  try {
    return scriptWrite(parseShell(command).script, scope, 0)
  } catch {
    return undefined
  }
}

const PRINTERS = new Set(['cat', 'head', 'tail', 'sed', 'nl', 'bat', 'batcat'])
const COMPANIONS = new Set(['cd', 'pwd', 'echo', 'printf', 'true'])
const HEAD_TAIL_ARG = new Set(['-n', '--lines'])
const LOG_FILE = /\.(?:log|out|err)$/i
const GLOB = /[*?[]/

function readOperands(name: string, args: readonly ShellWord[]): ShellWord[] | undefined {
  const texts = args.map(a => a.text)
  if (name === 'tail' && texts.some(t => t === '-f' || t === '-F' || t.startsWith('--follow') || /^-[a-zA-Z]*[fF]/.test(t))) return undefined
  if ((name === 'head' || name === 'tail') && texts.some(t => t === '-c' || t.startsWith('--bytes') || /^-c\d/.test(t))) return undefined
  if (name === 'sed') {
    if (!texts.includes('-n') || texts.some(t => /^-[a-zA-Z]*i/.test(t) || t.startsWith('--in-place'))) return undefined
    const scriptAt = texts.findIndex(t => /^[\d,$;\s]+p$/.test(t))
    if (scriptAt < 0) return undefined
    return args.filter((a, i) => i !== scriptAt && !a.text.startsWith('-'))
  }
  const out: ShellWord[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as ShellWord
    if ((name === 'head' || name === 'tail') && HEAD_TAIL_ARG.has(a.text)) { i++; continue }
    if (a.text.startsWith('-')) continue
    out.push(a)
  }
  return out
}

export function shellFileRead(command: string): string[] | undefined {
  if (typeof command !== 'string' || command.trim() === '') return undefined
  try {
    const { script, subs } = parseShell(command)
    if (subs.length > 0) return undefined
    const files: string[] = []
    for (const pl of script.pipelines) {
      if (pl.stages.length !== 1) return undefined
      const st = pl.stages[0]
      if (st === undefined || st.kind !== 'cmd') return undefined
      const cmd = st.cmd
      const argv = words(cmd)
      const name = commandName(argv[0])
      if (name === undefined) return undefined
      if (COMPANIONS.has(name)) { if (cmd.redirects.length > 0) return undefined; continue }
      if (!PRINTERS.has(name) || cmd.redirects.length > 0 || cmd.assigns.length > 0) return undefined
      const ops = readOperands(name, argv.slice(1))
      if (ops === undefined || ops.length === 0 || ops.length > 3) return undefined
      for (const w of ops) {
        if (w.dynamic || w.text.includes(DYN) || w.text === '-' || GLOB.test(w.text) || tempWord(w) || LOG_FILE.test(w.text)) return undefined
        files.push(shownPath(w))
      }
    }
    return files.length > 0 ? files : undefined
  } catch {
    return undefined
  }
}
