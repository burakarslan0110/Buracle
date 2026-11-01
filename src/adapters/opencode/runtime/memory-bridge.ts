import { existsSync } from 'node:fs'
import type { SpoolEntry } from '../../../core/memory/spool'
import { log } from '../../../engine/log'
import * as paths from '../../../engine/paths'
import { windowsVerbatim } from '../../../engine/platform'
import { shimArgv, shimLaunch } from '../../../engine/shim'
import { promptSeen, sessionStart, spawnFinalizer } from '../../../memory/session-record'
import { cliArgv } from '../../../memory/spawn'
import { appendSpool } from '../../../memory/spool'
import { uiBuildId } from '../../../memory/ui-build'
import { sessionClosed, sessionOpened, sessionSeen, startUiSoon } from '../../../memory/ui-presence'

export type { SpoolEntry }

export interface HandoffRequest { sessionId: string; cwd: string; project?: string; branch?: string; slug: string; markdown: string; now: number }

export interface MemoryBridge {
  append(sid: string, entries: SpoolEntry[]): void | Promise<void>
  start(sid: string, cwd: string): void | Promise<unknown>
  prompt?(sid: string): void
  finalize(sid: string): void | Promise<unknown>
  context(cwd: string, maxBytes: number): Promise<string | undefined>
  handoff(req: HandoffRequest): Promise<string | undefined>
  /** The memory web UI's session record (memory.ui.autostart): independent of the capture and of the idle finalize. */
  ui?: UiBridge
}

export interface UiBridge {
  started(sid: string): void
  seen(sid: string): void
  ended(sid: string): void
}

/** The memory UI's session record and start, called in-process (never throws, never waits for the UI). */
export const uiBridge: UiBridge = {
  started: sid => {
    try {
      sessionOpened('opencode', sid)
      const build = uiBuildId()
      startUiSoon(build !== undefined ? { build } : {})
    } catch (e) { log('warn', 'opencode: memory ui session start failed', { error: e }) }
  },
  seen: sid => {
    try { if (sessionSeen('opencode', sid) === 'revived') startUiSoon() } catch (e) { log('warn', 'opencode: memory ui refresh failed', { error: e }) }
  },
  ended: sid => {
    try { sessionClosed('opencode', sid) } catch {  }
  },
}

export function spawnShimFinalizer(sid: string): boolean {
  const argv = paths.isValidSessionId(sid) ? shimArgv(['mem', 'finalize', '--harness', 'opencode', '--session', sid]) : undefined
  if (argv === undefined) return false
  try {
    const proc = Bun.spawn(argv, {
      env: { ...process.env, BURACLE_FINALIZER: '1' },
      windowsVerbatimArguments: windowsVerbatim(argv),
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
  return shimLaunch() ?? cliArgv()
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
  finalize: sid => { if (!spawnShimFinalizer(sid)) spawnFinalizer('opencode', sid) },
  ui: uiBridge,
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
