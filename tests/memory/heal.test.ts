import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memSegmentWith } from '../../src/core/memory/status'
import { main } from '../../src/cli/router'
import * as paths from '../../src/engine/paths'
import { contextText } from '../../src/memory/context'
import { enqueueDistill } from '../../src/memory/distill'
import { finalize } from '../../src/memory/finalize'
import { remember, update, write } from '../../src/memory/api'
import { HEAL_BACKOFF_MAX_MS, healBrain, healEveryMs, healNoProgress, healRuns, healthLine, maybeStartHeal, type HealRun } from '../../src/memory/heal'
import { sessionStart } from '../../src/memory/session-record'
import { appendSpool } from '../../src/memory/spool'
import { computeStatus, readStatus, refreshStatus } from '../../src/memory/status'
import { deleteItem, getStored, projectRef } from '../../src/memory/store'
import { sweep } from '../../src/memory/sweep'
import { writeTelemetry } from '../../src/workflow/session-store'
import { withEnv } from '../helpers/sandbox'
import { agentCtx, withBrain } from './helpers'

const sid = (n: number) => `0199a213-81c0-7800-8aa1-bbab2a03${String(6000 + n)}`

async function cli(argv: string[]): Promise<{ code: number, out: string, err: string }> {
  let out = ''
  let err = ''
  const code = await main(argv, { stdout: { write: (s: string) => { out += s } }, stderr: { write: (s: string) => { err += s } }, stdin: { isTTY: true, text: async () => '' } })
  return { code, out, err }
}

describe('the distill queue', () => {
  test('dead entries are a backlog the repair clears; the status line says brain and names the queue', async () => {
    await withBrain(async () => {
      for (let i = 0; i < 6; i++) enqueueDistill('codex', sid(i))
      const s = await refreshStatus({ slug: 'demo' })
      expect(s).toMatchObject({ health: 'warn', reasons: ['distill_backlog'], distill: { pending: 6 } })
      expect(memSegmentWith(s, Date.now(), 'compact', { emoji: false }).text).toMatch(/^brain \d+.* ⚠ queue 6$/)
      const run = await healBrain({ slug: 'demo', trigger: 'cli' }) as HealRun
      expect(run.before).toEqual({ health: 'warn', reasons: ['distill_backlog'] })
      expect(run.after).toEqual({ health: 'ok', reasons: [] })
      expect(run.steps).toEqual([{ step: 'distill', ok: true, detail: 'distilled 0; dropped 6 with nothing to distill; 0 left in the queue' }])
      expect(readStatus('demo')?.health).toBe('ok')
      expect(healRuns()[0]).toMatchObject({ trigger: 'cli', project: 'demo', ok: true })
    })
  })

  test('a queue that only waits for its harness\'s usage window is no warning; the start text and memory_status say why it waits', async () => {
    await withBrain(async ({ repo }) => {
      for (let i = 0; i < 6; i++) {
        await sessionStart('claude', sid(i), repo)
        appendSpool('claude', sid(i), [{ ts: Date.now(), ev: 'prompt' }, { ts: Date.now() + 1, ev: 'stop', excerpt: `Session ${i} did work.` }])
        await finalize('claude', sid(i))
        enqueueDistill('claude', sid(i))
      }
      const weekReset = new Date(Date.now() + 4 * 3_600_000).toISOString()
      writeTelemetry('claude', sid(0), { at: Date.now(), windows: [{ label: '7d', pct: 98, resetsAt: weekReset }] })
      const s = await computeStatus({ slug: 'demo' })
      expect(s).toMatchObject({ health: 'ok', reasons: [], distill: { pending: 6, held: 6, until: weekReset } })
      const status = await cli(['mem', 'status', '--cwd', repo])
      expect(status.out).toContain(`distill queue: 6 session(s) wait for a harness with usage headroom (the first window resets ${weekReset}); not a fault`)
      await withEnv({ BURACLE_NO_DISTILL: undefined }, async () => {
        await refreshStatus({ slug: 'demo' })
        const run = await healBrain({ slug: 'demo', trigger: 'ui' }) as HealRun
        expect(run.steps).toEqual([{ step: 'distill', ok: true, detail: `distilled 0; 6 left in the queue; 6 wait for a harness with usage headroom (claude: 7-day window at 98% (limit 85%); the first window resets ${weekReset})` }])
        expect(run.after.health).toBe('ok')
      })
    })
  })
})

