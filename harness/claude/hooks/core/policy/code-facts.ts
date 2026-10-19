export type CodeLanguage = 'ts' | 'py' | 'go' | 'rs' | 'other'

export function languageOf(file: string): CodeLanguage {
  const ext = /\.([A-Za-z0-9]+)$/.exec(typeof file === 'string' ? file : '')?.[1]?.toLowerCase() ?? ''
  if (['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'ts'
  if (ext === 'py' || ext === 'pyi') return 'py'
  if (ext === 'go') return 'go'
  if (ext === 'rs') return 'rs'
  return 'other'
}

const ws = (s: string): string => s.replace(/\s+/g, ' ').trim()

const REGEX_AFTER_WORD = /(?:^|[^\w$.])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/

function regexMayStart(text: string, at: number, prev: string): boolean {
  if (prev === '' || /[(,=:[!&|?{};+\-*%<>~^}]/.test(prev)) return true
  return /[\w$]/.test(prev) && REGEX_AFTER_WORD.test(text.slice(Math.max(0, at - 16), at).trimEnd())
}

function jsQuoted(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  const holes: number[] = []
  const n = text.length
  let depth = 0
  let prev = ''
  let i = 0
  const template = (from: number): number => {
    for (let j = from; j < n; j++) {
      const c = text[j]
      if (c === '\\') { j++; continue }
      if (c === '`') { out.push([from, j]); prev = '`'; return j + 1 }
      if (c === '$' && text[j + 1] === '{') { out.push([from, j]); holes.push(depth++); prev = '{'; return j + 2 }
    }
    out.push([from, n])
    return n
  }
  while (i < n) {
    const c = text[i] as string
    const next = text[i + 1]
    if (c === '/' && next === '/') { const e = text.indexOf('\n', i); const end = e < 0 ? n : e; out.push([i, end]); i = end; continue }
    if (c === '/' && next === '*') { const e = text.indexOf('*/', i + 2); const end = e < 0 ? n : e + 2; out.push([i, end]); i = end; continue }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1
      out.push([i + 1, Math.min(j, n)])
      i = j + 1
      prev = c
      continue
    }
    if (c === '`') { i = template(i + 1); continue }
    if (c === '/' && regexMayStart(text, i, prev)) {
      let j = i + 1
      let cls = false
      while (j < n && text[j] !== '\n') {
        const d = text[j]
        if (d === '\\') { j += 2; continue }
        if (d === '[') cls = true
        else if (d === ']') cls = false
        else if (d === '/' && !cls) break
        j++
      }
      if (j < n && text[j] === '/') { out.push([i, j + 1]); i = j + 1; prev = '/'; continue }
    }
    if (c === '{') depth++
    else if (c === '}') {
      if (holes.length > 0 && holes[holes.length - 1] === depth - 1) { holes.pop(); depth--; i = template(i + 1); continue }
      if (depth > 0) depth--
    }
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out
}

function pyQuoted(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  for (const m of text.matchAll(/("""|''')[\s\S]*?(?:\1|$)/g)) out.push([m.index ?? 0, (m.index ?? 0) + m[0].length])
  return out
}

function outside(spans: ReadonlyArray<readonly [number, number]>, at: number): boolean {
  return !spans.some(([s, e]) => at >= s && at < e)
}

function quotedSpans(text: string, lang: CodeLanguage): Array<[number, number]> {
  return lang === 'ts' ? jsQuoted(text) : lang === 'py' ? pyQuoted(text) : []
}

function upTo(text: string, start: number, stops: string, max = 800): string {
  let depth = 0
  const end = Math.min(text.length, start + max)
  for (let i = start; i < end; i++) {
    const c = text[i] as string
    if (c === '(' || c === '[' || c === '<') depth++
    else if ((c === ')' || c === ']' || c === '>') && depth > 0) {
      if (!(c === '>' && text[i - 1] === '=')) depth--
    } else if (depth === 0 && stops.includes(c)) return text.slice(start, i)
  }
  return text.slice(start, end)
}

function declarations(text: string, lang: CodeLanguage): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof text !== 'string' || text === '') return out
  const quoted = quotedSpans(text, lang)
  const matches = (rx: RegExp): RegExpExecArray[] => [...text.matchAll(rx)].filter(m => outside(quoted, m.index ?? 0))
  const put = (name: string | undefined, sig: string): void => {
    if (name !== undefined && name !== '' && !out.has(name)) out.set(name, ws(sig))
  }
  if (lang === 'ts') {
    for (const m of matches(/^[ \t]*export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) {
      const at = m.index ?? 0
      put(m[1], upTo(text, at, '{;'))
    }
    for (const m of matches(/^[ \t]*export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm)) put(m[1], upTo(text, m.index ?? 0, '{'))
    for (const m of matches(/^[ \t]*export\s+(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm)) {
      const line = upTo(text, m.index ?? 0, '\n;')
      const arrow = line.indexOf('=>')
      put(m[1], arrow >= 0 ? line.slice(0, arrow) : line.split('=')[0] ?? line)
    }
    for (const m of matches(/^[ \t]*export\s+(?:declare\s+)?(?:interface|enum|const\s+enum)\s+([A-Za-z_$][\w$]*)/gm)) put(m[1], upTo(text, m.index ?? 0, '{'))
    for (const m of matches(/^[ \t]*export\s+(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/gm)) put(m[1], upTo(text, m.index ?? 0, '\n;'))
    for (const m of matches(/^[ \t]*export\s+(?:type\s+)?\{([^}]*)\}/gm)) {
      for (const part of (m[1] ?? '').split(',')) {
        const name = /(?:\bas\s+)?([A-Za-z_$][\w$]*)\s*$/.exec(part.trim())?.[1]
        if (name !== undefined) put(name, `export { ${ws(part)} }`)
      }
    }
  } else if (lang === 'py') {
    for (const m of matches(/^(?:async\s+)?def\s+([A-Za-z]\w*)\s*\(/gm)) put(m[1], upTo(text, m.index ?? 0, ':'))
    for (const m of matches(/^class\s+([A-Za-z]\w*)/gm)) put(m[1], upTo(text, m.index ?? 0, ':'))
  } else if (lang === 'go') {
    for (const m of text.matchAll(/^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*[[(]/gm)) put(m[1], upTo(text, m.index ?? 0, '{'))
    for (const m of text.matchAll(/^type\s+([A-Z]\w*)\b/gm)) put(m[1], upTo(text, m.index ?? 0, '{\n'))
  } else if (lang === 'rs') {
    for (const m of text.matchAll(/^[ \t]*pub\s+(?:async\s+)?(?:unsafe\s+)?fn\s+([a-z_]\w*)/gm)) put(m[1], upTo(text, m.index ?? 0, '{;'))
    for (const m of text.matchAll(/^[ \t]*pub\s+(?:struct|enum|trait|type)\s+([A-Z]\w*)/gm)) put(m[1], upTo(text, m.index ?? 0, '{;'))
  }
  return out
}

export function changedExports(oldText: string, newText: string, file: string): string[] {
  const lang = languageOf(file)
  if (lang === 'other') return []
  const before = declarations(oldText, lang)
  if (before.size === 0) return []
  const after = declarations(newText, lang)
  return [...before].filter(([name, sig]) => after.get(name) !== sig).map(([name]) => name).sort()
}

const NODE_BUILTINS = new Set([
  'assert', 'async_hooks', 'buffer', 'child_process', 'cluster', 'console', 'constants', 'crypto', 'dgram', 'diagnostics_channel', 'dns',
  'domain', 'events', 'fs', 'http', 'http2', 'https', 'inspector', 'module', 'net', 'os', 'path', 'perf_hooks', 'process', 'punycode',
  'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys', 'timers', 'tls', 'trace_events', 'tty', 'url', 'util', 'v8', 'vm',
  'wasi', 'worker_threads', 'zlib', 'bun',
])

const PY_STDLIB = new Set([
  '__future__', 'abc', 'argparse', 'array', 'ast', 'asyncio', 'atexit', 'base64', 'bisect', 'builtins', 'bz2', 'calendar', 'cmath', 'codecs',
  'collections', 'colorsys', 'concurrent', 'configparser', 'contextlib', 'contextvars', 'copy', 'cProfile', 'csv', 'ctypes', 'curses',
  'dataclasses', 'datetime', 'decimal', 'difflib', 'dis', 'doctest', 'email', 'enum', 'errno', 'faulthandler', 'filecmp', 'fnmatch',
  'fractions', 'ftplib', 'functools', 'gc', 'getopt', 'getpass', 'gettext', 'glob', 'graphlib', 'gzip', 'hashlib', 'heapq', 'hmac', 'html',
  'http', 'imaplib', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json', 'keyword', 'linecache', 'locale', 'logging', 'lzma',
  'mailbox', 'math', 'mimetypes', 'mmap', 'multiprocessing', 'netrc', 'numbers', 'operator', 'os', 'pathlib', 'pdb', 'pickle', 'pkgutil',
  'platform', 'plistlib', 'poplib', 'posixpath', 'pprint', 'profile', 'pstats', 'pty', 'pwd', 'queue', 'random', 're', 'readline',
  'reprlib', 'resource', 'runpy', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex', 'shutil', 'signal', 'site', 'smtplib',
  'socket', 'socketserver', 'sqlite3', 'ssl', 'stat', 'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'symtable', 'sys',
  'sysconfig', 'tarfile', 'tempfile', 'termios', 'textwrap', 'threading', 'time', 'timeit', 'tkinter', 'token', 'tokenize', 'tomllib',
  'trace', 'traceback', 'tracemalloc', 'tty', 'turtle', 'types', 'typing', 'unicodedata', 'unittest', 'urllib', 'uuid', 'venv', 'warnings',
  'wave', 'weakref', 'webbrowser', 'winreg', 'wsgiref', 'xml', 'xmlrpc', 'zipapp', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
])

const RUST_BUILTINS = new Set(['std', 'core', 'alloc', 'crate', 'self', 'super', 'proc_macro', 'test'])

function jsPackage(spec: string): string | undefined {
  let s = spec.trim()
  if (s === '' || /^[./#~]/.test(s) || s.startsWith('@/') || /^(?:node|bun|data|http|https|file|virtual|blob):/.test(s)) return undefined
  s = s.replace(/^(?:npm|jsr):/, '')
  const parts = s.split('/')
  let name = s.startsWith('@') ? `${parts[0] ?? ''}/${parts[1] ?? ''}` : (parts[0] ?? '')
  name = name.replace(/(?<=.)@[^/]*$/, '')
  if (name === '' || name.endsWith('/') || NODE_BUILTINS.has(name)) return undefined
  return /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/i.test(name) ? name : undefined
}

function goModule(path: string): string | undefined {
  const parts = path.trim().split('/')
  const host = parts[0] ?? ''
  if (!host.includes('.')) return undefined
  const n = ['github.com', 'gitlab.com', 'bitbucket.org', 'golang.org', 'codeberg.org'].includes(host) ? 3 : 2
  return parts.slice(0, n).join('/')
}

export function importedPackages(text: string, file: string): string[] {
  const out = new Set<string>()
  if (typeof text !== 'string' || text === '') return []
  const lang = languageOf(file)
  const quoted = quotedSpans(text, lang)
  if (lang === 'ts') {
    const specs = [
      /(?:^|;)[ \t]*import\s+(?:type\s+)?(?:[\w*${}\s,]+?\s+from\s+)?['"]([^'"\n]+)['"]/gm,
      /(?:^|;)[ \t]*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"\n]+)['"]/gm,
      /\brequire\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
      /\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
    ]
    for (const rx of specs) {
      for (const m of text.matchAll(rx)) {
        if (!outside(quoted, (m.index ?? 0) + m[0].search(/[a-z]/))) continue
        const p = jsPackage(m[1] ?? '')
        if (p !== undefined) out.add(p)
      }
    }
  } else if (lang === 'py') {
    for (const m of text.matchAll(/^[ \t]*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) {
      if (!outside(quoted, m.index ?? 0)) continue
      for (const mod of (m[1] ?? '').split(',')) { const top = mod.trim().split('.')[0] ?? ''; if (top !== '' && !PY_STDLIB.has(top)) out.add(top) }
    }
    for (const m of text.matchAll(/^[ \t]*from\s+([\w][\w.]*)\s+import\b/gm)) {
      if (!outside(quoted, m.index ?? 0)) continue
      const top = (m[1] ?? '').split('.')[0] ?? ''
      if (top !== '' && !PY_STDLIB.has(top)) out.add(top)
    }
  } else if (lang === 'go') {
    const paths: string[] = []
    for (const m of text.matchAll(/^[ \t]*import\s+(?:[\w.]+\s+)?"([^"]+)"/gm)) paths.push(m[1] ?? '')
    for (const m of text.matchAll(/^[ \t]*import\s*\(([\s\S]*?)\)/gm)) {
      for (const l of (m[1] ?? '').split('\n')) { const p = /^\s*(?:[\w.]+\s+)?"([^"]+)"/.exec(l)?.[1]; if (p !== undefined) paths.push(p) }
    }
    for (const p of paths) { const mod = goModule(p); if (mod !== undefined) out.add(mod) }
  } else if (lang === 'rs') {
    for (const m of text.matchAll(/^[ \t]*(?:pub\s+)?use\s+(?:::)?([a-z_][a-z0-9_]*)::/gm)) { const c = m[1] ?? ''; if (!RUST_BUILTINS.has(c)) out.add(c) }
    for (const m of text.matchAll(/^[ \t]*extern\s+crate\s+([a-z_][a-z0-9_]*)/gm)) { const c = m[1] ?? ''; if (!RUST_BUILTINS.has(c)) out.add(c) }
  }
  return [...out].sort()
}

function pyName(req: string): string | undefined {
  const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(req)
  return m?.[1] !== undefined ? m[1].toLowerCase().replace(/[_.]+/g, '-') : undefined
}

function tomlArrayStrings(text: string, start: number): string[] {
  const out: string[] = []
  let depth = 0
  let quote: string | undefined
  let cur = ''
  for (let i = start; i < text.length; i++) {
    const c = text[i] as string
    if (quote !== undefined) {
      if (c === '\\' && quote === '"') { cur += text[i + 1] ?? ''; i++; continue }
      if (c === quote) { out.push(cur); cur = ''; quote = undefined } else cur += c
      continue
    }
    if (c === '"' || c === "'") { quote = c; continue }
    if (c === '#') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '[') depth++
    else if (c === ']') { depth--; if (depth === 0) break }
  }
  return out
}

interface TomlEntry { table: string, key: string, valueAt: number }

function tomlEntries(text: string): TomlEntry[] {
  const out: TomlEntry[] = []
  let table = ''
  let depth = 0
  let offset = 0
  for (const line of text.split('\n')) {
    const bare = line.replace(/"(?:[^"\\\n]|\\.)*"|'[^'\n]*'/g, '""').replace(/#.*$/, '')
    const header = depth === 0 ? /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*$/.exec(bare) : null
    if (header) {
      table = (/^\s*\[\[?\s*([^\]]+?)\s*\]\]?/.exec(line)?.[1] ?? '').replace(/\s*\.\s*/g, '.').replace(/["']/g, '')
    } else {
      if (depth === 0) {
        const kv = /^\s*("[^"\n]+"|'[^'\n]+'|[A-Za-z0-9_.-]+)\s*=/.exec(line)
        if (kv) out.push({ table, key: (kv[1] ?? '').replace(/^["']|["']$/g, ''), valueAt: offset + kv[0].length })
      }
      depth = Math.max(0, depth + (bare.match(/\[/g) ?? []).length - (bare.match(/\]/g) ?? []).length)
    }
    offset += line.length + 1
  }
  return out
}

function tomlArrayAt(text: string, at: number): string[] {
  const rest = text.slice(at)
  const lead = /^\s*\[/.exec(rest)
  return lead ? tomlArrayStrings(text, at + lead[0].length - 1) : []
}

export function parseManifestDeps(name: string, text: string): string[] {
  const base = (typeof name === 'string' ? name : '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (typeof text !== 'string' || text.trim() === '') return []
  const out = new Set<string>()
  const add = (n: string | undefined): void => { if (n !== undefined && n.trim() !== '') out.add(n.trim()) }
  try {
    if (base === 'package.json' || base === 'composer.json') {
      const j = JSON.parse(text) as Record<string, unknown>
      const keys = base === 'package.json' ? ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] : ['require', 'require-dev']
      for (const k of keys) {
        const deps = j[k]
        if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
          for (const d of Object.keys(deps)) if (base === 'package.json' || (d !== 'php' && !d.startsWith('ext-'))) add(d)
        }
      }
    } else if (/^(?:requirements|constraints)[\w.-]*\.(?:txt|in)$/.test(base)) {
      for (const raw of text.split('\n')) {
        const line = raw.replace(/(^|\s)#.*$/, '').trim()
        if (line === '' || line.startsWith('-')) continue
        const egg = /#egg=([A-Za-z0-9._-]+)/.exec(raw)?.[1]
        if (line.includes('://')) { if (egg !== undefined) add(pyName(egg)); continue }
        add(pyName(line))
      }
    } else if (base === 'pyproject.toml' || base === 'pipfile') {
      for (const e of tomlEntries(text)) {
        const table = e.table.toLowerCase()
        if ((table === 'project' && e.key === 'dependencies') || table === 'project.optional-dependencies' || table === 'dependency-groups') {
          for (const s of tomlArrayAt(text, e.valueAt)) add(pyName(s))
        } else if (/^tool\.poetry(?:\.group\.[^.]+)?\.(?:dev-)?dependencies$/.test(table) || table === 'packages' || table === 'dev-packages') {
          if (e.key.toLowerCase() !== 'python') add(pyName(e.key))
        }
      }
    } else if (base === 'go.mod') {
      let block = false
      for (const raw of text.split('\n')) {
        const line = raw.replace(/\/\/.*$/, '').trim()
        if (/^require\s*\($/.test(line)) { block = true; continue }
        if (block && line === ')') { block = false; continue }
        const m = block ? /^(\S+)\s+v\S+/.exec(line) : /^require\s+(\S+)\s+v\S+/.exec(line)
        if (m?.[1] !== undefined) add(m[1])
      }
    } else if (base === 'cargo.toml') {
      for (const e of tomlEntries(text)) {
        const t = e.table.toLowerCase()
        if (/(?:^|\.)(?:dev-|build-)?dependencies$/.test(t)) add(e.key)
        else {
          const sub = /(?:^|\.)(?:dev-|build-)?dependencies\.([^.]+)$/.exec(e.table)?.[1]
          if (sub !== undefined) add(sub)
        }
      }
      for (const m of text.matchAll(/^\s*\[(?:[^\]]*\.)?(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)\]/gm)) add(m[1])
    } else if (base === 'gemfile') {
      for (const m of text.matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) add(m[1])
    }
  } catch {
    return []
  }
  return [...out].sort()
}

export function patchEdits(patch: string): Array<{ path: string, removed: string, added: string }> {
  const out: Array<{ path: string, removed: string[], added: string[] }> = []
  if (typeof patch !== 'string' || patch === '') return []
  let cur: { path: string, removed: string[], added: string[] } | undefined
  const open = (path: string): void => {
    const p = path.trim().replace(/^["']|["']$/g, '')
    cur = out.find(e => e.path === p)
    if (cur === undefined) { cur = { path: p, removed: [], added: [] }; out.push(cur) }
  }
  const star = /\*\*\* (?:Begin Patch|Update File:|Add File:)/.test(patch)
  for (const line of patch.split(/\r?\n/)) {
    if (star) {
      const h = /^\*\*\* (Add|Update|Delete) File:\s*(.+)$/.exec(line.trim())
      if (h) { if (h[1] === 'Delete') cur = undefined; else open(h[2] ?? ''); continue }
      const mv = /^\*\*\* Move to:\s*(.+)$/.exec(line.trim())
      if (mv && cur !== undefined) { cur.path = (mv[1] ?? '').trim(); continue }
      if (line.startsWith('***')) continue
    } else {
      if (line.startsWith('+++ ')) { const p = line.slice(4).split('\t')[0]?.trim() ?? ''; if (p === '/dev/null') cur = undefined; else open(p.replace(/^b\//, '')); continue }
      if (line.startsWith('--- ')) continue
    }
    if (cur === undefined) continue
    if (line.startsWith('+')) cur.added.push(line.slice(1))
    else if (line.startsWith('-')) cur.removed.push(line.slice(1))
  }
  return out.map(e => ({ path: e.path, removed: e.removed.join('\n'), added: e.added.join('\n') }))
}

export function patchDeletes(patch: string): string[] {
  const out: string[] = []
  if (typeof patch !== 'string' || patch === '') return out
  const add = (path: string): void => {
    const p = path.trim().replace(/^["']|["']$/g, '')
    if (p !== '' && !out.includes(p)) out.push(p)
  }
  const star = /\*\*\* (?:Begin Patch|Update File:|Add File:|Delete File:)/.test(patch)
  let from: string | undefined
  for (const line of patch.split(/\r?\n/)) {
    if (star) {
      const h = /^\*\*\* Delete File:\s*(.+)$/.exec(line.trim())
      if (h) add(h[1] ?? '')
      continue
    }
    const file = line.slice(4).split('\t')[0]?.trim() ?? ''
    if (line.startsWith('+++ ') && file === '/dev/null' && from !== undefined && from !== '/dev/null') add(from.replace(/^a\//, ''))
    from = line.startsWith('--- ') ? file : undefined
  }
  return out
}
