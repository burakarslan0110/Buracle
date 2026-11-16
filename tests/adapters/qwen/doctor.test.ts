import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { qwenDoctor } from '../../../src/adapters/qwen/doctor'
import { adapter } from '../../../src/adapters/qwen/index'
import { defaultConfig } from '../../../src/core/config'
import * as paths from '../../../src/engine/paths'
import { applyPlans } from '../../../src/engine/txn'
import { fakeExe, narrowPath } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { ctx, REPO } from './helpers'

const byCheck = (items: Array<{ check: string, level: string, detail: string }>, check: string) => items.find(i => i.check === check)

/** The `buracle` the hook command line runs: the checkout's CLI, so the probe is the real guard. */
function shim(): void {
  const bin = join(paths.buracleHome(), 'bin')
  mkdirSync(bin, { recursive: true })
  writeFileSync(join(bin, 'buracle'), `#!/bin/sh\nexec bun ${join(REPO, 'src', 'cli', 'main.ts')} "$@"\n`)
  chmodSync(join(bin, 'buracle'), 0o755)
}

async function withQwen(version: string, fn: (root: string) => Promise<void>): Promise<void> {
  await withSandbox(async ({ root, home }) => {
    const bin = join(root, 'bin')
    fakeExe(join(bin, 'qwen'), `console.log(${JSON.stringify(version)})`)
    await withEnv({ PATH: `${narrowPath(bin)}:${process.env['PATH'] ?? ''}`, HOME: home }, () => fn(root))
  })
}

describe('doctor', () => {
  test('qwen is not installed: one warning and nothing else', async () => {
    await withSandbox(async ({ root }) => {
      await withEnv({ PATH: join(root, 'empty') }, async () => {
        expect(await qwenDoctor(ctx())).toEqual([{ level: 'warn', check: 'qwen.binary', detail: 'qwen is not on PATH; nothing to check' }])
      })
    })
  })

  test('a Qwen Code older than the minimum is an error; a prerelease of a later line is not', async () => {
    await withQwen('0.25.9', async () => {
      expect(byCheck(await qwenDoctor(ctx()), 'qwen.version')?.level).toBe('error')
    })
    await withQwen('1.0.0-preview.1', async () => {
      expect(byCheck(await qwenDoctor(ctx()), 'qwen.version')?.level).toBe('ok')
    })
    await withQwen('0.26.1', async () => {
      expect(byCheck(await qwenDoctor(ctx()), 'qwen.version')?.level).toBe('ok')
    })
  })

  test('before the install: settings.json is missing, said in one line that names the command', async () => {
    await withQwen('0.27.4', async () => {
      const items = await qwenDoctor(ctx())
      expect(byCheck(items, 'qwen.settings')).toMatchObject({ level: 'warn' })
      expect(byCheck(items, 'qwen.settings')?.detail).toContain('buracle install qwen')
    })
  })

  test('after the install, with the shim in place: hooks, the guard probe and the servers are ok', async () => {
    await withQwen('0.27.4', async () => {
      await applyPlans([await adapter.installPlan(ctx())])
      shim()
      const items = await qwenDoctor(ctx())
      expect(byCheck(items, 'qwen.hooks')).toMatchObject({ level: 'ok' })
      expect(byCheck(items, 'qwen.hooks')?.detail).toContain('user-level hooks need no approval')
      expect(byCheck(items, 'qwen.hooks.probe')).toMatchObject({ level: 'ok' })
      expect(byCheck(items, 'qwen.mcp')).toMatchObject({ level: 'ok' })
      expect(byCheck(items, 'qwen.content')).toMatchObject({ level: 'ok' })
      expect(items.filter(i => i.level === 'error')).toEqual([])
    })
  }, 60_000)

  test('a removed review agent file or QWEN.md block is a warning that names the file and the command', async () => {
    await withQwen('0.27.4', async () => {
      await applyPlans([await adapter.installPlan(ctx())])
      rmSync(join(paths.qwenHome(), 'agents', 'changes-review.md'))
      const row = byCheck(await qwenDoctor(ctx()), 'qwen.content')
      expect(row).toMatchObject({ level: 'warn' })
      expect(row?.detail).toContain('agents/changes-review.md')
      expect(row?.detail).toContain('buracle install qwen')
    })
  })

  test('without the shim the guard probe fails: the guards would not run', async () => {
    await withQwen('0.27.4', async () => {
      await applyPlans([await adapter.installPlan(ctx())])
      expect(byCheck(await qwenDoctor(ctx()), 'qwen.hooks.probe')).toMatchObject({ level: 'error' })
    })
  }, 60_000)

  test('the tips line: warn while ui.loadingPhrases is unset or off, ok on witty or all; the setting is never changed', async () => {
    await withQwen('0.27.4', async () => {
      await applyPlans([await adapter.installPlan(ctx())])
      const file = join(paths.qwenHome(), 'settings.json')
      const before = await Bun.file(file).text()
      expect(byCheck(await qwenDoctor(ctx()), 'qwen.tips')).toMatchObject({ level: 'warn' })
      expect(byCheck(await qwenDoctor(ctx()), 'qwen.tips')?.detail).toContain('"witty" or "all"')
      expect(await Bun.file(file).text()).toBe(before)
      for (const mode of ['witty', 'all', 'off', 'tips']) {
        const s = JSON.parse(before) as Record<string, Record<string, unknown>>
        writeFileSync(file, JSON.stringify({ ...s, ui: { ...s['ui'], loadingPhrases: mode } }))
        expect(byCheck(await qwenDoctor(ctx()), 'qwen.tips')?.level).toBe(mode === 'witty' || mode === 'all' ? 'ok' : 'warn')
      }
    })
  }, 60_000)

  test('disableAllHooks, a hook event Buracle Stack lost, a missing server and invalid JSON are reported', async () => {
    await withQwen('0.27.4', async () => {
      await applyPlans([await adapter.installPlan(ctx())])
      const file = join(paths.qwenHome(), 'settings.json')
      const s = JSON.parse(await Bun.file(file).text()) as Record<string, Record<string, unknown>>
      delete s['hooks']?.['Stop']
      delete s['mcpServers']?.['semble']
      writeFileSync(file, JSON.stringify({ ...s, disableAllHooks: true }))
      const items = await qwenDoctor(ctx(defaultConfig()))
      expect(items.filter(i => i.check === 'qwen.hooks' && i.level === 'error').map(i => i.detail).join('\n')).toMatch(/disableAllHooks[^]*no Buracle Stack hook for Stop/)
      expect(byCheck(items, 'qwen.mcp')).toMatchObject({ level: 'warn' })
      expect(byCheck(items, 'qwen.mcp')?.detail).toContain('semble')
      writeFileSync(file, '{ nope')
      expect(byCheck(await qwenDoctor(ctx()), 'qwen.settings')).toMatchObject({ level: 'error' })
    })
  }, 60_000)
})
