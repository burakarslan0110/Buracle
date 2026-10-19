import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { CORE_SECTIONS, coreId, isMemKind, memoryIdFor, type MemItem, type MemKind, type MemLayer } from '../core/memory/brain'
import { memIsSlug, parseNote } from '../core/memory/note'
import { memClip, memOneLine, redact } from '../core/memory/text'
import { atomicWriteSync, readJsonSafeSync } from '../engine/fsx'
import { log } from '../engine/log'
import * as paths from '../engine/paths'
import { vaultImportFile } from './layout'
import { oldVaultDir } from './project'
import { listAll, personRef, projectRef, recordEvent, saveItem, withBrainLock, type BrainRef } from './store'

export interface VaultImportReport {
  vault: string
  found: boolean
  dryRun: boolean
  imported: Array<{ from: string, id: string, layer: MemLayer, project?: string, kind: MemKind }>
  skipped: Array<{ from: string, reason: string }>
}

const FOLDER_KIND: Readonly<Record<string, MemKind>> = {
  decisions: 'decision', gotchas: 'gotcha', procedures: 'procedure', knowledge: 'knowledge', references: 'reference', preferences: 'preference',
}
const RETIRED = new Set(['superseded', 'deprecated', 'archived'])
const CLAUDE_KIND: Readonly<Record<string, { kind: MemKind, layer: MemLayer }>> = {
  user: { kind: 'preference', layer: 'person' },
  feedback: { kind: 'preference', layer: 'person' },
  project: { kind: 'knowledge', layer: 'project' },
  reference: { kind: 'reference', layer: 'project' },
}

export function oldVaultPath(): string {
  try {
    const raw = parseYaml(readFileSync(paths.userConfigFile(), 'utf8')) as unknown
    const v = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)['vault'] : undefined
    if (typeof v === 'string' && v.trim() !== '') {
      const p = paths.expandHome(v.trim())
      return isAbsolute(p) ? p : join(paths.home(), p)
    }
  } catch {  }
  return oldVaultDir()
}

export function vaultImportDone(): { at: string, vault: string } | undefined {
  const r = readJsonSafeSync<{ v: 1, at: string, vault: string }>(vaultImportFile())
  return r.ok && r.value !== null && typeof r.value === 'object' && r.value.v === 1 ? { at: r.value.at, vault: r.value.vault } : undefined
}

function mdFiles(dir: string): string[] {
  try { return readdirSync(dir).filter(n => n.endsWith('.md') && n !== 'MEMORY.md' && n !== 'index.md').map(n => join(dir, n)).filter(p => statSync(p).isFile()) } catch { return [] }
}

function strs(v: unknown): string[] {
  if (typeof v === 'string') return v.trim() === '' ? [] : [v.trim()]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(Boolean) : []
}

function unlink(s: string): string {
  return s.replace(/^\[\[([^\]|]+)(?:\|([^\]]+))?\]\]$/, (_m, a: string, b?: string) => (b ?? a.split('/').pop() ?? a))
}

