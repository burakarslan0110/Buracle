import { isAbsolute, relative, sep } from 'node:path'
import * as paths from '../paths'
import { isWindows } from '../platform'

export interface Out { write(chunk: string): void }

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && rel.split(sep)[0] !== '..')
}

export function tilde(p: string): string {
  return tildeFrom(paths.home(), p)
}

// One display style on every platform: a path under the home folder is shown as '~/' and '/'-separated parts.
export function tildeFrom(home: string, p: string): string {
  if (p === home) return '~'
  if (isInside(p, home)) return `~/${relative(home, p).split(sep).join('/')}`
  return p
}

export function tildeText(text: string): string {
  return tildeTextFrom(paths.home(), text)
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// On Windows the home folder may appear as C:\Users\me or (from git) C:/Users/me, in any case; the rest of
// that path, up to a space or quote, is shown with '/' as well.
export function tildeTextFrom(home: string, text: string): string {
  if (home.length <= 1) return text
  if (!isWindows()) return text.split(home + '/').join('~/')
  const parts = home.replace(/[\\/]+$/, '').split(/[\\/]/).map(escapeRe)
  const re = new RegExp(`${parts.join('[\\\\/]')}[\\\\/]([^\\s"'\`,;()<>|]*)`, 'gi')
  return text.replace(re, (_m, rest: string) => `~/${rest.replace(/\\/g, '/')}`)
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
