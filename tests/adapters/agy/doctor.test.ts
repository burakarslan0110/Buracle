import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chmodSync } from 'node:fs'
import { adapter } from '../../../src/adapters/agy/index'
import * as paths from '../../../src/engine/paths'
import { applyPlans } from '../../../src/engine/txn'
import { fakeExe, narrowPath } from '../../helpers/fake-exe'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { ctx, REPO } from './helpers'

const rows = async () => adapter.doctor(ctx())
const byCheck = (r: Array<{ check: string, level: string }>, c: string) => r.find(x => x.check === c)?.level

function shim(): string {
  const bin = join(paths.buracleHome(), 'bin')
  mkdirSync(bin, { recursive: true })
  const file = join(bin, 'buracle')
  writeFileSync(file, `#!/bin/sh\nexec ${process.execPath} ${join(REPO, 'src', 'cli', 'main.ts')} "$@"\n`)
  chmodSync(file, 0o755)
  return file
}

describe('doctor', () => {
  test('without the program it says there is nothing to check', async () => {
    await withSandbox(async ({ root }) => {
      await withEnv({ PATH: join(root, 'empty') }, async () => expect(await rows()).toEqual([{ level: 'warn', check: 'agy.binary', detail: 'agy is not on PATH; nothing to check' }]))
    })
  })

  test('an old version is an error; a missing hooks.json is a warning', async () => {
    await withSandbox(async ({ root }) => {
      fakeExe(join(root, 'bin', 'agy'), 'console.log("1.0.0")')
      await withEnv({ PATH: narrowPath(join(root, 'bin')) }, async () => {
        const r = await rows()
        expect(byCheck(r, 'agy.version')).toBe('error')
        expect(byCheck(r, 'agy.hooks')).toBe('warn')
      })
    })
  })

  test('after an install: the hooks, the servers and the guard probe pass; the skills warn until they are linked, then pass', async () => {
    await withSandbox(async ({ root, home }) => {
      fakeExe(join(root, 'bin', 'agy'), 'console.log("1.5.9")')
      shim()
      await withEnv({ PATH: narrowPath(join(root, 'bin')) }, async () => {
        await applyPlans([await adapter.installPlan(ctx())])
        let r = await rows()
        expect({ v: byCheck(r, 'agy.version'), h: byCheck(r, 'agy.hooks'), p: byCheck(r, 'agy.hooks.probe'), m: byCheck(r, 'agy.mcp'), s: byCheck(r, 'agy.skills') }).toEqual({ v: 'ok', h: 'ok', p: 'ok', m: 'ok', s: 'warn' })
        mkdirSync(join(home, '.agents', 'skills', 'x'), { recursive: true })
        writeFileSync(join(home, '.agents', 'skills', 'x', 'SKILL.md'), '---\nname: x\n---\n')
        mkdirSync(join(home, '.gemini', 'config', 'skills'), { recursive: true })
        symlinkSync(join(home, '.agents', 'skills', 'x'), join(home, '.gemini', 'config', 'skills', 'x'))
        r = await rows()
        expect(byCheck(r, 'agy.skills')).toBe('ok')
      })
    })
  }, 60_000)

  test('a disabled hook, and a hooks file that is not JSON, are errors', async () => {
    await withSandbox(async ({ root, home }) => {
      fakeExe(join(root, 'bin', 'agy'), 'console.log("1.5.9")')
      await withEnv({ PATH: narrowPath(join(root, 'bin')) }, async () => {
        await applyPlans([await adapter.installPlan(ctx())])
        const file = join(home, '.gemini', 'config', 'hooks.json')
        const hooks = JSON.parse((await Bun.file(file).text())) as Record<string, Record<string, unknown>>
        writeFileSync(file, JSON.stringify({ buracle: { ...hooks['buracle'], enabled: false } }))
        expect(byCheck(await rows(), 'agy.hooks')).toBe('error')
        writeFileSync(file, '{ nope')
        expect(byCheck(await rows(), 'agy.hooks')).toBe('error')
      })
    })
  }, 60_000)
})
