import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs'
import { join } from 'node:path'

export type TreeSnapshot = Record<string, string>

export function snapshotTree(root: string, skip: (rel: string) => boolean = () => false): TreeSnapshot {
  const out: TreeSnapshot = {}
  const walk = (rel: string) => {
    const abs = rel === '' ? root : join(root, rel)
    let st
    try { st = lstatSync(abs) } catch { return }
    if (rel !== '' && skip(rel)) return
    if (st.isSymbolicLink()) { out[rel] = `link:${readlinkSync(abs)}`; return }
    if (st.isDirectory()) {
      if (rel !== '') out[rel] = 'dir'
      for (const n of readdirSync(abs).sort()) walk(rel === '' ? n : `${rel}/${n}`)
      return
    }
    if (st.isFile()) { out[rel] = `file:${(st.mode & 0o777).toString(8)}:${readFileSync(abs).toString('base64')}`; return }
    out[rel] = 'other'
  }
  walk('')
  return out
}