describe('errors', () => {
  test('mcp_down: the server is started once and, when it answers, recorded as ok', async () => {
    await withBrain(async () => {
      mkdirSync(paths.stateDir(), { recursive: true })
      writeFileSync(paths.healthFile(), JSON.stringify({ v: 1, checked_at: new Date().toISOString(), mcp: { 'buracle-memory': { status: 'down', error: 'spawn failed' } } }))
      expect((await refreshStatus({ slug: 'demo' }))?.reasons).toEqual(['mcp_down'])
      const failing = await healBrain({ slug: 'demo', trigger: 'cli', deps: { mcpCheck: async () => ({ ok: false, detail: 'exit 1' }) } }) as HealRun
      expect(failing).toMatchObject({ ok: false, after: { health: 'error', reasons: ['mcp_down'] } })
      expect(failing.steps[0]?.detail).toContain('run: buracle doctor')
      const fixed = await healBrain({ slug: 'demo', trigger: 'cli', deps: { mcpCheck: async () => ({ ok: true, detail: 'protocol 2025-06-18, 6 tools' }) } }) as HealRun
      expect(fixed).toMatchObject({ ok: true, after: { health: 'ok', reasons: [] }, steps: [{ step: 'mcp', ok: true }] })
    })
  })

  test('cortexdb_missing: installed again, at most every 6 hours', async () => {
    await withBrain(async () => {
      const real = process.env['BURACLE_CORTEXDB_BIN'] as string
      await withEnv({ BURACLE_CORTEXDB_BIN: `${real}-missing` }, async () => {
        let installs = 0
        const install = async () => { installs++; process.env['BURACLE_CORTEXDB_BIN'] = real; return { ok: true, detail: 'installed' } }
        const run = await healBrain({ slug: 'demo', trigger: 'cli', deps: { installCortex: install } }) as HealRun
        expect(run.before.reasons).toContain('cortexdb_missing')
        expect(run.steps[0]).toEqual({ step: 'store', ok: true, detail: 'CortexDB installed again' })
        expect(run.after.health).toBe('ok')
        process.env['BURACLE_CORTEXDB_BIN'] = `${real}-missing`
        const again = await healBrain({ slug: 'demo', trigger: 'cli', deps: { installCortex: install } }) as HealRun
        expect(again.steps[0]?.detail).toContain('under 6 hours ago')
        expect(installs).toBe(1)
      })
    })
  })

  test('cortexdb_missing with toolchain.autoInstall off: the repair installs nothing and names the switch, because `buracle install` would skip it too', async () => {
    await withBrain(async ({ buracleHome }) => {
      mkdirSync(buracleHome, { recursive: true })
      writeFileSync(join(buracleHome, 'config.yaml'), 'toolchain:\n  autoInstall: false\n')
      const real = process.env['BURACLE_CORTEXDB_BIN'] as string
      await withEnv({ BURACLE_CORTEXDB_BIN: `${real}-missing` }, async () => {
        let installs = 0
        const run = await healBrain({ slug: 'demo', trigger: 'cli', deps: { installCortex: async () => { installs++; return { ok: true, detail: 'installed' } } } }) as HealRun
        expect(run.steps[0]).toMatchObject({ step: 'store', ok: false })
        expect(run.steps[0]?.detail).toContain('buracle config set toolchain.autoInstall true, then buracle install')
        expect(installs).toBe(0)
      })
    })
  })

  test('embed_missing with toolchain.autoInstall off: nothing is downloaded and the step names the switch', async () => {
    await withBrain(async ({ buracleHome }) => {
      mkdirSync(buracleHome, { recursive: true })
      writeFileSync(join(buracleHome, 'config.yaml'), 'toolchain:\n  autoInstall: false\n')
      await withEnv({ BURACLE_NO_EMBED: undefined }, async () => {
        let downloads = 0
        const run = await healBrain({ slug: 'demo', trigger: 'cli', deps: { installEmbed: async () => { downloads++; return { ok: true, detail: 'installed' } } } }) as HealRun
        expect(run.before.reasons).toContain('embed_missing')
        const embed = run.steps.find(st => st.step === 'embed')
        expect(embed).toMatchObject({ ok: false })
        expect(embed?.detail).toContain('buracle config set toolchain.autoInstall true, then buracle install')
        expect(downloads).toBe(0)
      })
    })
  })

  test('cortexdb_missing: the default install downloads in this process, not through a removed CLI command', async () => {
    await withBrain(async () => {
      const real = process.env['BURACLE_CORTEXDB_BIN'] as string
      const saved = globalThis.fetch
      const urls: string[] = []
      globalThis.fetch = (async (url: string | URL | Request) => { urls.push(String(url)); return new Response('', { status: 404 }) }) as typeof fetch
      try {
        await withEnv({ BURACLE_CORTEXDB_BIN: `${real}-missing` }, async () => {
          const run = await healBrain({ slug: 'demo', trigger: 'cli' }) as HealRun
          expect(run.steps[0]).toMatchObject({ step: 'store', ok: false })
          expect(run.steps[0]?.detail).toContain('HTTP 404')
        })
      } finally {
        globalThis.fetch = saved
      }
      expect(urls).toHaveLength(1)
      expect(urls[0]).toContain('github.com/liliang-cn/cortexdb/releases/latest/download/')
    })
  })
})

