import { describe, expect, test } from 'bun:test'
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '../../../src/core/index'
import type { CanonicalBundle } from '../../../src/core/catalog'
import { defaultConfig } from '../../../src/core/config'
import { loadCanonicalSync } from '../../../src/engine/canonical'
import * as paths from '../../../src/engine/paths'
import type { AdapterContext } from '../../../src/adapters/registry'
import { handleCodexHook, type CodexHookDeps } from '../../../src/adapters/codex/hook'
import { shellApplyPatch, shellPatchTargets } from '../../../src/adapters/codex/shell-patch'
import { withSandbox } from '../../helpers/sandbox'

const REPO = join(import.meta.dir, '..', '..', '..')
const canonical: CanonicalBundle = loadCanonicalSync(join(REPO, 'canonical'))
const SID = '019a1b2c-3d4e-7f60-8a9b-0c1d2e3f4a5b'
const ctx = (): AdapterContext => ({ repoRoot: REPO, config: defaultConfig(), canonical, paths, buracleBin: paths.shimPath() })
const deps = (): CodexHookDeps => ({
  core, memory: async () => ({}), now: () => 1, run: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }), env: () => ({ HOME: paths.home() }),
})

const patch = (...files: string[]) => `*** Begin Patch\n${files.map(f => `*** Add File: ${f}\n+SECRET=1`).join('\n')}\n*** End Patch`
const heredoc = (body: string, cmd = 'apply_patch', delim = "'EOF'") => `${cmd} <<${delim}\n${body}\n${delim.replace(/['"]/g, '')}`

describe('shellApplyPatch: how a shell command runs apply_patch', () => {
  test('commands that do not run apply_patch', () => {
    expect(shellApplyPatch('ls -la')).toEqual({ kind: 'none' })
    expect(shellApplyPatch('rg -n "apply_patch" src/ && grep -c applypatch notes.md')).toEqual({ kind: 'none' })
    expect(shellApplyPatch(`cat > /tmp/x.patch <<'EOF'\n${patch('a.txt')}\nEOF`)).toEqual({ kind: 'none' })
    expect(shellApplyPatch(undefined)).toEqual({ kind: 'none' })
  })

  test("Codex's intercepted forms: both spellings, an optional `cd <path> &&`, quoted or plain delimiters", () => {
    const body = patch('a.txt')
    expect(shellApplyPatch(heredoc(body))).toEqual({ kind: 'patch', body, expands: false })
    expect(shellApplyPatch(heredoc(body, 'applypatch'))).toEqual({ kind: 'patch', body, expands: false })
    expect(shellApplyPatch(heredoc(body, 'cd /Users/me/.ssh && apply_patch'))).toEqual({ kind: 'patch', body, cd: '/Users/me/.ssh', expands: false })
    expect(shellApplyPatch(heredoc(body, 'cd "/a b" &&  applypatch', 'EOF'))).toEqual({ kind: 'patch', body, cd: '/a b', expands: true })
    expect(shellApplyPatch(heredoc(body, "cd '~/.ssh' && apply_patch", '"P"'))).toEqual({ kind: 'patch', body, cd: '~/.ssh', expands: false })
    expect(shellApplyPatch(`apply_patch <<-'EOF'\n\t${body.split('\n').join('\n\t')}\n\tEOF\n`)).toEqual({ kind: 'patch', body, expands: false })
    expect(shellApplyPatch(`apply_patch <<'EOF'\n${body}\n`)).toEqual({ kind: 'patch', body, expands: false })
    expect(shellApplyPatch(['apply_patch', body])).toEqual({ kind: 'patch', body, expands: false })
    expect(shellApplyPatch(['/bin/bash', '-lc', heredoc(body, 'cd /w && applypatch')])).toEqual({ kind: 'patch', body, cd: '/w', expands: false })
  })

  test('every other way of running apply_patch is opaque', () => {
    const body = patch('a.txt')
    for (const cmd of [
      heredoc(body, 'cd $HOME/.ssh && apply_patch'),
      heredoc(body, 'cd ~/.ssh; apply_patch'),
      `echo start; ${heredoc(body)}`,
      `${heredoc(body)}\necho done`,
      'apply_patch < /tmp/p.patch',
      'cat /tmp/p.patch | applypatch',
      `bash -lc "${heredoc(body).replace(/"/g, '\\"')}"`,
      `p=apply_patch; $p <<'EOF'\n${body}\nEOF`,
      `codex --codex-run-as-apply-patch "${body}"`,
      `/tmp/codex-arg0x/apply_patch <<'EOF'\n${body}\nEOF`,
      `sudo apply_patch "${body}"`,
    ]) {
      expect({ cmd, kind: shellApplyPatch(cmd).kind }).toEqual({ cmd, kind: 'opaque' })
    }
  })
})

