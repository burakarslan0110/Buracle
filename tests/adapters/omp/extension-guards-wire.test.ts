import { describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBuracleExtension, defaultDeps } from '../../../src/adapters/omp/runtime/extension'
import { defaultConfig } from '../../../src/core/config'
import { checkBash } from '../../../src/core/policy/bash-guard'
import { checkWrite } from '../../../src/core/policy/write-guard'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeCtx, fakePi, testDeps, testGenerated } from './fakes'

const SID = '01a118a8-8d01-740c-9360-f4f796699f4c'

type Verdict = { block?: boolean, reason?: string } | undefined

function setup(cwd: string, protect: string[] = [], agent: { kind?: 'main' | 'sub', name?: string } = {}): (toolName: string, input: Record<string, unknown>) => Promise<Verdict> {
  mkdirSync(cwd, { recursive: true })
  const policy = { ...testDeps().deps.policy!, checkBash, checkWrite, routeTool: () => ({ action: 'allow' as const }) }
  const config = defaultConfig()
  config.guards.write.protect = protect
  const t = testDeps({ policy, evalGuard: defaultDeps().evalGuard, realpath: defaultDeps().realpath, consentGate: () => undefined })
  const fp = fakePi({ thinking: 'high' })
  createBuracleExtension(testGenerated({ config }), t.deps)(fp.pi)
  const ctx = fakeCtx({ cwd, sid: SID, ...agent })
  return async (toolName, input) => await fp.emit('tool_call', { type: 'tool_call', toolCallId: 'x', toolName, input }, ctx) as Verdict
}

describe('omp H01 meets the write context (W1.1)', () => {
  test('a deleting find that starts at the old memory vault is refused by H01 (BURACLE_VAULT no longer moves it); a protect glob covers a shell write', () => withSandbox(async ({ root, home }) => {
    const vault = join(home, 'Documents', 'Buracle')
    mkdirSync(vault, { recursive: true })
    await withEnv({ BURACLE_VAULT: join(root, 'elsewhere', 'vault') }, async () => {
      const call = setup(join(root, 'work'), ['secrets/**'])
      const r = await call('bash', { command: `find ${vault} -type f -delete` })
      expect(r?.reason).toStartWith('Buracle H01: ')
      expect(r?.reason).toContain('Buracle memory vault')
      expect((await call('bash', { command: 'echo x > secrets/a.txt' }))?.reason).toContain('guards.write.protect')
      const allowed = await call('bash', { command: 'echo x > notes/a.txt' }) as { block?: boolean, additionalContext?: string } | undefined
      expect(allowed?.block).toBeUndefined()
      expect(allowed?.additionalContext).toContain('this shell command writes `notes/a.txt`')
    })
  }))
})

describe('omp H02 judges write and edit by what they leave in a guarded file (W1.2)', () => {
  test('project Claude settings: a permission passes, disableAllHooks is refused', () => withSandbox(async ({ root }) => {
    const work = join(root, 'work')
    mkdirSync(join(work, '.claude'), { recursive: true })
    const file = join(work, '.claude', 'settings.json')
    writeFileSync(file, '{\n  "permissions": { "allow": [] }\n}\n')
    const call = setup(work)
    expect(await call('edit', { path: file, old_string: '"allow": []', new_string: '"allow": ["Bash(npm test:*)"]' })).toBeUndefined()
    const off = await call('edit', { path: file, old_string: '"allow": []', new_string: '"allow": [] }, "disableAllHooks": true, "x": {' })
    expect(off?.reason).toStartWith('Buracle H02: ')
    expect(off?.reason).toContain('disableAllHooks')
    expect(await call('write', { path: '.claude/settings.local.json', content: '{ "permissions": { "allow": ["Read"] } }' })).toBeUndefined()
    expect((await call('write', { path: '.omp/config.yml', content: 'disabledExtensions:\n  - buracle\n' }))?.reason).toContain('disabledExtensions')
    const patch = (body: string) => call('edit', { input: `*** Begin Patch\n${body}\n*** End Patch` })
    expect(await patch('*** Update File: .claude/settings.json\n@@\n-  "permissions": { "allow": [] }\n+  "permissions": { "allow": ["Read"] }')).toBeUndefined()
    expect((await patch('*** Add File: .claude/settings.local.json\n+{ "disableAllHooks": true }'))?.reason).toContain('disableAllHooks')
    expect((await call('edit', { input: '[.claude/settings.json#a1b2]\nPUT 2.=2:\n+  "permissions": { "allow": ["Read"] }' }))?.reason).toContain('cannot see what this write puts there')
  }))
})

