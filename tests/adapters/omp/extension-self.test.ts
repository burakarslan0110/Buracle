import { describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createBuracleExtension, defaultDeps } from '../../../src/adapters/omp/runtime/extension'
import { checkBash } from '../../../src/core/policy/bash-guard'
import { checkWrite } from '../../../src/core/policy/write-guard'
import * as paths from '../../../src/engine/paths'
import { withEnv, withSandbox, type Sandbox } from '../../helpers/sandbox'
import { fakeCtx, fakePi, testDeps, testGenerated } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4b'

type Verdict = { block?: boolean, reason?: string } | undefined

function setup(_sb: Sandbox, cwd: string): (toolName: string, input: Record<string, unknown>) => Promise<Verdict> {
  mkdirSync(cwd, { recursive: true })
  const policy = { ...testDeps().deps.policy!, checkBash, checkWrite, routeTool: () => ({ action: 'allow' as const }) }
  const t = testDeps({ policy, evalGuard: defaultDeps().evalGuard })
  const fp = fakePi({ thinking: 'high' })
  createBuracleExtension(testGenerated(), t.deps)(fp.pi)
  const ctx = fakeCtx({ cwd, sid: SID })
  return async (toolName, input) => await fp.emit('tool_call', { type: 'tool_call', toolCallId: 'x', toolName, input }, ctx) as Verdict
}

describe("omp extension with the real guards: Buracle's own setup (SEC-1)", () => {
  test('a relocated PI_CODING_AGENT_DIR is refused to the write tools, the shell and eval cells', () => withSandbox(async sb => {
    const agent = join(sb.root, 'relocated-omp')
    await withEnv({ PI_CODING_AGENT_DIR: agent }, async () => {
      const call = setup(sb, join(sb.root, 'work'))
      expect((await call('write', { path: join(agent, 'config.yml'), content: 'x' }))?.reason).toContain("omp's own configuration")
      expect((await call('bash', { command: `rm '${join(agent, 'extensions', 'buracle.js')}'` }))?.reason).toContain("omp's own configuration")
      expect((await call('eval', { language: 'py', code: `import shutil; shutil.rmtree('${agent}')` }))?.reason).toContain("omp's own configuration")
      expect(await call('write', { path: join(agent, 'AGENTS.md'), content: 'x' })).toBeUndefined()
    })
  }))

  test('the checkout the extension runs from is refused from an unrelated session, and writable from inside it', () => withSandbox(async sb => {
    const repo = paths.repoRoot()
    const target = join(repo, 'harness', 'omp', 'extensions', 'buracle.js')
    const outside = setup(sb, join(sb.root, 'work'))
    expect((await outside('write', { path: target, content: 'x' }))?.reason).toContain("Buracle's own source code")
    expect((await outside('bash', { command: `echo x > '${target}'` }))?.reason).toContain("Buracle's own source code")
    expect((await outside('eval', { language: 'js', code: `require('fs').writeFileSync('${target}', 'x')` }))?.reason).toContain("Buracle's own source code")
    const inside = setup(sb, join(repo, 'src'))
    expect(await inside('write', { path: join(repo, 'src', 'cli', 'never-written.ts'), content: 'x' })).toBeUndefined()
  }))
})
