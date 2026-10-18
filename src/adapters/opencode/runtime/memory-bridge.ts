import { existsSync } from 'node:fs'
import type { SpoolEntry } from '../../../core/memory/spool'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'
import { compactSeen, promptSeen, sessionStart, spawnFinalizer } from '../../../memory/session-record'
import { cliArgv } from '../../../memory/spawn'
import { appendSpool } from '../../../memory/spool'

export type { SpoolEntry }

export interface HandoffRequest { sessionId: string; cwd: string; project?: string; branch?: string; slug: string; markdown: string; now: number }

export interface MemoryBridge {
  append(sid: string, entries: SpoolEntry[]): void | Promise<void>
  start(sid: string, cwd: string): void | Promise<unknown>
  prompt?(sid: string): void
  compact?(sid: string): void
  finalize(sid: string): void | Promise<unknown>
  context(cwd: string, maxBytes: number): Promise<string | undefined>
  handoff(req: HandoffRequest): Promise<string | undefined>
}

export function spawnShimFinalizer(sid: string): boolean {
  const shim = paths.shimPath()
  if (!paths.isValidSessionId(sid) || !existsSync(shim)) return false
  try {
    const proc = Bun.spawn([shim, 'mem', 'finalize', '--harness', 'opencode', '--session', sid], {
      env: { ...process.env, BURACLE_FINALIZER: '1' },
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true,
    })
    proc.unref()
    return true
  } catch (e) {
    log('warn', 'opencode: cannot spawn the finalizer through the shim', { sid, error: e })
    return false
  }
}

function cli(): string[] {
  const shim = paths.shimPath()
  return existsSync(shim) ? [shim] : cliArgv()
}

async function runCliJson(args: string[], opts: { cwd: string, stdin?: string, timeoutMs: number }): Promise<Record<string, unknown> | undefined> {
  try {
    const proc = Bun.spawn([...cli(), ...args], {
      cwd: existsSync(opts.cwd) ? opts.cwd : paths.home(),
      env: { ...process.env },
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const timer = setTimeout(() => { try { proc.kill() } catch {  } }, opts.timeoutMs)
    const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    if (code !== 0) { log('debug', 'opencode: buracle CLI failed', { args: args.slice(0, 2), code }); return undefined }
    const v = JSON.parse(text) as unknown
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
  } catch (e) {
    log('debug', 'opencode: buracle CLI did not answer', { args: args.slice(0, 2), error: e })
    return undefined
  }
}

export const memoryBridge: MemoryBridge = {
  append: (sid, entries) => appendSpool('opencode', sid, entries),
  start: (sid, cwd) => sessionStart('opencode', sid, cwd),
  prompt: sid => { promptSeen('opencode', sid) },
  compact: sid => { compactSeen('opencode', sid) },
  finalize: sid => { if (!spawnShimFinalizer(sid)) spawnFinalizer('opencode', sid) },
  context: async (cwd, maxBytes) => {
    const r = await runCliJson(['mem', 'context', '--harness', 'opencode', '--cwd', cwd, '--json'], { cwd, timeoutMs: 15_000 })
    const text = typeof r?.['text'] === 'string' ? r['text'].trim() : ''
    if (text === '') return undefined
    const bytes = new TextEncoder().encode(text)
    return bytes.length <= maxBytes ? text : new TextDecoder().decode(bytes.slice(0, maxBytes)).replace(/\n[^\n]*$/, '')
  },
  handoff: async req => {
    const args = ['mem', 'handoff', '--harness', 'opencode', '--session', req.sessionId, '--cwd', req.cwd, '--slug', req.slug, '--trigger', 'compaction', '--json']
    if (req.branch !== undefined) args.push('--branch', req.branch)
    const r = await runCliJson(args, { cwd: req.cwd, stdin: req.markdown, timeoutMs: 20_000 })
    return typeof r?.['id'] === 'string' ? r['id'] : undefined
  },
}
