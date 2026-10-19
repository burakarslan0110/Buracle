export type FlagKind = 'bool' | 'string' | 'list'

export interface FlagSpec {
  flags: Record<string, FlagKind>
  aliases?: Record<string, string>
}

export interface ParsedFlags {
  bools: Set<string>
  strings: Map<string, string>
  lists: Map<string, string[]>
  positionals: string[]
  errors: string[]
}

const GLOBAL_BOOLS = new Set(['json', 'verbose'])

export function parseFlags(argv: readonly string[], spec: FlagSpec): ParsedFlags {
  const out: ParsedFlags = { bools: new Set(), strings: new Map(), lists: new Map(), positionals: [], errors: [] }
  let passthrough = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (passthrough) { out.positionals.push(a); continue }
    if (a === '--') { passthrough = true; continue }
    if (a === '-v') { out.bools.add('verbose'); continue }
    let name: string | undefined
    let inline: string | undefined
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=')
      name = eq >= 0 ? a.slice(2, eq) : a.slice(2)
      inline = eq >= 0 ? a.slice(eq + 1) : undefined
    } else if (/^-[A-Za-z]$/.test(a)) {
      const alias = spec.aliases?.[a.slice(1)]
      if (alias === undefined) { out.errors.push(`unknown option ${a}`); continue }
      name = alias
    } else {
      out.positionals.push(a)
      continue
    }
    if (GLOBAL_BOOLS.has(name) && spec.flags[name] === undefined) {
      out.bools.add(name)
      continue
    }
    const kind = spec.flags[name]
    if (kind === undefined) { out.errors.push(`unknown option --${name}`); continue }
    if (kind === 'bool') {
      if (inline !== undefined) {
        if (inline === 'true' || inline === '1') out.bools.add(name)
        else if (inline !== 'false' && inline !== '0') out.errors.push(`--${name} takes no value`)
        continue
      }
      out.bools.add(name)
      continue
    }
    let value = inline
    if (value === undefined) {
      const next = argv[i + 1]
      if (next === undefined || (next.startsWith('-') && next.length > 1)) { out.errors.push(`--${name} needs a value`); continue }
      value = next
      i++
    }
    if (kind === 'string') out.strings.set(name, value)
    else {
      const items = value.split(',').map(s => s.trim()).filter(s => s !== '')
      out.lists.set(name, [...(out.lists.get(name) ?? []), ...items])
    }
  }
  return out
}

export function removedFlags(argv: readonly string[], removed: Readonly<Record<string, string>>): string[] {
  const out: string[] = []
  for (const a of argv) {
    if (a === '--') break
    if (!a.startsWith('--') || a.length <= 2) continue
    const name = a.slice(2).split('=')[0] ?? ''
    const instead = Object.hasOwn(removed, name) ? removed[name] : undefined
    const line = `--${name} was removed; ${instead}`
    if (instead !== undefined && !out.includes(line)) out.push(line)
  }
  return out
}

export function intFlag(p: ParsedFlags, name: string): number | undefined {
  const raw = p.strings.get(name)
  if (raw === undefined) return undefined
  return /^\d+$/.test(raw.trim()) ? parseInt(raw, 10) : NaN
}
