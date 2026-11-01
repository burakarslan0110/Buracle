import { describe, expect, test } from 'bun:test'
import { existsSync, rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { uiBridge } from '../../../src/adapters/opencode/runtime/memory-bridge'
import { ompUiBridge } from '../../../src/adapters/omp/runtime/memory'
import { uiSessionHooks } from '../../../src/adapters/shared/ui-session'
import type { Harness } from '../../../src/core/events'
import * as paths from '../../../src/engine/paths'
import { uiPresenceDeps } from '../../../src/memory/ui-presence'
import { withEnv, withSandbox } from '../../helpers/sandbox'

// The four harnesses reach the memory UI through three copies of the same glue: src/adapters/shared/ui-session.ts
// (Claude Code and Codex, a process per hook), the OpenCode bridge and the Oh My Pi bridge (long-lived plugins). Each
// must record the session, start the UI once at the start, leave a stopped UI alone while the session's record is fresh
// (so `buracle mem ui --stop` holds), start it again once the record is gone or stale, and remove the record at the end.

interface Glue { harness: Harness, started(sid: string): Promise<void>, seen(sid: string): Promise<void>, ended(sid: string): Promise<void> }

const GLUES: Glue[] = [
  { harness: 'claude', started: sid => uiSessionHooks.started('claude', sid, Date.now()), seen: sid => uiSessionHooks.seen('claude', sid, Date.now()), ended: sid => uiSessionHooks.ended('claude', sid) },
  { harness: 'opencode', started: async sid => uiBridge.started(sid), seen: async sid => uiBridge.seen(sid), ended: async sid => uiBridge.ended(sid) },
  { harness: 'omp', started: async sid => ompUiBridge.started(sid), seen: async sid => ompUiBridge.seen(sid), ended: async sid => ompUiBridge.ended(sid) },
]

describe('the harness glue of the memory UI', () => {
  for (const glue of GLUES) {
    test(`${glue.harness}: a start records the session and starts the UI once; a fresh record starts nothing; a gone or stale one starts it again; the end removes it`, () => withSandbox(() => withEnv({ BURACLE_NO_AUTOSTART: undefined, BURACLE_MEMORY_RUNNER: undefined }, async () => {
      const starts: string[][] = []
      const saved = uiPresenceDeps.spawn
      uiPresenceDeps.spawn = args => { starts.push([...args]); return 4242 }
      // Each start leaves its marker for 15 s; the test takes it away so the next start is not counted as busy.
      const clearMarker = (): void => rmSync(paths.memoryUiSpawnMarker(), { force: true })
      try {
        const sid = 'sess-1'
        const record = join(paths.uiSessionsDir(), `${glue.harness}-${sid}`)
        await glue.started(sid)
        expect(existsSync(record)).toBe(true)
        expect(starts).toEqual([['mem', 'ui', '--serve']])
        clearMarker()

        await glue.seen(sid)
        expect(starts).toHaveLength(1)

        rmSync(record)
        await glue.seen(sid)
        expect(starts).toHaveLength(2)
        expect(existsSync(record)).toBe(true)
        clearMarker()

        const old = new Date(Date.now() - 3 * 3600_000)
        utimesSync(record, old, old)
        await glue.seen(sid)
        expect(starts).toHaveLength(3)

        await glue.ended(sid)
        expect(existsSync(record)).toBe(false)
      } finally {
        uiPresenceDeps.spawn = saved
      }
    })))
  }
})
