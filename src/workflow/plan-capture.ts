import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Harness } from '../core/events'
import { isHarness } from '../core/events'
import { capturedPlanMarkdown, normalizePlanText, planTitleOf, type PlanCaptureVia } from '../core/plan/capture'
import { revParse } from '../engine/git'
import { localDate, slugFromTitle } from './plan-file'
import { fail, ok, type CmdResult, type WorkflowCtx } from './result'
import type { ResolvedSession } from './session-store'

export const CAPTURE_SLOTS = 99

export interface PlanCaptureInput {
  plan: string
  cwd: string
  now: number
  harness: Harness
  approved?: boolean
  title?: string
  via?: PlanCaptureVia
}

export interface PlanCaptureResult { path: string, slug: string, title: string, created: string, approved: boolean }

function claim(path: string, content: string): boolean {
  let fd: number
  try {
    fd = openSync(path, 'wx', 0o644)
  } catch (e) {
    if ((e as { code?: string }).code === 'EEXIST') return false
    throw e
  }
  try {
    const buf = Buffer.from(content, 'utf8')
    let off = 0
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off)
  } finally {
    closeSync(fd)
  }
  return true
}

export async function capturePlanFile(i: PlanCaptureInput): Promise<PlanCaptureResult | undefined> {
  const text = normalizePlanText(i.plan)
  if (text === '') return undefined
  const top = await revParse(i.cwd, '--show-toplevel').catch(() => undefined)
  const root = top !== undefined && top !== '' ? top : i.cwd
  const created = localDate(i.now)
  const title = i.title !== undefined && i.title.trim() !== '' ? i.title.replace(/\s+/g, ' ').trim() : planTitleOf(text)
  const base = slugFromTitle(title, 60) || 'plan'
  const approved = i.approved ?? true
  const content = capturedPlanMarkdown(text, { created, harness: i.harness, approved, title, ...(i.via !== undefined ? { via: i.via } : {}) })
  const dir = join(root, 'docs', 'plans')
  mkdirSync(dir, { recursive: true })
  for (let n = 1; n <= CAPTURE_SLOTS; n++) {
    const slug = n === 1 ? base : `${base}-${n}`
    const path = join(dir, `${created}-${slug}.md`)
    if (claim(path, content)) return { path, slug, title, created, approved }
  }
  return undefined
}

export function shownPath(path: string, cwd: string): string {
  const rel = relative(cwd, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : path
}

export async function planCapture(o: { title?: string, harness?: string, file?: string, draft?: boolean }, stdin: () => Promise<string>, ctx: WorkflowCtx, s?: ResolvedSession): Promise<CmdResult> {
  const harness = o.harness !== undefined ? o.harness : s?.harness
  if (harness === undefined) return fail('usage', 'no harness: pass --harness claude|codex|opencode|omp, or run it inside a harness session')
  if (!isHarness(harness)) return fail('usage', `--harness must be claude, codex, opencode or omp (got '${harness}')`)
  if (o.title !== undefined && /[\r\n]/.test(o.title)) return fail('usage', '--title must be a single line')
  let plan: string
  try {
    plan = o.file !== undefined ? readFileSync(resolve(ctx.cwd, o.file), 'utf8') : await stdin()
  } catch (e) {
    return fail('io', `cannot read the plan${o.file !== undefined ? ` from ${o.file}` : ' from stdin'}: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (normalizePlanText(plan) === '') return fail('usage', `the plan is empty: pass its text on stdin or with --file <path>`)
  let r: PlanCaptureResult | undefined
  try {
    r = await capturePlanFile({ plan, cwd: ctx.cwd, now: ctx.now, harness, approved: o.draft !== true, via: 'cli', ...(o.title !== undefined ? { title: o.title } : {}) })
  } catch (e) {
    return fail('io', `cannot write the plan file: ${e instanceof Error ? e.message : String(e)}`)
  }
  if (r === undefined) return fail('exists', `${CAPTURE_SLOTS} plan files with this date and title already exist in docs/plans/; pass --title`)
  return ok({ ok: true, path: r.path, slug: r.slug, title: r.title, created: r.created, approved: r.approved, harness }, [r.path], [])
}
