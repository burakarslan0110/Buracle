import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createBuracleExtension, defaultDeps } from '../../../src/adapters/omp/runtime/extension'
import { withSandbox } from '../../helpers/sandbox'
import { fakeCtx, fakePi, testDeps, testGenerated } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4b'

type Verdict = { block?: boolean, reason?: string } | undefined

describe("omp eval cells and the user's guards.bash.extraDeny", () => {
  test.skipIf(defaultDeps().evalGuard === undefined)('a cell that runs a command the user denied is blocked (H01); other cells run', () => withSandbox(async sb => {
    const cwd = join(sb.root, 'work')
    mkdirSync(cwd, { recursive: true })
    const t = testDeps({
      evalGuard: defaultDeps().evalGuard,
      policy: { ...testDeps().deps.policy!, routeTool: () => ({ action: 'allow' as const }) },
      config: d => ({ config: { ...d, guards: { ...d.guards, bash: { extraDeny: ['kubectl\\s+delete'] } } }, vault: '/v', shim: '/s', source: 'defaults' }),
    })
    const fp = fakePi({ thinking: 'high' })
    createBuracleExtension(testGenerated(), t.deps)(fp.pi)
    const ctx = fakeCtx({ cwd, sid: SID })
    const call = async (input: Record<string, unknown>) => await fp.emit('tool_call', { type: 'tool_call', toolCallId: 'x', toolName: 'eval', input }, ctx) as Verdict
    for (const input of [
      { language: 'py', code: "import os; os.system('kubectl delete ns prod')" },
      { language: 'js', code: "require('child_process').execSync('kubectl delete ns prod')" },
    ]) {
      const r = await call(input)
      expect({ input, block: r?.block, reason: r?.reason }).toEqual({ input, block: true, reason: expect.stringContaining('Buracle H01: Blocked by the guards.bash.extraDeny pattern') })
    }
    expect(await call({ language: 'py', code: "import os; os.system('kubectl get pods')" })).toBeUndefined()
  }))
})
