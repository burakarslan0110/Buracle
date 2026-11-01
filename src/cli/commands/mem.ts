import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CommandIO } from '../router'
import type { Harness } from '../../core/events'
import { isHarness } from '../../core/events'
import { memIsSlug } from '../../core/memory/note'
import { memSegmentWith } from '../../core/memory/status'
import * as paths from '../../engine/paths'
import { resolveSession } from '../../workflow/session-store'

export const name = 'mem'
export const summary = 'Memory (one CortexDB brain: a bucket per project and one for the person): search, get, write, update, status, capture, backup, migrate, import, web UI'
export const usage = `Usage: buracle mem <subcommand> [args…] [--json]

The memory lives in one CortexDB file, ~/.buracle/brain/brain.db, with a bucket for each project and one
for the person. A command reaches only the current project's bucket and the person's.
Nothing runs in the background by itself: a session end captures what it learned (one detached
\`mem finalize\`), everything else happens when you run a command.

Memories (CLI twins of the MCP tools)
  search ["<query>"] [--layer project|person|all] [--type K]… [--status live|any] [--since D] [--until D] [--limit N]
         [--file PATH]… [--tag T]… [--about A]… [--offset N] [--around ID [--depth N]]
                                             a filter works without a query: --file lists the memories that
                                             cite a file or a folder (path relative to the root); --about
                                             names a topic and also follows the graph from it (memories linked
                                             to the topic rank first); --offset pages on; --around lists what
                                             was recorded before and after ID
  get ID…                                    up to 5 memories in full (person/<id> picks the person layer)
  write --type K --title "…" --summary "…" [--body "…" | --body-file F | stdin] [--layer project|person]
        [--source S]… [--tag T]… [--about A]… [--supersedes ID]… [--importance 1-5] [--pin] [--force] [--review ok]
        [--origin explicit|inferred] [--confidence 0-1]
                                             written by hand, so the origin is explicit unless you say otherwise
  update ID --patch '<json>' [--reason "…"] [--expected-version N] [--origin explicit|inferred]
                                             e.g. --patch '{"review":"ok"}', '{"status":"deprecated"}',
                                             '{"merge_into":"<id>"}', '{"move":{"kind":"decision"}}'
                                             an inferred change never edits, retires or replaces an explicit,
                                             pinned or (for retiring and replacing) verified memory
  remember "<text>"                          a capture to file later (memory_update with move: {kind, layer})
  status [--project SLUG] [--style compact|wide] [--refresh]
                                             the store, the brain file with its buckets, the counts per brain
                                             region, the last write and the last capture
  context [--cwd DIR]                        the session-start memory text (--json: {"text": …})

Capture (the model-assisted writing, on demand)
  capture [--session SID [--harness H]] [--pending] [--limit N] [--force]
                                             the same work a session end does, now: the session memory, the
                                             user's explicit statements as preference memories (no model),
                                             and one bounded model call over the session for its durable
                                             decisions, gotchas and procedures. Without --session it takes
                                             the newest session of this project. --pending also takes up to
                                             N (default 3) stale sessions whose capture is owed; --force
                                             distills again although the same material was distilled. A
                                             failed, rate-limited or invalid model answer writes nothing.

Backups and moving a brain (the brain stays on this machine; nothing is synced)
  backup [--keep N]                          copy brain.db (every bucket: a backup is always the whole file, so
                                             --project and --person are refused; \`export\` saves one bucket)
                                             into ~/.buracle/brain/backups/<id>/ and keep the newest 10 copies
  backup --list                              the backups, newest first, with the buckets each holds
  restore ID (--project SLUG | --person | --all)
                                             --all puts the whole brain file back (the running CortexDB
                                             readers are stopped, sessions start new ones); --project and
                                             --person take only that bucket out of the backup and leave the
                                             others as they are. The brain as it was goes into a
                                             pre-restore backup first.
  migrate [--status | --dry-run | --rollback [--force] | --purge-legacy]
                                             fold the per-layer files of Buracle 0.5 (person.db, projects/)
                                             into brain.db: verified copies first, nothing deleted, safe to
                                             run again. It also runs by itself at the first memory call. A large
                                             file shows how far the copy is on stderr (not with --json).
                                             --rollback puts the 0.5 files back (brain.db is kept as
                                             brain.db.rolled-back unless --force); --purge-legacy deletes the
                                             moved-aside files and the copies
  export [--project SLUG | --person] [--type K]… [--out FILE]
                                             the live memories of one brain as JSON lines, secrets masked
                                             again (decisions, gotchas, procedures, knowledge, references,
                                             preferences and core pages; --type picks kinds, capture too)
  import FILE|- [--project SLUG] [--dry-run]
                                             write an export into this project's brain and the person's
                                             through memory_write: duplicates and what an earlier import
                                             brought are skipped, and every memory starts unverified
  project init [--cwd DIR]                   map this folder to its project
  import-vault [--vault PATH] [--dry-run]    copy the live notes of the old Obsidian vault into the
                                             brains once (the vault is only read)
  doctor [--no-mcp]                          CortexDB binary, the brain file and its migration, leak check, MCP handshake
                                             (--json: {"checks":[{level,check,detail}]}; exit 1 errors, 2 warnings)
  ui [--open] [--port N] [--stop]            the brain web UI (http://localhost:41777): starts it in the
                                             background when it does not run, prints its address. With
                                             memory.ui.autostart (the default) the install and every harness
                                             session start it too, and it runs until the last harness session
                                             ends; before any session it stops after 30 minutes without a
                                             request (BURACLE_UI_IDLE_MS, in milliseconds). --stop stops it
                                             until the next session start
  ui --page review [--open]                  the review page of the same UI: the plans, build contracts
                                             and PRDs of your projects and the agent's changes, where you
                                             pin notes the agent reads (buracle plan notes)
  ui --serve [--port N]                      run the web UI in the foreground (Ctrl-C stops it; otherwise it
                                             stops by the same rule)

Sessions (called by hooks; nothing is recorded under BURACLE_NO_CAPTURE=1)
  start --harness H --session SID [--cwd DIR]
  finalize --harness H --session SID [--detach]
                                             the session end: the same work as capture, then up to 3 other
                                             stale sessions (--detach starts it in the background)
  handoff --harness H --session SID [--cwd DIR] [--branch B] [--slug S] [--trigger T]   (markdown on stdin)

Global: --json for machine-readable output. Exit codes: 0 ok, 1 error, 2 user action needed.
`

