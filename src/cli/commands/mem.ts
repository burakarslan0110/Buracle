import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { CommandIO } from '../router'
import type { Harness } from '../../core/events'
import { HARNESSES, isHarness } from '../../core/events'
import { memIsSlug } from '../../core/memory/note'
import { memSegmentWith } from '../../core/memory/status'
import * as paths from '../../engine/paths'
import { resolveSession } from '../../workflow/session-store'

export const name = 'mem'
export const summary = 'Memory (CortexDB brains per project and for the person): search, get, write, update, status, sweep, reflect, profile, import, web UI'
export const usage = `Usage: buracle mem <subcommand> [args…] [--json]

The memory lives in ~/.buracle/brain: one CortexDB file per project (projects/<slug>.db) and one for
the person (person.db). A command reaches only the current project's file and the person's.

Memories (CLI twins of the MCP tools)
  search ["<query>"] [--layer project|person|all] [--type K]… [--status live|any] [--since D] [--until D] [--limit N]
         [--file PATH]… [--tag T]… [--about A]… [--offset N] [--around ID [--depth N]]
                                             a filter works without a query: --file lists the memories that
                                             cite a file or a folder (path relative to the root); --offset
                                             pages on; --around lists what was recorded before and after ID
  get ID…                                    up to 5 memories in full (person/<id> picks the person layer)
  write --type K --title "…" --summary "…" [--body "…" | --body-file F | stdin] [--layer project|person]
        [--source S]… [--tag T]… [--about A]… [--supersedes ID]… [--importance 1-5] [--pin] [--force] [--review ok]
  update ID --patch '<json>' [--reason "…"] [--expected-version N]
                                             e.g. --patch '{"review":"ok"}', '{"status":"deprecated"}',
                                             '{"merge_into":"<id>"}', '{"move":{"kind":"decision"}}'
  remember "<text>"                          a capture the next harness files
  status [--project SLUG] [--style compact|wide] [--refresh]
                                             counts per brain region and the upkeep queue
  context [--harness H] [--cwd DIR]          the session-start memory text (--json: {"text": …})

Backups and moving a brain (the brains stay on this machine; nothing is synced)
  backup [--project SLUG | --person] [--keep N]
                                             copy the brains (all of them by default) into
                                             ~/.buracle/brain/backups/<id>/ and keep the newest 10 copies
                                             of each brain (--keep N); the tick copies each brain once a day
  backup --list                              the backups, newest first, with the brains each holds
  restore ID (--project SLUG | --person | --all)
                                             put a backup's copy back; the file it replaces goes into a
                                             pre-restore backup first, and the running CortexDB readers
                                             of that brain are stopped (sessions start new ones)
  export [--project SLUG | --person] [--type K]… [--out FILE]
                                             the live memories of one brain as JSON lines, secrets masked
                                             again (decisions, gotchas, procedures, knowledge, references,
                                             preferences and core pages; --type picks kinds, capture too)
  import FILE|- [--project SLUG] [--dry-run]
                                             write an export into this project's brain and the person's
                                             through memory_write: duplicates and what an earlier import
                                             brought are skipped, and every memory starts unverified

Upkeep (the memory keeps itself clean; the harnesses do the work)
  sweep [--project SLUG | --all] [--dry-run] [--quiet]
                                             delete what ran out (expired sessions and handoffs, memories
                                             retired 30 days ago), refresh the core pages from the
                                             repository and the upkeep queue (git looks at cited files)
  reflect [--project SLUG | --person] [--harness H] [--model M] [--dry-run]
                                             the brain questions itself: the model proposes small edits
                                             from an allowlist (tags, links, doubts, filing, merging
                                             flagged duplicates, drafts); never deletes or verifies. It
                                             runs through a harness with usage headroom: the calling
                                             agent's (or --harness) first, then any other with room
  heal [--project SLUG] [--quiet]           repair what the memory status reports: reinstall CortexDB
                                             and the embedding model, restart the brain readers, check
                                             the MCP server, prune and drain the distill queue, sweep and
                                             reflect (sessions run it in the background while the status is not ok)
  heal --list                                the recent repairs and what each step did
  jobs [--job ID] [--project SLUG] [--limit N]
                                             every automatic memory job (kick, finalize, sweep, distill,
                                             reflect, verify, heal, profile): when it last ran, what it
                                             did, why it was skipped or failed, and when it runs
  verify [--project SLUG] [--harness H] [--model M] [--dry-run] [--quiet]
                                             check waiting memories against the code: Buracle reads the
                                             cited files at HEAD, the model judges with verbatim quotes,
                                             and only a claim with checked quotes is marked verified
  verify --list | --undo RUN                 the recent verifier runs; take one back
  reflect --list                             the recent reflect runs (what each one changed)
  reflect --undo RUN                         take a reflect run back (memories changed since are left alone)
  profile [--rebuild]                        the user profile the agents start with
  profile drop "<text|key>" [--all]          take a wrongly learned line out of the profile
  project init [--cwd DIR]                   map this folder to its project and create its core pages
  import-vault [--vault PATH] [--dry-run]    copy the live notes of the old Obsidian vault into the
                                             brains once (the vault is only read)
  doctor [--no-mcp]                          CortexDB binary, brain files, leak check, MCP handshake
                                             (--json: {"checks":[{level,check,detail}]}; exit 1 errors, 2 warnings)
  ui [--open] [--port N] [--stop]            the brain web UI (http://localhost:41777): starts it in the
                                             background when it does not run, prints its address
  ui --page review [--open]                  the review page of the same UI: the plans, build contracts
                                             and PRDs of your projects and the agent's changes, where you
                                             pin notes the agent reads (buracle plan notes)
  ui --serve [--port N] [--for-session]      run the web UI in the foreground; it stops by itself once no
                                             harness session has been open for a while (--for-session: one
                                             is open as it starts, as the session-start autostart says)

Sessions (called by hooks; nothing is recorded under BURACLE_NO_CAPTURE=1)
  start --harness H --session SID [--cwd DIR]
  kick [--harness H --session SID] [--cwd DIR]
                                             the session-start upkeep (every start runs it detached):
                                             sweep, store check and repair, stale sessions, orphan
                                             spools, dead locks
  tick [--harness H --session SID] [--cwd DIR] [--trigger cli|prompt|session-start|session-end|compact|window-reset] [--at ISO] [--quiet]
                                             the machine-wide upkeep (every prompt, session start or
                                             end and compaction in any harness runs it detached, at
                                             most once a minute): the kick's work for every active
                                             project, the distill queue, reflect of the brains that
                                             changed (the curator included), the verifier and the repair
  finalize --harness H --session SID [--detach]
  handoff --harness H --session SID [--cwd DIR] [--branch B] [--slug S] [--trigger T]   (markdown on stdin)
  distill [--harness H --session SID | --pending] [--model M] [--dry-run]
                                             LLM summary (budgeted per call) through a harness with
                                             usage headroom: the session's own first, then any other

Global: --json for machine-readable output. Exit codes: 0 ok, 1 error, 2 user action needed.
`

