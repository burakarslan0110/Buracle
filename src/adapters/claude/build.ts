import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AdapterContext } from '../registry'
import { CORE_REL, TEMPLATE_REL } from './constants'
import { generatePlugin, type GenFile } from './plugin'

const SKIP = new Set(['node_modules', '.DS_Store', '.git'])

export function readTree(dir: string, filter: (rel: string) => boolean = () => true): GenFile[] {
  const out: GenFile[] = []
  const walk = (abs: string, rel: string) => {
    let names: string[]
    try { names = readdirSync(abs).sort() } catch { return }
    for (const name of names) {
      if (SKIP.has(name) || name.startsWith('.')) continue
      const childAbs = join(abs, name)
      const childRel = rel === '' ? name : `${rel}/${name}`
      let st
      try { st = statSync(childAbs) } catch { continue }
      if (st.isDirectory()) walk(childAbs, childRel)
      else if (st.isFile() && filter(childRel)) out.push({ path: childRel, content: readFileSync(childAbs, 'utf8'), mode: st.mode & 0o777 })
    }
  }
  walk(dir, '')
  return out
}

export function packageVersion(repoRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof pkg.version === 'string' && pkg.version !== '' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export function readTemplate(repoRoot: string): GenFile[] {
  return readTree(join(repoRoot, TEMPLATE_REL))
}

export async function buildClaude(ctx: AdapterContext): Promise<GenFile[]> {
  return generatePlugin({
    canonical: ctx.canonical,
    buracleVersion: packageVersion(ctx.repoRoot),
    coreFiles: readTree(join(ctx.repoRoot, CORE_REL), rel => rel.endsWith('.ts')),
    templateFiles: readTemplate(ctx.repoRoot),
  })
}