interface Parsed { pos: string[], flags: Map<string, string[]>, bools: Set<string> }

const VALUE_FLAGS = new Set([
  'vault', 'cwd', 'project', 'style', 'scope', 'layer', 'type', 'kind', 'status', 'since', 'until', 'limit', 'max-tokens',
  'title', 'summary', 'description', 'body', 'body-file', 'source', 'supersedes', 'tag', 'importance', 'review', 'harness',
  'session', 'model', 'port', 'patch', 'reason', 'expected-version', 'branch', 'slug', 'trigger', 'origin', 'confidence',
  'file', 'about', 'offset', 'around', 'depth', 'keep', 'out', 'page',
])

class UsageError extends Error {}

function parse(argv: string[]): Parsed {
  const pos: string[] = []
  const flags = new Map<string, string[]>()
  const bools = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string
    if (a === '--') { pos.push(...argv.slice(i + 1)); break }
    if (!a.startsWith('--') || a === '--') { pos.push(a); continue }
    const eq = a.indexOf('=')
    const key = a.slice(2, eq > 0 ? eq : undefined)
    // `--status` takes a value for search (live|any) and none for `migrate --status`.
    if (VALUE_FLAGS.has(key) && !(key === 'status' && pos[0] === 'migrate')) {
      const value = eq > 0 ? a.slice(eq + 1) : argv[++i]
      if (value === undefined) throw new UsageError(`--${key} needs a value`)
      flags.set(key, [...(flags.get(key) ?? []), value])
    } else {
      bools.add(key)
    }
  }
  return { pos, flags, bools }
}

const FINALIZER_GRACE_MS = 1500
const FINALIZER_SETTLE_MS = 1000

