export type FlagKind = 'bool' | 'string'

export interface ParsedCommandArgs {
  positional: string[]
  flags: Record<string, string | boolean>
  errors: string[]
}

const GLOBAL = new Set(['--json', '--verbose', '-v'])

export function parseCommandArgs(argv: readonly string[], spec: Readonly<Record<string, FlagKind>>): ParsedCommandArgs {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  const errors: string[] = []
  let rest = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (rest) { positional.push(a); continue }
    if (a === '--') { rest = true; continue }
    if (GLOBAL.has(a)) continue
    if (!a.startsWith('--') || a === '--') {
      positional.push(a)
      continue
    }
    const eq = a.indexOf('=')
    const name = eq >= 0 ? a.slice(2, eq) : a.slice(2)
    const kind = spec[name]
    if (kind === undefined) { errors.push(`unknown option --${name}`); continue }
    if (kind === 'bool') {
      if (eq >= 0) {
        const v = a.slice(eq + 1).toLowerCase()
        if (v === 'true' || v === '1' || v === 'yes') flags[name] = true
        else if (v === 'false' || v === '0' || v === 'no') flags[name] = false
        else errors.push(`--${name} takes no value`)
      } else flags[name] = true
      continue
    }
    if (eq >= 0) { flags[name] = a.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (next === undefined || (next.startsWith('--') && spec[next.slice(2).split('=')[0] ?? ''] !== undefined) || GLOBAL.has(next)) {
      errors.push(`--${name} needs a value`)
      continue
    }
    flags[name] = next
    i++
  }
  return { positional, flags, errors }
}

export function strFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name]
  return typeof v === 'string' ? v : undefined
}

export function boolFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true
}
