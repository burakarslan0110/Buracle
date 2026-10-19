import { beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clearRepoCache } from '../../../src/adapters/opencode/runtime/adapter-rules'
import { BuracleRuntime, REGISTRY_KEY, type PluginDeps } from '../../../src/adapters/opencode/runtime/plugin'
import type { PermissionEvaluation } from '../../../src/adapters/opencode/runtime/types'
import { clearPreparedWorkspaces } from '../../../src/adapters/opencode/runtime/workspace'
import type { BuracleConfig } from '../../../src/core/config'
import type { WorkspaceInfo } from '../../../src/core/workspace'
import * as paths from '../../../src/engine/paths'
import { withEnv, withSandbox } from '../../helpers/sandbox'
import { fakeMemory, fakeServerContext, testBaked } from './helpers'

const SID = 'ses_wire01'

beforeEach(() => {
  delete (globalThis as unknown as Record<symbol, unknown>)[REGISTRY_KEY]
  clearRepoCache()
  clearPreparedWorkspaces()
})

function noProject(cwd: string): WorkspaceInfo {
  return { cwd, children: [], index: { codegraph: { state: 'off' }, semble: { state: 'off' } } }
}

function writeRuntimeConfig(patch: (c: BuracleConfig) => BuracleConfig): void {
  const file = paths.runtimeConfigFile()
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify({ v: 1, config: patch(structuredClone(testBaked().defaults)), resolved: {} }))
}

async function runtime(dir: string) {
  const f = fakeServerContext(dir)
  const deps: PluginDeps = {
    baked: testBaked(), memory: fakeMemory(), settleMs: 0, runChecker: async () => ({ code: 0, stdout: '', stderr: '' }),
    capture: () => true, maint: () => ({ removed: [] }), notify: () => undefined,
    workspace: async cwd => noProject(cwd), workspaceRead: async cwd => noProject(cwd),
  }
  const rt = new BuracleRuntime(f.ctx, deps)
  await rt.register()
  let n = 0
  const call = async (tool: string, input: Record<string, unknown>, action: string, resources: string[] = [], agent = 'build'): Promise<PermissionEvaluation> => {
    const id = `call_w${++n}`
    await f.trigger('tool.execute.before', { tool, sessionID: SID, agent, messageID: 'msg_1', id, input })
    return f.trigger('permission.evaluate', { sessionID: SID, agent, action, resources, effect: 'allow', source: { type: 'tool', messageID: 'msg_1', id } } as PermissionEvaluation)
  }
  return { f, call }
}

describe('OpenCode H01 meets the write context (W1.1)', () => {
  test('a deleting find that starts at the old memory vault is refused by H01 (BURACLE_VAULT no longer moves it); a protect glob covers a shell write', () => withSandbox(async ({ root, home }) => {
    const vault = join(home, 'Documents', 'Buracle')
    mkdirSync(vault, { recursive: true })
    writeRuntimeConfig(c => ({ ...c, guards: { ...c.guards, write: { ...c.guards.write, protect: ['secrets/**'] } } }))
    await withEnv({ BURACLE_VAULT: join(root, 'elsewhere', 'vault') }, async () => {
      const { call } = await runtime(root)
      const e = await call('bash', { command: `find ${vault} -type f -delete` }, 'shell', [`find ${vault} -type f -delete`])
      expect(e.effect).toBe('deny')
      expect(e.message).toStartWith('[Buracle H01 ')
      expect(e.message).toContain('Buracle memory vault')
      expect((await call('bash', { command: 'echo x > secrets/a.txt' }, 'shell', ['echo x > secrets/a.txt'])).message).toContain('guards.write.protect')
      expect((await call('bash', { command: 'echo x > notes/a.txt' }, 'shell', ['echo x > notes/a.txt'])).effect).toBe('allow')
    })
  }))
})

describe('OpenCode H02 judges edit, write and patch by what they leave in a guarded file (W1.2)', () => {
  test('project Claude settings: a permission passes, disableAllHooks is refused', () => withSandbox(async ({ root }) => {
    mkdirSync(join(root, '.claude'), { recursive: true })
    const file = join(root, '.claude', 'settings.json')
    writeFileSync(file, '{\n  "permissions": { "allow": [] }\n}\n')
    const { call } = await runtime(root)
    const edit = (newString: string) => call('edit', { filePath: file, oldString: '"allow": []', newString }, 'edit', [file])
    expect((await edit('"allow": ["Bash(npm test:*)"]')).effect).toBe('allow')
    const off = await edit('"allow": [] }, "disableAllHooks": true, "x": {')
    expect(off.effect).toBe('deny')
    expect(off.message).toStartWith('[Buracle H02 ')
    expect(off.message).toContain('disableAllHooks')
    expect((await call('write', { filePath: '.claude/settings.local.json', content: '{ "permissions": { "allow": ["Read"] } }' }, 'edit', ['.claude/settings.local.json'])).effect).toBe('allow')
    expect((await call('write', { filePath: '.claude/settings.local.json', content: '{ "enabledPlugins": { "buracle@buracle": false } }' }, 'edit', ['.claude/settings.local.json'])).message).toContain("turns Buracle's plugin off")
    const patch = (body: string) => call('apply_patch', { patchText: `*** Begin Patch\n${body}\n*** End Patch` }, 'edit', [])
    expect((await patch('*** Update File: .claude/settings.json\n@@\n-  "permissions": { "allow": [] }\n+  "permissions": { "allow": ["Read"] }')).effect).toBe('allow')
    expect((await patch('*** Add File: opencode.json\n+{ "plugin": ["-buracle"] }')).message).toContain("removes Buracle's plugin")
    expect((await call('edit', { filePath: file, oldString: 'nope', newString: 'x' }, 'edit', [file])).message).toContain('cannot see what this write puts there')
  }))
})

describe('OpenCode MCP calls that name a file they write go through H02 (W1.3, G12)', () => {
  test('a protected target is refused, an ordinary one passes', () => withSandbox(async ({ root, home }) => {
    const { call } = await runtime(root)
    const heap = 'chrome-devtools_take_heapsnapshot'
    const denied = await call(heap, { filePath: join(home, '.ssh', 'authorized_keys') }, heap)
    expect(denied.effect).toBe('deny')
    expect(denied.message).toStartWith('[Buracle H02 ')
    expect(denied.message).toContain('SSH directory')
    expect((await call(heap, { filePath: join(root, 'h.heapsnapshot') }, heap)).effect).toBe('allow')
    expect((await call('semble_find_related', { file_path: '.env', line: 1, repo: root }, 'semble_find_related')).message ?? '').not.toContain('H02')
  }))
})

describe('OpenCode H01 adds the read-only shell check behind a reviewer\'s own allow rules', () => {
  test('an allowed-looking reviewer command that writes (a redirect, sed -i, git commit) is denied; a read passes; the build agent is not affected', () => withSandbox(async ({ root }) => {
    const { call } = await runtime(root)
    const shell = (command: string, agent: string) => call('bash', { command }, 'shell', [command], agent)
    for (const command of ['git diff > out.patch', "sed -i 's/a/b/' src/app.ts", 'git commit -am x']) {
      const e = await shell(command, 'changes-review')
      expect({ command, effect: e.effect }).toEqual({ command, effect: 'deny' })
      expect(e.message).toContain('changes-review is a read-only reviewer')
    }
    expect((await shell('git diff HEAD~1', 'changes-review')).effect).toBe('allow')
    expect((await shell('git diff > out.patch', 'goal-build-review')).effect).toBe('deny')
    expect((await shell('git diff > out.patch', 'build')).effect).toBe('allow')
  }))
})