const one = (p: Parsed, k: string): string | undefined => p.flags.get(k)?.at(-1)
const many = (p: Parsed, k: string): string[] => p.flags.get(k) ?? []
const int = (p: Parsed, k: string): number | undefined => {
  const v = one(p, k)
  if (v === undefined) return undefined
  if (!/^\d+$/.test(v)) throw new UsageError(`--${k} must be a number`)
  return Number(v)
}

function projectFlag(p: Parsed): string | undefined {
  const v = one(p, 'project')
  if (v === undefined) return undefined
  if (!memIsSlug(v)) throw new UsageError(`--project must be a project slug (lowercase letters, digits and dashes): ${JSON.stringify(v)}`)
  return v
}

function out(io: CommandIO, json: boolean, value: unknown, text: string): void {
  io.stdout.write(json ? JSON.stringify(value, null, 2) + '\n' : text.endsWith('\n') ? text : text + '\n')
}

async function stdinText(io: CommandIO): Promise<string> {
  return io.stdin.isTTY ? '' : await io.stdin.text()
}

function cwdOf(p: Parsed): string {
  return resolve(one(p, 'cwd') ?? process.cwd())
}

async function ctxFor(p: Parsed) {
  const { cliContext } = await import('../../memory/api')
  const session = resolveSession({
    ...(one(p, 'session') !== undefined ? { session: one(p, 'session') as string } : {}),
    ...(one(p, 'harness') !== undefined ? { harness: one(p, 'harness') as string } : {}),
  })
  const harnessName = (h: string) => (h === 'claude' ? 'claude-code' : h)
  return session
    ? cliContext(cwdOf(p), harnessName(session.harness), { session: session.sessionId, agent: true })
    : cliContext(cwdOf(p), one(p, 'harness') !== undefined ? harnessName(one(p, 'harness') as string) : 'human')
}

function harnessSession(p: Parsed): { h: Harness, sid: string } | undefined {
  const r = resolveSession({
    ...(one(p, 'session') !== undefined ? { session: one(p, 'session') as string } : {}),
    ...(one(p, 'harness') !== undefined ? { harness: one(p, 'harness') as string } : {}),
  })
  if (r) return { h: r.harness, sid: r.sessionId }
  const h = one(p, 'harness')
  const sid = one(p, 'session')
  return h !== undefined && isHarness(h) && sid !== undefined && paths.isValidSessionId(sid) ? { h, sid } : undefined
}

export async function run(argv: string[], io: CommandIO): Promise<number> {
  let p: Parsed
  try { p = parse(argv) } catch (e) { io.stderr.write(`buracle mem: ${(e as Error).message}\n`); return 1 }
  const json = io.flags.json || p.bools.has('json')
  const [sub, ...rest] = p.pos
  if (sub === undefined || sub === 'help') { io.stdout.write(usage); return 0 }
  try {
    return await dispatch(sub, rest, p, io, json)
  } catch (e) {
    const { MemoryError } = await import('../../memory/api')
    if (e instanceof UsageError) { io.stderr.write(`buracle mem ${sub}: ${e.message}\n`); return 1 }
    if (e instanceof MemoryError) {
      if (json) io.stdout.write(JSON.stringify({ error: e.code, message: e.message, ...(e.data ?? {}) }, null, 2) + '\n')
      else io.stderr.write(`buracle mem ${sub}: ${e.message}\n`)
      return e.code === 'conflict' || e.code === 'store_unavailable' || e.code === 'no_project' || e.code === 'migrating' ? 2 : 1
    }
    io.stderr.write(`buracle mem ${sub}: ${e instanceof Error ? e.message : String(e)}\n`)
    return 1
  } finally {
    if (sub !== 'ui') { try { await (await import('../../memory/cortex')).closeAllCortex() } catch {  } }
  }
}

