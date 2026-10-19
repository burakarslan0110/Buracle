import { isWindowsPath } from '../events'
import type { PsCommand, PsStatement, PsWord } from './powershell'
import { parseCmd, parsePowerShell } from './powershell'
import type { Pipeline, Redirect, Script, ShellWord, SimpleCommand } from './shell'
import { DYN, HOME } from './shell'

// PowerShell and cmd.exe commands restated as the POSIX commands the shell guard already judges
// (Remove-Item -Recurse is `rm -r`, Set-Content is `tee`, `rd /s` is `rm -r`, ...), so every rule
// and every consent kind applies to them unchanged.

export type Dialect = 'powershell' | 'cmd'

export interface NestedSource { dialect: Dialect; src: string; item?: string }

// origins pairs each restated command with the text the user wrote, for the guard's messages.
export interface Translated { script: Script; nested: NestedSource[]; origins: Array<{ cmd: SimpleCommand, text: string }>; fetch?: boolean }

export interface TranslateOptions {
  // In lenient mode the line was handed in as POSIX shell and only looks like PowerShell: native
  // commands and the aliases POSIX shares (rm, cp, mv, ...) without PowerShell parameters are left
  // to the POSIX reading.
  lenient?: boolean
  vars?: Map<string, string>
  item?: string
}

interface Spec { values: readonly string[]; switches: readonly string[]; positional: readonly string[]; aliases?: Readonly<Record<string, string>> }

const COMMON_VALUES = ['erroraction', 'warningaction', 'informationaction', 'errorvariable', 'warningvariable', 'informationvariable', 'outvariable', 'outbuffer', 'pipelinevariable', 'progressaction']
const COMMON_SWITCHES = ['verbose', 'debug', 'whatif', 'confirm']
const COMMON_ALIASES: Readonly<Record<string, string>> = { ea: 'erroraction', wa: 'warningaction', ev: 'errorvariable', ov: 'outvariable', ob: 'outbuffer', pv: 'pipelinevariable', vb: 'verbose', db: 'debug', wi: 'whatif', cf: 'confirm', lp: 'literalpath', pspath: 'literalpath' }

function spec(values: string[], switches: string[], positional: string[], aliases: Record<string, string> = {}): Spec {
  return { values: [...values, ...COMMON_VALUES], switches: [...switches, ...COMMON_SWITCHES], positional, aliases: { ...COMMON_ALIASES, ...aliases } }
}

const PATHS = ['path', 'literalpath']
const SPECS: Readonly<Record<string, Spec>> = {
  'remove-item': spec([...PATHS, 'filter', 'include', 'exclude', 'credential', 'stream'], ['recurse', 'force'], ['path']),
  'get-childitem': spec([...PATHS, 'filter', 'include', 'exclude', 'depth', 'attributes'], ['recurse', 'force', 'name', 'file', 'directory', 'hidden', 'followsymlink'], ['path', 'filter']),
  'get-item': spec([...PATHS, 'filter', 'include', 'exclude', 'stream'], ['force'], ['path']),
  'copy-item': spec([...PATHS, 'destination', 'filter', 'include', 'exclude', 'credential', 'fromsession', 'tosession'], ['recurse', 'force', 'container', 'passthru'], ['path', 'destination']),
  'move-item': spec([...PATHS, 'destination', 'filter', 'include', 'exclude', 'credential'], ['force', 'passthru'], ['path', 'destination']),
  'rename-item': spec([...PATHS, 'newname', 'credential'], ['force', 'passthru'], ['path', 'newname']),
  'set-content': spec([...PATHS, 'value', 'encoding', 'filter', 'include', 'exclude', 'credential', 'stream'], ['force', 'nonewline', 'passthru', 'asbytestream'], ['path', 'value']),
  'add-content': spec([...PATHS, 'value', 'encoding', 'filter', 'include', 'exclude', 'credential', 'stream'], ['force', 'nonewline', 'passthru', 'asbytestream'], ['path', 'value']),
  'clear-content': spec([...PATHS, 'filter', 'include', 'exclude', 'credential', 'stream'], ['force'], ['path']),
  'out-file': spec(['filepath', 'literalpath', 'encoding', 'inputobject', 'width'], ['append', 'force', 'noclobber', 'nonewline'], ['filepath', 'encoding'], { path: 'filepath' }),
  'tee-object': spec(['filepath', 'literalpath', 'variable', 'inputobject', 'encoding'], ['append'], ['filepath'], { path: 'filepath' }),
  'new-item': spec(['path', 'name', 'itemtype', 'value', 'target', 'credential'], ['force'], ['path'], { type: 'itemtype' }),
  'set-item': spec([...PATHS, 'value', 'filter', 'include', 'exclude', 'credential'], ['force', 'passthru'], ['path', 'value']),
  'set-itemproperty': spec([...PATHS, 'name', 'value', 'type', 'filter', 'include', 'exclude', 'credential', 'inputobject'], ['force', 'passthru'], ['path', 'name', 'value']),
  'new-itemproperty': spec([...PATHS, 'name', 'value', 'propertytype', 'filter', 'include', 'exclude', 'credential'], ['force'], ['path', 'name', 'value'], { type: 'propertytype' }),
  'set-location': spec([...PATHS, 'stackname'], ['passthru'], ['path']),
  'push-location': spec([...PATHS, 'stackname'], ['passthru'], ['path']),
  'invoke-expression': spec(['command'], [], ['command']),
  'invoke-webrequest': spec(['uri', 'outfile', 'method', 'body', 'headers', 'infile', 'contenttype', 'useragent', 'proxy', 'credential', 'sessionvariable', 'websession', 'timeoutsec', 'maximumredirection'], ['usebasicparsing', 'passthru', 'usedefaultcredentials', 'skipcertificatecheck'], ['uri']),
  'start-process': spec(['filepath', 'argumentlist', 'workingdirectory', 'verb', 'credential', 'redirectstandardoutput', 'redirectstandarderror', 'redirectstandardinput', 'windowstyle'], ['wait', 'passthru', 'nonewwindow', 'loaduserprofile', 'usenewenvironment'], ['filepath', 'argumentlist'], { args: 'argumentlist', file: 'filepath' }),
  'stop-process': spec(['id', 'name', 'inputobject'], ['force', 'passthru'], ['id'], { processname: 'name' }),
  'foreach-object': spec(['process', 'begin', 'end', 'membername', 'argumentlist', 'inputobject', 'throttlelimit', 'remainingscripts'], ['parallel', 'asjob'], ['process']),
  'invoke-command': spec(['scriptblock', 'computername', 'session', 'argumentlist', 'filepath', 'credential'], ['asjob', 'nonewscope'], ['scriptblock']),
}

