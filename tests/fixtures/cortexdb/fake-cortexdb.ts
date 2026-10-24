import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// A stand-in for cortexdb-mcp that keeps the behaviours of the real engine (2.139.0) Buracle depends on:
// - a memory id is the primary key of the whole file; saving an id again replaces the row, whichever bucket it was in;
// - a row lives in one bucket: scope `user` + user_id (namespace `default`), or scope `global` + a namespace;
//   `memory_search` only sees the bucket it is asked for (without scope: global/default), while `memory_list_all`,
//   `memory_get` and `memory_delete` ignore buckets;
// - supersedes hides the old row from search; ttl_seconds drops a row once its time is up;
// - entities and relations on save, and entity_names with retrieval_mode graph/hybrid/ppr on search;
// - review_status takes proposed, accepted or rejected.
interface Rec {
  id: string
  content: string
  created_at: string
  importance?: number
  metadata: Record<string, unknown>
  expires_ms?: number
  scope: string
  namespace: string
  user_id?: string
  review_status?: string
  entities?: string[]
  relations?: Array<{ from: string, to: string }>
}
interface Db { v: 1, seq: number, records: Record<string, Rec & { seq: number }> }

if (process.argv.includes('--doctor')) {
  const failed = process.env['FAKE_CORTEXDB_DOCTOR'] === 'fail'
  process.stdout.write(JSON.stringify({ version: '0.0.0-fake', mode: 'local', database: process.env['CORTEXDB_PATH'] ?? '', status: failed ? 'failed' : 'ready', self_test: 'passed', ...(failed ? { error: 'injected failure' } : {}) }) + '\n')
  process.exit(failed ? 1 : 0)
}

const file = process.env['CORTEXDB_PATH'] ?? ''
if (file === '') { process.stderr.write('CORTEXDB_PATH is not set\n'); process.exit(2) }

// FAKE_CORTEXDB_CLOCK_FILE names a file holding the current time in milliseconds, so a test can move the clock
// past a row's ttl_seconds without sleeping. Without it the clock is the real one.
function nowMs(): number {
  const clock = process.env['FAKE_CORTEXDB_CLOCK_FILE']
  if (clock !== undefined && clock !== '') {
    try { const t = Number(readFileSync(clock, 'utf8').trim()); if (Number.isFinite(t)) return t } catch { /* the real clock */ }
  }
  return Date.now()
}

// A row saved with ttl_seconds disappears from get, list_all and search once its time is up, like the real engine.
function live(r: Rec): boolean {
  return r.expires_ms === undefined || r.expires_ms > nowMs()
}

function load(): Db {
  let db: Db
  try { db = JSON.parse(readFileSync(file, 'utf8')) as Db } catch { return { v: 1, seq: 0, records: {} } }
  // A file written before buckets existed (Buracle 0.5) holds rows of the default bucket.
  for (const r of Object.values(db.records)) { r.scope ??= 'global'; r.namespace ??= 'default' }
  return db
}

function save(db: Db): void {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, JSON.stringify(db))
  renameSync(tmp, file)
}

const fold = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
const words = (s: string) => fold(s).split(/[^\p{L}\p{N}_]+/u).filter(w => w !== '')

function sessionOf(r: Rec): string {
  return r.scope === 'user' ? `memory:user:${r.user_id ?? ''}:${r.namespace}` : `memory:${r.scope}:${r.namespace}`
}

function view(r: Rec): Record<string, unknown> {
  const out: Record<string, unknown> = { id: r.id, content: r.content, created_at: r.created_at, metadata: r.metadata, namespace: r.namespace, role: 'memory', scope: r.scope, session_id: sessionOf(r) }
  if (r.user_id !== undefined) out['user_id'] = r.user_id
  if (r.review_status !== undefined) out['review_status'] = r.review_status
  if (r.expires_ms !== undefined) out['expires_at'] = new Date(r.expires_ms).toISOString().replace(/\.\d{3}Z$/, 'Z')
  if (r.importance !== undefined && r.importance > 0) out['importance'] = r.importance
  return out
}

class ToolError extends Error {}

interface Bucket { scope: string, namespace: string, user_id?: string }

