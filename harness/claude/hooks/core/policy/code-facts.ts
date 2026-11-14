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