const ALIASES: Readonly<Record<string, string>> = {
  ri: 'remove-item', rm: 'remove-item', rmdir: 'remove-item', rd: 'remove-item', del: 'remove-item', erase: 'remove-item',
  gci: 'get-childitem', ls: 'get-childitem', dir: 'get-childitem', gi: 'get-item',
  copy: 'copy-item', cp: 'copy-item', cpi: 'copy-item', move: 'move-item', mv: 'move-item', mi: 'move-item', ren: 'rename-item', rni: 'rename-item',
  sc: 'set-content', ac: 'add-content', clc: 'clear-content', tee: 'tee-object', ni: 'new-item', si: 'set-item', sp: 'set-itemproperty',
  sl: 'set-location', cd: 'set-location', chdir: 'set-location', pushd: 'push-location', popd: 'pop-location',
  iex: 'invoke-expression', iwr: 'invoke-webrequest', irm: 'invoke-webrequest', 'invoke-restmethod': 'invoke-webrequest',
  saps: 'start-process', start: 'start-process', spps: 'stop-process', kill: 'stop-process', '%': 'foreach-object', foreach: 'foreach-object',
  '?': 'where-object', where: 'where-object', icm: 'invoke-command', gps: 'get-process', ps: 'get-process',
}

// The aliases POSIX shells share: in lenient mode they are PowerShell only with a PowerShell
// parameter or a backslash path.
const WINDOWS_SHELLS = new Set(['cmd', 'powershell', 'pwsh', 'powershell_ise'])
const SHARED = new Set(['rm', 'rmdir', 'cp', 'mv', 'ls', 'dir', 'cd', 'pushd', 'popd', 'kill', 'tee', 'ps', 'start', 'foreach', 'where'])