describe('shellPatchTargets: the files a shell patch writes', () => {
  const parse = core.parseApplyPatch
  test('relative paths need an absolute `cd` anchor (exec_command workdir is invisible to hooks)', () => {
    expect(shellPatchTargets({ kind: 'patch', body: patch('a.txt'), expands: false }, parse)).toEqual({ undetermined: 'a.txt' })
    expect(shellPatchTargets({ kind: 'patch', body: patch('a.txt'), cd: 'sub', expands: false }, parse)).toEqual({ undetermined: 'a.txt' })
    expect(shellPatchTargets({ kind: 'patch', body: patch('a.txt'), cd: '~/.ssh', expands: false }, parse)).toEqual({ undetermined: 'a.txt' })
    expect(shellPatchTargets({ kind: 'patch', body: patch('a.txt', 'b/../c.txt'), cd: '/w/./x', expands: false }, parse)).toMatchObject({ paths: ['/w/x/a.txt', '/w/x/c.txt'] })
  })

  test('absolute paths need no anchor; shell-expanded bodies with `$` paths are unknown', () => {
    expect(shellPatchTargets({ kind: 'patch', body: patch('/w/a.txt'), cd: 'anything', expands: false }, parse)).toMatchObject({ paths: ['/w/a.txt'] })
    expect(shellPatchTargets({ kind: 'patch', body: patch('$HOME/.ssh/x'), cd: '/w', expands: true }, parse)).toEqual({ undetermined: '$HOME/.ssh/x' })
    expect(shellPatchTargets({ kind: 'patch', body: '*** Begin Patch\n*** Update File: /w/a.txt\n*** Move to: b.txt\n@@\n-x\n+y\n*** End Patch', cd: '/w', expands: false }, parse))
      .toMatchObject({ paths: ['/w/a.txt', '/w/b.txt'] })
  })

  test('Windows: a drive `cd` anchors relative paths, drive paths need none, the paths keep the Windows spelling', () => {
    const body = patch('a.txt')
    expect(shellApplyPatch(heredoc(body, 'cd C:\\Users\\me\\.ssh && apply_patch'))).toEqual({ kind: 'patch', body, cd: 'C:\\Users\\me\\.ssh', expands: false })
    expect(shellApplyPatch(heredoc(body, 'cd "D:\\a b" && applypatch'))).toEqual({ kind: 'patch', body, cd: 'D:\\a b', expands: false })
    expect(shellPatchTargets({ kind: 'patch', body, cd: 'C:\\Users\\me\\.ssh', expands: false }, parse)).toMatchObject({ paths: ['C:\\Users\\me\\.ssh\\a.txt'] })
    expect(shellPatchTargets({ kind: 'patch', body: patch('C:\\w\\a.txt'), expands: false }, parse)).toMatchObject({ paths: ['C:\\w\\a.txt'] })
    expect(shellPatchTargets({ kind: 'patch', body: patch('a.txt'), cd: 'C:', expands: false }, parse)).toMatchObject({ paths: ['C:\\a.txt'] })
  })
})