function cleanBody(body: string, title: string): string {
  let b = body.replace(/\r\n/g, '\n').trim()
  if (b.startsWith(`# ${title}`)) b = b.slice(`# ${title}`.length).trim()
  else b = b.replace(/^# [^\n]*\n+/, '')
  b = b.replace(/<!-- buracle:[^:]+:start -->[\s\S]*?<!-- buracle:[^:]+:end -->/g, '').trim()
  b = b.replace(/<!--[\s\S]*?-->/g, '').trim()
  b = b.replace(/\n## History\n[\s\S]*$/, '').replace(/^## History\n[\s\S]*$/, '').trim()
  return b
}

// A note's place in the vault, with '/' on every platform: it is what the import reports and remembers.
function vaultRel(vault: string, file: string): string {
  return relative(vault, file).split(sep).join('/')
}

interface Candidate { from: string, layer: MemLayer, project?: string, kind: MemKind, id?: string, title: string, summary: string, body: string, tags: string[], sources: string[], about: string[], importance: number, created?: string, author: 'agent' | 'user' }

function noteCandidate(file: string, vault: string, base: { layer: MemLayer, project?: string, kind: MemKind }, skipped: VaultImportReport['skipped']): Candidate | undefined {
  const from = vaultRel(vault, file)
  let text: string
  try { text = readFileSync(file, 'utf8') } catch (e) { skipped.push({ from, reason: `unreadable: ${(e as Error).message}` }); return undefined }
  const { fm, body } = parseNote(text)
  const status = typeof fm['status'] === 'string' ? fm['status'] : 'active'
  if (RETIRED.has(status)) { skipped.push({ from, reason: status }); return undefined }
  const title = memOneLine(typeof fm['title'] === 'string' && fm['title'] !== '' ? fm['title'] : (typeof fm['name'] === 'string' ? fm['name'] : basename(file, '.md')))
  const imp = typeof fm['importance'] === 'number' ? Math.max(1, Math.min(5, Math.round(fm['importance']))) : 3
  const c: Candidate = {
    from, ...base, title: memClip(title, 200),
    summary: memClip(memOneLine(typeof fm['description'] === 'string' ? fm['description'] : ''), 300),
    body: cleanBody(body, title), tags: strs(fm['tags']).map(t => t.replace(/^#/, '').toLowerCase()).slice(0, 12),
    sources: strs(fm['sources']).slice(0, 20), about: strs(fm['about']).map(unlink).slice(0, 12), importance: imp,
    author: fm['generated_by'] === 'human' || String(fm['harness'] ?? '') === 'human' ? 'user' : 'agent',
  }
  if (typeof fm['created'] === 'string') { const t = Date.parse(fm['created']); if (Number.isFinite(t)) c.created = new Date(t).toISOString() }
  return c
}

function candidates(vault: string, skipped: VaultImportReport['skipped']): Candidate[] {
  const out: Candidate[] = []
  const projects = join(vault, 'projects')
  let slugs: string[] = []
  try { slugs = readdirSync(projects).filter(s => memIsSlug(s) && statSync(join(projects, s)).isDirectory()) } catch {  }
  for (const slug of slugs) {
    const dir = join(projects, slug)
    for (const [folder, kind] of Object.entries(FOLDER_KIND)) {
      for (const f of mdFiles(join(dir, folder))) {
        const c = noteCandidate(f, vault, { layer: kind === 'preference' ? 'person' : 'project', project: slug, kind }, skipped)
        if (c !== undefined) out.push(c)
      }
    }
    for (const section of CORE_SECTIONS) {
      const f = join(dir, 'core', `${section}.md`)
      if (!existsSync(f)) continue
      const c = noteCandidate(f, vault, { layer: 'project', project: slug, kind: 'core' }, skipped)
      if (c === undefined) continue
      if (c.body.replace(/^_.*_$/gm, '').trim() === '' || /^_?(?:Not written yet|Draft)/i.test(c.body)) { skipped.push({ from: c.from, reason: 'empty core page' }); continue }
      c.id = coreId(section)
      out.push(c)
    }
    for (const f of mdFiles(join(dir, 'claude'))) {
      const { fm } = parseNote(readFileSync(f, 'utf8'))
      const t = typeof fm['type'] === 'string' ? fm['type'] : (fm['metadata'] !== null && typeof fm['metadata'] === 'object' ? String((fm['metadata'] as Record<string, unknown>)['type'] ?? '') : '')
      const target = CLAUDE_KIND[t]
      if (target === undefined) { skipped.push({ from: vaultRel(vault, f), reason: `Claude memory of type ${t || 'unknown'}` }); continue }
      const c = noteCandidate(f, vault, { ...target, ...(target.layer === 'project' ? { project: slug } : {}) }, skipped)
      if (c !== undefined) out.push(c)
    }
  }
  for (const [folder, kind] of Object.entries(FOLDER_KIND)) {
    for (const f of mdFiles(join(vault, 'global', folder))) {
      const c = noteCandidate(f, vault, { layer: 'person', kind }, skipped)
      if (c !== undefined) out.push(c)
    }
  }
  for (const f of mdFiles(join(vault, 'inbox'))) {
    const c = noteCandidate(f, vault, { layer: 'person', kind: 'capture' }, skipped)
    if (c !== undefined) out.push(c)
  }
  const profile = join(vault, 'global', 'profile', 'user-profile.md')
  if (existsSync(profile)) {
    const { body } = parseNote(readFileSync(profile, 'utf8'))
    const m = /\n## Pinned by the user\n([\s\S]*?)(?:\n## |\n<!-- buracle:|$)/.exec(`\n${body}`)
    for (const line of (m?.[1] ?? '').split('\n')) {
      const t = line.trim().replace(/^[-*]\s+/, '')
      if (t === '' || t.startsWith('<!--') || line.trim() === t) continue
      out.push({ from: `${vaultRel(vault, profile)}#pinned`, layer: 'person', kind: 'preference', title: memClip(memOneLine(t), 200), summary: 'Pinned by the user in the old profile', body: '', tags: ['pinned'], sources: [], about: [], importance: 5, author: 'user' })
    }
  }
  return out
}

export async function importVault(opts: { vault?: string, dryRun?: boolean, nowMs?: number } = {}): Promise<VaultImportReport> {
  const vault = opts.vault ?? oldVaultPath()
  const now = opts.nowMs ?? Date.now()
  const report: VaultImportReport = { vault, found: existsSync(join(vault, 'projects')) || existsSync(join(vault, 'global')), dryRun: opts.dryRun === true, imported: [], skipped: [] }
  if (!report.found) return report
  const list = candidates(vault, report.skipped)
  const groups = new Map<string, { ref: BrainRef, items: Candidate[] }>()
  for (const c of list) {
    const ref = c.layer === 'person' ? personRef() : projectRef(c.project as string)
    const g = groups.get(ref.db) ?? { ref, items: [] }
    g.items.push(c)
    groups.set(ref.db, g)
  }
  for (const { ref, items } of groups.values()) {
    await withBrainLock(ref, async () => {
      const existing = await listAll(ref)
      const done = new Set(existing.map(i => i.importedFrom).filter((x): x is string => x !== undefined))
      const taken = new Set(existing.map(i => i.id))
      let n = 0
      for (const c of items) {
        const from = `vault:${c.from}`
        if (done.has(from)) { report.skipped.push({ from: c.from, reason: 'imported before' }); continue }
        const id = c.id !== undefined && !taken.has(c.id) ? c.id : memoryIdFor(c.kind, c.title, taken)
        if (c.id !== undefined && taken.has(c.id)) { report.skipped.push({ from: c.from, reason: `${c.id} exists already` }); continue }
        taken.add(id)
        const red = [redact(c.title), redact(c.summary), redact(c.body)]
        const at = new Date(now).toISOString()
        const item: MemItem = {
          id, kind: isMemKind(c.kind) ? c.kind : 'knowledge', layer: ref.layer, title: memOneLine(red[0]?.text ?? c.title), summary: memOneLine(red[1]?.text ?? ''),
          body: red[2]?.text ?? '', tags: c.tags, sources: c.sources, about: c.about, status: 'active',
          review: c.author === 'user' ? 'ok' : 'pending', importance: c.importance, created: c.created ?? at, updated: at,
          author: c.author, version: 1, history: [{ at, by: 'buracle', what: `imported from the old vault (${c.from})` }], harness: 'buracle', importedFrom: from,
        }
        report.imported.push({ from: c.from, id, layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), kind: item.kind })
        if (opts.dryRun === true) continue
        await saveItem(ref, item)
        n++
      }
      if (n > 0) recordEvent({ op: 'import', layer: ref.layer, ...(ref.slug !== undefined ? { project: ref.slug } : {}), n, by: 'buracle' })
    })
  }
  if (opts.dryRun !== true) {
    try {
      atomicWriteSync(vaultImportFile(), JSON.stringify({ v: 1, at: new Date(now).toISOString(), vault, imported: report.imported.length, skipped: report.skipped.length }, null, 2) + '\n')
    } catch (e) { log('warn', 'memory: the vault import was not recorded', { error: e }) }
  }
  return report
}
