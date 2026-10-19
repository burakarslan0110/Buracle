import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PathRuleIndex, PathRuleSource } from '../../core/policy/path-rules'

function tilde(dir: string, home: string | undefined): string | undefined {
  if (home === undefined || home === '') return undefined
  const h = home.replace(/[\\/]+$/, '')
  return dir.startsWith(h + '/') || dir.startsWith(h + '\\') ? `~/${dir.slice(h.length + 1).replace(/\\/g, '/')}` : undefined
}

export function pathRuleSource(rules: readonly PathRuleIndex[] | undefined, dir: string, opts: { onRead?: boolean, home?: string } = {}): PathRuleSource | undefined {
  if (rules === undefined || rules.length === 0 || dir === '') return undefined
  const src: PathRuleSource = {
    rules,
    dir,
    body: id => {
      try { return readFileSync(join(dir, `${id}.md`), 'utf8') } catch { return undefined }
    },
  }
  const shown = tilde(dir, opts.home)
  if (shown !== undefined) src.shownDir = shown
  if (opts.onRead === true) src.onRead = true
  return src
}