describe('PreToolUse H02 for shell apply_patch (real core, real write guard)', () => {
  const pre = async (command: string, cwd: string) => {
    const p = JSON.stringify({ session_id: SID, turn_id: 't1', transcript_path: null, cwd, hook_event_name: 'PreToolUse', model: 'x', permission_mode: 'bypassPermissions', tool_name: 'Bash', tool_input: { command }, tool_use_id: 'c1' })
    const r = await handleCodexHook('PreToolUse', p, ctx(), deps())
    return r.stdout === '' ? 'allow' : JSON.parse(r.stdout).hookSpecificOutput?.permissionDecision === 'deny' ? `deny: ${JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason}` : 'allow'
  }

  test('the reviewed bypasses are denied', () => withSandbox(async ({ root, home }) => {
    const cwd = join(root, 'work')
    const vault = paths.oldVaultRoot()
    expect(await pre(heredoc(patch('id_rsa'), 'applypatch'), cwd)).toStartWith('deny: Buracle H02:')
    expect(await pre(heredoc(patch('.env'), 'applypatch'), cwd)).toStartWith('deny: Buracle H02:')
    expect(await pre(heredoc(patch('authorized_keys'), `cd ${home}/.ssh && apply_patch`), cwd)).toContain("in the user's SSH directory")
    expect(await pre(heredoc(patch('runtime-config.json'), `cd ${home}/.buracle/state && apply_patch`), cwd)).toContain("Buracle's own state")
    expect(await pre(heredoc(patch('.obsidian/app.json'), `cd ${vault} && apply_patch`), cwd)).toContain("Obsidian's own settings")
    expect(await pre(heredoc(patch('authorized_keys'), 'cd $HOME/.ssh && apply_patch'), cwd)).toContain('in a form Buracle cannot follow')
    const rel = await pre(heredoc(patch('notes.txt')), cwd)
    expect(rel).toContain('which Codex does not show to hooks')
    expect(rel).toContain('apply_patch tool')
  }))

  test('determinable shell patches are checked like apply_patch tool calls; mentions are not runs', () => withSandbox(async ({ root }) => {
    const cwd = join(root, 'work')
    expect(await pre(heredoc(patch(join(cwd, 'src', 'a.ts')), 'applypatch'), cwd)).toBe('allow')
    expect(await pre(heredoc(patch('src/a.ts'), `cd ${cwd} && apply_patch`), cwd)).toBe('allow')
    expect(await pre(heredoc(patch(join(cwd, '.env')), 'apply_patch'), cwd)).toStartWith('deny: Buracle H02:')
    expect(await pre('rg -n "apply_patch" src/', cwd)).toBe('allow')
  }))
})

const coreFollowsLinks = core.checkWrite(['/p/link'], { cwd: '/p', home: '/h', vault: '/v', protect: [], realpath: () => '/h/.ssh/authorized_keys' } as unknown as Parameters<typeof core.checkWrite>[1]).deny !== undefined

describe('PreToolUse H02 follows symlinks (SEC-11)', () => {
  test('the write context carries a resolver that sees through a project link into ~/.ssh', () => withSandbox(async ({ root, home }) => {
    let seen: Record<string, unknown> | undefined
    const cwd = join(root, 'proj')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(home, '.ssh', 'authorized_keys'), 'k\n')
    symlinkSync(join(home, '.ssh', 'authorized_keys'), join(cwd, 'notes.txt'))
    const d = { ...deps(), core: { ...core, checkWrite: (_p: string[], c: unknown) => { seen = c as Record<string, unknown>; return {} } } } as CodexHookDeps
    const p = JSON.stringify({ session_id: SID, cwd, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: notes.txt\n@@\n-k\n+evil\n*** End Patch' } })
    await handleCodexHook('PreToolUse', p, ctx(), d)
    const resolve = seen?.['realpath'] as ((x: string) => string | undefined) | undefined
    expect(resolve?.(join(cwd, 'notes.txt'))).toBe(join(home, '.ssh', 'authorized_keys'))
  }))

  test.skipIf(!coreFollowsLinks)('with the real guard, writing through the link is denied', () => withSandbox(async ({ root, home }) => {
    const cwd = join(root, 'proj')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    mkdirSync(cwd, { recursive: true })
    writeFileSync(join(home, '.ssh', 'authorized_keys'), 'k\n')
    symlinkSync(join(home, '.ssh'), join(cwd, 'cfg'))
    const p = JSON.stringify({ session_id: SID, cwd, hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: cfg/config\n+Host *\n*** End Patch' } })
    const r = await handleCodexHook('PreToolUse', p, ctx(), deps())
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe('deny')
  }))
})
