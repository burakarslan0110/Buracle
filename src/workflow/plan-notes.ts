import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { markNotesDone, NOTE_ID_RE, noteLines, openNotes, type ReviewNote } from '../core/plan/notes'
import { shellQuote } from '../core/policy/shell-text'
import { repoFacts } from './gitx'
import { checkoutId, changesTarget, docId, docTarget, readNotes, reviewPageUrl, updateNotes, type NotesTarget } from './review-notes'
import { resolveReviewScope } from './review-scope'
import { fail, ok, type CmdResult, type WorkflowCtx } from './result'
import { loadState, type ResolvedSession } from './session-store'

export const NOTE_KINDS = ['plan', 'code', 'all'] as const

interface Found { target: NotesTarget, page?: string }

async function docFound(path: string): Promise<Found | CmdResult> {
  const facts = await repoFacts(dirname(path))
  if (facts === undefined) return fail('not_a_repo', `the plan is not in a git repository: ${path}`)
  const target = docTarget(facts, path)
  if (target === undefined) return fail('not_a_review_doc', `the review page shows files directly under docs/plans, docs/builds or docs/prd of a repository; ${path} is not one`)
  const page = reviewPageUrl({ doc: docId(path) })
  return { target, ...(page !== undefined ? { page } : {}) }
}

async function codeFound(slug: string | undefined, ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<Found | CmdResult> {
  const r = await resolveReviewScope(slug, ctx.cwd, s)
  if ('error' in r) return fail(r.error, r.message)
  const checkout = r.scope.worktree_path ?? r.facts.top
  const branch = r.scope.mode === 'worktree' || r.scope.mode === 'branch' ? r.scope.branch : r.facts.branch
  const target = changesTarget(r.facts, branch, checkout)
  const page = reviewPageUrl({ checkout: checkoutId(checkout) })
  return { target, ...(page !== undefined ? { page } : {}) }
}

function isResult(x: Found | CmdResult): x is CmdResult {
  return 'code' in x && 'lines' in x
}

function shellWord(s: string): string {
  return /^[\w./-]+$/.test(s) ? s : shellQuote(s)
}

function noteJson(n: ReviewNote): Record<string, unknown> {
  return { ...n }
}

export async function planNotes(pathArg: string | undefined, o: { kind?: string, slug?: string, done?: string }, ctx: WorkflowCtx, s: ResolvedSession | undefined): Promise<CmdResult> {
  const kind = o.kind ?? 'all'
  if (!(NOTE_KINDS as readonly string[]).includes(kind)) return fail('usage', `--kind must be plan, code or all (got '${kind}')`)
  const ids = o.done === undefined ? [] : o.done.split(',').map(x => x.trim()).filter(x => x !== '')
  if (o.done !== undefined && (ids.length === 0 || ids.some(id => !NOTE_ID_RE.test(id)))) return fail('usage', `--done takes note ids such as n-1a2b3c4d, separated by commas (got '${o.done}')`)
  const bound = s !== undefined ? loadState(s.harness, s.sessionId).plan?.path : undefined
  const docPath = pathArg !== undefined ? resolve(ctx.cwd, pathArg) : bound
  if (pathArg !== undefined && (!existsSync(docPath as string) || !statSync(docPath as string).isFile())) return fail('not_found', `no such file: ${docPath}`)
  if (kind === 'plan' && docPath === undefined) return fail('usage', 'no plan is bound to this session: pass the path of the plan, build contract or PRD')
  const found: Array<{ kind: 'plan' | 'code', f: Found }> = []
  const warnings: string[] = []
  if (kind !== 'code' && docPath !== undefined) {
    const d = await docFound(docPath)
    if (isResult(d)) return d
    found.push({ kind: 'plan', f: d })
  }
  if (kind !== 'plan') {
    const c = await codeFound(o.slug, ctx, s)
    if (isResult(c)) {
      if (kind === 'code') return c
      warnings.push(`code notes skipped: ${c.errors.join('; ') || 'no repository here'}`)
    } else found.push({ kind: 'code', f: c })
  }
  const marked: string[] = []
  if (ids.length > 0) {
    for (const { f } of found) {
      marked.push(...updateNotes(f.target, file => {
        const r = markNotesDone(file, ids, new Date(ctx.now).toISOString())
        return { file: r.file, result: r.done }
      }, { now: ctx.now, byUser: false }))
    }
    const missing = ids.filter(id => !marked.includes(id))
    if (marked.length === 0) return fail('not_found', `no open note ${missing.join(', ')} here; run buracle plan notes --json to list the open ones`)
    if (missing.length > 0) warnings.push(`no open note ${missing.join(', ')}; it may be done already or belong to another plan`)
  }
  const sections = found.map(({ kind: k, f }) => {
    const notes = openNotes(readNotes(f.target)).filter(n => n.kind === k)
    return { kind: k, f, notes }
  })
  const open = sections.flatMap(x => x.notes)
  const plan = sections.find(x => x.kind === 'plan')
  const code = sections.find(x => x.kind === 'code')
  const page = plan?.f.page ?? code?.f.page ?? reviewPageUrl()
  const lines: string[] = []
  if (marked.length > 0) lines.push(`Marked as applied: ${marked.join(', ')}`)
  if (open.length === 0) {
    lines.push(`No open notes from the review page${plan !== undefined ? ` on ${plan.f.target.doc?.rel}` : ''}${code !== undefined ? `${plan !== undefined ? ' or' : ''} on the changes of ${code.f.target.branch ?? 'this checkout'}` : ''}. No notes is not an approval.`)
  } else {
    lines.push(`${open.length} open ${open.length === 1 ? 'note' : 'notes'} from the review page${page !== undefined ? ` (${page})` : ''}:`)
    for (const x of sections) {
      if (x.notes.length === 0) continue
      lines.push(x.kind === 'plan' ? `On ${x.f.target.doc?.rel}:` : `On the changes of ${x.f.target.branch ?? 'this checkout'}:`)
      for (const n of x.notes) lines.push(...noteLines(n))
    }
    lines.push(`Apply each note (or say why not), then mark it: buracle plan notes ${pathArg !== undefined && plan !== undefined ? `${shellWord(pathArg)} ` : ''}--done <id>[,<id>]`)
  }
  return ok({
    ok: true,
    doc: plan !== undefined && plan.f.target.doc !== undefined ? { path: plan.f.target.doc.path, rel: plan.f.target.doc.rel } : null,
    branch: code?.f.target.branch ?? null,
    checkout: code?.f.target.checkout ?? null,
    page: page ?? null,
    open: open.length,
    notes: open.map(noteJson),
    ...(ids.length > 0 ? { done: marked } : {}),
  }, lines, warnings)
}