function bucketOf(a: Record<string, unknown>): Bucket {
  const scope = typeof a['scope'] === 'string' && a['scope'] !== '' ? a['scope'] : 'global'
  const namespace = typeof a['namespace'] === 'string' && a['namespace'] !== '' ? a['namespace'] : 'default'
  if (scope !== 'user' && scope !== 'global') throw new ToolError(`unknown scope: ${scope}`)
  if (scope === 'user') {
    if (typeof a['user_id'] !== 'string' || a['user_id'] === '') throw new ToolError('user_id is required for user scope')
    return { scope, namespace, user_id: a['user_id'] }
  }
  return { scope, namespace }
}

function inBucket(r: Rec, b: Bucket): boolean {
  return r.scope === b.scope && r.namespace === b.namespace && (b.scope !== 'user' || r.user_id === b.user_id)
}

const REVIEW = ['proposed', 'accepted', 'rejected']

function call(name: string, a: Record<string, unknown>): unknown {
  if (process.env['FAKE_CORTEXDB_FAIL'] === name) throw new ToolError('injected failure')
  const db = load()
  const now = new Date(nowMs()).toISOString().replace(/\.\d{3}Z$/, 'Z')
  const id = typeof a['memory_id'] === 'string' ? a['memory_id'] : ''
  switch (name) {
    case 'memory_save': {
      if (id === '' || typeof a['content'] !== 'string') throw new ToolError('memory_id and content are required')
      const b = bucketOf(a)
      const sup = Array.isArray(a['supersedes']) ? a['supersedes'] as string[] : []
      for (const s of sup) if (db.records[s] === undefined || !live(db.records[s] as Rec)) throw new ToolError(`supersedes: memory ${s} not found`)
      const review = typeof a['review_status'] === 'string' && a['review_status'] !== '' ? a['review_status'] : undefined
      if (review !== undefined && !REVIEW.includes(review)) throw new ToolError(`review_status must be proposed, accepted or rejected, got "${review}"`)
      // The real engine (2.139.0) refuses an accepted or rejected memory that does not say who reviewed it.
      if ((review === 'accepted' || review === 'rejected') && (typeof a['reviewed_by'] !== 'string' || a['reviewed_by'] === '')) throw new ToolError(`review_status=${review} needs reviewed_by: a decision names who made it`)
      const entities = Array.isArray(a['entities']) ? (a['entities'] as Array<{ name?: unknown }>).map(e => String(e.name ?? '')).filter(n => n !== '') : []
      const relations = Array.isArray(a['relations']) ? a['relations'] as Array<{ from: string, to: string }> : []
      if ((entities.length > 0 || relations.length > 0) && process.env['FAKE_CORTEXDB_REJECT_GRAPH'] === '1') throw new ToolError('save memory relations: no relation could be written (injected)')
      const known = new Set([...entities, ...Object.values(db.records).flatMap(r => r.entities ?? [])])
      for (const rel of relations) if (!known.has(rel.from) || !known.has(rel.to)) throw new ToolError(`save memory relations: no relation could be written (1 rejected): [FOREIGN KEY constraint failed (787)]`)
      const prev = db.records[id]
      const importance = typeof a['importance'] === 'number' ? a['importance'] : 0
      const ttl = typeof a['ttl_seconds'] === 'number' && a['ttl_seconds'] > 0 ? a['ttl_seconds'] : 0
      const meta: Record<string, unknown> = { ...(a['metadata'] as Record<string, unknown> ?? {}), importance, kind: 'memory', namespace: b.namespace, scope: b.scope, ttl_seconds: ttl }
      if (review !== undefined) meta['_review_status'] = review
      db.records[id] = {
        id, content: a['content'], created_at: prev?.created_at ?? now, importance, metadata: meta, seq: ++db.seq, scope: b.scope, namespace: b.namespace,
        ...(b.user_id !== undefined ? { user_id: b.user_id } : {}), ...(review !== undefined ? { review_status: review } : {}),
        ...(entities.length > 0 ? { entities } : {}), ...(relations.length > 0 ? { relations } : {}), ...(ttl > 0 ? { expires_ms: nowMs() + ttl * 1000 } : {}),
      }
      for (const s of sup) { const r = db.records[s]; if (r) r.metadata = { ...r.metadata, superseded_by: id, superseded_at: now } }
      save(db)
      return { memory: view(db.records[id] as Rec) }
    }
    case 'memory_get': {
      const r = db.records[id]
      if (!r || !live(r)) throw new ToolError('embedding not found')
      return { memory: view(r) }
    }
    case 'memory_update': {
      const r = db.records[id]
      if (!r || !live(r)) throw new ToolError('embedding not found')
      if (typeof a['content'] === 'string') r.content = a['content']
      if (a['metadata'] !== null && typeof a['metadata'] === 'object') r.metadata = { ...r.metadata, ...(a['metadata'] as Record<string, unknown>) }
      if (typeof a['importance'] === 'number') { r.importance = a['importance']; r.metadata['importance'] = a['importance'] }
      save(db)
      return { memory: view(r) }
    }
    case 'memory_delete': {
      if (!db.records[id]) throw new ToolError('embedding not found')
      delete db.records[id]
      save(db)
      return { deleted: true, memory_id: id }
    }
    case 'memory_list_all': {
      const limit = typeof a['limit'] === 'number' ? a['limit'] : 50
      const start = typeof a['cursor'] === 'string' ? Number(a['cursor'].replace(/^c/, '')) : 0
      const all = Object.values(db.records).filter(live).sort((x, y) => y.seq - x.seq)
      const page = all.slice(start, start + limit)
      const more = start + limit < all.length
      return { memories: page.map(view), truncated: more || undefined, next_cursor: more ? `c${start + limit}` : undefined }
    }
    case 'memory_search': {
      const b = bucketOf(a)
      const terms = [...new Set([...words(String(a['query'] ?? '')), ...((a['keywords'] as string[] | undefined) ?? []).flatMap(words)])]
      const topK = typeof a['top_k'] === 'number' ? a['top_k'] : 10
      const names = new Set(((a['entity_names'] as string[] | undefined) ?? []).map(fold))
      const graph = names.size > 0 && ['graph', 'hybrid', 'ppr'].includes(String(a['retrieval_mode'] ?? ''))
      // A relation joins two entities: a memory about one is reached from the other.
      const reach = new Set(names)
      if (graph) for (const r of Object.values(db.records)) for (const rel of r.relations ?? []) {
        if (names.has(fold(rel.from))) reach.add(fold(rel.to))
        if (names.has(fold(rel.to))) reach.add(fold(rel.from))
      }
      const hits: Array<{ r: Rec & { seq: number }, score: number }> = []
      for (const r of Object.values(db.records)) {
        if (!inBucket(r, b) || !live(r) || r.metadata['superseded_by'] !== undefined) continue
        const toks = words(r.content)
        let score = 0
        for (const t of terms) if (toks.some(w => w === t || (t.length >= 3 && w.startsWith(t)))) score++
        if (graph && (r.entities ?? []).some(e => reach.has(fold(e)))) score += 0.5
        if (score > 0) hits.push({ r, score })
      }
      hits.sort((x, y) => y.score - x.score || y.r.seq - x.r.seq)
      const top = hits.slice(0, topK)
      for (const h of top) h.r.metadata = { ...h.r.metadata, recall_count: Number(h.r.metadata['recall_count'] ?? 0) + 1, last_recalled_at: now }
      if (top.length > 0) save(db)
      return { query: a['query'], results: top.map(h => ({ memory: view(h.r), score: h.score / 1e6 })) }
    }
    default:
      throw new ToolError(`unknown tool: ${name}`)
  }
}

let buf = ''
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n')
function handle(line: string): void {
  let msg: { id?: number, method?: string, params?: Record<string, unknown> }
  try { msg = JSON.parse(line) } catch { return }
  if (msg.id === undefined) return
  if (msg.method === 'initialize') { out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-cortexdb', version: '0' } } }); return }
  if (msg.method === 'tools/call') {
    const p = msg.params ?? {}
    try {
      // FAKE_CORTEXDB_DROP plays a CortexDB release that no longer has that tool.
      if (process.env['FAKE_CORTEXDB_DROP'] === String(p['name'])) throw new Error(`unknown tool: ${String(p['name'])}`)
      const structured = call(String(p['name']), (p['arguments'] as Record<string, unknown>) ?? {})
      out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured } })
    } catch (e) {
      out({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: (e as Error).message }], isError: true } })
    }
    return
  }
  out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } })
}

process.stdin.on('data', (chunk: Buffer) => {
  buf += chunk.toString('utf8')
  let nl: number
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (line !== '') handle(line)
  }
})
process.stdin.on('end', () => process.exit(0))
if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true })
