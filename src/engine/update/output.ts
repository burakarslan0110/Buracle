import { isAbsolute, relative, sep } from 'node:path'
import * as paths from '../paths'

export interface Out { write(chunk: string): void }

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

export function tilde(p: string): string {
  const home = paths.home()
  if (p === home) return '~'
  if (isInside(p, home)) return `~/${relative(home, p)}`
  return p
}

export function tildeText(text: string): string {
  const home = paths.home()
  return home.length > 1 ? text.split(home + '/').join('~/') : text
}

export function table(rows: readonly (readonly string[])[], indent = '  '): string {
  if (rows.length === 0) return ''
  const widths: number[] = []
  for (const r of rows) r.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, [...c].length) })
  return rows.map(r => indent + r.map((c, i) => (i === r.length - 1 ? c : c + ' '.repeat((widths[i] ?? 0) - [...c].length))).join('  ').trimEnd()).join('\n') + '\n'
}

export function writeJson(out: Out, value: unknown): void {
  out.write(JSON.stringify(value, null, 2) + '\n')
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