async function dispatch(sub: string, rest: string[], p: Parsed, io: CommandIO, json: boolean): Promise<number> {
  switch (sub) {
    case 'status': {
      const { readStatus } = await import('../../memory/status')
      const { memoryStatusReport } = await import('../../memory/status-report')
      const ctx = await ctxFor(p)
      if (projectFlag(p) !== undefined) ctx.project = projectFlag(p) as string
      if (!p.bools.has('refresh') && one(p, 'style') !== undefined) {
        const s = readStatus(ctx.project ?? undefined)
        if (s !== undefined) {
          const seg = memSegmentWith(s, Date.now(), one(p, 'style') === 'compact' ? 'compact' : 'wide', { emoji: true })
          out(io, json, s, seg.text)
          return s.health === 'error' ? 2 : 0
        }
      }
      const r = await memoryStatusReport(ctx)
      const seg = memSegmentWith(r.status, Date.now(), one(p, 'style') === 'compact' ? 'compact' : 'wide', { emoji: true })
      out(io, json, { status: r.status, ...(r.brain !== undefined ? { brain: r.brain } : {}), ...(r.excluded !== undefined ? { excluded: r.excluded } : {}), regions: r.regions }, `${seg.text}\n${r.text}`)
      return r.status.health === 'error' ? 2 : 0
    }
    case 'search': {
      const { search } = await import('../../memory/api')
      const layer = one(p, 'layer') ?? one(p, 'scope')
      const r = await search(await ctxFor(p), {
        query: rest.join(' ').trim(),
        ...(layer !== undefined ? { layer } : {}),
        ...(many(p, 'type').length > 0 ? { types: many(p, 'type') } : {}),
        ...(one(p, 'status') !== undefined ? { status: one(p, 'status') as string } : {}),
        ...(one(p, 'since') !== undefined ? { since: one(p, 'since') as string } : {}),
        ...(one(p, 'until') !== undefined ? { until: one(p, 'until') as string } : {}),
        ...(int(p, 'limit') !== undefined ? { limit: int(p, 'limit') as number } : {}),
        ...(many(p, 'file').length > 0 ? { files: many(p, 'file') } : {}),
        ...(many(p, 'tag').length > 0 ? { tags: many(p, 'tag') } : {}),
        ...(many(p, 'about').length > 0 ? { about: many(p, 'about') } : {}),
        ...(int(p, 'offset') !== undefined ? { offset: int(p, 'offset') as number } : {}),
        ...(one(p, 'around') !== undefined ? { around: one(p, 'around') as string } : {}),
        ...(int(p, 'depth') !== undefined ? { depth: int(p, 'depth') as number } : {}),
      })
      out(io, json, r.rows, r.text)
      return 0
    }
    case 'get': {
      const { get } = await import('../../memory/api')
      if (rest.length === 0) throw new UsageError('usage: buracle mem get ID…')
      const r = await get(await ctxFor(p), { ids: rest, ...(int(p, 'max-tokens') !== undefined ? { max_tokens: int(p, 'max-tokens') as number } : {}) })
      out(io, json, r.items, r.text)
      return 0
    }
    case 'write': {
      const { write } = await import('../../memory/api')
      let body = one(p, 'body')
      if (body === undefined && one(p, 'body-file') !== undefined) body = readFileSync(resolve(one(p, 'body-file') as string), 'utf8')
      if (body === undefined) body = await stdinText(io)
      const kind = one(p, 'type') ?? one(p, 'kind')
      const title = one(p, 'title') ?? rest.join(' ')
      if (kind === undefined || title.trim() === '') throw new UsageError('--type and --title are required')
      const layer = one(p, 'layer') ?? one(p, 'scope')
      const r = await write(await ctxFor(p), {
        type: kind, title, body,
        ...(one(p, 'summary') !== undefined || one(p, 'description') !== undefined ? { summary: (one(p, 'summary') ?? one(p, 'description')) as string } : {}),
        ...(layer !== undefined ? { layer } : {}),
        sources: many(p, 'source'), supersedes: many(p, 'supersedes'), tags: many(p, 'tag'), about: many(p, 'about'),
        ...(int(p, 'importance') !== undefined ? { importance: int(p, 'importance') as number } : {}),
        ...(one(p, 'review') !== undefined ? { review: one(p, 'review') as string } : {}),
        ...(p.bools.has('pin') ? { pin: true } : {}),
        ...(p.bools.has('force') ? { force: true } : {}),
        origin: one(p, 'origin') ?? 'explicit',
        ...(one(p, 'confidence') !== undefined ? { confidence: one(p, 'confidence') as string } : {}),
      })
      const text = r.action === 'duplicate_suspected'
        ? ['duplicate suspected; nothing written. Similar memories:', ...(r.similar ?? []).map(s => `  ${s.id} (${s.score}) ${s.title}`), 'Update one of them (buracle mem update), or write again with --force.'].join('\n')
        : `${r.action} ${r.layer === 'person' ? 'person/' : ''}${r.id}${r.redactions ? ` (redacted ${r.redactions} secret(s))` : ''}${r.conflicts ? `; left unchanged and marked as contradicting: ${r.conflicts.map(c => `${c.id} (${c.why})`).join(', ')}` : ''}`
      out(io, json, r, text)
      return r.action === 'duplicate_suspected' ? 2 : 0
    }
    case 'update': {
      const { update } = await import('../../memory/api')
      const id = rest[0]
      const raw = one(p, 'patch')
      if (id === undefined || raw === undefined) throw new UsageError('usage: buracle mem update ID --patch \'<json>\' [--reason "…"]')
      let patch: unknown
      try { patch = JSON.parse(raw) } catch { throw new UsageError('--patch must be a JSON object') }
      if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new UsageError('--patch must be a JSON object')
      const r = await update(await ctxFor(p), {
        id, patch: patch as Record<string, unknown>,
        ...(one(p, 'reason') !== undefined ? { reason: one(p, 'reason') as string } : {}),
        ...(int(p, 'expected-version') !== undefined ? { expected_version: int(p, 'expected-version') as number } : {}),
        ...(one(p, 'origin') !== undefined ? { origin: one(p, 'origin') as string } : {}),
      })
      out(io, json, r, r.changed.length === 0 ? `${r.id}: nothing changed` : `${r.moved_to !== undefined ? `moved to ${r.moved_to.layer}/${r.moved_to.id}` : `updated ${r.id}`} (version ${r.version}: ${r.changed.join(', ')})`)
      return 0
    }
    case 'remember': {
      const { remember } = await import('../../memory/api')
      const text = rest.length > 0 ? rest.join(' ') : await stdinText(io)
      const r = await remember(await ctxFor(p), text)
      out(io, json, r, `saved as a capture: ${r.layer === 'person' ? 'person/' : ''}${r.id} (file it with memory_update: move: {kind, layer})`)
      return 0
    }
    case 'context': {
      const { contextText } = await import('../../memory/context')
      const text = await contextText({ cwd: cwdOf(p) })
      if (json) io.stdout.write(JSON.stringify({ text }) + '\n')
      else io.stdout.write(text)
      return 0
    }
    case 'start': {
      const hs = harnessSession(p)
      if (!hs) { io.stderr.write('buracle mem start: --harness and --session (or a session env var) are required\n'); return 2 }
      const { sessionStart } = await import('../../memory/finalize')
      const r = await sessionStart(hs.h, hs.sid, cwdOf(p))
      out(io, json, r, r.skipped !== undefined ? `skipped: ${r.skipped}` : `session recorded${r.slug !== undefined ? ` (project ${r.slug})` : ''}${r.resumed ? ' (resumed)' : ''}`)
      return r.skipped === 'invalid-session' ? 2 : 0
    }
    case 'finalize': {
      const hs = harnessSession(p)
      if (!hs) { io.stderr.write('buracle mem finalize: --harness and --session (or a session env var) are required\n'); return 2 }
      const fin = await import('../../memory/finalize')
      const { captureOff } = await import('../../memory/spool')
      if (p.bools.has('detach')) {
        if (captureOff()) { out(io, json, { detached: false, skipped: 'capture-off' }, 'skipped: capture-off (BURACLE_NO_CAPTURE=1)'); return 0 }
        const pid = fin.spawnFinalizerPid(hs.h, hs.sid)
        out(io, json, { detached: pid !== undefined, pid }, pid !== undefined ? `finalizer started (pid ${pid})` : 'could not start the finalizer')
        return pid !== undefined ? 0 : 1
      }
      const detached = process.env['BURACLE_FINALIZER'] === '1'
      // The detached finalizer is bounded: it starts no new work after the budget, and a model call ends at its own timeout; this stops anything stuck beyond both.
      const watchdog = detached ? setTimeout(() => process.exit(1), fin.FINALIZE_BUDGET_MS + 10 * 60_000) : undefined
      watchdog?.unref()
      const r = await fin.finalize(hs.h, hs.sid, detached ? { graceMs: FINALIZER_GRACE_MS, settleMs: FINALIZER_SETTLE_MS } : {})
      if (watchdog !== undefined) clearTimeout(watchdog)
      if (detached && r.skipped === undefined) {
        try { await (await import('../../memory/backup')).maybeDailyBackup() } catch (e) { (await import('../../engine/log')).log('warn', 'memory: the daily backup was not taken', { error: e }) }
      }
      out(io, json, r, finalizeText(r))
      return r.skipped === 'invalid-session' ? 2 : 0
    }
    case 'capture': return captureCommand(p, io, json)
    case 'handoff': {
      const hs = harnessSession(p)
      if (!hs) { io.stderr.write('buracle mem handoff: --harness and --session are required\n'); return 2 }
      const markdown = await stdinText(io)
      if (markdown.trim() === '') throw new UsageError('the handoff markdown comes on stdin')
      const { writeHandoff } = await import('../../memory/handoff')
      const r = await writeHandoff({
        harness: hs.h, sessionId: hs.sid, cwd: cwdOf(p), markdown, slug: one(p, 'slug') ?? `${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${hs.h}`,
        ...(one(p, 'branch') !== undefined ? { branch: one(p, 'branch') as string } : {}),
        ...(one(p, 'trigger') !== undefined ? { trigger: one(p, 'trigger') as string } : {}),
      })
      out(io, json, r ?? { skipped: true }, r !== undefined ? `handoff memory: ${r.id}` : 'skipped: not a project, or CortexDB is not installed')
      return 0
    }
    case 'project': {
      if (rest[0] !== 'init') throw new UsageError('usage: buracle mem project init [--cwd DIR]')
      const { projectInit } = await import('../../memory/project-init')
      const r = await projectInit(cwdOf(p))
      out(io, json, r, [`Project: ${r.slug} (${r.scope}) → ${r.db}`, ...r.warnings.map(w => `warning: ${w}`)].join('\n'))
      return 0
    }
    case 'import-vault': {
      const { importVault } = await import('../../memory/import-vault')
      const r = await importVault({ ...(one(p, 'vault') !== undefined ? { vault: resolve(one(p, 'vault') as string) } : {}), ...(p.bools.has('dry-run') ? { dryRun: true } : {}) })
      if (!r.found) { out(io, json, r, `No old vault at ${r.vault}: nothing to import.`); return 0 }
      const lines = [`${r.dryRun ? 'Would import' : 'Imported'} ${r.imported.length} memories from ${r.vault} (the vault was only read):`,
        ...r.imported.map(i => `  + ${i.layer === 'person' ? 'person' : i.project}/${i.id} (${i.kind}) <- ${i.from}`),
        ...(r.skipped.length > 0 ? [`Skipped ${r.skipped.length}:`, ...r.skipped.slice(0, 40).map(s => `  - ${s.from}: ${s.reason}`)] : [])]
      out(io, json, r, lines.join('\n'))
      return 0
    }
    case 'migrate': {
      const { memMigrateCommand } = await import('./mem-migrate')
      return memMigrateCommand({ json, has: k => p.bools.has(k), out: (value, text) => out(io, json, value, text), progress: line => { io.stderr.write(`buracle mem migrate: ${line}\n`) }, usage: message => { throw new UsageError(message) } })
    }
    case 'doctor': {
      const { doctorExitCode, memDoctor } = await import('../../memory/doctor')
      const checks = await memDoctor({ cwd: cwdOf(p), mcp: !p.bools.has('no-mcp') })
      const mark = { ok: '✓', info: 'ℹ', warn: '⚠', error: '✗' } as const
      out(io, json, { checks }, checks.map(c => `${mark[c.level]} ${c.check}: ${c.detail}`).join('\n'))
      return doctorExitCode(checks)
    }
    case 'ui': return uiCommand(p, io, json)
    case 'backup': case 'restore': case 'export': case 'import': {
      const { memDataCommand } = await import('./mem-data')
      return memDataCommand(sub, {
        rest, json, one: k => one(p, k), many: k => many(p, k), int: k => int(p, k), has: k => p.bools.has(k), project: () => projectFlag(p),
        ctx: () => ctxFor(p), stdin: () => stdinText(io), out: (value, text) => out(io, json, value, text), write: text => { io.stdout.write(text) },
        usage: message => { throw new UsageError(message) },
      })
    }
    default:
      io.stderr.write(`buracle mem: unknown subcommand '${sub}'\n\n${usage}`)
      return 1
  }
}