interface Parsed { pos: string[], flags: Map<string, string[]>, bools: Set<string> }

const VALUE_FLAGS = new Set([
  'vault', 'cwd', 'project', 'style', 'scope', 'layer', 'type', 'kind', 'status', 'since', 'until', 'limit', 'max-tokens',
  'title', 'summary', 'description', 'body', 'body-file', 'source', 'supersedes', 'tag', 'importance', 'review', 'harness',
  'session', 'model', 'port', 'patch', 'reason', 'expected-version', 'branch', 'slug', 'trigger', 'undo', 'job',
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
    if (VALUE_FLAGS.has(key)) {
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
      return e.code === 'conflict' || e.code === 'store_unavailable' || e.code === 'no_project' ? 2 : 1
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
      const { memoryStatusReport } = await import('../../memory/report')
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
      const r = await memoryStatusReport(ctx, { ...(int(p, 'limit') !== undefined ? { limit: int(p, 'limit') as number } : {}) })
      const seg = memSegmentWith(r.status, Date.now(), one(p, 'style') === 'compact' ? 'compact' : 'wide', { emoji: true })
      out(io, json, { status: r.status, ...(r.excluded !== undefined ? { excluded: r.excluded } : {}), regions: r.regions, profile: r.profile, upkeep: r.upkeep, ...(r.sweptAt !== undefined ? { sweptAt: r.sweptAt } : {}) }, `${seg.text}\n${r.text}`)
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
      })
      const text = r.action === 'duplicate_suspected'
        ? ['duplicate suspected; nothing written. Similar memories:', ...(r.similar ?? []).map(s => `  ${s.id} (${s.score}) ${s.title}`), 'Update one of them (buracle mem update), or write again with --force.'].join('\n')
        : `${r.action} ${r.layer === 'person' ? 'person/' : ''}${r.id}${r.redactions ? ` (redacted ${r.redactions} secret(s))` : ''}`
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
      })
      out(io, json, r, r.changed.length === 0 ? `${r.id}: nothing changed` : `${r.moved_to !== undefined ? `moved to ${r.moved_to.layer}/${r.moved_to.id}` : `updated ${r.id}`} (version ${r.version}: ${r.changed.join(', ')})`)
      return 0
    }
    case 'remember': {
      const { remember } = await import('../../memory/api')
      const text = rest.length > 0 ? rest.join(' ') : await stdinText(io)
      const r = await remember(await ctxFor(p), text)
      out(io, json, r, `saved as a capture: ${r.layer === 'person' ? 'person/' : ''}${r.id} (the next harness files it)`)
      return 0
    }
    case 'context': {
      const { contextText } = await import('../../memory/context')
      const h = one(p, 'harness')
      const text = await contextText({ cwd: cwdOf(p), ...(h !== undefined ? { harness: h } : {}) })
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
      const r = await fin.finalize(hs.h, hs.sid, detached ? { graceMs: FINALIZER_GRACE_MS, settleMs: FINALIZER_SETTLE_MS } : {})
      out(io, json, r, r.skipped !== undefined ? `skipped: ${r.skipped}` : r.memoryId !== undefined ? `session memory: ${r.memoryId}` : r.empty === true ? 'no model turn ran: no session memory' : 'not a project: no session memory')
      return r.skipped === 'invalid-session' ? 2 : 0
    }
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
    case 'distill': {
      const d = await import('../../memory/distill')
      const dry = p.bools.has('dry-run')
      if (p.bools.has('pending')) {
        const r = await d.distillPending({ dryRun: dry, ...(one(p, 'model') !== undefined ? { model: one(p, 'model') as string } : {}) })
        out(io, json, r, r.length === 0 ? 'nothing queued' : r.map(x => `${x.harness}/${x.sid} (${x.model ?? 'default model'}): ${x.ran ? 'distilled' : `skipped (${x.skipped}${x.detail ? `: ${x.detail}` : ''})`}`).join('\n'))
        return 0
      }
      const hs = harnessSession(p)
      if (!hs) { io.stderr.write('buracle mem distill: --harness and --session, or --pending\n'); return 2 }
      const r = await d.distillSession(hs.h, hs.sid, { dryRun: dry, ...(one(p, 'model') !== undefined ? { model: one(p, 'model') as string } : {}) })
      out(io, json, r, r.ran ? `distilled: ${r.decisions.length} candidate(s) (${r.candidates.length} written)` : `skipped (${r.skipped}${r.detail ? `: ${r.detail}` : ''})`)
      return r.ran || r.skipped === 'dry-run' || r.skipped === 'nothing-to-distill' ? 0 : 2
    }
    case 'sweep': {
      const { sweep } = await import('../../memory/sweep')
      const { projectSlugFor } = await import('../../memory/project')
      const all = p.bools.has('all')
      const slug = all ? undefined : projectFlag(p) ?? (await projectSlugFor(cwdOf(p)).catch(() => undefined))
      const r = await sweep({ ...(slug !== undefined ? { slug } : {}), all, ...(p.bools.has('dry-run') ? { dryRun: true } : {}), trigger: one(p, 'trigger') ?? 'cli' })
      const { refreshStatus } = await import('../../memory/status')
      if (!r.dryRun) for (const l of r.layers) if (l.project !== undefined) await refreshStatus({ slug: l.project })
      if (p.bools.has('quiet') && !json) return 0
      const lines = r.layers.map(l => `${l.project ?? 'person'}: ${l.skipped !== undefined ? `skipped (${l.skipped})` : `${r.dryRun ? 'would delete' : 'deleted'} ${l.pruned.length}${l.pruned.length > 0 ? ` (${[...new Set(l.pruned.map(x => x.reason))].join(', ')})` : ''}; core pages ${l.core.length > 0 ? `refreshed: ${l.core.join(', ')}` : 'current'}; upkeep ${l.upkeep}${(l.absorbed ?? []).map(x => `; took over ${x.copied.length} from the folder project ${x.from}`).join('')}`}`)
      out(io, json, r, lines.join('\n') || 'nothing to sweep')
      return 0
    }
    case 'reflect': return reflectCommand(p, io, json)
    case 'heal': return healCommand(p, io, json)
    case 'verify': return verifyCommand(p, io, json)
    case 'kick': {
      const flagH = one(p, 'harness')
      if (flagH !== undefined && !isHarness(flagH)) throw new UsageError(`--harness must be one of ${HARNESSES.join(', ')}`)
      const sid = one(p, 'session')
      const { kick } = await import('../../memory/kick')
      const r = await kick({ cwd: cwdOf(p), ...(flagH !== undefined ? { harness: flagH } : {}), ...(sid !== undefined && paths.isValidSessionId(sid) ? { sid } : {}) })
      out(io, json, r, [
        `project: ${r.slug ?? 'none'}; store: ${r.store}`,
        `swept: ${r.swept.length > 0 ? r.swept.join(', ') : 'nothing due'}`,
        `repair: ${r.healStarted ? 'started' : 'not needed or not due'}`,
        `stale sessions handed to finalizers: ${r.staleFinalized.length > 0 ? r.staleFinalized.join(', ') : 'none'}`,
        `orphan spools handed to finalizers: ${r.orphansFinalized.length > 0 ? r.orphansFinalized.join(', ') : 'none'}`,
        `dead locks removed: ${r.locksRemoved}`,
      ].join('\n'))
      return r.store === 'ok' ? 0 : 2
    }
    case 'tick': {
      const flagH = one(p, 'harness')
      if (flagH !== undefined && !isHarness(flagH)) throw new UsageError(`--harness must be one of ${HARNESSES.join(', ')}`)
      const sid = one(p, 'session')
      const trigger = one(p, 'trigger') ?? 'cli'
      if (trigger !== 'cli' && trigger !== 'prompt' && trigger !== 'session-start' && trigger !== 'session-end' && trigger !== 'compact' && trigger !== 'window-reset') throw new UsageError('--trigger must be cli, prompt, session-start, session-end, compact or window-reset')
      const at = one(p, 'at')
      if (at !== undefined && !Number.isFinite(Date.parse(at))) throw new UsageError('--at must be an ISO time (the window-reset timer sleeps until then)')
      const { tick } = await import('../../memory/tick')
      const r = await tick({ cwd: cwdOf(p), trigger, ...(at !== undefined ? { at } : {}), ...(flagH !== undefined ? { harness: flagH } : {}), ...(sid !== undefined && paths.isValidSessionId(sid) ? { sid } : {}) })
      if (p.bools.has('quiet') && !json) return r.skipped === undefined ? 0 : 2
      out(io, json, r, r.skipped !== undefined ? `tick skipped: ${r.skipped === 'busy' ? 'another tick is running' : r.skipped === 'replaced' ? 'another window-reset timer took over' : 'CortexDB is not installed (the repair was asked to install it)'}` : [
        `projects: ${r.projects.length > 0 ? r.projects.join(', ') : 'none active'}`,
        `swept: ${r.swept.length > 0 ? r.swept.join(', ') : 'nothing due'}`,
        `distilled: ${r.distilled}`,
        `reflected: ${r.reflected.length > 0 ? r.reflected.join(', ') : 'nothing (no brain changed, or nothing to do)'}`,
        `verifier started: ${r.verifyStarted.length > 0 ? r.verifyStarted.join(', ') : 'no'}`,
        `repair started: ${r.healStarted.length > 0 ? r.healStarted.join(', ') : 'not needed or not due'}`,
        `stale sessions handed to finalizers: ${r.staleFinalized.length > 0 ? r.staleFinalized.join(', ') : 'none'}`,
        `orphan spools handed to finalizers: ${r.orphansFinalized.length > 0 ? r.orphansFinalized.join(', ') : 'none'}`,
        `dead locks removed: ${r.locksRemoved}`,
        `daily backup: ${r.backup ?? 'not due'}`,
      ].join('\n'))
      return r.skipped === undefined ? 0 : 2
    }
    case 'jobs': {
      const jobs = await import('../../memory/jobs')
      const job = one(p, 'job')
      if (job !== undefined && !(jobs.JOB_IDS as readonly string[]).includes(job)) throw new UsageError(`--job must be one of ${jobs.JOB_IDS.join(', ')}`)
      const now = Date.now()
      const project = projectFlag(p)
      const entries = jobs.readJobs().filter(e => (job === undefined || e.job === job) && (project === undefined || e.project === undefined || e.project === project))
      if (job !== undefined) {
        const recent = entries.slice(-(int(p, 'limit') ?? 20)).reverse()
        out(io, json, { job, schedule: jobs.JOB_SCHEDULE[job as import('../../memory/jobs').JobId], entries: recent },
          [`${job}: ${jobs.JOB_SCHEDULE[job as import('../../memory/jobs').JobId]}`, ...(recent.length === 0 ? ['  no entries yet'] : recent.map(e => `  ${e.at.slice(0, 16).replace('T', ' ')}  ${e.trigger}  ${jobs.jobEntryLine(e, now)}`))].join('\n'))
        return 0
      }
      const views = jobs.jobsOverview(now, { entries, ...(project !== undefined ? { project } : {}) })
      out(io, json, { jobs: views }, views.map(v => [
        `${v.job}  (${v.schedule})`,
        `  last: ${v.last !== undefined ? jobs.jobEntryLine(v.last, now) : 'never'}`,
        ...(v.lastRan !== undefined && v.lastRan !== v.last ? [`  last run: ${jobs.jobEntryLine(v.lastRan, now)}`] : []),
        ...(v.lastFailed !== undefined && v.lastFailed !== v.last ? [`  last failure: ${jobs.jobEntryLine(v.lastFailed, now)}`] : []),
        `  24 h: ${v.day.ran} ran, ${v.day.skipped} skipped, ${v.day.failed} failed`,
      ].join('\n')).join('\n'))
      return 0
    }
    case 'profile': {
      const prof = await import('../../memory/profile')
      if (rest[0] === 'drop') {
        const query = rest.slice(1).join(' ').trim()
        if (query === '') throw new UsageError('usage: buracle mem profile drop "<text of the line | claim key>" [--all]')
        const r = await prof.dropProfileClaim(query, { all: p.bools.has('all') })
        if (r.matches.length === 0) {
          if (json) out(io, json, r, '')
          else io.stderr.write(`buracle mem profile drop: no learned line matches ${JSON.stringify(query)} (see \`buracle mem profile\`)\n`)
          return 1
        }
        if (r.dropped.length === 0) {
          out(io, json, r, [`${r.matches.length} learned lines match ${JSON.stringify(query)}; nothing was dropped. Pass one key, or --all:`, ...r.matches.map(m => `  ${m.key}  ${m.text}`)].join('\n'))
          return 2
        }
        out(io, json, r, ['Dropped from the profile (it comes back only if the user states it again):', ...r.dropped.map(m => `  ${m.key}  ${m.text}`)].join('\n'))
        return 0
      }
      if (p.bools.has('rebuild')) await prof.updateProfile({})
      const s = await prof.profileSummary()
      const lines = [
        `${s.claims} claims from ${s.sessions} sessions${s.at !== undefined ? `, computed ${new Date(s.at).toISOString()}` : ''} (person brain: ${paths.brainDir()}/person.db)`,
        ...(s.top.length > 0 ? ['', 'What sessions start with:', ...s.top] : ['', 'Nothing learned yet: the profile fills in as sessions end.']),
        ...(s.hypotheses.length > 0 ? ['', 'Hypotheses (listed, never injected):', ...s.hypotheses] : []),
      ]
      out(io, json, s, lines.join('\n'))
      return 0
    }
    case 'project': {
      if (rest[0] !== 'init') throw new UsageError('usage: buracle mem project init [--cwd DIR]')
      const { projectInit } = await import('../../memory/project-init')
      const r = await projectInit(cwdOf(p))
      out(io, json, r, [`Project: ${r.slug} (${r.scope}) → ${r.db}`, `Core pages: ${r.core.length > 0 ? `created or refreshed ${r.core.join(', ')}` : 'current'}`, ...r.warnings.map(w => `warning: ${w}`)].join('\n'))
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

async function healCommand(p: Parsed, io: CommandIO, json: boolean): Promise<number> {
  const heal = await import('../../memory/heal')
  const runLine = (r: import('../../memory/heal').HealRun): string => [
    `${r.at.slice(0, 16).replace('T', ' ')}  ${r.trigger}  ${r.project ?? 'person'}  ${r.before.health} -> ${r.after.health}${r.after.reasons.length > 0 ? ` (${r.after.reasons.join(', ')})` : ''}  ${r.ok ? 'ok' : 'a step failed'}`,
    ...r.steps.map(s => `  ${s.ok ? 'ok  ' : 'fail'} ${s.step}: ${s.detail}`),
  ].join('\n')
  if (p.bools.has('list')) {
    const runs = heal.healRuns()
    out(io, json, { runs, running: heal.healRunning() }, runs.length === 0 ? 'No repairs yet.' : runs.map(runLine).join('\n'))
    return 0
  }
  const trigger = one(p, 'trigger') ?? 'cli'
  if (!['session-start', 'session-end', 'tick', 'ui', 'cli'].includes(trigger)) throw new UsageError('--trigger must be session-start, session-end, tick, ui or cli')
  const flagH = one(p, 'harness')
  if (flagH !== undefined && !isHarness(flagH)) throw new UsageError(`--harness must be one of ${HARNESSES.join(', ')}`)
  const { projectSlugFor } = await import('../../memory/project')
  const slug = projectFlag(p) ?? (await projectSlugFor(cwdOf(p)).catch(() => undefined))
  const sid = one(p, 'session')
  const model = flagH !== undefined && sid !== undefined ? (await import('../../memory/runner')).sessionModel(flagH, sid) : undefined
  const r = await heal.healBrain({
    trigger: trigger as import('../../memory/heal').HealTrigger, ...(slug !== undefined ? { slug } : {}),
    ...(flagH !== undefined ? { harness: flagH } : {}), ...(model !== undefined ? { model } : {}),
  })
  if ('skipped' in r) {
    out(io, json, r, `skipped: ${r.detail}`)
    return r.skipped === 'busy' ? 0 : 2
  }
  if (p.bools.has('quiet') && !json) return 0
  out(io, json, r, r.steps.length === 0 ? `${runLine(r)}\n  nothing to repair` : runLine(r))
  return r.after.health === 'error' ? 2 : 0
}

async function verifyCommand(p: Parsed, io: CommandIO, json: boolean): Promise<number> {
  const v = await import('../../memory/verify')
  const runLine = (e: import('../../memory/verify').VerifyRunEntry): string => {
    const what = e.skipped !== undefined ? `skipped (${e.skipped}${e.detail !== undefined ? `: ${e.detail}` : ''})`
      : `${e.dryRun === true ? 'dry run: ' : ''}${e.verified.length} verified, ${e.contradicted.length} contradicted, ${e.unsure.length} unsure (${e.checked} checked)`
    return `${e.id}  ${e.at.slice(0, 16).replace('T', ' ')}  project ${e.project}  ${e.trigger}  ${e.harness ?? '-'}/${e.model}  ${what}${e.undone !== undefined ? '  [undone]' : ''}`
  }
  const undoId = one(p, 'undo')
  if (undoId !== undefined) {
    const u = await v.undoVerify(undoId)
    out(io, json, u, [`Undid ${u.runId} (project ${u.project}): restored ${u.restored.length}${u.restored.length > 0 ? ` (${u.restored.join(', ')})` : ''}`, ...u.conflicts.map(c => `  conflict: ${c.id} ${c.reason === 'gone' ? 'is gone' : 'changed since the run'}; left as it is`)].join('\n'))
    return u.conflicts.length > 0 ? 2 : 0
  }
  if (p.bools.has('list')) {
    const runs = v.listVerifyRuns(20)
    out(io, json, { runs }, runs.length === 0 ? 'No verifier runs yet.' : runs.map(runLine).join('\n'))
    return 0
  }
  const { projectSlugFor } = await import('../../memory/project')
  const slug = projectFlag(p) ?? (await projectSlugFor(cwdOf(p)).catch(() => undefined))
  if (slug === undefined) { io.stderr.write('buracle mem verify: this folder is not inside a project; pass --project SLUG\n'); return 2 }
  const trigger = one(p, 'trigger') ?? 'manual'
  if (!['manual', 'session-end', 'heal', 'session-start', 'tick'].includes(trigger)) throw new UsageError('--trigger must be manual, session-end, heal, session-start or tick')
  const via = await reflectVia(p, slug)
  const run = await v.verifyProject(slug, { trigger: trigger as import('../../memory/verify').VerifyTrigger, ...via, ...(p.bools.has('dry-run') ? { dryRun: true } : {}) })
  if (p.bools.has('quiet') && !json) return 0
  const lines = [runLine(run)]
  for (const x of run.verified) lines.push(`  verified ${x.id}: ${x.checked}`)
  for (const x of run.contradicted) lines.push(`  contradicted ${x.id}: ${x.note}`)
  for (const x of run.unsure) lines.push(`  unsure ${x.id}${x.why !== undefined ? ` (${x.why})` : ''}`)
  if ((run.verified.length > 0 || run.contradicted.length > 0) && run.dryRun !== true) lines.push(`Undo: buracle mem verify --undo ${run.id}`)
  out(io, json, run, lines.join('\n'))
  return run.skipped === undefined || run.skipped === 'nothing-to-do' ? 0 : 2
}

async function reflectCommand(p: Parsed, io: CommandIO, json: boolean): Promise<number> {
  const r = await import('../../memory/reflect')
  const runLine = (e: import('../../memory/reflect').ReflectRunEntry): string => {
    const scope = e.layer === 'person' ? 'person' : `project ${e.project ?? '?'}`
    const what = e.skipped !== undefined ? `skipped (${e.skipped}${e.detail !== undefined ? `: ${e.detail}` : ''})`
      : `${e.dryRun === true ? `dry run, would apply ${e.planned?.length ?? 0}` : `applied ${e.applied.length}`}, rejected ${e.rejected.length} (${e.rounds} model call${e.rounds === 1 ? '' : 's'}, ${e.subQueries} sub-quer${e.subQueries === 1 ? 'y' : 'ies'}, ${e.shown} shown)`
    return `${e.id}  ${e.at.slice(0, 16).replace('T', ' ')}  ${scope}  ${e.trigger}  ${e.harness ?? '-'}/${e.model}  ${what}${e.undone !== undefined ? '  [undone]' : ''}`
  }
  const undoId = one(p, 'undo')
  if (undoId !== undefined) {
    const u = await r.undoReflect(undoId)
    const text = [
      `Undid ${u.runId} (${u.layer === 'person' ? 'person' : `project ${u.project ?? '?'}`}): restored ${u.restored.length}${u.restored.length > 0 ? ` (${u.restored.join(', ')})` : ''}, retired ${u.retired.length} draft(s)`,
      ...u.conflicts.map(c => `  conflict: ${c.id} ${c.reason === 'gone' ? 'is gone' : 'changed since the run'}; left as it is`),
    ].join('\n')
    out(io, json, u, text)
    return u.conflicts.length > 0 ? 2 : 0
  }
  if (p.bools.has('list')) {
    const runs = r.listReflectRuns(20)
    out(io, json, { runs }, runs.length === 0 ? 'No reflect runs yet.' : runs.map(runLine).join('\n'))
    return 0
  }
  const { personRef, projectRef } = await import('../../memory/store')
  let ref
  if (p.bools.has('person')) {
    if (projectFlag(p) !== undefined) throw new UsageError('pass --project SLUG or --person, not both')
    ref = personRef()
  } else {
    const { projectSlugFor } = await import('../../memory/project')
    const slug = projectFlag(p) ?? (await projectSlugFor(cwdOf(p)).catch(() => undefined))
    if (slug === undefined) {
      io.stderr.write('buracle mem reflect: this folder is not inside a project; pass --project SLUG or --person\n')
      return 2
    }
    ref = projectRef(slug)
  }
  const via = await reflectVia(p, ref.slug)
  const run = await r.reflectBrain(ref, { trigger: 'manual', ...via, ...(p.bools.has('dry-run') ? { dryRun: true } : {}) })
  const { logged: _logged, ...entry } = run
  const lines = [runLine(entry)]
  for (const a of run.dryRun === true ? run.planned ?? [] : run.applied) lines.push(`  ${run.dryRun === true ? 'would' : 'did'} ${a.op} ${a.id}${a.to !== undefined ? ` -> ${a.to}` : ''}${a.why !== '' ? `: ${a.why}` : ''}`)
  for (const x of run.rejected) lines.push(`  rejected ${x.op}${x.id !== undefined ? ` ${x.id}` : ''}: ${x.reason}`)
  if (run.applied.length > 0 && run.dryRun !== true) lines.push(`Undo: buracle mem reflect --undo ${run.id}`)
  out(io, json, entry, lines.join('\n'))
  return run.rounds > 0 || run.skipped === 'nothing-to-do' ? 0 : 2
}

async function reflectVia(p: Parsed, slug: string | undefined): Promise<{ harness?: Harness, model?: string }> {
  const flagH = one(p, 'harness')
  if (flagH !== undefined && !isHarness(flagH)) throw new UsageError(`--harness must be one of ${HARNESSES.join(', ')}`)
  const { latestSessionRecord } = await import('../../memory/session-record')
  const { sessionModel } = await import('../../memory/runner')
  const caller = resolveSession(flagH !== undefined ? { harness: flagH } : {})
  const rec = caller === undefined ? latestSessionRecord(slug, flagH) : undefined
  const h = caller?.harness ?? rec?.harness ?? flagH
  const sid = caller?.sessionId ?? rec?.sid
  const model = one(p, 'model') ?? (h !== undefined && sid !== undefined ? sessionModel(h, sid) : undefined)
  return { ...(h !== undefined ? { harness: h } : {}), ...(model !== undefined ? { model } : {}) }
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
    const stopAfterMs = Number(process.env['BURACLE_UI_STOP_AFTER_MS'])
    const exit = (clearRecord: boolean): void => {
      if (clearRecord) ui.clearUiRecord()
      try { server.stop(true) } catch {  }
      void (async () => { try { await (await import('../../memory/cortex')).closeAllCortex() } catch {  } process.exit(0) })()
    }
    const { server, record } = ui.serveUi({
      port, version: buracleVersion(), ...(build !== undefined ? { build } : {}),
      ...(Number.isFinite(stopAfterMs) && stopAfterMs > 0 ? { stopAfterMs } : {}),
      ...(p.bools.has('for-session') ? { sessionAtStart: true } : {}),
      onStop: () => exit(false),
    })
    io.stderr.write(`buracle mem ui: ${record.url} (pid ${record.pid}; Ctrl-C stops it, and it stops by itself once no harness session has been open for a while)\n`)
    for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.on(sig, () => exit(true))
    await new Promise<never>(() => {  })
  }
  const { buracleArgv } = await import('../../usage/bar-info')
  const r = await ui.ensureUi(buracleArgv(), { port })
  if (r === undefined) {
    out(io, json, { error: 'not_started', message: 'the memory UI did not start' }, 'The memory UI did not start; for details run: buracle mem ui --serve')
    return 1
  }
  const { projectSlugFor } = await import('../../memory/project')
  const { brainExists, projectRef } = await import('../../memory/store')
  const slug = want === 'brain' ? await projectSlugFor(cwdOf(p)).catch(() => undefined) : undefined
  const page = want === 'review' ? `${r.url.replace(/\/$/, '')}/review`
    : slug !== undefined && brainExists(projectRef(slug)) ? `${r.url.replace(/\/$/, '')}/?scope=${encodeURIComponent(`project:${slug}`)}` : r.url
  const opened = p.bools.has('open') ? ui.openInBrowser(page) : false
  out(io, json, { url: r.url, ...(page !== r.url ? { page } : {}), started: r.started, opened }, `${want === 'review' ? 'Review page' : 'Memory UI'}: ${page}${r.started ? ' (started)' : ''}${opened ? ' · opened in the browser' : ''}`)
  return 0
}
