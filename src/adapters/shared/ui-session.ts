import type { Harness } from '../../core/events'
import { log } from '../../engine/log'

// The four harnesses tell the memory UI when their sessions start, stay active and end (src/memory/ui-presence.ts),
// independent of the memory capture. Claude Code and Codex run a process per hook event and call these; OpenCode and
// omp call the same memory functions from their long-lived plugins. Every call is a few file operations, never waits
// for the UI, and never throws.

export interface UiSessionHooks {
  /** A session started: record it, and start the UI when it does not run (or runs another build). */
  started(h: Harness, sid: string, nowMs: number): Promise<void>
  /** A prompt or a tool call: refresh the record; a session that had counted as ended starts the UI again. */
  seen(h: Harness, sid: string, nowMs: number): Promise<void>
  /** The session ended. */
  ended(h: Harness, sid: string): Promise<void>
}

async function presence(): Promise<typeof import('../../memory/ui-presence') | undefined> {
  try { return await import('../../memory/ui-presence') } catch (e) {
    log('debug', 'memory ui: the presence module is not available', { error: e })
    return undefined
  }
}

export const uiSessionHooks: UiSessionHooks = {
  async started(h, sid, nowMs) {
    try {
      const m = await presence()
      if (m === undefined) return
      m.sessionOpened(h, sid, nowMs)
      const build = (await import('../../memory/ui-build')).uiBuildId()
      m.startUiSoon(build !== undefined ? { build } : {})
    } catch (e) { log('warn', 'memory ui: session start failed', { h, error: e }) }
  },
  async seen(h, sid, nowMs) {
    try {
      const m = await presence()
      if (m !== undefined && m.sessionSeen(h, sid, nowMs) === 'revived') m.startUiSoon()
    } catch (e) { log('warn', 'memory ui: session refresh failed', { h, error: e }) }
  },
  async ended(h, sid) {
    try { (await presence())?.sessionClosed(h, sid) } catch (e) { log('warn', 'memory ui: session end failed', { h, error: e }) }
  },
}