function finalizeText(r: import('../../memory/finalize').FinalizeResult): string {
  if (r.skipped !== undefined) return `skipped: ${r.skipped}`
  const lines = [r.memoryId !== undefined ? `session memory: ${r.memoryId}` : r.empty === true ? 'no model turn ran: no session memory' : 'not a project: no session memory']
  const c = r.capture
  if (c !== undefined) {
    const prefs = c.preferences
    lines.push(`preferences: ${prefs.written.length > 0 ? `filed ${prefs.written.join(', ')}` : 'none new'}${prefs.superseded.length > 0 ? `; replaced ${prefs.superseded.join(', ')}` : ''}`)
    const d = c.distill
    lines.push(d === undefined ? 'distillation: did not run'
      : d.ran ? `distillation: ${d.candidates.length} memor${d.candidates.length === 1 ? 'y' : 'ies'} written${d.candidates.length > 0 ? ` (${d.candidates.join(', ')})` : ''}`
      : `distillation: ${d.skipped ?? 'did not run'}${d.detail !== undefined ? ` (${d.detail})` : ''}; ${c.state === 'retry' ? 'another try is owed' : c.state === 'gave-up' ? 'given up after repeated failures' : 'nothing is owed'}`)
  }
  for (const x of r.pending ?? []) lines.push(`stale session ${x.harness}-${x.sid} (${x.why}): ${x.result.skipped !== undefined ? `skipped (${x.result.skipped})` : x.result.capture !== undefined ? `capture ${x.result.capture.state}` : 'finalized'}`)
  return lines.join('\n')
}