const DISK = new Set(['format-volume', 'clear-disk', 'initialize-disk', 'remove-partition', 'clear-partition', 'reset-physicaldisk'])
const POWER = new Set(['stop-computer', 'restart-computer'])
const DOWNLOAD_TEXT = /\b(?:invoke-webrequest|invoke-restmethod|iwr|irm|curl|wget|start-bitstransfer)\b|\.download(?:string|data|file)\s*\(|net\.webclient/i
const RUN_TEXT = /\b(?:invoke-expression|iex)\b|\[scriptblock\]::create/i
const HKCU_ENV = /^(?:hkcu:|hkey_current_user|registry::hkey_current_user|hklm:|hkey_local_machine|registry::hkey_local_machine)[\\/](?:system[\\/]currentcontrolset[\\/]control[\\/]session manager[\\/])?environment[\\/]?$/i

function sw(text: string, raw = text, quoted = false): ShellWord {
  return { text, raw, quoted, dynamic: text.includes(DYN) }
}

function cmdOf(words: ShellWord[], redirects: Redirect[] = []): SimpleCommand {
  return { assigns: [], words, redirects }
}

function slashes(t: string): string {
  return isWindowsPath(t) ? t : t.replace(/\\/g, '/')
}

function substitute(w: PsWord, opts: TranslateOptions, depth = 0): { text: string, changed: boolean } {
  if (w.kind === 'group' && w.src !== undefined) {
    const v = depth < 4 ? groupValue(w.src, opts, depth + 1) : undefined
    return v !== undefined ? { text: v, changed: true } : { text: w.text, changed: false }
  }
  if (!w.dynamic || w.refs === undefined) return { text: w.text, changed: false }
  let k = 0
  let changed = false
  let out = ''
  for (const ch of w.text) {
    if (ch !== DYN) { out += ch; continue }
    const name = w.refs[k++]
    const val = name === undefined ? undefined : itemOrVar(name, opts)
    if (val === undefined) { out += DYN; continue }
    out += val
    changed = true
  }
  return { text: out, changed }
}

// The value of a parenthesized path expression PowerShell code builds paths with: Join-Path,
// [IO.Path]::Combine and string concatenation, when every part is known.
function groupValue(src: string, opts: TranslateOptions, depth: number): string | undefined {
  const t = src.trim()
  const known = (ws: readonly PsWord[]): string[] | undefined => {
    const out = ws.map(w => substitute(w, opts, depth).text)
    return out.some(x => x.includes(DYN)) ? undefined : out
  }
  if (/^join-path\s/i.test(t)) {
    const words = parsePowerShell(t).statements[0]?.stages[0]?.words.slice(1) ?? []
    const b = bind(words, spec(['path', 'childpath', 'additionalchildpath'], ['resolve'], ['path', 'childpath', 'additionalchildpath']))
    const parts = known([...vals(b, 'path').slice(0, 1), ...vals(b, 'childpath'), ...vals(b, 'additionalchildpath')])
    return parts !== undefined && parts.length >= 2 ? parts.map((x, i) => (i === 0 ? x.replace(/[\\/]+$/, '') : x.replace(/^[\\/]+|[\\/]+$/g, ''))).join('\\') : undefined
  }
  const combine = /^\[(?:system\.)?io\.path\]::combine\s*\(([\s\S]*)\)$/i.exec(t)
  if (combine !== null) {
    const words = parsePowerShell(`x ${combine[1] as string}`).statements[0]?.stages[0]?.words.slice(1).filter(w => w.kind !== 'comma') ?? []
    const parts = known(words)
    return parts !== undefined && parts.length >= 1 ? parts.join('\\').replace(/\\{2,}/g, '\\') : undefined
  }
  const words = parsePowerShell(`x ${t}`).statements[0]?.stages[0]?.words.slice(1) ?? []
  if (words.length >= 3 && words.length % 2 === 1 && words.every((w, i) => (i % 2 === 1 ? w.raw === '+' : w.kind !== 'param'))) {
    const parts = known(words.filter((_, i) => i % 2 === 0))
    return parts?.join('')
  }
  return undefined
}

function itemOrVar(name: string, opts: TranslateOptions): string | undefined {
  if (opts.item !== undefined && /^(?:_|psitem)(?:\.(?:fullname|pspath|path))?$/.test(name)) return opts.item
  return name.includes('.') ? undefined : opts.vars?.get(name)
}

// A path the cmdlet resolves with wildcards (-Path, positional) keeps its glob unquoted for the
// guard; -LiteralPath does not expand them.
function pathWord(w: PsWord, opts: TranslateOptions, literal = false): ShellWord {
  const { text, changed } = substitute(w, opts)
  const t = slashes(text)
  const shown = t.replace(HOME, '~')
  const raw = !literal && /[*?[]/.test(t) && !t.includes(DYN) ? shown : changed ? `'${shown}'` : w.raw
  return sw(t, raw, w.quoted || changed)
}

function plainWord(w: PsWord, opts: TranslateOptions): ShellWord {
  if (w.kind === 'param') return sw(w.value !== undefined ? `${w.text}:${substitute(w.value, opts).text}` : w.text, w.raw)
  const { text, changed } = substitute(w, opts)
  const t = text.startsWith(HOME) ? HOME + text.slice(1).replace(/\\/g, '/') : text
  return sw(t, changed ? `'${t.replace(HOME, '~')}'` : w.raw, w.quoted || changed)
}

interface Bound { pos: PsWord[][]; named: Map<string, PsWord[]>; flags: Set<string>; unknown: string[] }

function bind(words: readonly PsWord[], s: Spec): Bound {
  const b: Bound = { pos: [], named: new Map(), flags: new Set(), unknown: [] }
  const all = [...s.values, ...s.switches]
  const resolve = (n: string): string | undefined => {
    const alias = s.aliases?.[n]
    if (alias !== undefined) return alias
    if (all.includes(n)) return n
    const c = all.filter(x => x.startsWith(n))
    return c.length === 1 ? c[0] : undefined
  }
  const list = (k: number): { items: PsWord[], next: number } => {
    const items: PsWord[] = []
    let j = k
    while (j < words.length) {
      const w = words[j] as PsWord
      if (w.kind === 'param') break
      if (w.kind === 'comma') { j++; continue }
      items.push(w)
      j++
      if ((words[j] as PsWord | undefined)?.kind !== 'comma') break
    }
    return { items, next: j }
  }
  for (let k = 0; k < words.length;) {
    const w = words[k] as PsWord
    if (w.kind === 'comma') { k++; continue }
    if (w.kind === 'param') {
      const name = resolve(w.name ?? '')
      if (name === undefined) { b.unknown.push(w.name ?? ''); k++; continue }
      if (s.switches.includes(name)) {
        const off = w.value !== undefined && /^(?:\$false|false|0)$/i.test(w.value.raw)
        if (!off) b.flags.add(name)
        k++
        continue
      }
      if (w.value !== undefined) { b.named.set(name, [...(b.named.get(name) ?? []), w.value]); k++; continue }
      const { items, next } = list(k + 1)
      b.named.set(name, [...(b.named.get(name) ?? []), ...items])
      k = next
      continue
    }
    const { items, next } = list(k)
    b.pos.push(items)
    k = next
  }
  s.positional.forEach((name, i) => {
    const items = b.pos[i]
    if (items !== undefined && !b.named.has(name)) b.named.set(name, items)
  })
  if (s.positional.length > 0 && b.pos.length > s.positional.length && s.positional[0] === 'path') {
    b.named.set('path', [...(b.named.get('path') ?? []), ...b.pos.slice(s.positional.length).flat()])
  }
  return b
}

function vals(b: Bound, ...names: string[]): PsWord[] {
  return names.flatMap(n => b.named.get(n) ?? [])
}

function nameOf(w: PsWord | undefined): string | undefined {
  if (w === undefined || w.kind !== 'word' || w.dynamic || w.text === '' || w.text.startsWith(HOME)) return undefined
  const base = w.text.slice(Math.max(w.text.lastIndexOf('/'), w.text.lastIndexOf('\\')) + 1).toLowerCase().replace(/\.(?:exe|cmd|bat|com)$/, '')
  return base === '' ? undefined : base
}

function canonical(name: string): string {
  return ALIASES[name] ?? name
}

interface Source { paths: ShellWord[]; recurse: boolean; filtered: boolean; filter?: string; processes?: boolean }

interface State { opts: TranslateOptions; nested: NestedSource[]; fetch: boolean }

function redirectsOf(c: PsCommand, opts: TranslateOptions): Redirect[] {
  return c.redirects.map(r => ({ op: r.op, target: pathWord(r.target, opts, true) }))
}

function rm(targets: ShellWord[], recursive: boolean, redirects: Redirect[]): SimpleCommand {
  return cmdOf([sw('rm'), ...(recursive ? [sw('-r')] : []), sw('-f'), sw('--'), ...targets], redirects)
}

function joinPath(dir: ShellWord, leaf: string): ShellWord {
  const t = `${dir.text.replace(/[\\/]+$/, '')}/${leaf}`
  return sw(t, t.includes(DYN) ? dir.raw : t, dir.quoted)
}

function psLike(words: readonly PsWord[], s: Spec | undefined): boolean {
  if (s === undefined) return false
  return words.some(w => (w.kind === 'param' && (w.name ?? '').length >= 2 && [...s.values, ...s.switches].some(n => n.startsWith(w.name ?? '')))
    || (w.kind === 'word' && /\\/.test(w.raw) && !/^-/.test(w.text)))
}

function translateStage(c: PsCommand, prev: Source | undefined, st: State): { cmd?: SimpleCommand, source?: Source } {
  const opts = st.opts
  const head = c.words[0]
  if (head !== undefined && head.kind === 'block') return {}
  const raw = nameOf(head)
  if (raw === undefined) return {}
  const name = canonical(raw)
  const s = SPECS[name]
  const args = c.words.slice(1)
  const redirects = redirectsOf(c, opts)
  if (opts.lenient === true && SHARED.has(raw) && !psLike(args, s)) return {}
  if (DISK.has(name)) return args.some(a => a.kind === 'param' && 'whatif'.startsWith(a.name ?? '-')) ? {} : { cmd: cmdOf([sw(`mkfs.${name}`), ...args.map(a => plainWord(a, opts))]) }
  if (POWER.has(name)) return { cmd: cmdOf([sw('shutdown'), ...args.map(a => plainWord(a, opts))]) }
  if (name === 'where-object') return prev !== undefined ? { source: { ...prev, filtered: true } } : {}
  if (name === 'get-process') return { source: { paths: [], recurse: false, filtered: args.length > 0, processes: true } }
  if (name === 'pop-location') return { cmd: cmdOf([sw('popd')]) }
  if (s === undefined) {
    if (opts.lenient === true && !WINDOWS_SHELLS.has(raw) && !args.some(a => a.raw.includes('\\'))) return {}
    const words = c.words.map(w => plainWord(w, opts))
    if ((raw === 'curl' || raw === 'wget') && args.some(a => a.kind === 'param' && a.name === 'outfile')) {
      return { cmd: cmdOf(words.map(w => (/^-outfile$/i.test(w.text) ? sw('-o') : w)), redirects) }
    }
    return { cmd: cmdOf(words, redirects) }
  }
  const b = bind(args, s)
  if (b.flags.has('whatif')) return {}
  switch (name) {
    case 'remove-item': {
      const literal = vals(b, 'literalpath').map(w => pathWord(w, opts, true))
      let targets = [...vals(b, 'path').map(w => pathWord(w, opts)), ...literal]
      const cmdFlags = targets.filter(t => /^[/-][sqf]$/i.test(t.text))
      targets = targets.filter(t => !cmdFlags.includes(t))
      let recursive = b.flags.has('recurse') || cmdFlags.some(t => /s/i.test(t.text)) || b.unknown.some(u => u.includes('r'))
      const filter = vals(b, 'filter', 'include').map(w => substitute(w, opts).text)[0]
      if (filter !== undefined) targets = targets.map(t => (/[*?]$/.test(t.text) ? joinPath(sw(t.text.replace(/[\\/][^\\/]*$/, '')), filter) : joinPath(t, filter)))
      if (targets.length === 0 && prev !== undefined && !prev.processes) {
        if (prev.paths.length === 0) return {}
        recursive ||= prev.recurse
        if (prev.filtered || prev.filter !== undefined) {
          return { cmd: cmdOf([sw('find'), ...prev.paths, sw('-name'), sw(prev.filter ?? '*'), sw('-type'), sw('f'), sw('-delete')], redirects) }
        }
        targets = prev.paths.map(p => joinPath(p, '*'))
      }
      if (targets.length === 0) return {}
      return { cmd: rm(targets, recursive, redirects) }
    }
    case 'get-childitem': case 'get-item': {
      const paths = [...vals(b, 'path').map(w => pathWord(w, opts)), ...vals(b, 'literalpath').map(w => pathWord(w, opts, true))]
      const filter = vals(b, 'filter', 'include').map(w => substitute(w, opts).text)[0]
      const filtered = b.named.has('exclude') || b.flags.has('name')
      const base = paths.length > 0 ? paths : [sw('.')]
      return { source: { paths: name === 'get-item' ? base.map(p => sw(p.text.replace(/[\\/]\*$/, ''), p.raw)) : base, recurse: b.flags.has('recurse'), filtered, ...(filter !== undefined ? { filter } : {}) } }
    }
    case 'copy-item': case 'move-item': {
      const src = [...vals(b, 'path').map(w => pathWord(w, opts)), ...vals(b, 'literalpath').map(w => pathWord(w, opts, true))]
      const dest = vals(b, 'destination').map(w => pathWord(w, opts, true))[0] ?? sw('.')
      const from = src.length > 0 ? src : prev !== undefined ? prev.paths.map(p => joinPath(p, '*')) : []
      if (from.length === 0) return {}
      return { cmd: cmdOf([sw(name === 'copy-item' ? 'cp' : 'mv'), ...(name === 'copy-item' && b.flags.has('recurse') ? [sw('-r')] : []), sw('--'), ...from, dest], redirects) }
    }
    case 'rename-item': {
      const path = [...vals(b, 'path'), ...vals(b, 'literalpath')].map(w => pathWord(w, opts, true))[0]
      const to = vals(b, 'newname').map(w => pathWord(w, opts, true))[0]
      if (path === undefined || to === undefined) return {}
      const dest = /[\\/]/.test(to.text) || to.text.startsWith(HOME) ? to : joinPath(sw(path.text.replace(/[\\/][^\\/]*$/, '') || '.', path.raw), to.text)
      return { cmd: cmdOf([sw('mv'), sw('--'), path, dest], redirects) }
    }
    case 'set-content': case 'add-content': case 'clear-content': case 'out-file': case 'tee-object': case 'set-item': {
      const targets = [...vals(b, 'path', 'filepath').map(w => pathWord(w, opts)), ...vals(b, 'literalpath').map(w => pathWord(w, opts, true))]
      const value = vals(b, 'value').map(w => plainWord(w, opts))
      const env = targets.map(t => /^env:[\\/]?([A-Za-z_][\w]*)$/i.exec(t.text)).find(m => m !== null)
      if (env != null) return { cmd: exportOf(env[1] as string, value[0]?.text ?? DYN) }
      if (name === 'set-item' || targets.length === 0) return {}
      return { cmd: cmdOf([sw('tee'), sw('--'), ...targets], [...redirects, ...value.map(v => ({ op: '<<<', target: v }))]) }
    }
    case 'new-item': {
      const dir = vals(b, 'path').map(w => pathWord(w, opts))[0]
      const leaf = vals(b, 'name').map(w => substitute(w, opts).text)[0]
      const target = dir !== undefined && leaf !== undefined ? joinPath(dir, leaf) : dir ?? (leaf !== undefined ? sw(leaf) : undefined)
      if (target === undefined) return {}
      const env = /^env:[\\/]?([A-Za-z_][\w]*)$/i.exec(target.text)
      const value = vals(b, 'value', 'target').map(w => pathWord(w, opts, true))
      if (env !== null) return { cmd: exportOf(env[1] as string, value[0]?.text ?? DYN) }
      const type = vals(b, 'itemtype').map(w => w.text.toLowerCase())[0] ?? 'file'
      if (/^(?:symboliclink|junction|hardlink)$/.test(type)) return value[0] !== undefined ? { cmd: cmdOf([sw('ln'), sw('-s'), value[0], target], redirects) } : {}
      if (type.startsWith('dir')) return {}
      return { cmd: cmdOf([sw('tee'), sw('--'), target], [...redirects, ...value.map(v => ({ op: '<<<', target: v }))]) }
    }
    case 'set-itemproperty': case 'new-itemproperty': {
      const key = [...vals(b, 'path'), ...vals(b, 'literalpath')].map(w => substitute(w, opts).text)[0] ?? ''
      const prop = vals(b, 'name').map(w => substitute(w, opts).text)[0]
      if (!HKCU_ENV.test(key) || prop === undefined) return {}
      return { cmd: cmdOf([sw('setx'), sw(prop), ...vals(b, 'value').map(w => plainWord(w, opts))]) }
    }
    case 'set-location': case 'push-location': {
      const to = [...vals(b, 'path'), ...vals(b, 'literalpath')].map(w => pathWord(w, opts, true))[0]
      return to !== undefined ? { cmd: cmdOf([sw(name === 'push-location' ? 'pushd' : 'cd'), to]) } : { cmd: cmdOf([sw('cd')]) }
    }
    case 'invoke-expression': {
      const code = vals(b, 'command')
      if (code.length === 0) return prev !== undefined && prev.paths.length === 0 ? { cmd: cmdOf([sw('sh')]) } : {}
      for (const w of code) {
        if (w.src !== undefined && DOWNLOAD_TEXT.test(w.src)) { st.fetch = true; continue }
        const { text } = substitute(w, opts)
        if (!text.includes(DYN)) st.nested.push({ dialect: 'powershell', src: text })
      }
      return {}
    }
    case 'invoke-webrequest': {
      const uri = vals(b, 'uri').map(w => plainWord(w, opts))
      const out = vals(b, 'outfile').map(w => pathWord(w, opts, true))
      return { cmd: cmdOf([sw('curl'), ...out.flatMap(o => [sw('-o'), o]), ...uri], redirects) }
    }
    case 'start-process': {
      const file = vals(b, 'filepath').map(w => plainWord(w, opts))[0]
      if (file === undefined) return {}
      const list = vals(b, 'argumentlist').flatMap(w => {
        const t = substitute(w, opts).text
        return w.quoted && /\s/.test(t) ? splitArgs(t) : [plainWord(w, opts)]
      })
      return { cmd: cmdOf([file, ...list], redirects) }
    }
    case 'stop-process': {
      const names = vals(b, 'name').map(w => substitute(w, opts).text)
      if (names.some(n => n === '*')) return { cmd: cmdOf([sw('kill'), sw('-9'), sw('-1')]) }
      if (names.length === 0 && vals(b, 'id').length === 0 && prev?.processes === true && !prev.filtered) return { cmd: cmdOf([sw('kill'), sw('-9'), sw('-1')]) }
      return {}
    }
    case 'foreach-object': case 'invoke-command': {
      const blocks = [...vals(b, 'process', 'scriptblock'), ...b.pos.flat()].filter(w => w.kind === 'block' && w.src !== undefined)
      const item = prev !== undefined && !prev.processes && prev.paths.length > 0 && !prev.filtered && prev.filter === undefined ? joinPath(prev.paths[0] as ShellWord, '*').text : undefined
      for (const blk of blocks) st.nested.push({ dialect: 'powershell', src: blk.src as string, ...(item !== undefined && name === 'foreach-object' ? { item } : {}) })
      return {}
    }
    default:
      return {}
  }
}

function exportOf(name: string, value: string): SimpleCommand {
  const t = `${name.toUpperCase()}=${value}`
  return cmdOf([sw('export'), sw(t)])
}

function splitArgs(text: string): ShellWord[] {
  const out: ShellWord[] = []
  for (const m of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    const t = m[1] ?? m[2] ?? m[3] ?? ''
    out.push(sw(t, m[0], m[3] === undefined))
  }
  return out
}

const DOTNET = /\[(?:system\.)?io\.(file|directory)\]::(\w+)\s*\(/gi
const SET_ENV = /\[(?:system\.)?environment\]::setenvironmentvariable\s*\(/gi
const DOWNLOAD_FILE = /\.downloadfile\s*\(/gi

function callArgs(text: string, open: number, opts: TranslateOptions): Array<ShellWord | undefined> {
  let depth = 0
  let end = -1
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    if (c === "'" || c === '"') { const j = text.indexOf(c, i + 1); if (j < 0) break; i = j; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return []
  const all = parsePowerShell(`x ${text.slice(open + 1, end)}`).statements[0]?.stages[0]?.words.slice(1) ?? []
  const out: Array<ShellWord | undefined> = [undefined]
  for (const w of all) {
    if (w.kind === 'comma') { out.push(undefined); continue }
    if (out[out.length - 1] === undefined) {
      const { text: t } = substitute(w, opts)
      out[out.length - 1] = w.quoted && !t.includes(DYN) ? sw(slashes(t), `'${slashes(t)}'`, true) : sw(DYN)
    }
  }
  return out
}

function dotnetCommands(text: string, opts: TranslateOptions): SimpleCommand[] {
  const out: SimpleCommand[] = []
  for (const m of text.matchAll(DOTNET)) {
    const kind = (m[1] as string).toLowerCase()
    const method = (m[2] as string).toLowerCase()
    const args = callArgs(text, (m.index ?? 0) + m[0].length - 1, opts)
    const [a, b2] = args
    if (a === undefined) continue
    if (kind === 'directory' && method === 'delete') out.push(args.length > 1 && !/false|0/i.test(b2?.raw ?? 'false') ? rm([a], true, []) : cmdOf([sw('rmdir'), a]))
    else if (kind === 'file' && method === 'delete') out.push(rm([a], false, []))
    else if (method === 'move' && b2 !== undefined) out.push(cmdOf([sw('mv'), sw('--'), a, b2]))
    else if (kind === 'file' && method === 'copy' && b2 !== undefined) out.push(cmdOf([sw('cp'), sw('--'), a, b2]))
    else if (kind === 'file' && /^(?:write|append|create|open|replace)/.test(method)) out.push(cmdOf([sw('tee'), sw('--'), method === 'replace' && b2 !== undefined ? b2 : a], args[1] !== undefined && /^(?:write|append)/.test(method) ? [{ op: '<<<', target: args[1] }] : []))
  }
  for (const m of text.matchAll(SET_ENV)) {
    const [n, v, scope] = callArgs(text, (m.index ?? 0) + m[0].length - 1, opts)
    if (n === undefined || n.text.includes(DYN)) { if (/user|machine/i.test(text.slice(m.index ?? 0))) out.push(cmdOf([sw('setx'), sw(DYN)])); continue }
    const persistent = scope !== undefined && (scope.text.includes(DYN) ? /user|machine/i.test(text.slice(m.index ?? 0)) : /user|machine/i.test(scope.text))
    out.push(persistent ? cmdOf([sw('setx'), n, v ?? sw(DYN)]) : exportOf(n.text, v?.text ?? DYN))
  }
  for (const m of text.matchAll(DOWNLOAD_FILE)) {
    const [url, path] = callArgs(text, (m.index ?? 0) + m[0].length - 1, opts)
    if (path !== undefined) out.push(cmdOf([sw('curl'), sw('-o'), path, url ?? sw(DYN)]))
  }
  return out
}

function statementText(s: PsStatement): string {
  return [s.expr ?? '', ...s.stages.flatMap(c => c.words.map(w => w.raw))].join(' ')
}

export function translatePowerShell(src: string, opts: TranslateOptions = {}): Translated & { truncated?: boolean } {
  const parsed = parsePowerShell(src)
  const vars = opts.vars ?? new Map<string, string>()
  const o: TranslateOptions = { ...opts, vars }
  const st: State = { opts: o, nested: [], fetch: false }
  const pipelines: Pipeline[] = []
  const origins: Translated['origins'] = []
  const nestedSeen = new Set<string>()
  for (const s of parsed.statements) {
    const text = statementText(s)
    if (DOWNLOAD_TEXT.test(text) && RUN_TEXT.test(text)) st.fetch = true
    if (s.assign !== undefined) {
      const value = s.assign.value
      const lit = value !== undefined && value.length === 1 && s.stages.length === 0 ? substitute(value[0] as PsWord, o).text : undefined
      if (s.assign.env) pipelines.push({ stages: [{ kind: 'cmd', cmd: exportOf(s.assign.name, lit ?? DYN) }] })
      else if (lit !== undefined && !lit.includes(DYN) && lit.length <= 4096 && (vars.size < 256 || vars.has(s.assign.name))) vars.set(s.assign.name, lit)
      else vars.delete(s.assign.name)
    }
    const dotnet = dotnetCommands(text, o)
    for (const c of dotnet) { pipelines.push({ stages: [{ kind: 'cmd', cmd: c }] }); origins.push({ cmd: c, text: s.expr ?? text }) }
    let prev: Source | undefined
    const stages: Pipeline['stages'] = []
    for (const c of s.stages) {
      const r = translateStage(c, prev, st)
      if (r.cmd !== undefined) { stages.push({ kind: 'cmd', cmd: r.cmd }); origins.push({ cmd: r.cmd, text: commandText(c) }) }
      prev = r.source ?? (r.cmd !== undefined && commandWord(r.cmd) === 'curl' ? { paths: [], recurse: false, filtered: false } : undefined)
    }
    if (stages.length > 0) pipelines.push({ stages })
  }
  for (const n of parsed.nested) {
    if (n.trim() === '' || nestedSeen.has(n)) continue
    nestedSeen.add(n)
    if (!st.nested.some(x => x.src === n)) st.nested.push({ dialect: 'powershell', src: n })
  }
  const out: Translated & { truncated?: boolean } = { script: { pipelines }, nested: st.nested, origins }
  if (st.fetch) out.fetch = true
  if (parsed.truncated === true) out.truncated = true
  return out
}

function commandText(c: PsCommand): string {
  return [...c.words.map(w => w.raw), ...c.redirects.map(r => `${r.op} ${r.target.raw}`)].join(' ')
}

function commandWord(c: SimpleCommand): string | undefined {
  return c.words[0]?.text
}

// cmd.exe built-ins (rd, del, copy, move, ren, cd, set, mklink, if, for); other commands pass on as they are.
export function translateCmd(src: string): Translated {
  const parsed = parseCmd(src)
  const pipelines: Pipeline[] = []
  const nested: NestedSource[] = parsed.nested.map(n => ({ dialect: 'cmd', src: n }))
  const opts: TranslateOptions = {}
  const origins: Translated['origins'] = []
  for (const c of parsed.commands) {
    const cmd = cmdBuiltin(c.words, redirectsOf(c, opts), nested)
    if (cmd !== undefined) { pipelines.push({ stages: [{ kind: 'cmd', cmd }] }); origins.push({ cmd, text: commandText(c) }) }
  }
  return { script: { pipelines }, nested, origins }
}

function cmdBuiltin(words: readonly PsWord[], redirects: Redirect[], nested: NestedSource[]): SimpleCommand | undefined {
  const name = nameOf(words[0])
  const opts: TranslateOptions = {}
  if (name === undefined) return undefined
  const rest = words.slice(1)
  const switches = rest.filter(w => /^\/[A-Za-z?]/.test(w.text) && w.text.length <= 4).map(w => w.text.toLowerCase())
  const operands = rest.filter(w => !(/^\/[A-Za-z?]/.test(w.text) && w.text.length <= 4)).map(w => pathWord(w, opts))
  if (switches.includes('/?')) return undefined
  switch (name) {
    case 'rd': case 'rmdir':
      return operands.length === 0 ? undefined : switches.includes('/s') ? rm(operands, true, redirects) : cmdOf([sw('rmdir'), ...operands], redirects)
    case 'del': case 'erase':
      return operands.length === 0 ? undefined : rm(operands, switches.includes('/s'), redirects)
    case 'copy': case 'xcopy':
      return operands.length < 1 ? undefined : cmdOf([sw('cp'), ...(name === 'xcopy' ? [sw('-r')] : []), sw('--'), ...operands, ...(operands.length === 1 ? [sw('.')] : [])], redirects)
    case 'move':
      return operands.length < 2 ? undefined : cmdOf([sw('mv'), sw('--'), ...operands], redirects)
    case 'ren': case 'rename': {
      const [from, to] = operands
      if (from === undefined || to === undefined) return undefined
      return cmdOf([sw('mv'), sw('--'), from, joinPath(sw(from.text.replace(/[\\/][^\\/]*$/, '') || '.'), to.text)], redirects)
    }
    case 'cd': case 'chdir': case 'pushd':
      return operands[0] !== undefined ? cmdOf([sw(name === 'pushd' ? 'pushd' : 'cd'), operands[0]]) : undefined
    case 'popd':
      return cmdOf([sw('popd')])
    case 'set': {
      if (switches.length > 0) return undefined
      const m = /^"?([A-Za-z_][\w]*)=(.*?)"?$/.exec(rest.map(w => w.text).join(' '))
      return m === null ? undefined : exportOf(m[1] as string, m[2] as string)
    }
    case 'mklink': {
      const [link, target] = operands
      return link !== undefined && target !== undefined ? cmdOf([sw('ln'), sw('-s'), target, link], redirects) : undefined
    }
    case 'if': case 'for': {
      let k = 0
      if (name === 'if') {
        while (k < rest.length && /^(?:not|\/i)$/i.test(rest[k]?.text ?? '')) k++
        const cond = (rest[k]?.text ?? '').toLowerCase()
        k += cond === 'exist' || cond === 'defined' || cond === 'errorlevel' || cond === 'cmdextversion' ? 2 : /==/.test(cond) ? 1 : 3
      } else {
        k = rest.findIndex(w => w.text.toLowerCase() === 'do') + 1
        if (k <= 0) return undefined
      }
      const body = rest.slice(k)
      if (body.length === 0) return undefined
      nested.push({ dialect: 'cmd', src: body.map(w => w.raw).join(' ') })
      return undefined
    }
    case 'start': {
      let k = 0
      if (rest[0]?.quoted === true) k = 1
      while (k < rest.length && /^\/[A-Za-z]/.test(rest[k]?.text ?? '')) k++
      const argv = rest.slice(k)
      return argv.length > 0 ? cmdOf(argv.map(w => plainWord(w, opts)), redirects) : undefined
    }
    case 'call':
      return rest.length > 0 ? cmdOf(rest.map(w => plainWord(w, opts)), redirects) : undefined
    default:
      return cmdOf(words.map(w => plainWord(w, opts)), redirects)
  }
}