describe('omp MCP calls that name a file they write go through H02 (W1.3, G12)', () => {
  test('a protected target is refused (a known server, another server, through a device), an ordinary one passes', () => withSandbox(async ({ root, home }) => {
    const call = setup(join(root, 'work'))
    const ssh = join(home, '.ssh', 'authorized_keys')
    const r = await call('mcp__chrome_devtools_take_heapsnapshot', { filePath: ssh })
    expect(r?.reason).toStartWith('Buracle H02: ')
    expect(r?.reason).toContain('SSH directory')
    expect((await call('mcp__myfiles_save', { path: ssh }))?.reason).toContain('SSH directory')
    expect((await call('write', { path: 'xd://mcp__myfiles_save', content: JSON.stringify({ path: ssh }) }))?.reason).toContain('SSH directory')
    expect(await call('mcp__chrome_devtools_take_heapsnapshot', { filePath: join(root, 'work', 'h.heapsnapshot') })).toBeUndefined()
    expect((await call('mcp__semble_search', { query: 'x', repo: '.env' }))?.reason ?? '').not.toContain('H02')
  }))
})

describe('omp H20: a command that needs several kinds is asked about each (W1.5)', () => {
  test('`git push --no-verify` asks for the skipped hooks, then for the push, and runs after two yeses', () => withSandbox(async ({ root }) => {
    const policy = { ...testDeps().deps.policy!, checkBash: () => ({}), checkWrite: () => ({}), routeTool: () => ({ action: 'allow' as const }) }
    const t = testDeps({ policy })
    const fp = fakePi({ thinking: 'high' })
    createBuracleExtension(testGenerated(), t.deps)(fp.pi)
    const ctx = fakeCtx({ cwd: join(root, 'work'), sid: SID })
    const asked: string[] = []
    ctx.ui.select = async (title: string) => { asked.push(title); return 'Allow once' }
    const r = await fp.emit('tool_call', { type: 'tool_call', toolCallId: 'p1', toolName: 'bash', input: { command: 'git push --no-verify origin main' } }, ctx)
    expect(r).toBeUndefined()
    expect(asked.length).toBe(2)
    expect(asked[0]).toContain('skips the git hooks')
    expect(asked[1]).toContain('pushes to a remote')
  }))
})

describe('omp H01 holds the review agents read-only (their bash tool)', () => {
  test('a reviewer\'s git commit, sed -i, git stash, rm and redirect are refused; git diff, rg and review-scope pass; other agents are not affected', () => withSandbox(async ({ root }) => {
    const work = join(root, 'work')
    const reviewer = setup(work, [], { kind: 'sub', name: 'changes-review' })
    for (const command of ['git commit -am x', "sed -i 's/a/b/' src/app.ts", 'git stash', 'rm notes.md', 'git diff > out.patch']) {
      const r = await reviewer('bash', { command })
      expect({ command, block: r?.block, reason: r?.reason }).toEqual({ command, block: true, reason: expect.stringMatching(/^Buracle H01: changes-review is a read-only reviewer/) })
    }
    for (const command of ['git diff HEAD~1', 'rg -n foo src', 'buracle review-scope --json']) expect({ command, r: await reviewer('bash', { command }) }).toEqual({ command, r: undefined })
    expect((await setup(work, [], { kind: 'sub', name: 'plan-build-review' })('bash', { command: 'git commit -am x' }))?.reason).toContain('read-only reviewer')
    expect(await setup(work, [], { kind: 'sub', name: 'worker' })('bash', { command: 'git commit -am x' })).toBeUndefined()
    expect(await setup(work, [], { kind: 'main', name: 'changes-review' })('bash', { command: 'git commit -am x' })).toBeUndefined()
  }))
})
