import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as paths from '../engine/paths'

function uiSources(memoryDir: string): string[] {
  const out = readdirSync(memoryDir).filter(n => /^ui.*\.ts$/u.test(n)).sort()
  const walk = (rel: string): void => {
    const entries = readdirSync(join(memoryDir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const r = `${rel}/${e.name}`
      if (e.isDirectory()) walk(r)
      else if (e.isFile()) out.push(r)
    }
  }
  walk('ui')
  return out
}

export function uiBuildId(repoRoot: string = paths.repoRoot()): string | undefined {
  try {
    const raw = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown }).version
    const dir = join(repoRoot, 'src', 'memory')
    const h = createHash('sha256')
    for (const rel of uiSources(dir)) {
      h.update(rel)
      h.update('\0')
      h.update(readFileSync(join(dir, rel)))
      h.update('\0')
    }
    return `${typeof raw === 'string' ? raw : '?'}+${h.digest('hex').slice(0, 12)}`
  } catch {
    return undefined
  }
}

export function sameUiBuild(running: string | undefined, current: string | undefined): boolean {
  return current === undefined || running === current
}
