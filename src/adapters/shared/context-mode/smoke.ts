import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cmHookInput, cmKeepExtracted, cmPromptEvent, cmPromptRow, cmToolEvent, cmToolName, renderRestore, type CmEvent, type CmExtracted } from '../../../core/context-mode'
import { cmPackage, type CmPackage } from '../../../engine/context-mode'
import { loadCmLibrary } from './library'
import { cmIdleSessions } from './session'

export interface CmSmokeResult {
  ok: boolean
  root?: string
  version?: string
  problems: string[]
  ms: number
}

export async function cmSmokeTest(opts: { root?: string, pkg?: CmPackage | null } = {}): Promise<CmSmokeResult> {
  const start = Date.now()
  const done = (r: Omit<CmSmokeResult, 'ms' | 'ok'>): CmSmokeResult => ({ ok: r.problems.length === 0, ...r, ms: Date.now() - start })
  const root = opts.root ?? (opts.pkg === undefined ? cmPackage() : opts.pkg ?? undefined)?.root
  if (root === undefined) return done({ problems: ['context-mode is not installed in the toolchain'] })
  const lib = await loadCmLibrary(root)
  if (lib === undefined) return done({ root, problems: ['the session library cannot be loaded or lacks an export the bridge uses (see the Buracle log)'] })
  const problems: string[] = []
  let work: string
  try {
    work = realpathSync(mkdtempSync(join(tmpdir(), 'buracle-cm-smoke-')))
  } catch (e) {
    return done({ root, version: lib.version, problems: [`no scratch folder: ${e instanceof Error ? e.message : String(e)}`] })
  }
  try {
    mkdirSync(join(work, 'project', 'src'), { recursive: true, mode: 0o700 })
    mkdirSync(join(work, 'sessions'), { recursive: true, mode: 0o700 })
    const projectDir = join(work, 'project')
    const file = join(projectDir, 'src', 'app.ts')
    const tool = (name: string, input: Record<string, unknown>, response: string, status: 'ok' | 'error'): CmEvent => {
      const ev = cmToolEvent(name, input, response, status)
      if (ev === undefined) throw new Error(`no event for ${name}`)
      return ev
    }
    const prompt = cmPromptEvent('Add input validation to src/app.ts and keep the public API.')
    if (prompt === undefined) throw new Error('no prompt event')
    const cases: Array<{ ev: CmEvent, type: string, category: string, check?: (r: CmExtracted) => boolean }> = [
      { ev: tool('Read', { file_path: file }, '', 'ok'), type: 'file_read', category: 'file', check: r => r.data === file },
      { ev: tool('Edit', { file_path: file }, '', 'ok'), type: 'file_edit', category: 'file', check: r => r.data === file },
      { ev: tool('Bash', { command: 'git commit -m "smoke test"' }, '', 'ok'), type: 'git_commit', category: 'git', check: r => r.data === 'smoke test' },
      { ev: tool('Bash', { command: 'bun test' }, 'Exit code 1\nerror: expected 1 to be 2', 'error'), type: 'error_tool', category: 'error' },
      { ev: tool('TodoWrite', { todos: [{ content: 'Write the tests', status: 'pending' }] }, '', 'ok'), type: 'task', category: 'task', check: r => /Write the tests/.test(r.data) },
    ]
    const rows: CmExtracted[] = [cmPromptRow(prompt), ...cmKeepExtracted(prompt, lib.extractUserEvents(prompt.text))]
    for (const c of cases) {
      if (c.ev.kind !== 'tool') continue
      const got = cmKeepExtracted(c.ev, lib.extractEvents(cmHookInput(c.ev)))
      const hit = got.find(r => r.type === c.type && r.category === c.category)
      if (hit === undefined || (c.check !== undefined && !c.check(hit))) problems.push(`extractEvents(${c.ev.tool}) gave no ${c.type} row of category ${c.category}`)
      rows.push(...got)
    }
    const dbPath = lib.resolveSessionDbPath({ projectDir, sessionsDir: join(work, 'sessions') })
    if (!dbPath.startsWith(join(work, 'sessions'))) problems.push(`resolveSessionDbPath left the sessions folder: ${dbPath}`)
    const db = lib.openSessionDb(dbPath)
    const sid = 'buracle-smoke'
    try {
      db.ensureSession(sid, projectDir)
      db.bulkInsertEvents(sid, rows, 'PostToolUse')
      const stored = db.getEvents(sid, { limit: 1000 })
      if (!Array.isArray(stored) || stored.length === 0) problems.push('getEvents returned no rows')
      else {
        if (!stored.some(r => r.type === 'user_prompt' && r.data === prompt.text)) problems.push('a stored prompt did not come back from getEvents')
        if (!stored.some(r => r.type === 'file_edit' && r.data === file)) problems.push('a stored file_edit did not come back from getEvents')
      }
      const idle = cmIdleSessions(db, 'buracle-smoke-next')
      if (idle === undefined) problems.push('the session database has no raw handle, so the startup op cannot drop idle sessions')
      else if (idle.includes(sid)) problems.push('the idle-session query picked a session recorded into just now')
      const snapshot = lib.buildResumeSnapshot(Array.isArray(stored) ? stored : [], { compactCount: 1, searchTool: cmToolName('claude', 'ctx_search') })
      if (typeof snapshot !== 'string' || snapshot.trim() === '') problems.push('buildResumeSnapshot returned no text')
      else {
        db.upsertResume(sid, snapshot, rows.length)
        db.markResumeConsumed(sid)
        if (!db.getResume(sid)?.consumed) problems.push('markResumeConsumed did not mark the snapshot used')
      }
      const eventsFile = lib.resolveSessionPath({ projectDir, sessionsDir: join(work, 'sessions'), ext: '-events.md' })
      lib.writeSessionEventsFile(Array.isArray(stored) ? stored : [], eventsFile)
      if (!existsSync(eventsFile)) problems.push('writeSessionEventsFile wrote no file')
      const text = renderRestore(Array.isArray(stored) ? stored : [], { source: 'compact', toolName: t => cmToolName('claude', t), projectDir })
      if (!text.includes('Last request') || !text.includes('Files changed (newest first): src/app.ts')) problems.push('the restore text lacks the last request or the changed file')
    } finally {
      try { db.close() } catch {  }
    }
  } catch (e) {
    problems.push(`the library failed: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    try { rmSync(work, { recursive: true, force: true }) } catch {  }
  }
  return done({ root, version: lib.version, problems })
}