async function captureCommand(p: Parsed, io: CommandIO, json: boolean): Promise<number> {
  const fin = await import('../../memory/finalize')
  const { captureOff } = await import('../../memory/spool')
  if (captureOff()) { out(io, json, { skipped: 'capture-off' }, 'skipped: capture-off (BURACLE_NO_CAPTURE=1)'); return 0 }
  const wantPending = p.bools.has('pending')
  let target = harnessSession(p)
  if (target === undefined && one(p, 'session') !== undefined) {
    io.stderr.write('buracle mem capture: --session must be a session id of a harness (add --harness H when it is not the current one)\n')
    return 2
  }
  if (target === undefined && !wantPending) {
    const { projectSlugFor } = await import('../../memory/project')
    const { latestSessionRecord } = await import('../../memory/session-record')
    const slug = projectFlag(p) ?? (await projectSlugFor(cwdOf(p)).catch(() => undefined))
    const rec = slug !== undefined ? latestSessionRecord(slug) : undefined
    if (rec === undefined) {
      io.stderr.write('buracle mem capture: no session of this project to capture; pass --session SID (and --harness H), or --pending\n')
      return 2
    }
    target = { h: rec.harness, sid: rec.sid }
  }
  const limit = int(p, 'limit')
  const model = one(p, 'model')
  const opts = { force: true, redistill: p.bools.has('force'), ...(model !== undefined ? { model } : {}) }
  const lines: string[] = []
  let code = 0
  const results: unknown[] = []
  if (target !== undefined) {
    const r = await fin.finalize(target.h, target.sid, { ...opts, pending: wantPending ? limit ?? undefined : false })
    results.push(r)
    lines.push(finalizeText(r))
    if (r.skipped === 'invalid-session' || r.skipped === 'unknown-session') code = 2
  } else {
    const done = await fin.capturePending({ ...opts, ...(limit !== undefined ? { max: limit } : {}) })
    results.push(done)
    lines.push(done.length === 0 ? 'no stale session waits for its capture' : done.map(x => `stale session ${x.harness}-${x.sid} (${x.why}): ${finalizeText(x.result)}`).join('\n'))
  }
  out(io, json, results.length === 1 ? results[0] : results, lines.join('\n'))
  return code
}