describe('starting it', () => {
  test('a session start never starts it under BURACLE_NO_AUTOSTART=1, nor while the status is ok', async () => {
    await withBrain(async () => {
      for (let i = 0; i < 6; i++) enqueueDistill('codex', sid(i))
      await refreshStatus({ slug: 'demo' })
      expect(maybeStartHeal({ slug: 'demo', nowMs: Date.now(), trigger: 'session-start' })).toBe(false)
    })
  })

  test('a core page deleted by hand is a warning the repair clears by writing the page again', async () => {
    await withBrain(async ({ repo }) => {
      await write(agentCtx(repo), { type: 'knowledge', title: 'The relay runs every second', summary: 'relay' })
      await sweep({ slug: 'demo', person: false })
      const ref = projectRef('demo')
      expect(await getStored(ref, 'core-brief')).toBeDefined()
      await deleteItem(ref, 'core-brief')
      expect((await refreshStatus({ slug: 'demo' }))?.reasons).toEqual(['core_missing'])
      const run = await healBrain({ slug: 'demo', trigger: 'cli' }) as HealRun
      expect(run.steps).toEqual([{ step: 'core', ok: true, detail: 'core pages written again: core-brief' }])
      expect(run.after.reasons).toEqual([])
      expect((await getStored(ref, 'core-brief'))?.item.kind).toBe('core')
      expect(readStatus('demo')?.health).toBe('ok')
    })
  })

  test('a repair that changes nothing backs off: 30 min, then twice as long each time, at most 6 h; a run that clears a reason resets it', async () => {
    await withBrain(async ({ repo }) => {
      const ctx = agentCtx(repo)
      const ids: string[] = []
      for (let i = 0; i < 11; i++) ids.push((await remember(ctx, `test note number ${i} for the repair`)).id)
      const now = Date.now()
      expect((await refreshStatus({ slug: 'demo', nowMs: now }))?.reasons).toEqual(['captures_high'])
      const r1 = await healBrain({ slug: 'demo', trigger: 'cli', nowMs: now }) as HealRun
      expect(r1.after.reasons).toEqual(['captures_high'])
      expect(healNoProgress()).toBe(1)
      await healBrain({ slug: 'demo', trigger: 'cli', nowMs: now + 3600_000 })
      expect(healNoProgress()).toBe(2)
      expect([0, 1, 2, 3, 4, 9].map(healEveryMs)).toEqual([30 * 60_000, 60 * 60_000, 120 * 60_000, 240 * 60_000, HEAL_BACKOFF_MAX_MS, HEAL_BACKOFF_MAX_MS])
      expect(healthLine(readStatus('demo'))).toContain('The repair ran 2 times without progress and backs off (the next one waits up to 120 min)')
      await withEnv({ BURACLE_NO_AUTOSTART: undefined }, () => {
        expect(maybeStartHeal({ slug: 'demo', nowMs: now + 3600_000 + 31 * 60_000, trigger: 'tick' })).toBe(false)
      })
      for (const id of ids) await update(ctx, { id, patch: { status: 'deprecated' } })
      await healBrain({ slug: 'demo', trigger: 'cli', nowMs: now + 2 * 3600_000 })
      expect(healNoProgress()).toBe(0)
      expect(readStatus('demo')?.health).toBe('ok')
    })
  })

  test('the start text carries one health line for the agent; `buracle mem heal --json` and `--list`', async () => {
    await withBrain(async ({ repo }) => {
      for (let i = 0; i < 6; i++) enqueueDistill('codex', sid(i))
      await refreshStatus({ slug: 'demo' })
      const text = await contextText({ cwd: repo, harness: 'claude' })
      expect(text).toContain('Memory health: warn (queue 6). Buracle repairs this in the background (`buracle mem heal` runs it now).')
      const r = await cli(['mem', 'heal', '--cwd', repo, '--json'])
      expect(r.code).toBe(0)
      expect(JSON.parse(r.out)).toMatchObject({ trigger: 'cli', project: 'demo', after: { health: 'ok' } })
      const list = await cli(['mem', 'heal', '--list'])
      expect(list.out).toContain('cli  demo  warn -> ok')
      expect(list.out).toContain('ok   distill: distilled 0; dropped 6 with nothing to distill')
      expect(await contextText({ cwd: repo, harness: 'claude' })).not.toContain('Memory health')
    })
  })
})