async function uiCommand(p: Parsed, io: CommandIO, json: boolean): Promise<number> {
  const ui = await import('../../memory/ui')
  const { loadConfigSync } = await import('../../engine/config')
  const cfg = loadConfigSync({ repoRoot: paths.repoRoot() }).config.memory.ui
  const port = int(p, 'port') ?? cfg.port
  const want = one(p, 'page') ?? 'brain'
  if (want !== 'brain' && want !== 'review') throw new UsageError(`--page must be brain or review (got ${JSON.stringify(want)})`)
  if (p.bools.has('stop')) {
    const rec = ui.readUiRecord()
    const outcome = rec !== undefined ? await ui.stopUi(rec) : 'not-running'
    const stopped = outcome === 'stopped'
    const text = stopped ? 'The memory UI stopped.'
      : outcome === 'still-running' ? `The memory UI (pid ${rec?.pid}) did not exit after SIGTERM.`
      : outcome === 'unconfirmed' ? `No memory UI at ${rec?.url} confirms pid ${rec?.pid}, so nothing was stopped.`
      : 'The memory UI was not running.'
    out(io, json, { stopped }, text)
    return outcome === 'still-running' ? 1 : 0
  }
  if (p.bools.has('serve')) {
    const { sameUiBuild, uiBuildId } = await import('../../memory/ui-build')
    const build = uiBuildId()
    const live = await ui.liveUi()
    if (live !== undefined) {
      if (sameUiBuild(live.health.build, build)) {
        out(io, json, { url: live.url, started: false }, `The memory UI is already running: ${live.url}`)
        return 0
      }
      const outcome = await ui.stopUi(live)
      io.stderr.write(`buracle mem ui: the running memory UI (pid ${live.pid}, build ${live.health.build ?? live.health.version ?? 'unknown'}) is not this checkout's build: ${outcome === 'stopped' ? 'stopped it' : `could not stop it (${outcome})`}\n`)
    }
    const { buracleVersion } = await import('../../usage/bar-info')
    const { openSessionCount } = await import('../../memory/ui-presence')
    const served = ui.serveUi({
      port, version: buracleVersion(), ...(build !== undefined ? { build } : {}),
      idleMs: ui.uiIdleMs(),
      ...(cfg.autostart ? { sessions: () => openSessionCount(Date.now()) } : {}),
      onStop: () => process.exit(0),
    })
    const idleMinutes = Math.max(1, Math.round(ui.uiIdleMs() / 60_000))
    const idle = `${idleMinutes} minute${idleMinutes === 1 ? '' : 's'} without a request`
    const rule = cfg.autostart ? `it stops when the last harness session ends, or after ${idle} while no session has started` : `it stops by itself after ${idle}`
    io.stderr.write(`buracle mem ui: ${served.record.url} (pid ${served.record.pid}; Ctrl-C stops it, and ${rule})\n`)
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => { void served.stop().then(() => process.exit(0)) })
    await new Promise<never>(() => {  })
  }
  const { buracleArgv } = await import('../../usage/bar-info')
  const r = await ui.ensureUi(buracleArgv(), { port })
  if (r === undefined) {
    out(io, json, { error: 'not_started', message: 'the memory UI did not start' }, 'The memory UI did not start; for details run: buracle mem ui --serve')
    return 1
  }
  const { projectSlugFor } = await import('../../memory/project')
  const { bucketExists, projectRef } = await import('../../memory/store')
  const slug = want === 'brain' ? await projectSlugFor(cwdOf(p)).catch(() => undefined) : undefined
  const page = want === 'review' ? `${r.url.replace(/\/$/, '')}/review`
    : slug !== undefined && await bucketExists(projectRef(slug)).catch(() => false) ? `${r.url.replace(/\/$/, '')}/?scope=${encodeURIComponent(`project:${slug}`)}` : r.url
  const opened = p.bools.has('open') ? ui.openInBrowser(page) : false
  out(io, json, { url: r.url, ...(page !== r.url ? { page } : {}), started: r.started, opened }, `${want === 'review' ? 'Review page' : 'Memory UI'}: ${page}${r.started ? ' (started)' : ''}${opened ? ' · opened in the browser' : ''}`)
  return 0
}
